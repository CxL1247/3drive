// ─────────────────────────────────────────────────────────────────────────────
// detectors.js — the pure indicator + pattern-detection math, extracted verbatim
// from index.html so that three consumers share ONE copy of it:
//
//   1. the browser  — index.html loads this before its inline script; the factory
//                     assigns every export onto the global object, so existing
//                     call sites (calcRSI(...), detectRange(...)) are unchanged.
//   2. the tests    — test/detectors.js require()s this file directly.
//   3. the server   — netlify/functions/signals.js require()s it, so what gets
//                     measured is provably the same code the UI runs.
//
// Nothing here touches the DOM, network, or localStorage. Function bodies are
// byte-identical to what they were in index.html and are deliberately left at
// column 0 (not re-indented) so the extraction diff is trivial to verify.
//
// Sloppy mode on purpose: the original ran without "use strict", and adding it
// could change behaviour. This is a move, not a rewrite.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(root, factory());
})(typeof self !== 'undefined' ? self : globalThis, function () {

// Diagnostics the detectors emit but do not own. In the browser index.html wires
// the real UI logger via setLogger(log); under Node these stay no-ops so the
// detectors can be tested headlessly.
var log = function () {};
function setLogger(fn) { if (typeof fn === 'function') log = fn; }

const BB_PERIOD  = 20;
const BB_STDDEV  = 2;

// ── RSI ──
function calcRSI(closes, period=14) {
  if(closes.length < period+1) return [];
  let gains=[], losses=[];
  for(let i=1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    gains.push(d>0?d:0);
    losses.push(d<0?Math.abs(d):0);
  }
  let avgG=gains.slice(0,period).reduce((a,b)=>a+b)/period;
  let avgL=losses.slice(0,period).reduce((a,b)=>a+b)/period;

  // Pad front with nulls so rsi[i] aligns with closes[i]
  const rsi = new Array(period + 1).fill(null);

  for(let i=period;i<gains.length;i++){
    avgG=(avgG*(period-1)+gains[i])/period;
    avgL=(avgL*(period-1)+losses[i])/period;
    rsi.push(avgL===0?100:100-(100/(1+avgG/avgL)));
  }
  return rsi;
}

// BB Squeeze: John Bollinger BandWidth method
// BandWidth = (Upper - Lower) / Middle × 100
// Squeeze = BandWidth at its LOWEST point in last 125 candles
// This exactly matches what you see visually on TradingView
const BW_LOOKBACK = 125;  // 125-bar lookback — original

function calcBBSqueeze(closes, period=BB_PERIOD, mult=BB_STDDEV) {
  if(closes.length < period + BW_LOOKBACK) {
    return { squeezing:false, strength:0, bw:0, bwMin:0 };
  }
  const bwArr = [];
  for(let i = period-1; i < closes.length; i++){
    const sl = closes.slice(i-period+1, i+1);
    const mean = sl.reduce((a,b)=>a+b,0)/period;
    const sd = Math.sqrt(sl.reduce((a,b)=>a+(b-mean)**2,0)/period);
    bwArr.push(mean>0 ? ((mean+mult*sd)-(mean-mult*sd))/mean*100 : 0);
  }
  const n = bwArr.length;
  const currentBW = bwArr[n-1];
  const window = bwArr.slice(-BW_LOOKBACK);
  const bwMin = Math.min(...window);
  const bwAvg = window.reduce((a,b)=>a+b,0)/window.length;
  // Squeeze = current BW is at or near the 125-bar minimum (bottom 20th percentile)
  const strength = bwAvg>0 ? Math.round(Math.max(0,Math.min(100,(1-currentBW/bwAvg)*100))) : 0;
  const squeezing = currentBW <= bwMin + 0.001 && strength >= 70;
  return { squeezing, strength, bw:Math.round(currentBW*100)/100, bwMin:Math.round(bwMin*100)/100 };
}

function findSwingHighs(arr, win=3) {
  const highs = [];
  for(let i=win; i<arr.length-win; i++){
    let isH = true;
    for(let j=i-win; j<=i+win; j++){
      if(j !== i && arr[j] >= arr[i]){ isH = false; break; }
    }
    if(isH) highs.push({ idx:i, val:arr[i] });
  }
  return highs;
}

function findSwingLows(arr, win=3) {
  const lows = [];
  for(let i=win; i<arr.length-win; i++){
    let isL = true;
    for(let j=i-win; j<=i+win; j++){
      if(j !== i && arr[j] <= arr[i]){ isL = false; break; }
    }
    if(isL) lows.push({ idx:i, val:arr[i] });
  }
  return lows;
}

// Keep findPivots for S/R detection (uses both highs+lows)
function findPivots(arr, win=3) {
  return { highs: findSwingHighs(arr, win), lows: findSwingLows(arr, win) };
}

// Finds the actual correction (pullback) extreme between two drive points —
// needed to verify real Fibonacci extension/retracement proportions between drives,
// not just "some pullback happened." This is what actually distinguishes a genuine
// "Three Drives" harmonic pattern from a head-and-shoulders-like shape: in a real
// 3-Drives, each drive is a ~1.13–1.618 extension of the prior correction, and each
// correction is a ~0.55–0.9 retracement of the prior drive. A H&S-style "huge middle
// spike, tiny final push" shape fails these ratios even though it still has 3 ascending
// (or descending) peaks.
function findExtremeIdx(arr, from, to, findMin) {
  let bestIdx = from, bestVal = arr[from];
  for (let i = from + 1; i <= to; i++) {
    if (findMin ? arr[i] < bestVal : arr[i] > bestVal) { bestVal = arr[i]; bestIdx = i; }
  }
  return { idx: bestIdx, val: bestVal };
}
const FIB_EXT_MIN  = 1.13, FIB_EXT_MAX  = 1.85; // each drive vs the prior correction
const FIB_RETR_MIN = 0.55, FIB_RETR_MAX = 0.90; // each correction vs the prior drive

// ── 4H TREND CONTEXT ──
// A lower-timeframe reversal signal that fights a strong 4H trend has a well-documented
// tendency to fail more often — more capital and momentum sit on the trend side. This gives
// each 1H/30M signal a simple "does this agree with or fight the higher timeframe" read.
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) ema.push(closes[i] * k + ema[i-1] * (1-k));
  return ema;
}
const TREND_EMA_PERIOD = 50;
const TREND_SLOPE_MIN  = 0.004; // ~0.4% EMA move over the lookback to call it a real trend, not noise
function get4HTrend(closes4h) {
  if (!closes4h || closes4h.length < TREND_EMA_PERIOD + 10) return 'neutral';
  const ema = calcEMA(closes4h, TREND_EMA_PERIOD);
  const now  = ema[ema.length - 1];
  const past = ema[Math.max(0, ema.length - 11)]; // ~10 candles (40h) ago
  const slope = (now - past) / past;
  const price = closes4h[closes4h.length - 1];
  if (slope > TREND_SLOPE_MIN && price > now) return 'up';
  if (slope < -TREND_SLOPE_MIN && price < now) return 'down';
  return 'neutral';
}

