#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// TRADER XO EDGE LAB — a standalone backtest for the Macro Trend (EMA 12/50)
// arrow the app alerts on. Run this LOCALLY (this repo's sandbox can't reach
// Binance): it downloads real historical candles, finds every arrow using the
// exact same EMA math as src/detectors.js (via calcEMA, imported directly —
// not reimplemented), and reports whether the arrow actually predicted
// anything, before you trust it with real money.
//
// USAGE
//   node scripts/backtest-xo.js --symbol BTCUSDT --interval 1h --days 365
//   node scripts/backtest-xo.js --symbol ETHUSDT --interval 4h --days 730 --market spot
//   node scripts/backtest-xo.js --symbol SOLUSDT --interval 1h --days 180 --stopPct 1.5 --r 2 --out sol-1h.csv
//
// FLAGS (all optional except --symbol)
//   --symbol    e.g. BTCUSDT                          (required)
//   --interval  Binance interval string: 1h, 4h, 30m, 15m, 1d, ...   default 1h
//   --days      how much history to pull                             default 365
//   --market    futures | spot                                       default futures
//   --fast      fast EMA period (matches the app's setting)          default 12
//   --slow      slow EMA period (matches the app's setting)          default 50
//   --stopPct   simulated stop distance, % of entry                  default 1.0
//   --r         reward multiple for the simulated target (R)         default 2
//   --maxBars   bars to hold before marking a trade as timeout       default 60
//   --out       write every arrow + its outcome to this CSV path     (optional)
//
// WHAT IT MEASURES
//   1. Forward return at fixed horizons (1/5/10/20 bars) after each arrow —
//      does price actually keep moving the arrow's way, on average?
//   2. A simple fixed-stop / fixed-target simulation (your --stopPct / --r) —
//      win rate and expectancy in R if you mechanically traded every arrow.
//   3. The same two, split by whether XO's own "choppy" flag was set at the
//      time (XO_CHOP_WINDOW/XO_CHOP_FLIPS from detectors.js) — this is the
//      one built-in filter the live app already offers, so it's worth
//      checking whether it actually helps.
//   4. Bull vs Bear split throughout, since a trend detector often performs
//      very differently long vs short.
//
// This is a MECHANICAL simulation for research, not a full backtest engine:
// no fees/funding/slippage (see the journal's own fee/funding settings for
// what those cost in this app), one position at a time, same-candle
// stop+target hits are scored as the stop (worst case, since intra-candle
// order isn't knowable from OHLC alone). Treat the output as "does this
// signal have any edge at all", not as a P&L projection.
//
// This file can also be require()'d as a module (see module.exports at the
// bottom) — that's how test/backtest-xo.js exercises it without hitting the
// network.
// ══════════════════════════════════════════════════════════════════════════
'use strict';
const https = require('https');
const path = require('path');
const fs = require('fs');
const D = require(path.join(__dirname, '..', 'src', 'detectors.js'));
// XO_WARMUP / XO_CHOP_WINDOW / XO_CHOP_FLIPS live under DETECTOR_CONSTANTS, not as top-level
// exports (only XO_FAST_EMA / XO_SLOW_EMA / XO_MACRO_EMA / XO_TF_MS are top-level).
const XO_WARMUP = D.DETECTOR_CONSTANTS.XO_WARMUP;
const XO_CHOP_WINDOW = D.DETECTOR_CONSTANTS.XO_CHOP_WINDOW;
const XO_CHOP_FLIPS = D.DETECTOR_CONSTANTS.XO_CHOP_FLIPS;

const INTERVAL_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '8h': 28800000, '12h': 43200000,
  '1d': 86400000, '3d': 259200000, '1w': 604800000
};

