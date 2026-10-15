import type { IDatabaseService } from "../database/DatabaseService.interface";
import type { SqlJsValue } from "../database/sql-types";
import { CARD_CHILD_STATEMENTS } from "../database/card-children";
import {
  generateFlashcardId,
  generateLegacyDeckScopedFlashcardId,
  generateOldFlashcardId,
} from "../utils/hash";
import { wideContentId } from "../utils/content-identity";
import type { HistoryRelinkOp } from "./SyncLog.types";

/** Shortest back a content match may attach history to, unless the card is a table row. */
export const MIN_MATCH_BACK_CHARS = 24;
/** Links carried by one `history_relink` op. */
export const HISTORY_RELINK_OP_LINKS = 200;

const CHUNK = 400;
const DIRECTORY_DECK_PREFIX = "deck_dir_";
// Appended to every statement that moves rows, so a card recreated under `from` keeps them.
const LIVE_GUARD = " AND NOT EXISTS (SELECT 1 FROM flashcards WHERE id = ?)";

export interface HistoryLink {
  from: string;
  to: string;
}

export type HistoryLinkBasis = "legacy-id" | "content";

export type HistorySkipReason =
  | "ambiguous"
  | "short-content"
  | "interleaved"
  | "conflicting-hash"
  | "directory-target"
  | "orphaned-target";

export interface PlannedHistoryLink extends HistoryLink {
  basis: HistoryLinkBasis;
  logs: number;
}

export interface HistoryPlan {
  links: PlannedHistoryLink[];
  skipped: Array<{ from: string; reason: HistorySkipReason }>;
}

export interface HistoryRecoveryResult {
  /** Dead ids whose history moved onto a live card. */
  reattached: number;
  /** Cards whose scheduling was rebuilt from their reviews. */
  restored: number;
  links: HistoryLink[];
  plan: HistoryPlan;
}

export interface HistoryPlanOptions {
  contentMatch: boolean;
  /** Only plan links onto these cards. */
  targets?: readonly string[];
}

type HistoryDb = Pick<IDatabaseService, "querySql" | "executeSql">;

interface OrphanLogRow {
  flashcard_id: string;
  reviewed_at: string;
  content_hash: string | null;
}

interface Orphan {
  id: string;
  logs: number;
  first: number;
  last: number;
  newestHash: string | null;
  newestHashAt: number;
  hashes: Set<string>;
}

interface CandidateRow {
  id: string;
  deck_id: string;
  back: string;
  is_table: number;
  content_hash: string;
}

interface LegacyCardRow {
  id: string;
  front: string;
  deck_id: string;
  source_node_id: string | null;
}

interface LogStateRow {
  new_state: "new" | "review";
  new_interval_minutes: number;
  new_repetitions: number;
  new_difficulty: number;
  new_stability: number;
  new_lapses: number;
  reviewed_at: string;
}

interface Range {
  first: number;
  last: number;
}

/** Epoch ms for a stored timestamp; SQLite's `datetime('now')` form is UTC without a zone. */
function toMillis(value: string): number {
  const sqliteForm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  return Date.parse(sqliteForm ? `${value.replace(" ", "T")}Z` : value);
}

function usableHash(hash: string | null): hash is string {
  return hash !== null && hash !== "" && hash !== "0";
}

function prefixOf(id: string): string {
  return id.slice(0, id.indexOf("_") + 1);
}

function chunked<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function overlaps(a: Range, b: Range): boolean {
  return a.first <= b.last && b.first <= a.last;
}

async function liveDeckIds(db: HistoryDb): Promise<Set<string>> {
  const rows = await db.querySql<{ id: string }>("SELECT id FROM decks", [], { asObject: true });
  return new Set(rows.map((row) => row.id));
}

function summarise(rows: OrphanLogRow[]): Map<string, Orphan> {
  const orphans = new Map<string, Orphan>();
  for (const row of rows) {
    const at = toMillis(row.reviewed_at);
    const orphan = orphans.get(row.flashcard_id) ?? {
      id: row.flashcard_id,
      logs: 0,
      first: at,
      last: at,
      newestHash: null,
      newestHashAt: Number.NEGATIVE_INFINITY,
      hashes: new Set<string>(),
    };
    orphan.logs++;
    orphan.first = Math.min(orphan.first, at);
    orphan.last = Math.max(orphan.last, at);
    if (usableHash(row.content_hash)) {
      orphan.hashes.add(row.content_hash);
      if (at >= orphan.newestHashAt) {
        orphan.newestHash = row.content_hash;
        orphan.newestHashAt = at;
      }
    }
    orphans.set(row.flashcard_id, orphan);
  }
  return orphans;
}

