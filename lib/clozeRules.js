// Loads the large, hand-tuned prompt rule sets from plain text files instead
// of embedding ~30KB of template literals in server.js. This is the file you
// edit when you want to tweak cloze philosophy/wording — no JS required.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

function loadPrompt(filename) {
  return readFileSync(path.join(PROMPTS_DIR, filename), "utf8").trim();
}

// Refine-tab rules (single/multi-card, delimiter-based, /api/refine)
export const RULES = loadPrompt("refine-rules.txt");

// Export-tab three-pass pipeline rules (/api/export-refine)
export const EXPORT_RULES = loadPrompt("export-rules.txt");
export const EXPORT_CLOZE_AUDIT_RULES = loadPrompt("export-audit-rules.txt");
export const EXPORT_FINAL_QA_RULES = loadPrompt("export-final-qa-rules.txt");

export const EXPORT_COMPLEX_MARKER = "<!--EXPORT_COMPLEX-->";
