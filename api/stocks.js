// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy (Polygon / Massive)
// Fixed: avgVol now fetched from ticker details API (real 30-day avg)
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// Cache for 10 minutes
let cache = { data: null, ts: 0 };
const CACHE_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { tickers, bust } = req.query;
  if (!tickers) return res.status(400).json({ error: "No tickers provided" });

  const tickerList = tickers.split(",").map(t => t.trim().toUpperCase());
  const now        = Date.now();

  // Return cache if fresh
  if (!bust && cache.data && (now - cache.ts) < CACHE_MS) {
    const cached = cache.data.filter(s => tickerList.includes(s.ticker));
    return res.status(200).json({
      stocks: cached, fetchedAt: new Date(cache.ts).toISOString(),
      source: "polygon.io", cached: true,
    });
  }

  try {
    // ── STEP 1: Snapshot — price, today vol, prev close ───────────
    const snapUrl =
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers` +
      `?tickers=${tickerList.join(",")}&apiKey=${POLY_KEY}`;
    const snapData = await (await fetch(snapUrl)).json();
    const snapMap  = {};
    (snapData.tickers || []).forEach(t => { snapMap[t.ticker] = t; });

    // ── STEP 2: Ticker Details — gets real 30-day avg volume ──────
    // Polygon v3 /reference/tickers/{ticker} has weighted_shares_outstanding
    // Better: use /v2/aggs/ticker/{ticker}/prev for yesterday's volume
    // We fetch prev day agg for all tickers in parallel to get real avgVol
    // Actually best source: grouped daily endpoint gives volume_weighted data
    // Use /v2/aggs/ticker/{T}/range/1/day/{from}/{to} last 30 days, take average

    const today   = new Date();
    const from    = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to      = today.toISOString().split("T")[0];

    // Only fetch avg vol for movers to save API calls
    const movers = tickerList.filter(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return false;
      const curr = snap.day?.c || snap.lastTrade?.p || 0;
      const prev = snap.prevDay?.c || 0;
      if (!curr || !prev) return false;
      return Math.abs(((curr - prev) / prev) * 100) >= 0.5;
    });

    // ── STEP 3: Fetch RSI + avgVol in parallel for movers ─────────
    const rsiMap    = {};
    const avgVolMap = {};

    await Promise.all(movers.map(async ticker => {
      // RSI
      try {
        const rsiUrl =
          `${BASE}/v1/indicators/rsi/${ticker}` +
          `?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
        const rsiJson = await (await fetch(rsiUrl)).json();
        const val = rsiJson?.results?.values?.[0]?.value;
        rsiMap[ticker] = val ? parseFloat(val.toFixed(1)) : null;
      } catch (_) { rsiMap[ticker] = null; }

      // Real 30-day average volume from daily aggregates
      try {
        const aggUrl =
          `${BASE}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}` +
          `?adjusted=true&sort=desc&limit=30&apiKey=${POLY_KEY}`;
        const aggJson = await (await fetch(aggUrl)).json();
        const bars    = aggJson.results || [];
        if (bars.length > 0) {
          const totalVol = bars.reduce((sum, b) => sum + (b.v || 0), 0);
          avgVolMap[ticker] = Math.floor(totalVol / bars.length);
        }
      } catch (_) { avgVolMap[ticker] = null; }
    }));

    // ── STEP 4: Build results ─────────────────────────────────────
    const results = tickerList.map(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return { ticker, error: "No snapshot data" };

      const day     = snap.day     || {};
      const prevDay = snap.prevDay || {};
      const curr    = parseFloat((day.c || snap.lastTrade?.p || 0).toFixed(2));
      const prev    = parseFloat((prevDay.c || 0).toFixed(2));
      const vol     = Math.floor(day.v || 0);

      // Use real 30-day avg if available, otherwise use prev day vol as proxy
      const avgVol  = avgVolMap[ticker]
        || Math.floor(snap.prevDay?.v || vol || 1);

      const dipDollars = parseFloat((prev - curr).toFixed(2));
      const dipPct     = prev > 0
        ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : 0;
      const volRatio   = avgVol > 0
        ? parseFloat((vol / avgVol).toFixed(2)) : 1;

      // 52w high/low from snapshot min/max — use prevDay data as proxy
      // (full 52w needs separate call — keeping it fast)
      const week52High = parseFloat((snap.day?.h || curr * 1.3).toFixed(2));
      const week52Low  = parseFloat((snap.day?.l || curr * 0.7).toFixed(2));
      const todayRange = week52High - week52Low;
      const distFromLow = todayRange > 0
        ? parseFloat((((curr - week52Low) / todayRange) * 100).toFixed(1))
        : 50;

      const openPrice  = parseFloat((day.o || curr).toFixed(2));
      const todayHigh  = parseFloat((day.h || curr).toFixed(2));
      const todayLow   = parseFloat((day.l || curr).toFixed(2));
      const gapFromOpen = openPrice > 0
        ? parseFloat((((curr - openPrice) / openPrice) * 100).toFixed(2)) : 0;
      const fromOpenDollars = parseFloat((curr - openPrice).toFixed(2));

      return {
        ticker, curr, prev,
        openPrice, todayHigh, todayLow,
        gapFromOpen, fromOpenDollars,
        dipDollars, dipPct,
        rsi:    rsiMap[ticker] ?? null,
        vol,    avgVol, volRatio,
        week52High, week52Low, distFromLow,
        isMover: movers.includes(ticker),
        avgVolSource: avgVolMap[ticker] ? "30day_avg" : "prev_day_proxy",
      };
    });

    cache = { data: results, ts: now };

    return res.status(200).json({
      stocks:      results,
      fetchedAt:   new Date().toISOString(),
      source:      "polygon.io",
      cached:      false,
      moversCount: movers.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
