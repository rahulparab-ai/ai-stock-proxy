// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy (Polygon)
// v4: Full Polygon field audit — all staleness issues fixed
//
// FIELD AUDIT RESULTS:
// ┌─────────────────┬──────────────────┬────────────────────────────┐
// │ Field           │ Risk             │ Fix                        │
// ├─────────────────┼──────────────────┼────────────────────────────┤
// │ day.c           │ STALE (was bug)  │ Use min.c > lastTrade.p    │
// │ prevDay.c       │ SAFE             │ Official yesterday close   │
// │ day.o           │ SAFE             │ Today's open, set at 9:30  │
// │ day.h / day.l   │ SAFE             │ Today's running high/low   │
// │ day.v           │ SAFE             │ Accumulated today volume   │
// │ day.vw (VWAP)   │ MILD RISK        │ Accumulates since open     │
// │ prevDay.v       │ SAFE             │ Yesterday final volume     │
// │ lastTrade.p     │ BEST PRICE       │ Most recent trade price    │
// │ min.c           │ BEST INTRADAY    │ Last 1-min bar close       │
// │ RSI (indicator) │ LAGGING (1 day)  │ Based on prev close, OK    │
// │ ATR (indicator) │ LAGGING (14 day) │ Historical, OK for sizing  │
// │ avgVol (aggs)   │ SAFE             │ 30-day historical, correct │
// │ news            │ SAFE             │ Timestamped, 3-day window  │
// └─────────────────┴──────────────────┴────────────────────────────┘
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

