import { unpackDpkg } from "../archive";
import type { DirectoryDeckRecord } from "../DirectoryStore";
import { directoryDeckMediaNames, directoryMediaToPrune } from "../media-prune";
import { buildPackage, card, singleDeck } from "./helpers";

const png = (byte: number) => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, byte]), ext: "png", mime: "image/png" });

async function manifestWith(ref: string, media: ReturnType<typeof png>[]): Promise<string> {
  const pkg = await buildPackage(ref, 1, singleDeck(ref, [card(ref, "c1", "Front", "Back")]), media);
  return JSON.stringify((await unpackDpkg(pkg, { includeMedia: false })).manifest);
}

function record(id: string, manifestJson: string, removedAt: string | null): DirectoryDeckRecord {
  return {
    id,
    publisher: "decksmd",
    slug: id,
    version: 1,
    title: id,
    description: "",
    manifestJson,
    archiveSha256: "",
    fileTagsByKey: {},
    importedAt: "2026-10-01T00:00:00.000Z",
    modified: removedAt ?? "2026-10-01T00:00:00.000Z",
    removedAt,
  };
}

describe("directory media pruning", () => {
  it("names a package's files the way the media folder stores them", async () => {
    const names = directoryDeckMediaNames(await manifestWith("decksmd/a", [png(1)]));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(directoryDeckMediaNames("not json")).toEqual([]);
  });

  it("offers only files of removed packages that no installed package still lists", async () => {
    const shared = png(1);
    const removed = await manifestWith("decksmd/old", [shared, png(2)]);
    const live = await manifestWith("decksmd/new", [shared]);
    const [sharedName, onlyRemoved] = directoryDeckMediaNames(removed);

    const prune = directoryMediaToPrune([
      record("old", removed, "2026-10-05T00:00:00.000Z"),
      record("new", live, null),
    ]);

    expect([...prune.keys()]).toEqual([onlyRemoved]);
    expect(prune.get(onlyRemoved)).toBe("2026-10-05T00:00:00.000Z");
    expect(prune.has(sharedName)).toBe(false);
  });

  it("keeps the latest removal when several removed packages list a file", async () => {
    const manifest = await manifestWith("decksmd/a", [png(3)]);
    const prune = directoryMediaToPrune([
      record("a", manifest, "2026-10-02T00:00:00.000Z"),
      record("b", manifest, "2026-10-08T00:00:00.000Z"),
    ]);
    expect([...prune.values()]).toEqual(["2026-10-08T00:00:00.000Z"]);
  });
});
