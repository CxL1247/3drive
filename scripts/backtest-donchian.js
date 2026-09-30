#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// DONCHIAN BREAKOUT EDGE LAB — a standalone backtest for a 20-bar channel
// breakout on 4H / daily, run across MANY coins at once. Like scripts/backtest-xo.js
// this runs LOCALLY (this repo's sandbox can't reach Binance): it downloads real
// candles, simulates every breakout, and tells you whether the rule had any edge
// AFTER fees, slippage and funding — before it gets anywhere near an alert.
//
// USAGE
//   node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --interval 4h --days 730
//   node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT --interval 1d --days 1460 --entry 20,55 --exit 10,20
//   node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --out donchian-trades.csv
//
// FLAGS (all optional except --symbols / --symbol)
//   --symbols   comma list, e.g. BTCUSDT,ETHUSDT,SOLUSDT          (required)
//   --interval  Binance interval string: 4h, 1d, 1h, ...          default 4h
//   --days      how much history to pull                          default 730
//   --market    futures | spot                                    default futures
//   --entry     channel length(s) for ENTRY, comma list           default 20
//   --exit      channel length(s) for the trailing EXIT           default 10
//   --atr       ATR period for the initial stop / R               default 14
//   --atrMult   initial stop = atrMult x ATR at entry  (1R)       default 2
//   --fee       taker fee per side, % of notional                 default 0.05
//   --slip      assumed slippage per side, % of notional          default 0.02  (a guess — change it)
//   --funding   funding per 8h, % of notional (longs pay, shorts receive)   default 0.01  (Binance baseline)
//   --volMult   "volume confirmed" = breakout volume >= volMult x prior-20 average   default 1.5
//   --lev       your leverage, only used for the liquidation-vs-stop readout   default 14
//   --btc       on | off — split results by BTC daily EMA 12/50 trend        default on
//   --out       write every simulated trade to this CSV path      (optional)
//
// THE RULE (long side; shorts mirror it)
//   ENTRY   a candle CLOSES above the highest high of the PRIOR --entry candles (the current
//           candle is excluded — including it is the classic look-ahead bug).
//   1R      --atrMult x ATR(--atr) at the entry candle. Stop sits 1R below entry and is checked
//           intrabar; if a candle gaps through the stop the fill is the open, not the stop.
//   EXIT    whichever comes first: the stop, or a candle closing below the lowest low of the
//           prior --exit candles (the trailing channel exit). Still open at the end of the data
//           is marked to the last close.
//   One position per coin at a time. Re-entry is allowed from the candle after an exit.
//
// COSTS ARE CHARGED IN R, so they show up where they hurt:
//   cost R = round-trip (fee + slip) / stop distance.   A tight stop makes fees expensive.
//   funding R = funding x hours held / 8 / stop distance.
//
// WHAT IT REPORTS
//   1. A parameter SWEEP (pooled across coins) — n, win %, payoff, net expectancy, t-stat,
//      worst losing streak. Pick parameters whose NEIGHBOURS are also fine, not the single best.
//   2. The first parameter set in detail: long/short, gross vs net, BTC daily trend
//      aligned vs against, volume confirmed vs not, recent squeeze vs not, first half vs second
//      half of the data, per-coin table, and how the stop distance compares with your leverage.
//
// HONEST LIMITS
//   * One position at a time, entries/exits at candle closes, no order-book slippage model.
//   * Coins move together, so pooled trades are NOT independent — the real sample is smaller
//     than n suggests. Treat the t-stat as generous.
//   * Win rate is not the number to judge a breakout system by; expectancy and payoff are.
//   * "Has edge in the past" is not "will have edge". The first-half / second-half split is
//     the cheapest guard against fooling yourself; use it.
//
// This file can also be require()'d as a module (see module.exports at the bottom) — that's how
// test/backtest-donchian.js exercises it without hitting the network.
// ══════════════════════════════════════════════════════════════════════════
'use strict';
const path = require('path');
const fs = require('fs');
const D = require(path.join(__dirname, '..', 'src', 'detectors.js'));
const X = require(path.join(__dirname, 'backtest-xo.js')); // fetchKlines + INTERVAL_MS (reused, not reimplemented)

