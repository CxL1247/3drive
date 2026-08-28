# 3Drive Scanner

A real-time crypto scanner that detects the **Three Drives** harmonic pattern across the top 100 tokens by market cap, confirmed by RSI divergence, and ranked by a composite confidence score.

## What it does

- **Pattern detection** — identifies genuine Three Drives structures using Fibonacci-proportional price legs (not just "three higher highs," which would also catch head-and-shoulders-like shapes)
- **RSI divergence confirmation** — a signal only fires when price and RSI disagree at each drive point (lower RSI highs on bearish setups, higher RSI lows on bullish setups)
- **Multi-timeframe scanning** — 4H, 1H, and 30M, checked continuously via auto-refresh
- **Confidence scoring** — each signal is scored from the base pattern quality, then adjusted for:
  - Support/resistance confluence (clustered, multi-touch zones — not raw pivots)
  - Fair value gap confluence (grade A/B only)
  - Volume confirmation at the pattern's actual formation candle
  - The token's own historical hit rate for that signal type
- **Trend-context filtering** — flags (and excludes from alerts/tracking) lower-timeframe signals that fight the 4H trend
- **Weekend liquidity flagging** — marks signals formed on weekends, excluded from alerts
- **Hit rate tracking** — every signal is logged with its real outcome, broken out by category (standard / trend-conflict / weekend), so the filtering assumptions above can be checked against actual data rather than just trusted

## Data sources

Candle and ticker data is fetched from **KuCoin, OKX, Binance, and Bybit** in parallel — whichever responds first wins. In practice, Binance and Bybit block requests from cloud/serverless IP ranges (not a Nigeria-specific restriction — confirmed via direct testing), so **KuCoin is the primary effective source** for most deployments, with OKX as secondary.

## Stack

- Single-page vanilla JS/HTML frontend, no build step
- Netlify Functions as a CORS proxy to the exchange APIs
- Email alerts via a separate Netlify Function
- All data (journal, hit-rate history, settings) stored in browser localStorage — no backend database

## Known limitations

- No cross-device sync (localStorage only)
- Alert endpoint is currently unauthenticated
- Binance/Bybit candle data unavailable when self-hosted on most serverless platforms (IP-range blocking)
