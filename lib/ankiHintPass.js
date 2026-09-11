const CLOZE_PATTERN = /\{\{c(\d+)::([\s\S]*?)\}\}/gi;

/** Remove only Anki's optional hint segment while preserving each cloze answer. */
export function withoutAnkiHints(card) {
  return String(card || "").replace(CLOZE_PATTERN, (_match, number, inner) => {
    const answer = String(inner).split("::")[0];
    return `{{c${number}::${answer}}}`;
  });
}

/** Accept a hint-pass result only when hints are the sole change it made. */
export function acceptHintOnlyEdit(finalizedCard, hintedCard) {
  if (typeof hintedCard !== "string" || !hintedCard.trim()) return finalizedCard;
  return withoutAnkiHints(hintedCard) === withoutAnkiHints(finalizedCard)
    ? hintedCard
    : finalizedCard;
}
