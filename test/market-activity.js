// Tests for src/market-activity.js — the "is the market unusually quiet?" logic.
// Run with:  node test/market-activity.js       (no dependencies, no network, no DOM)
//
// Covers: candle normalisation, the time-of-day / weekday-vs-weekend baseline, stale and incomplete data,
// the median across a basket, the quiet/normal/active state machine with hysteresis, and when an alert is
// allowed to fire. It does NOT cover the UI, the fetching, or whether the default thresholds are well
// chosen for real markets — those are untested guesses and are checked by running the app.

const path = require('path');
const M = require(path.join(__dirname, '..', 'src', 'market-activity.js'));

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name, cond ? '' : '→ ' + JSON.stringify(extra));
  if (!cond) fails++;
};
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-9);
const HOUR = 3600000, DAY = 86400000;

// Wed 2026-10-07 14:05 UTC: the newest CLOSED hourly candle opened at 13:00.
const WED = Date.UTC(2026, 9, 7, 14, 5);
// Sat 2026-10-10 14:05 UTC
const SAT = Date.UTC(2026, 9, 10, 14, 5);

// hourly candles up to `now`, as the proxy would return them (arrays + ms timestamps). volFn/rangeFn shape them.
function payload(now, days, volFn, rangeFn) {
  const times = [], volumes = [], highs = [], lows = [], closes = [];
  const last = Math.floor(now / HOUR) * HOUR;                  // open time of the (forming) current candle
  for (let t = last - days * DAY; t <= last; t += HOUR) {
    times.push(t); volumes.push(volFn(t)); closes.push(100);
    const r = rangeFn ? rangeFn(t) : 0.01;
    highs.push(100 + 50 * r); lows.push(100 - 50 * r);          // (h - l) / c = r
  }
  return { times, volumes, highs, lows, closes };
}
const hourOf = (t) => new Date(t).getUTCHours();
const dow = (t) => new Date(t).getUTCDay();
const isWe = (t) => dow(t) === 0 || dow(t) === 6;
// a realistic-ish daily rhythm, weekends at half the weekday volume
const rhythm = (t) => (1000 + 600 * Math.sin((hourOf(t) / 24) * 2 * Math.PI)) * (isWe(t) ? 0.5 : 1);

// ── normalisation ──
console.log('\nmaNormalize');
let p = payload(WED, 3, rhythm);
let c = M.maNormalize(p, WED);
check('keeps only CLOSED candles (drops the one still forming)', c[c.length - 1].t === Date.UTC(2026, 9, 7, 13), new Date(c[c.length - 1].t).toISOString());
check('candles are ascending', c.every((x, i) => i === 0 || x.t > c[i - 1].t));
const rev = { times: p.times.slice().reverse(), volumes: p.volumes.slice().reverse(), highs: p.highs.slice().reverse(), lows: p.lows.slice().reverse(), closes: p.closes.slice().reverse() };
check('newest-first input (some exchanges) is sorted ascending', M.maNormalize(rev, WED).every((x, i, a) => i === 0 || x.t > a[i - 1].t));
const dup = { times: [...p.times, p.times[5]], volumes: [...p.volumes, 99999], highs: [...p.highs, 101], lows: [...p.lows, 99], closes: [...p.closes, 100] };
check('a duplicated timestamp is kept once', M.maNormalize(dup, WED).length === c.length);
check('range = (high - low) / close', near(c[0].range, 0.01, 1e-9), c[0].range);
check('junk payloads give an empty list, not a throw', M.maNormalize(null, WED).length === 0 && M.maNormalize({}, WED).length === 0 && M.maNormalize({ times: ['x'], volumes: [1], highs: [1], lows: [1], closes: [1] }, WED).length === 0);
check('a zero or negative close is dropped', M.maNormalize({ times: [0], volumes: [1], highs: [1], lows: [1], closes: [0] }, WED).length === 0);

// ── per-coin ratio ──
console.log('\nmaSymbolRatios');
const norm = (pl, now) => M.maNormalize(pl, now);
// steady-state weekday: current volume = baseline -> ratio 1
let r = M.maSymbolRatios(norm(payload(WED, 14, rhythm), WED), WED);
check('a market behaving exactly as usual reads 1.00', r && near(r.vol, 1, 1e-9) && near(r.range, 1, 1e-9), r);
check('a weekday baseline uses the matching weekdays only (several samples)', r.samples >= 6, r);

// the last 4 hours are at half volume
const half = (t) => rhythm(t) * (t >= Date.UTC(2026, 9, 7, 10) ? 0.5 : 1);
r = M.maSymbolRatios(norm(payload(WED, 14, half), WED), WED);
check('half the usual volume for the latest 4 hours reads 0.50', r && near(r.vol, 0.5, 1e-9), r);
const hot = (t) => 0.01 * (t >= Date.UTC(2026, 9, 7, 10) ? 2 : 1);
r = M.maSymbolRatios(norm(payload(WED, 14, rhythm, hot), WED), WED);
check('double the usual price range reads 2.00', r && near(r.range, 2, 1e-9), r);

