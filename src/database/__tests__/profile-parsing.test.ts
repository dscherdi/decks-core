import { decksWithChangedParsing, profileParsingKey } from "../profile-parsing";
import { DEFAULT_DECK_PROFILE, type DeckProfile, type DeckWithProfile } from "../types";
import { directoryDeckPath } from "../../services/directory/ids";

const NOW = "2026-10-23T00:00:00.000Z";

function profile(id: string, overrides: Partial<DeckProfile> = {}): DeckProfile {
  return { ...DEFAULT_DECK_PROFILE, id, created: NOW, modified: NOW, ...overrides };
}

function deck(id: string, filepath: string, deckProfile: DeckProfile): DeckWithProfile {
  return {
    id,
    name: id,
    filepath,
    tag: "#decks",
    lastReviewed: null,
    profileId: deckProfile.id,
    created: NOW,
    modified: NOW,
    profile: deckProfile,
  };
}

describe("profile parsing changes", () => {
  it("keys only the settings the parser reads", () => {
    const base = profile("p");
    expect(profileParsingKey({ ...base, newCardsPerDay: 5, name: "Other" })).toBe(profileParsingKey(base));
    expect(profileParsingKey({ ...base, headerLevel: 4 })).not.toBe(profileParsingKey(base));
    expect(profileParsingKey({ ...base, extraHeaderLevels: [3] })).not.toBe(profileParsingKey(base));
    expect(profileParsingKey({ ...base, clozeEnabled: !base.clozeEnabled })).not.toBe(profileParsingKey(base));
    expect(profileParsingKey({ ...base, examEnabled: true })).not.toBe(profileParsingKey(base));
    expect(profileParsingKey({ ...base, headerLevel: 2, extraHeaderLevels: [4, 3] })).toBe(
      profileParsingKey({ ...base, headerLevel: 2, extraHeaderLevels: [3, 4] })
    );
  });

  it("lists the note decks a profile assignment or edit re-parses", () => {
    const h2 = profile("profile_default");
    const h4 = profile("profile_heading_4", { headerLevel: 4 });
    const h2Copy = profile("profile_copy");
    const before = [
      deck("bio", "Biologie/Grundlagen.md", h2),
      deck("same", "Same.md", h2),
      deck("renamed", "Renamed.md", h2),
      deck("package", directoryDeckPath("decksmd/abitur", "grundlagen"), h2),
    ];
    const after = [
      deck("bio", "Biologie/Grundlagen.md", h4),
      deck("same", "Same.md", h2Copy),
      deck("renamed", "Renamed.md", { ...h2, newCardOrder: "note" }),
      deck("package", directoryDeckPath("decksmd/abitur", "grundlagen"), h4),
      deck("new", "New.md", h4),
    ];
    expect(decksWithChangedParsing(before, after).map((d) => d.id)).toEqual(["bio"]);
  });
});
