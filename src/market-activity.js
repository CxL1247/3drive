// ─────────────────────────────────────────────────────────────────────────────
// market-activity.js — "is the market unusually quiet right now?"
//
// Same sharing pattern as src/detectors.js and src/journal-edit.js: index.html loads this before its
// inline script (the factory assigns every export onto the global object) and test/market-activity.js
// require()s it directly, so there is ONE copy of the logic.
//
// What it measures, and why it is built this way
//   * It compares the LAST FOUR CLOSED 1H candles with the SAME FOUR HOURS on previous days. Volume has a
//     strong time-of-day pattern, so "low volume" only means something relative to that hour.
//   * Weekdays are compared with weekdays and weekends with weekends (by UTC day), because weekends are
//     structurally quieter — comparing a Saturday with the last five weekdays would cry "quiet" every
//     weekend. The cost: a weekend baseline rests on only ~2 days of the ~12 days of hourly history a
//     single request returns, so weekend readings are noisier (the sample count is reported).
//   * Each coin is compared with ITSELF, so the units of volume (base vs quote, exchange) don't matter.
//   * The market reading is the MEDIAN across a basket of liquid coins, so one coin's news can't trigger it.
//   * "Quiet" needs low volume AND price movement that is not unusually large — low volume during a
//     violent move is news, not a quiet market.
//   * Entering and leaving "quiet" use different thresholds (hysteresis), so a reading hovering at the
//     line doesn't flip the alert on and off.
//
// THRESHOLDS ARE UNTESTED DEFAULTS. They are reasonable guesses, not calibrated on history — treat the
// first weeks as tuning. They live in MA_DEFAULTS so they are easy to change in one place.
//
// Nothing here touches the DOM, network or localStorage.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(root, factory());
})(typeof self !== 'undefined' ? self : globalThis, function () {

var HOUR = 3600000, DAY = 86400000;

var MA_DEFAULTS = {
  windowBars: 4,              // compare the latest 4 closed hourly candles ...
  maxDays: 14,                // ... with the same hours on up to 14 previous days
  minSamplesWeekday: 3,       // baseline days required (matching day type)
  minSamplesWeekend: 2,       // weekends have far fewer matching days in the history available
  maxStaleMs: 3 * HOUR,       // the newest closed candle must be at most this old, or the data is stale
  minSymbols: 6,              // coins that must have a valid reading before the market gets one
  enterVol: 0.65,             // quiet when median volume is at or below 65% of normal ...
  enterRange: 1.0,            // ... and price movement is no bigger than normal
  exitVol: 0.80,              // leave quiet once volume recovers to 80% ...
  exitRange: 1.25,            // ... or movement jumps to 125% of normal
  activeVol: 1.5,             // "active" at 150% of normal volume (informational, no alert)
  cooldownMs: 3 * HOUR        // at most one quiet alert per 3 hours
};

function median(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function isWeekend(ms) { var d = new Date(ms).getUTCDay(); return d === 0 || d === 6; }
function pct(x) { return Math.round(x * 100) + '%'; }
function merge(o) {
  var out = {}, k;
  for (k in MA_DEFAULTS) out[k] = MA_DEFAULTS[k];
  if (o) for (k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// ── candles -> ascending, de-duplicated, CLOSED-only ──
// c: the proxy's { times (ms), volumes, highs, lows, closes } payload. Exchanges differ in ordering
// (some return newest first) and the last candle is usually still forming, so both are handled here.
// Returns [{ t (open time, ms), v, range }] where range = (high - low) / close.
function maNormalize(c, nowMs, tfMs) {
  tfMs = tfMs || HOUR;
  if (!c || !c.times || !c.volumes || !c.highs || !c.lows || !c.closes) return [];
  var out = [], seen = {}, i;
  for (i = 0; i < c.times.length; i++) {
    var t = +c.times[i], v = +c.volumes[i], h = +c.highs[i], l = +c.lows[i], cl = +c.closes[i];
    if (!isFinite(t) || !isFinite(v) || !isFinite(h) || !isFinite(l) || !(cl > 0) || v < 0) continue;
    if (seen[t]) continue;
    if (t + tfMs > nowMs) continue;                 // still forming — not a closed candle
    seen[t] = true;
    out.push({ t: t, v: v, range: (h - l) / cl });
  }
  out.sort(function (a, b) { return a.t - b.t; });
  return out;
}

// ── one coin: how does the latest window compare with the same hours on matching days? ──
// Returns { vol, range, samples, tEnd } or null when there isn't enough trustworthy data.
function maSymbolRatios(candles, nowMs, opts) {
  var o = merge(opts), W = o.windowBars, n = candles.length;
  if (n < W) return null;
  var byT = {}, i, k;
  for (i = 0; i < n; i++) byT[candles[i].t] = candles[i];
  var tEnd = candles[n - 1].t;                                  // open time of the newest closed candle
  if (nowMs - (tEnd + HOUR) > o.maxStaleMs) return null;        // stale feed — better no reading than a wrong one

  var curV = 0, curR = 0, c;
  for (i = 0; i < W; i++) {
    c = byT[tEnd - i * HOUR];
    if (!c) return null;                                        // a hole in the current window
    curV += c.v; curR += c.range;
  }
  curR /= W;

  var weekend = isWeekend(tEnd), vols = [], rngs = [];
  for (k = 1; k <= o.maxDays; k++) {
    var te = tEnd - k * DAY;
    if (isWeekend(te) !== weekend) continue;                    // weekday vs weekday, weekend vs weekend
    var sv = 0, sr = 0, ok = true;
    for (i = 0; i < W; i++) {
      c = byT[te - i * HOUR];
      if (!c) { ok = false; break; }
      sv += c.v; sr += c.range;
    }
    if (ok) { vols.push(sv); rngs.push(sr / W); }
  }
  if (vols.length < (weekend ? o.minSamplesWeekend : o.minSamplesWeekday)) return null;
  var bv = median(vols), br = median(rngs);
  if (!(bv > 0)) return null;
  return { vol: curV / bv, range: br > 0 ? curR / br : null, samples: vols.length, tEnd: tEnd };
}

// ── the market: median across the basket ──
// items: per-coin results from maSymbolRatios (nulls allowed). Returns null if too few coins have a reading.
function maAggregate(items, opts) {
  var o = merge(opts), valid = items.filter(Boolean);
  if (valid.length < o.minSymbols) return null;
  var ranges = valid.filter(function (v) { return v.range != null; }).map(function (v) { return v.range; });
  return {
    vol: median(valid.map(function (v) { return v.vol; })),
    range: ranges.length ? median(ranges) : null,
    n: valid.length,
    samples: median(valid.map(function (v) { return v.samples; })),
    belowShare: valid.filter(function (v) { return v.vol < 0.8; }).length / valid.length,
    tEnd: Math.max.apply(null, valid.map(function (v) { return v.tEnd; }))
  };
}

// ── state machine with hysteresis ──
// prev: 'unknown' | 'normal' | 'quiet' | 'active'.  agg: from maAggregate, or null when there is no reading
// (then the previous state is kept — an outage must not flip it).
function maNextState(prev, agg, opts) {
  var o = merge(opts);
  prev = prev || 'unknown';
  if (!agg) return { state: prev, changed: false };
  var calm = agg.range == null || agg.range <= o.enterRange, state;
  if (prev === 'quiet') {
    var leave = agg.vol >= o.exitVol || (agg.range != null && agg.range >= o.exitRange);
    state = leave ? (agg.vol >= o.activeVol ? 'active' : 'normal') : 'quiet';
  } else if (agg.vol <= o.enterVol && calm) {
    state = 'quiet';
  } else {
    state = agg.vol >= o.activeVol ? 'active' : 'normal';
  }
  return { state: state, changed: state !== prev };
}

// ── when to actually notify ──
// Only on ENTERING quiet, and not again within the cooldown. A reload while still quiet doesn't re-alert
// because the previous state is persisted by the caller.
function maShouldAlert(prevState, newState, lastAlertMs, nowMs, opts) {
  var o = merge(opts);
  if (newState !== 'quiet' || prevState === 'quiet') return false;
  return !lastAlertMs || nowMs - lastAlertMs >= o.cooldownMs;
}

// ── wording ──
function maDescribe(state, agg) {
  if (!agg) return { title: 'Market activity unavailable', body: 'Not enough recent candle data to judge.', short: 'Market —' };
  var vol = pct(agg.vol), rng = agg.range == null ? null : pct(agg.range);
  var basis = 'median of ' + agg.n + ' majors, vs the same hours on ' + (agg.samples >= 5 ? 'recent' : 'the few comparable') + ' days';
  if (state === 'quiet') return {
    title: 'Quiet market — consider sizing down or waiting',
    body: 'Volume is ' + vol + ' of normal for this time' + (rng ? ' and price movement ' + rng : '') + ' (' + basis + '). Moves in thin conditions tend to be less reliable and fills worse.',
    short: 'QUIET ' + agg.vol.toFixed(2) + '×'
  };
  if (state === 'active') return {
    title: 'Busy market',
    body: 'Volume is ' + vol + ' of normal for this time' + (rng ? ' and price movement ' + rng : '') + ' (' + basis + ').',
    short: 'ACTIVE ' + agg.vol.toFixed(2) + '×'
  };
  return {
    title: 'Activity back to normal',
    body: 'Volume is ' + vol + ' of normal for this time' + (rng ? ' and price movement ' + rng : '') + ' (' + basis + ').',
    short: 'normal ' + agg.vol.toFixed(2) + '×'
  };
}

return {
  MA_DEFAULTS: MA_DEFAULTS,
  maNormalize: maNormalize,
  maSymbolRatios: maSymbolRatios,
  maAggregate: maAggregate,
  maNextState: maNextState,
  maShouldAlert: maShouldAlert,
  maDescribe: maDescribe
};
});
