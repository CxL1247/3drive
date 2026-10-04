// Tests for src/journal-edit.js — the logic behind logging and editing journal trades.
// Run with:  node test/journal-edit.js       (no dependencies, no network, no DOM)
//
// What this covers: validation (stop / take-profit on the right side of entry), the take-profit
// payoff preview (same margin x leverage x move% model as the journal's P&L), how an edit is
// applied without losing scale-outs / stop history / ids, and detecting that a trade changed
// underneath an edit. What it does NOT cover: the form itself, rendering, and R / result maths
// (those live in index.html and were checked by driving the real page in a browser).

const path = require('path');
const J = require(path.join(__dirname, '..', 'src', 'journal-edit.js'));

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL').padEnd(5), name);
  if (!cond) fails++;
};
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);
const fieldsOf = (res) => res.errors.map(e => e.field);

// ── validation ──
console.log('\njValidateTradeForm');
const good = { symbol: 'BTC', dir: 'long', entry: '100', sl: '95', tp: '110', exit: '', funding: '' };
check('a complete, correctly-sided long is valid', J.jValidateTradeForm(good).ok);
check('TP and exit and funding are optional', J.jValidateTradeForm({ symbol: 'BTC', dir: 'long', entry: '100', sl: '95', tp: '', exit: '', funding: '' }).ok);
check('a correctly-sided short is valid', J.jValidateTradeForm({ symbol: 'DOGE', dir: 'short', entry: '0.00594', sl: '0.00605', tp: '0.005576', exit: '', funding: '' }).ok);

let r = J.jValidateTradeForm({ symbol: '', dir: 'long', entry: '', sl: '', tp: '', exit: '', funding: '' });
check('missing token, entry and stop are all flagged', !r.ok && ['symbol', 'entry', 'sl'].every(f => fieldsOf(r).includes(f)));
check('the required-fields message names all three', /token, entry and stop loss/i.test(r.message));

r = J.jValidateTradeForm(Object.assign({}, good, { sl: '105' }));
check('a long with its stop ABOVE entry is rejected on the stop field', !r.ok && fieldsOf(r).includes('sl') && /below entry/.test(r.message));
r = J.jValidateTradeForm(Object.assign({}, good, { dir: 'short', sl: '95', tp: '90' }));
check('a short with its stop BELOW entry is rejected on the stop field', !r.ok && fieldsOf(r).includes('sl') && /above entry/.test(r.message));
r = J.jValidateTradeForm(Object.assign({}, good, { sl: '100' }));
check('a stop exactly at entry is rejected (zero risk)', !r.ok && fieldsOf(r).includes('sl'));

r = J.jValidateTradeForm(Object.assign({}, good, { tp: '90' }));
check('a long with its take profit BELOW entry is rejected on the TP field', !r.ok && fieldsOf(r).includes('tp') && /above entry/.test(r.message));
r = J.jValidateTradeForm(Object.assign({}, good, { dir: 'short', sl: '105', tp: '110' }));
check('a short with its take profit ABOVE entry is rejected on the TP field', !r.ok && fieldsOf(r).includes('tp') && /below entry/.test(r.message));
r = J.jValidateTradeForm(Object.assign({}, good, { tp: '100' }));
check('a take profit exactly at entry is rejected', !r.ok && fieldsOf(r).includes('tp'));

r = J.jValidateTradeForm(Object.assign({}, good, { entry: 'abc' }));
check('a non-numeric entry is rejected and does not crash the side checks', !r.ok && fieldsOf(r).includes('entry'));
r = J.jValidateTradeForm(Object.assign({}, good, { tp: '-5' }));
check('a negative take profit is rejected', !r.ok && fieldsOf(r).includes('tp'));
r = J.jValidateTradeForm(Object.assign({}, good, { exit: '0' }));
check('an exit of 0 is rejected', !r.ok && fieldsOf(r).includes('exit'));
r = J.jValidateTradeForm(Object.assign({}, good, { funding: 'lots' }));
check('non-numeric funding is rejected', !r.ok && fieldsOf(r).includes('funding'));
r = J.jValidateTradeForm(Object.assign({}, good, { funding: '-0.4' }));
check('negative funding (a payment) is fine', r.ok);
r = J.jValidateTradeForm(Object.assign({}, good, { sl: '105', tp: '90' }));
check('several problems at once are all reported', !r.ok && fieldsOf(r).includes('sl') && fieldsOf(r).includes('tp'));