// TF-aware pivot window and recency gate
const TF_PIVOT_WIN  = {'SIX_HOUR':5,'ONE_HOUR':4,'THIRTY_MINUTE':3};
const TF_RECENCY    = {'SIX_HOUR':8,'ONE_HOUR':12,'THIRTY_MINUTE':18};
// Max candles allowed between drives — was a flat 20 for every timeframe, which meant "20
// candles" silently meant wildly different real-world durations (10h on 30M vs ~3.3 days on
// 4H). A real PUMPUSDT 4H pattern needed 42 and 30 candles between its drives (5-7 real days)
// and was silently rejected before ever reaching the Fibonacci or RSI checks — confirmed by
// hand-computing the actual candle gaps against the old flat limit. Scaled per timeframe now,
// same pattern as TF_PIVOT_WIN/TF_RECENCY above.
const TF_MAX_GAP    = {'SIX_HOUR':50,'ONE_HOUR':30,'THIRTY_MINUTE':20};

function checkVolumeSpike(volumes,multiplier=1.5,lookback=20,atIdx=null){
  if(!volumes||volumes.length<lookback+1) return false;
  // Default to the latest candle if no specific index given (e.g. for live/no-pattern checks)
  const idx = atIdx!=null ? atIdx : volumes.length-1;
  if(idx < lookback) return false;
  const recent=volumes.slice(idx-lookback, idx);
  const avg=recent.reduce((a,b)=>a+b,0)/recent.length;
  return avg>0&&volumes[idx]>=avg*multiplier;
}

// Thin/low volume — the mirror of checkVolumeSpike. A signal formed on unusually quiet volume
// is thinner evidence: fewer real participants agreeing with the move, easier for a small
// order to swing price, similar in spirit to the weekend liquidity flag.
function checkVolumeDrought(volumes,threshold=0.5,lookback=20,atIdx=null){
  if(!volumes||volumes.length<lookback+1) return false;
  const idx = atIdx!=null ? atIdx : volumes.length-1;
  if(idx < lookback) return false;
  const recent=volumes.slice(idx-lookback, idx);
  const avg=recent.reduce((a,b)=>a+b,0)/recent.length;
  return avg>0&&volumes[idx]<=avg*threshold;
}

// Volume/price mismatch — a HEURISTIC proxy for possible wash-trading or artificial volume,
// not a confirmed detection. Real wash-trading detection needs order-book or wallet-level
// data this scanner doesn't have access to. What IS detectable from candles alone: volume
// that's elevated while price barely moved is the classic signature — genuine organic
// buying/selling tends to actually move price, so a big-volume, small-range candle is worth
// flagging as questionable rather than trusting at face value.
function checkVolumeMismatch(closes,highs,lows,volumes,multiplier=1.5,lookback=20,atIdx=null){
  if(!volumes||volumes.length<lookback+1||!highs||!lows||!closes) return false;
  const idx = atIdx!=null ? atIdx : volumes.length-1;
  if(idx < lookback) return false;
  const recentVol = volumes.slice(idx-lookback, idx);
  const avgVol = recentVol.reduce((a,b)=>a+b,0)/recentVol.length;
  if(!(avgVol>0) || volumes[idx] < avgVol*multiplier) return false; // only relevant when volume IS elevated

  // Typical range-per-volume for recent candles, vs this candle's range-per-volume
  const rangePct = i => closes[i]>0 ? (highs[i]-lows[i])/closes[i] : 0;
  const recentRangePerVol = recentVol.map((v,j) => v>0 ? rangePct(idx-lookback+j)/v : 0).filter(x=>x>0);
  if(!recentRangePerVol.length) return false;
  const avgRangePerVol = recentRangePerVol.reduce((a,b)=>a+b,0)/recentRangePerVol.length;
  const thisRangePerVol = volumes[idx]>0 ? rangePct(idx)/volumes[idx] : 0;

  // This candle moved the price far less per unit of volume than is typical — elevated
  // volume, disproportionately small range
  return avgRangePerVol>0 && thisRangePerVol <= avgRangePerVol*0.35;
}

// Single classification, independent of any 3-Drive pattern — for "what's this token's
// volume doing right now" on its own terms, not just when a signal happens to form there.
// Reuses the exact same thresholds as checkVolumeDrought/checkVolumeMismatch above, just
// exposed as a standalone status rather than a boolean tied to a signal.
function classifyVolumeStatus(closes,highs,lows,volumes,lookback=20,atIdx=null){
  if(!volumes||volumes.length<lookback+1||!closes) return null;
  const idx = atIdx!=null ? atIdx : volumes.length-1;
  if(idx < lookback) return null;
  const recent = volumes.slice(idx-lookback, idx);
  const avg = recent.reduce((a,b)=>a+b,0)/recent.length;
  if(!(avg>0)) return null;
  const ratio = volumes[idx]/avg;

  if(ratio <= 0.5) return 'low';
  if(ratio >= 1.5){
    if(checkVolumeMismatch(closes,highs,lows,volumes,1.5,lookback,idx)) return 'mismatch';
    return 'elevated'; // genuinely active, price moved proportionally — not suspicious
  }
  return 'normal';
}

function timeSym(p1, p2, p3){
  const gap1 = p2.idx - p1.idx;
  const gap2 = p3.idx - p2.idx;
  if(gap1 <= 0 || gap2 <= 0) return 0;
  const ratio = Math.min(gap1,gap2) / Math.max(gap1,gap2);
  return Math.round(ratio * 10);
}

