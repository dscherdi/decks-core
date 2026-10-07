import type { Database } from "sql.js";
import { buildMigrationSQL } from "../../../database/schemas";
import { unpackDpkg } from "../archive";
import { importDpkgContent } from "../import";
import {
  directoryExamDeckIds,
  ensureDirectoryTables,
  getDirectoryDeck,
  listDirectoryDecks,
  materialiseDirectoryDecks,
  mergeDirectoryTables,
  pickDirectoryProfile,
  removeDirectoryDeck,
} from "../DirectoryStore";
import { directoryDeckId, directoryDeckPath, directoryDeckTag } from "../ids";
import type { DirectoryCardContent, DirectoryPackageContent } from "../deck-db";
import { buildPackage, card, mainDb, opener, review, rows, singleDeck, sqlJs } from "./helpers";
import { DEFAULT_EXAM_SETTINGS, DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID } from "../../../database/types";

const SLUG = "capitals";
const DECK = directoryDeckId(SLUG);

function v1(): { cards: DirectoryCardContent[] } {
  return {
    cards: [
      card(SLUG, "card_fr", "France", "Paris"),
      card(SLUG, "card_de", "Germany", "Berlin"),
      card(SLUG, "card_it", "Italy", "Rome"),
    ],
  };
}

async function install(
  db: Database,
  content: { cards: DirectoryCardContent[] } | DirectoryPackageContent,
  version: number,
  now: string,
  exams = {}
) {
  const pkg = await buildPackage(
    SLUG,
    version,
    "decks" in content ? content : singleDeck("World capitals", content.cards),
    [],
    exams,
    "World capitals"
  );
  return importDpkgContent(db, await unpackDpkg(pkg, { includeMedia: false }), `sha-${version}`, await opener(), now);
}

/** Europe in two decks: west and east of the package. */
function course(west: DirectoryCardContent[], east: DirectoryCardContent[]): DirectoryPackageContent {
  return {
    decks: [
      { key: "west", name: "Western Europe", fileTags: ["west"], cards: west },
      { key: "east", name: "Eastern Europe", fileTags: [], cards: east },
    ],
    templates: [],
  };
}

const WEST = directoryDeckId(SLUG, "west");
const EAST = directoryDeckId(SLUG, "east");

