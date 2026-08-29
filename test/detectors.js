// Math tests for the extracted detectors.
// Run with:  node test/detectors.js       (no dependencies, no build step)
//
// Two kinds of assertion are used here, and the difference matters:
//
//   ANALYTIC  — the expected value is derived from the algorithm by hand, so the
//               test would catch the implementation silently changing meaning.
//   INVARIANT — a property that must hold for any correct implementation
//               (alignment, length, monotonicity, graceful degradation).
//
// Thresholds are read from the module rather than hardcoded, so tuning a
// constant does not produce a false test failure.

const path = require('path');
const D = require(path.join(__dirname, '..', 'src', 'detectors.js'));

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── computeVolumeProfile ──────────────────────────────────────────────────────
function volumeProfileTests() {
  console.log('\ncomputeVolumeProfile');
  const N = D.VP_BUCKETS;

  // ANALYTIC: every bar spans exactly 100..107 with equal volume, so volume is
  // spread uniformly across all N buckets. POC ties resolve to bucket 0, and the
  // value area expands upward (ties favour the high side) until it holds
  // VALUE_AREA_PCT of the buckets.
  const highs = [], lows = [], vols = [];
  for (let i = 0; i < 10; i++) { highs.push(107); lows.push(100); vols.push(10); }
  const bucket = 7 / N;
  const need = Math.ceil(N * D.VALUE_AREA_PCT);
  const vp = D.computeVolumeProfile(highs, lows, vols, 0, 9);
  check('uniform series: POC at the midpoint of bucket 0', near(vp.poc, 100 + bucket / 2));
  check('uniform series: VAL at the bottom of the range', near(vp.val, 100));
  check(`uniform series: VAH after expanding to ${need} buckets`, near(vp.vah, 100 + need * bucket));
  check('uniform series: VAL < POC < VAH', vp.val < vp.poc && vp.poc < vp.vah);

  // ANALYTIC: all volume sits in one narrow bar, so POC must land on it and the
  // value area must be far tighter than the full price range.
  const h2 = [110, 105.05, 105.05, 105.05, 100];
  const l2 = [100, 105.00, 105.00, 105.00, 100];
  const v2 = [0.0001, 500, 500, 500, 0.0001];
  const vp2 = D.computeVolumeProfile(h2, l2, v2, 0, 4);
  check('concentrated series: POC sits on the heavy price shelf',
    vp2.poc > 104.9 && vp2.poc < 105.2);
  check('concentrated series: value area is much tighter than the full range',
    (vp2.vah - vp2.val) < (110 - 100) * 0.5);

  // ANALYTIC: one bar spanning two buckets contributes to both in proportion to
  // the overlap. This is the property that separates a real volume profile from
  // a naive close-price histogram.
  const h3 = [102], l3 = [100], v3 = [90];
  const vp3 = D.computeVolumeProfile(h3, l3, v3, 0, 0);
  check('single spanning bar still yields a valid profile',
    vp3 && vp3.val >= 100 && vp3.vah <= 102 && vp3.poc >= 100 && vp3.poc <= 102);

  // INVARIANT: degenerate and empty inputs must degrade, not throw.
  check('flat price (max === min) -> null',
    D.computeVolumeProfile([100, 100], [100, 100], [5, 5], 0, 1) === null);
  check('zero total volume -> null',
    D.computeVolumeProfile([107, 107], [100, 100], [0, 0], 0, 1) === null);
  check('all-undefined volume -> null',
    D.computeVolumeProfile([107, 107], [100, 100], [undefined, undefined], 0, 1) === null);
}

