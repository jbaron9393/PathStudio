console.log("Loaded server.js from:", process.cwd());

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { existsSync, promises as fs } from "fs";
import { fileURLToPath } from "url";
import { syncGrossingManualVendor } from "./scripts/sync-grossing-manual.mjs";

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADAPTIVE_PRESETS = new Set(["micro", "gross", "path"]);
const LEARNING_DIR = path.join(__dirname, "data");
const GROSSING_MANUAL_DIR = path.join(__dirname, "vendor", "Grossing-Manual");
const LEARNING_FILE = path.join(LEARNING_DIR, "rewrite_learning.json");
const MAX_PERSISTED_EXAMPLES_PER_PRESET = 600;
const STYLE_SEED_FILE = path.join(LEARNING_DIR, "style_seed.json");
let styleSeedLibrary = { micro: [], gross: [], path: [] };
let grossingManualSyncPromise = null;

function ensureGrossingManualSynced() {
  const indexPath = path.join(GROSSING_MANUAL_DIR, "index.html");
  if (existsSync(indexPath)) return Promise.resolve(true);
  if (grossingManualSyncPromise) return grossingManualSyncPromise;

  grossingManualSyncPromise = Promise.resolve()
    .then(() => syncGrossingManualVendor())
    .then(() => existsSync(indexPath))
    .catch((err) => {
      console.warn("Grossing Manual sync failed:", err?.message || err);
      return false;
    })
    .finally(() => {
      grossingManualSyncPromise = null;
    });

  return grossingManualSyncPromise;
}

function normalizeStyleSnippet(text) {
  const v = String(text || "").trim().replace(/\r\n/g, "\n");
  if (!v) return "";
  return v.slice(0, 1200);
}

function normalizeStyleSeedLibrary(raw) {
  const out = { micro: [], gross: [], path: [] };
  for (const preset of ADAPTIVE_PRESETS) {
    const arr = Array.isArray(raw?.[preset]) ? raw[preset] : [];
    out[preset] = arr
      .map((item) => normalizeStyleSnippet(item))
      .filter(Boolean)
      .slice(-400);
  }
  return out;
}

async function loadStyleSeedLibrary() {
  try {
    const raw = await fs.readFile(STYLE_SEED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    styleSeedLibrary = normalizeStyleSeedLibrary(parsed);
    console.log("Loaded style seed library from", STYLE_SEED_FILE);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn("Failed to load style seed library:", err?.message || err);
    }
    styleSeedLibrary = { micro: [], gross: [], path: [] };
  }
}

function normalizeLearningExample(input, output) {
  const safeInput = String(input || "").trim().slice(0, 1400);
  const safeOutput = String(output || "").trim().slice(0, 2400);
  if (!safeInput || !safeOutput) return null;
  return { input: safeInput, output: safeOutput };
}

async function loadLearningStore() {
  try {
    const raw = await fs.readFile(LEARNING_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    console.warn("Failed to load rewrite learning store:", err?.message || err);
    return {};
  }
}

async function saveLearningStore(store) {
  try {
    await fs.mkdir(LEARNING_DIR, { recursive: true });
    await fs.writeFile(LEARNING_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save rewrite learning store:", err?.message || err);
  }
}

async function getPersistedLearningExamples(preset, limit = 8) {
  if (!ADAPTIVE_PRESETS.has(preset)) return [];
  const store = await loadLearningStore();
  const bucket = Array.isArray(store[preset]) ? store[preset] : [];
  return bucket.slice(-Math.max(1, limit));
}

async function appendPersistedLearningExample(preset, input, output) {
  if (!ADAPTIVE_PRESETS.has(preset)) return;
  const normalized = normalizeLearningExample(input, output);
  if (!normalized) return;

  const store = await loadLearningStore();
  const bucket = Array.isArray(store[preset]) ? store[preset] : [];

  bucket.push({
    ...normalized,
    savedAt: new Date().toISOString(),
  });

  store[preset] = bucket.slice(-MAX_PERSISTED_EXAMPLES_PER_PRESET);
  await saveLearningStore(store);
}

// Safe env debug (does NOT print the key itself)
const k = process.env.OPENAI_API_KEY || "";
console.log("OPENAI_API_KEY loaded:", k ? "YES" : "NO");
console.log("OPENAI_API_KEY prefix:", k.slice(0, 7));
console.log("OPENAI_API_KEY length:", k.length);

// ---- app init ----
const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

// ---- simple username gate ----
const APP_LOGIN_ID = String(
  process.env.APP_USERNAME || process.env.APP_PATH || process.env.APP_PASSWORD || "",
).trim();
const AUTH_COOKIE_NAME = "cloze_refiner_login";

function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const i = pair.indexOf("=");
      if (i < 0) return acc;
      const key = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!key) return acc;
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function isAuthenticated(req) {
  if (!APP_LOGIN_ID) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE_NAME] === APP_LOGIN_ID;
}