function detect3Drive(closes, highs, lows, rsiArr, tfKey='ONE_HOUR', times=null) {
  if(!closes || closes.length < 50 || !rsiArr || rsiArr.length < 30) return { signal:'none', confidence:0 };

  const win    = TF_PIVOT_WIN[tfKey] || 3;
  const maxAge = TF_RECENCY[tfKey]   || 14;
  const MIN_GAP     = 8;   // min candles between drives — 4 was a no-op: with win=3, the pivot
                            // algorithm can't produce swing highs less than 4 apart anyway, so
                            // that floor never actually rejected anything. 8 is a real minimum.
  const MAX_GAP     = TF_MAX_GAP[tfKey] || 20;  // max candles between drives — now timeframe-aware
  const MIN_PULLBACK = 0.008; // 0.8% visible pullback between drives

  // ── BEARISH: 3 swing highs (HH,HH,HH) + RSI lower at each high (LH,LH,LH) ──
  const priceHighs = findSwingHighs(highs || closes, win);
  if(priceHighs.length >= 3){
    const candidates = priceHighs.slice(-9);
    for(let i = 0; i <= candidates.length - 3; i++){
      const [d1, d2, d3] = [candidates[i], candidates[i+1], candidates[i+2]];

      if(closes.length - 1 - d3.idx > maxAge) continue;

      // Strictly higher highs — check this FIRST so we can count/log genuine 3-point
      // structures that get rejected purely on spacing, which previously vanished with no
      // diagnostic trace at all (rejected before the funnel counter or near-miss log ever saw them).
      if(d2.val <= d1.val) continue;
      if(d3.val <= d2.val) continue;

      _driveFunnel.rawTriples = (_driveFunnel.rawTriples||0) + 1;

      // Spacing — now timeframe-aware (see TF_MAX_GAP above)
      const gap12 = d2.idx - d1.idx;
      const gap23 = d3.idx - d2.idx;
      if(gap12 < MIN_GAP || gap12 > MAX_GAP || gap23 < MIN_GAP || gap23 > MAX_GAP){
        log(`Near-miss [${tfKey}]: real 3-point ascending structure, rejected on spacing — gap1=${gap12} candles, gap2=${gap23} candles (allowed ${MIN_GAP}-${MAX_GAP})`, 'warn');
        continue;
      }

      _driveFunnel.candidates++; // a real 3-point candidate worth evaluating further

      // Visible pullback between drives (absolute floor, to avoid noise-level corrections)
      const priceLowSlice = (lows || closes);
      const pb12 = (d2.val - Math.min(...priceLowSlice.slice(d1.idx, d2.idx+1))) / d2.val;
      const pb23 = (d3.val - Math.min(...priceLowSlice.slice(d2.idx, d3.idx+1))) / d3.val;
      if(pb12 < MIN_PULLBACK) continue;
      if(pb23 < MIN_PULLBACK) continue;

      _driveFunnel.passedGapPullback++;

      // Fibonacci proportionality — the actual defining feature of a real "Three Drives"
      // pattern, and what rules out head-and-shoulders-like shapes (huge middle spike,
      // tiny final push) that would otherwise pass the simple "each high is higher" check above.
      const c1 = findExtremeIdx(priceLowSlice, d1.idx, d2.idx, true);
      const c2 = findExtremeIdx(priceLowSlice, d2.idx, d3.idx, true);
      const corr1  = d1.val - c1.val;
      const drive2 = d2.val - c1.val;
      const corr2  = d2.val - c2.val;
      const drive3 = d3.val - c2.val;
      if(corr1 <= 0 || corr2 <= 0 || drive2 <= 0 || drive3 <= 0) continue;
      const ext1  = drive2 / corr1;  // Drive 2 should extend Correction 1
      const retr2 = corr2 / drive2;  // Correction 2 should retrace Drive 2
      const ext2  = drive3 / corr2;  // Drive 3 should extend Correction 2
      if(ext1 < FIB_EXT_MIN || ext1 > FIB_EXT_MAX) continue;
      if(retr2 < FIB_RETR_MIN || retr2 > FIB_RETR_MAX) continue;
      if(ext2 < FIB_EXT_MIN || ext2 > FIB_EXT_MAX) continue;

      _driveFunnel.passedFib++;

      // RSI at EXACT price pivot candles — strictly lower at each high
      const rsi1 = rsiArr[d1.idx];
      const rsi2 = rsiArr[d2.idx];
      const rsi3 = rsiArr[d3.idx];
      if(!rsi1 || !rsi2 || !rsi3) continue;
      if(rsi2 >= rsi1 || rsi3 >= rsi2 || (rsi1 - rsi3) < 7 || rsi1 < 55){
        // Passed the hard part (real structure + real Fibonacci proportions) but died on RSI —
        // log exactly which condition failed, since this is rare enough not to spam the console
        // and precious enough (a structurally real 3-Drives) to know why it didn't qualify.
        const reasons = [];
        if(rsi2 >= rsi1) reasons.push('RSI not lower at drive 2');
        if(rsi3 >= rsi2) reasons.push('RSI not lower at drive 3');
        if((rsi1 - rsi3) < 7) reasons.push(`divergence only ${(rsi1-rsi3).toFixed(1)}pts (need 7+)`);
        if(rsi1 < 55) reasons.push(`drive 1 RSI only ${rsi1.toFixed(1)} (need 55+)`);
        log(`Near-miss [${tfKey}]: real 3-Drives structure, RSI ${rsi1.toFixed(1)}→${rsi2.toFixed(1)}→${rsi3.toFixed(1)} — rejected: ${reasons.join(', ')}`, 'warn');
        continue;
      }

      _driveFunnel.passedRSI++;

      const priceMove = (d3.val - d1.val) / d1.val * 100;
      const rsiDiv    = rsi1 - rsi3;
      const symScore  = timeSym(d1, d2, d3);
      const conf      = Math.min(95, 40 + Math.min(rsiDiv*2.5,30) + Math.min(priceMove*3,20) + symScore);

      return { signal:'bearish', confidence:Math.round(conf), detectedAt:Date.now(),
               formationIdx: d3.idx, formationPrice: closes[d3.idx], formationTime: (times && times[d3.idx]) || Date.now(),
               drives:[d1,d2,d3], rsiAtDrives:[rsi1,rsi2,rsi3] };
    }
  }

  // ── BULLISH: 3 swing lows (LL,LL,LL) + RSI higher at each low (HL,HL,HL) ──
  const priceLows = findSwingLows(lows || closes, win);
  if(priceLows.length >= 3){
    const candidates = priceLows.slice(-9);
    for(let i = 0; i <= candidates.length - 3; i++){
      const [d1, d2, d3] = [candidates[i], candidates[i+1], candidates[i+2]];

      if(closes.length - 1 - d3.idx > maxAge) continue;

      const gap12 = d2.idx - d1.idx;
      const gap23 = d3.idx - d2.idx;
      if(gap12 < MIN_GAP || gap12 > MAX_GAP) continue;
      if(gap23 < MIN_GAP || gap23 > MAX_GAP) continue;

      // Strictly lower lows
      if(d2.val >= d1.val) continue;
      if(d3.val >= d2.val) continue;

      _driveFunnel.candidates++;

      // Visible bounce between drives (absolute floor, to avoid noise-level corrections)
      const priceHighSlice = (highs || closes);
      const bn12 = (Math.max(...priceHighSlice.slice(d1.idx, d2.idx+1)) - d2.val) / d2.val;
      const bn23 = (Math.max(...priceHighSlice.slice(d2.idx, d3.idx+1)) - d3.val) / d3.val;
      if(bn12 < MIN_PULLBACK) continue;
      if(bn23 < MIN_PULLBACK) continue;

      _driveFunnel.passedGapPullback++;

      // Fibonacci proportionality — same check as the bearish case, mirrored: each drive
      // (down-leg) should be a ~1.13–1.618 extension of the prior bounce, each bounce a
      // ~0.55–0.9 retracement of the prior drive. Rules out head-and-shoulders-like shapes.
      const c1 = findExtremeIdx(priceHighSlice, d1.idx, d2.idx, false);
      const c2 = findExtremeIdx(priceHighSlice, d2.idx, d3.idx, false);
      const corr1  = c1.val - d1.val;
      const drive2 = c1.val - d2.val;
      const corr2  = c2.val - d2.val;
      const drive3 = c2.val - d3.val;
      if(corr1 <= 0 || corr2 <= 0 || drive2 <= 0 || drive3 <= 0) continue;
      const ext1  = drive2 / corr1;  // Drive 2 should extend Correction 1
      const retr2 = corr2 / drive2;  // Correction 2 should retrace Drive 2
      const ext2  = drive3 / corr2;  // Drive 3 should extend Correction 2
      if(ext1 < FIB_EXT_MIN || ext1 > FIB_EXT_MAX) continue;
      if(retr2 < FIB_RETR_MIN || retr2 > FIB_RETR_MAX) continue;
      if(ext2 < FIB_EXT_MIN || ext2 > FIB_EXT_MAX) continue;

      _driveFunnel.passedFib++;

      // RSI at EXACT pivot candles — strictly higher at each low
      const rsi1 = rsiArr[d1.idx];
      const rsi2 = rsiArr[d2.idx];
      const rsi3 = rsiArr[d3.idx];
      if(!rsi1 || !rsi2 || !rsi3) continue;
      if(rsi2 <= rsi1 || rsi3 <= rsi2 || (rsi3 - rsi1) < 7 || rsi1 > 45){
        const reasons = [];
        if(rsi2 <= rsi1) reasons.push('RSI not higher at drive 2');
        if(rsi3 <= rsi2) reasons.push('RSI not higher at drive 3');
        if((rsi3 - rsi1) < 7) reasons.push(`divergence only ${(rsi3-rsi1).toFixed(1)}pts (need 7+)`);
        if(rsi1 > 45) reasons.push(`drive 1 RSI only ${rsi1.toFixed(1)} (need ≤45)`);
        log(`Near-miss [${tfKey}]: real 3-Drives structure, RSI ${rsi1.toFixed(1)}→${rsi2.toFixed(1)}→${rsi3.toFixed(1)} — rejected: ${reasons.join(', ')}`, 'warn');
        continue;
      }

      _driveFunnel.passedRSI++;

      const priceDrop = (d1.val - d3.val) / d1.val * 100;
      const rsiDiv    = rsi3 - rsi1;
      const symScore  = timeSym(d1, d2, d3);
      const conf      = Math.min(95, 40 + Math.min(rsiDiv*2.5,30) + Math.min(priceDrop*3,20) + symScore);

      return { signal:'bullish', confidence:Math.round(conf), detectedAt:Date.now(),
               formationIdx: d3.idx, formationPrice: closes[d3.idx], formationTime: (times && times[d3.idx]) || Date.now(),
               drives:[d1,d2,d3], rsiAtDrives:[rsi1,rsi2,rsi3] };
    }
  }

  return { signal:'none', confidence:0 };
}

