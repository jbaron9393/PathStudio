console.log("Loaded server.js from:", process.cwd());

import express from "express";
import dotenv from "dotenv";
import path from "path";
import os from "os";
import { existsSync, promises as fs } from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import * as zlib from "zlib";
import { syncGrossingManualVendor } from "./scripts/sync-grossing-manual.mjs";

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

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
    <form method="post" action="/api/login" style="box-sizing:border-box;width:min(420px,calc(100% - 32px));background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:22px;box-shadow:0 8px 24px rgba(15,23,42,.08);">
      <h1 style="margin:0 0 6px;font-size:20px;">Sign in</h1>
      <p style="margin:0 0 16px;color:#475569;">Enter your username/path to open Cloze Refiner.</p>
      ${safeError}
      <label for="username" style="display:block;font-weight:600;margin-bottom:6px;">Username</label>
      <input id="username" name="username" type="text" required autofocus style="box-sizing:border-box;width:100%;max-width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;" />
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

// Extract note fields from an Anki package without modifying the uploaded deck.
// An .apkg is a ZIP archive containing a SQLite collection database.
app.post(
  "/api/exports/apkg",
  express.raw({ type: "application/octet-stream", limit: "100mb" }),
  async (req, res) => {
    let tempDir = "";
    try {
      const fileName = decodeURIComponent(String(req.get("x-file-name") || "deck.apkg"));
      if (!fileName.toLowerCase().endsWith(".apkg")) {
        return res.status(400).send("Please upload an .apkg file.");
      }
      if (!Buffer.isBuffer(req.body) || req.body.length < 4) {
        return res.status(400).send("The uploaded .apkg file is empty.");
      }
      if (req.body[0] !== 0x50 || req.body[1] !== 0x4b) {
        return res.status(400).send("The uploaded file is not a valid Anki package.");
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pathstudio-apkg-"));
      const archivePath = path.join(tempDir, "upload.apkg");
      const databasePath = path.join(tempDir, "collection.sqlite");
      await fs.writeFile(archivePath, req.body);

      const { stdout: archiveList } = await execFileAsync("unzip", ["-Z1", archivePath], {
        maxBuffer: 4 * 1024 * 1024,
      });
      const databaseEntry = String(archiveList)
        .split(/\r?\n/)
        .find((entry) => /^(?:collection\.anki2|collection\.anki21b?)$/i.test(entry.trim()));
      if (!databaseEntry) {
        return res.status(400).send("This package does not contain an Anki collection database.");
      }

      const { stdout: database } = await execFileAsync(
        "unzip",
        ["-p", archivePath, databaseEntry.trim()],
        { encoding: "buffer", maxBuffer: 250 * 1024 * 1024 },
      );
      let collectionDatabase = database;
      if (/\.anki21b$/i.test(databaseEntry.trim())) {
        if (typeof zlib.zstdDecompress !== "function") {
          return res.status(500).send("This newer Anki package requires Node.js 22.15 or later to decompress.");
        }
        collectionDatabase = await promisify(zlib.zstdDecompress)(database);
      }
      await fs.writeFile(databasePath, collectionDatabase);

      const { stdout: noteJson } = await execFileAsync(
        "sqlite3",
        [
          "-json",
          "-readonly",
          databasePath,
          `SELECT n.id, n.tags, hex(n.flds) AS fldsHex, MIN(c.id) AS firstCardId
           FROM notes AS n
           LEFT JOIN cards AS c ON c.nid = n.id
           GROUP BY n.id
           ORDER BY COALESCE(MIN(c.id), n.id), n.id
           LIMIT 5001;`,
        ],
        { maxBuffer: 100 * 1024 * 1024 },
      );
      const rows = JSON.parse(noteJson || "[]");
      if (rows.length > 5000) {
        return res.status(413).send("This deck has more than 5,000 notes. Export a smaller Anki deck and try again.");
      }

      const notes = rows.map((row, index) => {
        const rawFields = Buffer.from(String(row.fldsHex || ""), "hex").toString("utf8");
        const fields = rawFields
          .split("\u001f")
          .map((field) => field.trim());
        return {
          id: String(row.id || index + 1),
          sourceOrder: index,
          firstCardId: String(row.firstCardId || row.id || index + 1),
          tags: String(row.tags || "").trim(),
          fields,
          text: fields.filter(Boolean).join("\n"),
        };
      }).filter((note) => note.text);

      return res.json({ fileName, noteCount: notes.length, notes });
    } catch (error) {
      console.error("APKG extraction failed:", error);
      const missingTool = error?.code === "ENOENT";
      return res.status(500).send(
        missingTool
          ? "APKG extraction requires the unzip and sqlite3 utilities on the server."
          : `Unable to read this Anki package: ${error?.message || error}`,
      );
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

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
- Output plain card text and Anki cloze wrappers only.
- Do not output HTML tags, text colors, style attributes, Markdown emphasis, or other presentation code.

CLOZE RULES
- Never use nested clozes.
- Cloze numbers must be sequential starting at c1 within each card.
- Cloze 1–2 words whenever possible. Use 3 words only when the medical term cannot be shortened without becoming unclear; never cloze more than 3 words.
- If an existing cloze contains a sentence or list, move all supporting text outside the wrapper and keep only a medically meaningful 1–2 word anchor clozed.
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
- Preserve all existing cloze numbers and their tested concepts, except that an oversized list wrapper must be redistributed across selected terms as described below.
- If an existing cloze block is too long, reorganize it so every original fact remains visible, but only a 1–2 word anchor is inside the wrapper (3 words only when unavoidable).
- When a single existing cloze wraps an entire list, remove that outer wrapper and reuse its SAME cloze number on only the 2–4 most medically important complete terms in the list. Leave every other list item visible and unclozed. This redistribution does not count as adding a new cloze number.
- Never cloze a word fragment (for example, do not turn "Angelman" into "Angel{{c1::man}}"). Cloze the complete medical term or leave it visible.
- Never cloze HTML tag names or attributes (for example, never produce <{{c1::span}} style="...">). Ignore presentation markup and cloze the medical concept itself.

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

  // Otherwise prefer the first complete non-numeric term. This keeps list
  // numbering outside the cloze and guarantees an exact substring match.
  const words = Array.from(s.matchAll(/[A-Za-z][A-Za-z'’-]*/g));
  if (!words.length) return s;
  return words[0][0];
}

function enforceClozeWordLimit(text, maxWords = 3) {
  if (!text) return text;

  return text.replace(/\{\{c(\d+)::([\s\S]*?)\}\}/g, (full, n, inner) => {
    const parts = String(inner).split("::");
    const content = String(parts.shift() || "").trim();
    const hint = parts.length ? parts.join("::").trim() : "";
    const words = content.split(/\s+/).filter(Boolean);

    if (words.length <= maxWords) return full;

    // Keep the full answer visible and move only the short anchor inside the
    // cloze. The former implementation discarded everything after the anchor.
    const anchor = pickAnchorWords(content, maxWords);
    const anchorIndex = content.toLowerCase().indexOf(anchor.toLowerCase());
    if (anchorIndex < 0) return content;
    const wrappedAnchor = `{{c${n}::${content.slice(anchorIndex, anchorIndex + anchor.length)}${hint ? `::${hint}` : ""}}}`;
    return `${content.slice(0, anchorIndex)}${wrappedAnchor}${content.slice(anchorIndex + anchor.length)}`;
  });
}

function removePartialWordClozes(text) {
  return String(text || "").replace(/\{\{c\d+::([^{}]*?)(?:::[^{}]*?)?\}\}/gi, (full, answer, offset, source) => {
    const previous = source[offset - 1] || "";
    const next = source[offset + full.length] || "";
    return /[a-z0-9]/i.test(previous) || /[a-z0-9]/i.test(next) ? answer : full;
  });
}

function hasInvalidClozeShape(text) {
  const value = String(text || "");
  const weakAnchors = new Set([
    "collect", "first-trimester", "gram", "more", "months", "severe", "temporal",
  ]);
  if (/<\s*\{\{c\d+::/i.test(value)) return true;

  for (const match of value.matchAll(/\{\{c\d+::([^{}]*?)(?:::[^{}]*?)?\}\}/gi)) {
    const answer = String(match[1] || "").trim();
    if (answer.split(/\s+/).filter(Boolean).length > 2) return true;
    if (weakAnchors.has(answer.toLowerCase().replace(/[.,;:!?]+$/g, ""))) return true;
    const previous = value[match.index - 1] || "";
    const next = value[match.index + match[0].length] || "";
    if (/[a-z0-9]/i.test(previous) || /[a-z0-9]/i.test(next)) return true;
  }
  return false;
}

function stripPresentationHtml(text) {
  return String(text || "")
    .replace(/<\s*\{\{c\d+::(?:div|font|span|b|strong|i|em|u)\}\}[^>]*>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:div|p|li|ul|ol|h[1-6])\s*>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&");
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

function retainOriginalCardsWhenContentIsLost(outText, inText, delimiter = "===CARD===") {
  const d = String(delimiter || "===CARD===");
  const outputCards = String(outText || "").split(d);
  const inputCards = String(inText || "").split(d);

  const contentTokens = (card) => String(card || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{\{c\d+::|\}\}/gi, " ")
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.filter((token) => token.length > 1) || [];

  return inputCards.map((inputCard, index) => {
    const outputCard = outputCards[index];
    if (!outputCard?.trim()) return inputCard;

    const inputTokens = contentTokens(inputCard);
    if (inputTokens.length < 8) return outputCard;

    // Compare token counts as a multiset so repeated numbered-list content is
    // also protected. If refinement drops substantial source information, the
    // untouched original is safer than an incomplete card.
    const available = new Map();
    contentTokens(outputCard).forEach((token) => {
      available.set(token, (available.get(token) || 0) + 1);
    });
    let retained = 0;
    inputTokens.forEach((token) => {
      const count = available.get(token) || 0;
      if (count > 0) {
        retained += 1;
        available.set(token, count - 1);
      }
    });

    // Long, wordy cards are allowed to lose redundant phrasing as they are
    // condensed. Shorter cards retain the stricter threshold so a concise
    // source is not accidentally gutted.
    const minimumRetention = inputTokens.length >= 70 ? 0.4 : 0.8;
    return retained / inputTokens.length >= minimumRetention ? outputCard : inputCard;
  }).join(d);
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
      extraRules = "",
      preserveContent = false
    } = req.body || {};

    const rawText = String(text || "").trim();
    if (!rawText) return res.status(400).send("Missing 'text'.");

    const d = String(delimiter || "===CARD===");
    const extra = String(extraRules || "").trim();
    const preservationRules = preserveContent ? `
EXPORT CONTENT-PRESERVATION RULES:
- Retain all CORE medical facts, diagnoses, mechanisms, qualifiers, hallmark findings, and numbered items from every original card.
- For long or repetitive cards, actively shorten redundant prose, combine overlapping statements, and reorganize into concise, skimmable sections. Do not merely reproduce a wordy paragraph.
- Keep the minimum context needed to understand each mechanism and cloze; remove filler transitions and repeated explanations without removing board-relevant pathology facts.
- Improve existing clozes according to the Refiner rules. For a long clozed list, retain every item as visible text; for a wordy sentence, retain its core fact while moving only a medically meaningful 1–2 word anchor inside the wrapper.
- Reorder sections or list items when that makes the pathology concept easier to study.
- Return plain card text and Anki cloze wrappers only. Do not output HTML tags, style attributes, text colors, Markdown, or code fences.
- For a list enclosed by one cloze, unwrap the list and reuse that cloze number on the 2–4 highest-yield pathology terms rather than clozing the whole list or merely its first item.
- In export mode, you may add a new sequential cloze when a long card contains an important unclozed diagnosis, mechanism, hallmark histology, or complication. Add only what materially improves recall and do not over-cloze.
- Export mode may relocate or remove an existing poor cloze; preserve the tested fact, not a bad wrapper. Choose the answer the prompt is actually asking for.
- Never cloze generic grammar or low-information words such as "more," "severe," "collect," "Gram," "temporal," or a unit such as "months." Cloze the discriminating diagnosis, finding, organism, specimen, or number instead.
- For a number plus unit, cloze the number and leave the unit visible (for example, {{c1::3}} months). For an instruction, leave the action visible and cloze the specimen or test (for example, Collect first voided {{c1::urine}}).
- Reuse a cloze number for tightly linked facts that should be recalled together, and consolidate excessive numbering into a small logical set. Keep numbering sequential.
- Format disease-to-repeat, organism-to-product, syndrome-to-genetics, and similar mappings as short parallel lines. Cloze the distinguishing side of each relationship, not the heading or filler text.
- Favor board-discriminating pathology anchors: the diagnosis after sensitivity/specificity language, hallmark morphology, causative mutation, characteristic organism, key lab, inheritance, and defining complication.
` : "";

    let input = "";

    // =======================
    // CUSTOM RULES MODE
    // =======================
    if (extra) {
      input = `
You are editing Anki cloze cards.

${RULES}
${preservationRules}

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
${preservationRules}

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
    let out = await callOpenAI({ apiKey, model, temperature, input });

    // Give the model one focused repair pass when it returns long, partial-word,
    // or HTML-tag clozes. This lets it choose medically meaningful anchors
    // instead of relying on a generic first-word fallback.
    if (hasInvalidClozeShape(out)) {
      const repairInput = `
You are repairing Anki cloze cards for pathology boards.

SOURCE CARDS (retain every core medical fact):
${rawText}

DRAFT TO REPAIR:
${out}

Return only the repaired cards, separated by ${d} exactly as in the source.
- Condense redundant wording and reorganize long cards into skimmable sections, while retaining core pathology mechanisms, findings, and complications.
- Every cloze answer must be a complete, medically meaningful 1–2 word term.
- Never cloze a word fragment, HTML tag, attribute, list-item number, whole sentence, or whole list.
- Replace vague clozes on words like "more," "severe," "collect," "Gram," "temporal," or "months" with the actual discriminating answer. Cloze a number rather than its unit and a specimen/test rather than an instruction verb.
- You may relocate, remove, add, or reuse cloze wrappers as needed in export mode; keep a small logical set of sequential cloze numbers and preserve the underlying facts.
- If one cloze wraps a list, unwrap it and reuse that same cloze number on the 2–4 highest-yield pathology terms; keep all other items visible.
- Output plain text plus Anki {{cN::answer}} wrappers only: no HTML, Markdown, code fences, or commentary.
`.trim();
      out = await callOpenAI({ apiKey, model, temperature: 0.1, input: repairInput });
    }

    // Enforce the structural cloze guarantees in both normal and custom-rules modes.
    // User rules can steer content selection, but should not accidentally create
    // long clozes, new clozes on an already-clozed card, or broken numbering.
    let fixed = out;
    // Content fallback must happen before formatting/cloze enforcement. Doing it
    // last could restore the original card's oversized clozes unchanged.
    if (preserveContent) fixed = retainOriginalCardsWhenContentIsLost(fixed, rawText, d);
    fixed = stripPresentationHtml(fixed);
    if (!preserveContent) fixed = capClozesToInput(fixed, rawText, d);
    fixed = enforceClozeWordLimit(fixed, 2);
    fixed = removePartialWordClozes(fixed);
    fixed = renumberClozesPerCard(fixed, d);
    fixed = limitEmphasisFormatting(fixed, d, 3, 3);
    if (preserveContent) fixed = retainOriginalCardsWhenContentIsLost(fixed, rawText, d);

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
