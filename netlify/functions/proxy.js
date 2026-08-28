const https = require('https');
const http  = require('http');

// ── SERVER-SIDE FETCH — short timeout, never blocks ──
function fetchUrl(url, ms=5000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: '', errCode: e.code || e.message })); // never reject — resolve with empty
    req.setTimeout(ms, () => { req.destroy(); resolve({ status: 0, body: '', errCode: 'TIMEOUT' }); });
  });
}

async function tryFetch(url, label='') {
  const r = await fetchUrl(url, 5000);
  const ok = r.status >= 200 && r.status < 300 && r.body;
  // DEBUG: remove once diagnosed — logs status/len per exchange so we can see who's actually failing
  console.log(`[fetch] ${label || url} -> status=${r.status} len=${r.body?.length || 0}${r.errCode ? ' errCode='+r.errCode : ''}`);
  if (ok) {
    try { return JSON.parse(r.body); } catch(e) { console.log(`[fetch] ${label || url} -> JSON parse failed`); return null; }
  }
  return null;
}

// ── TRUE RACE — returns as soon as first valid result arrives, cancels the rest ──
async function raceExchanges(requests) {
  return new Promise((resolve) => {
    let settled = false;
    let pending = requests.length;

    requests.forEach(({ url, parse, label }) => {
      tryFetch(url, label).then(data => {
        pending--;
        if (!settled) {
          const result = data ? parse(data) : null;
          if (result) {
            settled = true;
            console.log(`[race] winner=${label}`);
            resolve(result);
          } else if (pending === 0) {
            console.log('[race] all sources failed');
            resolve(null); // all failed
          }
        }
      }).catch(() => {
        pending--;
        if (!settled && pending === 0) resolve(null);
      });
    });
  });
}

// ── CANDLE FETCHERS ──
const TF_MAP = {
  SIX_HOUR:      { ku:'4hour', okx:'4H',  bin:'4h',  bybit:'240' },
  ONE_HOUR:      { ku:'1hour', okx:'1H',  bin:'1h',  bybit:'60'  },
  THIRTY_MINUTE: { ku:'30min', okx:'30m', bin:'30m', bybit:'30'  },
  FIFTEEN_MINUTE:{ ku:'15min', okx:'15m', bin:'15m', bybit:'15'  },
};

function parseKuCandles(d) {
  const c = d?.data;
  if (!Array.isArray(c) || c.length < 40) return null;
  const r = [...c].reverse();
  // KuCoin candle time is in SECONDS — normalize to ms like the other three exchanges
  return { closes:r.map(x=>+x[2]), highs:r.map(x=>+x[3]), lows:r.map(x=>+x[4]), volumes:r.map(x=>+x[5]), times:r.map(x=>+x[0]*1000), source:'kucoin' };
}
function parseOkxCandles(d) {
  const c = d?.data;
  if (!Array.isArray(c) || c.length < 40) return null;
  const r = [...c].reverse();
  return { closes:r.map(x=>+x[4]), highs:r.map(x=>+x[2]), lows:r.map(x=>+x[3]), volumes:r.map(x=>+x[5]), times:r.map(x=>+x[0]), source:'okx' };
}
function parseBinCandles(d) {
  if (!Array.isArray(d) || d.length < 40) return null;
  return { closes:d.map(x=>+x[4]), highs:d.map(x=>+x[2]), lows:d.map(x=>+x[3]), volumes:d.map(x=>+x[5]), times:d.map(x=>+x[0]), source:'binance' };
}
function parseBybitCandles(d) {
  const c = d?.result?.list;
  if (!Array.isArray(c) || c.length < 40) return null;
  const r = [...c].reverse();
  return { closes:r.map(x=>+x[4]), highs:r.map(x=>+x[2]), lows:r.map(x=>+x[3]), volumes:r.map(x=>+x[5]), times:r.map(x=>+x[0]), source:'bybit' };
}

async function fetchCandles(symbol, tfKey) {
  const tf = TF_MAP[tfKey] || TF_MAP['ONE_HOUR'];
  return raceExchanges([
    { label:'binance', url:`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${tf.bin}&limit=300`, parse:parseBinCandles },
    { label:'bybit',   url:`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}USDT&interval=${tf.bybit}&limit=300`, parse:parseBybitCandles },
    { label:'kucoin',  url:`https://api.kucoin.com/api/v1/market/candles?type=${tf.ku}&symbol=${symbol}-USDT&limit=300`, parse:parseKuCandles },
    { label:'okx',     url:`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=${tf.okx}&limit=300`, parse:parseOkxCandles },
  ]);
}

