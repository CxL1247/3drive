// Tests for the /signals endpoint.
// Run with:  node test/signals.js       (no dependencies, no build step)

const path = require('path');
const { handler } = require(path.join(__dirname, '..', 'netlify', 'functions', 'signals.js'));
const D = require(path.join(__dirname, '..', 'src', 'detectors.js'));

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name);
  if (!cond) fails++;
};

// The same catalyst-then-oscillation shape used in test/detectors.js.
function buildCandles(after = 20, amp = 8, catPct = 0.12) {
  const c = [];
  for (let i = 0; i < 80; i++) c.push(100 + Math.sin(i / 3) * 0.3);
  const base = c[79];
  for (let i = 0; i < 5; i++) c.push(base * (1 + catPct * (i + 1) / 5));
  const top = c[c.length - 1];
  for (let i = 0; i < after; i++) c.push(top - amp / 2 + Math.sin(i / 2.2) * amp / 2);
  return c.map((close, i) => ({
    t: 1700000000000 + i * 3600000,
    o: i === 0 ? close : c[i - 1],
    h: close + (i >= 80 && i < 85 ? 0.6 : 0.25),
    l: close - (i >= 80 && i < 85 ? 0.6 : 0.25),
    c: close,
    v: (i >= 80 && i < 85 ? 5000 : 1000),
  }));
}