function setLoginCookie(res, { remember = false } = {}) {
  const maxAge = remember ? 60 * 60 * 24 * 30 : null;
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(APP_LOGIN_ID)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (maxAge) parts.push(`Max-Age=${maxAge}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearLoginCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function requireLogin(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Login required" });
  }
  return res.redirect("/login");
}

function renderLoginPage(errorText = "") {
  const safeError = errorText
    ? `<p style="color:#b91c1c;margin:0 0 12px;">${errorText}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Cloze Refiner Login</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body style="font-family:Arial,sans-serif;background:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0;">
    <form method="post" action="/api/login" style="width:min(420px,92vw);background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:22px;box-shadow:0 8px 24px rgba(15,23,42,.08);">
      <h1 style="margin:0 0 6px;font-size:20px;">Sign in</h1>
      <p style="margin:0 0 16px;color:#475569;">Enter your username/path to open Cloze Refiner.</p>
      ${safeError}
      <label for="username" style="display:block;font-weight:600;margin-bottom:6px;">Username</label>
      <input id="username" name="username" type="text" required autofocus style="width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;" />
      <label style="display:flex;align-items:center;gap:8px;margin:14px 0 16px;color:#334155;">
        <input type="checkbox" name="remember" value="1" />
        Remember me on this browser
      </label>
      <button type="submit" style="width:100%;padding:10px 12px;border:0;border-radius:8px;background:#0f766e;color:#fff;font-weight:600;cursor:pointer;">Continue</button>
    </form>
  </body>
</html>`;
}

app.get("/login", (req, res) => {
  if (!APP_LOGIN_ID) return res.redirect("/");
  if (isAuthenticated(req)) return res.redirect("/");
  return res.status(200).type("html").send(renderLoginPage());
});

app.post("/api/login", (req, res) => {
  if (!APP_LOGIN_ID) return res.redirect("/");
  const fromBody = req.body && typeof req.body === "object" ? req.body : {};
  const fromQuery = req.query && typeof req.query === "object" ? req.query : {};

  const username = String(fromBody.username || fromQuery.username || "").trim();
  const rememberRaw = fromBody.remember ?? fromQuery.remember;
  const remember = rememberRaw === "1" || rememberRaw === "true" || rememberRaw === true;

  if (username !== APP_LOGIN_ID) {
    return res.status(401).type("html").send(renderLoginPage("Wrong username/path."));
  }

  setLoginCookie(res, { remember });
  return res.redirect("/");
});

app.post("/api/logout", (_req, res) => {
  clearLoginCookie(res);
  return res.status(200).json({ ok: true });
});

app.get("/logout", (_req, res) => {
  clearLoginCookie(res);
  return res.redirect("/login");
});

if (APP_LOGIN_ID) {
  console.log("Login gate enabled (username/path required).");
}

if (!APP_LOGIN_ID) {
  console.log("Login gate disabled (APP_USERNAME/APP_PATH/APP_PASSWORD not set).");
}

// Health check public
app.get("/health", (req, res) => res.status(200).send("ok"));

// Apply auth to protected app content and API routes
app.use(requireLogin);

// Static files protected behind login
app.use(express.static(__dirname));

// Grossing Manual mounted under same domain (no iframe).
app.use("/grossing-manual", express.static(GROSSING_MANUAL_DIR));

app.get("/grossing-manual", async (_req, res) => {
  const indexPath = path.join(GROSSING_MANUAL_DIR, "index.html");
  if (!existsSync(indexPath)) {
    await ensureGrossingManualSynced();
  }

  if (!existsSync(indexPath)) {
    return res.status(503).send(
      "Grossing Manual is still syncing. Please retry in a few seconds.",
    );
  }

  return res.sendFile(indexPath);
});

app.get("/grossing-manual/*", async (_req, res, next) => {
  const indexPath = path.join(GROSSING_MANUAL_DIR, "index.html");
  if (!existsSync(indexPath)) {
    await ensureGrossingManualSynced();
  }
  if (!existsSync(indexPath)) return next();
  return res.sendFile(indexPath);
});

ensureGrossingManualSynced().catch(() => {});

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "cap_cloze_refiner.html"));
});

// Authenticated ping used by the browser tab to keep auth/session paths warm.
app.get("/api/ping", (_req, res) => {
  res.status(200).json({ ok: true });
});

const RULES = `
I am creating Anki cloze cards for pathology boards.

Follow these rules exactly unless I explicitly say otherwise.

FORMATTING
- Output must be clean, spaced, and easy to skim while editing in Anki.
- Use short lines and clear section headers.
- Do not change my wording unless needed for clarity.
- Final output must always be placed inside a single plain-text “copy window” (code-style box).
- Do not include explanations outside the copy window unless I ask.
- Optional emphasis is allowed using Anki-compatible HTML: <b>bold</b>, <i>italics</i>, or <u>underline</u>.
- Use emphasis only when it materially helps identify a few especially important words. Most cards do not need any emphasis.
- Never emphasize a whole sentence or line, never stack multiple styles on the same words, and use no more than 3 short emphasized phrases per card.
- Emphasis is secondary to cloze selection: do not add it merely for decoration or use it to compensate for choosing the wrong cloze anchor.

CLOZE RULES
- Never use nested clozes.
- Cloze numbers must be sequential starting at c1 within each card.
- Cloze only 1 to 3 words per cloze, NO MORE THAN THAT.
- If something needs more than 3 words, split into multiple clozes.
- Use only as many clozes as necessary (do not over-cloze).
- Reusing the same cloze number multiple times on a card is allowed when concepts are tightly linked.
- If I specify a maximum number of clozes, obey it strictly.
- If I say “no clozes,” do not add any clozes.
- If content is a short phrase, keep it on the same line.
- Prefer clozing single anchors (1–2 words) like medically relevant clinical terms or disease or disease processes
- Do NOT cloze whole sentences.

CLOZE HINTS (OPTIONAL AND RESTRAINED)
- You may add a gentle Anki hint using {{cN::answer::hint}} only when the surrounding card does not clearly indicate what kind of answer is expected.
- Use a short categorical cue (normally 1–4 words), such as "virus", "bug?", or "envelope or not". A hint should orient recall without giving away the answer.
- Do not add a hint to every cloze. Most clear clozes should remain {{cN::answer}} with no hint, and a card should rarely need more than 1–3 hints.
- Never use the answer itself, a close synonym, or distinctive answer wording as the hint.
- Preserve useful hints already supplied by the user, editing them only when needed for clarity or to avoid revealing the answer.

PARENTHETICAL EMPHASIS (HIGH PRIORITY)
- Treat text inside parentheses in the user's input as an explicit signal of what they consider important.
- When a parenthetical contains a diagnosis, mechanism, hallmark finding, key qualifier, or answer cue, prefer that concept as the cloze anchor rather than a less specific nearby word.
- Keep the clozed answer succinct (normally 1–3 words). Leave explanatory or supporting parenthetical words visible as context instead of hiding the entire parenthetical.
- Do not discard medically meaningful parenthetical content merely to shorten the card; tighten redundant surrounding prose first.

IF INPUT ALREADY HAS CLOZES
- If the user input already contains clozes ({{c...::}}), you MUST NOT add any new clozes.
- Only edit existing cloze contents to comply with the rules.
- Preserve all existing cloze blocks (do not delete them).
- If an existing cloze block is too long, shorten the clozed text to a 1–3 word anchor (e.g., "hypnozoite", "Schuffner's dots", "48 hours") while keeping the surrounding sentence intact.

CLOZE NUMBERING (HARD RULE)
- Within EACH card, cloze numbers MUST start at c1 and be sequential with NO gaps (c1, c2, c3, ...).
- If the input already contains clozes with higher numbers (e.g., c5, c6, c8), you MUST renumber that card so clozes become c1..cN in the order they appear.
- Reusing the same cloze number multiple times is allowed, but the set of numbers used must still be sequential with no gaps.
- Example: if a card uses c5, c6, c8, c9 -> renumber to c1, c2, c3, c4 (preserve order of first appearance).


CONTENT RULES
- Cloze only high-yield anchors:
  diagnosis, mechanism, hallmark histology, key lab or molecular finding.
- Leave descriptive lists unclozed unless I explicitly ask.
- Prefer ↑ / ↓ arrows for lab changes.
- Keep content pathology-accurate and board-oriented.
- Do not invent grading systems, criteria, or facts.
- Do not over-explain.

WORKFLOW
- I will paste raw notes, partially clozed cards, or images.
- Your job is to clean, standardize, and fix them without violating any rules.
- If I paste an image, generate ONE high-yield study card tied to the image, using the same copy-window format.

IMPORTANT
- Do NOT add extra clozes.
- Do NOT merge unrelated concepts.
- Do NOT explain unless asked.
`.trim();

function pickAnchorWords(content, maxWords = 3) {
  const s = String(content || "").trim();

  // Prefer classic high-yield anchors
  const patterns = [
    /\bhypnozoite\b/i,
    /\bSchuffner'?s\b/i,
    /\bdots?\b/i,
    /\bmerozoites?\b/i,
    /\bschizonts?\b/i,
    /\btertian\b/i,
    /\bquotidian\b/i,
    /\b48\b/i,
    /\b24\b/i,
    /\bvivax\b/i,
    /\bovale\b/i,
    /\bmalariae\b/i,
    /\bknowlesi\b/i,
  ];

  // If content contains one of these words, return that word (+ optional companion word)
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const w = m[0];
      // Try to keep "Schuffner's dots" together if present
      if (/Schuffner/i.test(w) && /dots?/i.test(s)) return "Schuffner's dots";
      return w;
    }
  }

  // Otherwise: take first maxWords "word tokens" (strip punctuation edges)
  const words = s
    .split(/\s+/)
    .map(w => w.replace(/^[^\w]+|[^\w]+$/g, "")) // trim punctuation
    .filter(Boolean);

  if (!words.length) return s;
  return words.slice(0, maxWords).join(" ");
}

function enforceClozeWordLimit(text, maxWords = 3) {
  if (!text) return text;

  return text.replace(/\{\{c(\d+)::([\s\S]*?)\}\}/g, (full, n, inner) => {
    const parts = String(inner).split("::");
    const content = String(parts.shift() || "").trim();
    const hint = parts.length ? parts.join("::").trim() : "";
    const words = content.split(/\s+/).filter(Boolean);

    if (words.length <= maxWords) return full;

    // Salvage: replace long cloze content with a short anchor (1–3 words)
    const anchor = pickAnchorWords(content, maxWords);
    return `{{c${n}::${anchor}${hint ? `::${hint}` : ""}}}`;
  });
}

function limitEmphasisFormatting(text, delimiter = "===CARD===", maxSpans = 3, maxWords = 3) {
  const d = String(delimiter || "===CARD===");
  return String(text || "")
    .split(d)
    .map((card) => {
      let kept = 0;
      return card.replace(/<(b|strong|i|em|u)>([\s\S]*?)<\/\1>/gi, (_full, tag, inner) => {
        const visibleWords = String(inner)
          .replace(/<[^>]*>/g, " ")
          .replace(/\{\{c\d+::|\}\}/gi, " ")
          .trim()
          .split(/\s+/)
          .filter(Boolean);

        if (kept >= maxSpans || visibleWords.length === 0 || visibleWords.length > maxWords) {
          return inner;
        }
        kept += 1;
        return `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
      });
    })
    .join(d);
}


