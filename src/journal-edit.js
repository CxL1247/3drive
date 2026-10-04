// ─────────────────────────────────────────────────────────────────────────────
// journal-edit.js — the pure logic behind logging and EDITING a journal trade.
//
// Same arrangement as src/detectors.js, so there is ONE copy of this logic:
//   1. the browser — index.html loads this before its inline script; the factory
//                    assigns every export onto the global object (jValidateTradeForm(...)).
//   2. the tests   — test/journal-edit.js require()s this file directly.
//
// Nothing here touches the DOM, network or localStorage. It deliberately contains NO R-multiple
// maths: result and R come from index.html's jCalcBlendedR (which knows about scale-outs), and
// are passed in. This file owns the rules around them:
//   - what a valid trade form is (stop and take profit must sit on the right side of entry)
//   - how an edit is applied to a stored trade without losing scale-outs, stop-loss history, ids
//   - how much the trade would make at its take profit
//   - how to tell that a trade changed underneath an edit (e.g. a scan auto-closed it)
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(root, factory());
})(typeof self !== 'undefined' ? self : globalThis, function () {

function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }
function blank(v) { return v === '' || v === null || v === undefined; }

// ── validation ──
// v: the raw form strings { symbol, dir, entry, sl, tp, exit, funding }.
// Returns { ok, errors: [{ field, msg }], message }. `field` is one of
// symbol | entry | sl | tp | exit | funding, so the UI can mark exactly the inputs at fault;
// `message` is the first error, ready to show.
function jValidateTradeForm(v) {
  var errors = [];
  var long = v.dir !== 'short';
  var entry = num(v.entry), sl = num(v.sl), tp = num(v.tp), exit = num(v.exit);

  if (!v.symbol || blank(v.entry) || blank(v.sl)) {
    if (!v.symbol)     errors.push({ field: 'symbol', msg: 'Token, entry and stop loss are required.' });
    if (blank(v.entry)) errors.push({ field: 'entry',  msg: 'Token, entry and stop loss are required.' });
    if (blank(v.sl))    errors.push({ field: 'sl',     msg: 'Token, entry and stop loss are required.' });
  }
  if (!blank(v.entry) && !(entry > 0)) errors.push({ field: 'entry', msg: 'Entry must be a price above 0.' });
  if (!blank(v.sl)    && !(sl > 0))    errors.push({ field: 'sl',    msg: 'Stop loss must be a price above 0.' });
  if (!blank(v.tp)    && !(tp > 0))    errors.push({ field: 'tp',    msg: 'Take profit must be a price above 0.' });
  if (!blank(v.exit)  && !(exit > 0))  errors.push({ field: 'exit',  msg: 'Exit must be a price above 0.' });
  if (!blank(v.funding) && !isFinite(num(v.funding))) errors.push({ field: 'funding', msg: 'Funding must be a number.' });

  // side checks only make sense once the prices themselves are numbers
  if (entry > 0 && sl > 0) {
    if (long && sl >= entry)  errors.push({ field: 'sl', msg: 'For a long, the stop loss must be below entry.' });
    if (!long && sl <= entry) errors.push({ field: 'sl', msg: 'For a short, the stop loss must be above entry.' });
  }
  if (entry > 0 && tp > 0) {
    if (long && tp <= entry)  errors.push({ field: 'tp', msg: 'For a long, the take profit must be above entry.' });
    if (!long && tp >= entry) errors.push({ field: 'tp', msg: 'For a short, the take profit must be below entry.' });
  }
  return { ok: errors.length === 0, errors: errors, message: errors.length ? errors[0].msg : '' };
}

// ── what the trade makes if its take profit is hit ──
// Same isolated-margin model as jTradePnL in index.html:
//   gross = margin x leverage x price move %, minus a round-trip fee on notional (fee % x 2).
// Funding is excluded (it depends on how long you hold). rr = reward : risk against the stop.
// p: { dir, entry, sl, tp, margin, leverage, feePct }
function jTpPreview(p) {
  var long = p.dir !== 'short';
  var entry = num(p.entry), tp = num(p.tp), sl = num(p.sl);
  var margin = num(p.margin), lev = Math.max(1, num(p.leverage) || 1), feePct = num(p.feePct) || 0;
  if (!(entry > 0) || !(tp > 0)) return { valid: false, reason: 'incomplete' };
  if (long ? tp <= entry : tp >= entry) return { valid: false, reason: 'wrong-side' };
  var pct = Math.abs(tp - entry) / entry;
  var gross = margin * lev * pct;
  var fee = margin * lev * (feePct / 100) * 2;
  var risk = sl > 0 ? (long ? entry - sl : sl - entry) : NaN;
  return {
    valid: true, pct: pct, gross: gross, fee: fee, net: gross - fee,
    rr: risk > 0 ? Math.abs(tp - entry) / risk : null
  };
}

// ── the stop the R-multiple is measured against ──
// jCalcBlendedR uses the FIRST slHistory entry as the original risk unit, so that is the stop an
// edit form must show and change. If the stop was later moved (Adjust SL), trade.sl differs.
function jOriginalSl(t) {
  return (t.slHistory && t.slHistory[0] && !blank(t.slHistory[0].sl)) ? t.slHistory[0].sl : t.sl;
}

// ── a stored trade -> the strings the edit form shows ──
function jTradeToFormValues(t) {
  var orig = jOriginalSl(t);
  var moves = (t.slHistory || []).length - 1;
  return {
    symbol: t.symbol || '', dir: t.dir === 'short' ? 'short' : 'long', tf: t.tf || '1H',
    leverage: Math.max(1, Math.min(100, parseFloat(t.leverage) || 1)),
    entry: blank(t.entry) ? '' : String(t.entry),
    sl: blank(orig) ? '' : String(orig),
    tp: blank(t.tp) ? '' : String(t.tp),
    exit: blank(t.exit) ? '' : String(t.exit),
    funding: (typeof t.funding === 'number' && t.funding !== 0) ? String(t.funding) : '',
    hasFunding: typeof t.funding === 'number' && t.funding !== 0,
    notes: t.notes || '',
    slMoves: moves > 0 ? moves : 0,
    currentSl: (moves > 0 && !blank(t.sl)) ? String(t.sl) : null
  };
}

// ── a fingerprint of the fields an edit can silently disagree with ──
// Taken when the edit starts and compared on save: if a scan auto-closed the trade (or anything
// else changed it) in between, the two differ and the UI asks before overwriting.
function jTradeRev(t) {
  return [t.result, t.exit, t.entry, t.sl, t.tp, t.dir].map(function (x) { return blank(x) ? '' : String(x); }).join('|');
}

// ── apply an edit to a stored trade, in place ──
// vals:    { symbol, dir, tf, leverage(number), entry, sl, tp, exit, funding(number), notes }
// outcome: { result, r } — computed by the caller from the same form values (jCalcBlendedR).
// Keeps id, time, scaleOuts and (if the stop was moved) the stop-loss history; returns what changed.
function jApplyTradeEdit(trade, vals, outcome, nowMs) {
  var before = { dir: trade.dir, entry: String(trade.entry), sl: String(jOriginalSl(trade)),
                 tp: blank(trade.tp) ? '' : String(trade.tp), exit: blank(trade.exit) ? '' : String(trade.exit),
                 result: trade.result };

  trade.symbol = vals.symbol;
  trade.dir = vals.dir;
  trade.tf = vals.tf;
  trade.leverage = vals.leverage;
  trade.entry = vals.entry;
  trade.tp = blank(vals.tp) ? null : vals.tp;
  trade.exit = blank(vals.exit) ? null : vals.exit;
  trade.funding = vals.funding;
  trade.notes = vals.notes;

  // Stop loss: the form edits the ORIGINAL stop (the R denominator). With no later moves that is
  // also the current stop. If it was moved with Adjust SL, the current stop is left where it is.
  var hist = trade.slHistory;
  if (!hist || hist.length <= 1) {
    trade.slHistory = [{ time: (hist && hist[0] && hist[0].time) || new Date(nowMs).toISOString(), sl: vals.sl }];
    trade.sl = vals.sl;
  } else {
    hist[0].sl = vals.sl;
  }

  trade.result = outcome.result;
  trade.r = outcome.r;

  var after = { dir: trade.dir, entry: String(trade.entry), sl: String(vals.sl),
                tp: blank(trade.tp) ? '' : String(trade.tp), exit: blank(trade.exit) ? '' : String(trade.exit),
                result: trade.result };
  var changedCore = Object.keys(before).some(function (k) { return before[k] !== after[k]; });
  var reopened = before.result !== 'open' && trade.result === 'open';

  // A hand-edit of the levels or outcome means the scanner's verdict no longer describes this
  // trade, so its AUTO tag comes off. Untouched levels keep the tag.
  if (changedCore) { trade.autoResolved = false; delete trade.autoResolvedAmbiguous; }
  // A re-opened trade is open from NOW: auto-resolve walks candles since openedAt, and starting
  // from the original open time would instantly re-close it on the very levels it just left.
  if (reopened) { trade.openedAt = nowMs; trade.exit = null; trade.r = null; }

  return { changedCore: changedCore, reopened: reopened };
}

return {
  jValidateTradeForm: jValidateTradeForm,
  jTpPreview: jTpPreview,
  jOriginalSl: jOriginalSl,
  jTradeToFormValues: jTradeToFormValues,
  jTradeRev: jTradeRev,
  jApplyTradeEdit: jApplyTradeEdit
};
});
