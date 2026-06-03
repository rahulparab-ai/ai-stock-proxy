// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Market Movers Proxy
// Fetches top 20 gainers or losers from entire US stock market
// Endpoint: GET /api/marketmovers?direction=gainers|losers
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// Cache 2 minutes — movers change fast but no need to hammer API
let cache = { gainers: null, losers: null, ts: 0 };
const CACHE_MS = 2 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { direction = "gainers" } = req.query;
  if (direction !== "gainers" && direction !== "losers") {
    return res.status(400).json({ error: "direction must be gainers or losers" });
  }

  const now = Date.now();

  // Return cache if fresh
  if (cache[direction] && (now - cache.ts) < CACHE_MS) {
    return res.status(200).json({
      tickers:   cache[direction],
      direction,
      cached:    true,
      fetchedAt: new Date(cache.ts).toISOString(),
    });
  }

  try {
    const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/${direction}?apiKey=${POLY_KEY}`;
    const resp = await fetch(url);
    const json = await resp.json();

    if (!resp.ok) {
      console.error("[MarketMovers] Polygon error:", json);
      return res.status(resp.status).json({ error: json.error || "Polygon API error", details: json });
    }

    const tickers = (json.tickers || []).map(t => ({
      ticker:          t.ticker,
      todaysChange:    t.todaysChange,
      todaysChangePerc:t.todaysChangePerc,
      day: {
        o:  t.day?.o,
        h:  t.day?.h,
        l:  t.day?.l,
        c:  t.day?.c,
        v:  t.day?.v,
        vw: t.day?.vw,
      },
      lastTrade: {
        p: t.lastTrade?.p,
      },
      prevDay: {
        c: t.prevDay?.c,
        v: t.prevDay?.v,
      },
    }));

    // Update cache
    cache[direction] = tickers;
    cache.ts = now;

    return res.status(200).json({
      tickers,
      direction,
      cached:    false,
      count:     tickers.length,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[MarketMovers] Exception:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
