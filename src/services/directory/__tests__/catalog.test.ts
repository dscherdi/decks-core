import type { HttpClient, HttpRequest } from "../../ai/HttpClient";
import {
  DirectoryCatalogError,
  catalogInstallState,
  directoryCatalogUrl,
  directoryCoverUrl,
  directoryDescriptionSummary,
  directoryLanguageName,
  directoryPackageUrl,
  directoryTermsUrl,
  fetchDirectoryCatalog,
  fetchDirectoryFilters,
  installedDirectorySlugs,
  isPersonalUseLicense,
  parseDirectoryCatalogPage,
} from "../catalog";
import type { DirectoryDeckRecord } from "../DirectoryStore";

const BASE = "https://directory.test/api";
const COVER = `${"c".repeat(64)}.webp`;

function record(slug: string, version: number, overrides: Partial<DirectoryDeckRecord> = {}): DirectoryDeckRecord {
  return {
    id: `deck_dir_${slug}`,
    publisher: "decksmd",
    slug,
    version,
    title: slug,
    description: "",
    manifestJson: "{}",
    archiveSha256: "0".repeat(64),
    fileTagsByKey: {},
    importedAt: "2026-10-01T00:00:00.000Z",
    modified: "2026-10-01T00:00:00.000Z",
    removedAt: null,
    ...overrides,
  };
}

function listed(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    title: `Deck ${slug}`,
    description: "About it",
    subject: "languages",
    language: "de",
    topic: "German",
    level: "CEFR A1",
    tags: ["vocab", 3],
    version: 2,
    cardCount: 120,
    mediaCount: 0,
    sizeBytes: 4096,
    free: true,
    downloadCount: 7,
    likeCount: 1,
    cover: COVER,
    updatedAt: "2026-10-20T00:00:00.000Z",
    decks: [
      { key: "words", title: "Words", cardCount: 100, exam: null },
      { key: "exam", title: "Exam", cardCount: 20, exam: { questionCount: 10 } },
    ],
    ...extra,
  };
}

function http(responses: Record<string, { status: number; body: unknown }>): HttpClient & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    async request(req) {
      seen.push(req);
      const reply = responses[req.url] ?? { status: 404, body: { error: "not_found" } };
      return { status: reply.status, text: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) };
    },
  };
}

