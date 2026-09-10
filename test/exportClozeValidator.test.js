import test from "node:test";
import assert from "node:assert/strict";
import { validateExportClozes } from "../lib/exportClozeValidator.js";

test("accepts compact medical clozes", () => {
  assert.deepEqual(validateExportClozes("CCK: ↑ {{c1::pancreatic secretion}}"), { passed: true, reasons: [] });
  assert.deepEqual(validateExportClozes("Acidosis: {{c1::anion gap metabolic acidosis}}"), { passed: true, reasons: [] });
});

test("requires final review of every cloze longer than three words", () => {
  assert.deepEqual(validateExportClozes("{{c1::Normal growth and pregnancy}}"), {
    passed: false,
    reasons: ["oversized_cloze"],
  });
  assert.deepEqual(validateExportClozes("{{c1::N-acetylcysteine}} → regenerates glutathione"), {
    passed: true,
    reasons: [],
  });
});

test("detects giant sections and labeled relationships", () => {
  const card = "{{c1::Total: diazo with accelerator<br>Direct: diazo without accelerator<br>Indirect: total minus direct}}";
  assert.deepEqual(validateExportClozes(card), {
    passed: false,
    reasons: ["giant_cloze", "oversized_cloze"],
  });
});

test("detects arbitrary grammatical fragments", () => {
  assert.deepEqual(validateExportClozes("{{c1::Increase pancreatic}} secretion"), {
    passed: false,
    reasons: ["grammar_fragment"],
  });
  assert.equal(validateExportClozes("{{c1::Produced mainly}} in liver").passed, false);
  assert.equal(validateExportClozes("{{c1::Usually found}} in plasma").passed, false);
  assert.equal(validateExportClozes("{{c1::Most common}} cause").passed, false);
});

test("keeps representative repaired comparison cards unchanged", () => {
  const cards = [
    "Bilirubin measurement:<br>Total: Diazocolorimetric {{c1::with accelerator}}<br>Direct: Diazocolorimetric {{c1::without accelerator}}<br>Indirect: {{c2::Total − Direct}}",
    "AST vs ALT:<br>{{c1::AST}} → more sensitive, less specific<br>{{c1::ALT}} → more liver-specific",
    "Ammonia is detoxified by the {{c1::urea cycle}}.",
    "{{c1::Conjugated bilirubin}} is water-soluble; unconjugated bilirubin is lipid-soluble.",
  ];
  for (const card of cards) assert.deepEqual(validateExportClozes(card), { passed: true, reasons: [] });
});

test("detects cards without a meaningful target", () => {
  assert.deepEqual(validateExportClozes("Visible explanation only"), {
    passed: false,
    reasons: ["no_meaningful_cloze"],
  });
});

test("detects one cloze number spread over many independent bullets", () => {
  const card = ["• {{c1::Liver}}", "• {{c1::Bone}}", "• {{c1::Placenta}}", "• {{c1::Kidney}}"].join("<br>");
  assert.deepEqual(validateExportClozes(card), { passed: false, reasons: ["bad_grouping"] });
});