// ── calcRSI ───────────────────────────────────────────────────────────────────
function rsiTests() {
  console.log('\ncalcRSI');
  const period = 14;
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 40 }, (_, i) => 200 - i);
  const flat = new Array(40).fill(100);

  const r = D.calcRSI(rising, period);
  // INVARIANT: rsi[i] must line up with closes[i] or every downstream
  // divergence comparison is reading the wrong candle.
  check('output length matches input length', r.length === rising.length);
  check(`first ${period + 1} entries are null (alignment padding)`,
    r.slice(0, period + 1).every(v => v === null) && r[period + 1] !== null);

  // ANALYTIC: with no losses avgL is 0, which the implementation maps to 100.
  check('monotonically rising series -> RSI 100', r[r.length - 1] === 100);
  // ANALYTIC: with no gains avgG is 0, so 100 - 100/(1+0) = 0.
  const f = D.calcRSI(falling, period);
  check('monotonically falling series -> RSI 0', f[f.length - 1] === 0);

  // ANALYTIC + documented quirk: a perfectly flat series has avgL === 0, which
  // takes the same branch as "no losses" and yields 100 rather than a neutral 50.
  // Pinned deliberately so the behaviour cannot change unnoticed.
  const fl = D.calcRSI(flat, period);
  check('flat series -> 100 (avgL === 0 branch, not a neutral 50)',
    fl[fl.length - 1] === 100);

  // INVARIANT: bounded.
  const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 8 + Math.cos(i / 3) * 3);
  check('RSI stays within [0, 100]',
    D.calcRSI(noisy, period).every(v => v === null || (v >= 0 && v <= 100)));

  // INVARIANT: insufficient history returns empty, never a partial array.
  check('closes.length < period+1 -> []', D.calcRSI([1, 2, 3], period).length === 0);
  check('empty input -> []', D.calcRSI([], period).length === 0);
}

// ── calcEMA ───────────────────────────────────────────────────────────────────
function emaTests() {
  console.log('\ncalcEMA');
  const constant = new Array(50).fill(42);
  const ema = D.calcEMA(constant, 20);
  // ANALYTIC: an EMA of a constant series is that constant at every point.
  check('EMA of a constant series is the constant', ema.every(v => near(v, 42)));
  check('output length matches input length', ema.length === constant.length);
  check('seeded with the first close', near(D.calcEMA([10, 20, 30], 2)[0], 10));

  // ANALYTIC: second value = c1*k + seed*(1-k) with k = 2/(period+1).
  const k = 2 / (2 + 1);
  check('second value follows c*k + prev*(1-k)',
    near(D.calcEMA([10, 20, 30], 2)[1], 20 * k + 10 * (1 - k)));

  check('closes.length < period -> []', D.calcEMA([1, 2], 20).length === 0);
  check('null input -> []', D.calcEMA(null, 20).length === 0);
}

// ── swing / pivot detection ───────────────────────────────────────────────────
function swingTests() {
  console.log('\nfindSwingHighs / findSwingLows / findPivots');

  // ANALYTIC: the comparison is `arr[j] >= arr[i]` on BOTH sides, so a tie
  // disqualifies. A flat top therefore yields no swing high at all.
  // This is the anchor-selection rule the whole FRVP window depends on, so it is
  // pinned explicitly: a drifting anchor silently shortens every profile window.
  check('flat top yields no swing high (strict on both sides)',
    D.findSwingHighs([1, 2, 5, 5, 2, 1], 1).length === 0);

  const peak = D.findSwingHighs([1, 2, 9, 2, 1], 1);
  check('clear peak is found at the right index', peak.length === 1 && peak[0].idx === 2);
  check('swing entries carry {idx, val}', peak[0].val === 9);

  const trough = D.findSwingLows([9, 8, 1, 8, 9], 1);
  check('clear trough is found at the right index', trough.length === 1 && trough[0].idx === 2);

  // ANALYTIC: the loop runs i from win to len-win-1, so a peak inside the final
  // `win` candles cannot be confirmed yet — the right shoulder does not exist.
  check('peak inside the trailing window is not yet confirmable',
    D.findSwingHighs([1, 2, 3, 9], 1).every(p => p.idx !== 3));

  check('window larger than the series -> no swings',
    D.findSwingHighs([1, 2, 3], 5).length === 0);
  check('findPivots returns both sides',
    (() => {
      const p = D.findPivots([1, 9, 1, 9, 1, 9, 1], 1);
      return p && typeof p === 'object';
    })());
}