// ── fetch klines, paginated, same "never throw, resolve with what you got" pattern as
//    netlify/functions/proxy.js's fetchUrl ──
function httpGet(url, ms) {
  ms = ms || 15000;
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (backtest-xo)' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', errCode: e.code || e.message }));
    req.setTimeout(ms, () => { req.destroy(); resolve({ status: 0, body: '', errCode: 'TIMEOUT' }); });
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchKlines(symbol, interval, startTime, endTime, market, opts) {
  const tfMs = INTERVAL_MS[interval];
  if (!tfMs) throw new Error(`Unrecognised interval "${interval}". Use a Binance interval string, e.g. 1h, 4h, 30m, 1d.`);
  const err = (opts && opts.err) || console.error;
  const onProgress = opts && opts.onProgress;
  const host = market === 'spot' ? 'api.binance.com/api/v3' : 'fapi.binance.com/fapi/v1';
  const limit = market === 'spot' ? 1000 : 1500;
  const all = [];
  let cursor = startTime;
  let page = 0;
  while (cursor < endTime) {
    const url = `https://${host}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=${limit}`;
    const res = await httpGet(url);
    if (res.status !== 200) {
      err(`  fetch failed (status ${res.status}${res.errCode ? ', ' + res.errCode : ''}) at page ${page + 1} — `
        + (res.body ? res.body.slice(0, 200) : '(no body)'));
      if (page === 0) throw new Error('Could not fetch any candles. Check the symbol exists on Binance ' + market + ' and that this machine can reach Binance.');
      break; // partial history is still useful — keep what we have
    }
    let rows;
    try { rows = JSON.parse(res.body); } catch (e) { err('  could not parse response as JSON — stopping'); break; }
    if (rows && rows.code !== undefined) { err('  Binance error: ' + res.body); break; } // e.g. {"code":-1121,"msg":"Invalid symbol."}
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    const lastOpen = rows[rows.length - 1][0];
    if (onProgress) onProgress(all.length);
    if (rows.length < limit || lastOpen + tfMs >= endTime) break; // reached the end
    cursor = lastOpen + tfMs;
    page++;
    await sleep(250); // polite pacing — no need to hammer a public endpoint
  }
  return all;
}

// ── find every arrow across the whole history (same flip logic as detectTraderXO in
//    src/detectors.js, using its exported calcEMA so the math has zero drift from production —
//    detectTraderXO itself only ever reports the LATEST arrow, which is right for a live app but
//    useless for a backtest that needs every one) ──
function findAllArrows(closes, times, fast, slow) {
  fast = fast || D.XO_FAST_EMA; slow = slow || D.XO_SLOW_EMA;
  const n = closes.length;
  if (n < XO_WARMUP + 10) return [];
  const fastArr = D.calcEMA(closes, fast);
  const slowArr = D.calcEMA(closes, slow);
  const arrows = [];
  let state = null;
  for (let i = Math.max(slow, XO_WARMUP); i < n; i++) {
    const s = fastArr[i] > slowArr[i] ? 'bull' : fastArr[i] < slowArr[i] ? 'bear' : state;
    if (s === null) continue;
    if (state !== null && s !== state) arrows.push({ dir: s, idx: i, time: times[i], price: closes[i] });
    state = s;
  }
  return arrows;
}
// Same chop rule the live app uses (XO_CHOP_WINDOW/XO_CHOP_FLIPS), evaluated AS OF each arrow —
// how many flips occurred in the window immediately before this one, never using future arrows.
function isChoppyAt(arrows, i) {
  let flips = 0;
  for (let j = i; j >= 0 && arrows[i].idx - arrows[j].idx < XO_CHOP_WINDOW; j--) flips++;
  return flips >= XO_CHOP_FLIPS;
}

// ── outcomes ──
function forwardReturn(arrow, closes, bars) {
  const idx = arrow.idx + bars;
  if (idx >= closes.length) return null;
  const move = (closes[idx] - arrow.price) / arrow.price;
  return arrow.dir === 'bull' ? move : -move;
}
// Walks forward from the arrow using each bar's high/low. Same-candle stop+target is scored as
// the stop (worst case, since intra-candle order is unknown from OHLC alone).
function simulateTrade(arrow, highs, lows, closes, stopPct, rMult, maxBars) {
  const entry = arrow.price, long = arrow.dir === 'bull';
  const stopDist = entry * stopPct;
  const stop = long ? entry - stopDist : entry + stopDist;
  const target = long ? entry + stopDist * rMult : entry - stopDist * rMult;
  const end = Math.min(closes.length - 1, arrow.idx + maxBars);
  for (let i = arrow.idx + 1; i <= end; i++) {
    const hitStop = long ? lows[i] <= stop : highs[i] >= stop;
    const hitTarget = long ? highs[i] >= target : lows[i] <= target;
    if (hitStop) return { outcome: 'loss', r: -1, bars: i - arrow.idx };
    if (hitTarget) return { outcome: 'win', r: rMult, bars: i - arrow.idx };
  }
  const lastClose = closes[end];
  const movePct = long ? (lastClose - entry) / entry : (entry - lastClose) / entry;
  return { outcome: 'timeout', r: movePct / stopPct, bars: end - arrow.idx };
}