describe("deck directory catalog", () => {
  it("always asks for free decks and leaves defaults out of the address", () => {
    expect(directoryCatalogUrl({}, BASE)).toBe(`${BASE}/decks?free=1`);
    expect(
      directoryCatalogUrl({ q: "  verbs ", subject: "languages", language: "de", sort: "downloads", page: 2 }, BASE)
    ).toBe(`${BASE}/decks?free=1&q=verbs&subject=languages&language=de&sort=downloads&page=2`);
    expect(directoryCatalogUrl({ sort: "updated", slugs: ["a", "b"] }, BASE)).toBe(`${BASE}/decks?free=1&slugs=a%2Cb`);
    expect(directoryCatalogUrl({ slugs: [] }, BASE)).toBe(`${BASE}/decks?free=1&slugs=`);
    expect(directoryPackageUrl("german-a1", BASE)).toBe(`${BASE}/decks/german-a1/package`);
  });

  it("builds cover addresses only for content-addressed names", () => {
    expect(directoryCoverUrl(COVER, BASE)).toBe(`${BASE}/media/${COVER}`);
    expect(directoryCoverUrl("../archives/x.dpkg", BASE)).toBeNull();
    expect(directoryCoverUrl(null, BASE)).toBeNull();
  });

  it("reads a page, dropping malformed entries and filling what is missing", () => {
    const page = parseDirectoryCatalogPage(
      JSON.stringify({
        decks: [
          listed("german-a1", { license: "CC BY-SA 4.0" }),
          { slug: "Bad Slug", title: "x", version: 1 },
          { slug: "no-title" },
          listed("old", { decks: "x", cover: "nope", cardCount: 9 }),
        ],
        hasMore: true,
      })
    );
    expect(page?.hasMore).toBe(true);
    expect(page?.decks.map((deck) => deck.slug)).toEqual(["german-a1", "old"]);
    expect(page?.decks[0]).toMatchObject({
      tags: ["vocab"],
      cover: COVER,
      decks: [
        { key: "words", title: "Words", cardCount: 100, exam: false },
        { key: "exam", title: "Exam", cardCount: 20, exam: true },
      ],
    });
    expect(page?.decks[0].license).toBe("CC BY-SA 4.0");
    expect(page?.decks[1]).toMatchObject({ cover: null, license: "", decks: [{ key: "", title: "Deck old", cardCount: 9, exam: false }] });
    expect(isPersonalUseLicense("")).toBe(true);
    expect(isPersonalUseLicense("personal-use")).toBe(true);
    expect(isPersonalUseLicense("CC BY-SA 4.0")).toBe(false);
    expect(parseDirectoryCatalogPage("not json")).toBeNull();
    expect(parseDirectoryCatalogPage(JSON.stringify({ hasMore: false }))).toBeNull();
  });

  it("fetches pages and filters through the injected client, and reports refusals", async () => {
    const client = http({
      [`${BASE}/decks?free=1&q=verbs`]: { status: 200, body: { decks: [listed("verbs")], hasMore: false } },
      [`${BASE}/filters?free=1`]: {
        status: 200,
        body: { subjects: [{ value: "languages", count: 3 }, { value: "", count: 1 }], languages: [{ value: "de", count: 2 }] },
      },
    });
    const page = await fetchDirectoryCatalog(client, { q: "verbs" }, { base: BASE });
    expect(page.decks.map((deck) => deck.slug)).toEqual(["verbs"]);
    expect(client.seen[0]).toMatchObject({ method: "GET" });
    expect(await fetchDirectoryFilters(client, { base: BASE })).toEqual({
      subjects: [{ value: "languages", count: 3 }],
      languages: [{ value: "de", count: 2 }],
    });
    await expect(fetchDirectoryCatalog(client, { q: "missing" }, { base: BASE })).rejects.toBeInstanceOf(DirectoryCatalogError);
  });

  it("tells a new package from an installed one and from one with a newer version", () => {
    const records = [record("german-a1", 1), record("german-a2", 3), record("gone", 1, { removedAt: "2026-10-02" }), record("theirs", 1, { publisher: "u-abc" })];
    expect(catalogInstallState({ slug: "german-a1", version: 2 }, records)).toEqual({ state: "update", installedVersion: 1 });
    expect(catalogInstallState({ slug: "german-a2", version: 3 }, records)).toEqual({ state: "installed", installedVersion: 3 });
    expect(catalogInstallState({ slug: "gone", version: 1 }, records)).toEqual({ state: "new", installedVersion: null });
    expect(catalogInstallState({ slug: "theirs", version: 2 }, records)).toEqual({ state: "new", installedVersion: null });
    expect(installedDirectorySlugs(records)).toEqual(["german-a1", "german-a2"]);
  });

  it("summarises a description as its opening paragraph in plain text", () => {
    expect(directoryDescriptionSummary("# Title\n\nLearn **German** words with [audio](https://x).\n\nMore text.")).toBe(
      "Learn German words with audio."
    );
    expect(directoryDescriptionSummary("word ".repeat(60), 40).endsWith("…")).toBe(true);
  });

  it("links the German terms for German readers and the English ones otherwise", () => {
    expect(directoryTermsUrl("de")).toBe("https://decksmd.app/legal/deck-verzeichnis");
    expect(directoryTermsUrl("de-AT")).toBe("https://decksmd.app/legal/deck-verzeichnis");
    expect(directoryTermsUrl("fr")).toBe("https://decksmd.app/legal/deck-directory");
  });

  it("names a language in the reader's language, keeping an unknown code", () => {
    expect(directoryLanguageName("de", "en")).toBe("German");
    expect(directoryLanguageName("de", "de")).toBe("Deutsch");
    expect(directoryLanguageName("", "en")).toBe("");
    expect(directoryLanguageName("not a code!", "en")).toBe("not a code!");
  });
});
