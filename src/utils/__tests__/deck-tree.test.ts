import {
  buildDeckTree,
  filterDeckTree,
  sortDeckTree,
  flattenDeckTree,
  allBranchIds,
  type DeckTree,
  type TreeNode,
  type BuildDeckTreeInput,
} from "../deck-tree";
import { generateDeckGroupId } from "../hash";
import type {
  DeckProfile,
  FileDeck,
  DeckGroup,
  CustomDeckGroup,
} from "../../database/types";

// --- fixtures ---------------------------------------------------------------

function profile(over: Partial<DeckProfile> = {}): DeckProfile {
  return {
    id: "p",
    name: "p",
    hasNewCardsLimitEnabled: false,
    newCardsPerDay: 20,
    hasReviewCardsLimitEnabled: false,
    reviewCardsPerDay: 100,
    headerLevel: 2,
    reviewOrder: "due-date",
    learningSteps: "1m",
    relearningSteps: "10m",
    fsrs: { requestRetention: 0.9, profile: "STANDARD" },
    clozeEnabled: true,
    clozeShowContext: "hidden",
    isDefault: false,
    created: "",
    modified: "",
    ...over,
  };
}

function fileDeck(id: string, name: string, filepath: string, prof = profile()): FileDeck {
  return {
    type: "file",
    id,
    name,
    filepath,
    tag: "#decks",
    lastReviewed: null,
    profileId: prof.id,
    created: "",
    modified: "",
    profile: prof,
  };
}

