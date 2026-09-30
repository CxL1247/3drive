// Tests for scripts/backtest-donchian.js — the Donchian breakout edge-lab CLI.
// Run with:  node test/backtest-donchian.js       (no dependencies, no network)
//
// Everything here is offline. The pure functions (atrSeries, squeezeAt, makeTrendState,
// simulateBreakout, findTrades, stats) are checked directly, and runDonchian is exercised with a
// fake `fetch` returning synthetic klines. What this suite CANNOT verify: that Binance's real
// API still looks like this, or that the rule has any edge — synthetic data only proves the
// MECHANICS are right (no look-ahead, correct fills, correct cost math). The edge question is
// answered only when a human runs the script against real candles.

const path = require('path');
const fs = require('fs');
const os = require('os');
const B = require(path.join(__dirname, '..', 'scripts', 'backtest-donchian.js'));
const D = require(path.join(__dirname, '..', 'src', 'detectors.js'));

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name);
  if (!cond) fails++;
};
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);
const HOUR = 3600000, H4 = 4 * HOUR, DAY = 86400000;

// Binance kline row: [openTime, open, high, low, close, volume, ...]
function kl(t, o, h, l, c, v) { return [t, String(o), String(h), String(l), String(c), String(v == null ? 1000 : v), t + H4 - 1, '0', 1, '0', '0', '0']; }

// Hand-built data object with a constant ATR, so riskDist is exactly atrMult * atr and the maths is checkable.
function mk(opens, highs, lows, closes, atr, tfMs) {
  const n = closes.length;
  return { opens, highs, lows, closes, volumes: Array(n).fill(1000), times: closes.map((_, i) => i * (tfMs || H4)),
    tfMs: tfMs || H4, atr: Array(n).fill(atr), bw: Array(n).fill(5) };
}
const P = { entryN: 20, exitN: 3, atrPeriod: 14, atrMult: 2, fee: 0, slip: 0, funding: 0, volMult: 1.5, symbol: 'TEST' };

