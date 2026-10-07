import type { Database } from "sql.js";
import { buildMigrationSQL } from "../../../database/schemas";
import { unpackDpkg } from "../archive";
import { importDpkgContent } from "../import";
import {
  getDirectoryDeck,
  listDirectoryDecks,
  materialiseDirectoryDecks,
  mergeDirectoryTables,
  removeDirectoryDeck,
} from "../DirectoryStore";
import { directoryDeckId, directoryDeckPath, directoryDeckTag } from "../ids";
import type { DirectoryDeckContent } from "../deck-db";
import { buildPackage, card, mainDb, opener, review, rows, sqlJs } from "./helpers";

const SLUG = "capitals";
const DECK = directoryDeckId(SLUG);

function v1(): DirectoryDeckContent {
  return {
    name: "World capitals",
    fileTags: [],
    cards: [
      card(SLUG, "card_fr", "France", "Paris"),
      card(SLUG, "card_de", "Germany", "Berlin"),
      card(SLUG, "card_it", "Italy", "Rome"),
    ],
    templates: [],
  };
}

async function install(db: Database, content: DirectoryDeckContent, version: number, now: string) {
  const pkg = await buildPackage(SLUG, version, content);
  return importDpkgContent(db, await unpackDpkg(pkg, { includeMedia: false }), `sha-${version}`, await opener(), now);
}

function cards(db: Database) {
  return rows(db, "SELECT id, front, back, state, stability, source_file FROM flashcards WHERE deck_id = ? ORDER BY front", [DECK]);
}

