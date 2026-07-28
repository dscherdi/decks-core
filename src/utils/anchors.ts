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
