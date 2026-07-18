# 方寸工具箱同步感知 - Cloudflare

这是方寸工具箱同步感知的 Cloudflare 免费版部署方案。它使用 Worker + SQLite 支持的 Durable Object 保存最近事件，在线设备走 WebSocket 通知，离线设备继续用 HTTP 轮询兜底。

## 部署

```bash
# 安装依赖
npm install
# 写入共享密钥
npx wrangler secret put SYNC_AWARE_SECRET
# 部署到 Cloudflare
npm run deploy
```

然后把部署后的 Worker 地址填到方寸工具箱的服务端地址里。

## 免费版说明

- 只使用 Workers + Durable Objects。
- 不要把 Workers KV 当作事件主存储；免费版写入额度偏紧，而且 KV 是最终一致。
- 建议把插件轮询间隔保持在前台 10-15 秒、空闲 30-60 秒，除非你的 Cloudflare 账号有更高额度。

## 协议

- `POST /sync/v1/events`：上报同步完成事件
- `GET /sync/v1/events?since=<cursor>&limit=50`：拉取某个游标之后的新事件
- `GET /sync/v1/health`：健康检查接口
- `GET /sync/v1/ws`：WebSocket 实时通知接口

所有请求都由插件使用 HMAC-SHA256 签名。