// THE key property: weekends are structurally quiet; a normal Saturday must not look "quiet"
r = M.maSymbolRatios(norm(payload(SAT, 14, rhythm), SAT), SAT);
check('a NORMAL Saturday (half the weekday volume, as usual) reads ~1.00, not 0.5', r && near(r.vol, 1, 1e-9), r);
check('a Saturday baseline rests on the few weekend days available (and says so)', r && r.samples >= 2 && r.samples <= 4, r);
// the control: if weekends were NOT separated, this Saturday would have read about 0.5
const naive = (() => { const cs = norm(payload(SAT, 14, rhythm), SAT), by = {}; cs.forEach(x => by[x.t] = x); const te = cs[cs.length - 1].t; let cur = 0; for (let i = 0; i < 4; i++) cur += by[te - i * HOUR].v;
  const base = []; for (let k = 1; k <= 14; k++) { let s = 0, ok = true; for (let i = 0; i < 4; i++) { const x = by[te - k * DAY - i * HOUR]; if (!x) { ok = false; break; } s += x.v; } if (ok) base.push(s); } base.sort((a, b) => a - b); return cur / base[base.length >> 1]; })();
check('control: WITHOUT the weekday/weekend split the same Saturday would read ~0.5 (false "quiet")', naive < 0.65, naive);
// and a genuinely quiet Saturday is still caught
const halfSat = (t) => rhythm(t) * (t >= Date.UTC(2026, 9, 10, 10) ? 0.5 : 1);
r = M.maSymbolRatios(norm(payload(SAT, 14, halfSat), SAT), SAT);
check('a genuinely slow Saturday (half of a normal Saturday) reads 0.50', r && near(r.vol, 0.5, 1e-9), r);

// data problems -> null, never a wrong number
check('too little history gives null', M.maSymbolRatios(norm(payload(WED, 1, rhythm), WED), WED) === null);
check('only 2 matching weekdays of history is not enough for a weekday reading (needs 3)', M.maSymbolRatios(norm(payload(WED, 3, rhythm), WED), WED) === null);
const stale = payload(WED - 6 * HOUR, 14, rhythm);
check('a feed whose newest closed candle is 6h old gives null (stale)', M.maSymbolRatios(norm(stale, WED), WED) === null);
const holed = payload(WED, 14, rhythm); const hi = holed.times.indexOf(Date.UTC(2026, 9, 7, 12));
['times', 'volumes', 'highs', 'lows', 'closes'].forEach(k => holed[k].splice(hi, 1));
check('a missing candle inside the current window gives null', M.maSymbolRatios(norm(holed, WED), WED) === null);
const holedBase = payload(WED, 14, rhythm); const bi = holedBase.times.indexOf(Date.UTC(2026, 9, 6, 12));
['times', 'volumes', 'highs', 'lows', 'closes'].forEach(k => holedBase[k].splice(bi, 1));
const rb = M.maSymbolRatios(norm(holedBase, WED), WED);
check('a hole in ONE baseline day just drops that day (still valid, one fewer sample)', rb && near(rb.vol, 1, 1e-9), rb);
check('a coin with zero baseline volume gives null (no divide-by-zero)', M.maSymbolRatios(norm(payload(WED, 14, () => 0), WED), WED) === null);
check('zero CURRENT volume is a valid reading of 0', (() => { const z = M.maSymbolRatios(norm(payload(WED, 14, (t) => t >= Date.UTC(2026, 9, 7, 10) ? 0 : rhythm(t)), WED), WED); return z && z.vol === 0; })());

// ── the market ──
console.log('\nmaAggregate');
const R = (vol, range, samples) => ({ vol, range, samples: samples || 8, tEnd: 1 });
let agg = M.maAggregate([R(0.5, 0.9), R(0.6, 1), R(0.7, 0.8), R(0.55, 1), R(0.4, 0.7), R(0.65, 0.9), null, null]);
check('median volume and range across coins; nulls ignored', agg && near(agg.vol, 0.575) && near(agg.range, 0.9) && agg.n === 6, agg);
check('too few coins with a reading gives no market reading', M.maAggregate([R(0.5, 1), R(0.5, 1), null, null, null]) === null);
agg = M.maAggregate([R(0.1, 1), R(0.1, 1), R(0.1, 1), R(2.5, 1), R(0.1, 1), R(0.1, 1), R(0.1, 1)]);
check('one coin with a volume spike cannot move the median', agg.vol === 0.1, agg);
agg = M.maAggregate([R(0.5, null), R(0.6, null), R(0.7, null), R(0.5, null), R(0.5, null), R(0.5, null)]);
check('no range data at all gives range null, volume still works', agg && agg.range === null && agg.vol === 0.5, agg);
check('share of coins below 80% of normal is reported', near(M.maAggregate([R(0.5, 1), R(0.5, 1), R(0.5, 1), R(0.9, 1), R(1, 1), R(1.2, 1)]).belowShare, 0.5));

