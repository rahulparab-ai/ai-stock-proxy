// api/claude.js — Vercel Serverless Function
// Proxies Claude API calls from browser

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  // ── Step 1: Check key exists ──────────────────────────
  if (!CLAUDE_KEY) {
    return res.status(500).json({ 
      error: { message: "ANTHROPIC_API_KEY missing from Vercel env vars" }
    });
  }

  // ── Step 2: Get body ──────────────────────────────────
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch(e) {
      return res.status(400).json({ error: { message: "Bad JSON: " + e.message }});
    }
  }

  // ── Step 3: Call Anthropic ────────────────────────────
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      body.model      || "claude-sonnet-4-6",
        max_tokens: body.max_tokens || 1500,
        system:     body.system     || "",
        messages:   body.messages   || [],
      }),
    });

    const text = await upstream.text();
    res.setHeader("Content-Type", "application/json");
    return res.status(upstream.status).send(text);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message }});
  }
}