let _driveFunnel = { candidates:0, passedGapPullback:0, passedFib:0, passedRSI:0 };

const FVG_LOOKBACK   = 50;   // scan last 50 candles for FVGs
const FVG_MIN_GAP    = 0.002; // gap must be ≥0.2% of price to matter
const FVG_MAX_AGE    = 40;   // ignore FVGs older than 40 candles
const FVG_PROX_PCT   = 0.015; // flag FVG when price within 1.5% of the zone
const FVG_MIN_QUALITY = 50;  // only keep grade A/B (quality>=50) — grade C is mostly noise
                              // (tested empirically: ~96% of raw detected FVGs are grade C)

function detectFVGs(closes, highs, lows, opens) {
  if(!closes || closes.length < FVG_LOOKBACK + 3) return [];
  const len = closes.length;
  const approxOpens = opens || closes.map((c,i) => i===0 ? c : closes[i-1]);
  const fvgs = [];

  const start = Math.max(1, len - FVG_LOOKBACK);

  for(let i = start; i < len - 1; i++){
    const c1h = highs[i-1],   c1l = lows[i-1];
    const c2o = approxOpens[i], c2c = closes[i], c2h = highs[i], c2l = lows[i];
    const c3h = highs[i+1],   c3l = lows[i+1];
    const age = len - 1 - i; // candles since this FVG formed

    if(age > FVG_MAX_AGE) continue;

    // ── Bullish FVG: gap between c1 high and c3 low ──
    if(c3l > c1h){
      const gapTop    = c3l;
      const gapBottom = c1h;
      const gapPct    = (gapTop - gapBottom) / gapBottom;
      if(gapPct < FVG_MIN_GAP) continue;

      // Displacement: middle candle should be strongly bullish (big green body)
      const bodySize  = (c2c - c2o) / c2o;
      const wickRatio = c2h > c2l ? (Math.abs(c2c - c2o)) / (c2h - c2l) : 0;
      if(bodySize < 0.001) continue; // must be a green candle

      // Mitigation check: has price closed inside the gap?
      const futureLows = lows.slice(i+2);
      const futureCloses = closes.slice(i+2);
      // Mitigated if any future candle LOW entered the gap AND closed inside or below it
      const mitigated = futureLows.some((l, idx) =>
        l <= gapTop && futureCloses[idx] >= gapBottom && futureCloses[idx] <= gapTop
      );

      // Displacement score 0-100
      const dispScore = Math.min(100, Math.round(bodySize * 500 + wickRatio * 30));
      // Gap score 0-100
      const gapScore  = Math.min(100, Math.round(gapPct * 2000));
      // Freshness score — newer = better
      const freshScore = Math.round((1 - age / FVG_MAX_AGE) * 100);
      const quality   = Math.round(dispScore * 0.4 + gapScore * 0.35 + freshScore * 0.25);

      fvgs.push({
        type: 'bullish', gapTop, gapBottom,
        gapPct, quality, age, mitigated,
        midpoint: (gapTop + gapBottom) / 2
      });
    }

    // ── Bearish FVG: gap between c3 high and c1 low ──
    if(c1l > c3h){
      const gapTop    = c1l;
      const gapBottom = c3h;
      const gapPct    = (gapTop - gapBottom) / gapBottom;
      if(gapPct < FVG_MIN_GAP) continue;

      const bodySize  = (c2o - c2c) / c2o; // bearish = open > close
      const wickRatio = c2h > c2l ? (Math.abs(c2c - c2o)) / (c2h - c2l) : 0;
      if(bodySize < 0.001) continue; // must be a red candle

      // Mitigated if any future candle HIGH entered the gap AND closed inside or above it
      const futureHighs2 = highs.slice(i+2);
      const futureCloses2 = closes.slice(i+2);
      const mitigated = futureHighs2.some((h, idx) =>
        h >= gapBottom && futureCloses2[idx] >= gapBottom && futureCloses2[idx] <= gapTop
      );

      const dispScore  = Math.min(100, Math.round(bodySize * 500 + wickRatio * 30));
      const gapScore   = Math.min(100, Math.round(gapPct * 2000));
      const freshScore = Math.round((1 - age / FVG_MAX_AGE) * 100);
      const quality    = Math.round(dispScore * 0.4 + gapScore * 0.35 + freshScore * 0.25);

      fvgs.push({
        type: 'bearish', gapTop, gapBottom,
        gapPct, quality, age, mitigated,
        midpoint: (gapTop + gapBottom) / 2
      });
    }
  }

  // Only keep grade A/B — grade C is mostly noise (weak displacement, tiny gap, or stale)
  // and would otherwise still count toward the confidence boost and badges.
  return fvgs
    .filter(f => f.quality >= FVG_MIN_QUALITY)
    .sort((a,b) => b.quality - a.quality)
    .slice(0, 5);
}

