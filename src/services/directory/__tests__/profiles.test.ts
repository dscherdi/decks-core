import { DEFAULT_DECK_PROFILE, DEFAULT_EXAM_SETTINGS, type DeckProfile } from "../../../database/types";
import type { DpkgDeckEntry } from "../manifest";
import {
  carriedProfiles,
  directoryPackageProfiles,
  directoryProfileId,
  dpkgProfileFrom,
  dpkgProfileKey,
  learnerColumnsFromUpdates,
  nextLearnerSettings,
  packageOwnedChanges,
  packageProfileColumns,
  parseLearnerSettings,
} from "../profiles";
import { isDirectoryTag } from "../ids";
import { packageProfile } from "./helpers";

const author: DeckProfile = {
  ...DEFAULT_DECK_PROFILE,
  id: "profile_spanish",
  name: "Spanish",
  isDefault: false,
  created: "x",
  modified: "x",
};

function deck(key: string, title: string, profile: string | null, exam = false): DpkgDeckEntry {
  return { key, title, cardCount: 1, exam: exam ? DEFAULT_EXAM_SETTINGS : null, profile };
}

describe("package profiles", () => {
  it("carries an author's study settings, with no limit where none was set", () => {
    const carried = dpkgProfileFrom(
      {
        ...author,
        hasNewCardsLimitEnabled: true,
        newCardsPerDay: 12,
        reviewCardsPerDay: 50,
        learningSteps: "nonsense",
        ttsLang: "es-ES",
        ttsVoice: "com.apple.voice.es-ES",
        ttsRate: 40,
      },
      "spanish"
    );
    expect(carried).toEqual({
      key: "spanish",
      newCardsPerDay: 12,
      reviewCardsPerDay: null,
      reviewOrder: "due-date",
      learningSteps: "1m",
      relearningSteps: "10m",
      requestRetention: 0.9,
      clozeShowContext: "hidden",
      ttsLang: "es-ES",
      ttsRate: null,
    });
  });

  it("carries each author profile once, for every deck that studies with it", () => {
    const exams: DeckProfile = { ...author, id: "profile_exams", examEnabled: true, hasNewCardsLimitEnabled: true, newCardsPerDay: 0 };
    const carried = carriedProfiles([
      { key: "words", profile: author },
      { key: "verbs", profile: author },
      { key: "final", profile: exams },
    ]);
    expect(carried.profiles.map((profile) => [profile.key, profile.newCardsPerDay])).toEqual([
      ["profile_spanish", null],
      ["profile_exams", 0],
    ]);
    expect([...carried.byDeck]).toEqual([
      ["words", "profile_spanish"],
      ["verbs", "profile_spanish"],
      ["final", "profile_exams"],
    ]);
  });

  it("tells directory tags from the rest", () => {
    expect([isDirectoryTag("#directory"), isDirectoryTag("#Directory/german-a1/verbs")]).toEqual([true, true]);
    expect([isDirectoryTag("#directoryish"), isDirectoryTag("#decks/directory")]).toEqual([false, false]);
  });

  it("keys an author's profile by its id, hashing one the manifest would refuse", () => {
    expect(dpkgProfileKey("profile_spanish")).toBe("profile_spanish");
    expect(dpkgProfileKey("profile spanish!")).toMatch(/^p[0-9a-z]+$/);
    expect(dpkgProfileKey("profile spanish!")).toBe(dpkgProfileKey("profile spanish!"));
  });

  it("gives decks that share a profile one profile, named after the package and then after a deck", () => {
    const profiles = directoryPackageProfiles({
      publisher: { id: "someone", name: "" },
      slug: "spanish",
      title: "Spanish A1",
      decks: [deck("words", "Words", "steady"), deck("verbs", "Verbs", "steady"), deck("final", "Final exam", "exam", true)],
      profiles: [packageProfile("steady"), packageProfile("exam", { newCardsPerDay: 0 })],
    });
    expect(profiles.map((profile) => [profile.id, profile.name, profile.deckKeys, profile.exam !== null])).toEqual([
      [directoryProfileId("someone/spanish", "steady"), "Spanish A1", ["words", "verbs"], false],
      [directoryProfileId("someone/spanish", "exam"), "Spanish A1 · Final exam", ["final"], true],
    ]);
  });

  it("makes a profile for a package that carries none: one for its study decks, one per exam deck", () => {
    const profiles = directoryPackageProfiles({
      publisher: { id: "someone", name: "" },
      slug: "spanish",
      title: "Spanish A1",
      decks: [deck("words", "Words", null), deck("quiz", "Quiz", null, true), deck("final", "Final", null, true)],
      profiles: [],
    });
    expect(profiles.map((profile) => [profile.key, profile.settings.newCardsPerDay, profile.deckKeys])).toEqual([
      ["preset:study", null, ["words"]],
      ["preset:exam:quiz", 0, ["quiz"]],
      ["preset:exam:final", 0, ["final"]],
    ]);
  });

  it("keeps only a learner's own study settings, and only valid ones", () => {
    expect(
      parseLearnerSettings(
        JSON.stringify({ new_cards_per_day: 10, review_order: "random", fsrs_profile: "TRAINED", exam_enabled: 0, tts_rate: 99, name: "x" })
      )
    ).toEqual({ new_cards_per_day: 10, review_order: "random", fsrs_profile: "TRAINED" });
    expect(parseLearnerSettings("not json")).toEqual({});
  });

  it("keeps what a learner changed and drops what matches the package again", () => {
    const [study] = directoryPackageProfiles({
      publisher: { id: "decksmd", name: "" },
      slug: "spanish",
      title: "Spanish A1",
      decks: [deck("words", "Words", "steady")],
      profiles: [packageProfile("steady", { newCardsPerDay: 20 })],
    });
    const base = packageProfileColumns(study);
    const changed = nextLearnerSettings(base, {}, learnerColumnsFromUpdates({ newCardsPerDay: 10, reviewOrder: "random" }));
    expect(changed).toEqual({ new_cards_per_day: 10, review_order: "random" });
    expect(nextLearnerSettings(base, changed, learnerColumnsFromUpdates({ newCardsPerDay: 20 }))).toEqual({ review_order: "random" });
    // An editor shows an unset speed as the normal one; saving it changes nothing.
    expect(nextLearnerSettings(base, {}, learnerColumnsFromUpdates({ ttsRate: 1 }))).toEqual({});
    expect(learnerColumnsFromUpdates({ ttsVoice: "", fsrs: { requestRetention: 0.85, profile: "TRAINED" } })).toEqual({
      tts_voice: null,
      fsrs_request_retention: 0.85,
      fsrs_profile: "TRAINED",
    });
  });

  it("names the package's own fields an update would change", () => {
    const current = { ...author, examEnabled: true, examSettings: DEFAULT_EXAM_SETTINGS };
    expect(packageOwnedChanges(current, { name: "Spanish", newCardsPerDay: 5 })).toEqual([]);
    const { typedGrading, ...rest } = DEFAULT_EXAM_SETTINGS;
    const reordered = { typedGrading, ...rest };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(DEFAULT_EXAM_SETTINGS));
    expect(packageOwnedChanges(current, { examSettings: reordered })).toEqual([]);
    expect(packageOwnedChanges(current, { name: "Mine", examEnabled: false, headerLevel: 3 })).toEqual([
      "name",
      "headerLevel",
      "examEnabled",
    ]);
  });
});
