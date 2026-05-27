// ─────────────────────────────────────────────────────
// Vercel Serverless Function — Claude API Proxy
// File location in your GitHub repo: api/claude.js
// ─────────────────────────────────────────────────────

const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ── Parse body — Vercel doesn't auto-parse JSON ──────
  let body;
  try {
    if (typeof req.body === "string") {
      body = JSON.parse(req.body);
    } else if (typeof req.body === "object" && req.body !== null) {
      body = req.body;
    } else {
      // Manually read raw body
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON body: " + e.message });
  }

  if (!CLAUDE_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel environment variables" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
