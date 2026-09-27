// Tests for scripts/backtest-xo.js — the Trader XO edge-lab CLI.
// Run with:  node test/backtest-xo.js       (no dependencies, no network)
//
// Everything here is offline: fetchKlines is never called against Binance —
// runBacktest is exercised with a fake `fetch` that returns synthetic klines,
// and the pure functions (findAllArrows, simulateTrade, forwardReturn,
// isChoppyAt) are checked directly. The one thing this suite cannot verify is
// that Binance's real API still looks like this — that only shows up when the
// script is actually run against the network by a human.

const path = require('path');
const fs = require('fs');
const os = require('os');
const B = require(path.join(__dirname, '..', 'scripts', 'backtest-xo.js'));
const D = require(path.join(__dirname, '..', 'src', 'detectors.js'));

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name);
  if (!cond) fails++;
};
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);

// Builds a kline row in Binance's exact array shape (only the fields the script reads matter).
function kline(openTime, close, high, low) {
  high = high == null ? close : high;
  low = low == null ? close : low;
  return [openTime, close, high, low, close, '1000', openTime + 3599999, '0', 1, '0', '0', '0'];
}

// ── findAllArrows: must find every flip, not just the latest one, and must agree exactly with
//    detectTraderXO's own idea of where the trend is at the end of the series ──
function findAllArrowsTests() {
  console.log('\nfindAllArrows');
  const HOUR = 3600000;
  const T0 = Date.UTC(2026, 0, 1);
  // three regimes: down, up, down again — should produce exactly two arrows
  const closes = [];
  for (let i = 0; i < 150; i++) closes.push(100 - i * 0.5);
  for (let i = 0; i < 150; i++) closes.push(closes[closes.length - 1] + i * 1.2);
  for (let i = 0; i < 150; i++) closes.push(closes[closes.length - 1] - i * 1.2);
  const times = closes.map((_, i) => T0 + i * HOUR);

  const arrows = B.findAllArrows(closes, times, 12, 50);
  check('finds at least two flips across three regimes', arrows.length >= 2);
  const alt = arrows.every((a, i, arr) => i === 0 || a.dir !== arr[i - 1].dir);
  check('arrows alternate direction (a flip is never repeated)', alt);
  check('arrow indices are strictly increasing', arrows.every((a, i) => i === 0 || a.idx > arrows[i - 1].idx));
  check('arrow price matches the close at its index', arrows.every(a => near(a.price, closes[a.idx])));

  // parity with the live detector: the LAST arrow findAllArrows reports for the whole series
  // must be the same one detectTraderXO reports as "current" when run on the same data
  const now = times[times.length - 1] + HOUR;
  const live = D.detectTraderXO(closes, times, 'ONE_HOUR', now, { fast: 12, slow: 50 });
  check('live detector found a state to compare against', !!live);
  if (live && live.lastArrow) {
    const lastFromBacktest = arrows[arrows.length - 1];
    check('last arrow direction matches the live detector', lastFromBacktest.dir === live.lastArrow.dir);
    check('last arrow time matches the live detector', lastFromBacktest.time === live.lastArrow.time);
    check('last arrow price matches the live detector', near(lastFromBacktest.price, live.lastArrow.price));
  }

  check('too little history returns no arrows, not a throw', B.findAllArrows(closes.slice(0, 20), times.slice(0, 20), 12, 50).length === 0);
  check('flat series produces no arrows', B.findAllArrows(Array(200).fill(100), times, 12, 50).length === 0);
  check('defaults to the app\'s own EMA periods when none given', B.findAllArrows(closes, times).length === arrows.length);
}

