import type { Flashcard } from "../database/types";
import type {
  IDatabaseService,
  ILogger,
} from "../database/DatabaseService.interface";
import type { NoteAccess } from "./NoteAccess";
import { FlashcardParser } from "./FlashcardParser";
import { classifyExamBody } from "./ExamClassifier";
import {
  cardIdForKey,
  edgeBindingKey,
  encodeAnchorValue,
  extractAnchorTokens,
  extractLineAnchors,
  formatAnchorToken,
  isIdKey,
  isIdValue,
  nodeBindingKey,
  stripAnchorTokens,
  type AnchorRole,
  type AnchorValueKind,
} from "../utils/anchors";
import {
  generateClozeFlashcardId,
  generateFlashcardId,
  generateReverseFlashcardId,
} from "../utils/hash";
import { scanClozeDeletions } from "../utils/cloze-scanner";
import { splitTableLine, unescapeTableCell } from "../utils/markdown-table";
import { parseHeaderLevels } from "../database/types";
import { findFlashcardSegment } from "../utils/source-navigator";
import { wantsReverseCards } from "../utils/frontmatter";
import { isDirectoryDeckPath } from "./directory/ids";

export type StampOutcome =
  | { ok: true; anchorKey: string; adopted: boolean }
  | {
      ok: false;
      reason:
        | "not_stampable"
        | "already_anchored"
        | "file_missing"
        | "stale"
        | "ambiguous_front"
        | "segment_not_found"
        | "binding_conflict"
        | "write_failed";
    };

interface BindingRow {
  anchor: string;
  flashcardId: string;
}

/** The token a host should carry, and the key each of its cards resolves through. */
interface HostToken {
  role: AnchorRole;
  value: string;
  cards: BindingRow[];
  cardKey: string;
}

interface StampResult {
  content: string;
  outcome: StampOutcome;
  host?: HostToken;
}

/** Resolves a card's id from its key under the host's current token, or its content id. */
type Resolver = (key: string | null, contentId: string) => string;

/** A host whose token names another id for the reviewed card, not yet synced here. */
const STALE = Symbol("stale");

