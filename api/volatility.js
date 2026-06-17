// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Volatile Sweet Spot Scanner v2
// Uses Polygon snapshot + ATR to find volatile stocks in price range
// GET /api/volatility?minPrice=150&maxPrice=300&minAtr=15&maxAtr=20
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
    // ── STEP 1: Get gainers + losers snapshots for active stocks ──
    // These are the most actively moving stocks — best candidates
    const [gainersResp, losersResp] = await Promise.all([
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLY_KEY}`),
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${POLY_KEY}`),
    ]);
    const gainersJson = await gainersResp.json();
    const losersJson  = await losersResp.json();

    const allSnaps = [
      ...(gainersJson.tickers || []),
      ...(losersJson.tickers  || []),
    ];

    // ── STEP 2: Also get snapshots for a broader set of tickers ──
    // Use popular semiconductor + AI + tech tickers beyond our 120
    const BROAD_TICKERS = [
      // High-price semiconductors and tech likely in $150-$300 range
      "NVDA","AMD","MRVL","QCOM","ARM","AVGO","AMAT","LRCX","KLAC","ASML",
      "MU","TSM","INTC","TXN","ADI","MCHP","ON","NXPI","STM","SWKS",
      "SNPS","CDNS","CRWD","PANW","ZS","NET","DDOG","SNOW","PLTR","COIN",
      "MSFT","AAPL","AMZN","GOOGL","META","TSLA","ORCL","CRM","NOW","ADBE",
      "IBM","ANET","CSCO","DELL","HPE","VRT","SMCI","RDDT","GTLB","MDB",
      "HUBS","PATH","ISRG","GEV","VST","CEG","ETN","ROK","SYM","IONQ",
      "RGTI","QUBT","APLD","CORZ","IREN","WULF","WDC","STX","SNDK","COHR",
      "ASX","AMKR","KLIC","TTMI","ALAB","CRDO","AMBA","MBLY","INDI","AXTI",
      "ENTG","WOLF","LIN","APD","DD","MTRN","TER","ONTO","ACLS","AZTA",
      "VECO","UCTT","ICHR","COHU","PLAB","RMBS","CEVA","IDCC","CBRS","GFS",
      "UMC","TSEM","MPWR","MTSI","LSCC","SLAB","SMTC","CRUS","ALGM","MXL",
      // Additional high-volatility stocks commonly in this range
      "NFLX","SHOP","SQ","ROKU","UBER","LYFT","SNAP","PINS","TWLO","ZM",
      "DOCU","OKTA","SPLK","ESTC","DDOG","PD","COUP","VEEV","HUBS","BILL",
      "CFLT","GTLB","FRSH","BRZE","S","ASAN","DBX","BOX","DOCN","DT",
    ];

    // Fetch snapshot for broad list
    const chunks = [];
    for (let i = 0; i < BROAD_TICKERS.length; i += 50) {
      chunks.push(BROAD_TICKERS.slice(i, i + 50));
    }
    const snapResponses = await Promise.all(
      chunks.map(chunk =>
        fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${chunk.join(",")}&apiKey=${POLY_KEY}`)
          .then(r => r.json())
      )
    );
    const broadSnaps = snapResponses.flatMap(r => r.tickers || []);

    // Combine all snapshots, deduplicate
    const seen = new Set();
    const combined = [...allSnaps, ...broadSnaps].filter(s => {
      if (!s.ticker || seen.has(s.ticker)) return false;
      seen.add(s.ticker);
      return true;
    });

    // ── STEP 3: Filter by price range ────────────────────────────
    const priceFiltered = combined.filter(s => {
      const price = s.day?.c || s.lastTrade?.p || s.prevDay?.c || 0;
      const vol   = s.day?.v || 0;
      if (!isRealStock(s.ticker)) return false;
      if (price < minPrice || price > maxPrice) return false;
      if (vol < 200000) return false;
      return true;
    });

    if (priceFiltered.length === 0) {
      return res.status(200).json({
        stocks: [], count: 0, scanned: combined.length,
        message: `No stocks found in $${minPrice}-$${maxPrice} range from ${combined.length} candidates`,
        fetchedAt: new Date().toISOString()
      });
    }

    // ── STEP 4: Fetch ATR + RSI for price-filtered stocks ────────
    const atrResults = await Promise.all(
      priceFiltered.map(async snap => {
        const ticker = snap.ticker;
        const price  = snap.day?.c || snap.lastTrade?.p || snap.prevDay?.c || 0;
        const vol    = snap.day?.v || 0;
        const chgPct = snap.todaysChangePerc || 0;

        try {
          const [atrResp, rsiResp] = await Promise.all([
            fetch(`${BASE}/v1/indicators/atr/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`),
            fetch(`${BASE}/v1/indicators/rsi/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLY_KEY}`),
          ]);
          const atrJson = await atrResp.json();
          const rsiJson = await rsiResp.json();
          const atr = atrJson?.results?.values?.[0]?.value;
          const rsi = rsiJson?.results?.values?.[0]?.value;

          return {
            ticker,
            curr:   parseFloat(price.toFixed(2)),
            atr:    atr ? parseFloat(parseFloat(atr).toFixed(2)) : null,
            rsi:    rsi ? parseFloat(parseFloat(rsi).toFixed(1)) : null,
            vol:    Math.floor(vol),
            dipPct: parseFloat(chgPct.toFixed(2)),
            high:   snap.day?.h || price,
            low:    snap.day?.l || price,
            dayRange: snap.day?.h && snap.day?.l ? parseFloat((snap.day.h - snap.day.l).toFixed(2)) : null,
          };
        } catch (_) {
          return { ticker, curr: price, atr: null, rsi: null, vol, dipPct: chgPct };
        }
      })
    );

    // ── STEP 5: Filter by ATR range, sort by ATR desc ────────────
    const qualifying = atrResults
      .filter(s => s.atr !== null && s.atr >= minAtr && s.atr <= maxAtr)
      .sort((a, b) => (b.atr || 0) - (a.atr || 0));

    const result = {
      stocks:   qualifying,
      count:    qualifying.length,
      scanned:  priceFiltered.length,
      total:    combined.length,
      minPrice, maxPrice, minAtr, maxAtr,
      fetchedAt: new Date().toISOString(),
      cached:   false,
    };

    cache = { data: result, ts: now, key: cacheKey };
    return res.status(200).json(result);

  } catch (err) {
    console.error("[Volatility] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
