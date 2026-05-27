// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy (Polygon.io / Massive.com)
// Fetches real-time price + RSI + volume for ALL tickers at once
// Much faster than Alpha Vantage — no 13s delays, no daily limits
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "No tickers provided" });

  const tickerList = tickers.split(",").map(t => t.trim().toUpperCase());

  try {
    // ── STEP 1: One snapshot call gets ALL tickers at once ────────
    // Price, prev close, volume — all in a single request
    const snapshotUrl =
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers` +
      `?tickers=${tickerList.join(",")}&apiKey=${POLY_KEY}`;

    const snapRes  = await fetch(snapshotUrl);
    const snapData = await snapRes.json();
    const snapMap  = {};
    (snapData.tickers || []).forEach(t => { snapMap[t.ticker] = t; });

    // ── STEP 2: RSI + 52w range in parallel for each ticker ───────
    const results = await Promise.all(
      tickerList.map(async (ticker) => {
        const snap = snapMap[ticker];
        if (!snap) return { ticker, error: "No data from Polygon" };

        // Price data from snapshot
        const day     = snap.day     || {};
        const prevDay = snap.prevDay || {};
        const curr    = parseFloat((day.c || snap.lastTrade?.p || 0).toFixed(2));
        const prev    = parseFloat((prevDay.c || 0).toFixed(2));
        const vol     = Math.floor(day.v  || 0);
        const avgVol  = Math.floor(day.av || vol || 1);
        const dipDollars = parseFloat((prev - curr).toFixed(2));
        const dipPct     = prev > 0
          ? parseFloat((((curr - prev) / prev) * 100).toFixed(2))
          : 0;

        // RSI from Polygon technical indicators endpoint
        let rsi = null;
        try {
          const rsiUrl =
            `${BASE}/v1/indicators/rsi/${ticker}` +
            `?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const rsiJson = await (await fetch(rsiUrl)).json();
          rsi = rsiJson?.results?.values?.[0]?.value ?? null;
          if (rsi !== null) rsi = parseFloat(rsi.toFixed(1));
        } catch (_) {}

        // 52-week high/low from daily aggregates
        let week52High = curr * 1.3;
        let week52Low  = curr * 0.7;
        try {
          const today   = new Date().toISOString().split("T")[0];
          const yearAgo = new Date(Date.now() - 365*24*60*60*1000).toISOString().split("T")[0];
          const aggUrl  =
            `${BASE}/v2/aggs/ticker/${ticker}/range/1/day/${yearAgo}/${today}` +
            `?adjusted=true&sort=asc&limit=365&apiKey=${POLY_KEY}`;
          const aggJson = await (await fetch(aggUrl)).json();
          const bars    = aggJson.results || [];
          if (bars.length > 0) {
            week52High = parseFloat(Math.max(...bars.map(b => b.h)).toFixed(2));
            week52Low  = parseFloat(Math.min(...bars.map(b => b.l)).toFixed(2));
          }
        } catch (_) {}

        const distFromLow = week52High !== week52Low
          ? parseFloat((((curr - week52Low) / (week52High - week52Low)) * 100).toFixed(1))
          : 50;

        return {
          ticker, curr, prev,
          dipDollars, dipPct, rsi,
          vol, avgVol,
          volRatio: parseFloat((vol / avgVol).toFixed(2)),
          week52High, week52Low, distFromLow,
        };
      })
    );

    return res.status(200).json({
      stocks:    results,
      fetchedAt: new Date().toISOString(),
      source:    "polygon.io",
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
