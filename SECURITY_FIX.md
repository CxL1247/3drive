# Security fix — alert relay + proxy passthrough

Two issues found by reading the deployed code. Both are remotely exploitable by anyone
who knows the function URLs; neither requires an account. Fixes are in this branch and
covered by `node test/security.js` (24 checks).

⚠️ **This fix fails closed.** `send-alert` will refuse to send until
`ALERT_ALLOWED_RECIPIENTS` is set in the Netlify environment (see step 1 below).
That is deliberate — the previous default was "send to anyone."

---

## 1. `send-alert.js` was an open email relay with HTML injection

**Before:** the handler validated only `httpMethod === 'POST'` and the presence of
`email` + `alerts`, then sent mail via Resend **to whatever address the caller supplied**,
with `Access-Control-Allow-Origin: *`. Caller-controlled fields (`token`, `price`, `tf`,
`confidence`, `srLevel`) were interpolated into the email HTML **unescaped**.

**Impact**
- Anyone could send mail to arbitrary recipients from the project's Resend identity.
- Attacker-controlled HTML/links land in those emails (`<a href>`, `<img onerror>`, `<script>`).
- Function-quota burn, and realistically Resend account suspension for abuse — the
  sending reputation at risk is the repo owner's, not the caller's.

**Repro:** shared privately with the repo owner rather than published here, since the
deployed site is unpatched until this is merged and step 1 below is done. The regression
tests in `test/security.js` exercise the same paths.

**Fix**
- **Recipient allowlist** (`ALERT_ALLOWED_RECIPIENTS`) — the primary control. A static
  frontend cannot hold a secret, so rather than pretend otherwise, the endpoint now only
  sends to pre-approved addresses. Unauthenticated callers can at worst mail the operator.
- **HTML escaping** on every interpolated field; `confidence` numerically coerced.
- **Optional shared token** (`ALERT_TOKEN`) — timing-safe compare, required when set.
- Per-IP rate limit (5/min, best-effort per container), `alerts` capped at 50,
  body capped at 64 KB, `OPTIONS` preflight handled, CORS narrowed to `APP_ORIGIN` when set.
- `tvUrl()` now sanitizes the symbol and takes the exchange from `ALERT_TV_EXCHANGE`
  (default `BINANCE`), since Binance is often the blocked source.

## 2. `proxy.js` `?url=` allowlist was prefix-matched → SSRF

**Before:** `ALLOWED.some(o => url.startsWith(o))`. Prefix matching on an origin is
bypassable, and both of these returned `true` while resolving to an attacker's host:

```
https://api.coingecko.com.evil.com/steal   ← suffix trick
https://api.coingecko.com@evil.com/        ← userinfo trick
```

**Impact:** the function fetches an attacker-chosen URL and returns the response body —
a server-side request forgery proxy. Cloud metadata endpoints
(`http://169.254.169.254/…`) were reachable this way.

**Fix:** parse with `new URL()` and compare `u.origin` against an exact-match `Set`;
reject non-`https:` schemes and any URL carrying userinfo. Verified against both bypasses
plus the metadata endpoint in `test/security.js`.

## 3. Also included (not security)

- **Short-TTL response cache** in `proxy.js` (candles 20 s, orderbook 5 s, tickers 15 s,
  top100 5 min, per warm container). ~100 tokens × 3 timeframes × 4 exchanges per scan,
  repeated per open tab, was re-fetched every cycle; this collapses duplicate work with no
  staleness that matters at 30M/1H/4H. Expect a material drop in exchange rate-limit
  pressure and function invocations.
- **Input validation** on `symbol` (`^[A-Z0-9]{1,15}$`), `tf` (must be a `TF_MAP` key), and
  `market`, all of which were interpolated into exchange URLs after only `.toUpperCase()`.

---

## Required deploy steps

1. **Set `ALERT_ALLOWED_RECIPIENTS`** in Netlify → Site settings → Environment variables,
   e.g. `you@example.com` (comma-separate for several). **Alerts stay disabled until this
   is set.**
2. Optionally set `ALERT_TOKEN` (and have the frontend send it as `x-alert-token`),
   `APP_ORIGIN` (e.g. `https://clinton3drive.netlify.app`), and `ALERT_TV_EXCHANGE`.
3. Verify: `node test/security.js` → expect "All security checks passed."
4. Re-test a real alert from the app after step 1, since the allowlist now gates delivery.

## Not changed

No detection logic, thresholds, or UI were touched — `index.html` is untouched in this
branch, so scanner behaviour and output are identical.