function renumberClozesPerCard(text, delimiter = "===CARD===") {
  const d = String(delimiter || "===CARD===");
  const cards = String(text || "").split(d);

  const fixed = cards.map((cardText) => {
    const map = new Map();
    let next = 1;

    // Match {{cN:: with optional spaces anywhere
    return cardText.replace(/\{\{\s*c(\d+)\s*::/g, (_m, oldNum) => {
      if (!map.has(oldNum)) map.set(oldNum, String(next++));
      return `{{c${map.get(oldNum)}::`;
    });
  });

  return fixed.join(d);
}



function capClozesToInput(outText, inText, delimiter = "===CARD===") {
  const d = String(delimiter || "===CARD===");
  const outCards = String(outText || "").split(d);
  const inCards = String(inText || "").split(d);

  const fixedCards = outCards.map((outCard, i) => {
    const inCard = inCards[i] ?? "";

    // Set of cloze numbers that already exist in THIS input card
    const allowed = new Set(
      Array.from(inCard.matchAll(/\{\{\s*c(\d+)\s*::/g)).map(m => String(m[1]))
    );

    // If input card has clozes, forbid any new cloze numbers not in the set
    if (allowed.size > 0) {
      return outCard.replace(/\{\{\s*c(\d+)\s*::([\s\S]*?)\}\}/g, (full, n, inner) => {
        const answer = String(inner).split("::")[0].trim();
        return allowed.has(String(n)) ? full : answer;
      });
    }

    // If input card had no clozes, allow normal behavior
    return outCard;
  });

  return fixedCards.join(d);
}


async function callOpenAI({ apiKey, model, temperature, input }) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      temperature: Number(temperature) || 0.2,
    }),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${raw}`);

  const data = JSON.parse(raw);
  return (
    data.output_text ??
    data.output?.[0]?.content?.map((c) => c.text).join("") ??
    ""
  );
}

async function callOpenAIChat({ apiKey, model, temperature, system, user }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: String(system || "").trim() },
        { role: "user", content: String(user || "").trim() },
      ],
    }),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(text);

  const j = JSON.parse(text);
  return (j.choices?.[0]?.message?.content || "").trim();
}

function shouldUseWebSearch({ preset, user }) {
  if (String(preset || "").toLowerCase() !== "general") return false;

  const q = String(user || "").toLowerCase();
  const realtimeHints = [
    "current event",
    "current events",
    "latest news",
    "breaking news",
    "current news",
    "news today",
    "in the news",
    "right now",
    "today",
    "this week",
    "recent",
    "recently",
    "what happened",
    "news about",
  ];

  return realtimeHints.some((hint) => q.includes(hint));
}

function extractResponseOutputText(data) {
  const direct = String(data?.output_text || "").trim();
  if (direct) return direct;

  const outputs = Array.isArray(data?.output) ? data.output : [];
  const texts = [];

  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      const t = typeof c?.text === "string" ? c.text : "";
      if (t.trim()) texts.push(t);
    }
  }

  return texts.join("\n").trim();
}

async function callOpenAIWithWebSearch({ apiKey, model, temperature, system, user }) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: Number(temperature) || 0.2,
      tools: [{ type: "web_search" }],
      input: [
        { role: "system", content: String(system || "").trim() },
        { role: "user", content: String(user || "").trim() },
      ],
    }),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI web search error ${r.status}: ${raw}`);

  const data = JSON.parse(raw);
  return extractResponseOutputText(data);
}