function deckOf(db: Database, cardId: string) {
  return rows(db, "SELECT deck_id, state, stability FROM flashcards WHERE id = ?", [cardId])[0];
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

  it("studies an exam deck with the Exams preset unless #directory is mapped", async () => {
    const exam = {
      cards: [...v1().cards, card(SLUG, "qcard_gas", "Noble gas?", "- [ ] Oxygen\n- [x] Argon", { type: "multiple-choice" })],
    };
    const installExam = async (db: Database) => {
      await install(db, exam, 1, "2026-10-01T10:00:00.000Z", { "": { ...DEFAULT_EXAM_SETTINGS, questionCount: 2 } });
    };

    const db = await mainDb();
    await installExam(db);
    expect(rows(db, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(EXAMS_PROFILE_ID);
    expect(rows(db, "SELECT type FROM flashcards WHERE deck_id = ? AND front = 'Noble gas?'", [DECK])[0].type).toBe("multiple-choice");

    const mappedDb = await mainDb();
    const profileId = rows(mappedDb, "SELECT id FROM deckprofiles WHERE id NOT IN (?, ?) LIMIT 1", [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
    mappedDb.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory', 'x')`, [profileId]);
    await installExam(mappedDb);
    expect(rows(mappedDb, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(profileId);

    const noPresetDb = await mainDb();
    noPresetDb.run("UPDATE deckprofiles SET deleted_at = 'x' WHERE id = ?", [EXAMS_PROFILE_ID]);
    await installExam(noPresetDb);
    expect(rows(noPresetDb, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(DEFAULT_PROFILE_ID);
  });

  it("follows a #directory mapping made after it was installed", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const profileId = rows(db, "SELECT id FROM deckprofiles WHERE id <> 'profile_default' LIMIT 1")[0].id;
    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory/capitals', 'x')`, [profileId]);
    expect(materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z").reprofiled).toEqual([DECK]);
    expect(rows(db, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(profileId);
  });

  it("installs a package of several decks as one deck each, filed under the package", async () => {
    const db = await mainDb();
    const [france, germany, italy] = v1().cards;
    const result = await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z");

    expect(result.deckId).toBe(DECK);
    expect(result.sync).toHaveLength(2);
    expect(listDirectoryDecks(db).map((record) => record.id)).toEqual([DECK]);
    expect(rows(db, "SELECT id, name, filepath, tag, file_tags FROM decks ORDER BY filepath")).toEqual([
      { id: EAST, name: "Eastern Europe", filepath: directoryDeckPath(SLUG, "east"), tag: directoryDeckTag(SLUG, "east"), file_tags: "[]" },
      { id: WEST, name: "Western Europe", filepath: directoryDeckPath(SLUG, "west"), tag: directoryDeckTag(SLUG, "west"), file_tags: '["west"]' },
    ]);
    expect(deckOf(db, france.id).deck_id).toBe(WEST);
    expect(deckOf(db, italy.id).deck_id).toBe(EAST);
    expect(rows(db, "SELECT COUNT(*) AS n FROM flashcards WHERE source_file = ?", [directoryDeckPath(SLUG, "east")])[0].n).toBe(1);
  });

  it("keeps progress when an update moves a card between its decks, or folds them into one", async () => {
    const db = await mainDb();
    const [france, germany, italy] = v1().cards;
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z");
    review(db, france.id, "2026-10-02T09:00:00.000Z", 12.5);

    await install(db, course([germany], [italy, france]), 2, "2026-10-03T10:00:00.000Z");
    expect(deckOf(db, france.id)).toMatchObject({ deck_id: EAST, state: "review", stability: 12.5 });
    expect(materialiseDirectoryDecks(db, "2026-10-03T10:01:00.000Z").materialised).toEqual([]);

    // Shrunk to one deck, the package's deck takes the package's own id, path and tag.
    await install(db, { cards: [germany, italy, france] }, 3, "2026-10-04T10:00:00.000Z");
    expect(rows(db, "SELECT id FROM decks ORDER BY id")).toEqual([{ id: DECK }]);
    expect(deckOf(db, france.id)).toMatchObject({ deck_id: DECK, state: "review", stability: 12.5 });
  });

  it("removes every deck of the package together", async () => {
    const db = await mainDb();
    const [france, germany, italy] = v1().cards;
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z");
    expect(removeDirectoryDeck(db, DECK, "2026-10-05T10:00:00.000Z")).toBe(true);
    expect(rows(db, "SELECT id FROM decks")).toEqual([]);
    expect(rows(db, "SELECT id FROM flashcards")).toEqual([]);
  });

  it("gives each deck its own profile: the Exams preset for an exam deck, a mapping on the package or one deck", async () => {
    const [france, germany, italy] = v1().cards;
    const exams = { east: { ...DEFAULT_EXAM_SETTINGS, passScorePct: 80 } };
    const profileOf = (db: Database, id: string) => rows(db, "SELECT profile_id FROM decks WHERE id = ?", [id])[0].profile_id;

    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", exams);
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID]);

    const other = rows(db, "SELECT id FROM deckprofiles WHERE id NOT IN (?, ?) LIMIT 1", [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, ?, 'x')`, [other, directoryDeckTag(SLUG)]);
    materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z");
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([other, other]);

    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m2', ?, ?, 'x')`, [
      DEFAULT_PROFILE_ID,
      directoryDeckTag(SLUG, "west"),
    ]);
    materialiseDirectoryDecks(db, "2026-10-02T10:01:00.000Z");
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([DEFAULT_PROFILE_ID, other]);
  });

  it("picks a package deck's profile from its deck tag, never from a flat tag", () => {
    const mapping = (profileId: string, tag: string) => ({ id: tag, profileId, tag, created: "x" });
    const tag = directoryDeckTag(SLUG, "east");
    expect(pickDirectoryProfile([], tag, false)).toBe(DEFAULT_PROFILE_ID);
    expect(pickDirectoryProfile([], tag, true)).toBe(EXAMS_PROFILE_ID);
    expect(pickDirectoryProfile([mapping("p1", "#directory")], tag, true)).toBe("p1");
    expect(pickDirectoryProfile([mapping("p1", "#german")], tag, true)).toBe(EXAMS_PROFILE_ID);
  });

  it("names every exam deck, and passes over a mapping whose profile was deleted", async () => {
    const [france, germany, italy] = v1().cards;
    const profileOf = (db: Database, id: string) => rows(db, "SELECT profile_id FROM decks WHERE id = ?", [id])[0].profile_id;
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", { east: DEFAULT_EXAM_SETTINGS });
    expect(directoryExamDeckIds(listDirectoryDecks(db))).toEqual(new Set([EAST]));

    const [first, second] = rows(db, "SELECT id FROM deckprofiles WHERE id NOT IN (?, ?) LIMIT 2", [
      DEFAULT_PROFILE_ID,
      EXAMS_PROFILE_ID,
    ]).map((row) => String(row.id));
    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory', 'x'), ('m2', ?, ?, 'x')`, [
      first,
      second,
      directoryDeckTag(SLUG),
    ]);
    db.run("UPDATE deckprofiles SET deleted_at = 'x' WHERE id = ?", [second]);
    materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z");
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([first, first]);
  });

  it("arrives on another device with all of its decks", async () => {
    const SQL = await sqlJs();
    const phone = await mainDb();
    const laptop = await mainDb();
    const [france, germany, italy] = v1().cards;
    await install(phone, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z");

    mergeDirectoryTables(laptop, new SQL.Database(phone.export()));
    materialiseDirectoryDecks(laptop, "2026-10-01T11:00:00.000Z");
    expect(deckOf(laptop, germany.id).deck_id).toBe(WEST);
    expect(deckOf(laptop, italy.id).deck_id).toBe(EAST);
  });

  it("adds the deck key column to a table created before it existed", async () => {
    const db = await mainDb();
    db.run("ALTER TABLE directory_cards DROP COLUMN deck_key");
    ensureDirectoryTables(db);
    expect(rows(db, "SELECT name FROM pragma_table_info('directory_cards') WHERE name = 'deck_key'")).toHaveLength(1);
  });
});