// ── PERPETUAL FUTURES CANDLE FETCHERS ──
// For trading perps specifically rather than spot — same pattern/RSI/volume detection
// pipeline, fed the actual market being traded instead of a proxy for it. OKX reuses its
// spot candles endpoint with a different instId suffix (identical response shape, confirmed
// via OKX's own docs — same /market/candles endpoint serves SWAP instruments). KuCoin
// Futures is a genuinely separate API: different domain, different symbol convention, and
// requires an explicit from/to window instead of a simple limit param.
const FUT_TF_MAP = {
  SIX_HOUR:      { ku:240, okx:'4H'  }, // KuCoin Futures granularity is in MINUTES, not a label
  ONE_HOUR:      { ku:60,  okx:'1H'  },
  THIRTY_MINUTE: { ku:30,  okx:'30m' },
  FIFTEEN_MINUTE:{ ku:15,  okx:'15m' },
};
// KuCoin Futures uses legacy tickers for a handful of symbols — BTC is the notable one (XBT)
const KU_FUTURES_SYMBOL_MAP = { BTC: 'XBT' };

function parseOkxSwapCandles(d) {
  return parseOkxCandles(d); // identical response shape to spot, just a different instId fed in
}
function parseKuFuturesCandles(d) {
  const c = d?.data;
  if (!Array.isArray(c) || c.length < 40) return null;
  const r = [...c].reverse();
  // NOTE: implemented as [time_ms, open, close, high, low, volume, turnover], mirroring
  // KuCoin's spot field order — time is already in MILLISECONDS here (spot candles use
  // seconds). Flagged for a live spot-check against real Netlify logs after deploy, same as
  // every other exchange integration in this file — see the [fetch]/[race] debug logging below.
  return { closes:r.map(x=>+x[2]), highs:r.map(x=>+x[3]), lows:r.map(x=>+x[4]), volumes:r.map(x=>+x[5]), times:r.map(x=>+x[0]), source:'kucoin-futures' };
}

async function fetchPerpCandles(symbol, tfKey) {
  const tf = FUT_TF_MAP[tfKey] || FUT_TF_MAP['ONE_HOUR'];
  const kuSymbol = (KU_FUTURES_SYMBOL_MAP[symbol] || symbol) + 'USDTM';
  const now = Date.now();
  const windowMs = tf.ku * 60 * 1000 * 300; // ~300 candles of history
  return raceExchanges([
    { label:'okx-swap',       url:`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT-SWAP&bar=${tf.okx}&limit=300`, parse:parseOkxSwapCandles },
    { label:'kucoin-futures', url:`https://api-futures.kucoin.com/api/v1/kline/query?symbol=${kuSymbol}&granularity=${tf.ku}&from=${now-windowMs}&to=${now}`, parse:parseKuFuturesCandles },
  ]);
}

// ── ORDER BOOK DEPTH FETCHERS ──
// Returns raw bid/ask levels — [price, size] pairs, bids sorted highest-first,
// asks sorted lowest-first (each exchange already returns them that way; not
// re-sorted here, matching this file's general policy of light-touch parsing
// and letting the client own all derived logic, e.g. imbalance/wall detection).
const ORDERBOOK_DEPTH = 100;

function parseKuOrderbook(d) {
  const b = d?.data?.bids, a = d?.data?.asks;
  if (!Array.isArray(b) || !Array.isArray(a) || !b.length || !a.length) return null;
  return { bids:b.map(x=>[+x[0],+x[1]]), asks:a.map(x=>[+x[0],+x[1]]), source:'kucoin' };
}
function parseOkxOrderbook(d) {
  const book = d?.data?.[0];
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) || !book.bids.length || !book.asks.length) return null;
  return { bids:book.bids.map(x=>[+x[0],+x[1]]), asks:book.asks.map(x=>[+x[0],+x[1]]), source:'okx' };
}
function parseBinOrderbook(d) {
  if (!d || !Array.isArray(d.bids) || !Array.isArray(d.asks) || !d.bids.length || !d.asks.length) return null;
  return { bids:d.bids.map(x=>[+x[0],+x[1]]), asks:d.asks.map(x=>[+x[0],+x[1]]), source:'binance' };
}
function parseBybitOrderbook(d) {
  const b = d?.result?.b, a = d?.result?.a;
  if (!Array.isArray(b) || !Array.isArray(a) || !b.length || !a.length) return null;
  return { bids:b.map(x=>[+x[0],+x[1]]), asks:a.map(x=>[+x[0],+x[1]]), source:'bybit' };
}

async function fetchOrderbook(symbol) {
  return raceExchanges([
    { label:'binance', url:`https://api.binance.com/api/v3/depth?symbol=${symbol}USDT&limit=${ORDERBOOK_DEPTH}`, parse:parseBinOrderbook },
    { label:'bybit',   url:`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}USDT&limit=${ORDERBOOK_DEPTH}`, parse:parseBybitOrderbook },
    { label:'kucoin',  url:`https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${symbol}-USDT`, parse:parseKuOrderbook },
    { label:'okx',     url:`https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT&sz=${ORDERBOOK_DEPTH}`, parse:parseOkxOrderbook },
  ]);
}