const INTERVAL_MS = X.INTERVAL_MS;
const SQUEEZE_MIN_INDEX = 144;     // calcBBSqueeze needs BB period (20) + 125 bars of history
const SQUEEZE_LOOKBACK_BARS = 10;  // "recent squeeze" = squeezing on any of the 10 candles before the breakout
const BTC_WARMUP_DAYS = 130;       // extra daily history so the BTC EMA 50 is settled at the window start
const VOL_AVG_BARS = 20;

// ── indicators ──
// Wilder ATR, aligned to the candle index (null until `period` candles of true range exist).
function atrSeries(highs, lows, closes, period) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

// Bollinger BandWidth (%) aligned to the candle index — same formula as calcBBSqueeze in
// src/detectors.js, computed once for the whole series instead of re-sliced on every bar.
function bandwidthSeries(closes, period, mult) {
  period = period || 20; mult = mult || 2;
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let k = i - period + 1; k <= i; k++) s += closes[k];
    const mean = s / period;
    let v = 0;
    for (let k = i - period + 1; k <= i; k++) v += (closes[k] - mean) ** 2;
    const sd = Math.sqrt(v / period);
    out[i] = mean > 0 ? (2 * mult * sd) / mean * 100 : 0;
  }
  return out;
}
// The app's own squeeze rule (BandWidth at its 125-bar low AND strength >= 70), evaluated as of
// candle i using only candles up to i. test/backtest-donchian.js checks this against calcBBSqueeze.
function squeezeAt(bw, i) {
  if (i < SQUEEZE_MIN_INDEX) return false;
  const win = bw.slice(i - 124, i + 1);
  const cur = bw[i];
  const bwMin = Math.min.apply(null, win);
  const avg = win.reduce((a, b) => a + b, 0) / win.length;
  const strength = avg > 0 ? Math.round(Math.max(0, Math.min(100, (1 - cur / avg) * 100))) : 0;
  return cur <= bwMin + 0.001 && strength >= 70;
}

// ── BTC daily trend, as of a moment in time, with no look-ahead ──
// Returns f(t) -> 'bull' | 'bear' | null, using only daily candles that had fully CLOSED by t.
function makeTrendState(closes, times, tfMs, fast, slow) {
  fast = fast || 12; slow = slow || 50;
  const f = D.calcEMA(closes, fast), s = D.calcEMA(closes, slow);
  const warm = slow + 10;
  return function (t) {
    let lo = 0, hi = times.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] + tfMs <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (k < warm) return null;
    return f[k] > s[k] ? 'bull' : f[k] < s[k] ? 'bear' : null;
  };
}

// ── turn Binance klines into the arrays everything else uses ──
function prepareData(raw, tfMs, atrPeriod) {
  const opens = raw.map(r => parseFloat(r[1]));
  const highs = raw.map(r => parseFloat(r[2]));
  const lows = raw.map(r => parseFloat(r[3]));
  const closes = raw.map(r => parseFloat(r[4]));
  const volumes = raw.map(r => parseFloat(r[5]));
  const times = raw.map(r => r[0]);
  return {
    opens, highs, lows, closes, volumes, times, tfMs,
    atr: atrSeries(highs, lows, closes, atrPeriod),
    bw: bandwidthSeries(closes, 20, 2)
  };
}

