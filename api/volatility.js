// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Volatile Sweet Spot Scanner v3
// Strategy: Use snapshot daily range (H-L) as ATR proxy
// No separate ATR calls needed — single snapshot call covers all
// GET /api/volatility?minPrice=150&maxPrice=300&minAtr=15&maxAtr=30
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

let cache = { data: null, ts: 0, key: "" };
const CACHE_MS = 30 * 60 * 1000;

function isRealStock(ticker) {
  if (!ticker) return false;
  if (ticker.endsWith("W")) return false;
  if (ticker.endsWith("R")) return false;
  if (ticker.endsWith("Z")) return false;
  if (ticker.includes(".")) return false;
  if (ticker.length > 5)   return false;
  return true;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const minPrice = parseFloat(req.query.minPrice || 150);
  const maxPrice = parseFloat(req.query.maxPrice || 300);
  const minAtr   = parseFloat(req.query.minAtr   || 15);
  const maxAtr   = parseFloat(req.query.maxAtr   || 30);
  const cacheKey = `${minPrice}-${maxPrice}-${minAtr}-${maxAtr}`;
  const now      = Date.now();

  if (cache.data && cache.key === cacheKey && (now - cache.ts) < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try {
    // ── STEP 1: Fetch gainers + losers snapshots ──────────────────
    // These have the most volatility by definition
    // Snapshot includes day.h and day.l — use (H-L) as ATR proxy
    const [gainersResp, losersResp] = await Promise.all([
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLY_KEY}`),
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${POLY_KEY}`),
    ]);
    const gainersJson = await gainersResp.json();
    const losersJson  = await losersResp.json();

    // ── STEP 2: Fetch snapshots for curated high-ATR tickers ──────
    // These are stocks historically known to have $15-$30 ATR
    const CURATED = [
      "NVDA","AMD","MRVL","ARM","AVGO","AMAT","LRCX","KLAC","ASML",
      "MU","TSM","INTC","TXN","ADI","SNPS","CDNS","CRWD","PANW","ZS",
      "MSFT","AAPL","AMZN","GOOGL","META","TSLA","ORCL","CRM","NOW","ADBE",
      "IBM","ANET","SMCI","DELL","VRT","COIN","PLTR","RDDT","GEV","VST",
      "NFLX","SHOP","UBER","SNOW","DDOG","MDB","HUBS","NET","GTLB","BILL",
      "CEG","ETN","ROK","ISRG","IONQ","RGTI","WDC","STX","COHR","ENTG",
      "QCOM","ON","NXPI","MCHP","STM","MPWR","LSCC","SWKS","MTSI","MXL",
      "TTMI","ALAB","CRDO","AMBA","MBLY","AXTI","WOLF","LIN","APD","KLIC",
      "TER","ONTO","ACLS","AZTA","VECO","UCTT","ICHR","COHU","PLAB","RMBS",
    ];

    const snapResp = await fetch(
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${CURATED.join(",")}&apiKey=${POLY_KEY}`
    );
    const snapJson = await snapResp.json();

    // ── STEP 3: Combine all snapshots, deduplicate ────────────────
    const seen = new Set();
    const allSnaps = [
      ...(gainersJson.tickers || []),
      ...(losersJson.tickers  || []),
      ...(snapJson.tickers    || []),
    ].filter(s => {
      if (!s.ticker || seen.has(s.ticker)) return false;
      seen.add(s.ticker);
      return true;
    });

    // ── STEP 4: Filter + calculate ATR proxy from day range ───────
    // ATR proxy = (day.h - day.l) — today's actual range
    // For 14-day ATR we'd need separate calls, but day range is good enough
    // to identify volatile stocks
    const qualifying = allSnaps
      .filter(s => {
        const ticker   = s.ticker;
        const price    = s.day?.c || s.lastTrade?.p || s.prevDay?.c || 0;
        const dayHigh  = s.day?.h || 0;
        const dayLow   = s.day?.l || 0;
        const dayRange = dayHigh - dayLow;
        const vol      = s.day?.v || 0;

        if (!isRealStock(ticker))              return false;
        if (price < minPrice || price > maxPrice) return false;
        if (vol < 300000)                      return false;
        if (dayRange < minAtr || dayRange > maxAtr) return false;
        return true;
      })
      .map(s => {
        const price    = s.day?.c || s.lastTrade?.p || s.prevDay?.c || 0;
        const dayHigh  = s.day?.h || 0;
        const dayLow   = s.day?.l || 0;
        const dayRange = parseFloat((dayHigh - dayLow).toFixed(2));
        const chgPct   = s.todaysChangePerc || 0;
        const vol      = s.day?.v || 0;
        const prevVol  = s.prevDay?.v || 1;
        const volRatio = prevVol > 0 ? parseFloat((vol/prevVol).toFixed(2)) : null;

        return {
          ticker:   s.ticker,
          curr:     parseFloat(price.toFixed(2)),
          atr:      dayRange,        // today's range as ATR proxy
          dipPct:   parseFloat(chgPct.toFixed(2)),
          vol:      Math.floor(vol),
          volRatio: volRatio,
          high:     parseFloat(dayHigh.toFixed(2)),
          low:      parseFloat(dayLow.toFixed(2)),
          rsi:      null,            // skip RSI to avoid extra calls
        };
      })
      .sort((a, b) => (b.atr || 0) - (a.atr || 0));

    const result = {
      stocks:    qualifying,
      count:     qualifying.length,
      scanned:   allSnaps.length,
      minPrice, maxPrice, minAtr, maxAtr,
      note:      "ATR shown = today's day range (High-Low). Run SCAN MY 120 STOCKS for 14-day ATR.",
      fetchedAt: new Date().toISOString(),
      cached:    false,
    };

    cache = { data: result, ts: now, key: cacheKey };
    return res.status(200).json(result);

  } catch (err) {
    console.error("[Volatility] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
