/**
 * Hash utility functions for generating deterministic IDs
 */

/**
 * Generate a simple hash from a string
 * Uses a basic hash algorithm for deterministic ID generation
 */
function simpleHash(text: string): number {
    if (!text) {
        return 0;
    }
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

/**
 * Generate unique flashcard ID from the card's front text.
 *
 * The ID is deck-independent so a card keeps its identity (and its review
 * history) when it moves between files/decks or its deck file is renamed.
 * Canvas cards pass an additional `sourceNodeId` so two text nodes inside the
 * same canvas with identical front text produce distinct IDs.
 */
export function generateFlashcardId(
    frontText: string,
    sourceNodeId?: string,
): string {
    const suffix = sourceNodeId ? "::node:" + sourceNodeId : "";
    return `card_${simpleHash(frontText + suffix).toString(36)}`;
}

/**
 * Generate a flashcard ID using only the front text (no node suffix).
 *
 * Identical to {@link generateFlashcardId} for markdown cards; retained for
 * re-linking review logs orphaned by the historical deck-scoped ID scheme.
 */
export function generateOldFlashcardId(frontText: string): string {
    return `card_${simpleHash(frontText).toString(36)}`;
}

/**
 * Reproduces the historical deck-scoped markdown ID (`hash(deckId + front)`).
 * Migration/recovery only: used to find review logs still keyed to the old
 * scheme so they can be re-pointed to the deck-independent ID.
 */
export function generateLegacyDeckScopedFlashcardId(
    frontText: string,
    deckId: string,
    sourceNodeId?: string,
): string {
    const suffix = sourceNodeId ? "::node:" + sourceNodeId : "";
    return `card_${simpleHash(deckId + "::" + frontText + suffix).toString(36)}`;
}

/**
 * Generate content hash for flashcard back content
 * @param backText The back text of the flashcard
 * @returns A hex string hash
 */
export function generateContentHash(backText: string): string {
    return simpleHash(backText).toString(16);
}

/**
 * Generate deck ID using hash of filepath
 * @param filepath The filepath of the deck
 * @returns A deterministic ID in format "deck_HASH"
 */
export function generateDeckId(filepath: string): string {
    return `deck_${simpleHash(filepath).toString(36)}`;
}

/**
 * Generate deck group ID using hash of tag
 * @param tag The tag of the deck group
 * @returns A deterministic ID in format "deckgroup_HASH"
 */
export function generateDeckGroupId(tag: string): string {
    return `deckgroup_${simpleHash(tag).toString(36)}`;
}

/**
 * Generate a reverse flashcard ID from the original card's front text.
 * The ID is based on the original front text (= reverse card's back) so it stays
 * stable when the original card's back content changes. Deck-independent.
 *
 * Canvas cards may pass `sourceNodeId` to disambiguate two text nodes with
 * identical content. Markdown cards omit it for byte-stable hashes.
 */
export function generateReverseFlashcardId(
    originalFrontText: string,
    sourceNodeId?: string,
): string {
    const suffix = sourceNodeId ? "::node:" + sourceNodeId : "";
    return `rcard_${simpleHash("reverse:" + originalFrontText + suffix).toString(36)}`;
}

/**
 * Generate custom deck ID using hash of name
 * @param name The name of the custom deck
 * @returns A deterministic ID in format "cdeck_HASH"
 */
export function generateCustomDeckId(name: string): string {
    return `cdeck_${simpleHash(name).toString(36)}`;
}

/**
 * Generate custom deck card membership ID using hash of custom deck ID and flashcard ID
 * @param customDeckId The ID of the custom deck
 * @param flashcardId The ID of the flashcard
 * @returns A deterministic ID in format "cdc_HASH"
 */
export function generateCustomDeckCardId(
    customDeckId: string,
    flashcardId: string,
): string {
    return `cdc_${simpleHash(customDeckId + "::" + flashcardId).toString(36)}`;
}

/**
 * Generate a cloze flashcard ID from front text, cloze order, and cloze text.
 * Deck-independent; cloze order/text keep sibling clozes on one front distinct.
 *
 * Canvas cards may pass `sourceNodeId` to disambiguate two text nodes with
 * identical content. Markdown cards omit it for byte-stable hashes.
 */
export function generateClozeFlashcardId(
    frontText: string,
    clozeText: string,
    clozeOrder: number,
    sourceNodeId?: string,
): string {
    const suffix = sourceNodeId ? "::node:" + sourceNodeId : "";
    return `ccard_${simpleHash("cloze:" + frontText + "::" + clozeOrder + "::" + clozeText + suffix).toString(36)}`;
}

/**
 * Generate ID for a V2 occlusion card. Keyed on the card's heading, the image
 * file name, and the stable mask id — not the full image path, which Obsidian
 * auto-manages and is therefore fragile. Mask ids are only unique within one
 * block, so the heading + image name distinguish blocks; the image name lets
 * several occlusion images share a heading. Deck-independent; moving/resizing a
 * box, editing its answer, or relocating the image's folder all preserve the
 * card's FSRS history (only renaming the image file changes the id).
 */
export function generateOcclusionV2FlashcardId(
    heading: string,
    imageName: string,
    maskId: string,
): string {
    return `ocard_${simpleHash("occ2:" + heading + "::" + imageName + "::" + maskId).toString(36)}`;
}

/**
 * Generate ID for a spatial canvas card derived from a single canvas edge.
 * Keyed on the front (source-node text) with the edge id as a within-canvas
 * tiebreaker; deck-independent. `edgeId` is only unique within one canvas, so
 * the front is what keeps edge ids reused across canvases from colliding.
 */
export function generateSpatialFlashcardId(
    frontText: string,
    edgeId: string,
): string {
    return `scard_${simpleHash(frontText + "::edge:" + edgeId).toString(36)}`;
}

/**
 * Generate ID for a spatial canvas card whose back contains a cloze deletion.
 * One card per cloze, distinguished by clozeOrder + clozeText. Keyed on the
 * front with the edge id as a within-canvas tiebreaker; deck-independent.
 */
export function generateSpatialClozeFlashcardId(
    frontText: string,
    edgeId: string,
    clozeText: string,
    clozeOrder: number,
): string {
    return `sccard_${simpleHash("spatial-cloze:" + frontText + "::edge:" + edgeId + "::" + clozeOrder + "::" + clozeText).toString(36)}`;
}