function getFVGNearPrice(fvgs, currentPrice) {
  // Find the highest-quality unfilled FVG that price is approaching or inside
  if(!fvgs || !fvgs.length) return null;
  const fresh = fvgs.filter(f => !f.mitigated);
  if(!fresh.length) return null;

  for(const fvg of fresh){
    const distToTop    = Math.abs(currentPrice - fvg.gapTop)    / fvg.gapTop;
    const distToBottom = Math.abs(currentPrice - fvg.gapBottom) / fvg.gapBottom;
    const inside       = currentPrice >= fvg.gapBottom && currentPrice <= fvg.gapTop;
    const approaching  = Math.min(distToTop, distToBottom) <= FVG_PROX_PCT;

    if(inside || approaching) return { ...fvg, inside, approaching };
  }
  return null;
}

// Returns array of clustered S/R zones: { price, type, touches, lastIdx }
// Raw pivots alone are noisy — a 100-candle window on typical crypto volatility throws off
// dozens of them, and treating every single one as its own "level" makes confluence nearly
// meaningless (tested: a totally random price matches ~94% of the time with the old approach).
// Real S/R only means something if price has reacted near that zone more than once, so this
// clusters nearby pivots together and requires a minimum touch count before a zone counts.
const SR_CLUSTER_PCT  = 0.004; // pivots within 0.4% of each other are treated as the same zone
const SR_MIN_TOUCHES  = 3;     // require at least 3 reactions before a zone counts as real S/R

function findSRLevels(closes, highs, lows, lookback=100) {
  const slice_h = highs.slice(-lookback);
  const slice_l = lows.slice(-lookback);
  const n = slice_h.length;

  // Raw pivots, tagged with how recently (in candle index) each occurred
  const rawPivots = [];
  for(let i=3; i<n-3; i++){
    const isSwingH = slice_h[i] === Math.max(...slice_h.slice(i-3,i+4));
    const isSwingL = slice_l[i] === Math.min(...slice_l.slice(i-3,i+4));
    if(isSwingH) rawPivots.push({ price: slice_h[i], type:'resistance', idx:i });
    if(isSwingL) rawPivots.push({ price: slice_l[i], type:'support', idx:i });
  }
  if(!rawPivots.length) return [];

  // Cluster: sort by price, then greedily group pivots within SR_CLUSTER_PCT of the
  // running cluster average. Mixed support/resistance pivots can share a zone — a level
  // that's flipped from resistance to support (or vice versa) over time is still one real zone.
  rawPivots.sort((a,b) => a.price - b.price);
  const clusters = [];
  rawPivots.forEach(p => {
    const last = clusters[clusters.length-1];
    if(last && Math.abs(p.price - last.avgPrice) / last.avgPrice <= SR_CLUSTER_PCT){
      last.members.push(p);
      last.avgPrice = last.members.reduce((s,m)=>s+m.price,0) / last.members.length;
    } else {
      clusters.push({ avgPrice: p.price, members: [p] });
    }
  });

  // Convert clusters to zones — require min touches, use the most recent pivot's type
  // (so a zone reflects its current role, not whichever direction happened first),
  // and track recency for weighting elsewhere.
  return clusters
    .filter(c => c.members.length >= SR_MIN_TOUCHES)
    .map(c => {
      const mostRecent = c.members.reduce((a,b) => b.idx > a.idx ? b : a);
      return {
        price:   c.avgPrice,
        type:    mostRecent.type,
        touches: c.members.length,
        lastIdx: mostRecent.idx,
        recency: mostRecent.idx / (n - 1) // 0 (oldest) to 1 (most recent candle in window)
      };
    })
    .sort((a,b) => b.touches - a.touches || b.recency - a.recency);
}

// Check if a price is within threshold% of a real (multi-touch) S/R zone.
// Prefers the strongest match — most touches, then most recent — rather than the first
// one encountered, so confidence boosts reflect genuinely significant levels.
function checkSRConfluence(drive3Price, srLevels, threshold=0.008) {
  const matches = srLevels.filter(lvl => Math.abs(drive3Price - lvl.price) / lvl.price <= threshold);
  if(!matches.length) return null;
  const best = matches.sort((a,b) => b.touches - a.touches || b.recency - a.recency)[0];
  return best.type; // 'support' or 'resistance'
}

// ── MULTI-TF CONFLUENCE ──
// Returns { tfs: ['4H','1H'], signal: 'bullish'|'bearish' } or null
function checkMTFConfluence(token) {
  const tfs = ['SIX_HOUR','ONE_HOUR','THIRTY_MINUTE'];
  const tfLabel = {'SIX_HOUR':'4H','ONE_HOUR':'1H','THIRTY_MINUTE':'30M'};
  const bullTFs = tfs.filter(tf => token.patterns[tf]?.signal === 'bullish');
  const bearTFs = tfs.filter(tf => token.patterns[tf]?.signal === 'bearish');
  if(bullTFs.length >= 2) return { tfs: bullTFs.map(t=>tfLabel[t]), signal:'bullish' };
  if(bearTFs.length >= 2) return { tfs: bearTFs.map(t=>tfLabel[t]), signal:'bearish' };
  return null;
}

