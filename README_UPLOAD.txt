MULTIQUANT BOT — WEBSOCKET UPLOAD PACK

Files:
1. worker.js
2. wrangler.toml
3. package.json

IMPORTANT:
wrangler.toml contains:
REPLACE_WITH_YOUR_MULTIIQUANT_DB_ID

Before connecting GitHub to Cloudflare Workers Builds, replace that placeholder
with the real database ID of the existing D1 database named "multiquant-db".
Do NOT create a new D1 database.

The Durable Object configuration is:
OKX_MONITOR -> OkxMonitorDO
storage = sqlite

Existing Cloudflare secrets are NOT included in these files:
TELEGRAM_BOT_TOKEN
GEMINI_API_KEY
CRON_SECRET

Workers Builds deploy command:
npx wrangler deploy
