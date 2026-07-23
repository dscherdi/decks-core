import type { DeckListSortMode } from "../settings";
import type { FileDeck, DeckGroup, CustomDeckGroup } from "../database/types";
import { generateDeckGroupId } from "./hash";
import { naturalCompare } from "./string";

/**
 * View-model for the unified Decks tree. Three top-level `section` nodes
 * (Files / Tags / Custom) plus a `Pinned` section; inside each, decks nest
 * into `folder` nodes with `leaf` decks at the bottom.
 *
 * - Files nest by the deck note's vault folder path (`filepath`).
 * - Tags nest by nested-tag path (`#a/b/c`). A node at a group's exact tag is
 *   "backed" (`group` set); intermediate paths with no exact group are virtual
 *   folders whose counts/ids are summed from children.
 * - Custom decks are a flat list (no natural hierarchy).
 *
 * All helpers here are pure and platform-agnostic (no Obsidian / DOM).
 */
export type TreeKind = "section" | "folder" | "leaf";

export type TreeSection = "files" | "tags" | "custom" | "pinned";

export interface TreeNode {
  /** Stable, unique id. section: "sec:files". folder: "dir:<path>" /
   *  "tag:<a/b>". leaf: the deck / group / custom id. */
  id: string;
  kind: TreeKind;
  /** Display label — last path segment for nested folders/tags. */
  name: string;
  /** 0 = section. */
  depth: number;
  children: TreeNode[];
  /** Which top-level section this belongs to (set on section nodes). */
  section?: TreeSection;
  // Leaf / backing payloads (at most one):
  fileDeck?: FileDeck;
  group?: DeckGroup; // backing tag group for a tag leaf/folder
  customDeck?: CustomDeckGroup;
  /** Deck ids to study for this node (leaf: its own; branch: union of
   *  descendants, or the backing group's ids for a backed tag node). */
  deckIds: string[];
  // Rolled-up for branches:
  newCount: number;
  dueCount: number;
  /** Any descendant leaf (or this node's backing group) has an enabled
   *  new-card limit and new > 0. */
  hasLimit: boolean;
  /** Leaves / backed tag nodes only. */
  pinned: boolean;
}

export interface DeckTree {
  pinned: TreeNode;
  sections: TreeNode[];
}

/** A flattened, renderable row: the node plus its live expansion state. */
export interface FlatRow {
  node: TreeNode;
  expanded: boolean;
}

interface NodeStats {
  newCount: number;
  dueCount: number;
  totalCount: number;
}

export interface BuildDeckTreeInput {
  fileDecks: FileDeck[];
  deckGroups: DeckGroup[];
  customDeckGroups: CustomDeckGroup[];
  getStats: (id: string) => NodeStats | undefined;
  pinnedIds: ReadonlySet<string>;
  minDeckCardCount: number;
}

function makeNode(partial: Partial<TreeNode> & Pick<TreeNode, "id" | "kind" | "name" | "depth">): TreeNode {
  return {
    children: [],
    deckIds: [],
    newCount: 0,
    dueCount: 0,
    hasLimit: false,
    pinned: false,
    ...partial,
  };
}

function dirSegments(filepath: string): string[] {
  const slash = filepath.lastIndexOf("/");
  if (slash < 0) return [];
  const dir = filepath.slice(0, slash);
  return dir.length === 0 ? [] : dir.split("/");
}

/**
 * Build the unified tree from the flat deck/group/custom lists. Counts are
 * rolled up (including pinned descendants); pinned leaves are then lifted into
 * a dedicated top block. The result is unsorted and unfiltered — callers pipe
 * it through `filterDeckTree` / `sortDeckTree` / `flattenDeckTree`.
 */