async function callOpenAIMultimodal({ apiKey, model, temperature, system, userText, imageDataUrls = [] }) {
  const userContent = [];
  if (String(userText || "").trim()) {
    userContent.push({ type: "input_text", text: String(userText || "").trim() });
  }

  for (const dataUrl of imageDataUrls) {
    userContent.push({ type: "input_image", image_url: dataUrl });
  }

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: Number(temperature) || 0.2,
      input: [
        { role: "system", content: [{ type: "input_text", text: String(system || "").trim() }] },
        { role: "user", content: userContent },
      ],
    }),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI multimodal error ${r.status}: ${raw}`);

  const data = JSON.parse(raw);
  return extractResponseOutputText(data);
}

function splitByDelimiter(raw, delimiter = "===CARD===") {
  const d = String(delimiter || "===CARD===");
  return String(raw || "")
    .split(d)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function joinByDelimiter(parts, delimiter = "===CARD===") {
  const d = String(delimiter || "===CARD===");
  return parts.join(`\n${d}\n`);
}



// --------- REFINE (CLOZE) ---------
app.post("/api/refine", async (req, res) => {
  try {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return res.status(500).send("Missing OPENAI_API_KEY environment variable.");

    const {
      text,
      model = "gpt-4.1-mini",
      temperature = 0.2,
      delimiter = "===CARD===",
      extraRules = ""
    } = req.body || {};

    const rawText = String(text || "").trim();
    if (!rawText) return res.status(400).send("Missing 'text'.");

    const d = String(delimiter || "===CARD===");
    const extra = String(extraRules || "").trim();

    let input = "";

    // =======================
    // CUSTOM RULES MODE
    // =======================
    if (extra) {
      input = `
