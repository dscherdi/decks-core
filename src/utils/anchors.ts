/**
 * Decks anchor tokens: `%%dk:<role>:<id>%%` comments that carry a card's
 * stable identity inside the note. Tokens are stripped from all parsed card
 * content and mapped to binding keys used by the sync layer.
 */

export type AnchorRole = "h" | "c" | "t" | "o" | "q";

export interface AnchorToken {
    role: AnchorRole;
    id: string;
}

export interface LineAnchor extends AnchorToken {
    lineIndex: number;
}

const TOKEN_PATTERN = "%%dk:([hctoq]):([a-z0-9]+)%%";
const STRIP_PATTERN = `[ \\t]*${TOKEN_PATTERN}`;

/** Matches one anchor token; comment body must be exactly `dk:<role>:<id>`. */
export const DK_TOKEN_REGEX = new RegExp(TOKEN_PATTERN, "g");

const ANCHOR_COMMENT_BODY_REGEX = /^dk:[hctoq]:[a-z0-9]+$/;

/** True when the inner text of a `%%…%%` comment is an anchor token body. */
export function isAnchorCommentBody(inner: string): boolean {
    return ANCHOR_COMMENT_BODY_REGEX.test(inner.trim());
}

/** Remove every anchor token (with any preceding inline whitespace). */
export function stripAnchorTokens(text: string): string {
    return text.replace(new RegExp(STRIP_PATTERN, "g"), "");
}

/** Split one line into its cleaned text and the tokens found on it, in order. */
export function extractAnchorTokens(line: string): {
    cleaned: string;
    tokens: AnchorToken[];
} {
    const tokens: AnchorToken[] = [];
    const cleaned = line.replace(
        new RegExp(STRIP_PATTERN, "g"),
        (_match, role: string, id: string) => {
            tokens.push({ role: role as AnchorRole, id });
            return "";
        },
    );
    return { cleaned, tokens };
}

/**
 * Strip tokens from a block of lines. The single chokepoint used by the
 * parser: `.lines` feeds card content, `.anchors` feeds identity matching.
 */
export function extractLineAnchors(lines: string[]): {
    lines: string[];
    anchors: LineAnchor[];
} {
    const anchors: LineAnchor[] = [];
    const cleanedLines = lines.map((line, lineIndex) => {
        const { cleaned, tokens } = extractAnchorTokens(line);
        for (const token of tokens) {
            anchors.push({ ...token, lineIndex });
        }
        return cleaned;
    });
    return { lines: cleanedLines, anchors };
}

export interface AnchorSpan extends AnchorToken {
    /** Offset of the first character to hide, including preceding inline whitespace. */
    start: number;
    /** Offset just past the closing `%%`. */
    end: number;
}

/** Private instance: `lastIndex` is reset per call, so no state leaks between callers. */
const SPAN_REGEX = new RegExp(STRIP_PATTERN, "g");

/**
 * Locate every anchor token in one line, as offsets. Same match rule as
 * `stripAnchorTokens`, so hiding a span shows exactly what the parser sees.
 */
export function findAnchorSpans(line: string): AnchorSpan[] {
    const spans: AnchorSpan[] = [];
    SPAN_REGEX.lastIndex = 0;
    for (let m = SPAN_REGEX.exec(line); m !== null; m = SPAN_REGEX.exec(line)) {
        spans.push({
            role: m[1] as AnchorRole,
            id: m[2],
            start: m.index,
            end: m.index + m[0].length,
        });
    }
    return spans;
}

/**
 * What an id-carrying value holds: `a` one card, `b` a card and its reverse,
 * `c` one cloze-family card, `p` one cloze id per deletion (slot k = k-th deletion).
 */
export type AnchorValueKind = "a" | "b" | "c" | "p";

const ID_VALUE = /^0([abcp])([6d])([0-9a-z]+)$/;
const WIDTH_BY_CHAR: Record<string, number> = { "6": 6, d: 13 };
const ID_BODY = /^[1-9a-z][0-9a-z]*$/;

/** The id prefix each slot of a kind decodes to. */
function slotPrefix(kind: AnchorValueKind, slot: number): string {
  if (kind === "a") return "card_";
  if (kind === "b") return slot === 0 ? "card_" : "rcard_";
  return "ccard_";
}

/** Which roles may carry which kinds; anything else is ignored. */
const KINDS_BY_ROLE: Record<AnchorRole, readonly AnchorValueKind[]> = {
  h: ["a", "b"],
  q: ["a"],
  t: ["a", "b", "p"],
  o: ["c"],
  c: ["p"],
};

/**
 * True for a value that carries card ids rather than a minted hash. Minted
 * values come from `Number#toString(36)`, which never starts with `0`.
 */
export function isIdValue(value: string): boolean {
  return ID_VALUE.test(value);
}

