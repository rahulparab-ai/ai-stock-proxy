// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Market Movers (Enriched)
// v2: Fetches top 20 gainers + losers, enriches with RSI + ATR
//     Returns same stock object format as stocks.js
//     So index.html can apply identical dip/gap analysis logic
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// RSI/ATR cached 8 hours (daily indicators)
// Movers snapshot cached 2 mins
let dailyCache = { rsi: {}, atr: {}, ts: 0 };
let moversCache = { data: null, ts: 0 };
const DAILY_CACHE_MS  = 8 * 60 * 60 * 1000;
const MOVERS_CACHE_MS = 2 * 60 * 1000;

function isMarketOpen() {
  const et   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  if (day === 0 || day === 6) return false;
  return mins >= 570 && mins < 960;
}

function buildStockObj(snap, rsiMap, atrMap, marketOpen) {
  const ticker  = snap.ticker;
  const day     = snap.day     || {};
  const prevDay = snap.prevDay || {};

  // Price — same logic as stocks.js
  const prevC    = prevDay.c || 0;
  const lastTP   = snap.lastTrade?.p || 0;
  const minC     = snap.min?.c       || 0;
  const dayC     = day.c             || 0;
  const todayChg = snap.todaysChange || 0;
  const nowET    = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const isWeekend= nowET.getDay()===0||nowET.getDay()===6;

  let curr, priceSource;
  if (marketOpen) {
    if      (lastTP>0){ curr=lastTP; priceSource="last_trade"; }
    else if (minC>0)  { curr=minC;   priceSource="min_bar"; }
    else if (dayC>0)  { curr=dayC;   priceSource="day_close"; }
    else              { curr=parseFloat((prevC+todayChg).toFixed(2)); priceSource="calc"; }
  } else if (isWeekend) {
    curr=prevC; priceSource="prev_close_weekend";
  } else {
    if      (dayC>0)  { curr=dayC;   priceSource="day_close_today"; }
    else if (lastTP>0){ curr=lastTP; priceSource="last_trade_ah"; }
    else              { curr=prevC;  priceSource="prev_close_fallback"; }
  }
  curr = parseFloat((curr||0).toFixed(2));
  const prev = parseFloat((prevC||0).toFixed(2));

  // Volume
  const volRaw   = day.v;
  const volNull  = volRaw===null||volRaw===undefined;
  const vol      = volNull ? 0 : Math.floor(volRaw);
  const avgVol   = Math.floor(prevDay.v || 1);
  const volRatio = volNull ? null : (avgVol>0 ? parseFloat((vol/avgVol).toFixed(2)) : null);

  // Dip
  const dipDollars = parseFloat((prev-curr).toFixed(2));
  const dipPct = !marketOpen ? 0
    : snap.todaysChangePerc!=null
      ? parseFloat(snap.todaysChangePerc.toFixed(2))
      : (prev>0 ? parseFloat((((curr-prev)/prev)*100).toFixed(2)) : 0);

  // Open / high / low
  const openPrice       = parseFloat((day.o||0).toFixed(2));
  const todayHigh       = parseFloat((day.h||curr).toFixed(2));
  const todayLow        = parseFloat((day.l||curr).toFixed(2));
  const gapFromOpen     = (openPrice>0&&prev>0) ? parseFloat((((openPrice-prev)/prev)*100).toFixed(2)) : 0;
  const fromOpenDollars = openPrice>0 ? parseFloat((curr-openPrice).toFixed(2)) : 0;

  // VWAP
  const vwap      = (day.vw&&vol>0) ? parseFloat(day.vw.toFixed(2)) : null;
  const belowVwap = vwap ? curr<vwap : null;
  const pctFromVwap = (vwap&&vwap>0) ? parseFloat((((curr-vwap)/vwap)*100).toFixed(2)) : null;

  // ATR
  const atr             = atrMap[ticker]??null;
  const todayMoveAbs    = parseFloat(Math.abs(curr-(openPrice||prev)).toFixed(2));
  const atrPctUsed      = (atr&&atr>0) ? parseFloat(((todayMoveAbs/atr)*100).toFixed(1)) : null;
  const atrRemainingDollars = (atr&&atrPctUsed!==null)
    ? parseFloat(Math.max(0,atr-todayMoveAbs).toFixed(2)) : null;
  const dipVsAtr        = (atr&&dipDollars>0) ? parseFloat((dipDollars/atr).toFixed(2)) : null;

  return {
    ticker, curr, prev,
    priceSource, marketOpen,
    openPrice, todayHigh, todayLow,
    gapFromOpen, fromOpenDollars,
    dipDollars, dipPct,
    rsi:    rsiMap[ticker]??null,
    vol, avgVol, volRatio, volNull,
    avgVolSource: "prev_day_proxy",
    vwap, belowVwap, pctFromVwap,
    atr, atrPctUsed, atrRemainingDollars, dipVsAtr,
    isMover: true,
    isMarketMover: true,   // flag so UI knows this came from market-wide scan
    news: [], newsStr: "NO_RECENT_NEWS", newsCount: 0,
    priceSuspect: prev>0&&curr>0&&curr<prev*0.30,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const now        = Date.now();
  const marketOpen = isMarketOpen();

  // Return movers cache if fresh
  if (moversCache.data && (now - moversCache.ts) < MOVERS_CACHE_MS) {
    return res.status(200).json({ ...moversCache.data, cached: true });
  }

  try {
    // ── STEP 1: Fetch gainers + losers in parallel ────────────────
    const [gainersResp, losersResp] = await Promise.all([
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLY_KEY}`),
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${POLY_KEY}`),
    ]);
    const gainersJson = await gainersResp.json();
    const losersJson  = await losersResp.json();

    const gainers = gainersJson.tickers || [];
    const losers  = losersJson.tickers  || [];

    // ── STEP 2: Filter to real tradeable stocks only ──────────────
    // Remove penny stocks, warrants, SPACs, rights that pollute the list
    function isRealStock(snap) {
      const t = snap.ticker || "";
      const price = snap.day?.c || snap.lastTrade?.p || 0;
      const vol   = snap.day?.v || 0;
      if (price < 5)       return false; // no penny stocks
      if (vol < 200000)    return false; // no illiquid stocks
      if (t.endsWith("W")) return false; // warrants
      if (t.endsWith("R")) return false; // rights
      if (t.endsWith("Z")) return false; // bankruptcy
      if (t.includes(".")) return false; // VLN.WS etc
      if (t.length > 5)    return false; // too long = special security
      return true;
    }

    const filteredGainers = gainers.filter(isRealStock);
    const filteredLosers  = losers.filter(isRealStock);
    const allSnaps = [...filteredGainers, ...filteredLosers];
    const seen = new Set();
    const uniqueSnaps = allSnaps.filter(t => {
      if (seen.has(t.ticker)) return false;
      seen.add(t.ticker);
      return true;
    });
    const tickerList = uniqueSnaps.map(t => t.ticker);

    // ── STEP 3: RSI + ATR — daily cache ──────────────────────────
    const rsiMap = {};
    const atrMap = {};
    const needFresh = (now - dailyCache.ts) > DAILY_CACHE_MS;
    const missing   = tickerList.filter(t => dailyCache.rsi[t]===undefined);

    if (needFresh || missing.length > 0) {
      const toFetch = needFresh ? tickerList : missing;
      await Promise.all(toFetch.map(async ticker => {
        try {
          const rsiUrl = `${BASE}/v1/indicators/rsi/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const rj = await (await fetch(rsiUrl)).json();
          const v  = rj?.results?.values?.[0]?.value;
          dailyCache.rsi[ticker] = v ? parseFloat(v.toFixed(1)) : null;
        } catch(_){ dailyCache.rsi[ticker]=null; }

        try {
          const atrUrl = `${BASE}/v1/indicators/atr/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const aj = await (await fetch(atrUrl)).json();
          const v  = aj?.results?.values?.[0]?.value;
          dailyCache.atr[ticker] = v ? parseFloat(v.toFixed(2)) : null;
        } catch(_){ dailyCache.atr[ticker]=null; }
      }));
      if (needFresh) dailyCache.ts = now;
    }

    // Copy from dailyCache
    tickerList.forEach(t => {
      rsiMap[t] = dailyCache.rsi[t]??null;
      atrMap[t] = dailyCache.atr[t]??null;
    });

    // ── STEP 4: Build enriched stock objects ──────────────────────
    const gainerStocks = filteredGainers.map(s => buildStockObj(s, rsiMap, atrMap, marketOpen));
    const loserStocks  = filteredLosers.map(s  => buildStockObj(s, rsiMap, atrMap, marketOpen));

    const result = {
      gainers:     gainerStocks,
      losers:      loserStocks,
      marketOpen,
      fetchedAt:   new Date().toISOString(),
      cached:      false,
      gainersCount: gainerStocks.length,
      losersCount:  loserStocks.length,
    };

    moversCache = { data: result, ts: now };

    return res.status(200).json(result);

  } catch (err) {
    console.error("[MarketMovers] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
