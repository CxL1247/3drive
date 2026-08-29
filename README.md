# 3Drive Scanner

A real-time crypto scanner across the top 100 tokens by market cap — pattern detection, live rankings, and order book reads, all in one page.

## Tabs

### Scanner
Detects four setups across 4H/1H/30M, continuously via auto-refresh:
- **Three Drives** — genuine harmonic structures using Fibonacci-proportional legs (not just "three higher highs"), confirmed by RSI divergence at each drive point
- **Fair Value Gaps** — graded A/B, used as confluence for other signals
- **Bollinger Band Squeeze** — volatility compression flagged as it happens
- **Fixed Range Volume Profile / Range Deviation** — anchored at the exact swing pivot of a real impulsive move (not just the start of a search window), builds a real volume profile from that pivot to now, and derives VAH/POC/VAL. A catalyst move has to clear both a volatility-relative bar (vs. that token's own recent range) and a volume-confirmation bar before it counts — tuned against synthetic noise until false positives dropped under 1%. Every detected range gets a 0–100 quality score and A/B/C grade; anything scoring below 50 is filtered out entirely rather than shown.

Each signal gets a composite confidence score (support/resistance confluence, FVG confluence, volume confirmation at the formation candle, the token's own historical hit rate), trend-context filtering (flags lower-timeframe signals fighting the 4H trend), and weekend liquidity flagging.

### Gainers & Losers
Top 25 gainers/losers across 15m/30m/1h/4h windows. Price ticks live via WebSocket; the comparison window is recalculated against real wall-clock time on every render (not frozen at scan time), so it stays accurate no matter how long the tab's been open. Each token's candle-series price is cross-checked against its independently-sourced ticker price — anything that disagrees by more than 3% (a likely wrong-instrument match from an ambiguous ticker) is dropped rather than shown.

### RSI Ranking
Every scanned token ranked by live RSI, 1H or 4H, sortable. Shown as a plain number with a mini position bar — no "overbought/oversold" labels. Includes market-wide summary stats (avg RSI, overbought/oversold counts, hottest token).

### Order Book
Real resting bid/ask depth per token — not leveraged positions, not predicted liquidation levels. Sums bid vs. ask notional within ±3% of price to derive an imbalance score, and surfaces the single largest resting order (the "wall") on each side, with its exact price and size. Two columns: strongest buy pressure vs. strongest sell pressure. Shows which exchange each row's data actually came from. Snapshot per scan cycle, not continuously streamed — full order book depth for ~100 tokens at once isn't practical to stream live.

### Token Search
Search any scanned token to open a floating popup combining Pattern, RSI, Range, and Order Book data for that one token in one place. Minimize to a summary pill, maximize to a larger panel, or close — price ticks live while open.

## Trading Journal
Log trades (entry/SL/TP/leverage, R-multiple, scale-outs) and open trades get a live-tracked floating widget showing real-time P&L against SL/TP, independent of the current scan universe. Auto-resolves against live candles when TP/SL is hit.

## Data sources

Candle, ticker, and order book data is fetched from **KuCoin, OKX, Binance, and Bybit** in parallel per request — whichever responds first wins. In practice, Binance and Bybit block requests from many cloud/serverless IP ranges (a documented, general restriction — not specific to any one region), so **KuCoin is often the primary effective source** on serverless deployments, with OKX as secondary. This is also why nothing in the app is hardcoded to a single exchange: if one gets blocked mid-scan, the others silently cover for it.

## Stack

- Single-page vanilla JS/HTML frontend, no build step
- Detection math in `src/detectors.js`, a dependency-free script shared by the page, the tests, and the signals endpoint
- Netlify Functions (`netlify/functions/proxy.js`) as a CORS proxy + exchange-race layer to the exchange APIs
- Email alerts via a separate Netlify Function (`netlify/functions/send-alert.js`)
- All data (journal, hit-rate history, settings, dismissed widgets) stored in browser localStorage — no backend database

## Known limitations

- No cross-device sync (localStorage only)
- Alert endpoint sends only to a pre-approved recipient allowlist (`ALERT_ALLOWED_RECIPIENTS`), and refuses to send at all until that is configured
- Binance/Bybit data unavailable when self-hosted on most serverless platforms (IP-range blocking) — the app is designed to degrade to the other exchanges automatically when this happens
- Order Book and Fixed Range Volume Profile are both approximations built from OHLCV/depth-snapshot data, not tick-level or true liquidation feeds
- The quality score and A/B grade are **self-assessments, not measured performance**. Hit-rate history lives in localStorage, so it is per-browser and unauditable, and no realized outcome has been scored against fees and slippage yet. The `/signals` endpoint below exists to close that gap

## Detection library

`src/detectors.js` holds the pure indicator and pattern math — RSI, EMA, Bollinger bandwidth,
swing/pivot detection, 3-Drive, FVGs, S/R levels, the volume profile and the range detector.
It touches no DOM, no network and no storage.

The page loads it before its inline script and every export lands on the global object, so call
sites read exactly as they always did. The same file is `require()`d by the tests and by the
signals function, which means there is one copy of the math rather than three that can drift.

## Signals endpoint

`POST /.netlify/functions/signals` runs the detectors over a candle series you supply and returns
what they found. It is stateless, stores nothing, and makes no exchange calls of its own.

```
POST /.netlify/functions/signals
{ "symbol": "BTC", "tf": "ONE_HOUR", "candles": [{ "t":…, "o":…, "h":…, "l":…, "c":…, "v":… }, …] }
```

Send `{ "series": [ … ] }` instead to analyse up to 25 at once; one bad series is reported in place
and does not fail the batch. Valid timeframes are `SIX_HOUR` (4H candles), `ONE_HOUR` and
`THIRTY_MINUTE`, and a series needs at least 40 candles — the same floor the scanner uses.

The caller supplies the candles on purpose. Binance and Bybit block many serverless IP ranges, so a
scan-it-yourself endpoint would be both slow and partially blind, while a caller running elsewhere
is not restricted.

Every response carries `detectorVersion`, a hash of the detector code and its thresholds as loaded.
Tune a constant and the hash changes, so recorded signals separate into clean cohorts instead of a
silently mixed sample — which is what makes an honest hit rate possible later.

Optional env: `SIGNALS_TOKEN` (required as `x-signals-token` when set) and `APP_ORIGIN` to narrow CORS.

## Tests

No framework and no install — plain Node:

```
node test/detectors.js    # detection math
node test/signals.js      # signals endpoint
node test/security.js     # proxy allowlist + alert hardening
```