// ── FIXED RANGE VOLUME PROFILE — anchored at the swing pivot ──
// Mirrors the way this is actually traded on TradingView: find a strong impulsive
// move ("way mover"), anchor the profile at the exact swing pivot candle (the
// swing HIGH for an up-move, the swing LOW for a down-move) — not the start of
// the search window — then build the volume profile from that pivot through to
// the current candle. VAH/VAL (not raw high/low) are the two tradeable lines;
// a deviation above VAH or below VAL, in either direction, is the signal.
const CATALYST_MIN_PCT   = 0.025; // catalyst move must be ≥2.5% (absolute floor)
const CATALYST_MAX_CANDLES = 6;   // catalyst completes within 6 candles
const CATALYST_BASELINE_LOOKBACK = 20;  // candles before the window used as this token's own "normal" baseline
const CATALYST_ATR_MULT  = 4.0;   // move must be 4x the token's own recent avg candle range, not just a flat %
const CATALYST_VOL_MULT  = 1.5;   // move must carry 1.5x the token's own recent avg volume — real conviction, not a thin wick
const RANGE_MIN_QUALITY  = 65;    // 0-100 composite score floor — B-grade and up only. C (50-64) cleared the bar but was the noisiest tier in practice.
const RANGE_MIN_CANDLES  = 12;    // need at least 12 candles of oscillation after the pivot
const RANGE_MAX_CANDLES  = 60;    // stale after 60 candles
const RANGE_MIN_WIDTH    = 0.03;  // structural box must be ≥3% wide
const RANGE_MAX_WIDTH    = 0.18;  // structural box must be ≤18% wide
const FULL_SWING_MIN     = 2;     // price must make at least 2 full swings (top→bot or bot→top)
const DEV_THRESHOLD      = 0.015; // 1.5%+ outside VAH/VAL = deviation
const VALUE_AREA_PCT     = 0.70;  // standard 70% value area
const VP_BUCKETS         = 30;    // price buckets for the volume profile
const RANGE_ENABLED_TFS  = new Set(["SIX_HOUR", "ONE_HOUR", "THIRTY_MINUTE"]); // SIX_HOUR key = 4H candles

// Bins volume-at-price across [fromIdx..toIdx] by spreading each candle's volume
// uniformly across the price levels it touched (high→low) — the standard
// approximation used when only OHLCV is available, not tick-level data. Returns
// the Point of Control (highest-volume price) and the Value Area High/Low
// (the tightest price band containing VALUE_AREA_PCT of total volume, expanded
// outward from POC one bucket at a time toward whichever side has more volume).
function computeVolumeProfile(highs, lows, volumes, fromIdx, toIdx){
  const priceMax = Math.max(...highs.slice(fromIdx, toIdx+1));
  const priceMin = Math.min(...lows.slice(fromIdx, toIdx+1));
  if(!(priceMax > priceMin)) return null;

  const bucketSize = (priceMax - priceMin) / VP_BUCKETS;
  const vol = new Array(VP_BUCKETS).fill(0);
  const bucketLow  = j => priceMin + j*bucketSize;
  const bucketHigh = j => priceMin + (j+1)*bucketSize;

  for(let i=fromIdx; i<=toIdx; i++){
    const h = highs[i], l = lows[i], v = volumes[i] || 0;
    if(!(v>0)) continue;
    if(h === l){
      const j = Math.min(VP_BUCKETS-1, Math.max(0, Math.floor((h-priceMin)/bucketSize)));
      vol[j] += v;
      continue;
    }
    const jLo = Math.max(0, Math.floor((l-priceMin)/bucketSize));
    const jHi = Math.min(VP_BUCKETS-1, Math.floor((h-priceMin)/bucketSize));
    for(let j=jLo; j<=jHi; j++){
      const overlap = Math.min(h, bucketHigh(j)) - Math.max(l, bucketLow(j));
      if(overlap > 0) vol[j] += v * (overlap/(h-l));
    }
  }

  const total = vol.reduce((a,b)=>a+b,0);
  if(!(total>0)) return null;

  let pocIdx = 0;
  for(let j=1;j<VP_BUCKETS;j++) if(vol[j]>vol[pocIdx]) pocIdx=j;

  let lowIdx = pocIdx, highIdx = pocIdx, cum = vol[pocIdx];
  const target = total * VALUE_AREA_PCT;
  while(cum < target && (lowIdx>0 || highIdx<VP_BUCKETS-1)){
    const nextLowVol  = lowIdx>0 ? vol[lowIdx-1] : -1;
    const nextHighVol = highIdx<VP_BUCKETS-1 ? vol[highIdx+1] : -1;
    if(nextHighVol >= nextLowVol){ highIdx++; cum += vol[highIdx]; }
    else { lowIdx--; cum += vol[lowIdx]; }
  }

  return {
    poc: bucketLow(pocIdx) + bucketSize/2,
    vah: bucketHigh(highIdx),
    val: bucketLow(lowIdx),
  };
}

