import {
  buildDeckTree,
  filterDeckTree,
  sortDeckTree,
  flattenDeckTree,
  allBranchIds,
  directoryPackageRefOfNode,
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

  it("gives a flat tag its own root, alongside the deck-tag subtree", () => {
    const tree = build({ deckGroups: groups, getStats: stats });
    const tags = tree.sections.find((s) => s.section === "tags")!;
    expect(tags.children.map((c) => c.id).sort()).toEqual(["tag:a", "tag:flat"]);
  });

  it("totals the section over unique decks when a deck sits in several tags", () => {
    // One deck reachable by its deck tag and by two flat tags.
    const overlapping = [group("#decks/spanish", ["x"]), group("#math", ["x"]), group("#retry", ["x"])];
    const overlapStats = statsGetter({
      x: { newCount: 5, dueCount: 2, totalCount: 9 },
      [generateDeckGroupId("#decks/spanish")]: { newCount: 5, dueCount: 2, totalCount: 9 },
      [generateDeckGroupId("#math")]: { newCount: 5, dueCount: 2, totalCount: 9 },
      [generateDeckGroupId("#retry")]: { newCount: 5, dueCount: 2, totalCount: 9 },
    });
    const tree = build({ deckGroups: overlapping, getStats: overlapStats });
    const tags = tree.sections.find((s) => s.section === "tags")!;
    expect([...tags.deckIds]).toEqual(["x"]);
    // Counted once, not once per tag it appears under.
    expect(tags).toMatchObject({ newCount: 5, dueCount: 2 });
  });

  it("hides tag groups below the min-card floor but keeps pinned ones", () => {
    const tree = build({
      deckGroups: groups,
      getStats: stats,
      minDeckCardCount: 5,
    });
    // #flat has 8 cards and stays; #a/b/c has 3 and goes.
    expect(findNode(tree, "tag:flat")).toBeDefined();
    expect(findNode(tree, "tag:a/b/c")).toBeUndefined();

    const pinned = build({
      deckGroups: groups,
      getStats: stats,
      minDeckCardCount: 5,
      pinnedIds: new Set([generateDeckGroupId("#a/b/c")]),
    });
    expect(findNode(pinned, "tag:a/b/c")).toBeDefined();
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

  it("totals a branch kept for its matches from those matches alone", () => {
    const decks = [
      fileDeck("es", "Spanish", "Languages/Spanish.md"),
      fileDeck("fr", "French", "Languages/French.md"),
      fileDeck("bio", "Biology", "Science/Biology.md"),
    ];
    const counts = statsGetter({
      es: { newCount: 2, dueCount: 4, totalCount: 6 },
      fr: { newCount: 2, dueCount: 3, totalCount: 5 },
      bio: { newCount: 1, dueCount: 3, totalCount: 4 },
    });
    const tree = filterDeckTree(build({ fileDecks: decks, getStats: counts }), "span");
    const files = tree.sections[0];
    expect([files.newCount, files.dueCount]).toEqual([2, 4]);
    expect(files.deckIds).toEqual(["es"]);
    const languages = findNode(tree, "dir:Languages")!;
    expect([languages.newCount, languages.dueCount]).toEqual([2, 4]);
    expect(tree.sections[1].newCount + tree.sections[1].dueCount).toBe(0);
  });

  it("counts a deck once when overlapping tag groups both match", () => {
    const decks = [fileDeck("de", "German", "German.md")];
    const counts = statsGetter({
      de: { newCount: 3, dueCount: 1, totalCount: 4 },
      [generateDeckGroupId("#lang/german")]: { newCount: 3, dueCount: 1, totalCount: 4 },
      [generateDeckGroupId("#german")]: { newCount: 3, dueCount: 1, totalCount: 4 },
    });
    const tree = filterDeckTree(
      build({
        fileDecks: decks,
        deckGroups: [group("#lang/german", ["de"]), group("#german", ["de"])],
        getStats: counts,
        flat: true,
      }),
      "german"
    );
    expect([tree.sections[1].newCount, tree.sections[1].dueCount]).toEqual([3, 1]);
  });

  it("keeps a branch's own totals when its own name matches", () => {
    const decks = [fileDeck("es", "Spanish", "Languages/Spanish.md"), fileDeck("fr", "French", "Languages/French.md")];
    const counts = statsGetter({
      es: { newCount: 2, dueCount: 4, totalCount: 6 },
      fr: { newCount: 2, dueCount: 3, totalCount: 5 },
    });
    const languages = findNode(filterDeckTree(build({ fileDecks: decks, getStats: counts }), "languages"), "dir:Languages")!;
    expect([languages.newCount, languages.dueCount]).toEqual([4, 7]);
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

// --- Deck directory -----------------------------------------------------------

describe("buildDeckTree — Deck directory", () => {
  const installed = fileDeck("deck_dir_x", "World capitals", "decks-directory:decksmd/capitals");
  installed.tag = "#directory/decksmd/capitals";

  it("lists installed decks in their own section, never under Files", () => {
    const tree = build({ fileDecks: [fileDeck("fa", "Own", "Notes/Own.md"), installed] });
    const section = tree.sections.find((s) => s.section === "directory");
    expect(section?.children.map((c) => c.id)).toEqual(["deck_dir_x"]);
    const files = tree.sections.find((s) => s.section === "files");
    expect(findNode({ pinned: tree.pinned, sections: files ? [files] : [] }, "deck_dir_x")).toBeUndefined();
  });

  it("has no section until a deck is installed", () => {
    const tree = build({ fileDecks: [fileDeck("fa", "Own", "Notes/Own.md")] });
    expect(tree.sections.map((s) => s.section)).toEqual(["files", "tags", "custom"]);
  });

  it("is not hidden by the minimum card count", () => {
    const tree = build({ fileDecks: [installed], minDeckCardCount: 50, getStats: () => ({ newCount: 1, dueCount: 0, totalCount: 3 }) });
    expect(findNode(tree, "deck_dir_x")).toBeDefined();
  });

  it("files the decks of a package in a folder named after it, studied together or one by one", () => {
    const vocabulary = fileDeck("deck_dir_v", "Vocabulary", "decks-directory:decksmd/german-a1/vocabulary");
    const grammar = fileDeck("deck_dir_g", "Grammar", "decks-directory:decksmd/german-a1/grammar");
    // Another publisher's package of the same name is a separate folder.
    const theirs = fileDeck("deck_dir_t", "Vocabulary", "decks-directory:someone/german-a1/vocabulary");
    const directoryTitles = new Map([
      ["decksmd/german-a1", "German A1"],
      ["someone/german-a1", "German A1"],
    ]);
    const tree = build({ fileDecks: [installed, vocabulary, grammar, theirs], directoryTitles });
    const section = tree.sections.find((s) => s.section === "directory");
    const folder = section?.children.find((c) => c.kind === "folder");
    expect(folder).toMatchObject({ id: "pkg:decksmd/german-a1", name: "German A1", depth: 1 });
    expect(folder && directoryPackageRefOfNode(folder)).toBe("decksmd/german-a1");
    expect(section?.children.filter((c) => c.kind === "folder").map((c) => c.id)).toEqual([
      "pkg:decksmd/german-a1",
      "pkg:someone/german-a1",
    ]);
    expect(folder?.children.map((c) => [c.id, c.depth])).toEqual([["deck_dir_v", 2], ["deck_dir_g", 2]]);
    expect(folder?.deckIds.sort()).toEqual(["deck_dir_g", "deck_dir_v"]);
    expect(section?.children.find((c) => c.id === "deck_dir_x")?.kind).toBe("leaf");
    expect(directoryPackageRefOfNode({ id: "dir:German", kind: "folder" })).toBeNull();

    const flat = build({ fileDecks: [vocabulary], directoryTitles, flat: true });
    expect(flat.sections.find((s) => s.section === "directory")?.children[0]).toMatchObject({
      id: "deck_dir_v",
      name: "German A1 › Vocabulary",
    });
  });
});
