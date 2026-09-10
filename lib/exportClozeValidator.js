const CLOZE_PATTERN = /\{\{c(\d+)::([\s\S]*?)\}\}/gi;

const FRAGMENT_ENDINGS = new Set([
  "increase", "decrease", "increased", "decreased", "produces", "produced",
  "causes", "associated", "common", "found", "mainly", "mostly", "usually", "more", "less",
]);

const GENERIC_ANSWERS = new Set([
  "a", "an", "and", "associated", "causes", "decrease", "decreased", "increase",
  "increased", "less", "mainly", "more", "most common", "mostly", "produced", "produces", "the",
  "usually found",
  "usually",
]);

// Four-word terms are exceptional, not a general allowance. Keep this list
// deliberately narrow so every other >3-word span receives the final semantic
// review requested by the export pipeline.
const INSEPARABLE_LONG_MEDICAL_UNITS = new Set([
  "anion gap metabolic acidosis",
]);

function answerOnly(inner) {
  return String(inner || "").split("::")[0].trim();
}

function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGiantCloze(answer) {
  const plain = plainText(answer);
  const words = plain.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  const breaks = answer.match(/<br\s*\/?>/gi)?.length || 0;
  const sentences = plain.match(/[.!?](?=\s|$)/g)?.length || 0;
  const labels = answer.match(/(?:^|<br\s*\/?>|\n)\s*(?:[•*-]\s*)?[\p{L}][\p{L}\p{N} /()+-]{0,35}:/giu)?.length || 0;
  const bullets = answer.match(/(?:^|<br\s*\/?>|\n)\s*(?:[•*-]|\d+[.)])\s+/giu)?.length || 0;

  return words.length > 18
    || plain.length > 140
    || breaks >= 2
    || sentences >= 2
    || labels >= 2
    || bullets >= 2;
}

function isOversizedCloze(answer) {
  const plain = plainText(answer);
  const words = plain.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  return words.length > 3 && !INSEPARABLE_LONG_MEDICAL_UNITS.has(plain.toLowerCase());
}

function isGrammarFragment(answer, followingText) {
  const plain = plainText(answer).replace(/[,:;.!?]+$/g, "").trim();
  const words = plain.toLowerCase().match(/[\p{L}]+/gu) || [];
  const last = words.at(-1) || "";
  if (FRAGMENT_ENDINGS.has(last)) return true;

  // Directional verb + adjective with a visible noun, e.g. "Increase pancreatic}} secretion".
  const startsWithDirection = /^(?:increase|decrease|increased|decreased)\b/i.test(plain);
  const endsLikeAdjective = /(?:ic|al|ary|ive|ous|ent|ant)$/i.test(last);
  const visibleNounFollows = /^\s*(?:<[^>]+>\s*)*[\p{L}][\p{L}'’-]*/u.test(followingText);
  return startsWithDirection && endsLikeAdjective && visibleNounFollows;
}

function hasBadGrouping(matches, card) {
  const byNumber = new Map();
  for (const match of matches) {
    const entries = byNumber.get(match.number) || [];
    entries.push(match);
    byNumber.set(match.number, entries);
  }

  return [...byNumber.values()].some((entries) => {
    if (entries.length < 4) return false;
    const between = card.slice(entries[0].end, entries.at(-1).index);
    const structuralBreaks = between.match(/<br\s*\/?>|\n|[•]/gi)?.length || 0;
    return structuralBreaks >= 3;
  });
}

/** Deterministically inspects final Anki cloze syntax without editing the card. */
export function validateExportClozes(card) {
  const value = String(card || "");
  const matches = [...value.matchAll(CLOZE_PATTERN)].map((match) => ({
    number: match[1],
    answer: answerOnly(match[2]),
    index: match.index,
    end: match.index + match[0].length,
  }));
  const reasons = new Set();

  if (!matches.length || matches.every(({ answer }) => GENERIC_ANSWERS.has(plainText(answer).toLowerCase()))) {
    reasons.add("no_meaningful_cloze");
  }

  for (const match of matches) {
    if (isGiantCloze(match.answer)) reasons.add("giant_cloze");
    if (isOversizedCloze(match.answer)) reasons.add("oversized_cloze");
    if (isGrammarFragment(match.answer, value.slice(match.end))) reasons.add("grammar_fragment");
  }
  if (hasBadGrouping(matches, value)) reasons.add("bad_grouping");

  return { passed: reasons.size === 0, reasons: [...reasons] };
}
