// Moving anchor tokens through an edit made in a Decks editor, so a rewritten
// host keeps the ids it carried. Both surfaces' note writers use these.
import {
  decodeAnchorValue,
  encodeAnchorValue,
  extractAnchorTokens,
  formatAnchorToken,
  isIdValue,
  type AnchorToken,
} from "./anchors";
import { scanClozeDeletions, scanLineDeletions } from "./cloze-scanner";

const CLOZE_TEST = /==((?:(?!==).)+)==/;

/** Refit a packed value to rewritten text: same-text deletions keep their ids, leftovers pair in order. */
export function refitPackedValue(
  value: string,
  oldDeletions: string[],
  newDeletions: string[]
): string | null {
  const decoded = decodeAnchorValue(value);
  if (!decoded || decoded.kind !== "p") return value;
  const oldIds = oldDeletions.map((_, j) => decoded.ids[j] ?? null);
  const used = new Set<number>();
  const ids: (string | null)[] = newDeletions.map((text) => {
    const j = oldDeletions.findIndex(
      (old, idx) => !used.has(idx) && oldIds[idx] !== null && old === text
    );
    if (j < 0) return null;
    used.add(j);
    return oldIds[j];
  });
  const spare = oldIds
    .map((id, j) => (id !== null && !used.has(j) ? j : -1))
    .filter((j) => j >= 0);
  for (let k = 0; k < ids.length && spare.length > 0; k++) {
    if (ids[k] === null) ids[k] = oldIds[spare.shift()!];
  }
  if (ids.length === 0 || ids.every((id) => id === null)) return null;
  return encodeAnchorValue("p", ids);
}

/** The text a table row's clozes come from, as the parser picks it. */
export function tableClozeSource(cells: string[]): string {
  return CLOZE_TEST.test(cells[0] ?? "") ? cells[0] : cells[1] ?? "";
}

/** The `t` token a rewritten row keeps, packed ids following their deletions (cells are cleaned). */
export function carryRowToken(
  rowLine: string,
  oldCells: string[],
  newCells: string[]
): AnchorToken | null {
  const token = extractAnchorTokens(rowLine).tokens.find((t) => t.role === "t");
  if (!token) return null;
  const texts = (cells: string[]): string[] =>
    scanClozeDeletions(tableClozeSource(cells)).map((d) => d.text);
  const id = refitPackedValue(token.id, texts(oldCells), texts(newCells));
  return id === null ? null : { role: "t", id };
}

/**
 * Carry tokens from a card's old body into its rebuilt one. A rewritten cloze line's
 * token follows its deletions.
 */
export function carryBodyAnchors(oldBody: string[], bodyLines: string[]): void {
  const headerTokens: AnchorToken[] = [];
  const questionTokens: AnchorToken[] = [];
  const lineTokens: { cleaned: string; token: AnchorToken; index: number }[] = [];
  oldBody.forEach((line, index) => {
    const { cleaned, tokens } = extractAnchorTokens(line);
    for (const token of tokens) {
      if (token.role === "h") headerTokens.push(token);
      else if (token.role === "q") questionTokens.push(token);
      else lineTokens.push({ cleaned: cleaned.trim(), token, index });
    }
  });

  const claimed = new Set<number>();
  const attach = (i: number, token: AnchorToken): void => {
    bodyLines[i] = `${bodyLines[i]} ${formatAnchorToken(token.role, token.id)}`;
    claimed.add(i);
  };
  const unplaced: typeof lineTokens = [];
  for (const entry of lineTokens) {
    const i = bodyLines.findIndex((line, idx) => !claimed.has(idx) && line.trim() === entry.cleaned);
    if (i >= 0) attach(i, entry.token);
    else unplaced.push(entry);
  }

  for (const { cleaned, token, index } of unplaced) {
    // Minted values resolve by position through bindings, so a rewritten line drops them.
    if (token.role !== "c" || !isIdValue(token.id)) continue;
    const oldTexts = scanLineDeletions(cleaned).map((d) => d.text);
    let best = -1;
    let bestShared = 0;
    bodyLines.forEach((line, i) => {
      if (claimed.has(i)) return;
      const newTexts = scanLineDeletions(line).map((d) => d.text);
      const shared = newTexts.filter((t) => oldTexts.includes(t)).length;
      if (shared > bestShared) {
        best = i;
        bestShared = shared;
      }
    });
    if (best < 0 && index < bodyLines.length && !claimed.has(index)) best = index;
    if (best < 0) continue;
    const newTexts = scanLineDeletions(bodyLines[best]).map((d) => d.text);
    const id = refitPackedValue(token.id, oldTexts, newTexts);
    if (id !== null) attach(best, { role: "c", id });
  }

  const lastContentIndex = (): number => {
    for (let i = bodyLines.length - 1; i >= 0; i--) {
      if (bodyLines[i].trim() !== "") return i;
    }
    return -1;
  };
  if (headerTokens.length > 0) {
    bodyLines.splice(lastContentIndex() + 1, 0, formatAnchorToken("h", headerTokens[0].id));
  }
  if (questionTokens.length > 0) {
    bodyLines.splice(lastContentIndex() + 1, 0, "", formatAnchorToken("q", questionTokens[0].id));
  }
}