const HEADER_LINE_REGEX = /^(#{1,6})\s+(.*)$/;
const TABLE_ROW_REGEX = /^\|.*\|$/;
const CLOZE_SOURCE = "==((?:(?!==).)+)==";

/** The frontmatter block's lines, without its fences; empty when there is none. */
function frontmatterLines(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end === -1 ? [] : lines.slice(1, end);
}

/** The note's `decks-id`, read the way the parser reads it. */
function frontmatterDecksId(lines: string[]): string | null {
  for (const line of frontmatterLines(lines)) {
    const match = /^decks-id:\s*("?)([A-Za-z0-9_-]+)\1\s*$/.exec(line);
    if (match) return match[2];
  }
  return null;
}

/** Tokens of one role on a line, with the whitespace before each. */
function roleTokenPattern(role: AnchorRole): RegExp {
  return new RegExp(`[ \\t]*%%dk:${role}:[a-z0-9]+%%`, "g");
}

/**
 * Writes the ids a card's host resolves to into its note at review time, as one
 * token per host. Every failure is silent and non-blocking — the next review retries.
 */
export class AnchorStamper {
  constructor(
    private notes: NoteAccess,
    private db: IDatabaseService,
    private logger?: ILogger
  ) {}

  async ensureAnchored(card: Flashcard): Promise<StampOutcome> {
    try {
      const outcome = await this.stamp(card);
      if (!outcome.ok && outcome.reason !== "already_anchored") {
        this.logger?.debug(
          `Anchor stamp skipped for ${card.id}: ${outcome.reason}`
        );
      }
      return outcome;
    } catch (error) {
      this.logger?.debug(`Anchor stamp failed for ${card.id}`, error);
      return { ok: false, reason: "write_failed" };
    }
  }

  private async stamp(card: Flashcard): Promise<StampOutcome> {
    // Packaged cards have no note to write into; their ids are already fixed.
    if (isDirectoryDeckPath(card.sourceFile)) return { ok: false, reason: "not_stampable" };
    if (card.edgeId) {
      const key = edgeBindingKey(
        card.edgeId,
        card.type === "cloze" ? card.clozeOrder ?? 0 : undefined
      );
      return this.bindExistingKey(card, key);
    }

    if (card.sourceNodeId) {
      if (card.type === "cloze") return { ok: false, reason: "not_stampable" };
      const count = await this.db.countNodeCards(
        card.deckId,
        card.sourceNodeId
      );
      if (count !== 1) return { ok: false, reason: "not_stampable" };
      return this.bindExistingKey(card, nodeBindingKey(card.sourceNodeId));
    }

    if (card.type === "image-occlusion-v2") {
      return { ok: false, reason: "not_stampable" };
    }

    // The note already carries this card's id: nothing to write.
    if (card.anchor && cardIdForKey(card.anchor) === card.id) {
      return { ok: false, reason: "already_anchored" };
    }

    const deck = await this.db.getDeckWithProfile(card.deckId);
    if (!deck) return { ok: false, reason: "not_stampable" };
    const titleMode = parseHeaderLevels(deck.profile).includes(0);
    const stamped = await this.stampFileBatch(card.sourceFile, [card], titleMode);
    return stamped.outcomes[0] ?? { ok: false, reason: "write_failed" };
  }

  /** Canvas cards: their key comes from the canvas itself, so only the binding is kept. */
  private async bindExistingKey(
    card: Flashcard,
    key: string
  ): Promise<StampOutcome> {
    const bound = await this.db.getAnchorBinding(key);
    if (bound === card.id) {
      if (card.anchor !== key) {
        await this.db.setFlashcardAnchor(card.id, key);
        card.anchor = key;
      }
      return { ok: false, reason: "already_anchored" };
    }
    if (bound !== null) return { ok: false, reason: "binding_conflict" };
    await this.db.insertAnchorBindings([{ anchor: key, flashcardId: card.id }]);
    await this.db.setFlashcardAnchor(card.id, key);
    card.anchor = key;
    return { ok: true, anchorKey: key, adopted: true };
  }

  /**
   * Stamp several cards of one note in a single write. Cards must share
   * `sourceFile`; each one's outcome is returned in order.
   */
  async stampFileBatch(
    path: string,
    cards: Flashcard[],
    titleMode = false
  ): Promise<{ stamped: number; skipped: number; outcomes: StampOutcome[] }> {
    if (isDirectoryDeckPath(path)) {
      const fixed: StampOutcome = { ok: false, reason: "not_stampable" };
      return { stamped: 0, skipped: cards.length, outcomes: cards.map(() => fixed) };
    }
    const content = await this.notes.read(path);
    if (content === null) {
      const missing: StampOutcome = { ok: false, reason: "file_missing" };
      return { stamped: 0, skipped: cards.length, outcomes: cards.map(() => missing) };
    }

    const run = (
      initial: string,
      resolve: Resolver
    ): { content: string; results: StampResult[] } => {
      let current = initial;
      const results = cards.map((card) => {
        const result = this.applyStamp(current, card, titleMode, resolve);
        if (result.outcome.ok) current = result.content;
        return result;
      });
      return { content: current, results };
    };

    // Minted tokens resolve through bindings: a dry run names the keys to fetch.
    const bindings = new Map<string, string | null>();
    let requested = new Set<string>();
    let pass = run(content, this.resolver(bindings, requested));
    if (requested.size > 0) {
      for (const key of requested) bindings.set(key, await this.db.getAnchorBinding(key));
      requested = new Set();
      pass = run(content, this.resolver(bindings, requested));
    }

    if (pass.content !== content) {
      const deckId = cards[0].deckId;
      const { preMtime, lastSynced } = await this.readMtimeState(path, deckId);
      await this.notes.process(path, (current) => {
        const missed = new Set<string>();
        pass = run(current, this.resolver(bindings, missed));
        if (missed.size > 0) {
          // The note changed under us in a way the fetched bindings don't cover.
          const stale: StampOutcome = { ok: false, reason: "stale" };
          pass = { content: current, results: cards.map(() => ({ content: current, outcome: stale })) };
        }
        return pass.content;
      });
      await this.suppressMtimeIfClean(path, deckId, preMtime, lastSynced);
    }

    const recorded = new Set<string>();
    let stamped = 0;
    const outcomes: StampOutcome[] = [];
    for (let i = 0; i < cards.length; i++) {
      const { outcome, host } = pass.results[i];
      outcomes.push(outcome);
      if (!outcome.ok || !host) continue;
      stamped++;
      cards[i].anchor = outcome.anchorKey;
      if (recorded.has(host.value)) continue;
      recorded.add(host.value);
      await this.recordHost(host);
    }
    return { stamped, skipped: cards.length - stamped, outcomes };
  }

  /** Mirrors the synchronizer: a carried id, else the binding of a minted key, else content. */
  private resolver(
    bindings: Map<string, string | null>,
    requested: Set<string>
  ): Resolver {
    return (key, contentId) => {
      if (key === null) return contentId;
      if (isIdKey(key)) return cardIdForKey(key) ?? contentId;
      if (!bindings.has(key)) {
        requested.add(key);
        return contentId;
      }
      return bindings.get(key) ?? contentId;
    };
  }

  /** Keys onto the rows now, and compatibility bindings for versions that still read them. */
  private async recordHost(host: HostToken): Promise<void> {
    await this.db.insertAnchorBindings(host.cards);
    for (const row of host.cards) {
      if (await this.db.getFlashcardById(row.flashcardId)) {
        await this.db.setFlashcardAnchor(row.flashcardId, row.anchor);
      }
    }
  }

  private applyStamp(
    content: string,
    card: Flashcard,
    titleMode: boolean,
    resolve: Resolver
  ): StampResult {
    const unchanged = (reason: StampOutcome & { ok: false }): StampResult => ({
      content,
      outcome: reason,
    });
    const isReverse = card.id.startsWith("rcard_");
    const hostFront = isReverse ? card.back : card.front;
    const hostBack = isReverse ? card.front : card.back;
    const lines = content.split("\n");
    const reverses = wantsReverseCards(content);

    if (titleMode) return this.applyTitleStamp(content, card, hostBack, reverses, resolve);
    if (card.type === "image-occlusion") return this.applyOcclusionStamp(content, card);
    if (this.isTableCard(card)) {
      if (this.countTableRowMatches(lines, hostFront) > 1) {
        return unchanged({ ok: false, reason: "ambiguous_front" });
      }
      return this.applyTableStamp(content, card, hostFront, hostBack, reverses, resolve);
    }
    if (this.countHeaderMatches(lines, hostFront) > 1) {
      return unchanged({ ok: false, reason: "ambiguous_front" });
    }

    const segment = findFlashcardSegment(lines, {
      type: card.type === "cloze" ? "cloze" : "header-paragraph",
      front: hostFront,
      breadcrumb: card.breadcrumb,
      clozeOrder: card.clozeOrder ?? null,
    });
    if (!segment) return unchanged({ ok: false, reason: "segment_not_found" });

    // A cloze whose segment resolves to a table row belongs to the table path;
    // templateRow may be missing on older rows.
    if (
      segment.end - segment.start === 1 &&
      TABLE_ROW_REGEX.test(lines[segment.start].trim())
    ) {
      return this.applyTableStamp(content, card, hostFront, hostBack, reverses, resolve);
    }

    // The parser skips blank lines before a body, so line k of its body is here.
    let bodyStart = segment.start + 1;
    while (bodyStart < segment.end && lines[bodyStart].trim() === "") bodyStart++;

    // An exercise's stored back keeps its comments, so it is compared unextracted.
    if (card.type === "multiple-choice" && classifyExamBody(hostBack).kind === "exercise") {
      const end = this.exerciseBodyEnd(lines, bodyStart, segment.end, hostBack);
      if (end === -1) return unchanged({ ok: false, reason: "stale" });
      return this.applyQuestionStamp(content, lines, bodyStart, end, card);
    }

    const bodyLines = lines.slice(bodyStart, segment.end);
    const { lines: stripped, anchors } = extractLineAnchors(bodyLines);
    const { back: cleanBack } = FlashcardParser.extractHeaderParagraphNotes(
      stripped.join("\n").trim()
    );
    if (cleanBack.trim() !== hostBack.trim()) {
      return unchanged({ ok: false, reason: "stale" });
    }

    if (card.type === "cloze") {
      const deletions = scanClozeDeletions(cleanBack);
      const target = deletions.find((d) => d.order === (card.clozeOrder ?? 0));
      if (!target) return unchanged({ ok: false, reason: "stale" });
      if (
        !FlashcardParser.clozeLineSurvives(stripped, cleanBack.split("\n"), target.lineIndex)
      ) {
        return unchanged({ ok: false, reason: "not_stampable" });
      }
      // The parser reads the last c token on a line.
      const existing = anchors
        .filter((a) => a.role === "c" && a.lineIndex === target.lineIndex)
        .pop()?.id;
      const onLine = deletions.filter((d) => d.lineIndex === target.lineIndex);
      const host = this.packedHost(
        "c",
        onLine.map((d) => ({
          contentId: generateClozeFlashcardId(hostFront, d.text, d.order),
          suffix: `#${d.indexInLine}`,
        })),
        target.indexInLine,
        card,
        this.trustedValue(content, "c", existing, `#${target.indexInLine}`, card),
        resolve
      );
      if (!("value" in host)) return unchanged(host);
      const lineIndex = bodyStart + target.lineIndex;
      lines[lineIndex] = this.writeLineToken(lines[lineIndex], "c", host.value);
      return this.done(content, lines, host);
    }

    if (card.type === "multiple-choice") {
      return this.applyQuestionStamp(content, lines, bodyStart, segment.end, card);
    }

    const existing = anchors.find((a) => a.role === "h")?.id;
    const host = this.pairHost(
      "h",
      card,
      hostFront,
      reverses && hostBack.trim() !== "",
      this.trustedValue(content, "h", existing, isReverse ? ":rev" : "", card),
      resolve
    );
    if (!("value" in host)) return unchanged(host);
    const placed = this.replaceFirstBodyToken(lines, bodyStart, segment.end, "h", host.value);
    if (!placed) {
      const last = this.lastNonBlank(lines, bodyStart, segment.end);
      if (last === -1) return unchanged({ ok: false, reason: "segment_not_found" });
      lines.splice(last + 1, 0, formatAnchorToken("h", host.value));
    }
    return this.done(content, lines, host);
  }

  /** Questions and exercises: the body's first q token carries the card's id. */
  private applyQuestionStamp(
    content: string,
    lines: string[],
    bodyStart: number,
    bodyEnd: number,
    card: Flashcard
  ): StampResult {
    const unchanged = (reason: StampOutcome & { ok: false }): StampResult => ({
      content,
      outcome: reason,
    });
    const { anchors } = extractLineAnchors(lines.slice(bodyStart, bodyEnd));
    const existing = anchors.find((a) => a.role === "q")?.id;
    const trusted = this.trustedValue(content, "q", existing, "", card);
    if (trusted === STALE) return unchanged({ ok: false, reason: "stale" });
    const host = this.singleHost("q", "a", card.id);
    if (!host) return unchanged({ ok: false, reason: "not_stampable" });
    if (!this.replaceFirstBodyToken(lines, bodyStart, bodyEnd, "q", host.value)) {
      const last = this.lastNonBlank(lines, bodyStart, bodyEnd);
      if (last === -1) return unchanged({ ok: false, reason: "segment_not_found" });
      // Own paragraph: a line directly after a list item would continue that item.
      lines.splice(last + 1, 0, "", formatAnchorToken("q", host.value));
    }
    return this.done(content, lines, host);
  }

  /**
   * Where an exercise's body ends: the segment's end or an earlier heading, whichever
   * reads back as its stored back (its sub-headings stay inside); -1 when none does.
   */
  private exerciseBodyEnd(lines: string[], bodyStart: number, segmentEnd: number, back: string): number {
    const target = back.trim();
    for (let end = bodyStart; end <= segmentEnd; end++) {
      if (end < segmentEnd && !HEADER_LINE_REGEX.test(lines[end])) continue;
      const { lines: stripped } = extractLineAnchors(lines.slice(bodyStart, end));
      if (stripped.join("\n").trim() === target) return end;
    }
    return -1;
  }

  /** Title mode: the note is the card, so its token sits in the body. */
  private applyTitleStamp(
    content: string,
    card: Flashcard,
    hostBack: string,
    reverses: boolean,
    resolve: Resolver
  ): StampResult {
    const unchanged = (reason: StampOutcome & { ok: false }): StampResult => ({
      content,
      outcome: reason,
    });
    const view = FlashcardParser.titleBodyView(content);
    if (view.back.trim() !== hostBack.trim()) {
      return unchanged({ ok: false, reason: "stale" });
    }
    const lines = content.split("\n");
    const bodyFirst = view.bodyStart + view.leading;
    const isReverse = card.id.startsWith("rcard_");
    const hostFront = isReverse ? card.back : card.front;
    const decksId = frontmatterDecksId(lines);

    if (card.type === "cloze") {
      const deletions = scanClozeDeletions(view.back);
      const target = deletions.find((d) => d.order === (card.clozeOrder ?? 0));
      if (!target) return unchanged({ ok: false, reason: "stale" });
      const lineIndex = bodyFirst + target.lineIndex;
      const backLine = view.back.split("\n")[target.lineIndex];
      if (stripAnchorTokens(lines[lineIndex] ?? "") !== backLine) {
        return unchanged({ ok: false, reason: "not_stampable" });
      }
      const lineValue = view.clozeLineTokens.get(target.lineIndex);
      const onLine = deletions.filter((d) => d.lineIndex === target.lineIndex);
      const trusted = this.trustedValue(content, "c", lineValue, `#${target.indexInLine}`, card);
      if (trusted === STALE) return unchanged({ ok: false, reason: "stale" });
      // Without a line token the line's cards resolve through `decks-id`.
      const keyFor = (d: { order: number; indexInLine: number }): string | null =>
        trusted !== null
          ? `${trusted.base}#${d.indexInLine}`
          : lineValue === undefined && decksId
          ? `p:${decksId}#${d.order}`
          : null;
      const ids = onLine.map((d) =>
        d.indexInLine === target.indexInLine
          ? card.id
          : resolve(keyFor(d), generateClozeFlashcardId(hostFront, d.text, d.order))
      );
      const host = this.encodePacked("c", ids, onLine.map((d) => `#${d.indexInLine}`), target.indexInLine);
      if (!host) return unchanged({ ok: false, reason: "not_stampable" });
      lines[lineIndex] = this.writeLineToken(lines[lineIndex], "c", host.value);
      return this.done(content, lines, host);
    }

    const headerValue = view.headerTokenId;
    const trusted = this.trustedValue(content, "h", headerValue, isReverse ? ":rev" : "", card);
    // Without a body token the note's cards resolve through `decks-id`.
    const existing =
      trusted === null && headerValue === undefined && decksId
        ? { base: `p:${decksId}` }
        : trusted;
    const host = this.pairHost(
      "h",
      card,
      hostFront,
      reverses && hostBack.trim() !== "",
      existing,
      resolve
    );
    if (!("value" in host)) return unchanged(host);
    if (!this.replaceFirstBodyToken(lines, view.bodyStart, lines.length, "h", host.value)) {
      const last = this.lastNonBlank(lines, view.bodyStart, lines.length);
      if (last === -1) return unchanged({ ok: false, reason: "segment_not_found" });
      lines.splice(last + 1, 0, formatAnchorToken("h", host.value));
    }
    return this.done(content, lines, host);
  }

  /** Table rows: the token sits in the first data cell, unless one is already in the row. */
  private applyTableStamp(
    content: string,
    card: Flashcard,
    hostFront: string,
    hostBack: string,
    reverses: boolean,
    resolve: Resolver
  ): StampResult {
    const unchanged = (reason: StampOutcome & { ok: false }): StampResult => ({
      content,
      outcome: reason,
    });
    const lines = content.split("\n");
    const segment = findFlashcardSegment(lines, {
      type: card.type === "cloze" ? "cloze" : "table",
      front: hostFront,
      breadcrumb: card.breadcrumb,
      clozeOrder: card.clozeOrder ?? null,
    });
    if (!segment) return unchanged({ ok: false, reason: "segment_not_found" });

    const rawLine = lines[segment.start];
    const leading = /^\s*/.exec(rawLine)?.[0] ?? "";
    const trimmedRow = rawLine.trim();
    if (!TABLE_ROW_REGEX.test(trimmedRow)) {
      return unchanged({ ok: false, reason: "segment_not_found" });
    }

    // Raw segments (outer empties included) so every untouched cell survives
    // byte-for-byte; cleaned cells mirror the parser for comparisons.
    const rawCells = splitTableLine(trimmedRow);
    const dataCells = rawCells
      .slice(1, -1)
      .map((c) => unescapeTableCell(stripAnchorTokens(c).trim()));
    if (card.templateRow) {
      if (JSON.stringify(dataCells) !== JSON.stringify(card.templateRow.cells)) {
        return unchanged({ ok: false, reason: "stale" });
      }
    } else if (
      dataCells[0] !== hostFront ||
      (card.type !== "cloze" && (dataCells[1] ?? "") !== hostBack)
    ) {
      return unchanged({ ok: false, reason: "stale" });
    }

    // The parser reads the row's first t token.
    const existing = rawCells
      .flatMap((c) => extractAnchorTokens(c).tokens)
      .find((t) => t.role === "t")?.id;
    let host: HostToken | { ok: false; reason: "stale" | "not_stampable" };
    if (card.type === "cloze") {
      // Mirrors the parser's cell choice: a cloze in the front cell wins.
      const frontIsCloze = new RegExp(CLOZE_SOURCE).test(dataCells[0]);
      const source = frontIsCloze ? dataCells[0] : dataCells[1] ?? "";
      const deletions = scanClozeDeletions(source);
      const slot = card.clozeOrder ?? 0;
      if (slot >= deletions.length) return unchanged({ ok: false, reason: "stale" });
      host = this.packedHost(
        "t",
        deletions.map((d) => ({
          contentId: generateClozeFlashcardId(hostFront, d.text, d.order),
          suffix: `#${d.order}`,
        })),
        slot,
        card,
        this.trustedValue(content, "t", existing, `#${slot}`, card),
        resolve
      );
    } else {
      host = this.pairHost(
        "t",
        card,
        hostFront,
        reverses && hostBack.trim() !== "",
        this.trustedValue(content, "t", existing, card.id.startsWith("rcard_") ? ":rev" : "", card),
        resolve
      );
    }
    if (!("value" in host)) return unchanged(host);

    const next = [...rawCells];
    const holder = next.findIndex((c) =>
      extractAnchorTokens(c).tokens.some((t) => t.role === "t")
    );
    if (holder >= 0) {
      next[holder] = next[holder].replace(
        /%%dk:t:[a-z0-9]+%%/,
        formatAnchorToken("t", host.value)
      );
    } else {
      next[1] =
        next[1].replace(/\s*$/, "") + " " + formatAnchorToken("t", host.value) + " ";
    }
    lines[segment.start] = leading + next.join("|");
    return this.done(content, lines, host);
  }

  /** Occlusion v1 items: the token goes at the end of the numbered list line. */
  private applyOcclusionStamp(content: string, card: Flashcard): StampResult {
    const unchanged = (reason: StampOutcome & { ok: false }): StampResult => ({
      content,
      outcome: reason,
    });
    const lines = content.split("\n");
    const segment = findFlashcardSegment(lines, {
      type: "image-occlusion",
      front: card.front,
      breadcrumb: card.breadcrumb,
      clozeOrder: card.clozeOrder ?? null,
    });
    if (!segment) return unchanged({ ok: false, reason: "segment_not_found" });

    const rawLine = lines[segment.start];
    const itemMatch = /^\d+\.\s+(.+)$/.exec(stripAnchorTokens(rawLine).trim());
    if (!itemMatch) return unchanged({ ok: false, reason: "stale" });
    const currentCloze = itemMatch[1]
      .trim()
      .replace(/==((?:(?!==).)+)==/g, "$1");
    if (currentCloze !== (card.clozeText ?? "")) {
      return unchanged({ ok: false, reason: "stale" });
    }
    const existing = extractAnchorTokens(rawLine).tokens.filter((t) => t.role === "o").pop()?.id;
    if (this.trustedValue(content, "o", existing, "", card) === STALE) {
      return unchanged({ ok: false, reason: "stale" });
    }
    const host = this.singleHost("o", "c", card.id);
    if (!host) return unchanged({ ok: false, reason: "not_stampable" });
    lines[segment.start] = this.writeLineToken(rawLine, "o", host.value);
    return this.done(content, lines, host);
  }

  private done(content: string, lines: string[], host: HostToken): StampResult {
    const next = lines.join("\n");
    return {
      content: next,
      outcome: { ok: true, anchorKey: host.cardKey, adopted: next === content },
      host,
    };
  }

  /**
   * Whether a host's token speaks for its cards: one naming another id for this card is a
   * copy (its value recurs in the note; null, so content ids) or not synced here yet (STALE).
   */
  private trustedValue(
    content: string,
    role: AnchorRole,
    value: string | undefined,
    cardSuffix: string,
    card: Flashcard
  ): { base: string } | null | typeof STALE {
    if (value === undefined) return null;
    const carried = cardIdForKey(`${role}:${value}${cardSuffix}`);
    if (!isIdValue(value) || carried === null || carried === card.id) {
      return { base: `${role}:${value}` };
    }
    const token = formatAnchorToken(role, value);
    return content.split(token).length > 2 ? null : STALE;
  }

  /** A host with exactly one card. */
  private singleHost(
    role: AnchorRole,
    kind: AnchorValueKind,
    id: string
  ): HostToken | null {
    const value = encodeAnchorValue(kind, [id]);
    if (value === null) return null;
    const key = `${role}:${value}`;
    return { role, value, cards: [{ anchor: key, flashcardId: id }], cardKey: key };
  }

  /** A host with a card and, when the note makes reverses, its reverse. */
  private pairHost(
    role: AnchorRole,
    card: Flashcard,
    hostFront: string,
    reverses: boolean,
    existing: { base: string } | null | typeof STALE,
    resolve: Resolver
  ): HostToken | { ok: false; reason: "stale" | "not_stampable" } {
    if (existing === STALE) return { ok: false, reason: "stale" };
    const isReverse = card.id.startsWith("rcard_");
    const base = existing?.base ?? null;
    const forwardId = isReverse
      ? resolve(base, generateFlashcardId(hostFront))
      : card.id;
    const reverseId = isReverse
      ? card.id
      : reverses
      ? resolve(base === null ? null : `${base}:rev`, generateReverseFlashcardId(hostFront))
      : null;
    const value =
      reverseId === null
        ? encodeAnchorValue("a", [forwardId])
        : encodeAnchorValue("b", [forwardId, reverseId]);
    if (value === null) return { ok: false, reason: "not_stampable" };
    const key = `${role}:${value}`;
    const cards: BindingRow[] = [{ anchor: key, flashcardId: forwardId }];
    if (reverseId !== null) cards.push({ anchor: `${key}:rev`, flashcardId: reverseId });
    return { role, value, cards, cardKey: isReverse ? `${key}:rev` : key };
  }

  /** A host with one cloze card per deletion; the reviewed card keeps its own id. */
  private packedHost(
    role: AnchorRole,
    slots: Array<{ contentId: string; suffix: string }>,
    cardSlot: number,
    card: Flashcard,
    existing: { base: string } | null | typeof STALE,
    resolve: Resolver
  ): HostToken | { ok: false; reason: "stale" | "not_stampable" } {
    if (existing === STALE) return { ok: false, reason: "stale" };
    const ids = slots.map((slot, k) =>
      k === cardSlot
        ? card.id
        : resolve(existing === null ? null : `${existing.base}${slot.suffix}`, slot.contentId)
    );
    const host = this.encodePacked(role, ids, slots.map((s) => s.suffix), cardSlot);
    return host ?? { ok: false, reason: "not_stampable" };
  }

  private encodePacked(
    role: AnchorRole,
    ids: string[],
    suffixes: string[],
    cardSlot: number
  ): HostToken | null {
    const value = encodeAnchorValue("p", ids);
    if (value === null) return null;
    const cards = ids.map((id, k) => ({
      anchor: `${role}:${value}${suffixes[k]}`,
      flashcardId: id,
    }));
    return { role, value, cards, cardKey: cards[cardSlot].anchor };
  }

  /** Replace every token of `role` on a line with one carrying `value`, at the end. */
  private writeLineToken(line: string, role: AnchorRole, value: string): string {
    const bare = line.replace(roleTokenPattern(role), "");
    return bare.replace(/\s*$/, "") + " " + formatAnchorToken(role, value);
  }

  /** Swap the first `role` token in lines [from, to) in place; false when there is none. */
  private replaceFirstBodyToken(
    lines: string[],
    from: number,
    to: number,
    role: AnchorRole,
    value: string
  ): boolean {
    const pattern = new RegExp(`%%dk:${role}:[a-z0-9]+%%`);
    for (let i = from; i < to; i++) {
      if (pattern.test(lines[i])) {
        lines[i] = lines[i].replace(pattern, formatAnchorToken(role, value));
        return true;
      }
    }
    return false;
  }

  private lastNonBlank(lines: string[], from: number, to: number): number {
    for (let i = to - 1; i >= from; i--) {
      if (lines[i].trim() !== "") return i;
    }
    return -1;
  }

  private isTableCard(card: Flashcard): boolean {
    return card.type === "table" || card.templateRow != null;
  }

  /** Whole-file count of table rows whose cleaned first cell equals `front`. */
  private countTableRowMatches(lines: string[], front: string): number {
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!TABLE_ROW_REGEX.test(trimmed)) continue;
      const cells = splitTableLine(trimmed.slice(1, -1));
      if (cells.length === 0) continue;
      const first = unescapeTableCell(stripAnchorTokens(cells[0]).trim());
      if (first === front) count++;
    }
    return count;
  }

  private countHeaderMatches(lines: string[], front: string): number {
    let count = 0;
    for (const line of lines) {
      const match = HEADER_LINE_REGEX.exec(line);
      if (!match) continue;
      const { cleaned } = FlashcardParser.extractAndStripTags(
        stripAnchorTokens(match[2])
      );
      if (cleaned === front) count++;
    }
    return count;
  }

  private async readMtimeState(
    path: string,
    deckId: string
  ): Promise<{ preMtime: number; lastSynced: number }> {
    return {
      preMtime: await this.notes.mtime(path),
      lastSynced: await this.db.getDeckLastSyncedMtime(deckId),
    };
  }

  /**
   * Suppress the resync a token-only write would trigger — but only when the
   * deck was clean, so a pending user edit is never swallowed.
   */
  private async suppressMtimeIfClean(
    path: string,
    deckId: string,
    preMtime: number,
    lastSynced: number
  ): Promise<void> {
    if (lastSynced !== preMtime) return;
    await this.db.setDeckLastSyncedMtime(deckId, await this.notes.mtime(path));
  }
}
