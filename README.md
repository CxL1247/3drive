# 3Drive Scanner

A real-time crypto scanner built to catch 3-Drive harmonic patterns confirmed by RSI divergence, with Bollinger Band squeeze detection and email alerts. Runs entirely in the browser, deployed on Netlify.

---

## What it does

Scans the top 100 (or 150) tokens by market cap across three timeframes simultaneously: 4H, 1H, and 30M. For each token it checks two things:

**3-Drive + RSI divergence.** Bearish setup: price printing three higher highs while RSI prints three lower highs. Bullish: the inverse. The pattern has to be recent — Drive 3 must fall within the last 8 candles on 4H, 12 on 1H, 18 on 30M. Old patterns don't count.

**Bollinger Band squeeze.** Uses John Bollinger's own BandWidth formula: `(Upper - Lower) / Middle × 100`. A squeeze fires when BandWidth hits its lowest point in the last 125 candles — same definition TradingView uses. Only shows results at 65% compression strength or above to cut noise.

Both signals get stronger when they happen near support or resistance. The scanner identifies significant swing highs and lows from the last 100 candles and checks whether the current price is within 1% of any of them. When there's confluence, the badge shows an orange `◎` marker with the level type.

Confidence scores account for RSI divergence strength, price divergence, and time symmetry between the three drives. Signals scoring ≥75% get a gold left border in the table so they stand out without needing to sort.

---

## Stack

- **Frontend:** Single HTML file, no framework. Inter + JetBrains Mono for fonts.
- **Data:** Binance public API (candles, 24h ticker) called directly from the browser. CoinGecko for market cap rankings via a proxy. Both have no auth requirement.
- **Hosting:** Netlify, with two serverless functions: a CORS proxy for CoinGecko and Forex Factory, and an email function that calls Resend.
- **Persistence:** localStorage for the trading journal, alert preferences, email, and theme.

---

## Features

**Scanner**
- Top 100 or 150 tokens, configurable
- 4H / 1H / 30M timeframes, togglable individually
- Parallel scanning in batches of 5 (roughly 3x faster than sequential)
- Live prices via Binance WebSocket after each scan completes
- Prices flash gold when they update

**Market context**
- Fear & Greed index from alternative.me, refreshes hourly
- BTC trend card showing EMA50 vs EMA200 across 1H, 4H, and 1D with strength labels (weak / moderate / strong)
- Economic calendar from Forex Factory, USD events only, high and medium impact, times in WAT (UTC+1)

**Confluence detection**
- S/R confluence on both 3-Drive signals and BB squeezes
- Multi-timeframe confluence badge when the same signal fires on 2+ timeframes

**Email alerts** (requires Resend API key as Netlify env variable)
- Configurable per alert type: 3-Drive at S/R, squeeze at S/R, multi-TF confluence
- Sends one bundled email per scan, not one per signal
- Clean HTML email with token, signal, timeframe, confidence, S/R level, and TradingView chart link
- Test button in the UI

**Trading Journal**
- Mon–Sun weekly view, navigate between weeks
- Log trades manually: token, direction, timeframe, entry, SL, exit, result
- R calculation is automatic: `(exit - entry) / (entry - SL)` for longs, inverted for shorts
- Results show as `+2.5R`, `-1R`, `0R`
- Weekly summary at the bottom: trade count, wins, losses, BE, win rate, total R
- CSV export from the journal header

**UI**
- Dark and light mode, saved to localStorage
- Mobile card layout below 620px with live price updates
- Auto-scan via Web Worker so it doesn't pause when the tab is backgrounded
- Auto-scan intervals: 15m / 30m / 1h / 2h / 4h

---

## Limitations

Auto-scan requires the browser to be open. If you close it entirely, no scans run and no alerts fire. A server-side cron job would fix this but isn't implemented yet.

The 3-Drive detection is pattern-based, not predictive. A signal means the structure is present, not that the move is guaranteed. Always verify on the chart before acting.

iOS Safari push notifications aren't supported (browser limitation). Email is the alert delivery method for cross-device reliability.