You are editing Anki cloze cards.

${RULES}

USER-SPECIFIED RULES:
- Apply the user's Extra Cloze Rules in addition to the base rules above.
- If an extra rule directly conflicts with a base preference, follow the user's extra rule, except that output and batch-format requirements remain mandatory.
- If the user requests a specific number of clozes, you MUST produce exactly that many clozes PER CARD.
- Do NOT invent facts.
- Keep the original text content; only add/adjust cloze wrappers.

Batch rules:
- Input may contain multiple cards separated by delimiter: ${d}
- Return same number of cards, same order
- Output MUST use the SAME delimiter (${d}) between cards
- Output ONLY the cards (no commentary)

EXTRA CLOZE RULES:
${extra}

USER INPUT:
${rawText}
`.trim();
    } else {
      // =======================
      // NORMAL STRICT MODE
      // =======================
      input = `
${RULES}

BATCH MODE INSTRUCTIONS
- The user input may contain multiple cards separated by the delimiter: ${d}
- Treat each chunk between delimiters as a separate card.
- Return the refined cards in the SAME ORDER.
- Output MUST use the SAME delimiter (${d}) between cards.
- Do not add extra cards. Do not remove cards.
- Do not add any extra commentary outside the copy windows.

USER INPUT:
${rawText}
`.trim();
    }

    // ✅ Call OpenAI ONCE
    const out = await callOpenAI({ apiKey, model, temperature, input });

    // Enforce the structural cloze guarantees in both normal and custom-rules modes.
    // User rules can steer content selection, but should not accidentally create
    // long clozes, new clozes on an already-clozed card, or broken numbering.
    let fixed = out;
    fixed = capClozesToInput(fixed, rawText, d);
    fixed = enforceClozeWordLimit(fixed, 3);
    fixed = renumberClozesPerCard(fixed, d);
    fixed = limitEmphasisFormatting(fixed, d, 3, 3);

    return res.json({ text: fixed });
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// --------- REWRITE (GENERAL/EMAIL/MICRO/PATH) ---------
app.post("/api/rewrite", async (req, res) => {
  try {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return res.status(500).send("Missing OPENAI_API_KEY");

    const {
      text,
      model = "gpt-4.1-mini",
      temperature = 0.2,
      preset = "general",
      rules = "",
      template = "",
      learningExamples = [],
      imageDataUrls = [],
      delimiter = "", // optional; empty means "single block"
      clientDateContext = null,
    } = req.body || {};

    const p = String(preset || "general").toLowerCase();
    const normalizedText = typeof text === "string" ? text : "";
    if (p !== "gross_photo" && !normalizedText.trim()) {
      return res.status(400).send("Missing text");
    }

    const userRules = String(rules || "").trim();
    const d = String(delimiter || "").trim();

    // If delimiter provided, treat as multi-chunk; else single text block
    const chunks = d ? splitByDelimiter(normalizedText, d) : [normalizedText.trim()];
    if (p !== "gross_photo" && !chunks[0]) {
      return res.status(400).send("Empty text after trimming.");
    }

    // =======================
    // DEFAULTS
    // =======================
  //this does nothing currently (rewrite base_section)
    const BASE_REWRITE = `
Rewrite the text to be professional, concise, and clear.

Hard rules:
- Keep meaning identical
- Do not add facts
- Fix grammar and flow
- Remove filler
- Keep qualifiers (e.g., focal, patchy, cannot exclude)
- Output ONLY rewritten text (no bullets unless the input used bullets)
`.trim();
//// this does nothing currently

    const PRESETS = {
general: `
You are ChatGPT. Respond normally and helpfully.
`.trim(),

      hpi: `
You are an experienced clinician writing a concise pathology-focused HPI for a preoperative, biopsy, cytology, or consult note.

Goal:
- Produce exactly one paragraph that is clinically coherent, chronologic when possible, and focused on details that matter to pathology interpretation.
- Prefer the structure of a polished chart HPI rather than a summary assessment.

Prioritize (when provided):
- Primary diagnosis with timing.
- Abnormal screening history or prior relevant test results (Pap/HPV/cytology/biopsy history, prior path diagnoses).
- Tumor site/location and size measurements.
- Key imaging findings (including metastatic disease status).
- Prior pathology/biopsy results (histology, grade, key biomarkers such as MMR if given).
- Prior treatments (chemotherapy, radiation, systemic therapy) with dates/timeframes and response if provided.
- Prior relevant procedures/surgeries and salient pathology from those procedures.
- For procedure-based specimens such as colposcopy/cervical biopsies, include only the key visible procedure findings and biopsy/ECC sites that will help interpret the specimen.
- Relevant personal/family history that directly informs current pathology context.
- Current reason for presentation/surgery.

