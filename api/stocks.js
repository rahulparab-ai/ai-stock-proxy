// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy (Polygon / Massive)
// v3: VWAP (from snapshot), ATR (14d), real news headlines added
//     VWAP = intraday price target for bounces
//     ATR  = avg daily $ range, used for position sizing + room-to-run
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// Cache for 10 minutes
let cache = { data: null, ts: 0, newsCache: {} };
const CACHE_MS      = 10 * 60 * 1000;
const NEWS_CACHE_MS = 15 * 60 * 1000; // news cached 15 mins separately

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

    // ── STEP 2: Identify movers for RSI + avgVol + NEWS ───────────
    const today = new Date();
    const from  = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to    = today.toISOString().split("T")[0];

    const movers = tickerList.filter(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return false;
      const curr = snap.day?.c || snap.lastTrade?.p || 0;
      const prev = snap.prevDay?.c || 0;
      if (!curr || !prev) return false;
      return Math.abs(((curr - prev) / prev) * 100) >= 0.5;
    });

    // ── STEP 3: Fetch RSI + ATR + avgVol + NEWS in parallel ──────
    const rsiMap    = {};
    const atrMap    = {};
    const avgVolMap = {};
    const newsMap   = {};

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

      // ATR (14-day Average True Range) — real average daily dollar move
      try {
        const atrUrl =
          `${BASE}/v1/indicators/atr/${ticker}` +
          `?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
        const atrJson = await (await fetch(atrUrl)).json();
        const atrVal  = atrJson?.results?.values?.[0]?.value;
        atrMap[ticker] = atrVal ? parseFloat(atrVal.toFixed(2)) : null;
      } catch (_) { atrMap[ticker] = null; }

      // VWAP — already in Polygon snapshot day.vw, extracted below in results
      // (no extra API call needed)

      // Real 30-day average volume
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

      // ── NEWS: Fetch last 2 headlines from Polygon news API ──────
      // Uses cache to avoid hammering news API on every scan
      const newsCacheEntry = cache.newsCache[ticker];
      if (newsCacheEntry && (now - newsCacheEntry.ts) < NEWS_CACHE_MS) {
        newsMap[ticker] = newsCacheEntry.headlines;
      } else {
        try {
          // published_utc.gte = today minus 3 days to catch weekend news
          const threeDaysAgo = new Date(today - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
          const newsUrl =
            `${BASE}/v2/reference/news` +
            `?ticker=${ticker}&published_utc.gte=${threeDaysAgo}&order=desc&limit=2&apiKey=${POLY_KEY}`;
          const newsJson = await (await fetch(newsUrl)).json();
          const articles = newsJson.results || [];

          // Extract just what Claude needs: title + published date
          const headlines = articles.map(a => ({
            title:     a.title || "",
            published: a.published_utc ? a.published_utc.slice(0, 10) : "",
            sentiment: a.insights?.find(i => i.ticker === ticker)?.sentiment || "neutral",
          }));

          newsMap[ticker] = headlines;
          // Store in news cache
          cache.newsCache[ticker] = { headlines, ts: now };
        } catch (_) {
          newsMap[ticker] = [];
        }
      }

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

      // ── DELISTED GUARD ───────────────────────────────────────────
      // A live stock always has today's open price and volume.
      // Delisted/acquired tickers return stale Polygon data with
      // zero open AND zero volume — flag and skip them entirely.
      const openToday = day.o || 0;
      if (openToday === 0 && vol === 0) {
        return {
          ticker,
          delisted: true,
          error: `DELISTED_OR_INACTIVE: no open price and zero volume today. Remove from watchlist.`,
        };
      }

      const avgVol  = avgVolMap[ticker]
        || Math.floor(snap.prevDay?.v || vol || 1);

      const dipDollars = parseFloat((prev - curr).toFixed(2));
      const dipPct     = prev > 0
        ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : 0;
      const volRatio   = avgVol > 0
        ? parseFloat((vol / avgVol).toFixed(2)) : 1;

      const week52High = parseFloat((snap.day?.h || curr * 1.3).toFixed(2));
      const week52Low  = parseFloat((snap.day?.l || curr * 0.7).toFixed(2));
      const todayRange = week52High - week52Low;
      const distFromLow = todayRange > 0
        ? parseFloat((((curr - week52Low) / todayRange) * 100).toFixed(1))
        : 50;

      const openPrice      = parseFloat((day.o || curr).toFixed(2));
      const todayHigh      = parseFloat((day.h || curr).toFixed(2));
      const todayLow       = parseFloat((day.l || curr).toFixed(2));
      const gapFromOpen    = openPrice > 0
        ? parseFloat((((curr - openPrice) / openPrice) * 100).toFixed(2)) : 0;
      const fromOpenDollars = parseFloat((curr - openPrice).toFixed(2));

      // ── VWAP — from Polygon snapshot day.vw ─────────────────────
      const vwap         = day.vw ? parseFloat(day.vw.toFixed(2)) : null;
      const priceVsVwap  = vwap
        ? parseFloat((curr - vwap).toFixed(2)) : null;           // negative = below VWAP (oversold)
      const pctFromVwap  = (vwap && vwap > 0)
        ? parseFloat((((curr - vwap) / vwap) * 100).toFixed(2)) : null;
      const belowVwap    = vwap ? curr < vwap : null;            // true = bounce signal for dip

      // ── ATR signals ──────────────────────────────────────────────
      const atr              = atrMap[ticker] ?? null;           // avg daily $ move (14d)
      const todayMoveAbs     = parseFloat(Math.abs(curr - openPrice).toFixed(2));
      const atrPctUsed       = (atr && atr > 0)                 // how much of daily range used up
        ? parseFloat(((todayMoveAbs / atr) * 100).toFixed(1)) : null;
      const atrRemainingDollars = (atr && atrPctUsed !== null)  // $ left in typical daily range
        ? parseFloat((atr - todayMoveAbs).toFixed(2)) : null;
      const dipVsAtr         = (atr && dipDollars > 0)          // dip size vs ATR (>1.5 = over-extended)
        ? parseFloat((dipDollars / atr).toFixed(2)) : null;

      // Format news headlines as a compact string for Claude prompt
      const newsHeadlines = newsMap[ticker] || [];
      const newsStr = newsHeadlines.length > 0
        ? newsHeadlines.map(n =>
            `[${n.published}] ${n.title}${n.sentiment !== "neutral" ? ` (${n.sentiment})` : ""}`
          ).join(" | ")
        : "NO_RECENT_NEWS";

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
        // ── VWAP ─────────────────────────────────────────────────
        vwap, priceVsVwap, pctFromVwap, belowVwap,
        // ── ATR ──────────────────────────────────────────────────
        atr, atrPctUsed, atrRemainingDollars, dipVsAtr,
        // ── NEWS ─────────────────────────────────────────────────
        news:        newsHeadlines,
        newsStr:     newsStr,
        newsCount:   newsHeadlines.length,
      };
    });

    cache = { data: results, ts: now, newsCache: cache.newsCache };

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