function group(tag: string, deckIds: string[], prof = profile()): DeckGroup {
  return {
    type: "group",
    tag,
    name: tag.replace(/^#/, "").split("/").pop() ?? tag,
    deckIds,
    profile: prof,
    lastReviewed: null,
    created: "",
    modified: "",
  };
}

function custom(id: string, name: string, deckType: "manual" | "filter" = "manual"): CustomDeckGroup {
  return {
    type: "custom",
    id,
    name,
    deckType,
    filterDefinition: null,
    flashcardIds: [],
    lastReviewed: null,
    created: "",
    modified: "",
  };
}

type Stats = { newCount: number; dueCount: number; totalCount: number };

function statsGetter(map: Record<string, Stats>): (id: string) => Stats | undefined {
  return (id) => map[id];
}

function build(over: Partial<BuildDeckTreeInput> = {}): DeckTree {
  return buildDeckTree({
    fileDecks: [],
    deckGroups: [],
    customDeckGroups: [],
    getStats: () => undefined,
    pinnedIds: new Set<string>(),
    minDeckCardCount: 0,
    ...over,
  });
}

function findNode(tree: DeckTree, id: string): TreeNode | undefined {
  const stack = [tree.pinned, ...tree.sections];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return undefined;
}

// --- Files subtree ----------------------------------------------------------

describe("buildDeckTree — Files", () => {
  const fileDecks = [
    fileDeck("fa", "1.Book 01", "German/Books/Book 1/1.Book 01.md"),
    fileDeck("fb", "1.Book 02", "German/Books/Book 1/1.Book 02.md"),
    fileDeck("fc", "1200 Redewendungen", "German/1200 Redewendungen.md"),
    fileDeck("fd", "Concepts", "Concepts.md"),
  ];
  const stats = statsGetter({
    fa: { newCount: 5, dueCount: 1, totalCount: 10 },
    fb: { newCount: 20, dueCount: 0, totalCount: 20 },
    fc: { newCount: 20, dueCount: 3, totalCount: 20 },
    fd: { newCount: 11, dueCount: 0, totalCount: 11 },
  });

  it("nests decks by vault folder path and attaches root decks to the section", () => {
    const tree = build({ fileDecks, getStats: stats });
    const files = tree.sections[0];
    expect(files.id).toBe("sec:files");
    // German folder + Concepts leaf directly under Files
    expect(files.children.map((c) => c.id).sort()).toEqual(["dir:German", "fd"]);
    const book1 = findNode(tree, "dir:German/Books/Book 1")!;
    expect(book1.kind).toBe("folder");
    expect(book1.name).toBe("Book 1");
    expect(book1.children.map((c) => c.id).sort()).toEqual(["fa", "fb"]);
    expect(findNode(tree, "fa")!.depth).toBe(4); // Files(0)>German(1)>Books(2)>Book 1(3)>leaf(4)
    expect(findNode(tree, "fd")!.depth).toBe(1);
  });

  it("rolls up New/Due counts from descendant leaves", () => {
    const tree = build({ fileDecks, getStats: stats });
    expect(findNode(tree, "dir:German/Books/Book 1")).toMatchObject({ newCount: 25, dueCount: 1 });
    expect(findNode(tree, "dir:German")).toMatchObject({ newCount: 45, dueCount: 4 });
    expect(tree.sections[0]).toMatchObject({ newCount: 56, dueCount: 4 });
  });

  it("collects descendant deck ids on branch nodes (for subtree study)", () => {
    const tree = build({ fileDecks, getStats: stats });
    expect([...findNode(tree, "dir:German")!.deckIds].sort()).toEqual(["fa", "fb", "fc"]);
  });

  it("rolls up the new-card-limit flag", () => {
    const limited = fileDeck("fa", "1.Book 01", "German/Books/Book 1/1.Book 01.md", profile({ hasNewCardsLimitEnabled: true }));
    const tree = build({ fileDecks: [limited, fileDecks[1]], getStats: stats });
    expect(findNode(tree, "fa")!.hasLimit).toBe(true);
    expect(findNode(tree, "dir:German")!.hasLimit).toBe(true);
    expect(findNode(tree, "fb")!.hasLimit).toBe(false);
  });
});

// --- Tags subtree -----------------------------------------------------------

describe("buildDeckTree — Tags", () => {
  const groups = [
    group("#a", ["x", "y", "z"]),
    group("#a/b/c", ["x"]),
    group("#a/b/d", ["y"]),
    group("#flat", ["q"]),
  ];
  const stats = statsGetter({
    [generateDeckGroupId("#a")]: { newCount: 10, dueCount: 2, totalCount: 30 },
    [generateDeckGroupId("#a/b/c")]: { newCount: 3, dueCount: 0, totalCount: 3 },
    [generateDeckGroupId("#a/b/d")]: { newCount: 4, dueCount: 1, totalCount: 4 },
    [generateDeckGroupId("#flat")]: { newCount: 8, dueCount: 0, totalCount: 8 },
  });

  it("nests by tag path; backed nodes use their own group stats, virtual folders sum children", () => {
    const tree = build({ deckGroups: groups, getStats: stats });
    const a = findNode(tree, "tag:a")!;
    expect(a.kind).toBe("folder");
    expect(a.group?.tag).toBe("#a");
    // backed node keeps the group's own (deep-aggregated) stats, not the child sum (7)
    expect(a).toMatchObject({ newCount: 10, dueCount: 2 });
    expect([...a.deckIds].sort()).toEqual(["x", "y", "z"]);

    const b = findNode(tree, "tag:a/b")!;
    expect(b.group).toBeUndefined(); // virtual — no #a/b group
    expect(b).toMatchObject({ newCount: 7, dueCount: 1 });
    expect([...b.deckIds].sort()).toEqual(["x", "y"]);

    const c = findNode(tree, "tag:a/b/c")!;
    expect(c.kind).toBe("leaf");
    expect(c.name).toBe("c");
    expect(findNode(tree, "tag:flat")!.kind).toBe("leaf");
  });
});

// --- Flat view --------------------------------------------------------------

describe("buildDeckTree — flat view", () => {
  it("lists file decks directly under the Files section, no folders", () => {
    const fileDecks = [
      fileDeck("fa", "A", "German/Books/A.md"),
      fileDeck("fb", "B", "German/B.md"),
    ];
    const stats = statsGetter({
      fa: { newCount: 3, dueCount: 0, totalCount: 3 },
      fb: { newCount: 4, dueCount: 1, totalCount: 4 },
    });
    const tree = build({ fileDecks, getStats: stats, flat: true });
    expect(findNode(tree, "dir:German")).toBeUndefined();
    expect(tree.sections[0].children.map((c) => c.id).sort()).toEqual(["fa", "fb"]);
    expect(tree.sections[0].children.every((c) => c.kind === "leaf")).toBe(true);
  });

  it("lists every tag group flat and totals the section by unique decks (no double count)", () => {
    const groups = [
      group("#a", ["x", "y", "z"]),
      group("#a/b/c", ["x"]),
      group("#a/b/d", ["y"]),
    ];
    const stats = statsGetter({
      // per-file-deck stats (used for the section total)
      x: { newCount: 3, dueCount: 0, totalCount: 3 },
      y: { newCount: 4, dueCount: 1, totalCount: 4 },
      z: { newCount: 5, dueCount: 0, totalCount: 5 },
      // per-group stats (used for each flat row)
      [generateDeckGroupId("#a")]: { newCount: 10, dueCount: 2, totalCount: 30 },
      [generateDeckGroupId("#a/b/c")]: { newCount: 3, dueCount: 0, totalCount: 3 },
      [generateDeckGroupId("#a/b/d")]: { newCount: 4, dueCount: 1, totalCount: 4 },
    });
    const tree = build({ deckGroups: groups, getStats: stats, flat: true });
    const tags = tree.sections[1];
    expect(tags.children.map((c) => c.id)).toEqual(["tag:a", "tag:a/b/c", "tag:a/b/d"]);
    expect(tags.children.every((c) => c.kind === "leaf")).toBe(true);
    // no virtual folder nodes in flat view
    expect(findNode(tree, "tag:a/b")).toBeUndefined();
    // section total = unique decks {x,y,z} = 3+4+5, not the inflated group sum (10+3+4)
    expect(tags).toMatchObject({ newCount: 12, dueCount: 1 });
    // each flat row still shows its own group stat
    expect(findNode(tree, "tag:a")).toMatchObject({ newCount: 10, dueCount: 2 });
  });
});

// --- Custom + pinned + min-count -------------------------------------------

describe("buildDeckTree — Custom, pinned, min-count", () => {
  it("lists custom decks flat with card totals available", () => {
    const tree = build({
      customDeckGroups: [custom("c1", "Big"), custom("c2", "Filter", "filter")],
      getStats: statsGetter({
        c1: { newCount: 0, dueCount: 0, totalCount: 3871 },
        c2: { newCount: 0, dueCount: 0, totalCount: 0 },
      }),
    });
    const customSection = tree.sections[2];
    expect(customSection.children.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(customSection.children[0].customDeck?.name).toBe("Big");
  });

  it("lifts pinned leaves into the top block but keeps their counts in the folder", () => {
    const fileDecks = [
      fileDeck("fa", "Book 01", "German/Book 01.md"),
      fileDeck("fb", "Book 02", "German/Book 02.md"),
    ];
    const stats = statsGetter({
      fa: { newCount: 5, dueCount: 0, totalCount: 5 },
      fb: { newCount: 20, dueCount: 1, totalCount: 20 },
    });
    const tree = build({ fileDecks, getStats: stats, pinnedIds: new Set(["fb"]) });

    // pinned block holds fb, at depth 1, and is not duplicated in German
    expect(tree.pinned.children.map((c) => c.id)).toEqual(["fb"]);
    expect(tree.pinned.children[0].depth).toBe(1);
    expect(tree.pinned).toMatchObject({ newCount: 20, dueCount: 1 });
    const german = findNode(tree, "dir:German")!;
    expect(german.children.map((c) => c.id)).toEqual(["fa"]);
    // folder count still includes the pinned deck
    expect(german).toMatchObject({ newCount: 25, dueCount: 1 });
  });

  it("hides file/custom leaves below the min-count threshold (pinned exempt) and prunes empty folders", () => {
    const fileDecks = [
      fileDeck("fa", "Tiny", "German/Tiny.md"),
      fileDeck("fb", "Big", "German/Big.md"),
      fileDeck("fc", "PinnedTiny", "Solo/PinnedTiny.md"),
    ];
    const stats = statsGetter({
      fa: { newCount: 1, dueCount: 0, totalCount: 3 },
      fb: { newCount: 1, dueCount: 0, totalCount: 50 },
      fc: { newCount: 1, dueCount: 0, totalCount: 2 },
    });
    const tree = build({ fileDecks, getStats: stats, minDeckCardCount: 15, pinnedIds: new Set(["fc"]) });
    // fa dropped (tiny, unpinned); fb kept; fc kept (pinned) → but fc is pinned so it moves to top block
    expect(findNode(tree, "fa")).toBeUndefined();
    expect(findNode(tree, "fb")).toBeDefined();
    expect(tree.pinned.children.map((c) => c.id)).toEqual(["fc"]);
    // Solo folder had only the pinned leaf → pruned once that leaf is lifted to the top block
    expect(findNode(tree, "dir:Solo")).toBeUndefined();
    // German folder retains fb
    expect(findNode(tree, "dir:German")!.children.map((c) => c.id)).toEqual(["fb"]);
  });

  it("prunes a folder whose only descendant is pinned, keeping the deck in the pinned block", () => {
    const fileDecks = [fileDeck("fa", "Only", "Solo/Only.md")];
    const stats = statsGetter({ fa: { newCount: 4, dueCount: 1, totalCount: 4 } });
    const tree = build({ fileDecks, getStats: stats, pinnedIds: new Set(["fa"]) });
    expect(findNode(tree, "dir:Solo")).toBeUndefined();
    expect(tree.pinned.children.map((c) => c.id)).toEqual(["fa"]);
  });
});

// --- filter / sort / flatten -----------------------------------------------

describe("filterDeckTree", () => {
  const fileDecks = [
    fileDeck("fa", "1.Book 01", "German/Books/1.Book 01.md"),
    fileDeck("fd", "Concepts", "Concepts.md"),
  ];
  const stats = statsGetter({
    fa: { newCount: 1, dueCount: 0, totalCount: 1 },
    fd: { newCount: 1, dueCount: 0, totalCount: 1 },
  });

  it("keeps matching leaves and their ancestor chain, drops the rest", () => {
    const tree = filterDeckTree(build({ fileDecks, getStats: stats }), "book 01");
    expect(findNode(tree, "fa")).toBeDefined();
    expect(findNode(tree, "dir:German/Books")).toBeDefined();
    expect(findNode(tree, "fd")).toBeUndefined();
  });

  it("matches on the backing tag as well as the name", () => {
    const tree = filterDeckTree(build({ deckGroups: [group("#deutsch/verben", ["v"])], getStats: () => undefined }), "deutsch");
    expect(findNode(tree, "tag:deutsch/verben")).toBeDefined();
  });
});

describe("sortDeckTree", () => {
  const fileDecks = [
    fileDeck("fa", "Alpha", "German/Alpha.md"),
    fileDeck("fb", "Zeta", "German/Zeta.md"),
  ];
  const stats = statsGetter({
    fa: { newCount: 5, dueCount: 0, totalCount: 5 },
    fb: { newCount: 1, dueCount: 0, totalCount: 1 },
  });

  it("sorts children within a folder without reordering the sections", () => {
    const base = build({ fileDecks, getStats: stats });
    const asc = sortDeckTree(base, "name-asc");
    expect(findNode(asc, "dir:German")!.children.map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
    const desc = sortDeckTree(base, "name-desc");
    expect(findNode(desc, "dir:German")!.children.map((c) => c.name)).toEqual(["Zeta", "Alpha"]);
    expect(desc.sections.map((s) => s.id)).toEqual(["sec:files", "sec:tags", "sec:custom"]);
  });

  it("sorts by rolled-up new count", () => {
    const byNew = sortDeckTree(build({ fileDecks, getStats: stats }), "new-desc");
    expect(findNode(byNew, "dir:German")!.children.map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("flattenDeckTree & allBranchIds", () => {
  const fileDecks = [fileDeck("fa", "Book 01", "German/Book 01.md")];
  const stats = statsGetter({ fa: { newCount: 1, dueCount: 0, totalCount: 1 } });

  it("skips a collapsed branch's children but keeps the branch row", () => {
    const tree = build({ fileDecks, getStats: stats });
    const collapsed = flattenDeckTree(tree, new Set(["sec:files"]));
    const ids = collapsed.map((r) => r.node.id);
    expect(ids).toContain("sec:files");
    expect(ids).not.toContain("dir:German");
    expect(collapsed.find((r) => r.node.id === "sec:files")!.expanded).toBe(false);
  });

  it("expands every branch with an empty collapsed set", () => {
    const tree = build({ fileDecks, getStats: stats });
    const ids = flattenDeckTree(tree, new Set()).map((r) => r.node.id);
    expect(ids).toContain("dir:German");
    expect(ids).toContain("fa");
  });

  it("emits the pinned block first only when it has children", () => {
    const noPins = build({ fileDecks, getStats: stats });
    expect(flattenDeckTree(noPins, new Set())[0].node.id).toBe("sec:files");
    const withPins = build({ fileDecks, getStats: stats, pinnedIds: new Set(["fa"]) });
    expect(flattenDeckTree(withPins, new Set())[0].node.id).toBe("sec:pinned");
  });

  it("lists every branch id for collapse-all", () => {
    const tree = build({ fileDecks, getStats: stats });
    expect(allBranchIds(tree)).toEqual(expect.arrayContaining(["sec:files", "dir:German", "sec:tags", "sec:custom"]));
    expect(allBranchIds(tree)).not.toContain("fa");
  });
});