function summarize(label, rows, log) {
  log = log || console.log;
  if (!rows.length) { log(`  ${label}: no arrows`); return; }
  const wins = rows.filter(r => r.outcome === 'win').length;
  const losses = rows.filter(r => r.outcome === 'loss').length;
  const timeouts = rows.filter(r => r.outcome === 'timeout').length;
  const decided = wins + losses;
  const winRate = decided ? (wins / decided * 100) : null;
  const expectancy = rows.reduce((a, r) => a + r.r, 0) / rows.length;
  const fwd = (n) => {
    const vals = rows.map(r => r.fwd[n]).filter(v => v != null);
    return vals.length ? (vals.reduce((a, v) => a + v, 0) / vals.length * 100) : null;
  };
  const fmtPct = (v) => v == null ? '  n/a' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const fmtR = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';
  log(`  ${label.padEnd(22)} n=${String(rows.length).padStart(5)}  win%=${winRate == null ? ' n/a' : winRate.toFixed(1).padStart(5)}  ` +
    `expectancy=${fmtR(expectancy).padStart(7)}  (${wins}W/${losses}L/${timeouts}T)  ` +
    `fwd 1/5/10/20 bars: ${fmtPct(fwd(1))} / ${fmtPct(fwd(5))} / ${fmtPct(fwd(10))} / ${fmtPct(fwd(20))}`);
}

