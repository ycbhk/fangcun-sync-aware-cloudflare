# Fangcun Sync Awareness - Cloudflare

This deploys the relay on Cloudflare Workers Free using SQLite-backed Durable Objects. Durable Objects store recent events per channel, WebSocket notifies online devices, and HTTP polling remains available as fallback.

## Deploy

```bash
npm install
npx wrangler secret put SYNC_AWARE_SECRET
npm run deploy
```

Then set the deployed Worker URL as the Fangcun Toolbox endpoint.

## Free-tier Notes

- Use Workers + Durable Objects only.
- Do not use Workers KV as the event store; free KV writes are too limited and KV is eventually consistent.
- Keep the plugin polling interval at 10-15 seconds foreground and 30-60 seconds idle unless your Cloudflare account has more quota.

## Protocol

- `POST /sync/v1/events`
- `GET /sync/v1/events?since=<cursor>&limit=50`
- `GET /sync/v1/health`
- `GET /sync/v1/ws`

All requests are signed by the plugin with HMAC-SHA256.
