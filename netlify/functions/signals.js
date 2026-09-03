const crypto = require('crypto');
const D = require('../../src/detectors.js');

// ── WHAT THIS IS ──────────────────────────────────────────────────────────────
// The detectors, exposed as a pure function over HTTP. You POST a candle series,
// you get back every detector's verdict for it. That is the whole contract.
//
// It deliberately makes NO exchange calls and keeps NO state:
//
//   * Binance and Bybit reject Netlify's AWS IP ranges — that is why the
//     4-exchange race exists in proxy.js. A caller running anywhere else is not
//     blocked, so letting the caller supply the candles sidesteps the problem
//     entirely and keeps this function well inside its execution budget. A
//     scan-the-top-100 endpoint would need ~300 upstream fetches per request.
//   * No database means nothing to provision, migrate, or keep in sync. Whoever
//     is measuring already has somewhere to put the results.
//
// Every response carries detectorVersion — a hash of the detector code and its
// thresholds as actually loaded. When a constant is tuned (RANGE_MIN_QUALITY
// went 50 -> 65, for instance) the hash changes, so recorded signals split into
// clean cohorts instead of a silently mixed sample. Measuring a detector while
// it is being tuned is how you end up unable to trust any of the numbers.
//
// Optional env:
//   SIGNALS_TOKEN — if set, callers must send header x-signals-token
//   APP_ORIGIN    — if set, CORS is restricted to this origin
// ──────────────────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES  = 2 * 1024 * 1024;   // candle payloads are larger than alert payloads
const MAX_SERIES      = 25;
const MAX_CANDLES     = 1500;
const MIN_CANDLES     = 40;                // processTokenTF() ignores anything shorter
const RATE_WINDOW_MS  = 60_000;
const RATE_MAX_PER_IP = 60;

const RSI_PERIOD  = 14;                    // must match index.html
const SR_LOOKBACK = 100;                   // findSRLevels(..., 100) at the call site
const SR_CONFLUENCE_THRESHOLD = 0.004;     // checkSRConfluence(..., 0.004) at the call site
const VALID_TF = new Set(['SIX_HOUR', 'ONE_HOUR', 'THIRTY_MINUTE']);
const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;

// Hash the detector functions as loaded, plus their thresholds. Derived from the
// live module rather than by reading a file off disk, so it survives bundling.
const DETECTOR_VERSION = (() => {
  const parts = Object.keys(D).sort()
    .filter(k => typeof D[k] === 'function')
    .map(k => k + ':' + D[k].toString());
  parts.push('constants:' + JSON.stringify(D.DETECTOR_CONSTANTS));
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
})();

const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) if (!v.some(t => now - t < RATE_WINDOW_MS)) rateBuckets.delete(k);
  }
  return hits.length > RATE_MAX_PER_IP;
}