// ── isChoppyAt: matches the semantics of XO_CHOP_WINDOW / XO_CHOP_FLIPS, using only past arrows ──
function isChoppyAtTests() {
  console.log('\nisChoppyAt');
  const CHOP_FLIPS = D.DETECTOR_CONSTANTS.XO_CHOP_FLIPS, CHOP_WINDOW = D.DETECTOR_CONSTANTS.XO_CHOP_WINDOW;
  const mk = (idx) => ({ idx });
  // CHOP_FLIPS flips landing within CHOP_WINDOW candles of each other -> choppy
  const tight = [];
  for (let i = 0; i < CHOP_FLIPS + 1; i++) tight.push(mk(i * 2));
  check('flips packed inside the window are flagged choppy', B.isChoppyAt(tight, tight.length - 1) === true);

  // spread far apart -> not choppy
  const spread = [];
  for (let i = 0; i < CHOP_FLIPS + 1; i++) spread.push(mk(i * (CHOP_WINDOW * 2)));
  check('flips spread well beyond the window are not choppy', B.isChoppyAt(spread, spread.length - 1) === false);

  check('a single arrow is never choppy on its own', B.isChoppyAt([mk(0)], 0) === false);

  // only PAST arrows count — a cluster that happens later must not retroactively flag an earlier one
  const seq = [mk(0), mk(500), mk(502), mk(504)];
  check('an isolated early arrow is not marked choppy by a later cluster', B.isChoppyAt(seq, 0) === false);
  check('the later cluster is still flagged for itself', B.isChoppyAt(seq, 3) === true);
}

// ── forwardReturn: sign convention and out-of-range handling ──
function forwardReturnTests() {
  console.log('\nforwardReturn');
  const closes = [100, 102, 104, 96, 90];
  check('bull arrow: positive move forward is a positive return', near(B.forwardReturn({ dir: 'bull', idx: 0, price: 100 }, closes, 1), 0.02));
  check('bear arrow: the SAME upward price move is a negative return', near(B.forwardReturn({ dir: 'bear', idx: 0, price: 100 }, closes, 1), -0.02));
  check('bull arrow tracks a later drawdown correctly', near(B.forwardReturn({ dir: 'bull', idx: 0, price: 100 }, closes, 3), -0.04));
  check('beyond the end of the series returns null, not a throw', B.forwardReturn({ dir: 'bull', idx: 0, price: 100 }, closes, 10) === null);
  check('exactly at the last index is still in range', B.forwardReturn({ dir: 'bull', idx: 0, price: 100 }, closes, 4) !== null);
}

