const express = require("express");
const cors = require("cors");
const https = require("https");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;

// ── CONFIG (set these as env variables on Railway) ────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_PASSWORD     = process.env.ADMIN_PASSWORD;

// ── DATABASE ──────────────────────────────────────────────
// Railway injects DATABASE_URL automatically when you add a Postgres plugin
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      id        SERIAL PRIMARY KEY,
      score     REAL    NOT NULL,
      roast     TEXT,
      tip       TEXT,
      nickname  TEXT    DEFAULT 'Anonymous',
      image     TEXT,
      flagged   BOOLEAN DEFAULT FALSE,
      timestamp BIGINT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id           SERIAL PRIMARY KEY,
      rating_id    INTEGER REFERENCES ratings(id),
      reason       TEXT,
      ai_verdict   TEXT,
      ai_reasoning TEXT,
      reviewed     BOOLEAN DEFAULT FALSE,
      timestamp    BIGINT
    )
  `);
  console.log("✅ Database ready");
}
initDB().catch(console.error);

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["http://127.0.0.1:5500", "http://localhost:5500"],
  methods: ["GET", "POST"],
  credentials: false
}));
app.use(express.json({ limit: "15mb" }));

// ── OPENROUTER HELPER ─────────────────────────────────────
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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
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

// ── POST /rate ────────────────────────────────────────────
app.post("/rate", async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64 || !mediaType)
    return res.status(400).json({ error: "imageBase64 and mediaType are required" });

  try {
    const result = await openRouterRequest({
      model: "google/gemma-3-27b-it:free",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
          { type: "text", text: `You are a brutally honest but funny interior design critic for RateMyRoom.
Respond ONLY with valid JSON, no markdown, no code fences:
{"score":<number>,"roast":"<text>","tip":"<text>"}

SCORING: 0-10 with 3-5 decimal places (e.g. 4.74391). Be extremely harsh.
Most rooms: 2-5. Nice rooms: 6-7. Impressive rooms: 8. Magazine-worthy: 9+. 10 is near impossible.
roast: cutting funny 1-2 sentences referencing specific visible details.
tip: one useful improvement in 1 sentence.` }
        ]
      }],
      max_tokens: 500,
      temperature: 1.0
    });

    if (result.status !== 200) {
      console.error("OpenRouter error:", result.body);
      return res.status(502).json({ error: result.body.error?.message || "API error" });
    }

    const text = result.body.choices?.[0]?.message?.content || "";
    res.json(extractJSON(text));
  } catch (e) {
    console.error("Rate error:", e);
    res.status(502).json({ error: "Failed to get rating" });
  }
});

// ── POST /submit ──────────────────────────────────────────
app.post("/submit", async (req, res) => {
  let { score, roast, tip, nickname, image, timestamp } = req.body;

  if (typeof score !== "number" || score < 0 || score > 10)
    return res.status(400).json({ error: "Invalid score" });
  if (typeof roast !== "string" || typeof tip !== "string")
    return res.status(400).json({ error: "roast and tip must be strings" });

  nickname  = String(nickname || "Anonymous").trim().slice(0, 32) || "Anonymous";
  timestamp = typeof timestamp === "number" ? timestamp : Date.now();
  if (image && !String(image).startsWith("data:image/")) image = null;

  try {
    const result = await pool.query(
      `INSERT INTO ratings (score, roast, tip, nickname, image, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [score, roast, tip, nickname, image || null, timestamp]
    );
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (e) {
    console.error("DB insert error:", e);
    res.status(500).json({ error: "Database insert failed" });
  }
});

// ── GET /leaderboard ──────────────────────────────────────
app.get("/leaderboard", async (req, res) => {
  const orderBy = req.query.sort === "recent" ? "timestamp DESC" : "score DESC";
  try {
    const result = await pool.query(
      `SELECT id, score, roast, tip, nickname, image, timestamp
       FROM ratings WHERE flagged = FALSE ORDER BY ${orderBy}`
    );
    res.json(result.rows);
  } catch (e) {
    console.error("Leaderboard error:", e);
    res.status(500).json({ error: "Database read failed" });
  }
});

