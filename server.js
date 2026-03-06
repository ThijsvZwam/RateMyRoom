const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;

// ── CONFIG ───────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ── DATABASE ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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

  console.log("✅ Database ready");
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

// ── SIMPLE RATE LIMITER (NO DEPENDENCIES) ────────────────

const rateLimits = {};

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown";

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

// Clean old IPs every 5 minutes
setInterval(() => {
  const now = Date.now();

  for (const ip in rateLimits) {
    if (now - rateLimits[ip].start > 15 * 60 * 1000) {
      delete rateLimits[ip];
    }
  }
}, 5 * 60 * 1000);

// ── LIMITERS ─────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20
});

const adminLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5
});

// Apply to endpoints
app.use("/rate", apiLimiter);
app.use("/submit", apiLimiter);
app.use("/report", apiLimiter);
app.use("/admin", adminLimiter);

// ── OPENROUTER HELPER ────────────────────────────────────

function openRouterRequest(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);

    const options = {
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.SITE_URL || "http://localhost:5500",
        "X-Title": "RateMyRoom",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", c => data += c);

      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(data)
          });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in response");
  return JSON.parse(match[0]);
}

// ── MODELS ───────────────────────────────────────────────

const VISION_MODELS = [
  "google/gemma-3-12b-it:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "qwen/qwen2.5-vl-3b-instruct:free"
];

// ── AI RATING ────────────────────────────────────────────

async function rateWithFallback(imageBase64, mediaType) {

  const prompt = `You are a brutally honest but funny interior design critic for RateMyRoom.
Respond ONLY with JSON:
{"score":<number>,"roast":"<text>","tip":"<text>"}

Score 0-10 with decimals.
Most rooms: 2-5
Nice rooms: 6-7
Impressive: 8
Magazine worthy: 9+`;

  for (const model of VISION_MODELS) {

    try {

      const result = await openRouterRequest({
        model,
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${imageBase64}` }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }],
        max_tokens: 500,
        temperature: 1
      });

      if (result.status !== 200) continue;

      const text = result.body.choices?.[0]?.message?.content || "";

      return extractJSON(text);

    } catch (e) {}

  }

  throw new Error("All models failed");

}

// ── POST /rate ───────────────────────────────────────────

app.post("/rate", async (req, res) => {

  const { imageBase64, mediaType } = req.body;

  if (!imageBase64 || !mediaType)
    return res.status(400).json({ error: "imageBase64 required" });

  try {

    const parsed = await rateWithFallback(imageBase64, mediaType);

    res.json(parsed);

  } catch (e) {

    res.status(502).json({
      error: "AI models busy"
    });

  }

});

// ── POST /submit ─────────────────────────────────────────

app.post("/submit", async (req, res) => {

  let { score, roast, tip, nickname, image, timestamp } = req.body;

  if (typeof score !== "number" || score < 0 || score > 10)
    return res.status(400).json({ error: "Invalid score" });

  nickname = String(nickname || "Anonymous").slice(0, 32);
  timestamp = timestamp || Date.now();

  if (image && !image.startsWith("data:image/"))
    image = null;

  try {

    const result = await pool.query(
      `INSERT INTO ratings (score, roast, tip, nickname, image, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [score, roast, tip, nickname, image, timestamp]
    );

    res.status(201).json({
      success: true,
      id: result.rows[0].id
    });

  } catch (e) {

    res.status(500).json({ error: "Database insert failed" });

  }

});

// ── GET /leaderboard ─────────────────────────────────────

app.get("/leaderboard", async (req, res) => {

  const orderBy = req.query.sort === "recent"
    ? "timestamp DESC"
    : "score DESC";

  try {

    const result = await pool.query(
      `SELECT id,score,roast,tip,nickname,image,timestamp
       FROM ratings
       WHERE flagged = FALSE
       ORDER BY ${orderBy}`
    );

    res.json(result.rows);

  } catch (e) {

    res.status(500).json({ error: "Database read failed" });

  }

});

// ── ADMIN AUTH (TIMING SAFE) ─────────────────────────────

function safeCompare(a, b) {

  const aBuf = Buffer.from(a || "");
  const bBuf = Buffer.from(b || "");

  if (aBuf.length !== bBuf.length)
    return false;

  return crypto.timingSafeEqual(aBuf, bBuf);

}

function adminAuth(req, res, next) {

  const password = req.headers["x-admin-password"] || "";

  if (!safeCompare(password, ADMIN_PASSWORD))
    return res.status(401).json({ error: "Unauthorized" });

  next();

}

// ── ADMIN ROUTES ─────────────────────────────────────────

app.get("/admin/stats", adminAuth, async (req, res) => {

  const main = await pool.query(
    `SELECT COUNT(*) as total,
            AVG(score) as avg_score,
            MAX(score) as top_score
     FROM ratings
     WHERE flagged = FALSE`
  );

  res.json(main.rows[0]);

});

// ── HEALTH CHECK ─────────────────────────────────────────

app.get("/", (req, res) => res.send("OK"));

// ── START ────────────────────────────────────────────────

app.listen(port, () => {

  console.log(`🚀 Server running on port ${port}`);

});