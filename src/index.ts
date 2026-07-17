export interface Env {
  CHANNELS: DurableObjectNamespace<ChannelDurableObject>;
  SYNC_AWARE_SECRET: string;
  RETENTION_MS?: string;
  MAX_EVENTS_PER_CHANNEL?: string;
}

interface SyncEvent {
  id: string;
  kind: "sync-complete" | "test";
  channelId: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  source: "siyuan" | "manual" | "test";
}

const TIME_SKEW_MS = 5 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type,x-fc-channel,x-fc-device,x-fc-timestamp,x-fc-nonce,x-fc-signature",
    },
  });
}

function base64Url(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(secret: string, message: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function constantTimeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function verifySignedRequest(request: Request, env: Env, body = "") {
  const url = new URL(request.url);
  const channelId = request.headers.get("x-fc-channel") || "";
  const deviceId = request.headers.get("x-fc-device") || "";
  const timestamp = request.headers.get("x-fc-timestamp") || "";
  const nonce = request.headers.get("x-fc-nonce") || "";
  const signature = request.headers.get("x-fc-signature") || "";
  if (!channelId || !deviceId || !timestamp || !nonce || !signature) {
    return { ok: false, status: 401, message: "Missing sync awareness signature headers." };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TIME_SKEW_MS) {
    return { ok: false, status: 401, message: "Signature timestamp is outside the allowed clock window." };
  }
  const expected = await hmac(env.SYNC_AWARE_SECRET, `${request.method.toUpperCase()}\n${url.pathname}\n${timestamp}\n${nonce}\n${body}`);
  if (!constantTimeEqual(expected, signature)) return { ok: false, status: 401, message: "Invalid sync awareness signature." };
  return { ok: true, channelId };
}

async function verifyWebSocketRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel") || "";
  const deviceId = url.searchParams.get("device") || "";
  const timestamp = url.searchParams.get("ts") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const signature = url.searchParams.get("sig") || "";
  if (!channelId || !deviceId || !timestamp || !nonce || !signature) {
    return { ok: false, status: 401, message: "Missing WebSocket signature." };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TIME_SKEW_MS) {
    return { ok: false, status: 401, message: "Signature timestamp is outside the allowed clock window." };
  }
  const expected = await hmac(env.SYNC_AWARE_SECRET, `GET\n${url.pathname}\n${timestamp}\n${nonce}\n`);
  if (!constantTimeEqual(expected, signature)) return { ok: false, status: 401, message: "Invalid WebSocket signature." };
  return { ok: true, channelId };
}

function durableObjectFor(env: Env, channelId: string) {
  const id = env.CHANNELS.idFromName(channelId);
  return env.CHANNELS.get(id);
}

async function route(request: Request, env: Env) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/sync/v1/")) return json({ ok: false, message: "Not found" }, 404);

  if (url.pathname === "/sync/v1/ws") {
    if (request.headers.get("upgrade") !== "websocket") return json({ ok: false, message: "Expected WebSocket upgrade." }, 426);
    const auth = await verifyWebSocketRequest(request, env);
    if (!auth.ok || !auth.channelId) return json({ ok: false, message: auth.message }, auth.status);
    return durableObjectFor(env, auth.channelId).fetch(request);
  }

  const body = request.method === "POST" ? await request.text() : "";
  const auth = await verifySignedRequest(request, env, body);
  if (!auth.ok || !auth.channelId) return json({ ok: false, message: auth.message }, auth.status);
  if (url.pathname === "/sync/v1/health") {
    return json({ ok: true, service: "fangcun-sync-aware-cloudflare", retentionMs: Number(env.RETENTION_MS || 259200000) });
  }
  return durableObjectFor(env, auth.channelId).fetch(new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body || undefined,
  }));
}

export default {
  fetch(request: Request, env: Env) {
    return route(request, env).catch((error) => json({ ok: false, message: error instanceof Error ? error.message : "Internal error" }, 500));
  },
};

export class ChannelDurableObject {
  private sql: SqlStorage;
  private env: Env;

  constructor(private ctx: DurableObjectState, env: Env) {
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, channelId TEXT NOT NULL, deviceId TEXT NOT NULL, deviceName TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, createdAt INTEGER NOT NULL)");
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const retentionMs = Number(this.env.RETENTION_MS || 259200000);
    const maxEvents = Number(this.env.MAX_EVENTS_PER_CHANNEL || 500);
    this.sql.exec("DELETE FROM events WHERE createdAt < ?", Date.now() - retentionMs);

    if (url.pathname === "/sync/v1/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const cursor = url.searchParams.get("cursor") || "";
      server.send(JSON.stringify({ ok: true, events: this.readEvents(cursor, 50), cursor: this.latestCursor() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/sync/v1/events" && request.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
      return json({ ok: true, events: this.readEvents(url.searchParams.get("since") || "", limit), cursor: this.latestCursor() });
    }

    if (url.pathname === "/sync/v1/events" && request.method === "POST") {
      const event = await request.json<SyncEvent>();
      if (!event.id || !event.channelId || !event.deviceId || !event.createdAt) {
        return json({ ok: false, message: "Invalid sync awareness event." }, 400);
      }
      this.sql.exec(
        "INSERT OR IGNORE INTO events (id, channelId, deviceId, deviceName, kind, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        String(event.id).slice(0, 80),
        String(event.channelId).slice(0, 160),
        String(event.deviceId).slice(0, 120),
        String(event.deviceName || "SiYuan").slice(0, 120),
        event.kind === "test" ? "test" : "sync-complete",
        ["siyuan", "manual", "test"].includes(event.source) ? event.source : "siyuan",
        Number(event.createdAt),
      );
      this.sql.exec("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY createdAt DESC LIMIT ?)", maxEvents);
      const inserted = this.readEvents(event.id, 1);
      this.broadcast({ ok: true, events: [this.normalizeEvent(event)], cursor: this.latestCursor() });
      return json({ ok: true, inserted: inserted.length });
    }

    return json({ ok: false, message: "Not found" }, 404);
  }

  webSocketMessage() {
    // Clients do not need to send messages. Keeping this handler enables WebSocket Hibernation.
  }

  webSocketClose(ws: WebSocket) {
    ws.close();
  }

  private readEvents(since: string, limit: number): SyncEvent[] {
    const rows = since
      ? this.sql.exec("SELECT * FROM events WHERE createdAt > COALESCE((SELECT createdAt FROM events WHERE id = ?), 0) ORDER BY createdAt ASC LIMIT ?", since, limit).toArray()
      : this.sql.exec("SELECT * FROM events ORDER BY createdAt DESC LIMIT ?", limit).toArray().reverse();
    return rows.map((row) => this.normalizeEvent(row as unknown as SyncEvent));
  }

  private latestCursor() {
    const row = this.sql.exec("SELECT id FROM events ORDER BY createdAt DESC LIMIT 1").one<{ id: string }>();
    return row?.id || "";
  }

  private normalizeEvent(event: SyncEvent): SyncEvent {
    return {
      id: String(event.id),
      channelId: String(event.channelId),
      deviceId: String(event.deviceId),
      deviceName: String(event.deviceName || "SiYuan"),
      kind: event.kind === "test" ? "test" : "sync-complete",
      source: ["siyuan", "manual", "test"].includes(event.source) ? event.source : "siyuan",
      createdAt: Number(event.createdAt),
    };
  }

  private broadcast(payload: unknown) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        ws.close();
      }
    }
  }
}