// deterministic pseudo-random, so the synthetic market is the same on every run
function lcg(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

// ── ATR ──
function atrTests() {
  console.log('\natrSeries');
  const a = B.atrSeries([10, 12, 11, 13], [9, 10, 9, 11], [9.5, 11, 10, 12], 2);
  check('null until `period` true ranges exist', a[0] == null && a[1] == null && a[2] != null);
  check('first ATR is the plain mean of the first `period` true ranges', near(a[2], 2.25));
  check('later ATR uses Wilder smoothing', near(a[3], 2.625));
  check('too little data returns all nulls, not a throw', B.atrSeries([1, 2], [0, 1], [1, 2], 14).every(v => v == null));
}

// ── squeeze parity with the app's own detector ──
function squeezeTests() {
  console.log('\nsqueezeAt vs calcBBSqueeze (the app\'s own rule)');
  const rnd = lcg(42);
  const closes = [100];
  for (let i = 1; i < 420; i++) {
    const vol = (i > 200 && i < 330) ? 0.0015 : 0.012;        // a quiet stretch creates squeezes
    closes.push(closes[i - 1] * (1 + (rnd() - 0.5) * 2 * vol));
  }
  const bw = B.bandwidthSeries(closes, 20, 2);
  let mismatches = 0, trues = 0, falses = 0;
  for (let i = 144; i < closes.length; i++) {
    const mine = B.squeezeAt(bw, i);
    const theirs = D.calcBBSqueeze(closes.slice(0, i + 1)).squeezing;
    if (mine !== theirs) mismatches++;
    if (theirs) trues++; else falses++;
  }
  check('agrees with calcBBSqueeze on every candle from 144 onward', mismatches === 0);
  check('the parity test actually saw both squeezing and non-squeezing candles', trues > 0 && falses > 0);
  check('returns false before enough history, like the app does', B.squeezeAt(bw, 100) === false);
}

// ── BTC trend state: must not peek at a daily candle that has not closed yet ──
function trendTests() {
  console.log('\nmakeTrendState (BTC daily trend, no look-ahead)');
  const closes = [];
  for (let i = 0; i < 100; i++) closes.push(200 - i);               // long downtrend
  for (let i = 0; i < 100; i++) closes.push(closes[closes.length - 1] + i * 0.9); // then a rally
  const times = closes.map((_, i) => i * DAY);
  const f = D.calcEMA(closes, 12), s = D.calcEMA(closes, 50);
  let flip = -1;
  for (let k = 70; k < closes.length; k++) if (f[k] > s[k] && f[k - 1] <= s[k - 1]) { flip = k; break; }
  check('the synthetic series really flips from bear to bull', flip > 0);
  const st = B.makeTrendState(closes, times, DAY, 12, 50);
  check('one millisecond before the flip candle closes, it still reads bear', st(times[flip] + DAY - 1) === 'bear');
  check('the moment the flip candle closes, it reads bull', st(times[flip] + DAY) === 'bull');
  check('before the EMAs have warmed up it reports unknown, not a guess', st(times[10] + DAY) === null);
}

// ── findTrades: entry rule, look-ahead, one position at a time ──
function entryTests() {
  console.log('\nfindTrades — entry rule');
  const n = 40;
  const base = () => ({ o: Array(n).fill(100), h: Array(n).fill(101), l: Array(n).fill(99), c: Array(n).fill(100) });

  // a close ABOVE the prior 20-bar high triggers a long
  let x = base();
  x.c[25] = 105; x.h[25] = 106; x.o[25] = 100;
  let rows = B.findTrades(mk(x.o, x.h, x.l, x.c, 2), P, null);
  check('a close above the prior channel high opens a long at that close', rows.length >= 1 && rows[0].dir === 'long' && rows[0].entryIdx === 25 && rows[0].entry === 105);

  // equal to the prior high is NOT a breakout (strictly greater)
  x = base(); x.c[25] = 101; x.h[25] = 101;
  rows = B.findTrades(mk(x.o, x.h, x.l, x.c, 2), P, null);
  check('closing exactly AT the prior high is not a breakout', rows.length === 0);

  // a huge HIGH that closes back inside the channel is not a breakout either — and proves the
  // current candle is excluded from its own channel (otherwise its own high would raise the bar)
  x = base(); x.h[25] = 130; x.c[25] = 100;
  rows = B.findTrades(mk(x.o, x.h, x.l, x.c, 2), P, null);
  check('a spike high that closes back inside does not trigger', rows.length === 0);

  // a close below the prior low triggers a short
  x = base(); x.c[25] = 95; x.l[25] = 94;
  rows = B.findTrades(mk(x.o, x.h, x.l, x.c, 2), P, null);
  check('a close below the prior channel low opens a short', rows.length >= 1 && rows[0].dir === 'short' && rows[0].entryIdx === 25);

  // the channel is the PRIOR 20 bars: a spike 25 bars ago has aged out and no longer blocks entry
  x = base(); x.h[3] = 120;
  x.c[28] = 105; x.h[28] = 106;
  rows = B.findTrades(mk(x.o, x.h, x.l, x.c, 2), P, null);
  check('a high older than the channel length no longer blocks a breakout', rows.some(r => r.entryIdx === 28));

  console.log('\nfindTrades — one position at a time');
  const rnd = lcg(7);
  const m = 600, o = [], h = [], l = [], c = [];
  let px = 100;
  for (let i = 0; i < m; i++) {
    const op = px; px = px * (1 + (rnd() - 0.48) * 0.04);
    o.push(op); c.push(px); h.push(Math.max(op, px) * 1.004); l.push(Math.min(op, px) * 0.996);
  }
  const big = B.findTrades(mk(o, h, l, c, 1.5), P, null);
  check('the synthetic market produced a meaningful number of trades', big.length >= 10);
  check('no trade starts before the previous one has ended', big.every((r, i) => i === 0 || r.entryIdx > big[i - 1].exitIdx));
  check('every trade exits at or after it enters', big.every(r => r.exitIdx > r.entryIdx));
}

// ── simulateBreakout: stop, gap, trailing exit, costs ──
function simulateTests() {
  console.log('\nsimulateBreakout');
  const n = 30;
  // every candle sits around the entry price, so the prior-channel lows are consistent with an entry at 100
  const flat = () => ({ o: Array(n).fill(100), h: Array(n).fill(101), l: Array(n).fill(99), c: Array(n).fill(100) });
  // entry candle i=5 at close 100, atr 2, mult 2 -> 1R = 4, stop = 96
  const enter = (x) => { x.c[5] = 100; };

  // long stop hit intrabar (no gap) -> fills AT the stop, about -1R
  let x = flat(); enter(x); x.o[6] = 100; x.l[6] = 95; x.h[6] = 101; x.c[6] = 97;
  let r = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 2), 5, 'long', P);
  check('long stop hit intrabar exits at the stop price for -1R', r.reason === 'stop' && r.exitPrice === 96 && near(r.grossR, -1) && r.bars === 1);

  // gap THROUGH the stop -> fills at the (worse) open
  x = flat(); enter(x); x.o[6] = 92; x.l[6] = 91; x.h[6] = 93; x.c[6] = 92;
  r = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 2), 5, 'long', P);
  check('a gap through the stop fills at the open, worse than -1R', r.reason === 'stop' && r.exitPrice === 92 && r.grossR < -1 && near(r.grossR, -2));

  // short mirror
  x = flat(); enter(x); x.o[6] = 100; x.h[6] = 105; x.l[6] = 99; x.c[6] = 103;
  r = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 2), 5, 'short', P);
  check('short stop (above entry) fills at the stop for -1R', r.reason === 'stop' && r.exitPrice === 104 && near(r.grossR, -1));

  // trailing exit on the close: a rising run, then a close below the lowest low of the prior 3 candles
  x = flat(); enter(x);
  const path1 = [[101, 103, 100.5, 102], [102, 106, 101.5, 105], [105, 110, 104.5, 109], [109, 111, 108.5, 110]];
  path1.forEach((b, k) => { const j = 6 + k; x.o[j] = b[0]; x.h[j] = b[1]; x.l[j] = b[2]; x.c[j] = b[3]; });
  // bar 10 closes at 101.0, below the lowest low of bars 7..9 (101.5), while its own low stays above the 96 stop
  x.o[10] = 110; x.h[10] = 110.5; x.l[10] = 100.95; x.c[10] = 101.0; // low 100.95 > stop 96 so no stop
  r = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 2), 5, 'long', P);
  check('the trailing exit fires on a close below the prior-3-candle low', r.reason === 'trail' && r.exitIdx === 10 && r.exitPrice === 101.0);
  check('a winning trail exit books positive R', near(r.grossR, (101 - 100) / 4));

  // still open at the end of the data -> marked to the last close
  x = flat(); enter(x);
  for (let j = 6; j < n; j++) { x.o[j] = 100 + (j - 5); x.c[j] = 101 + (j - 5); x.h[j] = 101.5 + (j - 5); x.l[j] = 100 + (j - 5); }
  r = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 2), 5, 'long', P);
  check('an unfinished trade is marked to the last close and flagged open', r.reason === 'open' && r.exitIdx === n - 1 && r.exitPrice === x.c[n - 1]);

  console.log('\nsimulateBreakout — costs are charged in R');
  const p2 = Object.assign({}, P, { fee: 0.05, slip: 0.02, funding: 0.01 });
  x = flat(); enter(x); x.o[6] = 100; x.l[6] = 95; x.h[6] = 101; x.c[6] = 97;
  r = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 2), 5, 'long', p2);
  // stop distance = 4 / 100 = 4% -> round trip (0.05+0.02)*2 = 0.14% -> 0.14 / 4 = 0.035R
  check('round-trip fee + slippage divided by the stop distance', near(r.costR, 0.035, 1e-9));
  // 1 bar of 4h = 4 hours -> funding 0.01% * (4/8) = 0.005% -> /4% = 0.00125R, paid by a long
  check('funding for a long is a cost, scaled by hold time and stop distance', near(r.fundingR, 0.00125, 1e-9));
  check('net R = gross - cost - funding', near(r.netR, r.grossR - r.costR - r.fundingR, 1e-12));

  const xs = flat(); enter(xs); xs.o[6] = 100; xs.h[6] = 105; xs.l[6] = 99; xs.c[6] = 103;
  const rs = B.simulateBreakout(mk(xs.o, xs.h, xs.l, xs.c, 2), 5, 'short', p2);
  check('funding for a short is a credit (negative cost)', rs.fundingR < 0);

  // a tighter stop makes the same fee far more expensive in R — the reason fees kill small-stop systems
  const tight = B.simulateBreakout(mk(x.o, x.h, x.l, x.c, 0.5), 5, 'long', p2);
  check('a tighter stop multiplies the fee cost in R', tight.costR > r.costR * 3);
}

