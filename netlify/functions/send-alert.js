const crypto = require('crypto');

// ── SECURITY NOTES ─────────────────────────────────────────────────────────────
// This endpoint is publicly reachable and a static frontend cannot hold a secret,
// so the primary control is a RECIPIENT ALLOWLIST: even an unauthenticated caller
// can only cause mail to be sent to an address the operator has pre-approved.
// That removes the "arbitrary-victim spam relay" capability entirely. Rate limiting
// caps volume, HTML escaping stops content injection, and an optional shared token
// (ALERT_TOKEN) raises the bar further when the caller can carry one.
//
// Required env:
//   RESEND_API_KEY             — Resend API key (server-side only)
//   ALERT_ALLOWED_RECIPIENTS   — comma-separated allowlist, e.g. "me@example.com"
// Optional env:
//   ALERT_TOKEN                — if set, callers must send header x-alert-token
//   APP_ORIGIN                 — if set, CORS is restricted to this origin
//   ALERT_TV_EXCHANGE          — TradingView chart prefix (default BINANCE)
// ──────────────────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES   = 64 * 1024;
const MAX_ALERTS       = 50;
const RATE_WINDOW_MS   = 60_000;
const RATE_MAX_PER_IP  = 5;

// Best-effort, per-container only (serverless instances are not shared). This is a
// volume brake, not a guarantee — the recipient allowlist is what bounds the damage.
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

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function tokenOk(provided, expected) {
  if (!expected) return true;                       // no token configured → not required
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;          // length check before timingSafeEqual
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  const appOrigin = process.env.APP_ORIGIN || '*';
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': appOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, x-alert-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  const fail = (statusCode, error) => ({ statusCode, headers: cors, body: JSON.stringify({ error }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return fail(500, 'RESEND_API_KEY not set');

  // Fail CLOSED: without an allowlist this endpoint would be an open relay.
  const allowed = (process.env.ALERT_ALLOWED_RECIPIENTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) {
    return fail(503, 'ALERT_ALLOWED_RECIPIENTS is not configured; refusing to send to arbitrary recipients');
  }

  if (!tokenOk(event.headers?.['x-alert-token'], process.env.ALERT_TOKEN)) {
    return fail(401, 'Unauthorized');
  }

  const ip = event.headers?.['x-nf-client-connection-ip']
          || (event.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
          || 'unknown';
  if (rateLimited(ip)) return fail(429, 'Rate limit exceeded');

  const raw = event.body || '';
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return fail(413, 'Payload too large');

  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }

  const { email, alerts, isTest } = body || {};
  if (typeof email !== 'string' || !Array.isArray(alerts) || !alerts.length) {
    return fail(400, 'Missing email or alerts');
  }
  if (!allowed.includes(email.trim().toLowerCase())) {
    return fail(403, 'Recipient not allowed');
  }
  if (alerts.length > MAX_ALERTS) return fail(400, `Too many alerts (max ${MAX_ALERTS})`);

  const tvExchange = (process.env.ALERT_TV_EXCHANGE || 'BINANCE').replace(/[^A-Z0-9]/gi, '').toUpperCase();

  const signalLabel = a => a.type === 'squeeze' ? '◈ BB SQUEEZE'
    : a.type === 'mtf' ? `★ MTF ${a.signal === 'bullish' ? '↑ BULL' : '↓ BEAR'}`
    : a.signal === 'bullish' ? '↑ BULL 3-Drive' : '↓ BEAR 3-Drive';
  const signalColor = a => a.type === 'squeeze' ? '#c070ff' : a.signal === 'bullish' ? '#00c9a0' : '#f04468';
  const tvUrl = (sym, tf) => {
    const i = { '4H': '240', '1H': '60', '30M': '30' };
    const safeSym = String(sym ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 15);
    const key = String(tf ?? '').split('+')[0];
    return `https://www.tradingview.com/chart/?symbol=${tvExchange}:${encodeURIComponent(safeSym)}USDT&interval=${i[key] || '60'}`;
  };

  // Every interpolated field below is escaped or numerically coerced — these values
  // arrive from an unauthenticated caller and must never reach the HTML unescaped.
  const rows = alerts.map(a => {
    const conf = num(a.confidence);
    return `<tr style="border-bottom:1px solid #1a2840">
    <td style="padding:12px 16px"><div style="font-family:monospace;font-size:16px;font-weight:700;color:#d4e2f0">${esc(a.token)}</div><div style="font-family:monospace;font-size:11px;color:#3d5570">${esc(a.price)}</div></td>
    <td style="padding:12px 16px"><span style="font-family:monospace;font-size:13px;font-weight:700;color:${signalColor(a)}">${esc(signalLabel(a))}</span><div style="font-family:monospace;font-size:11px;color:#3d5570">${esc(a.tf)}</div></td>
    <td style="padding:12px 16px;text-align:center"><span style="font-family:monospace;font-size:14px;font-weight:700;color:${conf >= 80 ? '#00c9a0' : conf >= 70 ? '#f0a800' : '#8fa8c0'}">${conf}%</span></td>
    <td style="padding:12px 16px">${a.srLevel ? `<span style="font-family:monospace;font-size:12px;font-weight:700;color:#f06030;background:rgba(240,96,48,0.1);padding:2px 8px;border-radius:4px">◎ ${esc(String(a.srLevel).toUpperCase())}</span>` : '<span style="color:#3d5570">—</span>'}</td>
    <td style="padding:12px 16px"><a href="${tvUrl(a.token, a.tf)}" style="font-family:monospace;font-size:12px;color:#00c8f0;text-decoration:none;background:rgba(0,200,240,0.08);padding:4px 10px;border-radius:4px;border:1px solid rgba(0,200,240,0.25)">chart ↗</a></td>
  </tr>`;
  }).join('');

  const subject = isTest ? '[3Drive Scanner] Test Alert'
    : `[3Drive Scanner] ${alerts.length} signal${alerts.length > 1 ? 's' : ''} detected`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#080c16;font-family:-apple-system,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="font-family:monospace;font-size:11px;color:#3d5570;letter-spacing:3px;margin-bottom:4px">3DRIVE SCANNER</div>
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#d4e2f0">${isTest ? 'Test Alert' : `${alerts.length} Signal${alerts.length > 1 ? 's' : ''} Detected`}</h1>
    <div style="font-family:monospace;font-size:12px;color:#3d5570;margin-bottom:24px">${new Date().toUTCString()}</div>
    <div style="background:#0c1220;border:1px solid #1a2840;border-radius:8px;overflow:hidden;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#060a13;border-bottom:1px solid #1a2840">
          <th style="padding:10px 16px;text-align:left;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">TOKEN</th>
          <th style="padding:10px 16px;text-align:left;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">SIGNAL</th>
          <th style="padding:10px 16px;text-align:center;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">CONF</th>
          <th style="padding:10px 16px;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">S/R</th>
          <th style="padding:10px 16px;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">CHART</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-family:monospace;font-size:11px;color:#3d5570;text-align:center;line-height:2">signals are pattern detections, not financial advice</div>
  </div></body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'onboarding@resend.dev', to: [email], subject, html })
    });
    const data = await res.json();
    if (!res.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: data }) };
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