// ── TP payoff preview ──
console.log('\njTpPreview');
// the BTC trade from the journal screenshot: $300 margin, 14x, 77004.4 -> 80528.7
let p = J.jTpPreview({ dir: 'long', entry: '77004.4', sl: '75200', tp: '80528.7', margin: 300, leverage: 14, feePct: 0.05 });
check('valid preview for a correctly-sided long', p.valid);
check('move % is |tp - entry| / entry', near(p.pct, (80528.7 - 77004.4) / 77004.4, 1e-9));
check('gross is margin x leverage x move (~$192 in the journal example)', near(p.gross, 300 * 14 * p.pct, 1e-6) && Math.abs(p.gross - 192.2) < 0.2);
check('fee is a round trip on notional (0.05% x 2 x $4,200 = $4.20)', near(p.fee, 4.2, 1e-9));
check('net = gross - fee', near(p.net, p.gross - p.fee, 1e-9));
check('reward:risk compares the TP distance with the stop distance', near(p.rr, (80528.7 - 77004.4) / (77004.4 - 75200), 1e-9));

p = J.jTpPreview({ dir: 'short', entry: '0.005940', sl: '0.006050', tp: '0.005576', margin: 300, leverage: 10, feePct: 0.05 });
check('a short is previewed with the move measured downward', p.valid && p.pct > 0 && near(p.pct, (0.005940 - 0.005576) / 0.005940, 1e-9));
p = J.jTpPreview({ dir: 'long', entry: '100', sl: '95', tp: '90', margin: 300, leverage: 10, feePct: 0.05 });
check('a take profit on the wrong side gives no payoff', p.valid === false && p.reason === 'wrong-side');
p = J.jTpPreview({ dir: 'long', entry: '', sl: '95', tp: '110', margin: 300, leverage: 10, feePct: 0.05 });
check('an incomplete form gives no payoff, not NaN', p.valid === false && p.reason === 'incomplete');
p = J.jTpPreview({ dir: 'long', entry: '100', sl: '', tp: '110', margin: 300, leverage: 10, feePct: 0.05 });
check('without a stop the payoff still shows but reward:risk is null', p.valid && p.rr === null);
p = J.jTpPreview({ dir: 'long', entry: '100', sl: '95', tp: '110', margin: 300, leverage: 0, feePct: 0 });
check('leverage below 1 is treated as 1x', near(p.gross, 300 * 1 * 0.1, 1e-9));