export function buildDeckTree(input: BuildDeckTreeInput): DeckTree {
  const { fileDecks, deckGroups, customDeckGroups, getStats, pinnedIds, minDeckCardCount } = input;
  const minCount = Number.isFinite(minDeckCardCount) && minDeckCardCount > 0 ? minDeckCardCount : 0;

  const filesSection = makeNode({ id: "sec:files", kind: "section", section: "files", name: "Files", depth: 0 });
  const tagsSection = makeNode({ id: "sec:tags", kind: "section", section: "tags", name: "Tags", depth: 0 });
  const customSection = makeNode({ id: "sec:custom", kind: "section", section: "custom", name: "Custom", depth: 0 });

  // --- Files: nest by vault folder path -------------------------------------
  const folderByPath = new Map<string, TreeNode>();
  const ensureFolder = (segs: string[]): TreeNode => {
    let parent = filesSection;
    let cumulative = "";
    for (const seg of segs) {
      cumulative = cumulative ? `${cumulative}/${seg}` : seg;
      let node = folderByPath.get(cumulative);
      if (!node) {
        node = makeNode({ id: `dir:${cumulative}`, kind: "folder", name: seg, depth: parent.depth + 1 });
        folderByPath.set(cumulative, node);
        parent.children.push(node);
      }
      parent = node;
    }
    return parent;
  };

  for (const deck of fileDecks) {
    const pinned = pinnedIds.has(deck.id);
    if (minCount > 0 && !pinned && (getStats(deck.id)?.totalCount ?? 0) < minCount) continue;
    const parent = ensureFolder(dirSegments(deck.filepath));
    parent.children.push(
      makeNode({ id: deck.id, kind: "leaf", name: deck.name, depth: parent.depth + 1, fileDeck: deck, pinned })
    );
  }
  pruneEmptyFolders(filesSection);

  // --- Tags: nest by nested-tag path ----------------------------------------
  const tagByPath = new Map<string, TreeNode>();
  for (const group of deckGroups) {
    const path = group.tag.replace(/^#/, "");
    const segs = path.split("/");
    let parent = tagsSection;
    let cumulative = "";
    for (let i = 0; i < segs.length; i++) {
      cumulative = cumulative ? `${cumulative}/${segs[i]}` : segs[i];
      let node = tagByPath.get(cumulative);
      if (!node) {
        node = makeNode({ id: `tag:${cumulative}`, kind: "folder", name: segs[i], depth: parent.depth + 1 });
        tagByPath.set(cumulative, node);
        parent.children.push(node);
      }
      if (i === segs.length - 1) node.group = group;
      parent = node;
    }
  }
  // A tag node with no children is a leaf; otherwise a folder.
  finalizeTagKinds(tagsSection);

  // --- Custom: flat list ----------------------------------------------------
  for (const custom of customDeckGroups) {
    const pinned = pinnedIds.has(custom.id);
    if (minCount > 0 && !pinned && (getStats(custom.id)?.totalCount ?? 0) < minCount) continue;
    customSection.children.push(
      makeNode({ id: custom.id, kind: "leaf", name: custom.name, depth: 1, customDeck: custom, pinned })
    );
  }

  const sections = [filesSection, tagsSection, customSection];

  // Roll up counts / ids / limit flags over the FULL tree (pinned included).
  for (const section of sections) rollup(section, getStats, pinnedIds);

  // Lift pinned leaves into a dedicated top block (folders stay in place).
  const pinnedSection = makeNode({ id: "sec:pinned", kind: "section", section: "pinned", name: "Pinned", depth: 0 });
  for (const section of sections) extractPinned(section, pinnedSection);
  for (const child of pinnedSection.children) child.depth = 1;
  aggregate(pinnedSection);

  return { pinned: pinnedSection, sections };
}

function pruneEmptyFolders(node: TreeNode): void {
  node.children = node.children.filter((child) => {
    if (child.kind === "leaf") return true;
    pruneEmptyFolders(child);
    return child.children.length > 0;
  });
}

function finalizeTagKinds(node: TreeNode): void {
  for (const child of node.children) {
    finalizeTagKinds(child);
    child.kind = child.children.length > 0 ? "folder" : "leaf";
  }
}

function rollup(
  node: TreeNode,
  getStats: (id: string) => NodeStats | undefined,
  pinnedIds: ReadonlySet<string>
): void {
  if (node.kind === "leaf") {
    if (node.fileDeck) {
      const s = getStats(node.fileDeck.id);
      node.newCount = s?.newCount ?? 0;
      node.dueCount = s?.dueCount ?? 0;
      node.deckIds = [node.fileDeck.id];
      node.hasLimit = node.fileDeck.profile.hasNewCardsLimitEnabled && node.newCount > 0;
      node.pinned = pinnedIds.has(node.fileDeck.id);
    } else if (node.group) {
      const groupId = generateDeckGroupId(node.group.tag);
      const s = getStats(groupId);
      node.newCount = s?.newCount ?? 0;
      node.dueCount = s?.dueCount ?? 0;
      node.deckIds = node.group.deckIds;
      node.hasLimit = node.group.profile.hasNewCardsLimitEnabled && node.newCount > 0;
      node.pinned = pinnedIds.has(groupId);
    } else if (node.customDeck) {
      const s = getStats(node.customDeck.id);
      node.newCount = s?.newCount ?? 0;
      node.dueCount = s?.dueCount ?? 0;
      node.deckIds = [node.customDeck.id];
      node.hasLimit = false;
      node.pinned = pinnedIds.has(node.customDeck.id);
    }
    return;
  }

  for (const child of node.children) rollup(child, getStats, pinnedIds);

  if (node.group) {
    // Backed tag folder: the group already deep-aggregates its subtree, so use
    // its own (already-correct) stats rather than re-summing children.
    const groupId = generateDeckGroupId(node.group.tag);
    const s = getStats(groupId);
    node.newCount = s?.newCount ?? 0;
    node.dueCount = s?.dueCount ?? 0;
    node.deckIds = node.group.deckIds;
    const ownLimit = node.group.profile.hasNewCardsLimitEnabled && node.newCount > 0;
    node.hasLimit = ownLimit || node.children.some((c) => c.hasLimit);
    node.pinned = pinnedIds.has(groupId);
    return;
  }

  aggregate(node);
}

/** Sum a branch's counts / ids / limit flags from its (already-rolled) children. */
function aggregate(node: TreeNode): void {
  let newCount = 0;
  let dueCount = 0;
  let hasLimit = false;
  const ids = new Set<string>();
  for (const child of node.children) {
    newCount += child.newCount;
    dueCount += child.dueCount;
    hasLimit = hasLimit || child.hasLimit;
    for (const id of child.deckIds) ids.add(id);
  }
  node.newCount = newCount;
  node.dueCount = dueCount;
  node.hasLimit = hasLimit;
  node.deckIds = [...ids];
}

function extractPinned(node: TreeNode, pinnedSection: TreeNode): void {
  node.children = node.children.filter((child) => {
    if (child.kind === "leaf" && child.pinned) {
      pinnedSection.children.push(child);
      return false;
    }
    if (child.kind !== "leaf") extractPinned(child, pinnedSection);
    return true;
  });
}

/**
 * Keep leaves whose name (or backing tag) matches `query`; keep a branch if its
 * own name matches or any descendant survives. Empty query is a no-op.
 */
export function filterDeckTree(tree: DeckTree, query: string): DeckTree {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  return {
    pinned: filterBranch(tree.pinned, q) ?? emptyLike(tree.pinned),
    sections: tree.sections.map((s) => filterBranch(s, q) ?? emptyLike(s)),
  };
}

function emptyLike(node: TreeNode): TreeNode {
  return { ...node, children: [] };
}

function matchesQuery(node: TreeNode, q: string): boolean {
  if (node.name.toLowerCase().includes(q)) return true;
  const tag = node.group?.tag ?? node.fileDeck?.tag;
  return tag ? tag.toLowerCase().includes(q) : false;
}

function filterBranch(node: TreeNode, q: string): TreeNode | null {
  if (node.kind === "leaf") return matchesQuery(node, q) ? node : null;
  const kids = node.children.map((c) => filterBranch(c, q)).filter((c): c is TreeNode => c !== null);
  if (kids.length > 0) return { ...node, children: kids };
  return matchesQuery(node, q) ? { ...node, children: [] } : null;
}

/**
 * Sort each branch's children by the active mode. Never reorders the three
 * top-level sections and never lifts a leaf out of its folder. Pinned handling
 * is not needed here — pins are already isolated in the top block.
 */
export function sortDeckTree(tree: DeckTree, sortMode: DeckListSortMode): DeckTree {
  const cmp = makeComparator(sortMode);
  return {
    pinned: sortBranch(tree.pinned, cmp),
    sections: tree.sections.map((s) => sortBranch(s, cmp)),
  };
}

function sortBranch(node: TreeNode, cmp: (a: TreeNode, b: TreeNode) => number): TreeNode {
  if (node.kind === "leaf") return node;
  const children = node.children.map((c) => sortBranch(c, cmp)).sort(cmp);
  return { ...node, children };
}

function makeComparator(sortMode: DeckListSortMode): (a: TreeNode, b: TreeNode) => number {
  switch (sortMode) {
    case "name-asc":
      return (a, b) => naturalCompare(a.name, b.name);
    case "name-desc":
      return (a, b) => naturalCompare(b.name, a.name);
    case "new-asc":
      return (a, b) => a.newCount - b.newCount || naturalCompare(a.name, b.name);
    case "new-desc":
      return (a, b) => b.newCount - a.newCount || naturalCompare(a.name, b.name);
    case "due-asc":
      return (a, b) => a.dueCount - b.dueCount || naturalCompare(a.name, b.name);
    case "due-desc":
      return (a, b) => b.dueCount - a.dueCount || naturalCompare(a.name, b.name);
  }
}

/**
 * Depth-first flatten into renderable rows: the Pinned block first (only when
 * non-empty), then the three sections. A collapsed branch's children are
 * skipped unless `filtering` is true, which forces every branch open so matches
 * are visible.
 */
export function flattenDeckTree(
  tree: DeckTree,
  collapsed: ReadonlySet<string>,
  filtering: boolean
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      const branch = node.kind !== "leaf";
      const expanded = branch && (filtering || !collapsed.has(node.id));
      out.push({ node, expanded });
      if (branch && expanded) walk(node.children);
    }
  };
  if (tree.pinned.children.length > 0) walk([tree.pinned]);
  walk(tree.sections);
  return out;
}

/** Every branch id in the tree — used by the "collapse all" action. */
export function allBranchIds(tree: DeckTree): string[] {
  const ids: string[] = [];
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== "leaf") {
        ids.push(node.id);
        walk(node.children);
      }
    }
  };
  if (tree.pinned.children.length > 0) walk([tree.pinned]);
  walk(tree.sections);
  return ids;
}