// ── stats ──
function statsTests() {
  console.log('\nstats');
  const mkRow = (netR, ts, extra) => Object.assign({ netR, grossR: netR, costR: 0, fundingR: 0, bars: 4, ts, reason: 'trail' }, extra);
  const rows = [2, 2, -1, -1, -1, 0.5].map((v, i) => mkRow(v, i));
  const s = B.stats(rows);
  check('n, wins and losses', s.n === 6 && s.wins === 3 && s.losses === 3);
  check('win rate', near(s.winRate, 50));
  check('payoff = average win / average loss', near(s.payoff, 1.5));
  check('net expectancy is the mean R per trade', near(s.expNet, 0.25));
  check('profit factor = gross wins / gross losses', near(s.profitFactor, 1.5));
  check('worst losing streak counts consecutive losers in time order', s.maxLosingStreak === 3);
  check('worst single trade is reported', near(s.worst, -1));
  // streak must follow chronological order even if rows arrive shuffled (pooled across coins)
  const shuffled = [mkRow(-1, 3), mkRow(2, 0), mkRow(-1, 4), mkRow(-1, 2), mkRow(2, 1), mkRow(0.5, 5)];
  check('the streak is computed chronologically, not in array order', B.stats(shuffled).maxLosingStreak === 3);
  check('an empty set returns null, not a throw', B.stats([]) === null);
  check('a run with no losers has no profit factor rather than dividing by zero', B.stats([mkRow(1, 0), mkRow(2, 1)]).profitFactor === null);
  check('parseList reads comma lists and falls back on junk', B.parseList('10,20,55', [1]).join() === '10,20,55' && B.parseList('x', [7]).join() === '7' && B.parseList(undefined, [9]).join() === '9');
}