// ── trade -> form values ──
console.log('\njTradeToFormValues / jOriginalSl');
const stored = () => ({
  id: 't_1', symbol: 'BTC', dir: 'long', tf: '4H', leverage: 14, entry: '77004.4', sl: '75200', tp: '80528.7', exit: '80528.7',
  result: 'win', r: 1.95, notes: 'clean retest', funding: -0.4, slHistory: [{ time: 'x', sl: '75200' }], scaleOuts: [], openedAt: 1000, time: '09:14', autoResolved: true
});
let v = J.jTradeToFormValues(stored());
check('every field comes back as the string the form shows', v.symbol === 'BTC' && v.entry === '77004.4' && v.sl === '75200' && v.tp === '80528.7' && v.exit === '80528.7' && v.notes === 'clean retest');
check('non-zero funding is carried and flagged so the form can show it', v.funding === '-0.4' && v.hasFunding === true);
check('zero funding is left blank rather than shown as 0', J.jTradeToFormValues(Object.assign(stored(), { funding: 0 })).funding === '' && J.jTradeToFormValues(Object.assign(stored(), { funding: 0 })).hasFunding === false);
check('an older trade with no TP shows a blank TP, not "null"', J.jTradeToFormValues(Object.assign(stored(), { tp: null })).tp === '');
check('an open trade shows a blank exit', J.jTradeToFormValues(Object.assign(stored(), { exit: null, result: 'open' })).exit === '');
const moved = Object.assign(stored(), { sl: '77004.4', slHistory: [{ time: 'x', sl: '75200' }, { time: 'y', sl: '77004.4' }] });
v = J.jTradeToFormValues(moved);
check('the form shows the ORIGINAL stop (what R is measured against), not the moved one', v.sl === '75200' && J.jOriginalSl(moved) === '75200');
check('a moved stop is reported with its count and current level', v.slMoves === 1 && v.currentSl === '77004.4');
check('an unmoved stop reports no moves and no separate current level', J.jTradeToFormValues(stored()).slMoves === 0 && J.jTradeToFormValues(stored()).currentSl === null);
check('a trade with no slHistory (very old data) falls back to its sl', J.jOriginalSl({ sl: '90' }) === '90');
check('leverage is clamped to the slider range', J.jTradeToFormValues(Object.assign(stored(), { leverage: 500 })).leverage === 100 && J.jTradeToFormValues(Object.assign(stored(), { leverage: 'x' })).leverage === 1);

// ── applying an edit ──
console.log('\njApplyTradeEdit');
const NOW = 5000000;
const editVals = (o) => Object.assign({ symbol: 'BTC', dir: 'long', tf: '4H', leverage: 14, entry: '77004.4', sl: '75200', tp: '80528.7', exit: '80528.7', funding: -0.4, notes: 'clean retest' }, o || {});

// 1) a pure notes edit changes nothing that matters
let t = stored();
let res = J.jApplyTradeEdit(t, editVals({ notes: 'new note' }), { result: 'win', r: 1.95 }, NOW);
check('editing only the notes keeps the AUTO tag', t.autoResolved === true && res.changedCore === false);
check('the notes are updated', t.notes === 'new note');
check('id, time, openedAt and scale-outs survive an edit', t.id === 't_1' && t.time === '09:14' && t.openedAt === 1000 && Array.isArray(t.scaleOuts));

// 2) adding a missing TP to an open trade
t = Object.assign(stored(), { tp: null, exit: null, result: 'open', r: null, autoResolved: false });
res = J.jApplyTradeEdit(t, editVals({ tp: '80528.7', exit: '' }), { result: 'open', r: null }, NOW);
check('a TP can be added to an open trade', t.tp === '80528.7' && t.result === 'open');
check('adding a TP counts as a change to the levels', res.changedCore === true);

// 3) clearing the TP stores null, not an empty string
t = stored();
J.jApplyTradeEdit(t, editVals({ tp: '' }), { result: 'win', r: 1.95 }, NOW);
check('a blank TP is stored as null', t.tp === null);

// 4) changing the exit / levels takes the AUTO tag off
t = stored();
res = J.jApplyTradeEdit(t, editVals({ exit: '79000' }), { result: 'win', r: 1.1 }, NOW);
check('changing the exit marks the trade as hand-edited (AUTO tag removed)', t.autoResolved === false && res.changedCore === true);
check('the new result and R from the caller are stored', t.result === 'win' && t.r === 1.1 && t.exit === '79000');
t = Object.assign(stored(), { autoResolvedAmbiguous: true });
J.jApplyTradeEdit(t, editVals({ entry: '77000' }), { result: 'win', r: 2 }, NOW);
check('the "ambiguous" flag is cleared along with the AUTO tag', t.autoResolved === false && !('autoResolvedAmbiguous' in t));

