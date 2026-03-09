const express  = require("express");
const cors     = require("cors");
const https    = require("https");
const crypto   = require("crypto");
const { Pool } = require("pg");

const app  = express();
const port = process.env.PORT || 3000;

// ── CONFIG ────────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_PASSWORD     = process.env.ADMIN_PASSWORD;
const SCORE_SECRET = process.env.SCORE_SECRET || crypto.randomBytes(32).toString("hex");
const BAD_WORDS = ["fuck","shit","ass","bitch","bastard","cunt","dick","pussy","cock","whore","slut","nigger","nigga","faggot","retard","rape","kys","kill yourself"];
function hasProfanity(str) {
  const lower = str.toLowerCase();
  return BAD_WORDS.some(w => lower.includes(w));
}
// Secret used to sign rating tokens — set this in your env variables
const TOKEN_SECRET       = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");

// ── DATABASE ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ratings (
    id        SERIAL PRIMARY KEY,
    score     REAL    NOT NULL,
    roast     TEXT,
    tip       TEXT,
    nickname  TEXT    DEFAULT 'Anonymous',
    image     TEXT    NOT NULL,
    flagged   BOOLEAN DEFAULT FALSE,
    timestamp BIGINT,
    ip        TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id           SERIAL PRIMARY KEY,
    rating_id    INTEGER REFERENCES ratings(id),
    reason       TEXT,
    ai_verdict   TEXT,
    ai_reasoning TEXT,
    reviewed     BOOLEAN DEFAULT FALSE,
    timestamp    BIGINT,
    ip           TEXT
  )`);
  // Store used tokens to prevent replay attacks
  await pool.query(`CREATE TABLE IF NOT EXISTS used_tokens (
    token     TEXT PRIMARY KEY,
    used_at   BIGINT
  )`);
  // Clean up tokens older than 1 hour periodically
  setInterval(() => {
    pool.query(`DELETE FROM used_tokens WHERE used_at < $1`, [Date.now() - 3600000]).catch(() => {});
  }, 30 * 60 * 1000);
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
app.use(express.json({ limit: "8mb" }));

// ── RATE LIMITING ─────────────────────────────────────────
const rateLimits = new Map();
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  if (!rateLimits.has(key)) rateLimits.set(key, []);
  const timestamps = rateLimits.get(key).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  rateLimits.set(key, timestamps);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimits.entries()) {
    const fresh = timestamps.filter(t => now - t < 3600000);
    if (!fresh.length) rateLimits.delete(key);
    else rateLimits.set(key, fresh);
  }
}, 10 * 60 * 1000);

function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

// ── RATING TOKEN (prevents score tampering) ───────────────
// Server signs {score, roast, tip, imageHash} after AI rates it.
// /submit verifies the token before accepting the entry.
function signToken(payload) {
  const data = JSON.stringify(payload);
  const sig  = crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("hex");
  return Buffer.from(data).toString("base64") + "." + sig;
}

function verifyToken(token) {
  try {
    const [dataB64, sig] = token.split(".");
    const data    = Buffer.from(dataB64, "base64").toString();
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("hex");
    if (sig !== expected) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── PROFANITY FILTER ──────────────────────────────────────
const PROFANITY = [
  "fuck","shit","cunt","nigger","nigga","faggot","fag","retard","bitch",
  "asshole","bastard","whore","slut","cock","dick","pussy","ass","piss",
  "damn","crap","twat","wanker","bollocks","prick","motherfucker","fucker"
];
function containsProfanity(str) {
  const lower = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PROFANITY.some(word => lower.includes(word));
}

// ── IMAGE VALIDATION ──────────────────────────────────────
function isValidImage(str) {
  if (!str || typeof str !== "string") return false;
  if (!str.startsWith("data:image/")) return false;
  const match = str.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return false;
  if (!["image/jpeg","image/png","image/webp","image/gif"].includes(match[1])) return false;
  if (match[2].length < 1000 || match[2].length > 10_000_000) return false;
  return true;
}

// ── OPENROUTER ────────────────────────────────────────────
function openRouterRequest(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer":   process.env.SITE_URL || "http://localhost:5500",
        "X-Title":        "RateMyRoom",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    }, (res) => {
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

const VISION_MODELS = [
  "google/gemma-3-12b-it:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "qwen/qwen2.5-vl-3b-instruct:free",
];

async function rateWithFallback(imageBase64, mediaType) {
  const prompt = `You are a brutally honest but funny interior design critic for RateMyRoom.