// ── the whole pipeline, offline ──
async function runTests() {
  console.log('\nrunDonchian (offline, fake fetch)');
  const T0 = Date.now() - 400 * DAY;
  function series(seed, drift) {
    const rnd = lcg(seed), rows = [];
    let px = 100;
    const count = Math.ceil(400 * 6);                   // 400 days of 4h candles
    for (let i = 0; i < count; i++) {
      const op = px; px = px * (1 + drift + (rnd() - 0.5) * 0.03);
      rows.push(kl(T0 + i * H4, op, Math.max(op, px) * 1.003, Math.min(op, px) * 0.997, px, 500 + rnd() * 1500));
    }
    return rows;
  }
  function daily(seed) {
    const rnd = lcg(seed), rows = [];
    let px = 100;
    for (let i = 0; i < 400; i++) { const op = px; px = px * (1 + (rnd() - 0.48) * 0.04); rows.push(kl(T0 - 130 * DAY + i * DAY, op, Math.max(op, px) * 1.01, Math.min(op, px) * 0.99, px, 9000)); }
    return rows;
  }
  const calls = [];
  const fakeFetch = async (symbol, interval) => {
    calls.push(symbol + ':' + interval);
    if (symbol === 'BROKENUSDT') throw new Error('Could not fetch any candles');
    if (symbol === 'THINUSDT') return series(3, 0).slice(0, 20);
    if (interval === '1d') return daily(99);
    return series(symbol.length * 11, symbol === 'AAAUSDT' ? 0.0004 : 0);
  };

  const logs = [], errs = [];
  const res = await B.runDonchian({
    symbols: ['AAAUSDT', 'BBBUSDT', 'BROKENUSDT', 'THINUSDT'], interval: '4h', days: 330,
    entryList: [10, 20], exitList: [5, 10], log: (s) => logs.push(s), err: (s) => errs.push(s), fetch: fakeFetch
  });
  const out = logs.join('\n');
  check('no network was touched — only the fake fetch ran', calls.length > 0);
  check('a coin that fails to fetch is skipped without sinking the run', !res.error && errs.some(e => e.includes('BROKENUSDT')));
  check('a coin with too little history is skipped and named', errs.some(e => e.includes('THINUSDT')));
  check('BTC daily history was requested for the trend split', calls.includes('BTCUSDT:1d'));
  check('produced trades across the good coins', res.trades.length > 0 && new Set(res.trades.map(t => t.symbol)).size === 2);
  check('sweep printed one line per parameter combination (2 x 2)', (out.match(/entry \d+ \/ exit \d+/g) || []).length >= 4);
  ['PARAMETER SWEEP', 'COST DRAG', 'BTC DAILY TREND', 'VOLUME', 'SQUEEZE', 'ROBUSTNESS', 'First half', 'Second half', 'PER COIN', 'STOP DISTANCE vs 14x LEVERAGE']
    .forEach(h => check(`report includes "${h}"`, out.includes(h)));
  check('every trade carries a finite net R and costs that are never negative for fees', res.trades.every(t => Number.isFinite(t.netR) && t.costR > 0));
  check('gross minus costs equals net for every trade', res.trades.every(t => near(t.netR, t.grossR - t.costR - t.fundingR, 1e-9)));

  // BTC split can be switched off
  const noBtcLogs = [];
  const noBtc = await B.runDonchian({ symbols: ['AAAUSDT'], interval: '4h', days: 330, btc: false, log: (s) => noBtcLogs.push(s), err: () => {}, fetch: fakeFetch });
  check('--btc off skips the BTC section and the daily fetch', !noBtcLogs.join('\n').includes('BTC DAILY TREND') && !noBtc.error);

  // CSV export
  const csvPath = path.join(os.tmpdir(), 'backtest-donchian-test-' + Date.now() + '.csv');
  const withCsv = await B.runDonchian({ symbols: ['AAAUSDT'], interval: '4h', days: 330, outCsv: csvPath, log: () => {}, err: () => {}, fetch: fakeFetch });
  check('CSV file was written', fs.existsSync(csvPath));
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    check('CSV header matches the documented columns', lines[0] === 'symbol,time,dir,entry,exit_price,stop_pct,exit_reason,bars,gross_r,cost_r,funding_r,net_r,vol_ok,squeeze_recent,btc_aligned');
    check('CSV has one row per simulated trade', lines.length - 1 === withCsv.results[0].rows.length);
    fs.unlinkSync(csvPath);
  }

  // graceful failure paths — always resolve with {error}, never throw or exit
  check('no symbols resolves with an error', !!(await B.runDonchian({ symbols: [], fetch: fakeFetch, log: () => {}, err: () => {} })).error);
  check('bad interval resolves with an error', !!(await B.runDonchian({ symbols: ['X'], interval: '7h', fetch: fakeFetch, log: () => {}, err: () => {} })).error);
  const allBad = await B.runDonchian({ symbols: ['BROKENUSDT'], fetch: fakeFetch, log: () => {}, err: () => {} });
  check('every coin failing resolves with an error, not an unhandled rejection', !!allBad.error);

  // BTC fetch failing degrades gracefully: the run still completes without the split
  const btcDown = async (symbol, interval) => { if (symbol === 'BTCUSDT') throw new Error('network down'); return fakeFetch(symbol, interval); };
  const btcErrs = [];
  const degraded = await B.runDonchian({ symbols: ['AAAUSDT'], interval: '4h', days: 330, log: () => {}, err: (s) => btcErrs.push(s), fetch: btcDown });
  check('a BTC fetch failure skips the split but still returns trades', !degraded.error && btcErrs.some(e => e.includes('BTC')));

  // nothing but a flat market -> no breakouts, clean result
  const flatFetch = async () => Array.from({ length: 300 }, (_, i) => kl(T0 + i * H4, 100, 100, 100, 100, 1000));
  const flat = await B.runDonchian({ symbols: ['FLATUSDT'], interval: '4h', days: 330, btc: false, log: () => {}, err: () => {}, fetch: flatFetch });
  check('a flat market with no breakouts resolves cleanly', !flat.error && flat.trades.length === 0);
}

