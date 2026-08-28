// Security regression tests for the Netlify Functions.
// Run with:  node test/security.js      (no dependencies, no build step)
//
// Covers the two vulnerabilities fixed in this branch:
//   1. send-alert.js was an open email relay with HTML injection
//   2. proxy.js ?url= allowlist was prefix-matched and therefore SSRF-bypassable

const path = require('path');
const fs = require('fs');

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name);
  if (!cond) fails++;
};

// ── 1. proxy.js passthrough allowlist ─────────────────────────────────────────
function ssrfTests() {
  console.log('\nproxy.js — ?url= passthrough allowlist');
  const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'proxy.js'), 'utf8');
  const originsBlock = src.match(/const ALLOWED_ORIGINS[\s\S]*?\n\]\);\n/);
  const fnBlock = src.match(/function passthroughAllowed[\s\S]*?\n}\n/);
  if (!originsBlock || !fnBlock) { check('could extract allowlist + validator from proxy.js', false); return; }

  // Evaluate the real allowlist + validator from source in an isolated scope,
  // so this test always exercises the shipped code rather than a copy.
  const passthroughAllowed = new Function(
    originsBlock[0] + fnBlock[0] + '\nreturn passthroughAllowed;'
  )();

  const cases = [
    ['https://api.coingecko.com/api/v3/ping', true, 'legitimate allowlisted origin'],
    ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', true, 'legitimate calendar origin'],
    ['https://api.coingecko.com.evil.com/steal', false, 'suffix trick (defeats prefix matching)'],
    ['https://api.coingecko.com@evil.com/', false, 'userinfo trick (defeats prefix matching)'],
    ['http://api.coingecko.com/x', false, 'plain http downgrade'],
    ['http://169.254.169.254/latest/meta-data/', false, 'cloud metadata endpoint'],
    ['https://evil.com/', false, 'unrelated origin'],
    ['file:///etc/passwd', false, 'non-http scheme'],
    ['not-a-url', false, 'unparseable input'],
  ];
  for (const [url, want, label] of cases) {
    check(`${label} -> ${want ? 'allowed' : 'blocked'}`, passthroughAllowed(url) === want);
  }
}

// ── 2. send-alert.js hardening ────────────────────────────────────────────────
async function alertTests() {
  console.log('\nsend-alert.js — relay + injection hardening');
  const { handler } = require(path.join(__dirname, '..', 'netlify', 'functions', 'send-alert.js'));

  let sent = null;
  global.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'test' }) }; };

  const post = (body, headers = {}) => ({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
  const hostile = {
    email: 'me@example.com',
    alerts: [{
      token: '<img src=x onerror=alert(1)>',
      price: '<b>0</b>',
      tf: '"><script>steal()</script>',
      confidence: '99; DROP',
      signal: 'bullish',
      srLevel: '<a href="https://evil.com">click</a>',
    }],
  };

  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.ALERT_ALLOWED_RECIPIENTS;
  delete process.env.ALERT_TOKEN;

  check('no allowlist configured -> 503 (fails closed)', (await handler(post(hostile))).statusCode === 503);

  process.env.ALERT_ALLOWED_RECIPIENTS = 'me@example.com';
  check('arbitrary recipient -> 403 (relay closed)',
    (await handler(post({ ...hostile, email: 'victim@elsewhere.com' }))).statusCode === 403);
  check('GET -> 405', (await handler({ httpMethod: 'GET', headers: {} })).statusCode === 405);
  check('OPTIONS -> 204 (preflight)', (await handler({ httpMethod: 'OPTIONS', headers: {} })).statusCode === 204);

  process.env.ALERT_TOKEN = 'sekret';
  check('missing token -> 401', (await handler(post(hostile))).statusCode === 401);
  check('wrong token -> 401', (await handler(post(hostile, { 'x-alert-token': 'nope' }))).statusCode === 401);

  const ok = await handler(post(hostile, { 'x-alert-token': 'sekret' }));
  check('valid request -> 200', ok.statusCode === 200);

  const html = (sent && sent.html) || '';
  check('no unescaped <script> in email body', !html.includes('<script>steal()'));
  check('no unescaped <img tag in email body', !html.includes('<img'));
  check('no injected <a href in email body', !html.includes('<a href="https://evil.com"'));
  check('payload present but escaped', html.includes('&lt;img src=x'));
  check('non-numeric confidence coerced to a number', /">0%<\/span>/.test(html));

  const many = { email: 'me@example.com', alerts: Array.from({ length: 51 }, () => ({ token: 'A', signal: 'bullish' })) };
  check('too many alerts -> 400', (await handler(post(many, { 'x-alert-token': 'sekret' }))).statusCode === 400);

  const big = { email: 'me@example.com', alerts: [{ token: 'A'.repeat(70000), signal: 'bullish' }] };
  check('oversized body -> 413', (await handler(post(big, { 'x-alert-token': 'sekret' }))).statusCode === 413);

  const ipHdr = { 'x-alert-token': 'sekret', 'x-nf-client-connection-ip': '203.0.113.9' };
  let got429 = false;
  for (let i = 0; i < 8; i++) {
    if ((await handler(post(hostile, ipHdr))).statusCode === 429) got429 = true;
  }
  check('rate limit engages -> 429', got429);
}

(async () => {
  ssrfTests();
  await alertTests();
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll security checks passed.');
  process.exit(fails ? 1 : 0);
})();