Rules:
- Output a single paragraph only (no bullets, no headings).
- Keep it concise (usually 2-4 sentences, occasionally 5 if needed) and information-dense.
- Preserve all provided facts, dates, and measurements accurately.
- Do not invent missing data or over-interpret findings.
- If chronology is incomplete, use neutral transitions and avoid guessing.
- Use professional medical language suitable for a chart HPI.
- Standard clinical abbreviations are allowed when they improve concision (e.g., hx, s/p, chemoRT, mets, bx, MRI/CT).
- Avoid run-on sentences; use clear sentence boundaries and tight syntax.
- No em dashes.
- Omit fluff, generic management language, counseling details, consent details, hemostasis details, patient tolerance details, and post-procedure instructions unless explicitly requested.
- Do not add tail sentences about what clinicians will do next unless that immediate procedure/management decision is directly relevant to specimen interpretation.
- Do not editorialize with phrases like “complex presentation,” “revised plan,” or “now favored” unless those exact concepts are necessary and supported by the input.
- When procedure-note details are present, preferentially keep only the abnormal visual findings, biopsy sites, ECC, and any details that inform how the slides should be interpreted.
- If the input is already close to a usable HPI, lightly compress and clean it rather than reframing it into a more elaborate narrative.

Preferred paragraph shape:
- Default: 2-4 compact sentences.
- Sentence 1: introduce the patient and the key diagnosis / abnormal screening history / reason for specimen.
- Sentence 2: summarize the most relevant prior pathology, imaging, or objective data if present.
- Final sentence: if applicable, summarize only the key procedure findings that will matter to the pathologist (for example acetowhite change, lesion location, biopsy sites, ECC).
- For oncologic resection cases, include the immediate planned surgery/treatment only if it explains the current specimen.
- For colposcopy or office procedure cases, do not add follow-up plans or ASCCP-style management recommendations.

Style preferences:
- Favor compact, high-yield sentences over exhaustive narrative.
- Use parentheses to tuck in confirmatory pathology or procedural detail when that improves flow.
- Prefer direct factual phrasing over explanation-heavy transitions.
- Emphasize pathology-relevant decision points such as site of origin, prior abnormal screening history, lesion location, biopsy site, nodal disease, and prior pathology correlation.
`.trim(),

      email: `
Make it sound better. 
`.trim(),

      micro: `
You are an experienced surgical pathologist drafting the MICROSCOPIC DESCRIPTION section of a final pathology report.

The user may paste either:
(A) brief bullets / diagnosis-style micro summary, OR
(B) an existing microscopic description paragraph.

Your job:
- If input is (A): expand into a polished, sign-out–ready narrative microscopic description.
- If input is (B): refine for clarity, flow, concision, and sign-out style while preserving the same facts and overall structure.

Universal rules:
- Do not invent new findings, specimen counts, measurements, or diagnoses.
- If details are missing, use neutral language rather than guessing.
- Preserve severity and distribution (mild/moderate/marked; focal/patchy/diffuse; portal/lobular, etc.).
- No em dashes.
- Avoid speculation and do not add differential diagnoses unless explicitly provided.

Formatting:
- Output only the microscopic description text.
- Default output is narrative paragraphs (not bullets), unless a template is provided.

OPENING SENTENCE RULE:
- The microscopic description must begin with one of the following phrases:
  “Sections show…”
  “Sections demonstrate…”
  “Histologic evaluation reveals…”
- Do not use any other opening phrasing unless explicitly instructed by the user.

DIAGNOSTIC LANGUAGE RULES:

- Do NOT restate the diagnosis within the microscopic description.
- Do not conclude with a diagnostic statement.
`.trim(),

      gross: `
You are an experienced pathology assistant writing the GROSS DESCRIPTION section of a surgical pathology report.

The user input may be one of the following:

(A) A complete gross description beginning with “Received…”
(B) A short sentence, rough paragraph, or partial gross description
(C) A specimen name or brief scenario requiring a full example gross description

MODE DETERMINATION:

• If the input begins with “Received…”, treat it as REFINEMENT MODE.
• If the input is a short sentence or partial description but does not begin with “Received…”, treat it as EXPANSION MODE.
• If the input is only a specimen type or brief scenario, treat it as EXAMPLE GENERATION MODE.

--------------------------------------------------

REFINEMENT MODE:
- Preserve all original facts exactly.
- Do not invent findings.
- Keep all measurements, laterality, specimen parts, ink colors, identifiers, and margins as provided.
- Maintain the original opening sentence.
- Improve clarity, organization, and logical flow.

--------------------------------------------------

EXPANSION MODE:
- Convert the rough text into a complete, professionally structured gross description.
- Use only details supported by the input.
- Do not invent measurements, ink colors, or margins unless explicitly provided.
- If key information is missing, omit it rather than fabricate it.
--------------------------------------------------

EXAMPLE GENERATION MODE:
- Always begin exactly with:
  Received [fresh for frozen section diagnosis/tissue banking/in formalin] in a container labeled [patients name/MRN/designation],
  Fill in accordingly based off of input
- Use realistic but generic findings.
- For any estimated measurements not given place [x]
- Follow standard academic surgical pathology gross structure.

--------------------------------------------------

STRUCTURE REQUIREMENTS (all modes):
Maintain logical gross flow:
1. Receipt and labeling
2. Specimen type and measurements
3. External surface findings
4. Internal/cut surface findings
5. Orientation and inked margins
6. Lymph nodes or additional structures if applicable
7. Section submission

--------------------------------------------------

STYLE RULES:
- Use complete sentences.
- Avoid em dashes.
- Do not use bullets (unless needed for ink key)
- Use formal surgical pathology terminology.
- Keep orientation, ink colors, and margins explicit when provided.