// ── one trade, from the breakout candle i to its exit ──
function simulateBreakout(d, i, dir, p) {
  const n = d.closes.length;
  const long = dir === 'long';
  const entry = d.closes[i];
  const riskDist = p.atrMult * d.atr[i];
  const stop = long ? entry - riskDist : entry + riskDist;
  const stopFrac = riskDist / entry;
  let exitIdx = n - 1, exitPrice = d.closes[n - 1], reason = 'open';
  for (let j = i + 1; j < n; j++) {
    // 1) the stop, intrabar. A gap through it fills at the open (worse than the stop).
    if (long ? d.lows[j] <= stop : d.highs[j] >= stop) {
      const gapped = long ? d.opens[j] <= stop : d.opens[j] >= stop;
      exitIdx = j; exitPrice = gapped ? d.opens[j] : stop; reason = 'stop';
      break;
    }
    // 2) the trailing channel exit, on the close, against the PRIOR exitN candles.
    if (j - p.exitN >= 0) {
      let lvl = long ? Infinity : -Infinity;
      for (let k = j - p.exitN; k < j; k++) lvl = long ? Math.min(lvl, d.lows[k]) : Math.max(lvl, d.highs[k]);
      if (long ? d.closes[j] < lvl : d.closes[j] > lvl) {
        exitIdx = j; exitPrice = d.closes[j]; reason = 'trail';
        break;
      }
    }
  }
  const bars = exitIdx - i;
  const grossR = (long ? exitPrice - entry : entry - exitPrice) / riskDist;
  const costR = (2 * (p.fee + p.slip) / 100) / stopFrac;
  const hours = bars * d.tfMs / 3600000;
  const fundingR = ((p.funding / 100) * (hours / 8) * (long ? 1 : -1)) / stopFrac;
  return { exitIdx, exitPrice, reason, bars, stopFrac, grossR, costR, fundingR, netR: grossR - costR - fundingR };
}

// ── every trade on one coin ──
function findTrades(d, p, trendState) {
  const n = d.closes.length;
  const start = Math.max(p.entryN, p.atrPeriod) + 1;
  const rows = [];
  let free = 0;
  for (let i = start; i < n - 1; i++) {
    if (i < free || d.atr[i] == null) continue;
    let hh = -Infinity, ll = Infinity;
    for (let k = i - p.entryN; k < i; k++) { hh = Math.max(hh, d.highs[k]); ll = Math.min(ll, d.lows[k]); }
    const dir = d.closes[i] > hh ? 'long' : d.closes[i] < ll ? 'short' : null;
    if (!dir) continue;

    const sim = simulateBreakout(d, i, dir, p);

    // tags, all evaluated with information available at the breakout candle's close
    let volOK = null;
    if (i >= VOL_AVG_BARS) {
      let vs = 0;
      for (let k = i - VOL_AVG_BARS; k < i; k++) vs += d.volumes[k];
      const avgV = vs / VOL_AVG_BARS;
      volOK = avgV > 0 ? d.volumes[i] >= p.volMult * avgV : null;
    }
    let squeezeRecent = false;
    for (let k = Math.max(0, i - SQUEEZE_LOOKBACK_BARS); k < i; k++) {
      if (squeezeAt(d.bw, k)) { squeezeRecent = true; break; }
    }
    const entryTime = d.times[i] + d.tfMs; // candle CLOSE time — the moment you'd actually know
    let btcAligned = null;
    if (trendState) {
      const st = trendState(entryTime);
      if (st) btcAligned = (dir === 'long') === (st === 'bull');
    }

    rows.push({
      symbol: p.symbol || '', dir, entryIdx: i, exitIdx: sim.exitIdx, ts: entryTime,
      time: new Date(entryTime).toISOString(), entry: d.closes[i], exitPrice: sim.exitPrice,
      reason: sim.reason, bars: sim.bars, stopFrac: sim.stopFrac,
      grossR: sim.grossR, costR: sim.costR, fundingR: sim.fundingR, netR: sim.netR,
      volOK, squeezeRecent, btcAligned
    });
    free = sim.exitIdx + 1;
  }
  return rows;
}

