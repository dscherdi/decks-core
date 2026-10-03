import type { Flashcard } from "../database/types";
import type { IDatabaseService, ILogger } from "../database/DatabaseService.interface";
import type { NoteAccess } from "./NoteAccess";
import type { AnchorStamper } from "./AnchorStamper";
import { isIdKey, parseBindingKey } from "../utils/anchors";
import type { ClientHelloOp } from "./SyncLog.types";

/** What a device's `client_hello` announces once it reads id-carrying tokens. */
export const CARD_IDENTITY_VERSION = 2;

/** The op each device writes at start and daily. */
export function helloOp(): ClientHelloOp {
  return { o: "client_hello", p: { identity: CARD_IDENTITY_VERSION } };
}

export interface DeviceLog {
  deviceId: string;
  /** Last-modified epoch ms of the device's log file. */
  modified: number;
  text: () => Promise<string>;
}

const ACTIVE_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Devices whose log moved in the last 30 days without announcing id-carrying tokens. */
export async function olderDevices(logs: DeviceLog[], now: number): Promise<string[]> {
  const older: string[] = [];
  for (const log of logs) {
    if (now - log.modified > ACTIVE_WITHIN_MS) continue;
    const announces = (await log.text()).split("\n").some((line) => {
      if (!line.includes('"client_hello"')) return false;
      try {
        const entry = JSON.parse(line) as { o?: string; p?: { identity?: number } };
        return entry.o === "client_hello" && (entry.p?.identity ?? 0) >= CARD_IDENTITY_VERSION;
      } catch {
        return false;
      }
    });
    if (!announces) older.push(log.deviceId);
  }
  return older;
}

/** Roles whose minted tokens the upgrade rewrites; canvas keys (`e`, `n`) have no token. */
const NOTE_ROLES = new Set(["h", "c", "t", "o", "q", "p"]);

/** Whether a row's identity still comes from this device's binding table. */
export function dependsOnBinding(anchor: string | null | undefined): boolean {
  if (!anchor || isIdKey(anchor)) return false;
  const parts = parseBindingKey(anchor);
  return parts !== null && NOTE_ROLES.has(parts.role);
}

export interface UpgradeDeck {
  id: string;
  filepath: string;
  titleMode: boolean;
}

/**
 * Rewrites minted tokens as id-carrying ones, a few notes at a time, so cards stop
 * depending on this device's bindings before they are retired.
 */
export class AnchorUpgrader {
  // Notes whose upgrade was refused this session; retried after a restart.
  private refused = new Set<string>();

  constructor(
    private notes: NoteAccess,
    private db: IDatabaseService,
    private stamper: AnchorStamper,
    private logger?: ILogger
  ) {}

  /** How many cards still resolve through this device's bindings. */
  static async pendingCount(db: Pick<IDatabaseService, "querySql">): Promise<number> {
    return (await AnchorUpgrader.pendingByDeck(db)).reduce((sum, [, n]) => sum + n, 0);
  }

  private static async pendingByDeck(
    db: Pick<IDatabaseService, "querySql">
  ): Promise<Array<[string, number]>> {
    const rows = await db.querySql<{ deck_id: string; anchor: string }>(
      "SELECT deck_id, anchor FROM flashcards WHERE anchor IS NOT NULL",
      [],
      { asObject: true }
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (dependsOnBinding(row.anchor)) counts.set(row.deck_id, (counts.get(row.deck_id) ?? 0) + 1);
    }
    return [...counts];
  }

  /** A note is clean when its file is what the deck last synced, so no edit is pending. */
  async matchesLastSync(deck: UpgradeDeck): Promise<boolean> {
    const lastSynced = await this.db.getDeckLastSyncedMtime(deck.id);
    return lastSynced !== 0 && (await this.notes.mtime(deck.filepath)) === lastSynced;
  }

  /** Upgrade up to `limit` notes, skipping any `isClean` turns down. Returns the cards upgraded. */
  async runBatch(
    decks: UpgradeDeck[],
    limit: number,
    isClean: (deck: UpgradeDeck) => boolean | Promise<boolean> = (deck) => this.matchesLastSync(deck)
  ): Promise<number> {
    const byId = new Map(decks.map((deck) => [deck.id, deck]));
    let notesDone = 0;
    let upgraded = 0;
    for (const [deckId] of await AnchorUpgrader.pendingByDeck(this.db)) {
      if (notesDone >= limit) break;
      const deck = byId.get(deckId);
      if (!deck || this.refused.has(deck.filepath) || !(await isClean(deck))) continue;

      const cards: Flashcard[] = (await this.db.getFlashcardsByDeck(deck.id)).filter(
        (card) => card.sourceFile === deck.filepath && dependsOnBinding(card.anchor)
      );
      if (cards.length === 0) continue;
      notesDone++;
      const result = await this.stamper.stampFileBatch(deck.filepath, cards, deck.titleMode);
      upgraded += result.stamped;
      if (result.skipped > 0) {
        this.refused.add(deck.filepath);
        this.logger?.debug(
          `Anchor upgrade left ${result.skipped} card(s) in ${deck.filepath} on their bindings`
        );
      }
    }
    return upgraded;
  }
}