// ── POST /report ──────────────────────────────────────────
app.post("/report", async (req, res) => {
  const { id, reason } = req.body;
  if (!id || typeof id !== "number")
    return res.status(400).json({ error: "Invalid entry id" });

  try {
    const ratingResult = await pool.query(`SELECT * FROM ratings WHERE id = $1`, [id]);
    if (!ratingResult.rows.length) return res.status(404).json({ error: "Entry not found" });
    const rating = ratingResult.rows[0];

    let ai_verdict = "pending", ai_reasoning = "";

    try {
      const messages = rating.image
        ? [{ role: "user", content: [
            { type: "image_url", image_url: { url: rating.image } },
            { type: "text", text: `A user reported this room image on RateMyRoom. Review for policy violations.
Respond ONLY with JSON: {"verdict":"safe","reasoning":"..."} or {"verdict":"remove","reasoning":"..."}
Remove if: nudity, graphic violence, illegal content, not a room. Safe if: just a room photo.` }
          ]}]
        : [{ role: "user", content: `Reported roast: "${rating.roast}". Safe for public website or hate speech? JSON only: {"verdict":"safe","reasoning":"..."}` }];

      const result = await openRouterRequest({
        model: "google/gemma-3-12b-it:free",
        messages,
        max_tokens: 100,
        temperature: 0.1
      });

      if (result.status === 200) {
        const parsed = extractJSON(result.body.choices?.[0]?.message?.content || "");
        ai_verdict   = parsed.verdict   || "pending";
        ai_reasoning = parsed.reasoning || "";
        if (ai_verdict === "remove") {
          await pool.query(`UPDATE ratings SET flagged = TRUE WHERE id = $1`, [id]);
          console.log(`🤖 AI removed entry #${id}: ${ai_reasoning}`);
        }
      }
    } catch (e) {
      console.error("AI moderation error:", e);
    }

    await pool.query(
      `INSERT INTO reports (rating_id, reason, ai_verdict, ai_reasoning, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, reason || "No reason given", ai_verdict, ai_reasoning, Date.now()]
    );

    // Auto-flag after 3 reports
    const countResult = await pool.query(`SELECT COUNT(*) FROM reports WHERE rating_id = $1`, [id]);
    if (parseInt(countResult.rows[0].count) >= 3) {
      await pool.query(`UPDATE ratings SET flagged = TRUE WHERE id = $1`, [id]);
      console.log(`⚠️ Entry #${id} auto-flagged after 3 reports`);
    }

    res.json({ success: true, ai_verdict, ai_reasoning });
  } catch (e) {
    console.error("Report error:", e);
    res.status(500).json({ error: "Report failed" });
  }
});

// ── ADMIN AUTH ────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers["x-admin-password"] !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── GET /admin/stats ──────────────────────────────────────
app.get("/admin/stats", adminAuth, async (req, res) => {
  try {
    const [main, flagged, reports] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, AVG(score) as avg_score, MAX(score) as top_score FROM ratings WHERE flagged = FALSE`),
      pool.query(`SELECT COUNT(*) as flagged FROM ratings WHERE flagged = TRUE`),
      pool.query(`SELECT COUNT(*) as reports FROM reports`)
    ]);
    res.json({
      total:     parseInt(main.rows[0].total),
      avg_score: main.rows[0].avg_score,
      top_score: main.rows[0].top_score,
      flagged:   parseInt(flagged.rows[0].flagged),
      reports:   parseInt(reports.rows[0].reports)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /admin/reports ────────────────────────────────────
app.get("/admin/reports", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.id as report_id, r.rating_id, r.reason, r.ai_verdict, r.ai_reasoning,
             r.reviewed, r.timestamp, rat.score, rat.nickname, rat.flagged, rat.roast, rat.image
      FROM reports r
      LEFT JOIN ratings rat ON r.rating_id = rat.id
      ORDER BY r.timestamp DESC
    `);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /admin/all-entries ────────────────────────────────
app.get("/admin/all-entries", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, score, roast, tip, nickname, image, flagged, timestamp FROM ratings ORDER BY timestamp DESC`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/flag ──────────────────────────────────────
app.post("/admin/flag", adminAuth, async (req, res) => {
  const { id, flagged } = req.body;
  try {
    await pool.query(`UPDATE ratings SET flagged = $1 WHERE id = $2`, [!!flagged, id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/review-report ─────────────────────────────
app.post("/admin/review-report", adminAuth, async (req, res) => {
  const { report_id } = req.body;
  try {
    await pool.query(`UPDATE reports SET reviewed = TRUE WHERE id = $1`, [report_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});