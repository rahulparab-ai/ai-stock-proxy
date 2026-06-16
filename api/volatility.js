// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Volatile Sweet Spot Scanner
// Finds stocks in a price range with high ATR (daily volatility)
// GET /api/volatility?minPrice=150&maxPrice=200&minAtr=15&maxAtr=20
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// Cache results 30 mins — ATR doesn't change intraday
let cache = { data: null, ts: 0, key: "" };
const CACHE_MS = 30 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const minPrice = parseFloat(req.query.minPrice || 150);
  const maxPrice = parseFloat(req.query.maxPrice || 200);
  const minAtr   = parseFloat(req.query.minAtr   || 15);
  const maxAtr   = parseFloat(req.query.maxAtr   || 20);
  const cacheKey = `${minPrice}-${maxPrice}-${minAtr}-${maxAtr}`;
  const now      = Date.now();

  // Return cached if fresh and same params
  if (cache.data && cache.key === cacheKey && (now - cache.ts) < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try {
    // ── STEP 1: Get all US stock snapshots grouped by day ─────────
    // Polygon /v2/aggs/grouped/locale/us/market/stocks/{date}
    // Returns OHLCV for all US stocks for a given day
    // We use this to get current prices and filter by range

    // Get yesterday's date (most recent trading day close)
    const today = new Date();
    const et    = new Date(today.toLocaleString("en-US", { timeZone: "America/New_York" }));
    // Go back to last Friday if weekend
    let targetDate = new Date(et);
    if (targetDate.getDay() === 0) targetDate.setDate(targetDate.getDate() - 2);
    if (targetDate.getDay() === 6) targetDate.setDate(targetDate.getDate() - 1);
    const dateStr = targetDate.toISOString().split("T")[0];

    // ── STEP 2: Use snapshot to get all tickers with current price ──
    // Filter by price range first using the snapshot gainers/losers won't work
    // Instead use ticker details with financials — but that's slow
    // Best approach: fetch grouped daily bars and filter by price
    const groupedUrl = `${BASE}/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLY_KEY}`;
    const groupedResp = await fetch(groupedUrl);
    const groupedJson = await groupedResp.json();

    if (!groupedJson.results) {
      return res.status(200).json({ stocks: [], error: "No market data for " + dateStr, fetchedAt: new Date().toISOString() });
    }

    // Filter by price range and minimum volume (liquid stocks only)
    const priceFiltered = (groupedJson.results || []).filter(bar => {
      const price  = bar.c || 0;
      const vol    = bar.v || 0;
      const ticker = bar.T || "";
      // Price in range
      if (price < minPrice || price > maxPrice) return false;
      // Minimum volume — avoid illiquid stocks
      if (vol < 500000) return false;
      // No warrants, rights, SPACs
      if (ticker.endsWith("W") || ticker.endsWith("R") || ticker.endsWith("Z")) return false;
      if (ticker.includes(".")) return false;
      if (ticker.length > 5) return false;
      // Reasonable daily range — rough ATR proxy using single day
      const dayRange = (bar.h || 0) - (bar.l || 0);
      if (dayRange < minAtr * 0.5) return false; // quick pre-filter
      return true;
    });

    if (priceFiltered.length === 0) {
      return res.status(200).json({ stocks: [], message: "No stocks in price range", fetchedAt: new Date().toISOString() });
    }

    // ── STEP 3: Fetch ATR for filtered tickers in batches ─────────
    // ATR needs 14 days of data — fetch in parallel batches
    // Limit to top 50 by volume to keep API calls manageable
    const top50 = priceFiltered
      .sort((a, b) => (b.v || 0) - (a.v || 0))
      .slice(0, 50);

    const atrResults = await Promise.all(
      top50.map(async bar => {
        const ticker = bar.T;
        try {
          const atrUrl = `${BASE}/v1/indicators/atr/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const atrJson = await (await fetch(atrUrl)).json();
          const atrVal  = atrJson?.results?.values?.[0]?.value;
          const atr     = atrVal ? parseFloat(atrVal.toFixed(2)) : null;

          // Also get RSI
          const rsiUrl  = `${BASE}/v1/indicators/rsi/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const rsiJson = await (await fetch(rsiUrl)).json();
          const rsiVal  = rsiJson?.results?.values?.[0]?.value;
          const rsi     = rsiVal ? parseFloat(rsiVal.toFixed(1)) : null;

          return { ticker, atr, rsi, curr: bar.c, vol: bar.v, high: bar.h, low: bar.l, open: bar.o };
        } catch (_) {
          return { ticker, atr: null, rsi: null, curr: bar.c, vol: bar.v };
        }
      })
    );

    // ── STEP 4: Filter by ATR range ───────────────────────────────
    const qualifying = atrResults
      .filter(s => s.atr !== null && s.atr >= minAtr && s.atr <= maxAtr)
      .sort((a, b) => (b.atr || 0) - (a.atr || 0)); // highest ATR first

    const result = {
      stocks:    qualifying,
      count:     qualifying.length,
      scanned:   top50.length,
      dateStr,
      minPrice, maxPrice, minAtr, maxAtr,
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
