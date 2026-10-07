# 3Drive Scanner

A real-time crypto scanner across the top 100 tokens by market cap — pattern detection, live rankings, and order book reads, all in one page.

## Tabs

### Scanner
Detects four setups across 4H/1H/30M, continuously via auto-refresh, and reads the Trader XO trend state alongside them:
- **Three Drives** — genuine harmonic structures using Fibonacci-proportional legs (not just "three higher highs"), confirmed by RSI divergence at each drive point
- **Fair Value Gaps** — graded A/B, used as confluence for other signals
- **Bollinger Band Squeeze** — volatility compression flagged as it happens
- **Fixed Range Volume Profile / Range Deviation** — anchored at the exact swing pivot of a real impulsive move (not just the start of a search window), builds a real volume profile from that pivot to now, and derives VAH/POC/VAL. A catalyst move has to clear both a volatility-relative bar (vs. that token's own recent range) and a volume-confirmation bar before it counts — tuned against synthetic noise until false positives dropped under 1%. Every detected range gets a 0–100 quality score and A/B/C grade; anything scoring below 50 is filtered out entirely rather than shown.
- **Trader XO Macro Trend (EMA 12 / 50)** — the `[@btc_charlie] Trader XO Macro Trend Scanner` as configured on the author's chart: fast EMA 12 vs slow EMA 50 on close. Trend is Bull while fast > slow, Bear while below, and an **arrow** is the cross itself. Evaluated on **closed candles only** (the still-forming candle is dropped), so an arrow can't appear and then vanish. Shown per timeframe (4H / 1H / 30M) in the token popup with how long ago the current trend's arrow printed, the EMA spread, price vs EMA 200, and a chop warning when the trend has flipped 3+ times in the last 20 candles. The script's own default slow EMA is 25 — change `XO_SLOW_EMA` in `src/detectors.js` (or pass `opts.slow`) to match a different chart.

Each signal gets a composite confidence score (support/resistance confluence, FVG confluence, volume confirmation at the formation candle, the token's own historical hit rate), trend-context filtering (flags lower-timeframe signals fighting the 4H trend), and weekend liquidity flagging.

### Gainers & Losers
Top 25 gainers/losers across 15m/30m/1h/4h windows. Price ticks live via WebSocket; the comparison window is recalculated against real wall-clock time on every render (not frozen at scan time), so it stays accurate no matter how long the tab's been open. Each token's candle-series price is cross-checked against its independently-sourced ticker price — anything that disagrees by more than 3% (a likely wrong-instrument match from an ambiguous ticker) is dropped rather than shown.

### RSI Ranking
Every scanned token ranked by live RSI, 1H or 4H, sortable. Shown as a plain number with a mini position bar — no "overbought/oversold" labels. Includes market-wide summary stats (avg RSI, overbought/oversold counts, hottest token).

### Order Book
Real resting bid/ask depth per token — not leveraged positions, not predicted liquidation levels. Sums bid vs. ask notional within ±3% of price to derive an imbalance score, and surfaces the single largest resting order (the "wall") on each side, with its exact price and size. Two columns: strongest buy pressure vs. strongest sell pressure. Shows which exchange each row's data actually came from. Snapshot per scan cycle, not continuously streamed — full order book depth for ~100 tokens at once isn't practical to stream live.

### Token Search
Search any scanned token to open a floating popup combining Pattern, RSI, Range, and Order Book data for that one token in one place. Minimize to a summary pill, maximize to a larger panel, or close — price ticks live while open.

## Logging a trade

The journal's **+ log trade** form is built to be quick rather than a wall of textboxes:

- **Direction** is a Long / Short toggle, **Timeframe** is a row of chips, and **Leverage** is a slider (with one-click presets) instead of typed numbers.
- **Result is automatic.** Leave *Exit* blank and the trade is **Open**; enter one and the same R the journal already computes decides **Win / Loss / Break-even** live, shown as a badge. There's no Result dropdown to get out of sync with the prices you entered. If your stop **or take profit** sits on the wrong side of entry for the chosen direction, the form says so next to the Save button, marks the field, and won't save it until it's fixed (a wrong-side level would otherwise auto-close the trade instantly).
- **Prices are one aligned row:** Entry, Stop loss, **Take profit** and Exit are four equal fields (two rows of two on a phone), so Take Profit is always visible, not tucked away.
- **live** buttons inside the Entry and Exit fields fill in the token's last scanned price (needs a scan to have run and the token to be in it).
- **Funding** lives under *Funding (optional)*, closed by default. Its suggested value only appears once you open that section, so a trade logged without touching it carries no hidden funding estimate.
- The **position size calculator** also reads Take Profit: it shows the profit if the target is hit (after the round-trip fee, same model as the journal's P&L) and the reward : risk against your stop.

### Editing a logged trade

Every trade card has a **✎ edit** button (next to ✕ delete). It swaps that card for the same form, pre-filled, right where the card was.

- You can change token, direction, timeframe, leverage, entry, stop loss, take profit, exit, funding and notes. Result and R are recomputed live, using the same maths as when logging (including any scale-outs).
- **Stop loss shows the *original* stop**, since that is what R is measured against. If you moved it with *Adjust SL*, the form says so and leaves the current stop where it is. Scale-outs and stop history are never touched by the form.
- Blanking *Exit* **re-opens** a closed trade (it counts as open from that moment, so auto-resolve doesn't instantly re-close it on the levels you just left). Changing a trade's levels or outcome by hand removes its **AUTO** tag; editing only the notes keeps it.
- If a scan closes the trade while you're editing it, saving asks before overwriting. Whatever you've typed survives a refresh of the journal. **Esc** cancels the edit; leaving the day or closing the journal does too.

## Fees and funding

Dollar P&L (journal, Weekly Balance, Weekly Summary, CSV, the trade card) now includes real costs, not just the raw price move:

- **Fees:** a round-trip taker fee (entry + exit) on notional (margin x leverage), at a **Fee rate** you set in Weekly Balance -> the gear icon (default 0.05% per side). Applied automatically to every trade, using the current setting — like margin, changing the rate later changes every trade's $ figure retroactively.
- **Funding:** entered manually per trade, in the journal form's **Funding ($, optional)** field, since the app has no way to know how long a position was actually held or what the exchange really charged. A suggestion is pre-filled from **Assumed funding rate** and **Assumed funding periods** (also in Weekly Balance settings) — notional x rate x periods, signed so a long pays when the rate is positive and a short receives it — but it's a starting guess, not a fetch: check your exchange and correct it. Editing the field once stops it from being overwritten by further suggestions on that trade.
- The trade card's $ figure has a hover tooltip breaking out the fee and funding that went into it.

## Confluence tab

## Confluence tab

Two sections: **Three Drives** (the classic harmonic pattern signals, unrelated to anything below) and **Weekly Summary**. The standalone RSI + Order Book + Trend confluence scoring engine has been retired — the tab now pairs pattern signals with a read of your own trading, not a second signal generator.

### Weekly Summary

A read of the Trading Journal, not a signal: figures and a bar chart for the current week's logged trades, always visible under Three Drives (no scan needed).

- **Figures:** trades, win rate (wins / all closed trades, matching the journal's own weekly row), total R, total $ P&L, best and worst trade. $ uses the same margin x leverage x price-move model as Weekly Balance (`jTradePnL`), so the numbers agree with the journal everywhere they're shown.
- **Chart:** a smooth cumulative-P&L line (Mon-Sun for the week, W1-W5 for the month), with a soft gradient fill down to zero, glow, and dot markers. Green if the range finished at or above zero, red if below. Hover any point for that day's (or week's) running total and its own change.
- **⤢ expand** opens a bigger view with a **Week / Month / All** switch and previous/next navigation (hidden in All, since there's no window to page through). Month mode buckets by calendar week (W1, W2, ...); **All** buckets adaptively — by day up to ~6 weeks of history, by week up to ~10 months, by month beyond that — so the full equity curve stays readable whether you've logged 10 trades or 1,000.
- **Max drawdown** (peak-to-trough decline in cumulative $, and as a % of that peak) is shown in the expanded view, not the compact card.

## Top bar

Search, Alerts and Journal live in the top bar, so they're one click away. Press **/** anywhere (outside a text field or dialog) to jump to token search. The bell shows how many trend arrows have printed since you last opened Alerts. On narrow screens search collapses to an icon and the BTC/ETH prices drop to a second row; the **⋯** menu keeps the less-used settings (theme, market, range engine, auto-scan, hit rate).

## Trend-shift notifications

When a Trader XO arrow prints on **4H or 1H** (30M is opt-in), the app shows an in-app popup and, if you've enabled them, a desktop notification. No email involved. Configure under **Alerts → Settings → Trend shifts**, including a list of tokens to mute (or hit "mute" on any popup).

- Checked a few seconds after each candle closes (see below) and again at the end of every scan, so it only works while the app is open. With the watcher off, an arrow is caught within one auto-scan interval of its candle closing.
- Only *new* arrows are announced. The last announced arrow per token/timeframe is remembered in localStorage, so reloads don't repeat, and the first scan after enabling just records a baseline instead of announcing every existing arrow.
- An arrow older than two candles (or 1.25× your auto-scan interval, if longer) is treated as stale and recorded silently.
- **Live at the candle close:** you don't have to wait for a scan. A small watcher checks a few seconds after every 4H / 1H (and 30M, if switched on) close: it re-fetches just that timeframe for the tokens from your last scan, recomputes the arrow and notifies straight away, through the same path a scan uses (same de-duplication, mute list, log and sound). It only ever acts on *closed* candles, so an arrow can't un-cross after you've been told. If the exchange is a few seconds late publishing a candle it retries (12s, 25s, 45s); if the exchange or network is down it makes one pass and leaves it to the next scan rather than hammering it. It stands down while a scan is running, runs off a Web Worker heartbeat so a hidden tab doesn't throttle it, and needs one scan first so it knows which tokens to follow. Turn it off under Alerts → Settings → Check at every candle close.
- **Today's log:** every arrow you were notified about is kept in **Alerts → Today's log** (newest first, with the time its candle closed, the price, a filter by timeframe and a dot on anything new since you last looked). Click a row to open the token. The log **resets every trading day**. Crypto never closes, so the day starts at a time you set in Alerts → Settings (default 00:00 local time, matching the journal's days; UTC is an option). It empties itself at that moment even if the app is left open overnight, and anything older is dropped on the next read even if the app was closed. The bell in the top bar counts arrows logged since you last opened it.
- **Sound is opt-in** (off by default): a rising tone for a Bull arrow, a falling tone for Bear, a neutral one when a burst is mixed. Pick Chime, Ping or Alarm and a volume, with a preview button. The tones are synthesised in the browser (no audio files), and browsers keep audio locked until you've clicked on the page once — if an arrow lands before that, the sound is skipped and noted in the scan log. Desktop notifications are sent silent so this is the single control for noise.
- Bursts are collapsed: at most 5 popups plus a "+N more", and one summary desktop notification when more than 3 fire at once.
- Desktop notifications need a one-time browser permission and a secure context (https or localhost). They don't work when the tab is closed — there is no push backend.

## Trading Journal
Log trades (entry/SL/TP/leverage, R-multiple, scale-outs) and open trades get a live-tracked floating widget showing real-time P&L against SL/TP, independent of the current scan universe. Auto-resolves against live candles when TP/SL is hit.

## Data sources

Candles are fetched **directly from Binance and Bybit by the browser** first. Both send
permissive CORS on their public market-data endpoints, and a visitor's own IP is not
subject to the cloud-range blocking that stops the serverless functions reaching them —
so this both restores two sources that otherwise contribute nothing and removes a
function invocation per fetch. If the direct calls fail for any reason (CORS, network,
an unlisted symbol, a short payload) the proxy path below runs exactly as before.

Ticker and order book data, and any candle fetch the direct path could not serve, go
through the proxy: **KuCoin, OKX, Binance, and Bybit** in parallel per request — whichever responds first wins. In practice, Binance and Bybit block requests from many cloud/serverless IP ranges (a documented, general restriction — not specific to any one region), so **KuCoin is often the primary effective source** on serverless deployments, with OKX as secondary. This is also why nothing in the app is hardcoded to a single exchange: if one gets blocked mid-scan, the others silently cover for it.

## Stack

- Single-page vanilla JS/HTML frontend, no build step
- Detection math in `src/detectors.js`, a dependency-free script shared by the page, the tests, and the signals endpoint
- Netlify Functions (`netlify/functions/proxy.js`) as a CORS proxy + exchange-race layer to the exchange APIs
- Email alerts via a separate Netlify Function (`netlify/functions/send-alert.js`)
- All data (journal, hit-rate history, settings, trend-arrow history, dismissed widgets) stored in browser localStorage — no backend database

## Known limitations

- No cross-device sync (localStorage only)
- Alert endpoint sends only to a pre-approved recipient allowlist (`ALERT_ALLOWED_RECIPIENTS`), and refuses to send at all until that is configured
- Binance/Bybit data unavailable when self-hosted on most serverless platforms (IP-range blocking) — the app is designed to degrade to the other exchanges automatically when this happens
- Order Book and Fixed Range Volume Profile are both approximations built from OHLCV/depth-snapshot data, not tick-level or true liquidation feeds
- The quality score and A/B grade are **self-assessments, not measured performance**. Hit-rate history lives in localStorage, so it is per-browser and unauditable, and no realized outcome has been scored against fees and slippage yet. The `/signals` endpoint below exists to close that gap

## Range engines — FRVP and V1

The header carries an **FRVP | V1** toggle. It picks which range engine the scanner
uses, and persists per browser. FRVP is the default.

**FRVP (`range_frvp_v2`)** is a Fixed Range Volume Profile in the literal sense — the
profile is computed once and then frozen:

1. **Anchor** on the swing high (or low) of a genuine catalyst move.
2. **Walk forward while candles _close_ inside the box.** Wicks may pierce freely. The
   lower bound is a consolidation shelf — the densest cluster of following lows — not
   the lowest wick, so a single spike bar cannot define the boundary that decides where
   the break is.
3. **Freeze** at the candle before the first close outside the box, and compute the 70%
   value area over that window. VAH/POC/VAL never move again.
4. **Signal on the reclaim.** A close beyond the value area by ≥1.5% followed by a close
   back inside it. Both legs and the excursion extreme are recorded, so the trade is
   fully stated rather than inferred: **entry** at the reclaim close, **stop** beyond the
   excursion extreme, **target** the opposite edge of the value area, and the stop moved
   to entry at the **Gann 0.5** level.

A Gann box is reported alongside every frozen range — `0` at VAH, `1` at VAL, so `0.5` is
the midpoint. A strong reclaim candle can close past 0.5, in which case
`breakevenPassedAtEntry` says so rather than the level being quietly dropped.

Because a profile can only be frozen once price has left the box, FRVP publishes fewer
setups than V1 — every one it does publish has a completed structure behind it. Boxes
that are still contained appear as a dashed **FORMING** badge with the provisional
bounds and no value-area numbers; there is nothing to trade yet, and the badge says so.

**V1 (`detectRange`)** is the original: it profiles from the anchor to the *current*
candle and recomputes every scan, so its value area drifts as candles arrive. Kept on
the toggle so the two can be compared on the same charts.

Each engine has its own constants (`RANGE_*` and `RANGE_V2_*`), so tuning one never
moves the other.

### Calibration

FRVP uses **100 rows** and a **90% value area**, matching a real TradingView FRVP setup
(`Row Size 100`, `Value Area Volume 90`) rather than V1's 30 / 70%. Row size alone moves
the levels a long way, so this is not cosmetic: on the window below, V1's defaults put
VAH 28 USD lower.

Validated by inversion on ETHUSDT.P 1h (OKX). Searching every (P1, P2) pair over 300 real
bars for the window that reproduces a labelled chart lands on an 88-bar window,
2026-08-21 17:00 → 2026-08-25 08:00:

| | computed | labelled chart | delta |
|---|---|---|---|
| VAH | 2531.85 | 2532 | −0.15 (−0.006%) |
| POC | 2427.91 | ~2430 | −2.09 |
| VAL | 2399.74 | ~2405.5 | −5.76 (3 rows of 1.94) |

The VAH agreement confirms both the distribution maths and the settings. The residual on
POC and VAL is about 2–3 rows, which is the same order as two other known sources of
noise: reading a level off a screenshot, and which exchange's volume is used (the same
window off Binance instead of OKX moves POC and VAL by ~2 USD). It is therefore **not**
treated as an algorithm difference — a pairwise value-area expansion was tried and moved
VAL only 1.7 closer while selecting a different window, which is fitting to noise rather
than evidence.

`RANGE_V2_MAX_BARS` is 120 because that labelled window is 88 bars; a 60-bar cap
rejected the very setup the engine exists to find.

**Anchor selection is discretionary.** P2 is chosen by eye on the chart, so the shelf rule
is an approximation of a judgement call, not a reproduction of it. For a specific window,
`frvpFromAnchors(highs, lows, volumes, p1, p2)` returns the profile for exactly those two
anchors — reachable over HTTP via the `anchors` field on the signals endpoint.

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
node test/backtest-xo.js  # the Trader XO edge lab below (offline — no network)
node test/backtest-donchian.js  # the Donchian breakout edge lab (offline — no network)
node test/journal-edit.js # journal validation + edit rules (src/journal-edit.js)
node test/market-activity.js # quiet-market logic (src/market-activity.js)
```

## Trader XO edge lab

`scripts/backtest-xo.js` is a standalone backtest for the Trader XO arrow, run **locally** on
your own machine (this repo's own dev/CI sandbox can't reach Binance):

```
node scripts/backtest-xo.js --symbol BTCUSDT --interval 1h --days 365
node scripts/backtest-xo.js --symbol ETHUSDT --interval 4h --days 730 --market spot
node scripts/backtest-xo.js --symbol SOLUSDT --interval 1h --days 180 --stopPct 1.5 --r 2 --out sol-1h.csv
```

It downloads real historical candles from Binance's public API, finds **every** arrow across
that history using `calcEMA` straight from `src/detectors.js` (zero drift from what the app
itself runs — `detectTraderXO` only ever reports the *latest* arrow, which is right for a live
app but useless for a backtest), and reports:

- **Forward return** at 1/5/10/20 bars after each arrow — does price actually keep moving the
  arrow's way, on average?
- **A simple fixed-stop / fixed-target simulation** (your `--stopPct` / `--r`) — win rate and
  expectancy in R if you mechanically traded every arrow.
- The same two, **split by XO's own "choppy" flag** (`XO_CHOP_WINDOW`/`XO_CHOP_FLIPS`) — the one
  filter the live app already offers, so it's worth checking whether it actually helps.
- **Bull vs Bear**, split throughout, since a trend detector often behaves very differently long vs short.

Pass `--out results.csv` to get every arrow and its outcome as a CSV, for the tool doing the same job the journal's own P&L math does. This is a mechanical simulation for research, not a full backtest engine — no fees, funding, or slippage (see the journal's own Fee/Funding settings for what those cost in this app), one position at a time, and a same-candle stop+target hit is scored as the stop (worst case, since intra-candle order isn't knowable from OHLC alone). It answers "does this signal have any edge at all", not "what would I have made".

## Donchian breakout edge lab

`scripts/backtest-donchian.js` tests a channel breakout (a candle closes beyond the highest high
/ lowest low of the prior N candles) across **many coins at once**, run **locally** because this
repo's sandbox can't reach Binance. It exists to answer one question before any alert is built:
*does this rule still have an edge after fees, slippage and funding?*

```
node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT --interval 4h --days 730
node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --interval 1d --days 1460 --entry 20,55 --exit 10,20
node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --out donchian-trades.csv
```

How it is built, and what to read in the output:

- **1R is an ATR stop** (`--atrMult` x ATR at entry), not a fixed percentage, and the stop is checked
  intrabar with gap-aware fills. Exit is the stop or a close back through the prior `--exit`-candle channel.
- **Costs are charged in R** (`--fee`, `--slip`, `--funding`): round-trip cost divided by the stop
  distance, so a tight stop visibly makes fees expensive. Slippage (0.02%) and funding (0.01% / 8h) are
  assumptions; change them to match what you actually pay.
- **Splits, not a verdict:** long vs short, BTC daily trend (EMA 12/50) aligned vs against, breakout
  volume confirmed vs not, and whether the app's own BB squeeze rule was active just before the
  breakout. Every split uses only information available at the breakout candle's close.
- **Robustness:** first half vs second half of the data, a per-coin table, and a parameter sweep
  (`--entry 10,20,55`). Prefer settings whose neighbours also look fine; the single best cell is usually luck.
- **Stop distance vs your leverage:** how often the stop is wider than half the liquidation distance at
  `--lev` (default 14x), and the leverage that would keep liquidation twice as far as the stop.

Limits worth remembering: coins move together, so pooled trades are not independent and the t-stat is
generous; entries and exits are at candle closes with no order-book model; and win rate is the wrong
number to judge a breakout system by (they win roughly a third of the time). The offline tests prove
the *mechanics* (no look-ahead, correct fills, correct cost math, squeeze parity with `calcBBSqueeze`)
and that the lab rejects a random walk while detecting real momentum. They cannot prove the rule works
on real markets. Only running it against real candles can.


## Live prices when Binance is unreachable

Live prices come from Binance's WebSocket, opened **directly from your browser**. The scanner itself doesn't
depend on that: candles and the token list are fetched server-side by the Netlify proxy. So on a network where
the browser can't reach Binance (the console shows `net::ERR_NAME_NOT_RESOLVED` for `stream.binance.com`), the
scan works but the header shows "—" and the pill never reaches "live".

The app now detects this. After two failed connection attempts in a row it logs what happened, switches the
pill to **`polling · 30s`**, and refreshes prices (header, token list, floating open-trade cards) every 30 seconds
through the proxy's ticker endpoint, only while the tab is visible. It keeps retrying the real socket in the
background and switches back to **live** (and stops polling) as soon as one connects. 30 seconds because the
proxy caches tickers for 15 seconds, so polling faster gains nothing and costs Netlify invocations.

## Market activity alert (quiet-market warning)

A pill in the top bar (**Market · normal / QUIET / ACTIVE**) tells you whether trading is unusually thin right
now, so you can size down or wait. When the market turns **quiet** you also get a toast and, if enabled in your
alert settings, a desktop notification (and the alert sound, if you've turned that on). Leaving a lull only
shows a quiet toast. Click the pill to refresh it.

How it decides (logic in `src/market-activity.js`, unit-tested in `test/market-activity.js`):

- Every hour, two minutes after the candle closes, it reads 1H candles for 12 liquid coins through the proxy and
  compares the **latest 4 closed hours with the same 4 hours on previous days** (volume has a strong
  time-of-day pattern, so only the comparison with the same hours means anything).
- **Weekdays are compared with weekdays and weekends with weekends**, so a normally slow Sunday doesn't cry
  "quiet". The catch: one request returns about 12 days of hourly candles, so a weekend baseline rests on only
  ~2 days and is noisier. The tooltip says when it is working from few comparable days.
- The reading is the **median across the 12 coins**, so one coin's news can't trigger it.
- **Quiet** = volume at or below **65%** of normal *and* price movement no bigger than normal (low volume during
  a violent move is news, not a lull). It ends once volume recovers to **80%** (or movement jumps to 125%), so a
  reading hovering at the line can't flip the alert on and off. At most one quiet alert per 3 hours.

**The thresholds are untested defaults**, reasonable guesses, not calibrated on history. Expect to tune them
(`MA_DEFAULTS` in `src/market-activity.js`) after a few weeks of seeing how often it fires.