// ── state machine ──
console.log('\nmaNextState');
const A = (vol, range) => ({ vol, range, n: 12, samples: 8 });
check('normal activity stays normal', M.maNextState('normal', A(1, 1)).state === 'normal');
check('volume at or below 65% with ordinary movement enters QUIET', M.maNextState('normal', A(0.6, 0.9)).state === 'quiet' && M.maNextState('normal', A(0.65, 1.0)).state === 'quiet');
check('volume just above 65% is not quiet', M.maNextState('normal', A(0.66, 0.9)).state === 'normal');
check('low volume WITH an unusually big price range is not "quiet" (that is news)', M.maNextState('normal', A(0.5, 1.6)).state === 'normal');
check('no range data: volume alone decides', M.maNextState('normal', A(0.5, null)).state === 'quiet');
check('hysteresis: at 72% (above the 65% entry, below the 80% exit) QUIET persists', M.maNextState('quiet', A(0.72, 0.9)).state === 'quiet');
check('hysteresis: once volume recovers to 80%, QUIET ends', M.maNextState('quiet', A(0.8, 0.9)).state === 'normal');
check('QUIET also ends if movement jumps to 125% even with volume still low', M.maNextState('quiet', A(0.6, 1.3)).state === 'normal');
check('150% of normal volume reads ACTIVE', M.maNextState('normal', A(1.5, 1)).state === 'active' && M.maNextState('quiet', A(1.6, 1)).state === 'active');
check('first reading from "unknown" goes straight to the right state', M.maNextState('unknown', A(0.5, 1)).state === 'quiet' && M.maNextState(undefined, A(1, 1)).state === 'normal');
check('no data keeps the previous state (an outage must not flip it)', (() => { const x = M.maNextState('quiet', null); return x.state === 'quiet' && x.changed === false; })());
check('changed flag is true only when the state really changes', M.maNextState('normal', A(0.5, 1)).changed === true && M.maNextState('quiet', A(0.5, 1)).changed === false);
// a reading oscillating around the entry line must not flap alerts on and off
let st = 'normal', flips = 0;
[0.64, 0.67, 0.64, 0.68, 0.66, 0.7, 0.62, 0.69].forEach(v => { const x = M.maNextState(st, A(v, 1)); if (x.changed) flips++; st = x.state; });
check('a reading wobbling 0.62-0.70 flips state ONCE, not on every wobble', flips === 1 && st === 'quiet', { flips, st });

// ── alert gating ──
console.log('\nmaShouldAlert');
const T0 = 1e12;
check('alerts when entering quiet for the first time', M.maShouldAlert('normal', 'quiet', 0, T0) === true);
check('first-ever reading that is already quiet also alerts (you opened the app mid-lull)', M.maShouldAlert('unknown', 'quiet', 0, T0) === true);
check('does NOT alert again while still quiet (e.g. after a page reload)', M.maShouldAlert('quiet', 'quiet', T0 - 10 * HOUR, T0) === false);
check('does not alert for normal or active', M.maShouldAlert('quiet', 'normal', 0, T0) === false && M.maShouldAlert('normal', 'active', 0, T0) === false);
check('cooldown: a second quiet within 3h of the last alert is suppressed', M.maShouldAlert('normal', 'quiet', T0 - 2 * HOUR, T0) === false);
check('cooldown: allowed again after 3h', M.maShouldAlert('normal', 'quiet', T0 - 3 * HOUR, T0) === true);

// ── wording ──
console.log('\nmaDescribe');
const dq = M.maDescribe('quiet', { vol: 0.52, range: 0.61, n: 12, samples: 8 });
check('quiet message states the numbers and the advice', /52%/.test(dq.body) && /61%/.test(dq.body) && /12 majors/.test(dq.body) && /sizing down or waiting/.test(dq.title), dq);
check('short pill text carries the multiple', dq.short === 'QUIET 0.52×', dq.short);
check('weekend-style thin baseline is described honestly ("few comparable days")', /few comparable/.test(M.maDescribe('quiet', { vol: 0.5, range: 1, n: 12, samples: 2 }).body));
check('no reading gives a neutral message, not NaN', /unavailable/i.test(M.maDescribe('normal', null).title));
check('range omitted from the text when unknown', !/movement/.test(M.maDescribe('quiet', { vol: 0.5, range: null, n: 12, samples: 8 }).body));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll market-activity checks passed.');
process.exit(fails ? 1 : 0);
