import type { Database } from "sql.js";
import { buildMigrationSQL } from "../../../database/schemas";
import { unpackDpkg } from "../archive";
import { importDpkgContent } from "../import";
import {
  directoryDeckProfiles,
  directoryPackageProfileOf,
  ensureDirectoryTables,
  getDirectoryDeck,
  listDirectoryDecks,
  materialiseDirectoryDecks,
  mergeDirectoryTables,
  removeDirectoryDeck,
  UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL,
} from "../DirectoryStore";
import { directoryDeckId, directoryDeckPath, directoryDeckTag } from "../ids";
import type { DirectoryCardContent, DirectoryPackageContent } from "../deck-db";
import { buildPackage, card, mainDb, opener, packageProfile, review, rows, singleDeck, sqlJs, type PackageProfiles } from "./helpers";
import { DEFAULT_EXAM_SETTINGS, DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID } from "../../../database/types";
import { DROP_DIRECTORY_PROFILES_SQL, OWN_PROFILES_WHERE, directoryProfileId } from "../profiles";

const REF = "decksmd/capitals";
const DECK = directoryDeckId(REF);

function v1(): { cards: DirectoryCardContent[] } {
  return {
    cards: [
      card(REF, "card_fr", "France", "Paris"),
      card(REF, "card_de", "Germany", "Berlin"),
      card(REF, "card_it", "Italy", "Rome"),
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
    REF,
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

const WEST = directoryDeckId(REF, "west");
const EAST = directoryDeckId(REF, "east");
// The profiles a package that carries none studies with.
const STUDY_PROFILE = directoryProfileId(REF, "preset:study");
const examPresetProfile = (key: string) => directoryProfileId(REF, `preset:exam:${key}`);
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
    expect(deck).toEqual({ filepath: directoryDeckPath(REF), tag: directoryDeckTag(REF), profile_id: STUDY_PROFILE });
    expect(profileRow(db, STUDY_PROFILE)).toMatchObject({ name: "World capitals", newLimit: 0, examEnabled: 0, deletedAt: null });
    expect(cards(db).map((c) => c.id).sort()).toEqual(v1().cards.map((c) => c.id).sort());
    expect(cards(db).every((c) => c.state === "new" && c.source_file === directoryDeckPath(REF))).toBe(true);
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
      card(REF, "card_es", "Spain", "Madrid"),
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
    const roman = card(REF, "card_roma", "Capital of the Roman Empire", "Rome");
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


  it("studies an exam deck with its own exam profile, carrying the package's exam settings", async () => {
    const exam = {
      cards: [...v1().cards, card(REF, "qcard_gas", "Noble gas?", "- [ ] Oxygen\n- [x] Argon", { type: "multiple-choice" })],
    };
    const settings = { ...DEFAULT_EXAM_SETTINGS, questionCount: 2 };
    const db = await mainDb();
    await install(db, exam, 1, "2026-10-01T10:00:00.000Z", { "": settings });
    expect(profileOf(db, DECK)).toBe(examPresetProfile(""));
    const own = profileRow(db, examPresetProfile(""));
    expect(own).toMatchObject({ examEnabled: 1, newLimit: 1, newPerDay: 0 });
    expect(JSON.parse(String(own.examSettings))).toEqual(settings);
    expect(rows(db, "SELECT type FROM flashcards WHERE deck_id = ? AND front = 'Noble gas?'", [DECK])[0].type).toBe("multiple-choice");
  });


  it("installs a package of several decks as one deck each, filed under the package", async () => {
    const db = await mainDb();
    const [france, germany, italy] = v1().cards;
    const result = await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z");

    expect(result.deckId).toBe(DECK);
    expect(result.sync).toHaveLength(2);
    expect(listDirectoryDecks(db).map((record) => record.id)).toEqual([DECK]);
    expect(rows(db, "SELECT id, name, filepath, tag, file_tags FROM decks ORDER BY filepath")).toEqual([
      { id: EAST, name: "Eastern Europe", filepath: directoryDeckPath(REF, "east"), tag: directoryDeckTag(REF, "east"), file_tags: "[]" },
      { id: WEST, name: "Western Europe", filepath: directoryDeckPath(REF, "west"), tag: directoryDeckTag(REF, "west"), file_tags: '["west"]' },
    ]);
    expect(deckOf(db, france.id).deck_id).toBe(WEST);
    expect(deckOf(db, italy.id).deck_id).toBe(EAST);
    expect(rows(db, "SELECT COUNT(*) AS n FROM flashcards WHERE source_file = ?", [directoryDeckPath(REF, "east")])[0].n).toBe(1);
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

  it("gives each deck its package's profile, and pays no heed to #directory mappings", async () => {
    const [france, germany, italy] = v1().cards;
    const exams = { east: { ...DEFAULT_EXAM_SETTINGS, passScorePct: 80 } };
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", exams);
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([STUDY_PROFILE, examPresetProfile("east")]);

    const other = rows(db, USER_PROFILE_SQL, [DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID])[0].id;
    db.run(`INSERT INTO profile_tag_mappings (id, profile_id, tag, created) VALUES ('m1', ?, ?, 'x')`, [other, directoryDeckTag(REF)]);
    materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z");
    expect([profileOf(db, WEST), profileOf(db, EAST)]).toEqual([STUDY_PROFILE, examPresetProfile("east")]);
  });


  it("names each deck's package profile", async () => {
    const [france, germany, italy] = v1().cards;
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", { east: DEFAULT_EXAM_SETTINGS });
    expect(directoryDeckProfiles(listDirectoryDecks(db))).toEqual(
      new Map([
        [WEST, STUDY_PROFILE],
        [EAST, examPresetProfile("east")],
      ])
    );
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

    const steady = directoryProfileId(REF, "steady");
    const final = directoryProfileId(REF, "final");
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
    expect(profileRow(db, STUDY_PROFILE).name).toBe("World capitals (decksmd)");
    expect(rows(db, "SELECT name FROM deckprofiles WHERE id = 'profile_mine'")[0].name).toBe("World capitals");
  });

  it("keeps its profiles as the package sets them: a change is put back, and a new version applies", async () => {
    const [france, germany, italy] = v1().cards;
    const carried = (westNew: number, eastNew: number): PackageProfiles => ({
      list: [packageProfile("a", { newCardsPerDay: westNew }), packageProfile("b", { newCardsPerDay: eastNew })],
      byDeck: { west: "a", east: "b" },
    });
    const db = await mainDb();
    await install(db, course([france, germany], [italy]), 1, "2026-10-01T10:00:00.000Z", {}, carried(10, 10));
    const [a, b] = [directoryProfileId(REF, "a"), directoryProfileId(REF, "b")];
    db.run("UPDATE deckprofiles SET new_cards_per_day = 3, exam_enabled = 1, modified = '2026-10-02T09:00:00.000Z' WHERE id = ?", [b]);
    expect(materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z").profiles).toEqual([b]);
    expect(profileRow(db, b)).toMatchObject({ newPerDay: 10, examEnabled: 0 });
    expect(materialiseDirectoryDecks(db, "2026-10-02T10:01:00.000Z").profiles).toEqual([]);

    await install(db, course([france, germany], [italy]), 2, "2026-10-03T10:00:00.000Z", {}, carried(25, 30));
    expect([profileRow(db, a).newPerDay, profileRow(db, b).newPerDay]).toEqual([25, 30]);
  });

  it("removes its profiles with it, and has them back while it is installed", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    removeDirectoryDeck(db, DECK, "2026-10-02T10:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).deletedAt).toBe("2026-10-02T10:00:00.000Z");

    await install(db, v1(), 1, "2026-10-03T10:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).deletedAt).toBeNull();

    db.run("UPDATE deckprofiles SET deleted_at = '2026-10-04T10:00:00.000Z' WHERE id = ?", [STUDY_PROFILE]);
    db.run("DELETE FROM deckprofiles WHERE id = ?", [STUDY_PROFILE]);
    materialiseDirectoryDecks(db, "2026-10-04T11:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE)).toMatchObject({ name: "World capitals", deletedAt: null });
    expect(profileOf(db, DECK)).toBe(STUDY_PROFILE);
  });

  it("gives way to a profile of the user's that arrives with the same name", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    // A merge writes rows with INSERT OR REPLACE, which evicts a same-named row.
    db.run("INSERT OR REPLACE INTO deckprofiles (id, name, created, modified) VALUES ('profile_mine', 'World capitals', 'x', 'x')");
    materialiseDirectoryDecks(db, "2026-10-02T10:00:00.000Z");
    expect(profileRow(db, STUDY_PROFILE).name).toBe("World capitals (decksmd)");
    expect(rows(db, "SELECT name FROM deckprofiles WHERE id = 'profile_mine'")[0].name).toBe("World capitals");
    expect(profileOf(db, DECK)).toBe(STUDY_PROFILE);
  });

  it("leaves only the user's own profiles in a copy about to be merged in", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const before = rows(db, "SELECT COUNT(*) AS n FROM deckprofiles WHERE id NOT LIKE 'profile_dir_%'")[0].n;
    db.run(DROP_DIRECTORY_PROFILES_SQL);
    expect(rows(db, "SELECT COUNT(*) AS n FROM deckprofiles WHERE id LIKE 'profile_dir_%'")[0].n).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS n FROM deckprofiles")[0].n).toBe(before);
    expect(rows(db, `SELECT COUNT(*) AS n FROM deckprofiles WHERE ${OWN_PROFILES_WHERE}`)[0].n).toBe(before);
  });

  it("names the package behind a package profile", async () => {
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const owner = directoryPackageProfileOf(listDirectoryDecks(db), STUDY_PROFILE);
    expect([owner?.title, owner?.profile.id]).toEqual(["World capitals", STUDY_PROFILE]);
    expect(directoryPackageProfileOf(listDirectoryDecks(db), DEFAULT_PROFILE_ID)).toBeNull();
  });

  it("lays the learner's own settings over the package profile; the rest follows a new version", async () => {
    const carried = (newPerDay: number, order: "due-date" | "random"): PackageProfiles => ({
      list: [packageProfile("p", { newCardsPerDay: newPerDay, reviewOrder: order })],
      byDeck: { "": "p" },
    });
    const own = directoryProfileId(REF, "p");
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z", {}, carried(10, "due-date"));
    db.run(UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL, [own, JSON.stringify({ new_cards_per_day: 5 }), "2026-10-02T10:00:00.000Z"]);
    expect(materialiseDirectoryDecks(db, "2026-10-02T10:01:00.000Z").profiles).toEqual([own]);
    expect(profileRow(db, own)).toMatchObject({ newPerDay: 5, reviewOrder: "due-date" });

    await install(db, v1(), 2, "2026-10-03T10:00:00.000Z", {}, carried(25, "random"));
    expect(profileRow(db, own)).toMatchObject({ newPerDay: 5, reviewOrder: "random" });

    db.run(UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL, [own, "{}", "2026-10-04T10:00:00.000Z"]);
    materialiseDirectoryDecks(db, "2026-10-04T10:01:00.000Z");
    expect(profileRow(db, own)).toMatchObject({ newPerDay: 25, reviewOrder: "random" });
  });

  it("takes the learner's newer settings from another copy, and keeps its own when they are newer", async () => {
    const SQL = await sqlJs();
    const phone = await mainDb();
    const laptop = await mainDb();
    await install(phone, v1(), 1, "2026-10-01T10:00:00.000Z");
    await install(laptop, v1(), 1, "2026-10-01T10:00:00.000Z");
    phone.run(UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL, [STUDY_PROFILE, JSON.stringify({ new_cards_per_day: 7 }), "2026-10-02T10:00:00.000Z"]);
    laptop.run(UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL, [STUDY_PROFILE, JSON.stringify({ new_cards_per_day: 3 }), "2026-10-03T10:00:00.000Z"]);

    mergeDirectoryTables(laptop, new SQL.Database(phone.export()));
    materialiseDirectoryDecks(laptop, "2026-10-04T10:00:00.000Z");
    expect(profileRow(laptop, STUDY_PROFILE).newPerDay).toBe(3);

    mergeDirectoryTables(phone, new SQL.Database(laptop.export()));
    materialiseDirectoryDecks(phone, "2026-10-04T10:00:00.000Z");
    expect(profileRow(phone, STUDY_PROFILE).newPerDay).toBe(3);
  });

  it("keeps two publishers' packages of the same slug apart", async () => {
    const theirs = "someone/capitals";
    const db = await mainDb();
    await install(db, v1(), 1, "2026-10-01T10:00:00.000Z");
    const pkg = await buildPackage(theirs, 1, singleDeck("Their capitals", [card(theirs, "card_fr", "France", "Paris")]), [], {}, "Their capitals");
    importDpkgContent(db, await unpackDpkg(pkg, { includeMedia: false }), "sha-theirs", await opener(), "2026-10-02T10:00:00.000Z");

    expect(listDirectoryDecks(db).map((record) => [record.publisher, record.slug]).sort()).toEqual([
      ["decksmd", "capitals"],
      ["someone", "capitals"],
    ]);
    expect(cards(db)).toHaveLength(3);
    expect(rows(db, "SELECT COUNT(*) AS n FROM flashcards WHERE deck_id = ?", [directoryDeckId(theirs)])[0].n).toBe(1);
    expect(directoryDeckTag(theirs)).toBe("#directory/someone/capitals");
  });

  it("clears installs made before publishers were part of a package's identity", async () => {
    const db = await mainDb();
    db.run("DROP TABLE directory_decks");
    db.run(
      `CREATE TABLE directory_decks (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '', manifest TEXT NOT NULL, archive_sha256 TEXT NOT NULL, file_tags TEXT,
         imported_at TEXT NOT NULL, modified TEXT NOT NULL, removed_at TEXT)`
    );
    db.run("INSERT INTO directory_decks VALUES ('deck_dir_old', 'capitals', 1, 'Old', '', '{}', 'sha', NULL, 'x', 'x', NULL)");
    db.run(
      "INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES ('deck_dir_old', 'Old', 'decks-directory:capitals', '#directory/capitals', 'profile_default', 'x', 'x')"
    );
    ensureDirectoryTables(db);
    expect(rows(db, "SELECT COUNT(*) AS n FROM decks WHERE filepath LIKE 'decks-directory:%'")[0].n).toBe(0);
    expect(rows(db, "SELECT name FROM pragma_table_info('directory_decks') WHERE name = 'publisher'")).toHaveLength(1);
    expect(listDirectoryDecks(db)).toEqual([]);
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
