# MultiQuant — Master Logic / Conditions

This document records the intended production behavior preserved in the rebuild.

## 1. Signal discovery

### Universe
- Scan live OKX `*-USDT-SWAP` perpetuals.
- Ignore instruments with no live price or no usable volume.
- Rank the whole available ticker universe before deeper setup analysis.
- Analyze a larger candidate pool and select only one final signal per scan.
- Do not publish a weak signal just to fill a quota.

### Core setup logic
The currently preserved production scanner uses the established 15M setup path:

- EMA 9 vs EMA 21 trend direction.
- RSI(14) confirmation.
- Volume ratio versus recent average.
- 24H movement alignment.
- Recent structural high/low for SL.
- Opportunity-based TP bands under the existing 10X convention.
- Trade-setup labeling such as:
  - Bullish Breakout
  - Bearish Breakdown
  - Double Bottom
  - Double Top
  - Bullish Flag
  - Bearish Flag
  - Support Bounce
  - Resistance Rejection

The signal-generation logic is intentionally not replaced by a completely different strategy.

## 2. Signal output

Locked format:

```text
📈 CRYPTO FUTURES SIGNAL (USDT-M)

Pair: `COIN/USDT`
Direction: LONG/SHORT
Leverage: 10X

Entry: `LOW – HIGH`

TP1: `PRICE` — XX.X%
TP2: `PRICE` — XX.X%
TP3: `PRICE` — XX.X%

SL: `PRICE`

⚠️ Move your SL to entry after the first target is hit.

📊 Trade Setup: SETUP — 15M

#BTCUSDT #BTC #CRYPTO #COINUSDT
```

Only one signal is posted per scan.

## 3. TP conditions

- TP1/TP2/TP3 are checked from OKX 5M candle high/low data.
- LONG: target is hit when the favorable high reaches the target.
- SHORT: target is hit when the favorable low reaches the target.
- Each TP notification is idempotent.
- Notifications reply to the original signal message.
- TP1 protection moves the effective stop to entry.

TP reply structure:

```text
🎯 TP1 HIT

📌 COIN/USDT — LONG

🎯 Entry: `...`
💰 Price: `...`
📈 Profit: +18.1%

TP2 coming soon ....
```

No fake ❌ message is shown for an unhit target.

## 4. Close / SL conditions

### Direct SL
If no target has been reached and the original SL is touched:

```text
😔 SL HIT ❌

📌 COIN/USDT — LONG

💰 SL Price: `...`
📉 Loss: -X.X%

🔒 Position Closed
```

### Protected-profit close
If a target has already been reached and price returns to the protected stop/trailing level:

- Do not call it `SL HIT`.
- Report the favorable peak as the best achieved price/profit.
- Mark the trade as profit protected.
- Reply to the original signal.

## 5. D1 quota protection

D1 free-tier row-write exhaustion is treated as a write circuit-breaker.

Important separation:

- D1 persistence can pause.
- Real-time Durable Object TP/SL state should continue.
- TP notification idempotency lives in Durable Object storage.
- Closed-position state is also retained in Durable Object storage until D1 becomes writable again.
- `/positions` filters Durable Object-known closed positions so stale D1 rows are not shown as live.

## 6. `/positions`

The live report includes:

- total open
- profitable
- losing
- flat
- total profit %
- total loss %
- net P/L
- TP1 hit count
- TP2 hit count
- TP3 hit count
- best current
- worst current
- each position's entry/current/targets/SL

Only hit targets are shown; no `Targets Hit: None` line is required.

## 7. Rapid movement alerts

Every 5-minute cron obtains the live OKX ticker universe.

The Durable Object stores short-lived ticker snapshots. When a roughly 10-minute comparison is available:

- `+10%` or more → PUMP alert
- `-10%` or less → DUMP alert
- price before → price now
- movement percentage
- approximate period
- cumulative 24H volume change when available
- activity direction
- cooldown/deduplication

The rapid alert is separate from the normal signal engine.

## 8. Daily market lists

The system can publish exactly one daily:

- Top Gainers list
- Top Losers list

Deduplication is stored in Durable Object state so the cron running every 5 minutes does not repeat the same daily list.

## 9. News

News processing remains separate from signal generation.

- RSS feeds are used for source material.
- Recent stories are deduplicated before publishing.
- Rewrites are used rather than blindly reposting source wording.
- Telegram channel output is separate from private lead conversations.

## 10. Economic events

Economic events are handled by a data provider/API path rather than asking Gemini to invent actual/forecast/previous values.

The production flow supports pre-event and release-style economic posts when provider data is available.

## 11. Lead onboarding

Channel/member onboarding:

1. Forex Trading
2. Copy Trading in Forex
3. Indian Stock Market
4. Crypto Premium Signals
5. Crypto Copy Trading

Qualification flow:

`interest → trading type → capital → experience → goal/requirement`

Qualified leads are routed to the appropriate team and follow-ups run on cron.

Team alerts go to `TEAM_ALERT_CHAT_ID`.

## 12. Language

Private bot replies preserve the user's language mode:

- Hindi → Hindi
- Hinglish → Hinglish/Roman script
- English → English

Hinglish is not automatically converted into Devanagari.

## 13. Cron

The repository uses:

```text
*/5 * * * *
```

The 5-minute cron drives follow-ups, news, economic checks, rapid movement checks, daily market-list checks and the 15-minute signal schedule.

## 14. Secrets

Never put Telegram tokens or Gemini keys in GitHub.

Cloudflare Dashboard Secrets/Variables remain the source of truth, and `keep_vars = true` is retained in `wrangler.toml`.
