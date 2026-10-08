import {
  ancestorTags,
  flatTagsFor,
  isUnderTag,
  matchesIgnore,
  normalizeTag,
  parseIgnoredTags,
  pickDeckTag,
  pickProfileMapping,
  studyTagsFor,
  tagScopeFromSettings,
} from "../deck-tags";
import type { ProfileTagMapping } from "../../database/types";

const scope = { baseTag: "#decks" };

function mapping(profileId: string, tag: string): ProfileTagMapping {
  return { id: `m_${tag}`, profileId, tag, created: "2026-01-01T00:00:00.000Z" };
}

describe("normalizeTag", () => {
  it("adds the hash, lowercases, and trims a trailing slash", () => {
    expect(normalizeTag("Math")).toBe("#math");
    expect(normalizeTag("#Math/Algebra")).toBe("#math/algebra");
    expect(normalizeTag("  #math/  ")).toBe("#math");
  });
});

describe("ancestorTags", () => {
  it("walks every level of a nested tag", () => {
    expect(ancestorTags("#a/b/c")).toEqual(["#a", "#a/b", "#a/b/c"]);
  });

  it("returns a single entry for a flat tag", () => {
    expect(ancestorTags("#math")).toEqual(["#math"]);
  });

  it("returns nothing for an empty tag", () => {
    expect(ancestorTags("#")).toEqual([]);
  });
});

describe("isUnderTag", () => {
  it("matches a tag and its descendants", () => {
    expect(isUnderTag("#decks", "#decks")).toBe(true);
    expect(isUnderTag("#decks/math", "#decks")).toBe(true);
  });

  it("requires a path boundary, so a shared prefix is not a match", () => {
    expect(isUnderTag("#decksforever", "#decks")).toBe(false);
  });

  it("does not match upwards", () => {
    expect(isUnderTag("#decks", "#decks/math")).toBe(false);
  });
});

describe("matchesIgnore", () => {
  it("hides the tag and everything beneath it", () => {
    expect(matchesIgnore("#status", ["#status"])).toBe(true);
    expect(matchesIgnore("#status/todo", ["status"])).toBe(true);
  });

  it("accepts a trailing wildcard as the same thing", () => {
    expect(matchesIgnore("#status/todo", ["status/*"])).toBe(true);
  });

  it("leaves unrelated tags alone", () => {
    expect(matchesIgnore("#statusboard", ["status"])).toBe(false);
    expect(matchesIgnore("#math", [])).toBe(false);
  });
});

describe("pickDeckTag", () => {
  it("takes the deepest tag under the base", () => {
    expect(pickDeckTag(["decks", "decks/spanish", "math"], "#decks")).toBe("#decks/spanish");
  });

  it("breaks ties lexically so two devices agree", () => {
    expect(pickDeckTag(["decks/zoo", "decks/art"], "#decks")).toBe("#decks/art");
  });

  it("returns null when nothing sits under the base tag", () => {
    expect(pickDeckTag(["math", "retry"], "#decks")).toBeNull();
  });
});

describe("flatTagsFor", () => {
  it("keeps the note's other tags and drops the ones under the base tag", () => {
    const deck = { fileTags: ["decks/spanish", "Math", "#retry"] };
    expect(flatTagsFor(deck, scope)).toEqual(["#math", "#retry"]);
  });

  it("never lets a note join the tags of installed packages", () => {
    const deck = { fileTags: ["directory/decksmd/german-a1", "Directory", "directoryish"] };
    expect(flatTagsFor(deck, scope)).toEqual(["#directoryish"]);
  });

  it("drops ignored tags and everything beneath them", () => {
    const deck = { fileTags: ["math", "status/todo", "status"] };
    expect(flatTagsFor(deck, { baseTag: "#decks", ignore: ["#status"] })).toEqual(["#math"]);
  });

  it("is empty when the note has no frontmatter tags", () => {
    expect(flatTagsFor({ fileTags: undefined }, scope)).toEqual([]);
  });
});

describe("studyTagsFor", () => {
  it("puts the deck tag first, then the flat tags", () => {
    const deck = { tag: "#decks/spanish", fileTags: ["decks/spanish", "math", "retry"] };
    expect(studyTagsFor(deck, scope)).toEqual(["#decks/spanish", "#math", "#retry"]);
  });

  it("does not repeat a tag that appears in both places", () => {
    const deck = { tag: "#math", fileTags: ["math"] };
    expect(studyTagsFor(deck, scope)).toEqual(["#math"]);
  });
});

describe("pickProfileMapping", () => {
  const mappings = [
    mapping("p_decks", "#decks"),
    mapping("p_spanish", "#decks/spanish"),
    mapping("p_math", "#math"),
  ];

  it("prefers the deck tag over any flat tag", () => {
    expect(pickProfileMapping(mappings, ["#decks/spanish", "#math"])).toBe("p_spanish");
  });

  it("falls back to a flat tag when the deck tag has no mapping", () => {
    expect(pickProfileMapping(mappings, ["#other/deck", "#math"])).toBe("p_math");
  });

  it("takes the most specific mapping within one tag", () => {
    expect(pickProfileMapping(mappings, ["#decks/spanish/verbs"])).toBe("p_spanish");
  });

  it("inherits from an ancestor mapping", () => {
    expect(pickProfileMapping(mappings, ["#decks/french"])).toBe("p_decks");
  });

  it("returns null when nothing matches", () => {
    expect(pickProfileMapping(mappings, ["#unmapped"])).toBeNull();
    expect(pickProfileMapping([], ["#decks"])).toBeNull();
  });

  it("breaks equal-length mappings lexically so devices agree", () => {
    const ties = [mapping("p_b", "#bbb"), mapping("p_a", "#aaa")];
    expect(pickProfileMapping(ties, ["#aaa"])).toBe("p_a");
  });
});

describe("parseIgnoredTags", () => {
  it("reads commas and newlines, normalising and deduping", () => {
    expect(parseIgnoredTags("status, #Daily\nstatus")).toEqual(["#status", "#daily"]);
  });

  it("drops a trailing wildcard and empty entries", () => {
    expect(parseIgnoredTags("status/*, ,")).toEqual(["#status"]);
  });

  it("accepts an array as stored in settings", () => {
    expect(parseIgnoredTags(["#status"])).toEqual(["#status"]);
    expect(parseIgnoredTags(undefined)).toEqual([]);
  });
});

describe("tagScopeFromSettings", () => {
  it("falls back to the default base tag", () => {
    expect(tagScopeFromSettings(undefined)).toEqual({ baseTag: "#decks", ignore: [] });
  });

  it("reads the configured tag and ignore list", () => {
    expect(tagScopeFromSettings({ deckTag: "#flashcards", ignoredTags: ["Status"] })).toEqual({
      baseTag: "#flashcards",
      ignore: ["#status"],
    });
  });
});