function detectRange(closes, highs, lows, volumes, opens, tfKey) {
  if(!RANGE_ENABLED_TFS.has(tfKey)) return null;
  if(!closes || closes.length < CATALYST_MAX_CANDLES + RANGE_MIN_CANDLES + 5) return null;
  if(!volumes || volumes.length !== closes.length) return null; // volume profile needs real per-candle volume

  const len = closes.length;
  const approxOpens = opens || closes.map((c,i) => i===0 ? c : closes[i-1]);

  // ── Step 1: Find a catalyst move, then pinpoint the exact swing pivot candle ──
  const searchBack = Math.min(RANGE_MAX_CANDLES + CATALYST_MAX_CANDLES + 5, len - RANGE_MIN_CANDLES);
  let catalyst = null;

  for(let i = RANGE_MIN_CANDLES; i <= searchBack; i++){
    const endIdx   = len - 1 - i;
    const startIdx = Math.max(0, endIdx - CATALYST_MAX_CANDLES);

    // This token's own recent "normal" behavior — used to tell a genuine impulsive
    // move apart from that same token's ordinary noise. A flat % threshold treats a
    // calm major and a wild micro-cap identically, which is what let noise through
    // in the first place: on a volatile alt, 2.5% within 6 candles is just chop.
    const baselineStart = Math.max(0, startIdx - CATALYST_BASELINE_LOOKBACK);
    if(baselineStart >= startIdx) continue;
    let baseRangeSum = 0, baseVolSum = 0, baseCount = 0;
    for(let k=baselineStart; k<startIdx; k++){
      baseRangeSum += (highs[k]-lows[k]) / lows[k];
      baseVolSum += volumes[k] || 0;
      baseCount++;
    }
    if(baseCount < 5) continue;
    const baseAvgRangePct = baseRangeSum / baseCount;
    const baseAvgVol = baseVolSum / baseCount;

    const moveHigh = Math.max(...highs.slice(startIdx, endIdx + 1));
    const moveLow  = Math.min(...lows.slice(startIdx, endIdx + 1));
    const movePct  = (moveHigh - moveLow) / moveLow;
    const requiredMovePct = Math.max(CATALYST_MIN_PCT, baseAvgRangePct * CATALYST_ATR_MULT);
    if(movePct < requiredMovePct) continue;

    // Require real trading behind the move, not just a wick off a thin order book.
    if(!(baseAvgVol > 0)) continue;
    const windowVol = volumes.slice(startIdx, endIdx+1);
    const windowAvgVol = windowVol.reduce((a,b)=>a+(b||0),0) / windowVol.length;
    if(windowAvgVol < baseAvgVol * CATALYST_VOL_MULT) continue;

    const closeMove = (closes[endIdx] - closes[startIdx]) / closes[startIdx];
    const direction = closeMove >= 0 ? 'up' : 'down';

    // Anchor = the swing pivot itself, not the window boundary: swing HIGH for an
    // up-move (profile builds from the top of the move), swing LOW for a down-move.
    let anchorIdx = startIdx;
    if(direction === 'up'){
      for(let k=startIdx; k<=endIdx; k++) if(highs[k] > highs[anchorIdx]) anchorIdx = k;
    } else {
      for(let k=startIdx; k<=endIdx; k++) if(lows[k] < lows[anchorIdx]) anchorIdx = k;
    }

    const candlesAfter = len - 1 - anchorIdx;
    if(candlesAfter < RANGE_MIN_CANDLES) continue;
    if(candlesAfter > RANGE_MAX_CANDLES) continue;

    catalyst = { direction, movePct, anchorIdx, candlesAfter, requiredMovePct, windowAvgVol, baseAvgVol };
    break;
  }

  if(!catalyst) return null;

  // ── Step 2: Structural box — full high/low extent from the pivot to now ──
  // This gates whether the pattern is still alive/valid at all. The tradeable
  // lines (VAH/VAL) are derived separately below, from actual volume, and are
  // deliberately tighter than this box.
  const postH = highs.slice(catalyst.anchorIdx);
  const postL = lows.slice(catalyst.anchorIdx);
  const postC = closes.slice(catalyst.anchorIdx);
  const postO = approxOpens.slice(catalyst.anchorIdx);

  const rangeHigh = Math.max(...postH);
  const rangeLow  = Math.min(...postL);
  const rangeWidth = (rangeHigh - rangeLow) / rangeLow;
  if(rangeWidth < RANGE_MIN_WIDTH || rangeWidth > RANGE_MAX_WIDTH) return null;

  // ── Step 3: Build the volume profile from the pivot to now ──
  const vp = computeVolumeProfile(highs, lows, volumes, catalyst.anchorIdx, len-1);
  if(!vp) return null;
  const { poc, vah, val } = vp;
  const midpoint = (vah + val) / 2;

  // ── Step 4: Oscillation — price should be making full swings between VAH and VAL ──
  const topZone    = vah - (vah-val) * 0.15;
  const bottomZone = val + (vah-val) * 0.15;
  let swings = 0, lastZone = null;
  for(let i=0; i<postH.length; i++){
    if(postH[i] >= topZone && lastZone !== 'top'){ swings++; lastZone = 'top'; }
    else if(postL[i] <= bottomZone && lastZone !== 'bot'){ swings++; lastZone = 'bot'; }
  }
  if(swings < FULL_SWING_MIN * 2) return null;

  // ── Step 5: Quality score — how strong is this specific setup, not just "does it qualify" ──
  // Built entirely from signal strength already computed above, no new data needed:
  //  - catalyst strength: how far past the required bar did the move actually go
  //  - volume strength: how far past the required volume bar did it go
  //  - value-area tightness: how concentrated is volume around POC vs. the full box (tighter = cleaner consensus)
  //  - freshness: younger ranges (closer to their catalyst) score higher than near-stale ones
  //  - swing count: more confirmed swings = more tested, more trustworthy
  const catalystStrength = Math.max(0, Math.min(100, 50 + (catalyst.movePct / catalyst.requiredMovePct - 1) * 50));
  const volumeStrength   = Math.max(0, Math.min(100, 50 + (catalyst.windowAvgVol / (catalyst.baseAvgVol * CATALYST_VOL_MULT) - 1) * 50));
  const tightness         = 1 - (vah - val) / (rangeHigh - rangeLow);
  const tightnessScore   = Math.max(0, Math.min(100, tightness * 100));
  const freshnessScore   = Math.max(0, Math.min(100, 100 - (catalyst.candlesAfter / RANGE_MAX_CANDLES) * 100));
  const swingScore       = Math.max(0, Math.min(100, (swings / (FULL_SWING_MIN * 4)) * 100));

  const qualityScore = Math.round(
    catalystStrength * 0.25 +
    volumeStrength   * 0.25 +
    tightnessScore   * 0.25 +
    freshnessScore   * 0.15 +
    swingScore        * 0.10
  );
  if(qualityScore < RANGE_MIN_QUALITY) return null; // marginal setup — not worth surfacing

  const grade = qualityScore >= 80 ? 'A' : 'B'; // C used to exist (50-64) but the gate above now excludes it entirely

  // ── Step 6: Containment against the structural box (not VAH/VAL — that's expected to be pierced) ──
  let bodyBreaks = 0;
  for(let i=0; i<postC.length; i++){
    const bH = Math.max(postO[i], postC[i]);
    const bL = Math.min(postO[i], postC[i]);
    if(bL > rangeHigh || bH < rangeLow) bodyBreaks++;
  }
  if(bodyBreaks / postC.length > 0.30) return null;

  // ── Step 7: Still active? Last 5 closes shouldn't be decisively broken out ──
  const last5 = postC.slice(-5);
  if(last5.every(c => c > rangeHigh * 1.02)) return null;
  if(last5.every(c => c < rangeLow  * 0.98)) return null;

  // ── Step 8: Deviation check, symmetric both directions, gated on VAH/VAL ──
  const currentClose = closes[len - 1];
  const prevClose    = closes[len - 2];
  const prevOpen     = approxOpens[len - 2];
  const devAbovePct  = (currentClose - vah) / vah;
  const devBelowPct  = (val - currentClose) / val;
  const prevBodyHigh = Math.max(prevOpen, prevClose);
  const prevBodyLow  = Math.min(prevOpen, prevClose);
  const nowInside    = currentClose <= vah && currentClose >= val;
  const nearTop    = currentClose >= topZone    && currentClose <= vah;
  const nearBottom = currentClose <= bottomZone && currentClose >= val;

  const meta = {
    rangeHigh, rangeLow, rangePct: rangeWidth, // structural box, for context/tooltip only
    poc, vah, val, midpoint,                   // the actual tradeable lines
    catalystDir: catalyst.direction,
    catalystPct: (catalyst.movePct * 100).toFixed(1),
    swings, candlesInRange: catalyst.candlesAfter,
    qualityScore, grade                        // how strong this specific setup is, not just "does it qualify"
  };

  if(prevBodyHigh > vah * (1 + DEV_THRESHOLD) && nowInside) return { state:"confirmed-down", ...meta };
  if(prevBodyLow  < val * (1 - DEV_THRESHOLD) && nowInside) return { state:"confirmed-up",   ...meta };
  if(devAbovePct >= DEV_THRESHOLD) return { state:"dev-above", ...meta, deviationPct:(devAbovePct*100).toFixed(1) };
  if(devBelowPct >= DEV_THRESHOLD) return { state:"dev-below", ...meta, deviationPct:(devBelowPct*100).toFixed(1) };
  if(nearTop)    return { state:"near-top",    ...meta };
  if(nearBottom) return { state:"near-bottom", ...meta };
  return { state:"ranging", ...meta };
}