--------------------------------------------------

SECTION SUBMISSION FORMAT:
When describing section submission, format blocks exactly as:

[A1] Description
[A2] Description
...etc

Do not alter bracket formatting.

--------------------------------------------------

OUTPUT:
Return only the gross description text.
`.trim(),

      gross_photo: `
You are a senior pathology assistant in a busy academic grossing room writing a final gross examination description from specimen photos.

The user may provide one or two gross specimen images and optional text context.

Your job:
- Describe only what is directly visible in the image(s) using formal gross pathology sign-out style.
- Write with the level of detail, precision, and observational nuance expected from a senior pathology assistant.
- If optional context text is provided, incorporate it only when it does not conflict with the image(s).
- If any text, handwriting, labels, cassette IDs, measurements, ruler markings, or numeric sequences are visible in the photo, explicitly describe them in the gross description.
- Transcribe clearly legible text or numbers exactly as shown (including units/symbols when visible); if partially legible, state that portions are illegible.
- Describe relevant gross visual details when visible (e.g., specimen type, configuration, color, consistency, surface characteristics, cut surface features, hemorrhage/necrosis/cysts, and orientation cues).
- Do not invent microscopic findings, final diagnosis, or unseen measurements.
- If dimensions are not visible or provided, do not guess exact numbers.
- If orientation, margins, or inking are unclear, explicitly state they are not clearly identifiable.
- If two images are provided, synthesize one coherent gross description and include text/number findings from both images.

Formatting:
- Output polished, sign-out-ready gross description paragraph(s) with natural grossing-room flow.
- Prefer specific descriptive terminology over vague wording.
- No bullets unless needed for an ink key.
- No em dashes.
- Return only the gross description text.
`.trim(),

      path: `
You are an experienced surgical pathologist writing FINAL DIAGNOSIS top line(s) for a pathology report.

The user may provide:
(A) Existing diagnosis line(s) to refine, OR
(B) Bullet points or descriptive findings requiring generation of diagnosis line(s).

MODE DETERMINATION:

• If the input already resembles diagnosis lines, refine for clarity and professionalism while preserving structure.
• If the input is descriptive or bullet findings, generate concise top line diagnosis statements based strictly on the provided information.

GENERAL RULES:

- Use concise, senior-level sign-out language.
- Be direct and definitive.
- Avoid unnecessary verbosity.
- Do not add speculative commentary.
- Do not invent diagnoses beyond what is supported by the input.
- Preserve any formatting provided by the user (bullets, spacing, parentheses).
- Maintain parallel structure when multiple lines are present.
- Use complete diagnostic phrases, not fragments.
- Avoid explanatory or educational language.

STYLE REQUIREMENTS:

- State the primary diagnosis first.
- Add modifiers (size, location, clinical context) only when relevant.
- Use parenthetical clinical correlation only when provided or clearly appropriate.
- Use “No evidence of…” statements only when supported by the input.
- Do not use phrases such as “consistent with” unless uncertainty is explicitly indicated.

OUTPUT:
Return only the final diagnosis line(s), preserving any user formatting.
`.trim()
    };

// =======================
// ALL PRESETS = CHATGPT-STYLE OUTPUT
// (Keeps your PRESETS so you can refine later.)
// =======================
const presetSystem = PRESETS[p] || PRESETS.general;
const presetTemplate = (p === "micro" || p === "gross") ? String(template || "").trim() : "";
const clientLearningExamples = ADAPTIVE_PRESETS.has(p) && Array.isArray(learningExamples)
  ? learningExamples
      .slice(-5)
      .map((ex) => normalizeLearningExample(ex?.input, ex?.output))
      .filter(Boolean)
  : [];

const persistedLearningExamples = await getPersistedLearningExamples(p, 10);
const normalizedLearningExamples = [...persistedLearningExamples, ...clientLearningExamples].slice(-12);

const LEARNING_CONTEXT = normalizedLearningExamples.length
  ? [
      "Adaptive style context from prior accepted rewrites for this preset:",
      ...normalizedLearningExamples.map((ex, idx) =>
        `Example ${idx + 1}:\nInput:\n${ex.input}\n\nOutput:\n${ex.output}`
      ),
      "Use this style context to improve consistency for this user's future rewrites.",
      "Do not copy examples verbatim when they conflict with the current source text.",
    ].join("\n\n")
  : "";

const styleSeedSnippets = Array.isArray(styleSeedLibrary?.[p])
  ? styleSeedLibrary[p].slice(-12)
  : [];

const STYLE_SEED_CONTEXT = styleSeedSnippets.length
  ? [
      "Curated long-term style snippets provided by the user:",
      ...styleSeedSnippets.map((snippet, idx) => `Style Snippet ${idx + 1}:\n${snippet}`),
      "Match this writing style while staying faithful to the current source text.",
    ].join("\n\n")
  : "";


const serverNow = new Date();
const serverDateContext = {
  serverNowIso: serverNow.toISOString(),
  serverNowUtc: serverNow.toUTCString(),
};

const safeClientDateContext =
  clientDateContext && typeof clientDateContext === "object"
    ? {
        clientNowIso: String(clientDateContext.clientNowIso || "").trim(),
        clientNowLocal: String(clientDateContext.clientNowLocal || "").trim(),
        clientTimezone: String(clientDateContext.clientTimezone || "").trim(),
      }
    : null;

const DATE_TIME_CONTEXT = [
  "Current date/time context:",
  `- serverNowIso: ${serverDateContext.serverNowIso}`,
  `- serverNowUtc: ${serverDateContext.serverNowUtc}`,
  `- clientNowIso: ${safeClientDateContext?.clientNowIso || "(not provided)"}`,
  `- clientNowLocal: ${safeClientDateContext?.clientNowLocal || "(not provided)"}`,
  `- clientTimezone: ${safeClientDateContext?.clientTimezone || "(not provided)"}`,
  "When the user asks for today's date/day/time, answer strictly from this context.",
  "If both server and client values are present, prefer the client values for 'today' and local time.",
].join("\n");

// Rules box overrides preset instructions (optional)
const system = userRules
  ? `You are a helpful assistant.

