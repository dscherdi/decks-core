import type {
  DeckWithProfile,
  DeckGroup,
  DeckProfile,
  ProfileTagMapping,
} from "../database/types";
import type { IDatabaseService } from "../database/DatabaseService.interface";
import { naturalCompare } from "../utils/string";
import {
  ancestorTags,
  pickProfileMapping,
  studyTagsFor,
  type TagScopeOptions,
} from "../utils/deck-tags";
import { isDirectoryDeckPath } from "./directory/ids";

const DEFAULT_SCOPE: TagScopeOptions = { baseTag: "#decks", ignore: [] };

export class TagGroupService {
  /**
   * Read as a callback rather than captured, because both surfaces mutate their
   * settings object in place — a scope snapshotted at construction would keep
   * grouping by the base tag and ignore list that were in force when the view
   * was opened.
   */
  private readonly scopeOf: () => TagScopeOptions;

  constructor(private db: IDatabaseService, scope?: () => TagScopeOptions) {
    this.scopeOf = scope ?? (() => DEFAULT_SCOPE);
  }

  /**
   * Group decks into the tag tree.
   *
   * A deck joins a bucket for every tag it carries — its deck tag and its flat
   * frontmatter tags alike — and for every ancestor of each, so `#decks/a/b`
   * is a real group rather than an empty folder that only sums its children.
   * Membership is intentionally overlapping: a deck tagged `#decks/spanish` and
   * `#math` appears under both, and callers that total a section do so over
   * unique deck ids. Directory decks have a section of their own and never
   * appear here.
   */
  async aggregateByTag(decks: DeckWithProfile[]): Promise<DeckGroup[]> {
    const tagMap = new Map<string, DeckWithProfile[]>();
    const members = new Map<string, Set<string>>();

    const add = (tag: string, deck: DeckWithProfile): void => {
      let seen = members.get(tag);
      if (!seen) {
        seen = new Set();
        members.set(tag, seen);
        tagMap.set(tag, []);
      }
      if (seen.has(deck.id)) return;
      seen.add(deck.id);
      tagMap.get(tag)!.push(deck);
    };

    const scope = this.scopeOf();
    for (const deck of decks) {
      if (isDirectoryDeckPath(deck.filepath)) continue;
      for (const tag of studyTagsFor(deck, scope)) {
        for (const ancestor of ancestorTags(tag)) add(ancestor, deck);
      }
    }

    const mappings = await this.db.getAllTagMappings();
    const profileCache = new Map<string, DeckProfile | null>();

    const deckGroups: DeckGroup[] = [];
    for (const [tag, groupDecks] of tagMap) {
      const profile = await this.resolveProfileForTag(tag, groupDecks, mappings, profileCache);
      deckGroups.push({
        type: 'group',
        tag,
        name: this.getDisplayName(tag),
        deckIds: groupDecks.map(d => d.id),
        profile,
        lastReviewed: this.getMostRecentReview(groupDecks),
        created: this.getEarliestCreation(groupDecks),
        modified: this.getMostRecentModification(groupDecks),
      });
    }

    return deckGroups.sort((a, b) => naturalCompare(a.tag, b.tag));
  }

  private getDisplayName(tag: string): string {
    const parts = tag.replace(/^#/, '').split('/');
    const lastPart = parts[parts.length - 1];
    return lastPart.charAt(0).toUpperCase() + lastPart.slice(1);
  }

  private async resolveProfileForTag(
    tag: string,
    groupDecks: DeckWithProfile[],
    mappings: ProfileTagMapping[],
    profileCache: Map<string, DeckProfile | null>
  ): Promise<DeckProfile> {
    const profileId = pickProfileMapping(mappings, [tag]);
    if (profileId) {
      const profile = await this.loadProfile(profileId, profileCache);
      if (profile) return profile;
    }

    if (groupDecks.length > 0) {
      return groupDecks[0].profile;
    }

    const defaultProfile = await this.loadProfile('profile_default', profileCache);
    if (!defaultProfile) throw new Error('Default profile not found');
    return defaultProfile;
  }

  private async loadProfile(
    profileId: string,
    cache: Map<string, DeckProfile | null>
  ): Promise<DeckProfile | null> {
    const cached = cache.get(profileId);
    if (cached !== undefined) return cached;
    const profile = await this.db.getProfileById(profileId);
    cache.set(profileId, profile);
    return profile;
  }

  private getMostRecentReview(decks: DeckWithProfile[]): string | null {
    return decks.reduce((latest, deck) =>
      deck.lastReviewed && (!latest || deck.lastReviewed > latest)
        ? deck.lastReviewed
        : latest,
      null as string | null
    );
  }

  private getEarliestCreation(decks: DeckWithProfile[]): string {
    return decks.reduce((earliest, deck) =>
      deck.created < earliest ? deck.created : earliest,
      decks[0].created
    );
  }

  private getMostRecentModification(decks: DeckWithProfile[]): string {
    return decks.reduce((latest, deck) =>
      deck.modified > latest ? deck.modified : latest,
      decks[0].modified
    );
  }
}