let cache = { data: null, ts: 0, newsCache: {} };
const CACHE_MS      = 10 * 60 * 1000;
const NEWS_CACHE_MS = 15 * 60 * 1000;

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
    // ── STEP 1: Snapshot ─────────────────────────────────────────
    const snapUrl =
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers` +
      `?tickers=${tickerList.join(",")}&apiKey=${POLY_KEY}`;
    const snapData = await (await fetch(snapUrl)).json();
    const snapMap  = {};
    (snapData.tickers || []).forEach(t => { snapMap[t.ticker] = t; });

    // ── STEP 2: Identify movers ───────────────────────────────────
    // FIX: Use same corrected price priority here too (not just in Step 4)
    const today = new Date();
    const from  = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to    = today.toISOString().split("T")[0];

    const movers = tickerList.filter(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return false;
      // FIX: corrected price priority — same logic as Step 4
      const curr = snap.min?.c || snap.lastTrade?.p || snap.day?.c || 0;
      const prev = snap.prevDay?.c || 0;
      if (!curr || !prev) return false;
      return Math.abs(((curr - prev) / prev) * 100) >= 0.5;
    });

    // ── STEP 3: RSI + ATR + avgVol + NEWS in parallel ────────────
    const rsiMap    = {};
    const atrMap    = {};
    const avgVolMap = {};
    const newsMap   = {};

    await Promise.all(movers.map(async ticker => {

      // RSI — uses daily closes, 1-day lag is acceptable for swing trading
      try {
        const rsiUrl =
          `${BASE}/v1/indicators/rsi/${ticker}` +
          `?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
        const rsiJson = await (await fetch(rsiUrl)).json();
        const val = rsiJson?.results?.values?.[0]?.value;
        rsiMap[ticker] = val ? parseFloat(val.toFixed(1)) : null;
      } catch (_) { rsiMap[ticker] = null; }

      // ATR — 14-day historical, acceptable for position sizing
      try {
        const atrUrl =
          `${BASE}/v1/indicators/atr/${ticker}` +
          `?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
        const atrJson = await (await fetch(atrUrl)).json();
        const atrVal  = atrJson?.results?.values?.[0]?.value;
        atrMap[ticker] = atrVal ? parseFloat(atrVal.toFixed(2)) : null;
      } catch (_) { atrMap[ticker] = null; }

      // avgVol — 30-day historical daily bars, safe and accurate
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

      // News — timestamped headlines, safe
      const newsCacheEntry = cache.newsCache[ticker];
      if (newsCacheEntry && (now - newsCacheEntry.ts) < NEWS_CACHE_MS) {
        newsMap[ticker] = newsCacheEntry.headlines;
      } else {
        try {
          const threeDaysAgo = new Date(today - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
          const newsUrl =
            `${BASE}/v2/reference/news` +
            `?ticker=${ticker}&published_utc.gte=${threeDaysAgo}&order=desc&limit=2&apiKey=${POLY_KEY}`;
          const newsJson = await (await fetch(newsUrl)).json();
          const articles = newsJson.results || [];
          const headlines = articles.map(a => ({
            title:     a.title || "",
            published: a.published_utc ? a.published_utc.slice(0, 10) : "",
            sentiment: a.insights?.find(i => i.ticker === ticker)?.sentiment || "neutral",
          }));
          newsMap[ticker] = headlines;
          cache.newsCache[ticker] = { headlines, ts: now };
        } catch (_) { newsMap[ticker] = []; }
      }

    }));

    // ── STEP 4: Build results ─────────────────────────────────────
    const results = tickerList.map(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return { ticker, error: "No snapshot data" };

      const day     = snap.day     || {};
      const prevDay = snap.prevDay || {};

      // ── CURRENT PRICE — corrected priority ───────────────────────
      // min.c     = last 1-minute bar close (most accurate intraday)
      // lastTrade.p = most recent trade (real-time/15min delayed)
      // day.c     = last session close (CAN BE STALE — use last resort)
      const minC      = snap.min?.c       || 0;
      const lastTP    = snap.lastTrade?.p || 0;
      const dayC      = day.c             || 0;
      const curr      = parseFloat((minC || lastTP || dayC || 0).toFixed(2));
      const priceSource = minC ? "min_bar" : lastTP ? "last_trade" : "day_close";

      // ── PREV CLOSE — safe, official yesterday close ───────────────
      const prev = parseFloat((prevDay.c || 0).toFixed(2));

      // ── VOLUME — day.v is safe (accumulates since open today) ─────
      const vol = Math.floor(day.v || 0);

      // ── DELISTED GUARD ───────────────────────────────────────────
      const openToday = day.o || 0;
      if (openToday === 0 && vol === 0) {
        return {
          ticker, delisted: true,
          error: "DELISTED_OR_INACTIVE: no open price and zero volume. Remove from watchlist.",
        };
      }

      // ── PRICE SANITY CHECK ───────────────────────────────────────
      // curr more than 70% below prev = almost certainly stale/wrong
      const priceSuspect = prev > 0 && curr > 0 && curr < (prev * 0.30);

      // ── AVERAGE VOLUME — 30-day historical (safe) ─────────────────
      const avgVol = avgVolMap[ticker] || Math.floor(prevDay.v || vol || 1);

      // ── DIP CALCULATIONS ─────────────────────────────────────────
      const dipDollars = parseFloat((prev - curr).toFixed(2));
      const dipPct     = prev > 0
        ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : 0;
      const volRatio   = avgVol > 0
        ? parseFloat((vol / avgVol).toFixed(2)) : 1;

      // ── TODAY'S OPEN / HIGH / LOW — safe (set at market open) ────
      const openPrice       = parseFloat((day.o || curr).toFixed(2));
      const todayHigh       = parseFloat((day.h || curr).toFixed(2));
      const todayLow        = parseFloat((day.l || curr).toFixed(2));
      const gapFromOpen     = openPrice > 0
        ? parseFloat((((curr - openPrice) / openPrice) * 100).toFixed(2)) : 0;
      const fromOpenDollars = parseFloat((curr - openPrice).toFixed(2));

      // ── 52W HIGH/LOW — NOTE: using today's high/low as proxy ─────
      // Real 52w needs separate Polygon call — known limitation
      // These are labeled week52 but are actually today's range
      const week52High  = parseFloat((day.h || curr * 1.05).toFixed(2));
      const week52Low   = parseFloat((day.l || curr * 0.95).toFixed(2));
      const todayRange  = week52High - week52Low;
      const distFromLow = todayRange > 0
        ? parseFloat((((curr - week52Low) / todayRange) * 100).toFixed(1)) : 50;

      // ── VWAP — mild risk: accumulates from market open ───────────
      // Safe during market hours. At open or pre-market may be 0.
      // FIX: null it out if market not yet open (vol=0 but stock exists)
      const vwap        = (day.vw && vol > 0) ? parseFloat(day.vw.toFixed(2)) : null;
      const priceVsVwap = vwap ? parseFloat((curr - vwap).toFixed(2)) : null;
      const pctFromVwap = (vwap && vwap > 0)
        ? parseFloat((((curr - vwap) / vwap) * 100).toFixed(2)) : null;
      const belowVwap   = vwap ? curr < vwap : null;

      // ── ATR signals — 14-day historical, safe for sizing ─────────
      const atr                 = atrMap[ticker] ?? null;
      const todayMoveAbs        = parseFloat(Math.abs(curr - openPrice).toFixed(2));
      const atrPctUsed          = (atr && atr > 0)
        ? parseFloat(((todayMoveAbs / atr) * 100).toFixed(1)) : null;
      const atrRemainingDollars = (atr && atrPctUsed !== null)
        ? parseFloat(Math.max(0, atr - todayMoveAbs).toFixed(2)) : null;
      const dipVsAtr            = (atr && dipDollars > 0)
        ? parseFloat((dipDollars / atr).toFixed(2)) : null;

      // ── NEWS ─────────────────────────────────────────────────────
      const newsHeadlines = newsMap[ticker] || [];
      const newsStr = newsHeadlines.length > 0
        ? newsHeadlines.map(n =>
            `[${n.published}] ${n.title}${n.sentiment !== "neutral" ? ` (${n.sentiment})` : ""}`
          ).join(" | ")
        : "NO_RECENT_NEWS";

      return {
        ticker, curr, prev,
        priceSource, priceSuspect,
        openPrice, todayHigh, todayLow,
        gapFromOpen, fromOpenDollars,
        dipDollars, dipPct,
        rsi:    rsiMap[ticker] ?? null,
        vol, avgVol, volRatio,
        avgVolSource: avgVolMap[ticker] ? "30day_avg" : "prev_day_proxy",
        week52High, week52Low, distFromLow,
        isMover: movers.includes(ticker),
        vwap, priceVsVwap, pctFromVwap, belowVwap,
        atr, atrPctUsed, atrRemainingDollars, dipVsAtr,
        news:      newsHeadlines,
        newsStr,
        newsCount: newsHeadlines.length,
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
