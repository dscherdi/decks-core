import type { RawDatabase, SyncResult } from "../FlashcardSynchronizer";
import type { DpkgContents } from "./archive";
import { readDpkgDeckDb, type DirectoryDeckContent } from "./deck-db";
import {
  getDirectoryDeck,
  materialiseDirectoryDeck,
  storeDirectoryDeck,
  type DirectoryDeckRecord,
} from "./DirectoryStore";
import { directoryDeckId } from "./ids";
import { DpkgError, type DpkgManifest } from "./manifest";

export interface ClosableRawDatabase extends RawDatabase {
  close(): void;
}

/** Opens a package's deck.db bytes as a separate, throwaway database. */
export type OpenRawDatabase = (bytes: Uint8Array) => ClosableRawDatabase;

// Package ids are 64-bit; a short suffix is a content id that could name a user's own card.
const PACKAGE_CARD_ID = /^[a-z]+_[0-9a-z]{8,13}$/;

export function readDpkgContent(contents: DpkgContents, open: OpenRawDatabase): DirectoryDeckContent {
  const deckDb = open(contents.deckDb);
  let content: DirectoryDeckContent;
  try {
    content = readDpkgDeckDb(deckDb);
  } finally {
    deckDb.close();
  }
  if (content.cards.length !== contents.manifest.cardCount) {
    throw new DpkgError("invalid_deck", "The card count does not match the manifest");
  }
  const malformed = content.cards.find((card) => !PACKAGE_CARD_ID.test(card.id));
  if (malformed) throw new DpkgError("invalid_deck", `Card id ${malformed.id} is not a package id`);
  return content;
}

/** Card ids in the package that already belong to a deck other than this one. */
export function findForeignCardIds(db: RawDatabase, deckId: string, ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const stmt = db.prepare(
      `SELECT id FROM flashcards WHERE deck_id <> ? AND id IN (${chunk.map(() => "?").join(",")})`
    );
    try {
      stmt.bind([deckId, ...chunk]);
      while (stmt.step()) out.push(String(stmt.get()[0]));
    } finally {
      stmt.free();
    }
  }
  return out;
}

export interface DpkgImportResult {
  deckId: string;
  manifest: DpkgManifest;
  previous: DirectoryDeckRecord | null;
  sync: SyncResult;
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
  const foreign = findForeignCardIds(db, deckId, content.cards.map((card) => card.id));
  if (foreign.length > 0) {
    throw new DpkgError("invalid_deck", `The package reuses ${foreign.length} card id(s) of another deck`);
  }
  const { previous } = storeDirectoryDeck(db, { manifest: contents.manifest, content, archiveSha256, now });
  const record = getDirectoryDeck(db, deckId);
  if (!record) throw new DpkgError("invalid_deck", "The deck could not be stored");
  const sync = materialiseDirectoryDeck(db, record, now);
  return { deckId, manifest: contents.manifest, previous, sync };
}