/** The ids a value carries, `null` for a slot not yet assigned. Null for a malformed value. */
export function decodeAnchorValue(
  value: string
): { kind: AnchorValueKind; ids: (string | null)[] } | null {
  const match = ID_VALUE.exec(value);
  if (!match) return null;
  const kind = match[1] as AnchorValueKind;
  const width = WIDTH_BY_CHAR[match[2]];
  const payload = match[3];
  if (payload.length % width !== 0) return null;
  const count = payload.length / width;
  if ((kind === "a" || kind === "c") && count !== 1) return null;
  if (kind === "b" && count !== 2) return null;
  const ids: (string | null)[] = [];
  for (let slot = 0; slot < count; slot++) {
    const body = payload.slice(slot * width, (slot + 1) * width).replace(/^0+/, "");
    if (body === "") {
      // Only a per-deletion slot or a reverse slot may be left unassigned.
      if (kind === "a" || kind === "c" || (kind === "b" && slot === 0)) return null;
      ids.push(null);
    } else {
      ids.push(slotPrefix(kind, slot) + body);
    }
  }
  return { kind, ids };
}

/** A value carrying these ids, or null when one can't be carried (wrong prefix or too long). */
export function encodeAnchorValue(
  kind: AnchorValueKind,
  ids: (string | null)[]
): string | null {
  const expected = kind === "b" ? 2 : kind === "p" ? Math.max(ids.length, 1) : 1;
  if (ids.length !== expected) return null;
  const bodies: string[] = [];
  for (let slot = 0; slot < ids.length; slot++) {
    const id = ids[slot];
    if (id === null) {
      if (kind === "a" || kind === "c" || (kind === "b" && slot === 0)) return null;
      bodies.push("");
      continue;
    }
    const prefix = slotPrefix(kind, slot);
    if (!id.startsWith(prefix)) return null;
    const body = id.slice(prefix.length);
    if (!ID_BODY.test(body)) return null;
    bodies.push(body);
  }
  const longest = Math.max(...bodies.map((b) => b.length));
  const widthChar = longest <= 6 ? "6" : longest <= 13 ? "d" : null;
  if (widthChar === null) return null;
  const width = WIDTH_BY_CHAR[widthChar];
  return `0${kind}${widthChar}${bodies.map((b) => b.padStart(width, "0")).join("")}`;
}

/** The parts of a binding key: role, token value, and which card of the host it names. */
export function parseBindingKey(
  key: string
): { role: string; value: string; slot: number | null; reverse: boolean } | null {
  const match = /^([a-z]):([^#:]+)(?:#(\d+))?(:rev)?$/.exec(key);
  if (!match) return null;
  return {
    role: match[1],
    value: match[2],
    slot: match[3] === undefined ? null : Number(match[3]),
    reverse: match[4] !== undefined,
  };
}

/** True when a key's token value carries ids, so it resolves without any lookup. */
export function isIdKey(key: string): boolean {
  const parts = parseBindingKey(key);
  return parts !== null && isIdValue(parts.value);
}

/**
 * The card id a key names when its token carries ids; null for a minted value,
 * a kind the role can't carry, or a slot not assigned yet.
 */
export function cardIdForKey(key: string): string | null {
  const parts = parseBindingKey(key);
  if (!parts) return null;
  const decoded = decodeAnchorValue(parts.value);
  if (!decoded) return null;
  const allowed = KINDS_BY_ROLE[parts.role as AnchorRole];
  if (!allowed || !allowed.includes(decoded.kind)) return null;
  if (decoded.kind === "p") {
    if (parts.slot === null || parts.reverse) return null;
    return decoded.ids[parts.slot] ?? null;
  }
  if (parts.slot !== null) return null;
  if (parts.reverse) return decoded.kind === "b" ? decoded.ids[1] : null;
  return decoded.ids[0];
}

/** Render a token for writing into a note. */
export function formatAnchorToken(role: AnchorRole, id: string): string {
    return `%%dk:${role}:${id}%%`;
}

/** Binding key for a header/body card token. */
export function headerBindingKey(id: string): string {
    return `h:${id}`;
}

/** Binding key for the k-th cloze within a `c:`-tokened line. */
export function clozeBindingKey(id: string, indexInLine: number): string {
    return `c:${id}#${indexInLine}`;
}

/** Binding key for the reverse sibling of any bound card. */
export function reverseBindingKey(baseKey: string): string {
    return `${baseKey}:rev`;
}

/** Binding key for a title-mode card identified by frontmatter `decks-id`. */
export function titleBindingKey(id: string): string {
    return `p:${id}`;
}

/** Binding key for the k-th cloze of a title-mode note. */
export function titleClozeBindingKey(id: string, index: number): string {
    return `p:${id}#${index}`;
}

/** Binding key for a table row (plain), or the k-th cloze in its cloze cell. */
export function tableBindingKey(id: string, clozeOrder?: number): string {
    return clozeOrder === undefined ? `t:${id}` : `t:${id}#${clozeOrder}`;
}

/** Binding key for an occlusion-v1 numbered list item (one card per item). */
export function occlusionBindingKey(id: string): string {
    return `o:${id}`;
}

/** Binding key for a multiple-choice question card token. */
export function questionBindingKey(id: string): string {
    return `q:${id}`;
}

/** Binding key for a canvas edge card (native edge id; no token needed). */
export function edgeBindingKey(edgeId: string, clozeOrder?: number): string {
    return clozeOrder === undefined ? `e:${edgeId}` : `e:${edgeId}#${clozeOrder}`;
}

/** Binding key for a single-card standalone canvas node. */
export function nodeBindingKey(nodeId: string): string {
    return `n:${nodeId}`;
}