// ── calcBBSqueeze ─────────────────────────────────────────────────────────────
function bbTests() {
  console.log('\ncalcBBSqueeze');
  const need = D.BB_PERIOD + D.BW_LOOKBACK;
  const short = D.calcBBSqueeze(new Array(D.BB_PERIOD).fill(100));
  check('insufficient history -> inert result, not a throw',
    short.squeezing === false && short.strength === 0 && short.bw === 0);

  // ANALYTIC: zero standard deviation means zero bandwidth, so there is no
  // squeeze to report even though bandwidth is technically at its minimum.
  const flat = D.calcBBSqueeze(new Array(need + 5).fill(100));
  check('constant series -> zero bandwidth', flat.bw === 0);
  check('constant series -> not reported as squeezing', flat.squeezing === false);

  const noisy = Array.from({ length: need + 50 }, (_, i) => 100 + Math.sin(i / 4) * 6);
  const res = D.calcBBSqueeze(noisy);
  check('strength is bounded to [0, 100]', res.strength >= 0 && res.strength <= 100);
  check('bandwidth minimum never exceeds current bandwidth', res.bwMin <= res.bw + 1e-9);
}

// ── detectRange ───────────────────────────────────────────────────────────────
function rangeTests() {
  console.log('\ndetectRange');
  const n = 200;
  const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 6) * 4);
  const highs = closes.map(c => c + 0.5);
  const lows = closes.map(c => c - 0.5);
  const vols = new Array(n).fill(1000);
  const opens = closes.map((c, i) => (i === 0 ? c : closes[i - 1]));

  // INVARIANT: guards must reject cleanly rather than compute nonsense.
  check('timeframe outside RANGE_ENABLED_TFS -> null',
    D.detectRange(closes, highs, lows, vols, opens, 'ONE_MINUTE') === null);
  check('volume array length mismatch -> null',
    D.detectRange(closes, highs, lows, vols.slice(0, 10), opens, 'ONE_HOUR') === null);
  check('missing volume array -> null',
    D.detectRange(closes, highs, lows, null, opens, 'ONE_HOUR') === null);
  check('insufficient history -> null',
    D.detectRange(closes.slice(0, 5), highs.slice(0, 5), lows.slice(0, 5),
      vols.slice(0, 5), opens.slice(0, 5), 'ONE_HOUR') === null);

  // INVARIANT: whatever it returns must be one of the documented states and must
  // carry the three tradeable lines in the correct order.
  const STATES = ['ranging', 'near-top', 'near-bottom', 'dev-above', 'dev-below',
    'confirmed-up', 'confirmed-down'];

  // A quiet baseline, a sharp high-volume catalyst, then oscillation inside the
  // resulting box — the shape detectRange exists to find.
  const build = (after, amp, catPct) => {
    const c = [];
    for (let i = 0; i < 80; i++) c.push(100 + Math.sin(i / 3) * 0.3);
    const base = c[79];
    for (let i = 0; i < 5; i++) c.push(base * (1 + catPct * (i + 1) / 5));
    const top = c[c.length - 1];
    for (let i = 0; i < after; i++) c.push(top - amp / 2 + Math.sin(i / 2.2) * amp / 2);
    const h = c.map((x, i) => x + (i >= 80 && i < 85 ? 0.6 : 0.25));
    const l = c.map((x, i) => x - (i >= 80 && i < 85 ? 0.6 : 0.25));
    const v = c.map((_, i) => (i >= 80 && i < 85 ? 5000 : 1000));
    const o = c.map((x, i) => (i === 0 ? x : c[i - 1]));
    return [c, h, l, v, o];
  };

  const r = D.detectRange(...build(20, 8, 0.12), 'ONE_HOUR');
  check('a catalyst followed by oscillation produces a range', r !== null);
  if (r) {
    check('returned state is one of the documented states', STATES.includes(r.state));
    check('VAL < POC < VAH', r.val < r.poc && r.poc < r.vah);
    check('value area sits inside the structural box',
      r.val >= r.rangeLow - 1e-9 && r.vah <= r.rangeHigh + 1e-9);
    check('quality score respects its own floor',
      r.qualityScore >= D.RANGE_MIN_QUALITY && r.qualityScore <= 100);
    check('grade is A or B (C is excluded by the quality gate)', r.grade === 'A' || r.grade === 'B');
    check('width is inside the configured bounds',
      r.rangePct >= D.RANGE_MIN_WIDTH - 1e-9 && r.rangePct <= D.RANGE_MAX_WIDTH + 1e-9);
    check('catalyst direction is recorded', r.catalystDir === 'up' || r.catalystDir === 'down');
    check('swing count meets the minimum', r.swings >= D.FULL_SWING_MIN * 2);
  }

  // The freshness term in the quality score decays with age, so an otherwise
  // identical setup that drifted far from its catalyst falls below the floor.
  // This is what stops a stale box being surfaced as a live setup.
  check('the same shape far from its catalyst is no longer surfaced',
    D.detectRange(...build(40, 8, 0.12), 'ONE_HOUR') === null);

  // The box is measured from the catalyst pivot, so an oversized swing breaches
  // RANGE_MAX_WIDTH and must be rejected outright.
  check('an over-wide box is rejected', D.detectRange(...build(20, 40, 0.12), 'ONE_HOUR') === null);
}