describe("directory decks in the main database", () => {
  it("installs as a review-only deck with no vault path", async () => {
    const db = await mainDb();
    const result = await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");

    expect(result.deckId).toBe(DECK);
    const deck = rows(db, "SELECT filepath, tag, profile_id FROM decks WHERE id = ?", [DECK])[0];
    expect(deck).toEqual({ filepath: directoryDeckPath(SLUG), tag: directoryDeckTag(SLUG), profile_id: "profile_default" });
    expect(cards(db).map((c) => c.id).sort()).toEqual(v1().cards.map((c) => c.id).sort());
    expect(cards(db).every((c) => c.state === "new" && c.source_file === directoryDeckPath(SLUG))).toBe(true);
  });

  it("keeps progress across an update and drops only the cards the update removed", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const [france, germany, italy] = v1().cards;
    review(db, france.id, "2026-10-02T09:00:00.000Z", 12.5);
    review(db, italy.id, "2026-10-02T09:01:00.000Z", 3);

    const updated = v1();
    updated.cards = [
      { ...france, back: "Paris (capital since 987)", contentHash: "edited" },
      germany,
      card(SLUG, "card_es", "Spain", "Madrid"),
    ];
    const result = await install(db, updated, 2, "2026-10-03T10:00:00.000Z");

    expect(result.previous?.version).toBe(1);
    const after = cards(db);
    expect(after.map((c) => c.front)).toEqual(["France", "Germany", "Spain"]);
    expect(after.find((c) => c.id === france.id)).toMatchObject({ state: "review", stability: 12.5, back: "Paris (capital since 987)" });
    expect(rows(db, "SELECT COUNT(*) AS n FROM review_logs WHERE flashcard_id = ?", [italy.id])[0].n).toBe(1);
  });

  it("never hands a removed card's progress to a new card with the same answer", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const [france, germany, italy] = v1().cards;
    review(db, italy.id, "2026-10-02T09:00:00.000Z", 20);

    const updated = v1();
    const roman = card(SLUG, "card_roma", "Capital of the Roman Empire", "Rome");
    updated.cards = [france, germany, roman];
    await install(db, updated, 2, "2026-10-03T10:00:00.000Z");

    expect(cards(db).find((c) => c.id === roman.id)).toMatchObject({ state: "new" });
    expect(rows(db, "SELECT COUNT(*) AS n FROM review_logs WHERE flashcard_id = ?", [italy.id])[0].n).toBe(1);
  });

  it("is rebuilt with its progress after a migration drops the working tables", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const france = v1().cards[0];
    review(db, france.id, "2026-10-02T09:00:00.000Z", 8);

    db.run("PRAGMA user_version = 41");
    db.run(buildMigrationSQL(db));
    expect(cards(db)).toHaveLength(0);
    expect(listDirectoryDecks(db)).toHaveLength(1);

    const result = materialiseDirectoryDecks(db, "2026-10-04T10:00:00.000Z");
    expect(result.materialised).toEqual([DECK]);
    expect(cards(db).find((c) => c.id === france.id)).toMatchObject({ state: "review", stability: 8 });

    expect(materialiseDirectoryDecks(db, "2026-10-04T10:01:00.000Z").materialised).toEqual([]);
  });

  it("stays removed when an older copy of the database is merged back", async () => {
    const SQL = await sqlJs();
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const stale = new SQL.Database(db.export());

    expect(removeDirectoryDeck(db, DECK, "2026-10-05T10:00:00.000Z")).toBe(true);
    expect(cards(db)).toHaveLength(0);

    expect(mergeDirectoryTables(db, stale)).toEqual([]);
    materialiseDirectoryDecks(db, "2026-10-05T10:01:00.000Z");
    expect(cards(db)).toHaveLength(0);
    expect(getDirectoryDeck(db, DECK)?.removedAt).toBe("2026-10-05T10:00:00.000Z");
  });

  it("arrives on another device through a merge, and leaves the same way", async () => {
    const SQL = await sqlJs();
    const phone = await mainDb();
    const laptop = await mainDb();
    await install(phone, v1(), 1, "2026-10-01T10:00:00.000Z");

    expect(mergeDirectoryTables(laptop, new SQL.Database(phone.export()))).toEqual([DECK]);
    materialiseDirectoryDecks(laptop, "2026-10-01T11:00:00.000Z");
    expect(cards(laptop)).toHaveLength(3);

    removeDirectoryDeck(phone, DECK, "2026-10-06T10:00:00.000Z");
    mergeDirectoryTables(laptop, new SQL.Database(phone.export()));
    expect(materialiseDirectoryDecks(laptop, "2026-10-06T11:00:00.000Z").dropped).toEqual([DECK]);
    expect(cards(laptop)).toHaveLength(0);
  });

  it("an import made after a removal wins over it", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-07T10:00:00.000Z");
    expect(removeDirectoryDeck(db, DECK, "2026-10-06T10:00:00.000Z")).toBe(false);
    expect(cards(db)).toHaveLength(3);
  });

  it("refuses a package whose ids already belong to another deck", async () => {
    const db = await mainDb();
    const stolenId = v1().cards[0].id;
    db.run(
      `INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES ('deck_own', 'Own', 'Own.md', '#decks', 'profile_default', 'x', 'x')`
    );
    db.run(
      `INSERT INTO flashcards (id, deck_id, front, back, type, source_file, content_hash, state, due_date, interval, created, modified)
       VALUES (?, 'deck_own', 'q', 'a', 'header-paragraph', 'Own.md', 'h', 'new', 'x', 0, 'x', 'x')`,
      [stolenId]
    );
    await expect(install(db, v1(), 1, "2026-10-01T10:00:00.000Z")).rejects.toMatchObject({ code: "invalid_deck" });
    expect(rows(db, "SELECT deck_id FROM flashcards WHERE id = ?", [stolenId])[0].deck_id).toBe("deck_own");
  });

  it("studies with the profile mapped to #directory", async () => {
    const db = await mainDb();
    const profileId = rows(db, "SELECT id FROM deckprofiles WHERE id <> 'profile_default' LIMIT 1")[0].id;
    db.run(
      `INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory', 'x')`,
      [profileId]
    );
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    expect(rows(db, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(profileId);
  });

  it("follows a #directory mapping made after it was installed", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const profileId = rows(db, "SELECT id FROM deckprofiles WHERE id <> 'profile_default' LIMIT 1")[0].id;
    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory/capitals', 'x')`, [profileId]);
    expect(materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z").reprofiled).toEqual([DECK]);
    expect(rows(db, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(profileId);
  });
});