// ── aggregate math ──
function stats(rows) {
  const n = rows.length;
  if (!n) return null;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const nets = rows.map(r => r.netR);
  const wins = nets.filter(x => x > 0), losses = nets.filter(x => x <= 0);
  const exp = mean(nets);
  const sd = n > 1 ? Math.sqrt(nets.reduce((s, x) => s + (x - exp) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? exp / (sd / Math.sqrt(n)) : 0;
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;
  const sumWin = wins.reduce((a, b) => a + b, 0), sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let streak = 0, maxStreak = 0;
  rows.slice().sort((a, b) => a.ts - b.ts).forEach(r => {
    if (r.netR <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0;
  });
  return {
    n, wins: wins.length, losses: losses.length,
    winRate: wins.length / n * 100,
    avgWin, avgLoss,
    payoff: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
    expNet: exp, expGross: mean(rows.map(r => r.grossR)),
    avgCost: mean(rows.map(r => r.costR + r.fundingR)),
    t, profitFactor: sumLoss > 0 ? sumWin / sumLoss : null,
    maxLosingStreak: maxStreak, avgBars: mean(rows.map(r => r.bars)),
    worst: Math.min.apply(null, nets), open: rows.filter(r => r.reason === 'open').length
  };
}
const fmtR = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';
const pad = (s, w) => String(s).padEnd(w);
function line(label, rows, log) {
  const s = stats(rows);
  if (!s) { log(`  ${pad(label, 30)} no trades`); return; }
  log(`  ${pad(label, 30)} n=${String(s.n).padStart(4)}  win%=${s.winRate.toFixed(1).padStart(5)}  ` +
    `payoff=${s.payoff == null ? ' n/a' : s.payoff.toFixed(2).padStart(4)}  net=${fmtR(s.expNet).padStart(7)}  ` +
    `gross=${fmtR(s.expGross).padStart(7)}  t=${s.t.toFixed(1).padStart(4)}  ` +
    `PF=${s.profitFactor == null ? 'inf' : s.profitFactor.toFixed(2)}  worstStreak=${s.maxLosingStreak}` +
    (s.n < 30 ? '  (n<30: too few to trust)' : ''));
}
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const parseList = (v, dflt) => {
  if (v == null || v === '') return dflt;
  const a = String(v).split(',').map(x => parseInt(x, 10)).filter(x => x > 0);
  return a.length ? a : dflt;
};

// ── the whole run, as one testable function (network / fs / process.exit live only here and
//    in the CLI block — everything above is pure and unit-tested directly) ──
async function runDonchian(opts) {
  opts = opts || {};
  const symbols = (opts.symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const interval = opts.interval || '4h';
  const days = opts.days || 730;
  const market = opts.market || 'futures';
  const entryList = opts.entryList && opts.entryList.length ? opts.entryList : [20];
  const exitList = opts.exitList && opts.exitList.length ? opts.exitList : [10];
  const base = {
    atrPeriod: opts.atrPeriod || 14,
    atrMult: opts.atrMult || 2,
    fee: opts.fee != null ? opts.fee : 0.05,
    slip: opts.slip != null ? opts.slip : 0.02,
    funding: opts.funding != null ? opts.funding : 0.01,
    volMult: opts.volMult || 1.5
  };
  const lev = opts.lev || 14;
  const useBtc = opts.btc !== false;
  const outCsv = opts.outCsv || null;
  const log = opts.log || console.log;
  const err = opts.err || console.error;
  const fetch = opts.fetch || X.fetchKlines;

  if (!symbols.length) return { error: 'at least one symbol is required' };
  const tfMs = INTERVAL_MS[interval];
  if (!tfMs) return { error: `Unrecognised interval "${interval}"` };

  log(`Donchian breakout edge lab — ${symbols.length} coin(s), ${interval} (${market}), last ${days} days`);
  const end = Date.now();
  const start = end - days * 86400000;
  const progress = (label) => (n) => { if (process.stdout && process.stdout.write) process.stdout.write(`\r  fetching ${label}\u2026 ${n} candles`); };

  // candles per coin — one failing coin never sinks the run
  const data = {};
  const maxPeriod = Math.max(base.atrPeriod, Math.max.apply(null, entryList), Math.max.apply(null, exitList));
  for (const sym of symbols) {
    try {
      const raw = await fetch(sym, interval, start, end, market, { err, onProgress: progress(`${sym} ${interval}`) });
      if (process.stdout && process.stdout.write) process.stdout.write('\n');
      if (!raw || raw.length < maxPeriod + 30) { err(`  ${sym}: only ${raw ? raw.length : 0} candles — skipped`); continue; }
      data[sym] = prepareData(raw, tfMs, base.atrPeriod);
    } catch (e) {
      if (process.stdout && process.stdout.write) process.stdout.write('\n');
      err(`  ${sym}: ${e.message} — skipped`);
    }
  }
  const okSymbols = Object.keys(data);
  if (!okSymbols.length) return { error: 'no usable candle data for any symbol' };

  // BTC daily trend, for the "is the whole market with you?" split
  let trendState = null;
  if (useBtc) {
    try {
      const dayMs = INTERVAL_MS['1d'];
      const rawBtc = await fetch('BTCUSDT', '1d', start - BTC_WARMUP_DAYS * 86400000, end, market, { err, onProgress: progress('BTCUSDT 1d') });
      if (process.stdout && process.stdout.write) process.stdout.write('\n');
      if (rawBtc && rawBtc.length > 70) {
        trendState = makeTrendState(rawBtc.map(r => parseFloat(r[4])), rawBtc.map(r => r[0]), dayMs, 12, 50);
      } else err('  BTC daily history too short — the BTC-trend split will be skipped');
    } catch (e) {
      if (process.stdout && process.stdout.write) process.stdout.write('\n');
      err(`  BTC daily fetch failed (${e.message}) — the BTC-trend split will be skipped`);
    }
  }

  const first = data[okSymbols[0]];
  log(`Loaded ${okSymbols.length} coin(s): ${okSymbols.join(', ')}`);
  log(`Window ${new Date(start).toISOString().slice(0, 10)} to ${new Date(end).toISOString().slice(0, 10)}  (~${first.closes.length} ${interval} candles each)\n`);
  log(`Rule: close beyond the prior-N-candle channel, 1R = ${base.atrMult} x ATR(${base.atrPeriod}), trailing exit on the prior-M-candle channel.`);
  log(`Costs: ${base.fee}% fee + ${base.slip}% slippage per side, funding ${base.funding}% per 8h — all charged in R. Slippage and funding are assumptions.\n`);

  // parameter sweep, pooled across coins
  const combos = [];
  entryList.forEach(en => exitList.forEach(ex => combos.push({ entryN: en, exitN: ex })));
  const results = combos.map(c => {
    const rows = [];
    okSymbols.forEach(sym => rows.push.apply(rows, findTrades(data[sym], Object.assign({}, base, c, { symbol: sym }), trendState)));
    return { combo: c, rows };
  });
  log('PARAMETER SWEEP (pooled across coins; net of costs)');
  results.forEach(r => line(`entry ${r.combo.entryN} / exit ${r.combo.exitN}`, r.rows, log));
  if (combos.length > 1) log('  -> prefer a setting whose neighbours also look fine. The single best cell is usually luck.');

  // detailed report for the first combination
  const prim = results[0];
  const rows = prim.rows;
  const pc = prim.combo;
  log(`\nDETAIL — entry ${pc.entryN} / exit ${pc.exitN}`);
  if (!rows.length) {
    log('  no breakouts in this window.');
    return { trades: [], results };
  }
  line('All trades', rows, log);
  line('Long', rows.filter(r => r.dir === 'long'), log);
  line('Short', rows.filter(r => r.dir === 'short'), log);

  const s = stats(rows);
  log(`\nCOST DRAG — gross ${fmtR(s.expGross)} per trade becomes net ${fmtR(s.expNet)} after fees, slippage and funding (${fmtR(-s.avgCost)} per trade).`);
  log(`Exits: ${rows.filter(r => r.reason === 'stop').length} stopped, ${rows.filter(r => r.reason === 'trail').length} trailed out, ${s.open} still open at the end of the data.`);

  if (trendState) {
    log('\nBTC DAILY TREND (EMA 12/50) — is the whole market on your side?');
    line('Aligned with BTC trend', rows.filter(r => r.btcAligned === true), log);
    line('Against BTC trend', rows.filter(r => r.btcAligned === false), log);
  }
  log(`\nVOLUME — breakout candle volume >= ${base.volMult}x its prior-${VOL_AVG_BARS} average`);
  line('Volume confirmed', rows.filter(r => r.volOK === true), log);
  line('Not confirmed', rows.filter(r => r.volOK === false), log);
  log(`\nSQUEEZE — the app's BB squeeze rule active on any of the ${SQUEEZE_LOOKBACK_BARS} candles before the breakout`);
  line('Out of a squeeze', rows.filter(r => r.squeezeRecent), log);
  line('No recent squeeze', rows.filter(r => !r.squeezeRecent), log);

  const mid = start + (end - start) / 2;
  log('\nROBUSTNESS — does the first half of the data agree with the second?');
  line('First half', rows.filter(r => r.ts < mid), log);
  line('Second half', rows.filter(r => r.ts >= mid), log);

  log('\nPER COIN');
  okSymbols.forEach(sym => line(sym, rows.filter(r => r.symbol === sym), log));

  const stopPcts = rows.map(r => r.stopFrac * 100);
  const medStop = median(stopPcts);
  const liqPct = 100 / lev;
  const tooWide = stopPcts.filter(x => x > liqPct / 2).length / stopPcts.length * 100;
  log(`\nSTOP DISTANCE vs ${lev}x LEVERAGE`);
  log(`  median stop ${medStop.toFixed(2)}% of price; ${lev}x liquidates at roughly ${liqPct.toFixed(1)}% (before maintenance margin).`);
  log(`  ${tooWide.toFixed(0)}% of trades had a stop wider than half that distance.`);
  log(`  For the median trade, leverage up to about ${Math.max(1, Math.floor(50 / medStop))}x keeps liquidation at least twice as far as the stop.`);
  log('  Size by stop distance: notional = dollars at risk / stop %, and let leverage fall out of that.');

  if (outCsv) {
    const header = 'symbol,time,dir,entry,exit_price,stop_pct,exit_reason,bars,gross_r,cost_r,funding_r,net_r,vol_ok,squeeze_recent,btc_aligned\n';
    const out = results[0].rows.map(r => [r.symbol, r.time, r.dir, r.entry, r.exitPrice, (r.stopFrac * 100).toFixed(3), r.reason, r.bars,
      r.grossR.toFixed(3), r.costR.toFixed(3), r.fundingR.toFixed(3), r.netR.toFixed(3), r.volOK, r.squeezeRecent, r.btcAligned].join(','));
    fs.writeFileSync(outCsv, header + out.join('\n') + '\n');
    log(`\nWrote every simulated trade (first parameter set) to ${outCsv}`);
  }
  log('\nMechanical research simulation — see the comment header for what it does and does not account for.');
  return { trades: rows, results, stats: s };
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
    const symbols = String(args.symbols || args.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) {
      console.error('Usage: node scripts/backtest-donchian.js --symbols BTCUSDT,ETHUSDT,SOLUSDT [--interval 4h] [--days 730] [--entry 20] [--exit 10] ...');
      console.error('See the comment header in this file for the full flag list.');
      process.exit(1);
    }
    const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
    runDonchian({
      symbols,
      interval: args.interval || '4h',
      days: Math.max(30, parseInt(args.days, 10) || 730),
      market: args.market === 'spot' ? 'spot' : 'futures',
      entryList: parseList(args.entry, [20]),
      exitList: parseList(args.exit, [10]),
      atrPeriod: Math.max(2, parseInt(args.atr, 10) || 14),
      atrMult: num(args.atrMult, 2),
      fee: num(args.fee, 0.05),
      slip: num(args.slip, 0.02),
      funding: num(args.funding, 0.01),
      volMult: num(args.volMult, 1.5),
      lev: num(args.lev, 14),
      btc: args.btc !== 'off',
      outCsv: args.out || null
    }).then((result) => { if (result && result.error) { console.error(result.error); process.exit(1); } });
  })();
} else {
  module.exports = { atrSeries, bandwidthSeries, squeezeAt, makeTrendState, prepareData, simulateBreakout, findTrades, stats, runDonchian, parseList, INTERVAL_MS };
}