// ── simulateTrade: stop/target/timeout logic, long and short ──
function simulateTradeTests() {
  console.log('\nsimulateTrade');
  const n = 30;
  const flatHigh = Array(n).fill(100), flatLow = Array(n).fill(100), flatClose = Array(n).fill(100);

  // long: target hit cleanly before the stop
  {
    const highs = flatHigh.slice(), lows = flatLow.slice(), closes = flatClose.slice();
    highs[5] = 103; // +2% at 1% stop, 2R target = 102 needed -> hits at bar 5
    const r = B.simulateTrade({ dir: 'bull', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 20);
    check('long target hit -> win at the reward multiple', r.outcome === 'win' && near(r.r, 2) && r.bars === 5);
  }
  // long: stop hit before target
  {
    const highs = flatHigh.slice(), lows = flatLow.slice(), closes = flatClose.slice();
    lows[3] = 98.5; // below the 99 stop
    const r = B.simulateTrade({ dir: 'bull', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 20);
    check('long stop hit -> loss at -1R', r.outcome === 'loss' && r.r === -1 && r.bars === 3);
  }
  // short: mirrors long with signs flipped
  {
    const highs = flatHigh.slice(), lows = flatLow.slice(), closes = flatClose.slice();
    lows[4] = 98; // -2% for a short = a win
    const r = B.simulateTrade({ dir: 'bear', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 20);
    check('short target hit -> win', r.outcome === 'win' && near(r.r, 2));
  }
  {
    const highs = flatHigh.slice(), lows = flatLow.slice(), closes = flatClose.slice();
    highs[2] = 101.5; // above the short's stop
    const r = B.simulateTrade({ dir: 'bear', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 20);
    check('short stop hit -> loss', r.outcome === 'loss' && r.r === -1);
  }
  // same candle hits both -> scored as the stop (worst case), for both directions
  {
    const highs = flatHigh.slice(), lows = flatLow.slice(), closes = flatClose.slice();
    highs[2] = 103; lows[2] = 98.5;
    const r = B.simulateTrade({ dir: 'bull', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 20);
    check('same-candle stop+target scores as the stop (worst case)', r.outcome === 'loss');
  }
  // neither hit -> timeout, mark-to-market R
  {
    const highs = flatHigh.slice(), lows = flatLow.slice(), closes = flatClose.slice();
    closes[10] = 100.4; // +0.4% at a 1% stop = 0.4R, well short of the 2R target
    const r = B.simulateTrade({ dir: 'bull', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 10);
    check('no stop or target hit -> timeout', r.outcome === 'timeout' && r.bars === 10);
    check('timeout R is mark-to-market against the stop distance', near(r.r, 0.4, 0.05));
  }
  // never runs past the end of the series
  {
    const highs = flatHigh.slice(0, 5), lows = flatLow.slice(0, 5), closes = flatClose.slice(0, 5);
    const r = B.simulateTrade({ dir: 'bull', idx: 0, price: 100 }, highs, lows, closes, 0.01, 2, 100);
    check('maxBars beyond the data is clamped, not a throw', r.bars <= 4);
  }
}

// ── summarize: aggregate math (win rate excludes timeouts from its denominator; expectancy
//    includes every row) ──
function summarizeTests() {
  console.log('\nsummarize');
  const rows = [
    { outcome: 'win', r: 2, fwd: { 1: 0.01, 5: 0.02, 10: null, 20: null } },
    { outcome: 'win', r: 2, fwd: { 1: 0.01, 5: 0.02, 10: null, 20: null } },
    { outcome: 'loss', r: -1, fwd: { 1: -0.01, 5: null, 10: null, 20: null } },
    { outcome: 'timeout', r: 0.3, fwd: { 1: 0.005, 5: null, 10: null, 20: null } }
  ];
  const lines = [];
  B.summarize('test', rows, (s) => lines.push(s));
  const out = lines.join(' ');
  check('reports the right n', out.includes('n=    4'));
  // win rate is wins / (wins+losses) = 2/3, excluding the timeout from the denominator
  check('win rate excludes timeouts from its denominator', out.includes('66.7'));
  // expectancy = mean of ALL rows' r: (2+2-1+0.3)/4 = 0.825
  check('expectancy averages every row, timeouts included', out.includes('+0.83R') || out.includes('+0.82R'));
  check('breakdown counts are shown', out.includes('2W/1L/1T'));

  const empty = [];
  B.summarize('empty', [], (s) => empty.push(s));
  check('an empty set logs a line instead of throwing', empty.length === 1 && empty[0].includes('no arrows'));
}

// ── runBacktest: the whole pipeline, offline (a fake `fetch` stands in for Binance) ──
async function runBacktestTests() {
  console.log('\nrunBacktest (offline, fake fetch)');
  const HOUR = 3600000;
  const T0 = Date.UTC(2026, 0, 1);
  // enough candles for the 50-EMA to settle, with a clean down->up->down shape so multiple
  // arrows exist to summarize and to write to CSV
  const closes = [];
  for (let i = 0; i < 150; i++) closes.push(100 - i * 0.3);
  for (let i = 0; i < 150; i++) closes.push(closes[closes.length - 1] + i * 0.4);
  for (let i = 0; i < 150; i++) closes.push(closes[closes.length - 1] - i * 0.4);
  const rows = closes.map((c, i) => kline(T0 + i * HOUR, c, c + Math.abs(c) * 0.002, c - Math.abs(c) * 0.002));

  const logs = [], errs = [];
  const fakeFetch = async (symbol, interval, start, end, market, opts) => {
    check('fetch called with the symbol/interval/market passed to runBacktest', symbol === 'TESTUSDT' && interval === '1h' && market === 'futures');
    return rows;
  };
  const result = await B.runBacktest({
    symbol: 'TESTUSDT', interval: '1h', days: 30, market: 'futures',
    stopPct: 0.01, rMult: 2, maxBars: 40,
    log: (s) => logs.push(s), err: (s) => errs.push(s), fetch: fakeFetch
  });
  check('no network was touched (fetchKlines itself never ran)', errs.length === 0);
  check('returns the arrow count and rows', result.arrows > 0 && Array.isArray(result.rows) && result.rows.length === result.arrows);
  check('every row has an outcome', result.rows.every(r => ['win', 'loss', 'timeout'].includes(r.outcome)));
  check('printed a summary for bull, bear, and the chop split', logs.some(l => l.includes('Bull arrows')) && logs.some(l => l.includes('Bear arrows')) && logs.some(l => l.includes('CHOP FILTER')));

  // CSV export
  const csvPath = path.join(os.tmpdir(), 'backtest-xo-test-' + Date.now() + '.csv');
  const withCsv = await B.runBacktest({
    symbol: 'TESTUSDT', interval: '1h', days: 30, stopPct: 0.01, rMult: 2, maxBars: 40,
    outCsv: csvPath, log: () => {}, err: () => {}, fetch: fakeFetch
  });
  const csvExists = fs.existsSync(csvPath);
  check('CSV file was written', csvExists);
  if (csvExists) {
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.trim().split('\n');
    check('CSV header matches the documented columns', lines[0] === 'time,dir,price,choppy,fwd_1,fwd_5,fwd_10,fwd_20,outcome,r,bars');
    check('CSV has one data row per arrow', lines.length - 1 === withCsv.arrows);
    fs.unlinkSync(csvPath);
  }

  // graceful failure paths — must resolve with {error}, never throw or call process.exit
  const badInterval = await B.runBacktest({ symbol: 'X', interval: '7h', fetch: fakeFetch, log: () => {}, err: () => {} });
  check('unrecognised interval resolves with an error, not a throw', !!badInterval.error);

  const noSymbol = await B.runBacktest({ fetch: fakeFetch, log: () => {}, err: () => {} });
  check('missing symbol resolves with an error, not a throw', !!noSymbol.error);

  const thinData = async () => rows.slice(0, 10);
  const tooThin = await B.runBacktest({ symbol: 'X', interval: '1h', fetch: thinData, log: () => {}, err: () => {} });
  check('too few candles resolves with an error and the candle count', tooThin.error && tooThin.candleCount === 10);

  const throws = async () => { throw new Error('network down'); };
  const netErr = await B.runBacktest({ symbol: 'X', interval: '1h', fetch: throws, log: () => {}, err: () => {} });
  check('a fetch failure resolves with an error, not an unhandled rejection', !!netErr.error);

  const flatRows = Array.from({ length: 200 }, (_, i) => kline(T0 + i * HOUR, 100));
  const flatFetch = async () => flatRows;
  const noArrows = await B.runBacktest({ symbol: 'X', interval: '1h', fetch: flatFetch, log: () => {}, err: () => {} });
  check('a flat market with no arrows resolves cleanly with arrows: 0', noArrows.arrows === 0);
}

// ── fetchKlines pagination, exercised against a fake https module is impractical here without a
//    dependency; instead this checks the function's documented contract indirectly through
//    runBacktest's fake-fetch tests above, and directly validates INTERVAL_MS covers every
//    interval string the CLI help text advertises. ──
function intervalTableTests() {
  console.log('\nINTERVAL_MS');
  const advertised = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
  check('every documented interval has a millisecond value', advertised.every(iv => typeof B.INTERVAL_MS[iv] === 'number'));
  check('1h is exactly one hour', B.INTERVAL_MS['1h'] === 3600000);
  check('4h is exactly four hours (matches the app\'s SIX_HOUR... no, its own 4H key)', B.INTERVAL_MS['4h'] === 4 * 3600000);
  check('1d is exactly one day', B.INTERVAL_MS['1d'] === 86400000);
}

findAllArrowsTests();
isChoppyAtTests();
forwardReturnTests();
simulateTradeTests();
summarizeTests();
intervalTableTests();

runBacktestTests().then(() => {
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll backtest-xo checks passed.');
  process.exit(fails ? 1 : 0);
});