const post = (body, headers = {}) => ({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
const parse = (res) => JSON.parse(res.body);

async function run() {
  const candles = buildCandles();

  console.log('\nmethod + transport');
  check('GET -> 405', (await handler({ httpMethod: 'GET', headers: {} })).statusCode === 405);
  check('OPTIONS -> 204 (preflight)', (await handler({ httpMethod: 'OPTIONS', headers: {} })).statusCode === 204);
  check('invalid JSON -> 400', (await handler({ httpMethod: 'POST', headers: {}, body: '{oops' })).statusCode === 400);
  check('empty object -> 400 (no series)',
    (await handler(post({ series: [] }))).statusCode === 400);
  {
    // Comfortably over the 2 MB cap, and rejected on byte length before any
    // parsing happens — the cap is what stops a huge payload being parsed at all.
    const big = { symbol: 'BTC', tf: 'ONE_HOUR', candles: Array.from({ length: 90000 }, () => ({ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 })) };
    const bigRes = await handler(post(big));
    check('oversized body -> 413', bigRes.statusCode === 413);
    check('oversized body rejected before parsing', JSON.parse(bigRes.body).error === 'Payload too large');
  }

  console.log('\nauth');
  process.env.SIGNALS_TOKEN = 'sekret';
  check('missing token -> 401', (await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }))).statusCode === 401);
  check('wrong token -> 401',
    (await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }, { 'x-signals-token': 'nope' }))).statusCode === 401);
  const auth = { 'x-signals-token': 'sekret' };
  check('correct token -> 200', (await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }, auth))).statusCode === 200);
  delete process.env.SIGNALS_TOKEN;
  check('no token configured -> not required',
    (await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }))).statusCode === 200);

  console.log('\nper-series validation (a bad series must not fail the batch)');
  const bad = await handler(post({
    series: [
      { symbol: 'BTC', tf: 'ONE_HOUR', candles },
      { symbol: 'not a symbol!', tf: 'ONE_HOUR', candles },
      { symbol: 'ETH', tf: 'ONE_MINUTE', candles },
      { symbol: 'SOL', tf: 'ONE_HOUR', candles: 'nope' },
      { symbol: 'ADA', tf: 'ONE_HOUR', candles: candles.slice(0, 5) },
      { symbol: 'XRP', tf: 'ONE_HOUR', candles: candles.map((k, i) => (i === 3 ? { ...k, c: 0 } : k)) },
      { symbol: 'DOT', tf: 'ONE_HOUR', candles: candles.map((k, i) => (i === 3 ? { ...k, h: 'x' } : k)) },
    ],
  }));
  const br = parse(bad).results;
  check('batch still returns 200', bad.statusCode === 200);
  check('good series in a mixed batch still analysed', !br[0].error && br[0].symbol === 'BTC');
  check('invalid symbol rejected', br[1].error === 'Invalid symbol');
  check('invalid timeframe rejected', br[2].error === 'Invalid tf');
  check('non-array candles rejected', br[3].error === 'candles must be an array');
  check('too-few candles rejected', /At least/.test(br[4].error));
  check('zero price rejected rather than coerced', /non-finite or non-positive/.test(br[5].error));
  check('non-numeric field rejected', /non-finite or non-positive/.test(br[6].error));

  console.log('\ndetector output');
  const res = await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }));
  const out = parse(res);
  const r = out.results[0];
  check('detectorVersion is a sha256 hex digest', /^[0-9a-f]{64}$/.test(out.detectorVersion));
  check('constants are echoed for the record', out.constants.VP_BUCKETS === D.VP_BUCKETS);
  check('generatedAt is an ISO timestamp', !Number.isNaN(Date.parse(out.generatedAt)));
  check('candle count reported', r.candles === candles.length);
  check('last candle time is carried through', r.lastCandleTime === candles[candles.length - 1].t);
  check('rsi present', typeof r.rsi === 'number');
  check('range detected for the constructed setup', r.range && r.range.state);
  check('range carries the tradeable lines', r.range.val < r.range.poc && r.range.poc < r.range.vah);
  check('fvg buckets present', r.fvg && Array.isArray(r.fvg.all) && Array.isArray(r.fvg.fresh));
  check('squeeze present', r.squeeze && typeof r.squeeze.squeezing === 'boolean');
  check('sr levels present', Array.isArray(r.srLevels));
  check('threeDrive present', r.threeDrive && typeof r.threeDrive.signal === 'string');
  check('both range engines are reported', 'range' in r && 'rangeV2' in r);
  check('v2 result is either null or tagged as v2', r.rangeV2 === null || r.rangeV2.engine === 'v2');

  // The whole point of the endpoint: it must agree with the library the browser
  // runs. If these ever diverge, the measurement is measuring the wrong thing.
  console.log('\nagreement with the module the browser loads');
  const closes = candles.map(k => k.c);
  const highs = candles.map(k => k.h);
  const lows = candles.map(k => k.l);
  const vols = candles.map(k => k.v);
  const approxOpens = closes.map((c, i) => (i === 0 ? c : closes[i - 1]));
  const direct = D.detectRange(closes, highs, lows, vols, approxOpens, 'ONE_HOUR');
  check('endpoint POC matches a direct library call', r.range.poc === direct.poc);
  check('endpoint VAH matches a direct library call', r.range.vah === direct.vah);
  check('endpoint VAL matches a direct library call', r.range.val === direct.val);
  check('endpoint quality matches a direct library call', r.range.qualityScore === direct.qualityScore);
  check('endpoint RSI matches a direct library call',
    r.rsi === D.calcRSI(closes, 14)[closes.length - 1]);

  console.log('\nexact-anchor FRVP path');
  {
    const withAnchors = parse(await handler(post({
      series: [{ symbol: 'BTC', tf: 'ONE_HOUR', candles, anchors: { p1: 63, p2: 99 } }],
    }))).results[0];
    check('frvp returned when anchors are supplied', withAnchors.frvp !== null);
    check('frvp reports the window it was given',
      withAnchors.frvp.p1Index === 63 && withAnchors.frvp.p2Index === 99);
    check('frvp echoes the row count and value area used',
      withAnchors.frvp.buckets === D.RANGE_V2_BUCKETS &&
      withAnchors.frvp.valueAreaPct === D.RANGE_V2_VALUE_AREA_PCT);
    check('frvp matches a direct library call',
      withAnchors.frvp.vah === D.frvpFromAnchors(highs, lows, vols, 63, 99).vah);
    check('frvp carries the Gann box', withAnchors.frvp.gann.level0 === withAnchors.frvp.vah);

    const noAnchors = parse(await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }))).results[0];
    check('frvp is null when no anchors are supplied', noAnchors.frvp === null);

    const overrides = parse(await handler(post({
      series: [{ symbol: 'BTC', tf: 'ONE_HOUR', candles, anchors: { p1: 63, p2: 99, buckets: 30, valueAreaPct: 0.7 } }],
    }))).results[0];
    check('row count and value area can be overridden per request', overrides.frvp.buckets === 30);

    // Bad anchors must be rejected, not clamped — a clamped window would silently
    // return the profile of a different range than the caller asked for.
    for (const [label, a] of [
      ['out of range', { p1: 0, p2: 99999 }],
      ['negative', { p1: -5, p2: 50 }],
      ['identical', { p1: 40, p2: 40 }],
      ['non-integer', { p1: 1.5, p2: 50 }],
      ['bad bucket count', { p1: 10, p2: 50, buckets: 0 }],
      ['bad value area', { p1: 10, p2: 50, valueAreaPct: 2 }],
    ]) {
      const res = parse(await handler(post({ series: [{ symbol: 'BTC', tf: 'ONE_HOUR', candles, anchors: a }] })));
      check(`anchors rejected: ${label}`, typeof res.results[0].error === 'string');
    }
  }

  console.log('\ndetectorVersion behaviour');
  const again = parse(await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles })));
  check('detectorVersion is stable across requests', again.detectorVersion === out.detectorVersion);
  check('detectorVersion is exported for callers to pin', typeof require(
    path.join(__dirname, '..', 'netlify', 'functions', 'signals.js')).DETECTOR_VERSION === 'string');

  console.log('\nrate limiting');
  const ipHdr = { 'x-nf-client-connection-ip': '203.0.113.55' };
  let got429 = false;
  for (let i = 0; i < 70; i++) {
    const rr = await handler(post({ symbol: 'BTC', tf: 'ONE_HOUR', candles }, ipHdr));
    if (rr.statusCode === 429) { got429 = true; break; }
  }
  check('rate limit engages -> 429', got429);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll signals checks passed.');
  process.exit(fails ? 1 : 0);
}

run();