async function fetchPerpOrderbook(symbol) {
  const kuSymbol = (KU_FUTURES_SYMBOL_MAP[symbol] || symbol) + 'USDTM';
  return raceExchanges([
    { label:'binance-perp', url:`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}USDT&limit=${ORDERBOOK_DEPTH}`, parse:parseBinOrderbook },
    { label:'bybit-perp',   url:`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}USDT&limit=${ORDERBOOK_DEPTH}`, parse:parseBybitOrderbook },
    { label:'okx-swap',     url:`https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT-SWAP&sz=${ORDERBOOK_DEPTH}`, parse:parseOkxOrderbook },
    // NOTE: assumed to mirror spot's { data: { bids, asks } } shape, same as KuCoin's other
    // spot/futures pairs in this file — flagged for a live spot-check against real Netlify
    // logs after deploy, same as every other exchange integration here. If it's wrong, the
    // other three sources in this race still cover the request.
    { label:'kucoin-futures', url:`https://api-futures.kucoin.com/api/v1/level2/depth100?symbol=${kuSymbol}`, parse:parseKuOrderbook },
  ]);
}

// ── TICKER FETCHERS ──
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','FDUSD','PYUSD','FRAX','LUSD','SUSD','GUSD','USDD','UST','USTC','CUSD','CEUR','USDJ','HUSD']);

async function fetchTickers(n) {
  // Fetch all four in parallel — Binance has best volume data globally
  const [ku, okx, bybit, bin] = await Promise.all([
    tryFetch('https://api.kucoin.com/api/v1/market/allTickers', 'kucoin-tickers'),
    tryFetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT', 'okx-tickers'),
    tryFetch('https://api.bybit.com/v5/market/tickers?category=spot', 'bybit-tickers'),
    tryFetch('https://api.binance.com/api/v3/ticker/24hr?type=MINI', 'binance-tickers'),
  ]);

  const seen = new Set();
  const tokens = [];

  // Binance first — highest liquidity, most accurate volume
  if (Array.isArray(bin)) {
    bin.filter(t => t.symbol.endsWith('USDT'))
      .forEach(t => {
        const sym = t.symbol.replace('USDT','');
        if (!STABLES.has(sym) && +t.lastPrice > 0 && +t.quoteVolume > 100000 && !seen.has(sym)) {
          seen.add(sym);
          tokens.push({ symbol:sym, price:+t.lastPrice, change24h:+t.priceChangePercent||0, volume:+t.quoteVolume, source:'binance' });
        }
      });
  }

  if (ku?.data?.ticker) {
    ku.data.ticker.filter(t => t.symbol.endsWith('-USDT')).forEach(t => {
      const sym = t.symbol.replace('-USDT','');
      if (!STABLES.has(sym) && +t.last > 0 && +t.volValue > 100000 && !seen.has(sym)) {
        seen.add(sym);
        tokens.push({ symbol:sym, price:+t.last, change24h:+t.changeRate*100||0, volume:+t.volValue, source:'kucoin' });
      }
    });
  }

  if (okx?.data) {
    okx.data.filter(t => t.instId.endsWith('-USDT')).forEach(t => {
      const sym = t.instId.replace('-USDT','');
      if (!STABLES.has(sym) && +t.last > 0 && +t.volCcy24h > 100000 && !seen.has(sym)) {
        seen.add(sym);
        tokens.push({ symbol:sym, price:+t.last, change24h:+t.sodUtc8||0, volume:+t.volCcy24h, source:'okx' });
      }
    });
  }

  if (bybit?.result?.list) {
    bybit.result.list.filter(t => t.symbol.endsWith('USDT')).forEach(t => {
      const sym = t.symbol.replace('USDT','');
      if (!STABLES.has(sym) && +t.lastPrice > 0 && +t.turnover24h > 100000 && !seen.has(sym)) {
        seen.add(sym);
        tokens.push({ symbol:sym, price:+t.lastPrice, change24h:+t.price24hPcnt*100||0, volume:+t.turnover24h, source:'bybit' });
      }
    });
  }

  return tokens.sort((a,b) => b.volume - a.volume).slice(0, n);
}