// ── the whole run, as a single testable function. Everything that touches the network, the
//    filesystem or process.exit is confined to here and to the CLI block below — findAllArrows /
//    simulateTrade / forwardReturn / isChoppyAt / summarize are pure and unit-tested directly. ──
async function runBacktest(opts) {
  opts = opts || {};
  const symbol = opts.symbol;
  const interval = opts.interval || '1h';
  const days = opts.days || 365;
  const market = opts.market || 'futures';
  const fast = opts.fast || D.XO_FAST_EMA;
  const slow = opts.slow || D.XO_SLOW_EMA;
  const stopPct = opts.stopPct || 0.01;
  const rMult = opts.rMult || 2;
  const maxBars = opts.maxBars || 60;
  const outCsv = opts.outCsv || null;
  const log = opts.log || console.log;
  const err = opts.err || console.error;
  const fetch = opts.fetch || fetchKlines;

  if (!symbol) return { error: 'symbol is required' };
  if (!INTERVAL_MS[interval]) return { error: `Unrecognised interval "${interval}"` };

  log(`Trader XO edge lab — ${symbol} ${interval} (${market}), last ${days} days, EMA ${fast}/${slow}`);
  const end = Date.now();
  const start = end - days * 86400000;
  let raw;
  try {
    raw = await fetch(symbol, interval, start, end, market, {
      err, onProgress: (n) => { if (process.stdout && process.stdout.write) process.stdout.write(`\r  fetching ${symbol} ${interval} (${market})\u2026 ${n} candles`); }
    });
  } catch (e) {
    err('\n' + e.message);
    return { error: e.message };
  }
  if (process.stdout && process.stdout.write) process.stdout.write('\n');

  if (raw.length < XO_WARMUP + 20) {
    err(`Only got ${raw.length} candles — not enough history for a ${slow}-period EMA to settle. Try a longer --days or a shorter --interval.`);
    return { error: 'not enough candles', candleCount: raw.length };
  }
  const closes = raw.map(r => parseFloat(r[4]));
  const highs  = raw.map(r => parseFloat(r[2]));
  const lows   = raw.map(r => parseFloat(r[3]));
  const times  = raw.map(r => r[0]);
  log(`Loaded ${closes.length} candles, ${new Date(times[0]).toISOString().slice(0, 10)} to ${new Date(times[times.length - 1]).toISOString().slice(0, 10)}\n`);

  const arrows = findAllArrows(closes, times, fast, slow);
  if (!arrows.length) {
    log('No arrows found in this range \u2014 the trend never flipped, or there is not enough history.');
    return { arrows: 0, rows: [] };
  }
  log(`Found ${arrows.length} arrows (${arrows.filter(a => a.dir === 'bull').length} bull, ${arrows.filter(a => a.dir === 'bear').length} bear)\n`);

  const rows = arrows.map((a, i) => {
    const sim = simulateTrade(a, highs, lows, closes, stopPct, rMult, maxBars);
    return {
      time: new Date(a.time).toISOString(), dir: a.dir, price: a.price,
      choppy: isChoppyAt(arrows, i),
      fwd: { 1: forwardReturn(a, closes, 1), 5: forwardReturn(a, closes, 5), 10: forwardReturn(a, closes, 10), 20: forwardReturn(a, closes, 20) },
      outcome: sim.outcome, r: sim.r, bars: sim.bars
    };
  });

  log(`Simulated rule: ${(stopPct * 100).toFixed(2)}% stop, ${rMult}R target, ${maxBars}-bar timeout (mark-to-market R). No fees/funding/slippage.\n`);
  log('OVERALL');
  summarize('All arrows', rows, log);
  summarize('Bull arrows', rows.filter(r => r.dir === 'bull'), log);
  summarize('Bear arrows', rows.filter(r => r.dir === 'bear'), log);
  log('\nCHOP FILTER \u2014 does skipping "choppy" arrows (the live app\'s own flag) actually help?');
  summarize('Not choppy', rows.filter(r => !r.choppy), log);
  summarize('Choppy', rows.filter(r => r.choppy), log);

  if (outCsv) {
    const header = 'time,dir,price,choppy,fwd_1,fwd_5,fwd_10,fwd_20,outcome,r,bars\n';
    const lines = rows.map(r => [r.time, r.dir, r.price, r.choppy, r.fwd[1], r.fwd[5], r.fwd[10], r.fwd[20], r.outcome, r.r.toFixed(3), r.bars].join(','));
    fs.writeFileSync(outCsv, header + lines.join('\n') + '\n');
    log(`\nWrote every arrow + outcome to ${outCsv}`);
  }
  log('\nThis is a mechanical simulation for research \u2014 see the comment header in this file for what it does and does not account for.');
  return { arrows: arrows.length, rows };
}

// ── CLI entrypoint — only runs when this file is executed directly, never on require() ──
if (require.main === module) {
  (function () {
    function parseArgs(argv) {
      const out = {};
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
      }
      return out;
    }
    const args = parseArgs(process.argv.slice(2));
    if (!args.symbol) {
      console.error('Usage: node scripts/backtest-xo.js --symbol BTCUSDT [--interval 1h] [--days 365] [--market futures|spot] ...');
      console.error('See the comment header in this file for the full flag list.');
      process.exit(1);
    }
    runBacktest({
      symbol: args.symbol.toUpperCase(),
      interval: args.interval || '1h',
      days: Math.max(1, parseInt(args.days, 10) || 365),
      market: args.market === 'spot' ? 'spot' : 'futures',
      fast: parseInt(args.fast, 10) || D.XO_FAST_EMA,
      slow: parseInt(args.slow, 10) || D.XO_SLOW_EMA,
      stopPct: (parseFloat(args.stopPct) || 1.0) / 100,
      rMult: parseFloat(args.r) || 2,
      maxBars: Math.max(5, parseInt(args.maxBars, 10) || 60),
      outCsv: args.out || null
    }).then((result) => { if (result && result.error) process.exit(1); });
  })();
} else {
  module.exports = { findAllArrows, isChoppyAt, forwardReturn, simulateTrade, summarize, fetchKlines, runBacktest, INTERVAL_MS };
}
