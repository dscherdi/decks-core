import type { RawDatabase, SyncResult } from "../FlashcardSynchronizer";
import type { DpkgContents } from "./archive";
import { packageCards, readDpkgDeckDb, type DirectoryDeckContent, type DirectoryPackageContent } from "./deck-db";
import {
  getDirectoryDeck,
  materialiseDirectoryDeck,
  storeDirectoryDeck,
  type DirectoryDeckRecord,
} from "./DirectoryStore";
import { directoryDeckId, directoryDeckPath } from "./ids";
import { DpkgError, type DpkgManifest } from "./manifest";

export interface ClosableRawDatabase extends RawDatabase {
  close(): void;
}

/** Opens a package's deck.db bytes as a separate, throwaway database. */
export type OpenRawDatabase = (bytes: Uint8Array) => ClosableRawDatabase;

// Package ids are 64-bit; a short suffix is a content id that could name a user's own card.
const PACKAGE_CARD_ID = /^[a-z]+_[0-9a-z]{8,13}$/;

export function readDpkgContent(contents: DpkgContents, open: OpenRawDatabase): DirectoryPackageContent {
  const deckDb = open(contents.deckDb);
  let content: DirectoryPackageContent;
  try {
    content = readDpkgDeckDb(deckDb);
  } finally {
    deckDb.close();
  }
  const listed = contents.manifest.decks;
  if (content.decks.length !== listed.length) {
    throw new DpkgError("invalid_deck", "The decks do not match the manifest");
  }
  // The manifest's order is the author's; the store and the apps follow it.
  const ordered: DirectoryDeckContent[] = [];
  for (const entry of listed) {
    const deck = content.decks.find((candidate) => candidate.key === entry.key);
    if (!deck || deck.cards.length !== entry.cardCount) {
      throw new DpkgError("invalid_deck", `Deck ${JSON.stringify(entry.key || entry.title)} does not match the manifest`);
    }
    ordered.push(deck);
  }
  const cards = packageCards(content);
  const malformed = cards.find((card) => !PACKAGE_CARD_ID.test(card.id));
  if (malformed) throw new DpkgError("invalid_deck", `Card id ${malformed.id} is not a package id`);
  return { ...content, decks: ordered };
}

/** Card ids in the package that already belong to a deck outside it. */
export function findForeignCardIds(db: RawDatabase, slug: string, ids: string[]): string[] {
  const root = directoryDeckPath(slug);
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const stmt = db.prepare(
      `SELECT f.id FROM flashcards f LEFT JOIN decks d ON d.id = f.deck_id
       WHERE NOT (COALESCE(d.filepath, '') = ? OR COALESCE(d.filepath, '') LIKE ?)
         AND f.id IN (${chunk.map(() => "?").join(",")})`
    );
    try {
      stmt.bind([root, `${root}/%`, ...chunk]);
      while (stmt.step()) out.push(String(stmt.get()[0]));
    } finally {
      stmt.free();
    }
  }
  return out;
}

export interface DpkgImportResult {
  /** The installed package's id; a single-deck package's deck has the same one. */
  deckId: string;
  manifest: DpkgManifest;
  previous: DirectoryDeckRecord | null;
  /** One per deck of the package, in the manifest's order. */
  sync: SyncResult[];
}

/** Store a package's deck and build its working rows. Media files are the caller's to write. */
export function importDpkgContent(
  db: RawDatabase,
  contents: DpkgContents,
  archiveSha256: string,
  open: OpenRawDatabase,
  now: string
): DpkgImportResult {
  const content = readDpkgContent(contents, open);
  const deckId = directoryDeckId(contents.manifest.slug);
  const foreign = findForeignCardIds(db, contents.manifest.slug, packageCards(content).map((card) => card.id));
  if (foreign.length > 0) {
    throw new DpkgError("invalid_deck", `The package reuses ${foreign.length} card id(s) of another deck`);
  }
  const { previous } = storeDirectoryDeck(db, { manifest: contents.manifest, content, archiveSha256, now });
  const record = getDirectoryDeck(db, deckId);
  if (!record) throw new DpkgError("invalid_deck", "The deck could not be stored");
  const sync = materialiseDirectoryDeck(db, record, now);
  return { deckId, manifest: contents.manifest, previous, sync };
}
