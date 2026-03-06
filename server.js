const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;
const LEADERBOARD_PATH = path.join(__dirname, "leaderboard.json");

// ── CONFIG ───────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ── DATABASE ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Helper om JSON bestand te synchroniseren met DB
async function syncDbToJson() {
  try {
    const result = await pool.query(
      `SELECT id, score, roast, tip, nickname, image, timestamp 
       FROM ratings 
       WHERE flagged = FALSE 
       ORDER BY score DESC`
    );
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(result.rows, null, 2), "utf8");
    console.log("📂 JSON leaderboard geüpdatet");
  } catch (e) {
    console.error("❌ Sync fout:", e);
  }
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      id SERIAL PRIMARY KEY,
      score REAL NOT NULL,
      roast TEXT,
      tip TEXT,
      nickname TEXT DEFAULT 'Anonymous',
      image TEXT,
      flagged BOOLEAN DEFAULT FALSE,
      timestamp BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      rating_id INTEGER REFERENCES ratings(id),
      reason TEXT,
      ai_verdict TEXT,
      ai_reasoning TEXT,
      reviewed BOOLEAN DEFAULT FALSE,
      timestamp BIGINT
    )
  `);

  // Synchroniseer direct bij startup
  await syncDbToJson();
  console.log("✅ Database ready & JSON synced");
}
initDB().catch(console.error);

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["http://127.0.0.1:5500", "http://localhost:5500"],
  methods: ["GET", "POST"],
  credentials: false
}));

app.use(express.json({ limit: "10mb" }));

// ── RATE LIMITER ─────────────────────────────────────────
const rateLimits = {};
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (!rateLimits[ip]) {
      rateLimits[ip] = { count: 1, start: now };
      return next();
    }
    const elapsed = now - rateLimits[ip].start;
    if (elapsed > windowMs) {
      rateLimits[ip] = { count: 1, start: now };
      return next();
    }
    rateLimits[ip].count++;
    if (rateLimits[ip].count > max) {
      return res.status(429).json({ error: "Too many requests. Slow down." });
    }
    next();
  };
}

// ── OPENROUTER & AI HELPERS ──────────────────────────────
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found");
  return JSON.parse(match[0]);
}

async function rateWithFallback(imageBase64, mediaType) {
  const models = [
    "google/gemma-3-12b-it:free",
    "meta-llama/llama-3.2-11b-vision-instruct:free",
    "qwen/qwen2.5-vl-3b-instruct:free"
  ];

  const prompt = `You are a brutally honest but funny interior design critic. Respond ONLY with JSON: {"score":<number>,"roast":"<text>","tip":"<text>"}`;

  for (const model of models) {
    try {
      const body = JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
            { type: "text", text: prompt }
          ]
        }]
      });

      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "openrouter.ai",
          path: "/api/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Length": Buffer.byteLength(body)
          }
        }, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });

      if (res.status === 200) return extractJSON(res.body.choices[0].message.content);
    } catch (e) { console.error(`Model ${model} failed, trying next...`); }
  }
  throw new Error("AI failed");
}

// ── ROUTES ───────────────────────────────────────────────

// 1. AI Score genereren
app.post("/rate", rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Image required" });
  try {
    const result = await rateWithFallback(imageBase64, mediaType);
    res.json(result);
  } catch (e) { res.status(502).json({ error: "AI busy" }); }
});

// 2. Submit naar DB én Update JSON
app.post("/submit", rateLimit({ windowMs: 60000, max: 5 }), async (req, res) => {
  let { score, roast, tip, nickname, image } = req.body;
  
  try {
    await pool.query(
      `INSERT INTO ratings (score, roast, tip, nickname, image, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [score, roast, tip, nickname || "Anonymous", image, Date.now()]
    );

    // Belangrijk: Update het JSON bestand na elke nieuwe inzending
    await syncDbToJson();

    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Database error" });
  }
});

// 3. Leaderboard uit JSON lezen (Geen DB request!)
app.get("/leaderboard", (req, res) => {
  try {
    if (!fs.existsSync(LEADERBOARD_PATH)) return res.json([]);
    
    const data = JSON.parse(fs.readFileSync(LEADERBOARD_PATH, "utf8"));
    
    if (req.query.sort === "recent") {
      data.sort((a, b) => b.timestamp - a.timestamp);
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Read error" });
  }
});

// ── ADMIN & START ────────────────────────────────────────
app.get("/", (req, res) => res.send("System Online"));

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