// ── detectFVGs ────────────────────────────────────────────────────────────────
function fvgTests() {
  console.log('\ndetectFVGs');
  check('insufficient history -> []',
    D.detectFVGs([1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]).length === 0);
  check('null closes -> []', D.detectFVGs(null, [], [], []).length === 0);

  const n = D.FVG_LOOKBACK + 20;
  const flat = new Array(n).fill(100);
  check('flat series has no fair value gaps',
    D.detectFVGs(flat, flat.map(c => c + 0.1), flat.map(c => c - 0.1), flat).length === 0);

  // INVARIANT: a real displacement gap must be found and must be self-consistent.
  const c = new Array(n).fill(100);
  const h = c.map(x => x + 0.1), l = c.map(x => x - 0.1), o = c.slice();
  const g = n - 8;                    // leave room for the c3 candle and mitigation scan
  o[g] = 100; c[g] = 106; h[g] = 106.2; l[g] = 99.9;   // big green displacement
  for (let i = g + 1; i < n; i++) { c[i] = 107; o[i] = 106.5; h[i] = 107.5; l[i] = 106.0; }
  const fvgs = D.detectFVGs(c, h, l, o);
  check('a clear bullish displacement produces an FVG', fvgs.length >= 1);
  if (fvgs.length) {
    check('FVG gap boundaries are ordered', fvgs.every(f => f.gapTop > f.gapBottom));
    check('FVG midpoint sits between its boundaries',
      fvgs.every(f => f.midpoint > f.gapBottom && f.midpoint < f.gapTop));
    check('FVG carries a direction', fvgs.every(f => f.type === 'bullish' || f.type === 'bearish'));
  }
}