// ── TOP 100 BY MARKET CAP (CoinGecko) matched against tradeable exchange pairs ──
// CoinGecko gives the token LIST (which 100 tokens actually matter by market cap, not by
// whichever exchange volume happens to be inflated today). The exchanges still provide every
// price/candle used for detection — this only decides which symbols get scanned in the first
// place. Not every top-100-by-market-cap token has a KuCoin/OKX USDT pair, so we walk further
// down CoinGecko's ranked list than 100 and backfill until we actually have 100 tradeable ones,
// reporting exactly which ones got skipped and why rather than silently coming up short.
async function fetchTop100ByMarketCap(n) {
  const [cg, ku, okx] = await Promise.all([
    tryFetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false', 'coingecko-markets'),
    tryFetch('https://api.kucoin.com/api/v1/market/allTickers', 'kucoin-tickers-for-top100'),
    tryFetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT', 'okx-tickers-for-top100'),
  ]);

  if (!Array.isArray(cg) || !cg.length) return { included: [], skipped: [], error: 'CoinGecko market data unavailable' };

  // Build a map of symbol -> { price, volume, source } from whichever exchanges responded
  const exchangeMap = {};
  if (ku?.data?.ticker) {
    ku.data.ticker.filter(t => t.symbol.endsWith('-USDT')).forEach(t => {
      const sym = t.symbol.replace('-USDT','');
      if (+t.last > 0) exchangeMap[sym] = { price:+t.last, change24h:+t.changeRate*100||0, volume:+t.volValue||0, source:'kucoin' };
    });
  }
  if (okx?.data) {
    okx.data.filter(t => t.instId.endsWith('-USDT')).forEach(t => {
      const sym = t.instId.replace('-USDT','');
      if (!exchangeMap[sym] && +t.last > 0) exchangeMap[sym] = { price:+t.last, change24h:0, volume:+t.volCcy24h||0, source:'okx' };
    });
  }

  const included = [];
  const skipped = [];

  for (const coin of cg) {
    if (included.length >= n) break;
    const sym = (coin.symbol||'').toUpperCase();
    if (!sym) continue;
    if (STABLES.has(sym)) { skipped.push({ symbol:sym, name:coin.name, rank:coin.market_cap_rank, reason:'stablecoin, excluded' }); continue; }

    const ex = exchangeMap[sym];
    if (!ex) { skipped.push({ symbol:sym, name:coin.name, rank:coin.market_cap_rank, reason:'no KuCoin/OKX USDT pair found' }); continue; }

    included.push({
      symbol: sym, name: coin.name, price: ex.price, change24h: ex.change24h, volume: ex.volume, source: ex.source,
      marketCap: coin.market_cap, marketCapRank: coin.market_cap_rank
    });
  }

  return { included, skipped };
}

// ── LEGACY: ?url= passthrough for CoinGecko / calendar ──
const ALLOWED = [
  'https://api.alternative.me',
  'https://api.coingecko.com',
  'https://nfs.faireconomy.media',
  'https://cdn-nfs.faireconomy.media',
];

const CORS = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };

exports.handler = async function(event) {
  const q = event.queryStringParameters || {};

  if (q.action === 'candles') {
    const { symbol, tf, market } = q;
    if (!symbol || !tf) return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Missing symbol or tf'}) };
    const data = market === 'perp'
      ? await fetchPerpCandles(symbol.toUpperCase(), tf)
      : await fetchCandles(symbol.toUpperCase(), tf);
    if (!data) return { statusCode:502, headers:CORS, body:JSON.stringify({error:'All candle sources failed'}) };
    return { statusCode:200, headers:CORS, body:JSON.stringify(data) };
  }

  if (q.action === 'orderbook') {
    const { symbol, market } = q;
    if (!symbol) return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Missing symbol'}) };
    const data = market === 'perp'
      ? await fetchPerpOrderbook(symbol.toUpperCase())
      : await fetchOrderbook(symbol.toUpperCase());
    if (!data) return { statusCode:502, headers:CORS, body:JSON.stringify({error:'All orderbook sources failed'}) };
    return { statusCode:200, headers:CORS, body:JSON.stringify(data) };
  }

  if (q.action === 'tickers') {
    const n = Math.min(parseInt(q.n)||100, 200);
    const data = await fetchTickers(n);
    if (!data.length) return { statusCode:502, headers:CORS, body:JSON.stringify({error:'All ticker sources failed'}) };
    return { statusCode:200, headers:CORS, body:JSON.stringify(data) };
  }

  if (q.action === 'top100') {
    const n = Math.min(parseInt(q.n)||100, 150);
    const data = await fetchTop100ByMarketCap(n);
    if (data.error) return { statusCode:502, headers:CORS, body:JSON.stringify(data) };
    return { statusCode:200, headers:CORS, body:JSON.stringify(data) };
  }

  // Legacy passthrough
  const url = q.url;
  if (!url) return { statusCode:400, body:'Missing action or url' };
  if (!ALLOWED.some(o => url.startsWith(o))) return { statusCode:403, body:'Not allowed' };
  const r = await fetchUrl(url, 8000);
  return { statusCode:r.status||502, headers:CORS, body:r.body||'{}' };
};
