import test from "node:test";
import assert from "node:assert/strict";
import { acceptHintOnlyEdit, withoutAnkiHints } from "../lib/ankiHintPass.js";

test("accepts additions and refinements limited to Anki hints", () => {
  const finalized = "Protein S: {{c1::↓}}; fibrinogen: {{c1::↑::direction}}";
  const hinted = "Protein S: {{c1::↓::↓ or ↑?}}; fibrinogen: {{c1::↑::↓ or ↑?}}";
  assert.equal(acceptHintOnlyEdit(finalized, hinted), hinted);
  assert.equal(withoutAnkiHints(hinted), "Protein S: {{c1::↓}}; fibrinogen: {{c1::↑}}");
});

test("rejects any content or cloze-answer change from the hint pass", () => {
  const finalized = "Sensitivity is ~{{c7::88}}%";
  assert.equal(acceptHintOnlyEdit(finalized, "Sensitivity: {{c7::88::percentage}}%"), finalized);
  assert.equal(acceptHintOnlyEdit(finalized, "Sensitivity is ~{{c7::90::percentage}}%"), finalized);
  assert.equal(acceptHintOnlyEdit(finalized, "Sensitivity is ~{{c1::88::percentage}}%"), finalized);
});

test("falls back to the finalized card for empty output", () => {
  assert.equal(acceptHintOnlyEdit("{{c1::UGT1A1}}", ""), "{{c1::UGT1A1}}");
});