ABSOLUTE OVERRIDE MODE:
- Follow ONLY the user's rules in the Rules Override box.
- The only exception: if a Template is provided, you must also follow the template’s structure and section ordering exactly.
- If the Rules Override conflicts with the Template structure, the Template structure wins for formatting, and the Rules Override wins for tone/length/style within those sections.
- Do not add content not supported by the input text.

USER RULES:
${userRules}

${presetTemplate ? `TEMPLATE:
${presetTemplate}
` : ""}

${DATE_TIME_CONTEXT}

${LEARNING_CONTEXT}

${STYLE_SEED_CONTEXT}`.trim()
  : `${presetSystem}

${presetTemplate
    ? `If a TEMPLATE is provided, mirror its structure, section names, and ordering while preserving the source findings.

TEMPLATE:
${presetTemplate}`
    : ""}

${DATE_TIME_CONTEXT}

${LEARNING_CONTEXT}

${STYLE_SEED_CONTEXT}`.trim();

const normalizedImageDataUrls = Array.isArray(imageDataUrls)
  ? imageDataUrls
      .map((url) => String(url || "").trim())
      .filter((url) => /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(url))
      .slice(0, 2)
  : [];

if (p === "gross_photo" && normalizedImageDataUrls.length === 0) {
  return res.status(400).send("Gross (Photo) preset requires at least one image.");
}

// User content
const user = chunks.join("\n\n");

// Use web search for general + real-time/current-events style queries.
const useWebSearch = shouldUseWebSearch({ preset: p, user });

let finalOut;
if (p === "gross_photo") {
  finalOut = await callOpenAIMultimodal({
    apiKey,
    model,
    temperature: Number(temperature) || 0.2,
    system,
    userText: user,
    imageDataUrls: normalizedImageDataUrls,
  });
} else if (useWebSearch) {
  try {
    finalOut = await callOpenAIWithWebSearch({
      apiKey,
      model,
      temperature: Number(temperature) || 0.2,
      system,
      user,
    });
  } catch (webErr) {
    console.warn("Web search failed, falling back to chat completions:", webErr?.message || webErr);
    finalOut = await callOpenAIChat({
      apiKey,
      model,
      temperature: Number(temperature) || 0.2,
      system,
      user,
    });
  }
} else {
  finalOut = await callOpenAIChat({
    apiKey,
    model,
    temperature: Number(temperature) || 0.2,
    system,
    user,
  });
}

finalOut = String(finalOut || "").trim();

// If it re-asks the question, force a second pass (optional guard)
if (finalOut.endsWith("?")) {
  finalOut = await callOpenAIChat({
    apiKey,
    model,
    temperature: 0,
    system: "Return ONLY the final answer. Do NOT restate or rephrase the question.",
    user,
  });
  finalOut = String(finalOut || "").trim();
}

if (ADAPTIVE_PRESETS.has(p) && finalOut) {
  await appendPersistedLearningExample(p, text, finalOut);
}

  // Single block mode
  if (!d) return res.json({ text: finalOut });

  // Delimiter mode (must split finalOut)
  const outChunks = splitByDelimiter(finalOut, d);

  if (outChunks.length !== chunks.length) {
    console.log("general chunk mismatch", {
      inChunks: chunks.length,
      outChunks: outChunks.length,
      delimiter: d,
    });
    return res.json({
      text: finalOut,
      warning: `Model returned ${outChunks.length} chunk(s) but expected ${chunks.length}.`,
    });
  }

const fixed = joinByDelimiter(outChunks, d);
return res.json({ text: fixed });

  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

app.post("/api/rewrite/learn", async (req, res) => {
  try {
    const { preset = "", input = "", output = "" } = req.body || {};
    const p = String(preset || "").toLowerCase().trim();

    if (!ADAPTIVE_PRESETS.has(p)) {
      return res.status(400).json({ error: "Preset must be micro, gross, or path." });
    }

    const normalized = normalizeLearningExample(input, output);
    if (!normalized) {
      return res.status(400).json({ error: "Both input and output are required." });
    }

    await appendPersistedLearningExample(p, normalized.input, normalized.output);
    return res.json({ ok: true, preset: p });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/rewrite/reload-style-seed", async (_req, res) => {
  try {
    await loadStyleSeedLibrary();
    return res.json({ ok: true, counts: {
      micro: styleSeedLibrary.micro.length,
      gross: styleSeedLibrary.gross.length,
      path: styleSeedLibrary.path.length,
    } });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- LISTEN ----
const PORT = process.env.PORT || 3000;

await loadStyleSeedLibrary();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