function tokenOk(provided, expected) {
  if (!expected) return true;
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Accepts {t,o,h,l,c,v} objects. Anything non-finite makes the series invalid
// rather than being coerced to 0 — a zero price would silently poison every
// percentage in the detectors.
function toArrays(candles) {
  const times = [], opens = [], highs = [], lows = [], closes = [], volumes = [];
  for (const k of candles) {
    if (!k || typeof k !== 'object') return null;
    const o = Number(k.o), h = Number(k.h), l = Number(k.l), c = Number(k.c);
    const v = Number(k.v), t = Number(k.t);
    if (![o, h, l, c, v].every(Number.isFinite)) return null;
    if (!(h >= l) || o <= 0 || c <= 0 || l <= 0) return null;
    times.push(Number.isFinite(t) ? t : null);
    opens.push(o); highs.push(h); lows.push(l); closes.push(c); volumes.push(v);
  }
  return { times, opens, highs, lows, closes, volumes };
}

// Mirrors processTokenTF() in index.html, in the same order, so the verdict here
// is the verdict the UI would show for the same candles.
function analyse(symbol, tf, series, anchors) {
  const { times, opens, highs, lows, closes, volumes } = series;
  const price = closes[closes.length - 1];
  const approxOpens = closes.map((c, i) => (i === 0 ? c : closes[i - 1]));

  const srLevels = D.findSRLevels(closes, highs, lows, SR_LOOKBACK);
  const rsi = D.calcRSI(closes, RSI_PERIOD);
  const range = D.detectRange(closes, highs, lows, volumes, approxOpens, tf);
  // Both engines are returned so a consumer can measure them against each other on
  // identical candles. v2 freezes its profile at the pre-expansion candle; v1
  // reprofiles to the current candle on every call.
  const rangeV2 = D.detectRangeV2(closes, highs, lows, volumes, approxOpens, tf);
  // Exact-window profile, when the caller names the two anchors. The author selects
  // P2 by eye on TradingView, so the discovered window is an approximation of a
  // discretionary choice; this path reproduces a specific chart instead.
  const frvp = anchors
    ? D.frvpFromAnchors(highs, lows, volumes, anchors.p1, anchors.p2, anchors.buckets, anchors.valueAreaPct)
    : null;
  const fvgs = D.detectFVGs(closes, highs, lows, approxOpens);
  const squeeze = D.calcBBSqueeze(closes);
  const volStatus = D.classifyVolumeStatus(closes, highs, lows, volumes);

  const threeDrive = D.detect3Drive(closes, highs, lows, rsi, tf, times);
  if (threeDrive && threeDrive.signal !== 'none') {
    threeDrive.volumeSpike = D.checkVolumeSpike(volumes, 1.5, 20, threeDrive.formationIdx);
    threeDrive.lowVolume = D.checkVolumeDrought(volumes, 0.5, 20, threeDrive.formationIdx);
    threeDrive.volumeMismatch = D.checkVolumeMismatch(closes, highs, lows, volumes, 1.5, 20, threeDrive.formationIdx);
    threeDrive.srLevel = D.checkSRConfluence(price, srLevels, SR_CONFLUENCE_THRESHOLD);
  }

  return {
    symbol, tf,
    candles: closes.length,
    lastCandleTime: times[times.length - 1],
    price,
    rsi: rsi && rsi.length ? rsi[rsi.length - 1] : null,
    threeDrive,
    range,
    rangeV2,
    frvp,
    fvg: {
      all: fvgs,
      fresh: fvgs.filter(f => !f.mitigated),
      nearest: D.getFVGNearPrice(fvgs, price),
    },
    squeeze,
    volStatus,
    srLevels,
  };
}

exports.handler = async function (event) {
  const appOrigin = process.env.APP_ORIGIN || '*';
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': appOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, x-signals-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  const fail = (statusCode, error) => ({ statusCode, headers: cors, body: JSON.stringify({ error }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const headers = event.headers || {};
  if (!tokenOk(headers['x-signals-token'], process.env.SIGNALS_TOKEN)) {
    return fail(401, 'Invalid or missing x-signals-token');
  }

  const body = event.body || '';
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return fail(413, 'Payload too large');

  const ip = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown';
  if (rateLimited(ip)) return fail(429, 'Rate limit exceeded');

  let payload;
  try { payload = JSON.parse(body); } catch { return fail(400, 'Body must be valid JSON'); }
  if (!payload || typeof payload !== 'object') return fail(400, 'Body must be a JSON object');

  // One series, or a batch. Both shapes return the same `results` array so a
  // caller never has to branch on which form it sent.
  const requested = Array.isArray(payload.series)
    ? payload.series
    : [{ symbol: payload.symbol, tf: payload.tf, candles: payload.candles }];

  if (!requested.length) return fail(400, 'No series supplied');
  if (requested.length > MAX_SERIES) return fail(400, `At most ${MAX_SERIES} series per request`);

  const results = [];
  for (const item of requested) {
    const symbol = String(item && item.symbol || '').toUpperCase();
    const tf = String(item && item.tf || '');
    const candles = item && item.candles;

    if (!SYMBOL_RE.test(symbol)) { results.push({ symbol, tf, error: 'Invalid symbol' }); continue; }
    if (!VALID_TF.has(tf)) { results.push({ symbol, tf, error: 'Invalid tf' }); continue; }
    if (!Array.isArray(candles)) { results.push({ symbol, tf, error: 'candles must be an array' }); continue; }
    if (candles.length > MAX_CANDLES) { results.push({ symbol, tf, error: `At most ${MAX_CANDLES} candles` }); continue; }
    if (candles.length < MIN_CANDLES) { results.push({ symbol, tf, error: `At least ${MIN_CANDLES} candles required` }); continue; }

    const series = toArrays(candles);
    if (!series) { results.push({ symbol, tf, error: 'Candles contain non-finite or non-positive values' }); continue; }

    // Optional: { anchors: { p1, p2, buckets?, valueAreaPct? } } — bar indices into
    // the candles just supplied. Out-of-range or inverted anchors are rejected rather
    // than clamped, so a caller cannot silently get a profile of the wrong window.
    let anchors = null;
    if (item && item.anchors) {
      const p1 = Number(item.anchors.p1), p2 = Number(item.anchors.p2);
      const ok = Number.isInteger(p1) && Number.isInteger(p2)
        && p1 >= 0 && p2 >= 0 && p1 < candles.length && p2 < candles.length && p1 !== p2;
      if (!ok) { results.push({ symbol, tf, error: 'anchors.p1/p2 must be distinct bar indices within the candles supplied' }); continue; }
      const buckets = item.anchors.buckets === undefined ? undefined : Number(item.anchors.buckets);
      const vaPct = item.anchors.valueAreaPct === undefined ? undefined : Number(item.anchors.valueAreaPct);
      if (buckets !== undefined && !(Number.isInteger(buckets) && buckets >= 2 && buckets <= 1000)) {
        results.push({ symbol, tf, error: 'anchors.buckets must be an integer between 2 and 1000' }); continue;
      }
      if (vaPct !== undefined && !(vaPct > 0 && vaPct <= 1)) {
        results.push({ symbol, tf, error: 'anchors.valueAreaPct must be between 0 and 1' }); continue;
      }
      anchors = { p1, p2, buckets, valueAreaPct: vaPct };
    }

    try {
      results.push(analyse(symbol, tf, series, anchors));
    } catch (e) {
      // One malformed series must not take down a whole batch.
      results.push({ symbol, tf, error: 'Detector failed: ' + (e && e.message ? e.message : 'unknown') });
    }
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      detectorVersion: DETECTOR_VERSION,
      constants: D.DETECTOR_CONSTANTS,
      generatedAt: new Date().toISOString(),
      results,
    }),
  };
};

exports.DETECTOR_VERSION = DETECTOR_VERSION;
