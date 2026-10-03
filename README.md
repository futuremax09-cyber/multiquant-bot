# MultiQuant Academy Bot

Production Cloudflare Worker for MultiQuant Academy.

## Runtime

- Cloudflare Workers
- D1: `multiquant-db`
- Durable Object: `OkxMonitorDO` / `OKX_MONITOR`
- Telegram Bot API
- Gemini
- OKX USDT perpetual market data
- RSS news and economic-event modules

## Important: secrets and dashboard variables

This repository intentionally does **not** contain Telegram or Gemini secrets.
Existing Cloudflare dashboard Variables and Secrets are preserved by `keep_vars = true` in `wrangler.toml`.
Do not commit `.dev.vars`, `.env`, API keys, or bot tokens.

Expected existing Cloudflare secrets include:

- `TELEGRAM_BOT_TOKEN`
- `GEMINI_API_KEY`

The Worker also reads the existing dashboard variables such as `BOT_USERNAME`, `CHANNEL_CHAT_ID`, `CHANNEL_USERNAME`, `GEMINI_MODEL`, `OKX_WS_URL`, `SIGNAL_MAX_24H`, `SIGNAL_MIN_GAP_MINUTES`, `SIGNAL_SCAN_INTERVAL_MINUTES`, and `TEAM_ALERT_CHAT_ID`.

## Deploy

From this directory:

```bash
npm install
npm run dry-run
npm run deploy
```

Do not add secrets to GitHub. Cloudflare Secrets remain on the Worker.

## Signal / trade monitoring notes

The existing signal-generation/scoring path is kept intact in `worker.js`. The rebuild focuses on deployment configuration, D1-write pressure, Telegram reply correctness, and duplicate-safe target/close notifications.

Target and close updates are replies to the original signal message. Target completion is not committed to D1 until the Telegram reply succeeds. Durable Object storage is used as an additional idempotency layer.

## Lead flow

The channel member flow uses the existing five-button onboarding. The copy-trading option is explicitly **Forex & Gold Copy Trading**, while Crypto Copy Trading remains a separate option. Existing Crypto/Forex/Stocks team environment variables remain supported; team-specific chat IDs are preferred when present, with the existing `TEAM_ALERT_CHAT_ID` kept as fallback.

## No test posts

Do not send test Telegram messages during deployment. Verify production through Cloudflare deployment/observability and the bot's normal traffic.
