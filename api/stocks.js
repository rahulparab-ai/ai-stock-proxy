// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Stock Data Proxy
// Fetches real price + RSI + volume from Alpha Vantage
// Deployed free on Vercel. Called by your browser app.
// ─────────────────────────────────────────────────────────────────

const AV_KEY = process.env.ALPHA_VANTAGE_KEY; // set in Vercel dashboard

export default async function handler(req, res) {
  // Allow your browser app to call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "No tickers provided" });

  const tickerList = tickers.split(",").map((t) => t.trim().toUpperCase());

  // Alpha Vantage free tier: 25 calls/day, 5 calls/min
  // We batch smartly — 1 call per ticker for quote, 1 for RSI
  const results = [];

  for (const ticker of tickerList) {
    try {
      // ── 1. Get current price + volume ──────────────────────────
      const quoteUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${AV_KEY}`;
      const quoteRes = await fetch(quoteUrl);
      const quoteData = await quoteRes.json();
      const q = quoteData["Global Quote"];

      if (!q || !q["05. price"]) {
        results.push({ ticker, error: "No data" });
        continue;
      }

      const curr        = parseFloat(q["05. price"]);
      const prev        = parseFloat(q["08. previous close"]);
      const dipDollars  = parseFloat((prev - curr).toFixed(2));
      const dipPct      = parseFloat((((curr - prev) / prev) * 100).toFixed(2));
      const vol         = parseInt(q["06. volume"]);
      const avgVol      = parseInt(q["10. 10 day average volume"] || vol); // fallback

      // ── 2. Get RSI (14-period daily) ───────────────────────────
      const rsiUrl = `https://www.alphavantage.co/query?function=RSI&symbol=${ticker}&interval=daily&time_period=14&series_type=close&apikey=${AV_KEY}`;
      const rsiRes = await fetch(rsiUrl);
      const rsiData = await rsiRes.json();
      const rsiValues = rsiData["Technical Analysis: RSI"];
      const latestRsiKey = rsiValues ? Object.keys(rsiValues)[0] : null;
      const rsi = latestRsiKey
        ? parseFloat(rsiValues[latestRsiKey]["RSI"])
        : null;

      // ── 3. Get 52-week high/low ────────────────────────────────
      const overviewUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${AV_KEY}`;
      const overviewRes = await fetch(overviewUrl);
      const overviewData = await overviewRes.json();
      const week52High = parseFloat(overviewData["52WeekHigh"] || curr * 1.3);
      const week52Low  = parseFloat(overviewData["52WeekLow"]  || curr * 0.7);
      const distFromLow = parseFloat(
        (((curr - week52Low) / (week52High - week52Low)) * 100).toFixed(1)
      );

      results.push({
        ticker,
        curr,
        prev,
        dipDollars,
        dipPct,
        vol,
        avgVol,
        volRatio: parseFloat((vol / avgVol).toFixed(2)),
        rsi,
        week52High,
        week52Low,
        distFromLow,
      });

      // Respect Alpha Vantage rate limit (5 calls/min on free tier)
      await new Promise((r) => setTimeout(r, 13000)); // ~13s between tickers

    } catch (err) {
      results.push({ ticker, error: err.message });
    }
  }

  return res.status(200).json({ stocks: results, fetchedAt: new Date().toISOString() });
}
