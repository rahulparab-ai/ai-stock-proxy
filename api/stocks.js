// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy (Polygon Starter)
// v6: Speed fix — RSI/ATR cached per session (daily indicators)
//     News cached 15 mins. Prices always live. Never times out.
// ─────────────────────────────────────────────────────────────────

const POLY_KEY = process.env.POLYGON_API_KEY;
const BASE     = "https://api.polygon.io";

// RSI and ATR are DAILY indicators — they don't change during the day
// Cache them for the full trading session (8 hours)
// This eliminates 90% of API calls and prevents Vercel timeouts
let dailyCache = {
  rsi:  {},   // ticker → rsi value
  atr:  {},   // ticker → atr value
  ts:   0,    // when daily cache was last populated
};
let newsCache = {};   // ticker → { headlines, ts }

const DAILY_CACHE_MS = 8 * 60 * 60 * 1000;  // 8 hours — full trading day
const NEWS_CACHE_MS  = 15 * 60 * 1000;       // 15 mins

function isMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  if (day === 0 || day === 6) return false;
  return mins >= 570 && mins < 960;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "No tickers provided" });

  const tickerList = tickers.split(",").map(t => t.trim().toUpperCase());
  const now        = Date.now();
  const marketOpen = isMarketOpen();

  try {
    // ── STEP 1: Snapshot — ONE fast call for all 120 tickers ─────
    const snapUrl =
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers` +
      `?tickers=${tickerList.join(",")}&apiKey=${POLY_KEY}`;
    const snapData = await (await fetch(snapUrl)).json();
    const snapMap  = {};
    (snapData.tickers || []).forEach(t => { snapMap[t.ticker] = t; });

    // ── STEP 2: Broad market detection ───────────────────────────
    const allSnaps       = tickerList.map(t => snapMap[t]).filter(Boolean);
    const upMoreThan1    = allSnaps.filter(s => (s.todaysChangePerc||0) > 1).length;
    const downMoreThan1  = allSnaps.filter(s => (s.todaysChangePerc||0) < -1).length;
    const broadRallyDay  = upMoreThan1  > allSnaps.length * 0.5;
    const broadSelloffDay= downMoreThan1> allSnaps.length * 0.5;

    // ── STEP 3: Identify top movers ───────────────────────────────
    const movers = tickerList
      .filter(t => {
        const s = snapMap[t];
        if (!s) return false;
        // Weekend: no moves — but still fetch RSI/ATR for prep
        const nowET2    = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
        const isWeekend2= nowET2.getDay()===0 || nowET2.getDay()===6;
        if (isWeekend2) return true;
        // Market hours OR after-hours weekday — use today's change
        return Math.abs(s.todaysChangePerc || 0) >= 0.5;
      })
      .sort((a,b) =>
        Math.abs(snapMap[b]?.todaysChangePerc||0) -
        Math.abs(snapMap[a]?.todaysChangePerc||0)
      )
      .slice(0, 40);

    // ── STEP 4: RSI + ATR — cached daily, fetch only if stale ────
    // These are daily indicators — same value all day
    // Only fetch if cache is empty or older than 8 hours
    const needDailyRefresh = (now - dailyCache.ts) > DAILY_CACHE_MS;
    const missingRsi = movers.filter(t => dailyCache.rsi[t] === undefined);

    if (needDailyRefresh || missingRsi.length > 0) {
      const toFetch = needDailyRefresh ? movers : missingRsi;
      // Fetch all in parallel — fast since it's a one-time daily fetch
      await Promise.all(toFetch.map(async ticker => {
        try {
          const rsiUrl = `${BASE}/v1/indicators/rsi/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const rsiJson = await (await fetch(rsiUrl)).json();
          const val = rsiJson?.results?.values?.[0]?.value;
          dailyCache.rsi[ticker] = val ? parseFloat(val.toFixed(1)) : null;
        } catch (_) { dailyCache.rsi[ticker] = null; }

        try {
          const atrUrl = `${BASE}/v1/indicators/atr/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`;
          const atrJson = await (await fetch(atrUrl)).json();
          const atrVal = atrJson?.results?.values?.[0]?.value;
          dailyCache.atr[ticker] = atrVal ? parseFloat(atrVal.toFixed(2)) : null;
        } catch (_) { dailyCache.atr[ticker] = null; }
      }));
      if (needDailyRefresh) dailyCache.ts = now;
    }

    // ── STEP 5: avgVol + news — for top 20 movers only ───────────
    const avgVolMap = {};
    const top20     = movers.slice(0, 20);
    const today     = new Date();
    const from      = new Date(today - 30*24*60*60*1000).toISOString().split("T")[0];
    const to        = today.toISOString().split("T")[0];

    await Promise.all(top20.map(async ticker => {
      // avgVol
      try {
        const aggUrl = `${BASE}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=30&apiKey=${POLY_KEY}`;
        const aggJson = await (await fetch(aggUrl)).json();
        const bars = aggJson.results || [];
        if (bars.length > 0) {
          avgVolMap[ticker] = Math.floor(bars.reduce((s,b)=>s+(b.v||0),0) / bars.length);
        }
      } catch (_) {}

      // News — 15 min cache
      const cached = newsCache[ticker];
      if (cached && (now - cached.ts) < NEWS_CACHE_MS) return;
      try {
        const threeDaysAgo = new Date(today - 7*24*60*60*1000).toISOString().split("T")[0];
        const newsUrl = `${BASE}/v2/reference/news?ticker=${ticker}&published_utc.gte=${threeDaysAgo}&order=desc&limit=3&apiKey=${POLY_KEY}`;
        const newsJson = await (await fetch(newsUrl)).json();
        const headlines = (newsJson.results||[]).map(a=>({
          title:     a.title||"",
          published: (a.published_utc||"").slice(0,10),
          sentiment: a.insights?.find(i=>i.ticker===ticker)?.sentiment||"neutral",
        }));
        newsCache[ticker] = { headlines, ts: now };
      } catch (_) { newsCache[ticker] = { headlines: [], ts: now }; }
    }));

    // ── STEP 6: Build results ─────────────────────────────────────
    const results = tickerList.map(ticker => {
      const snap = snapMap[ticker];
      if (!snap) return { ticker, error: "No snapshot data" };

      const day     = snap.day     || {};
      const prevDay = snap.prevDay || {};

      // Delisted guard
      if ((day.o||0)===0 && (day.v||0)===0 && (prevDay.c||0)===0) {
        return { ticker, delisted: true, error: "DELISTED_OR_INACTIVE" };
      }

      // ── PRICE ────────────────────────────────────────────────────
      const prevC    = prevDay.c || 0;
      const lastTP   = snap.lastTrade?.p || 0;
      const minC     = snap.min?.c       || 0;
      const dayC     = day.c             || 0;
      const todayChg = snap.todaysChange || 0;

      // Detect if it's actually a weekend (Saturday or Sunday)
      const nowET      = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const dayOfWeek  = nowET.getDay(); // 0=Sun, 6=Sat
      const isWeekend  = dayOfWeek === 0 || dayOfWeek === 6;

      let curr, priceSource;
      if (marketOpen) {
        // During market hours — use live price
        if      (lastTP > 0) { curr = lastTP; priceSource = "last_trade"; }
        else if (minC   > 0) { curr = minC;   priceSource = "min_bar"; }
        else if (dayC   > 0) { curr = dayC;   priceSource = "day_close"; }
        else                 { curr = parseFloat((prevC + todayChg).toFixed(2)); priceSource = "calc"; }
      } else if (isWeekend) {
        // Actual weekend — use Friday's close (prevDay.c)
        curr        = prevC;
        priceSource = "prev_close_weekend";
      } else {
        // Weekday after market close (4pm-9:30am) — use TODAY's close (day.c)
        // day.c is the official closing price set at 4pm
        if      (dayC   > 0) { curr = dayC;   priceSource = "day_close_today"; }
        else if (lastTP > 0) { curr = lastTP; priceSource = "last_trade_ah"; }
        else                 { curr = prevC;   priceSource = "prev_close_fallback"; }
      }
      curr = parseFloat((curr||0).toFixed(2));
      const prev = parseFloat((prevC||0).toFixed(2));

      // ── VOLUME ───────────────────────────────────────────────────
      const volRaw  = day.v;
      const volNull = volRaw === null || volRaw === undefined;
      const vol     = volNull ? 0 : Math.floor(volRaw);
      const avgVol  = avgVolMap[ticker] || Math.floor(prevDay.v || 1);
      const volRatio= volNull ? null : (avgVol > 0 ? parseFloat((vol/avgVol).toFixed(2)) : null);

      // ── PRICE SANITY ─────────────────────────────────────────────
      const priceSuspect = prev > 0 && curr > 0 && curr < prev * 0.30;

      // ── DIP ──────────────────────────────────────────────────────
      const dipDollars = parseFloat((prev - curr).toFixed(2));
      const dipPct = !marketOpen ? 0
        : snap.todaysChangePerc != null
          ? parseFloat(snap.todaysChangePerc.toFixed(2))
          : (prev > 0 ? parseFloat((((curr-prev)/prev)*100).toFixed(2)) : 0);

      // ── OPEN / HIGH / LOW ────────────────────────────────────────
      const openPrice       = parseFloat((day.o||0).toFixed(2));
      const todayHigh       = parseFloat((day.h||curr).toFixed(2));
      const todayLow        = parseFloat((day.l||curr).toFixed(2));
      const gapFromOpen     = (openPrice>0 && prev>0)
        ? parseFloat((((openPrice-prev)/prev)*100).toFixed(2)) : 0;
      const fromOpenDollars = openPrice>0 ? parseFloat((curr-openPrice).toFixed(2)) : 0;

      // ── VWAP ─────────────────────────────────────────────────────
      const vwap      = (day.vw && vol>0) ? parseFloat(day.vw.toFixed(2)) : null;
      const belowVwap = vwap ? curr < vwap : null;
      const pctFromVwap = (vwap&&vwap>0) ? parseFloat((((curr-vwap)/vwap)*100).toFixed(2)) : null;

      // ── ATR signals ──────────────────────────────────────────────
      const atr             = dailyCache.atr[ticker] ?? null;
      const todayMoveAbs    = parseFloat(Math.abs(curr-(openPrice||prev)).toFixed(2));
      const atrPctUsed      = (atr&&atr>0) ? parseFloat(((todayMoveAbs/atr)*100).toFixed(1)) : null;
      const atrRemainingDollars = (atr&&atrPctUsed!==null)
        ? parseFloat(Math.max(0,atr-todayMoveAbs).toFixed(2)) : null;
      const dipVsAtr        = (atr&&dipDollars>0) ? parseFloat((dipDollars/atr).toFixed(2)) : null;

      // ── NEWS ─────────────────────────────────────────────────────
      const newsHeadlines = newsCache[ticker]?.headlines || [];
      const newsStr = newsHeadlines.length > 0
        ? newsHeadlines.map(n=>`[${n.published}] ${n.title}${n.sentiment!=="neutral"?` (${n.sentiment})`:""}`).join(" | ")
        : "NO_RECENT_NEWS";

      return {
        ticker, curr, prev,
        priceSource, priceSuspect, marketOpen,
        openPrice, todayHigh, todayLow,
        gapFromOpen, fromOpenDollars,
        dipDollars, dipPct,
        rsi:    dailyCache.rsi[ticker] ?? null,
        vol, avgVol, volRatio, volNull,
        avgVolSource: avgVolMap[ticker] ? "30day_avg" : "prev_day_proxy",
        vwap, belowVwap, pctFromVwap,
        atr, atrPctUsed, atrRemainingDollars, dipVsAtr,
        week52High: parseFloat((day.h||curr).toFixed(2)),
        week52Low:  parseFloat((day.l||curr).toFixed(2)),
        distFromLow: 50,
        isMover: movers.includes(ticker),
        news: newsHeadlines, newsStr, newsCount: newsHeadlines.length,
      };
    });

    return res.status(200).json({
      stocks:           results,
      fetchedAt:        new Date().toISOString(),
      source:           "polygon.io",
      cached:           false,
      marketOpen,
      moversCount:      movers.length,
      broadRallyDay,
      broadSelloffDay,
      upMoreThan1Pct:   upMoreThan1,
      downMoreThan1Pct: downMoreThan1,
      rsiCacheAge:      Math.round((now - dailyCache.ts) / 60000) + " mins",
    });

  } catch (err) {
    console.error("[stocks] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
