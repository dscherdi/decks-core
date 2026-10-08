import { directoryMediaUrl, parseDirectoryDeckInfo, parseDirectoryImportRequest, isPublishedDirectoryArchive, matchesDirectoryLink, needsDirectoryCheck } from "../remote";

describe("directory import links", () => {
  it("accepts a slug and a ticket", () => {
    expect(parseDirectoryImportRequest({ deck: "spanish-basics", ticket: "AbCdEfGhIjKlMnOp_1234" })).toEqual({
      slug: "spanish-basics",
      ticket: "AbCdEfGhIjKlMnOp_1234",
    });
  });

  it("refuses anything that could steer the download elsewhere", () => {
    expect(parseDirectoryImportRequest({ deck: "../x", ticket: "AbCdEfGhIjKlMnOp" })).toBeNull();
    expect(parseDirectoryImportRequest({ deck: "ok", ticket: "https://evil.example/x.dpkg" })).toBeNull();
    expect(parseDirectoryImportRequest({ deck: "ok" })).toBeNull();
  });

  it("reads deck info and refuses a malformed reply", () => {
    expect(parseDirectoryDeckInfo('{"slug":"a-b","title":"T","version":2,"cardCount":5,"sizeBytes":10}')).toEqual({
      slug: "a-b", title: "T", version: 2, cardCount: 5, sizeBytes: 10, versions: [],
    });
    expect(parseDirectoryDeckInfo('{"slug":"A B","title":"T","version":2}')).toBeNull();
    expect(parseDirectoryDeckInfo("not json")).toBeNull();
  });

  it("takes a linked download only from the directory's own publisher, and checks files that claim it", () => {
    const official = { publisher: { id: "decksmd", name: "DecksMD" }, slug: "a-b" };
    const theirs = { publisher: { id: "someone", name: "" }, slug: "a-b" };
    expect([matchesDirectoryLink(official, "a-b"), matchesDirectoryLink(official, "c"), matchesDirectoryLink(theirs, "a-b")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([needsDirectoryCheck(official), needsDirectoryCheck(theirs)]).toEqual([true, false]);
  });

  it("accepts a package file as the directory's only when a published version has its hash", () => {
    const sha = "a".repeat(64);
    const info = parseDirectoryDeckInfo(
      JSON.stringify({ slug: "a-b", title: "T", version: 2, versions: [{ version: 1, sha256: sha }, { version: 2, sha256: "nope" }] })
    );
    expect(info?.versions).toEqual([{ version: 1, sha256: sha }]);
    expect(isPublishedDirectoryArchive(info, "a-b", sha)).toBe(true);
    expect(isPublishedDirectoryArchive(info, "a-b", "b".repeat(64))).toBe(false);
    expect(isPublishedDirectoryArchive(info, "other", sha)).toBe(false);
    expect(isPublishedDirectoryArchive(null, "a-b", sha)).toBe(false);
  });
});

describe("directory media URLs", () => {
  it("name the file the way the directory stores it, extension included", () => {
    expect(directoryMediaUrl({ sha256: "a".repeat(64), ext: "png" }, "https://x.test/api")).toBe(
      `https://x.test/api/media/${"a".repeat(64)}.png`
    );
    expect(directoryMediaUrl({ sha256: "nope", ext: "png" })).toBeNull();
  });
});
