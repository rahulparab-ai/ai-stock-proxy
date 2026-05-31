// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy (Polygon Starter)
// v5: Correct price logic for Starter plan + weekend/Monday handling
//
// PRICE STRATEGY (Polygon Starter plan):
//   Market open (9:30am–4pm ET):
//     lastTrade.p  → most recent trade price (real, 15-min delayed)
//     min.c        → last 1-min bar close (most accurate intraday)
//     day.c        → intraday running close (fallback)
//
//   Weekend / market closed:
//     prevDay.c    → Friday's official close (always correct)
//     todaysChange = 0, dipPct = 0 (no change until Monday open)
//
//   Monday 9:30am first scan:
//     day.o        → Monday's open price (set at bell)
//     gapFromOpen  → Monday open vs Friday close = gap signal
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// News cached 15 mins — prices always live, no price cache
let newsCache   = {};
const NEWS_CACHE_MS = 15 * 60 * 1000;

// Detect if US market is currently open
function isMarketOpen() {
  const now = new Date();
  // Convert to ET
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay(); // 0=Sun, 6=Sat
  const hour = et.getHours();
  const min  = et.getMinutes();
  const mins = hour * 60 + min;
  if (day === 0 || day === 6) return false;          // weekend
  return mins >= 570 && mins < 960;                  // 9:30am–4:00pm ET
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "No tickers provided" });

  const tickerList  = tickers.split(",").map(t => t.trim().toUpperCase());
  const now         = Date.now();
  const marketOpen  = isMarketOpen();

  try {
    // ── STEP 1: Snapshot ─────────────────────────────────────────
    const snapUrl =
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers` +
      `?tickers=${tickerList.join(",")}&apiKey=${POLY_KEY}`;
    const snapData = await (await fetch(snapUrl)).json();
    const snapMap  = {};
    (snapData.tickers || []).forEach(t => { snapMap[t.ticker] = t; });

    // ── STEP 2: Date range for avgVol ────────────────────────────
    const today = new Date();
    const from  = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to    = today.toISOString().split("T")[0];

    // ── STEP 3: Identify movers using todaysChangePerc ────────────
    const movers = tickerList.filter(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return false;
      // Weekend: nothing is moving — still fetch RSI/ATR for all
      if (!marketOpen) return true;
      const changePct = snap.todaysChangePerc || 0;
      return Math.abs(changePct) >= 0.5;
    });

    // ── STEP 4: RSI + ATR + avgVol + NEWS in parallel ────────────
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

      // ATR
      try {
        const atrUrl =
          `${BASE}/v1/indicators/atr/${ticker}` +
          `?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
        const atrJson = await (await fetch(atrUrl)).json();
        const atrVal  = atrJson?.results?.values?.[0]?.value;
        atrMap[ticker] = atrVal ? parseFloat(atrVal.toFixed(2)) : null;
      } catch (_) { atrMap[ticker] = null; }

      // avgVol — 30-day historical
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

      // News — 15-min cache
      const cached = newsCache[ticker];
      if (cached && (now - cached.ts) < NEWS_CACHE_MS) {
        newsMap[ticker] = cached.headlines;
      } else {
        try {
          const threeDaysAgo = new Date(today - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
          const newsUrl =
            `${BASE}/v2/reference/news` +
            `?ticker=${ticker}&published_utc.gte=${threeDaysAgo}&order=desc&limit=2&apiKey=${POLY_KEY}`;
          const newsJson = await (await fetch(newsUrl)).json();
          const articles  = newsJson.results || [];
          const headlines = articles.map(a => ({
            title:     a.title || "",
            published: a.published_utc ? a.published_utc.slice(0, 10) : "",
            sentiment: a.insights?.find(i => i.ticker === ticker)?.sentiment || "neutral",
          }));
          newsMap[ticker] = headlines;
          newsCache[ticker] = { headlines, ts: now };
        } catch (_) { newsMap[ticker] = []; }
      }
    }));

    // ── STEP 5: Build results ─────────────────────────────────────
    const results = tickerList.map(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return { ticker, error: "No snapshot data" };

      const day     = snap.day     || {};
      const prevDay = snap.prevDay || {};

      // ── DELISTED GUARD ───────────────────────────────────────────
      if ((day.o || 0) === 0 && (day.v || 0) === 0 && (prevDay.c || 0) === 0) {
        return { ticker, delisted: true,
          error: "DELISTED_OR_INACTIVE: no data at all. Remove from watchlist." };
      }

      // ── CURRENT PRICE ────────────────────────────────────────────
      // Starter plan field priority:
      //   Market open:  lastTrade.p > min.c > day.c > (prevDay.c + todaysChange)
      //   Market closed / weekend: prevDay.c (Friday close)
      let curr, priceSource;

      const lastTP   = snap.lastTrade?.p  || 0;
      const minC     = snap.min?.c        || 0;
      const dayC     = day.c              || 0;
      const prevC    = prevDay.c          || 0;
      const todayChg = snap.todaysChange  || 0;

      if (marketOpen) {
        if (lastTP > 0)       { curr = lastTP; priceSource = "last_trade"; }
        else if (minC > 0)    { curr = minC;   priceSource = "min_bar"; }
        else if (dayC > 0)    { curr = dayC;   priceSource = "day_close"; }
        else if (prevC > 0)   { curr = parseFloat((prevC + todayChg).toFixed(2)); priceSource = "calc_from_change"; }
        else                  { curr = 0;      priceSource = "unknown"; }
      } else {
        // Weekend or after hours — use Friday's official close
        curr        = prevC;
        priceSource = "prev_close_weekend";
      }
      curr = parseFloat((curr || 0).toFixed(2));

      // ── PREV CLOSE (Friday close or yesterday) ───────────────────
      const prev = parseFloat((prevC || 0).toFixed(2));

      // ── VOLUME ───────────────────────────────────────────────────
      const vol    = Math.floor(day.v || 0);
      const avgVol = avgVolMap[ticker] || Math.floor(prevDay.v || vol || 1);

      // ── PRICE SANITY ─────────────────────────────────────────────
      const priceSuspect = prev > 0 && curr > 0 && curr < (prev * 0.30);

      // ── DIP CALCULATION ──────────────────────────────────────────
      // Weekend: dipPct = 0 (no change until Monday open)
      // Market open: use todaysChangePerc directly (most accurate)
      const dipDollars = parseFloat((prev - curr).toFixed(2));
      let dipPct;
      if (!marketOpen) {
        dipPct = 0; // weekend — no change
      } else {
        dipPct = snap.todaysChangePerc !== null && snap.todaysChangePerc !== undefined
          ? parseFloat((snap.todaysChangePerc).toFixed(2))
          : (prev > 0 ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : 0);
      }

      const volRatio = avgVol > 0 ? parseFloat((vol / avgVol).toFixed(2)) : 1;

      // ── OPEN / HIGH / LOW ────────────────────────────────────────
      // Weekend: day.o will be 0 (market hasn't opened)
      // Monday 9:30am+: day.o = Monday's open → gap vs Friday close
      const openPrice       = parseFloat((day.o || 0).toFixed(2));
      const todayHigh       = parseFloat((day.h || curr).toFixed(2));
      const todayLow        = parseFloat((day.l || curr).toFixed(2));

      // gapFromOpen = Monday open vs Friday close (the real gap signal)
      const gapFromOpen     = (openPrice > 0 && prev > 0)
        ? parseFloat((((openPrice - prev) / prev) * 100).toFixed(2)) : 0;
      const fromOpenDollars = openPrice > 0
        ? parseFloat((curr - openPrice).toFixed(2)) : 0;

      // ── VWAP ─────────────────────────────────────────────────────
      const vwap        = (day.vw && vol > 0) ? parseFloat(day.vw.toFixed(2)) : null;
      const priceVsVwap = vwap ? parseFloat((curr - vwap).toFixed(2)) : null;
      const pctFromVwap = (vwap && vwap > 0)
        ? parseFloat((((curr - vwap) / vwap) * 100).toFixed(2)) : null;
      const belowVwap   = vwap ? curr < vwap : null;

      // ── ATR ──────────────────────────────────────────────────────
      const atr                 = atrMap[ticker] ?? null;
      const todayMoveAbs        = parseFloat(Math.abs(curr - (openPrice || prev)).toFixed(2));
      const atrPctUsed          = (atr && atr > 0)
        ? parseFloat(((todayMoveAbs / atr) * 100).toFixed(1)) : null;
      const atrRemainingDollars = (atr && atrPctUsed !== null)
        ? parseFloat(Math.max(0, atr - todayMoveAbs).toFixed(2)) : null;
      const dipVsAtr            = (atr && dipDollars > 0)
        ? parseFloat((dipDollars / atr).toFixed(2)) : null;

      // ── 52W — today's high/low proxy (known limitation) ──────────
      const week52High  = parseFloat((day.h || curr).toFixed(2));
      const week52Low   = parseFloat((day.l || curr).toFixed(2));
      const todayRange  = week52High - week52Low;
      const distFromLow = todayRange > 0
        ? parseFloat((((curr - week52Low) / todayRange) * 100).toFixed(1)) : 50;

      // ── NEWS ─────────────────────────────────────────────────────
      const newsHeadlines = newsMap[ticker] || [];
      const newsStr = newsHeadlines.length > 0
        ? newsHeadlines.map(n =>
            `[${n.published}] ${n.title}${n.sentiment !== "neutral" ? ` (${n.sentiment})` : ""}`
          ).join(" | ")
        : "NO_RECENT_NEWS";

      return {
        ticker, curr, prev,
        priceSource, priceSuspect, marketOpen,
        openPrice, todayHigh, todayLow,
        gapFromOpen, fromOpenDollars,
        dipDollars, dipPct,
        rsi:    rsiMap[ticker] ?? null,
        vol, avgVol, volRatio,
        avgVolSource: avgVolMap[ticker] ? "30day_avg" : "prev_day_proxy",
        vwap, priceVsVwap, pctFromVwap, belowVwap,
        atr, atrPctUsed, atrRemainingDollars, dipVsAtr,
        week52High, week52Low, distFromLow,
        isMover: movers.includes(ticker),
        news: newsHeadlines, newsStr, newsCount: newsHeadlines.length,
      };
    });

    return res.status(200).json({
      stocks:      results,
      fetchedAt:   new Date().toISOString(),
      source:      "polygon.io",
      cached:      false,
      marketOpen,
      moversCount: movers.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