async function loadOrphans(db: HistoryDb): Promise<Map<string, Orphan>> {
  const rows = await db.querySql<OrphanLogRow>(
    "SELECT flashcard_id, reviewed_at, content_hash FROM review_logs WHERE flashcard_id NOT IN (SELECT id FROM flashcards)",
    [],
    { asObject: true }
  );
  return summarise(rows);
}

async function loadCandidates(db: HistoryDb, hashes: readonly string[]): Promise<Map<string, CandidateRow[]>> {
  const byKey = new Map<string, CandidateRow[]>();
  for (const chunk of chunked(hashes)) {
    const rows = await db.querySql<CandidateRow>(
      `SELECT id, deck_id, back, template_row IS NOT NULL AS is_table, content_hash
       FROM flashcards WHERE content_hash IN (${marks(chunk.length)})`,
      chunk,
      { asObject: true }
    );
    for (const row of rows) {
      const key = `${prefixOf(row.id)}|${row.content_hash}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
  }
  return byKey;
}

async function ownRanges(db: HistoryDb, cardIds: readonly string[]): Promise<Map<string, Range>> {
  const ranges = new Map<string, Range>();
  for (const chunk of chunked(cardIds)) {
    const rows = await db.querySql<{ flashcard_id: string; reviewed_at: string }>(
      `SELECT flashcard_id, reviewed_at FROM review_logs WHERE flashcard_id IN (${marks(chunk.length)})`,
      chunk,
      { asObject: true }
    );
    for (const row of rows) {
      const at = toMillis(row.reviewed_at);
      const range = ranges.get(row.flashcard_id);
      if (range) {
        range.first = Math.min(range.first, at);
        range.last = Math.max(range.last, at);
      } else {
        ranges.set(row.flashcard_id, { first: at, last: at });
      }
    }
  }
  return ranges;
}

async function legacyLinks(
  db: HistoryDb,
  orphans: Map<string, Orphan>,
  targets: readonly string[] | undefined
): Promise<PlannedHistoryLink[]> {
  const rows: LegacyCardRow[] = [];
  if (targets) {
    for (const chunk of chunked(targets)) {
      rows.push(
        ...(await db.querySql<LegacyCardRow>(
          `SELECT id, front, deck_id, source_node_id FROM flashcards WHERE id IN (${marks(chunk.length)})`,
          chunk,
          { asObject: true }
        ))
      );
    }
  } else {
    rows.push(
      ...(await db.querySql<LegacyCardRow>(
        "SELECT id, front, deck_id, source_node_id FROM flashcards",
        [],
        { asObject: true }
      ))
    );
  }
  const links: PlannedHistoryLink[] = [];
  const claimed = new Set<string>();
  for (const card of rows) {
    if (!card.id.startsWith("card_")) continue;
    const nodeId = card.source_node_id ?? undefined;
    // On its wide id because another card held its content id, whose logs are that card's.
    const fellBack =
      card.id === wideContentId(generateFlashcardId(card.front, nodeId), { front: card.front, sourceNodeId: nodeId });
    const candidates = [
      generateLegacyDeckScopedFlashcardId(card.front, card.deck_id, nodeId),
      ...(fellBack ? [] : [generateOldFlashcardId(card.front)]),
    ];
    for (const oldId of candidates) {
      const orphan = orphans.get(oldId);
      if (oldId === card.id || !orphan || claimed.has(oldId)) continue;
      claimed.add(oldId);
      links.push({ from: oldId, to: card.id, basis: "legacy-id", logs: orphan.logs });
    }
  }
  return links;
}

/**
 * Pairs history stranded under dead ids with its live card: old id formulas first,
 * then, with `contentMatch`, the one card with the same content hash.
 */
export async function planHistoryLinks(db: HistoryDb, options: HistoryPlanOptions): Promise<HistoryPlan> {
  let targetHashes: Set<string> | null = null;
  if (options.targets) {
    targetHashes = new Set<string>();
    for (const chunk of chunked(options.targets)) {
      const rows = await db.querySql<{ content_hash: string }>(
        `SELECT content_hash FROM flashcards WHERE id IN (${marks(chunk.length)})`,
        chunk,
        { asObject: true }
      );
      for (const row of rows) if (usableHash(row.content_hash)) targetHashes.add(row.content_hash);
    }
  }

  const orphans = await loadOrphans(db);
  const links = await legacyLinks(db, orphans, options.targets);
  const skipped: HistoryPlan["skipped"] = [];
  if (!options.contentMatch) return { links, skipped };

  const claimed = new Set(links.map((link) => link.from));
  const pending = [...orphans.values()].filter(
    (orphan) =>
      !claimed.has(orphan.id) &&
      orphan.newestHash !== null &&
      (targetHashes === null || [...orphan.hashes].some((hash) => targetHashes?.has(hash)))
  );
  const hashes = [...new Set(pending.flatMap((orphan) => [...orphan.hashes]))];
  const candidates = await loadCandidates(db, hashes);
  const decks = await liveDeckIds(db);

  const accepted = new Map<string, Orphan[]>();
  const matched: Array<{ orphan: Orphan; target: CandidateRow }> = [];
  for (const orphan of pending) {
    const prefix = prefixOf(orphan.id);
    const found = candidates.get(`${prefix}|${orphan.newestHash}`) ?? [];
    if (found.length === 0) continue;
    if (found.length > 1) {
      skipped.push({ from: orphan.id, reason: "ambiguous" });
      continue;
    }
    const target = found[0];
    if (target.deck_id.startsWith(DIRECTORY_DECK_PREFIX)) {
      skipped.push({ from: orphan.id, reason: "directory-target" });
      continue;
    }
    if (!decks.has(target.deck_id)) {
      skipped.push({ from: orphan.id, reason: "orphaned-target" });
      continue;
    }
    const conflicting = [...orphan.hashes].some((hash) => {
      const other = candidates.get(`${prefix}|${hash}`);
      return other !== undefined && other.length === 1 && other[0].id !== target.id;
    });
    if (conflicting) {
      skipped.push({ from: orphan.id, reason: "conflicting-hash" });
      continue;
    }
    if (!target.is_table && target.back.trim().length < MIN_MATCH_BACK_CHARS) {
      skipped.push({ from: orphan.id, reason: "short-content" });
      continue;
    }
    matched.push({ orphan, target });
  }

  const ranges = await ownRanges(db, [...new Set(matched.map((m) => m.target.id))]);
  const targetSet = options.targets ? new Set(options.targets) : null;
  for (const { orphan, target } of matched) {
    const range: Range = { first: orphan.first, last: orphan.last };
    const own = ranges.get(target.id);
    const earlier = accepted.get(target.id) ?? [];
    if ((own && overlaps(own, range)) || earlier.some((other) => overlaps(other, range))) {
      skipped.push({ from: orphan.id, reason: "interleaved" });
      continue;
    }
    accepted.set(target.id, [...earlier, orphan]);
    if (targetSet && !targetSet.has(target.id)) continue;
    links.push({ from: orphan.id, to: target.id, basis: "content", logs: orphan.logs });
  }
  return { links, skipped };
}

/** Moves every row keyed by `from` onto `to`, unless `from` is a live card. Returns the reviews moved. */
export async function relinkCardHistory(db: HistoryDb, link: HistoryLink, now: string): Promise<number> {
  try {
    const live = await db.querySql<{ n: number }>("SELECT COUNT(*) AS n FROM flashcards WHERE id = ?", [link.from], {
      asObject: true,
    });
    if ((live[0]?.n ?? 0) > 0 || link.from === link.to) return 0;
    const moving = await db.querySql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM review_logs WHERE flashcard_id = ?",
      [link.from],
      { asObject: true }
    );
    for (const statement of CARD_CHILD_STATEMENTS) {
      try {
        const params: SqlJsValue[] = [...statement.params(link.from, link.to, now), link.from];
        await db.executeSql(statement.sql(LIVE_GUARD), params);
      } catch {
        // Table absent on databases that predate it.
      }
    }
    // The overlay moved; the card's cached suspend/bury columns follow it.
    await db.executeSql(
      `UPDATE flashcards SET
         suspended_at = (SELECT suspended_at FROM card_state_overlays WHERE flashcard_id = ?),
         buried_until = (SELECT buried_until FROM card_state_overlays WHERE flashcard_id = ?)
       WHERE id = ? AND EXISTS (SELECT 1 FROM card_state_overlays WHERE flashcard_id = ?)`,
      [link.to, link.to, link.to, link.to]
    );
    return moving[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Sets a card from its newest review when that review is newer than the card's last one. */
export async function applyNewestLogState(db: HistoryDb, cardId: string, modified: string): Promise<boolean> {
  try {
    const logs = await db.querySql<LogStateRow>(
      `SELECT new_state, new_interval_minutes, new_repetitions, new_difficulty, new_stability,
              new_lapses, reviewed_at
       FROM review_logs WHERE flashcard_id = ? ORDER BY julianday(reviewed_at) DESC LIMIT 1`,
      [cardId],
      { asObject: true }
    );
    const log = logs[0];
    if (!log) return false;
    const cards = await db.querySql<{ last_reviewed: string | null }>(
      "SELECT last_reviewed FROM flashcards WHERE id = ?",
      [cardId],
      { asObject: true }
    );
    const card = cards[0];
    if (!card) return false;
    const reviewedAt = toMillis(log.reviewed_at);
    if (card.last_reviewed !== null && toMillis(card.last_reviewed) >= reviewedAt) return false;
    const dueDate = new Date(reviewedAt + log.new_interval_minutes * 60 * 1000).toISOString();
    await db.executeSql(
      `UPDATE flashcards
       SET state = ?, due_date = ?, interval = ?, repetitions = ?, difficulty = ?, stability = ?,
           lapses = ?, last_reviewed = ?,
           modified = CASE WHEN julianday(modified) >= julianday(?) THEN modified ELSE ? END
       WHERE id = ? AND (last_reviewed IS NULL OR julianday(last_reviewed) < julianday(?))`,
      [
        log.new_state, dueDate, log.new_interval_minutes, log.new_repetitions, log.new_difficulty,
        log.new_stability, log.new_lapses, log.reviewed_at, modified, modified, cardId, log.reviewed_at,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

/** Cards still showing as new that have reviews take their state from the latest one. */
export async function restoreStrandedNewCards(db: HistoryDb, now: string): Promise<number> {
  const countRows = await db.querySql<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM flashcards f
     WHERE f.state = 'new'
       AND EXISTS (SELECT 1 FROM review_logs rl WHERE rl.flashcard_id = f.id)`,
    [],
    { asObject: true }
  );
  const restored = countRows[0]?.count ?? 0;
  if (restored === 0) return 0;
  await db.executeSql(
    `UPDATE flashcards
     SET state = latest.new_state,
         stability = latest.new_stability,
         difficulty = latest.new_difficulty,
         repetitions = latest.new_repetitions,
         lapses = latest.new_lapses,
         interval = latest.new_interval_minutes,
         last_reviewed = latest.reviewed_at,
         due_date = strftime('%Y-%m-%dT%H:%M:%fZ', latest.reviewed_at, '+' || latest.new_interval_minutes || ' minutes'),
         modified = ?
     FROM (
       SELECT rl.flashcard_id,
              rl.new_state, rl.new_stability, rl.new_difficulty,
              rl.new_repetitions, rl.new_lapses, rl.new_interval_minutes, rl.reviewed_at
       FROM review_logs rl
       JOIN (
         SELECT flashcard_id, MAX(reviewed_at) AS max_reviewed
         FROM review_logs
         GROUP BY flashcard_id
       ) m ON m.flashcard_id = rl.flashcard_id AND m.max_reviewed = rl.reviewed_at
     ) AS latest
     WHERE flashcards.id = latest.flashcard_id
       AND flashcards.state = 'new'`,
    [now]
  );
  return restored;
}

/** Re-attaches stranded review history and rebuilds the scheduling it implies. */
export async function recoverReviewHistory(
  db: HistoryDb,
  options: { contentMatch: boolean; now: string; dryRun?: boolean }
): Promise<HistoryRecoveryResult> {
  const plan = await planHistoryLinks(db, { contentMatch: options.contentMatch });
  if (options.dryRun) return { reattached: 0, restored: 0, links: [], plan };
  const links: HistoryLink[] = [];
  let restored = 0;
  for (const link of plan.links) {
    if ((await relinkCardHistory(db, link, options.now)) === 0) continue;
    links.push({ from: link.from, to: link.to });
    if (await applyNewestLogState(db, link.to, options.now)) restored++;
  }
  restored += await restoreStrandedNewCards(db, options.now);
  return { reattached: links.length, restored, links, plan };
}

/** Deletes stranded history a later recovery would attach to these just-reset cards. */
export async function forgetStrandedHistory(db: HistoryDb, cardIds: readonly string[], at: string): Promise<number> {
  if (cardIds.length === 0) return 0;
  try {
    const plan = await planHistoryLinks(db, { contentMatch: true, targets: cardIds });
    let forgotten = 0;
    for (const link of plan.links) {
      const rows = await db.querySql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM review_logs WHERE flashcard_id = ? AND julianday(reviewed_at) <= julianday(?)",
        [link.from, at],
        { asObject: true }
      );
      await db.executeSql(
        `DELETE FROM review_logs WHERE flashcard_id = ? AND julianday(reviewed_at) <= julianday(?)${LIVE_GUARD}`,
        [link.from, at, link.from]
      );
      forgotten += rows[0]?.n ?? 0;
    }
    return forgotten;
  } catch {
    return 0;
  }
}

/** The ops that carry these links to other devices. */
export function historyRelinkOps(links: readonly HistoryLink[], at: string): HistoryRelinkOp[] {
  const ops: HistoryRelinkOp[] = [];
  for (let i = 0; i < links.length; i += HISTORY_RELINK_OP_LINKS) {
    const slice = links.slice(i, i + HISTORY_RELINK_OP_LINKS);
    ops.push({ o: "history_relink", p: { links: slice.map((link) => ({ from: link.from, c: link.to })), at } });
  }
  return ops;
}
