// ─────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Volatile Sweet Spot Scanner v4
// Uses snapshot day range as ATR proxy across ~500 tickers
// Divided into batches to stay within Polygon Starter limits
// GET /api/volatility?minPrice=150&maxPrice=1200&minAtr=15&maxAtr=60
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

// ── UNIVERSE — 500+ tickers across all sectors ──────────────────
// Deliberately includes stocks OUTSIDE the user's 120 watchlist
// Covers: leveraged ETFs, biotech, financials, consumer, energy, 
// industrials, media, retail — not just semiconductors
const UNIVERSE = [
  // User's 120 watchlist (for comparison)
  "NVDA","AMD","MRVL","QCOM","ARM","AVGO","AMAT","LRCX","KLAC","ASML",
  "MU","TSM","INTC","TXN","ADI","SNPS","CDNS","CRWD","PANW","ZS","NET",
  "MSFT","AAPL","AMZN","GOOGL","META","TSLA","ORCL","CRM","NOW","ADBE",
  "IBM","ANET","SMCI","DELL","VRT","COIN","PLTR","RDDT","GEV","VST","CEG",
  "WDC","STX","COHR","ENTG","TER","ONTO","ACLS","WOLF","LIN","KLIC","TTMI",
  "ALAB","CRDO","AMBA","MBLY","IONQ","RGTI","QUBT","APLD","CORZ","IREN",
  // Leveraged ETFs — extremely high ATR
  "NVDL","NVDU","NVDD","TSLL","TSLS","TQQQ","SQQQ","UPRO","SPXU","UDOW",
  "LABU","LABD","CURE","NAIL","TNA","TZA","WEBL","WEBS","DPST","DFEN",
  "WANT","RETL","PILL","AMZU","AMZD","MSFU","MSFD","GOGU","GOGD",
  "MUU","MUD","AMDU","ORBU","SPXL","SPXS","TECL","TECS","SOXL","SOXS",
  "FAS","FAZ","ERX","ERY","GUSH","DRIP","JNUG","JDST","DUST","NUGT",
  // Big cap tech not in watchlist
  "NFLX","SHOP","UBER","LYFT","SNAP","PINS","TWLO","ROKU","SPOT","RBLX",
  "HOOD","SOFI","AFRM","UPST","OPEN","DKNG","PENN","MGM","LVS","WYNN",
  "SQ","PYPL","V","MA","ACLX","INTU","ADSK","ANSS","CDNS","CTSH",
  // Biotech/Pharma — high ATR names
  "MRNA","BNTX","REGN","BIIB","VRTX","ALNY","SGEN","BMRN","RARE","BLUE",
  "CRSP","EDIT","NTLA","BEAM","FATE","KYMR","RXRX","ARWR","ALLO","IMVT",
  "ARGX","ACAD","SAGE","INVA","ITCI","ACMR","FIXX","FOLD","PTGX","RCUS",
  // Financial/Banks
  "JPM","BAC","GS","MS","C","WFC","BLK","SCHW","COF","AXP",
  "IBKR","LPLA","RJF","PIPR","HLI","EVR","LAZ","PJT","MC","MKTX",
  // Energy
  "XOM","CVX","COP","SLB","HAL","BKR","DVN","MPC","PSX","VLO",
  "OXY","PXD","EOG","FANG","CTRA","AR","EQT","RRC","CNX","CHK",
  // Consumer/Retail
  "AMZN","TGT","WMT","COST","HD","LOW","TJX","ROST","LULU","NKE",
  "DECK","ONON","SKX","CROX","BOOT","WEBR","RH","WSM","BBWI","PVH",
  // Media/Entertainment
  "DIS","NFLX","PARA","WBD","FOX","FOXA","LSXMA","SIRI","IMAX","AMC",
  // Industrials
  "BA","RTX","LMT","GE","HON","MMM","CAT","DE","EMR","ETN",
  "FTV","ROP","IDEX","IEX","AME","GNRC","FELE","REXR","TREX","NVR",
  // Chinese ADRs — high volatility
  "BABA","JD","PDD","BIDU","NIO","LI","XPEV","DIDI","YUMC","TAL",
  // Healthcare
  "UNH","CVS","CI","HUM","MOH","ELV","CNC","HCA","THC","UHS",
  // Real estate / data centers
  "AMT","EQIX","DLR","CCI","SBAC","CONE","QTS","CBRE","CSGP","VICI",
  // Misc high-movers
  "GME","AMC","BBBY","SPCE","NKLA","RIDE","GOEV","WKHS","FSR","HYLN",
  "MSTR","RIOT","MARA","HUT","BITF","CLSK","BTBT","SOS","CAN","EBON",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const minPrice = parseFloat(req.query.minPrice || 150);
  const maxPrice = parseFloat(req.query.maxPrice || 1200);
  const minAtr   = parseFloat(req.query.minAtr   || 15);
  const maxAtr   = parseFloat(req.query.maxAtr   || 60);
  const cacheKey = `${minPrice}-${maxPrice}-${minAtr}-${maxAtr}`;
  const now      = Date.now();

  if (cache.data && cache.key === cacheKey && (now - cache.ts) < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try {
    // ── Fetch gainers + losers (active movers today) ──────────────
    const [gainersResp, losersResp] = await Promise.all([
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLY_KEY}`),
      fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${POLY_KEY}`),
    ]);
    const gainersJson = await gainersResp.json();
    const losersJson  = await losersResp.json();

    // ── Fetch universe in batches of 100 ─────────────────────────
    const unique = [...new Set(UNIVERSE.filter(isRealStock))];
    const batches = [];
    for (let i = 0; i < unique.length; i += 100) {
      batches.push(unique.slice(i, i + 100));
    }
    const batchResponses = await Promise.all(
      batches.map(b =>
        fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${b.join(",")}&apiKey=${POLY_KEY}`)
          .then(r => r.json())
      )
    );
    const universeSnaps = batchResponses.flatMap(r => r.tickers || []);

    // ── Combine + deduplicate ─────────────────────────────────────
    const seen = new Set();
    const allSnaps = [
      ...(gainersJson.tickers || []),
      ...(losersJson.tickers  || []),
      ...universeSnaps,
    ].filter(s => {
      if (!s.ticker || seen.has(s.ticker)) return false;
      seen.add(s.ticker);
      return true;
    });

    // ── Filter by price + day range ───────────────────────────────
    const qualifying = allSnaps
      .filter(s => {
        const price    = s.day?.c || s.lastTrade?.p || s.prevDay?.c || 0;
        const dayHigh  = s.day?.h || 0;
        const dayLow   = s.day?.l || 0;
        const dayRange = dayHigh - dayLow;
        const vol      = s.day?.v || 0;
        if (!isRealStock(s.ticker))               return false;
        if (price < minPrice || price > maxPrice) return false;
        if (vol < 100000)                         return false;
        if (dayRange < minAtr || dayRange > maxAtr) return false;
        return true;
      })
      .map(s => {
        const price    = s.day?.c || s.lastTrade?.p || s.prevDay?.c || 0;
        const dayHigh  = s.day?.h || 0;
        const dayLow   = s.day?.l || 0;
        const dayRange = parseFloat((dayHigh - dayLow).toFixed(2));
        const chgPct   = s.todaysChangePerc || 0;
        const vol      = s.day?.v || 0;
        const prevVol  = s.prevDay?.v || 1;
        return {
          ticker:   s.ticker,
          curr:     parseFloat(price.toFixed(2)),
          atr:      dayRange,
          dipPct:   parseFloat(chgPct.toFixed(2)),
          vol:      Math.floor(vol),
          volRatio: prevVol > 0 ? parseFloat((vol/prevVol).toFixed(2)) : null,
          high:     parseFloat(dayHigh.toFixed(2)),
          low:      parseFloat(dayLow.toFixed(2)),
          rsi:      null,
        };
      })
      .sort((a, b) => (b.atr || 0) - (a.atr || 0));

    const result = {
      stocks:    qualifying,
      count:     qualifying.length,
      scanned:   allSnaps.length,
      universe:  unique.length,
      minPrice, maxPrice, minAtr, maxAtr,
      note: "ATR = today's day range (H-L). Covers "+unique.length+" tickers incl leveraged ETFs, biotech, financials.",
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