Respond ONLY with valid JSON, no markdown, no code fences:
{"score":<number>,"roast":"<text>","tip":"<text>"}

SCORING: 0-10 with 3-5 decimal places (e.g. 4.74391). Be extremely harsh.
Most rooms: 2-5. Nice rooms: 6-7. Impressive rooms: 8. Magazine-worthy: 9+. 10 is near impossible.
roast: cutting funny 1-2 sentences referencing specific visible details.
tip: one useful improvement in 1 sentence.`;

  for (const model of VISION_MODELS) {
    try {
      console.log(`Trying model: ${model}`);
      const result = await openRouterRequest({
        model,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
          { type: "text", text: prompt }
        ]}],
        max_tokens: 500,
        temperature: 1.0
      });
      if (result.status === 429 || result.body?.error?.code === 429) { console.log(`${model} rate limited`); continue; }
      if (result.status !== 200) { console.log(`${model} failed ${result.status}`); continue; }
      const text = result.body.choices?.[0]?.message?.content || "";
      return extractJSON(text);
    } catch (e) {
      console.log(`${model} error: ${e.message}`);
    }
  }
  throw new Error("All models failed");
}

// ── POST /rate ────────────────────────────────────────────
// Rate: 5 per IP per 10 min
app.post("/rate", async (req, res) => {
  const ip = getIP(req);
  if (!rateLimit(`rate:${ip}`, 5, 10 * 60 * 1000))
    return res.status(429).json({ error: "Too many requests, slow down!" });

  const { imageBase64, mediaType } = req.body;
  if (!imageBase64 || !mediaType)
    return res.status(400).json({ error: "imageBase64 and mediaType are required" });

  const fullDataUrl = `data:${mediaType};base64,${imageBase64}`;
  if (!isValidImage(fullDataUrl))
    return res.status(400).json({ error: "Invalid image data" });

  try {
    const parsed = await rateWithFallback(imageBase64, mediaType);
    if (typeof parsed.score !== "number" || parsed.score < 0 || parsed.score > 10)
      return res.status(502).json({ error: "AI returned invalid score" });

    // Sign a token containing the exact score, roast, tip and image fingerprint
    const imageHash = crypto.createHash("sha256").update(imageBase64.slice(0, 1000)).digest("hex");
    const token = signToken({
      score:     parsed.score,
      roast:     parsed.roast,
      tip:       parsed.tip,
      imageHash,
      expiresAt: Date.now() + 30 * 60 * 1000 // valid for 30 minutes
    });

    res.json({ ...parsed, _token: token });
  } catch (e) {
    console.error("Rate error:", e);
    res.status(502).json({ error: "All AI models are currently busy, try again in a moment" });
  }
});

// ── POST /submit ──────────────────────────────────────────
// Rate: 3 per IP per hour
app.post("/submit", async (req, res) => {
  const ip = getIP(req);
  if (!rateLimit(`submit:${ip}`, 3, 60 * 60 * 1000))
    return res.status(429).json({ error: "Too many submissions, try again later" });

  let { score, roast, tip, nickname, image, timestamp, _token } = req.body;

  // ── Verify token ──────────────────────────────────────
  if (!_token) return res.status(400).json({ error: "Missing rating token" });

  const tokenData = verifyToken(_token);
  if (!tokenData) return res.status(400).json({ error: "Invalid or tampered rating token" });
  if (Date.now() > tokenData.expiresAt) return res.status(400).json({ error: "Rating expired, please re-rate your room" });

  // Check token hasn't been used before (prevents replay attacks)
  const tokenHash = crypto.createHash("sha256").update(_token).digest("hex");
  try {
    await pool.query(`INSERT INTO used_tokens (token, used_at) VALUES ($1, $2)`, [tokenHash, Date.now()]);
  } catch {
    return res.status(400).json({ error: "This rating has already been submitted" });
  }

  // Verify submitted values match what the AI actually returned
  if (score !== tokenData.score) return res.status(400).json({ error: "Score mismatch" });
  if (roast !== tokenData.roast) return res.status(400).json({ error: "Roast mismatch" });
  if (tip   !== tokenData.tip)   return res.status(400).json({ error: "Tip mismatch" });

  // Verify the image matches what was rated
  if (!isValidImage(image)) return res.status(400).json({ error: "A valid room image is required" });
  const imageBase64 = image.split(",")[1];
  const imageHash   = crypto.createHash("sha256").update(imageBase64.slice(0, 1000)).digest("hex");
  if (imageHash !== tokenData.imageHash) return res.status(400).json({ error: "Image does not match rated image" });

  // Profanity filter on nickname
  nickname = String(nickname || "Anonymous").trim().slice(0, 32) || "Anonymous";
  if (containsProfanity(nickname))
    return res.status(400).json({ error: "Nickname contains inappropriate language" });

  timestamp = typeof timestamp === "number" ? timestamp : Date.now();

  try {
    const result = await pool.query(
      `INSERT INTO ratings (score, roast, tip, nickname, image, timestamp, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [score, roast, tip, nickname, image, timestamp, ip]
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
// Rate: 10 per IP per hour, 1 per entry per IP
app.post("/report", async (req, res) => {
  const ip = getIP(req);
  if (!rateLimit(`report:${ip}`, 10, 60 * 60 * 1000))
    return res.status(429).json({ error: "Too many reports from your IP" });

  const { id, reason } = req.body;
  if (!id || typeof id !== "number")
    return res.status(400).json({ error: "Invalid entry id" });

  try {
    const ratingResult = await pool.query(`SELECT * FROM ratings WHERE id = $1`, [id]);
    if (!ratingResult.rows.length) return res.status(404).json({ error: "Entry not found" });
    const rating = ratingResult.rows[0];

    const dupCheck = await pool.query(
      `SELECT id FROM reports WHERE rating_id = $1 AND ip = $2`, [id, ip]
    );
    if (dupCheck.rows.length > 0)
      return res.status(409).json({ error: "You already reported this entry" });

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
        messages, max_tokens: 100, temperature: 0.1
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
    } catch (e) { console.error("AI moderation error:", e); }

    await pool.query(
      `INSERT INTO reports (rating_id, reason, ai_verdict, ai_reasoning, timestamp, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, reason || "No reason given", ai_verdict, ai_reasoning, Date.now(), ip]
    );

    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT ip) FROM reports WHERE rating_id = $1`, [id]
    );
    if (parseInt(countResult.rows[0].count) >= 3) {
      await pool.query(`UPDATE ratings SET flagged = TRUE WHERE id = $1`, [id]);
      console.log(`⚠️ Entry #${id} auto-flagged after 3 unique reports`);
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

app.get("/admin/stats", adminAuth, async (req, res) => {
  try {
    const [main, flagged, reports] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, AVG(score) as avg_score, MAX(score) as top_score FROM ratings WHERE flagged = FALSE`),
      pool.query(`SELECT COUNT(*) as flagged FROM ratings WHERE flagged = TRUE`),
      pool.query(`SELECT COUNT(*) as reports FROM reports`)
    ]);
    res.json({ total: parseInt(main.rows[0].total), avg_score: main.rows[0].avg_score, top_score: main.rows[0].top_score, flagged: parseInt(flagged.rows[0].flagged), reports: parseInt(reports.rows[0].reports) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/reports", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.id as report_id, r.rating_id, r.reason, r.ai_verdict, r.ai_reasoning,
             r.reviewed, r.timestamp, r.ip as report_ip,
             rat.score, rat.nickname, rat.flagged, rat.roast, rat.image
      FROM reports r LEFT JOIN ratings rat ON r.rating_id = rat.id
      ORDER BY r.timestamp DESC
    `);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/all-entries", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, score, roast, tip, nickname, image, flagged, timestamp, ip FROM ratings ORDER BY timestamp DESC`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/flag", adminAuth, async (req, res) => {
  const { id, flagged } = req.body;
  try {
    await pool.query(`UPDATE ratings SET flagged = $1 WHERE id = $2`, [!!flagged, id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/review-report", adminAuth, async (req, res) => {
  const { report_id } = req.body;
  try {
    await pool.query(`UPDATE reports SET reviewed = TRUE WHERE id = $1`, [report_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/ban-ip", adminAuth, async (req, res) => {
  const { ip } = req.body;
  try {
    await pool.query(`UPDATE ratings SET flagged = TRUE WHERE ip = $1`, [ip]);
    res.json({ success: true, message: `All entries from ${ip} flagged` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => res.send("OK"));

// ── START ─────────────────────────────────────────────────
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