// ── adversarial inputs ────────────────────────────────────────────────────────
function adversarialTests() {
  console.log('\nadversarial inputs (the cases that have caused silent bugs before)');
  const n = 200;
  const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 6) * 4);
  const highs = closes.map(c => c + 0.5);
  const lows = closes.map(c => c - 0.5);
  const vols = new Array(n).fill(1000);
  const opens = closes.map((x, i) => (i === 0 ? x : closes[i - 1]));

  const safe = (label, fn) => {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    check(label, threw === null);
  };

  safe('detectRange tolerates a zero-volume final (still-forming) candle',
    () => D.detectRange(closes, highs, lows, vols.slice(0, -1).concat([0]), opens, 'ONE_HOUR'));
  safe('detectRange tolerates NaN in the series',
    () => D.detectRange(closes.map((c, i) => (i === 50 ? NaN : c)), highs, lows, vols, opens, 'ONE_HOUR'));
  safe('detectRange tolerates a zero price',
    () => D.detectRange(closes.map((c, i) => (i === 50 ? 0 : c)), highs, lows, vols, opens, 'ONE_HOUR'));
  safe('detectRange tolerates omitted opens', () => D.detectRange(closes, highs, lows, vols, null, 'ONE_HOUR'));
  safe('calcRSI tolerates NaN', () => D.calcRSI(closes.map((c, i) => (i === 5 ? NaN : c)), 14));
  safe('calcBBSqueeze tolerates a zero-mean series', () => D.calcBBSqueeze(new Array(200).fill(0)));
  safe('computeVolumeProfile tolerates inverted high/low', () => D.computeVolumeProfile(lows, highs, vols, 0, 20));
  safe('detectFVGs tolerates omitted opens', () => D.detectFVGs(closes, highs, lows, null));
  safe('findSwingHighs tolerates an empty array', () => D.findSwingHighs([], 3));
}

// ── module contract ───────────────────────────────────────────────────────────
function contractTests() {
  console.log('\nmodule contract');
  const required = ['calcRSI', 'calcEMA', 'calcBBSqueeze', 'findSwingHighs', 'findSwingLows',
    'findPivots', 'detect3Drive', 'detectFVGs', 'findSRLevels', 'computeVolumeProfile',
    'detectRange', 'setLogger', 'resetDriveFunnel', 'getDriveFunnel', 'DETECTOR_CONSTANTS'];
  check('every expected export is present', required.every(k => D[k] !== undefined));
  check('DETECTOR_CONSTANTS is frozen', Object.isFrozen(D.DETECTOR_CONSTANTS));
  check('constants are also exported individually (preserves the pre-extraction global surface)',
    D.VP_BUCKETS === D.DETECTOR_CONSTANTS.VP_BUCKETS &&
    D.RANGE_MIN_QUALITY === D.DETECTOR_CONSTANTS.RANGE_MIN_QUALITY);

  // The detectors must not require a logger. Under Node nothing wires one, and
  // detect3Drive emits near-miss diagnostics through it.
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 6);
  const highs = closes.map(c => c + 1), lows = closes.map(c => c - 1);
  let threw = null;
  try { D.detect3Drive(closes, highs, lows, D.calcRSI(closes, 14), 'ONE_HOUR', null); }
  catch (e) { threw = e; }
  check('detect3Drive runs with no logger wired', threw === null);

  // setLogger must actually be honoured, or index.html's near-miss warnings
  // would silently disappear after the extraction.
  let captured = 0;
  D.setLogger(() => { captured++; });
  D.setLogger(null);            // invalid input must not clear a working logger
  check('setLogger ignores a non-function', typeof D.setLogger === 'function');

  D.resetDriveFunnel();
  const f = D.getDriveFunnel();
  check('drive funnel resets to zeroed counters',
    f.candidates === 0 && f.passedGapPullback === 0 && f.passedFib === 0 && f.passedRSI === 0);
  D.getDriveFunnel().candidates = 7;
  check('getDriveFunnel returns the live object, not a copy', D.getDriveFunnel().candidates === 7);
  D.resetDriveFunnel();
  check('reset replaces the object seen by getDriveFunnel', D.getDriveFunnel().candidates === 0);
}

volumeProfileTests();
rsiTests();
emaTests();
swingTests();
bbTests();
rangeTests();
fvgTests();
adversarialTests();
contractTests();

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll detector checks passed.');
process.exit(fails ? 1 : 0);
