import type { Database } from "sql.js";
import { buildMigrationSQL } from "../../../database/schemas";
import { unpackDpkg } from "../archive";
import { importDpkgContent } from "../import";
import {
  directoryDeckProfiles,
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
import { buildPackage, card, mainDb, opener, packageProfile, review, rows, singleDeck, sqlJs, type PackageProfiles } from "./helpers";
import { DEFAULT_EXAM_SETTINGS, DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID } from "../../../database/types";
import { directoryProfileId } from "../profiles";

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
  exams = {},
  profiles?: PackageProfiles
) {
  const pkg = await buildPackage(
    SLUG,
    version,
    "decks" in content ? content : singleDeck("World capitals", content.cards),
    [],
    exams,
    "World capitals",
    profiles
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
// The profiles a package that carries none studies with.
const STUDY_PROFILE = directoryProfileId(SLUG, "preset:study");
const examPresetProfile = (key: string) => directoryProfileId(SLUG, `preset:exam:${key}`);
// A profile the user has, which is neither the default nor a package's.
const USER_PROFILE_SQL = "SELECT id FROM deckprofiles WHERE id NOT IN (?, ?) AND id NOT LIKE 'profile_dir_%' LIMIT 2";

function profileOf(db: Database, deckId: string) {
  return rows(db, "SELECT profile_id FROM decks WHERE id = ?", [deckId])[0].profile_id;
}

function profileRow(db: Database, id: string) {
  return rows(
    db,
    `SELECT name, has_new_cards_limit_enabled AS newLimit, new_cards_per_day AS newPerDay, review_order AS reviewOrder,
       learning_steps AS learningSteps, fsrs_request_retention AS retention, cloze_show_context AS clozeContext,
       exam_enabled AS examEnabled, exam_settings AS examSettings, tts_lang AS ttsLang, created, modified, deleted_at AS deletedAt
     FROM deckprofiles WHERE id = ?`,
    [id]
  )[0];
}

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
    expect(deck).toEqual({ filepath: directoryDeckPath(SLUG), tag: directoryDeckTag(SLUG), profile_id: STUDY_PROFILE });
    expect(profileRow(db, STUDY_PROFILE)).toMatchObject({ name: "World capitals", newLimit: 0, examEnabled: 0, deletedAt: null });
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
    const profileId = rows(db, USER_PROFILE_SQL, [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
    db.run(
      `INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory', 'x')`,
      [profileId]
    );
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    expect(rows(db, "SELECT profile_id FROM decks WHERE id = ?", [DECK])[0].profile_id).toBe(profileId);
  });

  it("studies an exam deck with its own exam profile, carrying the package's exam settings, unless #directory is mapped", async () => {
    const exam = {
      cards: [...v1().cards, card(SLUG, "qcard_gas", "Noble gas?", "- [ ] Oxygen\n- [x] Argon", { type: "multiple-choice" })],
    };
    const settings = { ...DEFAULT_EXAM_SETTINGS, questionCount: 2 };
    const installExam = async (db: Database) => {
      await install(db, exam, 1, "2026-10-01T10:00:00.000Z", { "": settings });
    };

    const db = await mainDb();
    await installExam(db);
    expect(profileOf(db, DECK)).toBe(examPresetProfile(""));
    const own = profileRow(db, examPresetProfile(""));
    expect(own).toMatchObject({ examEnabled: 1, newLimit: 1, newPerDay: 0 });
    expect(JSON.parse(String(own.examSettings))).toEqual(settings);
    expect(rows(db, "SELECT type FROM flashcards WHERE deck_id = ? AND front = 'Noble gas?'", [DECK])[0].type).toBe("multiple-choice");

    const mappedDb = await mainDb();
    const profileId = rows(mappedDb, USER_PROFILE_SQL, [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
    mappedDb.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory', 'x')`, [profileId]);
    await installExam(mappedDb);
    expect(profileOf(mappedDb, DECK)).toBe(profileId);
  });

  it("follows a #directory mapping made after it was installed", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const profileId = rows(db, USER_PROFILE_SQL, [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
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

  it("gives each deck its package's profile, unless a mapping on the package or one deck says otherwise", async () => {
    const [france, germany, italy] = v1().cards;
    const exams = { east: { ...DEFAULT_EXAM_SETTINGS, passScorePct: 80 } };

    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", exams);
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([STUDY_PROFILE, examPresetProfile("east")]);

    const other = rows(db, USER_PROFILE_SQL, [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
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
    expect(pickDirectoryProfile([], tag, null)).toBe(DEFAULT_PROFILE_ID);
    expect(pickDirectoryProfile([], tag, "own")).toBe("own");
    expect(pickDirectoryProfile([mapping("p1", "#directory")], tag, "own")).toBe("p1");
    expect(pickDirectoryProfile([mapping("p1", "#german")], tag, "own")).toBe("own");
  });

  it("names each deck's profile, and passes over a mapping whose profile was deleted", async () => {
    const [france, germany, italy] = v1().cards;
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", { east: DEFAULT_EXAM_SETTINGS });
    expect(directoryDeckProfiles(listDirectoryDecks(db))).toEqual(
      new Map([
        [WEST, STUDY_PROFILE],
        [EAST, examPresetProfile("east")],
      ])
    );

    const [first, second] = rows(db, USER_PROFILE_SQL, [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID]).map((row) => String(row.id));
    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, '#directory', 'x'), ('m2', ?, ?, 'x')`, [
      first,
      second,
      directoryDeckTag(SLUG),
    ]);
    db.run("UPDATE deckprofiles SET deleted_at = 'x' WHERE id = ?", [second]);
    materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z");
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([first, first]);
  });

  it("studies with the profiles it carries: decks sharing one share it, the first named after the package", async () => {
    const [france, germany, italy] = v1().cards;
    const settings = { ...DEFAULT_EXAM_SETTINGS, questionCount: 5, passScorePct: 70 };
    const profiles: PackageProfiles = {
      list: [
        packageProfile("steady", { newCardsPerDay: 15, reviewOrder: "random", learningSteps: "1m 10m", ttsLang: "de-DE" }),
        packageProfile("final", { newCardsPerDay: 0, requestRetention: 0.85, clozeShowContext: "open" }),
      ],
      byDeck: { west: "steady", east: "final" },
    };
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", { east: settings }, profiles);

    const steady = directoryProfileId(SLUG, "steady");
    const final = directoryProfileId(SLUG, "final");
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([steady, final]);
    expect(profileRow(db, steady)).toMatchObject({
      name: "World capitals",
      newLimit: 1,
      newPerDay: 15,
      reviewOrder: "random",
      learningSteps: "1m 10m",
      ttsLang: "de-DE",
      examEnabled: 0,
      created: "2026-10-01T10:00:00.000Z",
      modified: "2026-10-01T10:00:00.000Z",
    });
    const finalRow = profileRow(db, final);
    expect(finalRow).toMatchObject({ name: "World capitals · Eastern Europe", newPerDay: 0, retention: 0.85, clozeContext: "open", examEnabled: 1 });
    expect(JSON.parse(String(finalRow.examSettings))).toEqual(settings);
  });

  it("moves an install made before packages carried profiles onto its own profile", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    db.run("DELETE FROM deckprofiles WHERE id LIKE 'profile_dir_%'");
    db.run("UPDATE decks SET profile_id = ? WHERE id = ?", [DEFAULT_PROFILE_ID, DECK]);

    const result = materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z");
    expect(result.profiles).toEqual([STUDY_PROFILE]);
    expect(result.reprofiled).toEqual([DECK]);
    expect(profileOf(db, DECK)).toBe(STUDY_PROFILE);
  });

  it("never takes a name another profile holds", async () => {
    const db = await mainDb();
    db.run(
      `INSERT INTO deckprofiles (id, name, created, modified) VALUES ('profile_mine', 'World capitals', 'x', 'x')`
    );
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).name).toBe("World capitals (capitals)");
    expect(rows(db, "SELECT name FROM deckprofiles WHERE id = 'profile_mine'")[0].name).toBe("World capitals");
  });

  it("brings an untouched profile up to a new version and keeps one the user edited", async () => {
    const [france, germany, italy] = v1().cards;
    const carried = (westNew: number, eastNew: number): PackageProfiles => ({
      list: [packageProfile("a", { newCardsPerDay: westNew }), packageProfile("b", { newCardsPerDay: eastNew })],
      byDeck: { west: "a", east: "b" },
    });
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", {}, carried(10, 10));
    const [a, b] = [directoryProfileId(SLUG, "a"), directoryProfileId(SLUG, "b")];
    db.run("UPDATE deckprofiles SET new_cards_per_day = 3, modified = '2026-10-02T09:00:00.000Z' WHERE id = ?", [b]);

    await install(db, course([france, germany], [italy]), 2, "2026-10-03T10:00:00.000Z", {}, carried(25, 30));
    expect([profileRow(db, a).newPerDay, profileRow(db, b).newPerDay]).toEqual([25, 3]);
  });

  it("removes its profiles with it and brings them back on a new install; a profile the user removed stays removed", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    removeDirectoryDeck(db, DECK, "2026-10-02T10:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).deletedAt).toBe("2026-10-02T10:00:00.000Z");

    await install(db, v1(), 1, "2026-10-03T10:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).deletedAt).toBeNull();
    expect(profileOf(db, DECK)).toBe(STUDY_PROFILE);

    // Deleting a profile moves its decks to the default, as the profile screen does.
    db.run("UPDATE deckprofiles SET deleted_at = '2026-10-04T10:00:00.000Z' WHERE id = ?", [STUDY_PROFILE]);
    db.run("UPDATE decks SET profile_id = ? WHERE profile_id = ?", [DEFAULT_PROFILE_ID, STUDY_PROFILE]);
    materialiseDirectoryDecks(db, "2026-10-04T11:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).deletedAt).toBe("2026-10-04T10:00:00.000Z");
    expect(profileOf(db, DECK)).toBe(DEFAULT_PROFILE_ID);
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
    // The same profiles, stamped alike, so a later database merge has nothing to settle.
    expect(profileRow(laptop, STUDY_PROFILE)).toEqual(profileRow(phone, STUDY_PROFILE));
    expect(profileOf(laptop, WEST)).toBe(STUDY_PROFILE);
  });

  it("adds the deck key column to a table created before it existed", async () => {
    const db = await mainDb();
    db.run("ALTER TABLE directory_cards DROP COLUMN deck_key");
    ensureDirectoryTables(db);
    expect(rows(db, "SELECT name FROM pragma_table_info('directory_cards') WHERE name = 'deck_key'")).toHaveLength(1);
  });
});