// ── the lab must be able to SEE an edge when one exists and REJECT noise when it does not ──
function detectionTests() {
  console.log('\nthe lab detects momentum and rejects noise (synthetic markets, fixed seeds)');
  function market(seed, phi) {
    const rnd = lcg(seed); let px = 100, prev = 0; const rows = [];
    for (let i = 0; i < 8000; i++) {
      const op = px, ret = phi * prev + (rnd() - 0.5) * 0.03; prev = ret; px *= 1 + ret;
      rows.push(kl(i * H4, op, Math.max(op, px) * 1.003, Math.min(op, px) * 0.997, px, 1000));
    }
    return rows;
  }
  const pooled = (phi) => {
    let all = [];
    for (let s = 1; s <= 6; s++) all = all.concat(B.findTrades(B.prepareData(market(s * 13, phi), H4, 14),
      Object.assign({}, P, { exitN: 10, fee: 0.05, slip: 0.02, funding: 0.01 }), null));
    return B.stats(all);
  };
  const noise = pooled(0), mild = pooled(0.15), strong = pooled(0.3);
  check('a pure random walk shows NO edge after costs', noise.expNet < 0);
  check('a strongly trending market shows a clear edge after costs', strong.expNet > 0.15 && strong.t > 3);
  check('more momentum means a better result, in order', noise.expNet < mild.expNet && mild.expNet < strong.expNet);
  check('costs are a real drag: net is below gross everywhere', noise.expNet < noise.expGross && strong.expNet < strong.expGross);
}

atrTests();
squeezeTests();
trendTests();
entryTests();
simulateTests();
statsTests();
detectionTests();
runTests().then(() => {
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll backtest-donchian checks passed.');
  process.exit(fails ? 1 : 0);
});