// 5) stop loss: unmoved vs moved
t = stored();
J.jApplyTradeEdit(t, editVals({ sl: '75000' }), { result: 'win', r: 1.7 }, NOW);
check('an unmoved stop updates both the current stop and the original', t.sl === '75000' && t.slHistory.length === 1 && t.slHistory[0].sl === '75000');
check('the original stop keeps its timestamp', t.slHistory[0].time === 'x');
t = Object.assign(stored(), { sl: '77004.4', slHistory: [{ time: 'x', sl: '75200' }, { time: 'y', sl: '77004.4' }] });
J.jApplyTradeEdit(t, editVals({ sl: '75000' }), { result: 'win', r: 1.7 }, NOW);
check('with a moved stop, editing changes the ORIGINAL stop only', t.slHistory[0].sl === '75000' && t.slHistory.length === 2);
check('with a moved stop, the current stop is left where Adjust SL put it', t.sl === '77004.4' && t.slHistory[1].sl === '77004.4');
t = { symbol: 'X', dir: 'long', tf: '1H', entry: '10', sl: '9', result: 'open', r: null };
J.jApplyTradeEdit(t, editVals({ symbol: 'X', entry: '10', sl: '9.5', tp: '', exit: '' }), { result: 'open', r: null }, NOW);
check('a very old trade with no slHistory gets one on edit', t.slHistory.length === 1 && t.slHistory[0].sl === '9.5' && typeof t.slHistory[0].time === 'string');

// 6) re-opening a closed trade
t = stored();
res = J.jApplyTradeEdit(t, editVals({ exit: '' }), { result: 'open', r: null }, NOW);
check('blanking the exit re-opens the trade', t.result === 'open' && t.exit === null && t.r === null && res.reopened === true);
check('a re-opened trade is open from NOW, so auto-resolve does not instantly re-close it', t.openedAt === NOW);
t = Object.assign(stored(), { exit: null, result: 'open', r: null, autoResolved: false });
res = J.jApplyTradeEdit(t, editVals({ exit: '' }), { result: 'open', r: null }, NOW);
check('editing an already-open trade does not reset its open time', t.openedAt === 1000 && res.reopened === false);
t = Object.assign(stored(), { exit: null, result: 'open', r: null, autoResolved: false });
J.jApplyTradeEdit(t, editVals({ exit: '80000' }), { result: 'win', r: 1.6 }, NOW);
check('closing an open trade by giving it an exit works', t.result === 'win' && t.exit === '80000' && t.openedAt === 1000);

// 7) scale-outs are never touched by the form
t = Object.assign(stored(), { scaleOuts: [{ pct: 50, price: 79000, time: 'z' }] });
J.jApplyTradeEdit(t, editVals({ notes: 'n' }), { result: 'win', r: 1.8 }, NOW);
check('scale-outs are preserved exactly', t.scaleOuts.length === 1 && t.scaleOuts[0].pct === 50 && t.scaleOuts[0].price === 79000);

// 8) symbol / direction / timeframe / leverage / funding edits
t = stored();
J.jApplyTradeEdit(t, editVals({ symbol: 'ETH', dir: 'short', tf: '1H', leverage: 5, funding: 0.12, sl: '78000', tp: '75000', exit: '' }), { result: 'open', r: null }, NOW);
check('symbol, direction, timeframe, leverage and funding are all editable', t.symbol === 'ETH' && t.dir === 'short' && t.tf === '1H' && t.leverage === 5 && t.funding === 0.12);

// ── change detection ──
console.log('\njTradeRev');
const a = stored();
check('the same trade has a stable fingerprint', J.jTradeRev(a) === J.jTradeRev(stored()));
check('a scan closing the trade changes the fingerprint', J.jTradeRev(Object.assign(stored(), { result: 'loss', exit: '75200' })) !== J.jTradeRev(a));
check('a changed take profit changes the fingerprint', J.jTradeRev(Object.assign(stored(), { tp: '81000' })) !== J.jTradeRev(a));
check('notes alone do not (an edit is allowed to coexist with that)', J.jTradeRev(Object.assign(stored(), { notes: 'zzz' })) === J.jTradeRev(a));
check('null and blank fields fingerprint the same', J.jTradeRev(Object.assign(stored(), { tp: null })) === J.jTradeRev(Object.assign(stored(), { tp: '' })));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll journal-edit checks passed.');
process.exit(fails ? 1 : 0);
