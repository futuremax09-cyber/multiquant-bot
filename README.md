# MultiQuant Academy Bot — Rebuild

Production-ready Cloudflare Worker package for the MultiQuant Academy Telegram + OKX crypto signal system.

## Runtime

- Cloudflare Workers
- D1: `multiquant-db` (`DB` binding)
- Durable Object: `OkxMonitorDO` (`OKX_MONITOR` binding)
- Telegram Bot API
- Gemini
- OKX USDT-margined perpetuals
- RSS crypto/finance news
- Economic-event alerts
- Lead qualification + follow-ups

## Important deployment fix

The Worker entry file is intentionally `worker.mjs` and `wrangler.toml` points to it directly. This forces module parsing and avoids the previous `Unexpected "export"` build failure around the Durable Object export.

`package.json` also contains `"type": "module"`.

## Files

- `worker.mjs` — complete Worker
- `wrangler.toml` — Worker, D1, Durable Object and cron configuration
- `package.json` — module/deploy configuration
- `MASTER_LOGIC.md` — signal, TP/SL, positions, alerts, news, economics and onboarding rules
- `PATCH_NOTES.txt` — rebuild/fix notes

## Required Cloudflare secrets

Keep these in Cloudflare Dashboard, never in GitHub:

- `TELEGRAM_BOT_TOKEN`
- `GEMINI_API_KEY`

## Existing dashboard variables supported

The Worker reads existing Cloudflare variables such as:

- `BOT_USERNAME`
- `CHANNEL_USERNAME`
- `CHANNEL_CHAT_ID`
- `TEAM_ALERT_CHAT_ID`
- `ADMIN_CHAT_ID`
- `GEMINI_MODEL`
- `OKX_WS_URL`
- `OKX_PUBLIC_WS_URL`
- `SIGNAL_MAX_24H`
- `SIGNAL_MIN_GAP_MINUTES`
- `SIGNAL_SCAN_INTERVAL_MINUTES`
- `SIGNALS_ENABLED`
- `NEWS_ENABLED`
- `ECONOMIC_ENABLED`
- `FOLLOWUPS_ENABLED`
- `CRON_SECRET`
- `TELEGRAM_WEBHOOK_SECRET`
- `WORKER_PUBLIC_URL`

Do not commit secrets or `.dev.vars`.

## Deploy

```bash
npm install
npm run dry-run
npm run deploy
```

Cloudflare Build settings can continue using:

```text
Deploy command: npx wrangler deploy
Root directory: /
```

No manual package.json module workaround is required beyond the included files.

## Telegram

The bot should be admin in `@multiquantacademy` if channel member updates are required. The webhook uses:

```text
message
callback_query
chat_member
```

The channel onboarding buttons are:

1. Forex Trading
2. Copy Trading in Forex
3. Indian Stock Market
4. Crypto Premium Signals
5. Crypto Copy Trading

Team alerts use `TEAM_ALERT_CHAT_ID`; `ADMIN_CHAT_ID` is not used as a fallback destination for new-member team alerts.

## Signal system

- OKX USDT perpetual universe is loaded dynamically.
- One public signal maximum per signal scan.
- Existing D1 24-hour quota and minimum-gap controls are preserved.
- The full ticker universe is ranked first; a larger setup candidate pool is then evaluated.
- Signal format remains the locked USDT-M format with Entry, TP1/TP2/TP3, SL, setup and hashtags.
- TP/SL monitoring is handled by the Durable Object using OKX 5-minute candles.
- TP notifications and close notifications are replies to the original signal.
- D1 write exhaustion does not intentionally stop the in-memory/Durable-Object monitoring path.

## No test posts

Deployment does not send test Telegram posts. Verify through Worker logs and normal production traffic.