// _driveFunnel is reset and read by index.html's scan loop. It is reassigned
// wholesale on reset, so it is exposed through accessors rather than as a value
// export — a copied reference would silently stop tracking after the first reset.
function resetDriveFunnel() {
  _driveFunnel = { candidates:0, passedGapPullback:0, passedFib:0, passedRSI:0 };
}
function getDriveFunnel() { return _driveFunnel; }

var DETECTOR_CONSTANTS = Object.freeze({
  BB_PERIOD: BB_PERIOD,
  BB_STDDEV: BB_STDDEV,
  BW_LOOKBACK: BW_LOOKBACK,
  CATALYST_ATR_MULT: CATALYST_ATR_MULT,
  CATALYST_BASELINE_LOOKBACK: CATALYST_BASELINE_LOOKBACK,
  CATALYST_MAX_CANDLES: CATALYST_MAX_CANDLES,
  CATALYST_MIN_PCT: CATALYST_MIN_PCT,
  CATALYST_VOL_MULT: CATALYST_VOL_MULT,
  DEV_THRESHOLD: DEV_THRESHOLD,
  FIB_EXT_MIN: FIB_EXT_MIN,
  FIB_RETR_MIN: FIB_RETR_MIN,
  FULL_SWING_MIN: FULL_SWING_MIN,
  FVG_LOOKBACK: FVG_LOOKBACK,
  FVG_MAX_AGE: FVG_MAX_AGE,
  FVG_MIN_GAP: FVG_MIN_GAP,
  FVG_MIN_QUALITY: FVG_MIN_QUALITY,
  FVG_PROX_PCT: FVG_PROX_PCT,
  RANGE_ENABLED_TFS: RANGE_ENABLED_TFS,
  RANGE_MAX_CANDLES: RANGE_MAX_CANDLES,
  RANGE_MAX_WIDTH: RANGE_MAX_WIDTH,
  RANGE_MIN_CANDLES: RANGE_MIN_CANDLES,
  RANGE_MIN_QUALITY: RANGE_MIN_QUALITY,
  RANGE_MIN_WIDTH: RANGE_MIN_WIDTH,
  SR_CLUSTER_PCT: SR_CLUSTER_PCT,
  SR_MIN_TOUCHES: SR_MIN_TOUCHES,
  TF_MAX_GAP: TF_MAX_GAP,
  TF_PIVOT_WIN: TF_PIVOT_WIN,
  TF_RECENCY: TF_RECENCY,
  TREND_EMA_PERIOD: TREND_EMA_PERIOD,
  TREND_SLOPE_MIN: TREND_SLOPE_MIN,
  VALUE_AREA_PCT: VALUE_AREA_PCT,
  VP_BUCKETS: VP_BUCKETS
});

return {
  calcRSI: calcRSI,
  calcBBSqueeze: calcBBSqueeze,
  findSwingHighs: findSwingHighs,
  findSwingLows: findSwingLows,
  findPivots: findPivots,
  findExtremeIdx: findExtremeIdx,
  calcEMA: calcEMA,
  get4HTrend: get4HTrend,
  checkVolumeSpike: checkVolumeSpike,
  checkVolumeDrought: checkVolumeDrought,
  checkVolumeMismatch: checkVolumeMismatch,
  classifyVolumeStatus: classifyVolumeStatus,
  timeSym: timeSym,
  detect3Drive: detect3Drive,
  detectFVGs: detectFVGs,
  getFVGNearPrice: getFVGNearPrice,
  findSRLevels: findSRLevels,
  checkSRConfluence: checkSRConfluence,
  checkMTFConfluence: checkMTFConfluence,
  computeVolumeProfile: computeVolumeProfile,
  detectRange: detectRange,
  // constants, exported individually as well so the global surface that existed
  // before the extraction is preserved exactly and no call site can break
  BB_PERIOD: BB_PERIOD,
  BB_STDDEV: BB_STDDEV,
  BW_LOOKBACK: BW_LOOKBACK,
  CATALYST_ATR_MULT: CATALYST_ATR_MULT,
  CATALYST_BASELINE_LOOKBACK: CATALYST_BASELINE_LOOKBACK,
  CATALYST_MAX_CANDLES: CATALYST_MAX_CANDLES,
  CATALYST_MIN_PCT: CATALYST_MIN_PCT,
  CATALYST_VOL_MULT: CATALYST_VOL_MULT,
  DEV_THRESHOLD: DEV_THRESHOLD,
  FIB_EXT_MIN: FIB_EXT_MIN,
  FIB_RETR_MIN: FIB_RETR_MIN,
  FULL_SWING_MIN: FULL_SWING_MIN,
  FVG_LOOKBACK: FVG_LOOKBACK,
  FVG_MAX_AGE: FVG_MAX_AGE,
  FVG_MIN_GAP: FVG_MIN_GAP,
  FVG_MIN_QUALITY: FVG_MIN_QUALITY,
  FVG_PROX_PCT: FVG_PROX_PCT,
  RANGE_ENABLED_TFS: RANGE_ENABLED_TFS,
  RANGE_MAX_CANDLES: RANGE_MAX_CANDLES,
  RANGE_MAX_WIDTH: RANGE_MAX_WIDTH,
  RANGE_MIN_CANDLES: RANGE_MIN_CANDLES,
  RANGE_MIN_QUALITY: RANGE_MIN_QUALITY,
  RANGE_MIN_WIDTH: RANGE_MIN_WIDTH,
  SR_CLUSTER_PCT: SR_CLUSTER_PCT,
  SR_MIN_TOUCHES: SR_MIN_TOUCHES,
  TF_MAX_GAP: TF_MAX_GAP,
  TF_PIVOT_WIN: TF_PIVOT_WIN,
  TF_RECENCY: TF_RECENCY,
  TREND_EMA_PERIOD: TREND_EMA_PERIOD,
  TREND_SLOPE_MIN: TREND_SLOPE_MIN,
  VALUE_AREA_PCT: VALUE_AREA_PCT,
  VP_BUCKETS: VP_BUCKETS,
  DETECTOR_CONSTANTS: DETECTOR_CONSTANTS,
  setLogger: setLogger,
  resetDriveFunnel: resetDriveFunnel,
  getDriveFunnel: getDriveFunnel
};
});
