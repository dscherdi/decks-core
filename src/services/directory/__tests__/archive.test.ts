import { strToU8, unzipSync, zipSync } from "fflate";
import { unpackDpkg } from "../archive";
import { DpkgError, parseDpkgManifest } from "../manifest";
import { readDpkgContent } from "../import";
import { buildPackage, card, opener } from "./helpers";
import { DEFAULT_EXAM_SETTINGS } from "../../../database/types";

const SLUG = "spanish-basics";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function content() {
  return {
    name: "Spanish basics",
    fileTags: ["languages"],
    cards: [
      card(SLUG, "card_1a", "hola", "hello"),
      card(SLUG, "rcard_1a", "hello", "hola"),
      card(SLUG, "ccard_2b", "El {{c1::perro}}", "El perro", { type: "cloze", clozeText: "perro", clozeOrder: 0 }),
    ],
    templates: [],
  };
}

async function codeOf(promise: Promise<object>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DpkgError) return error.code;
    throw error;
  }
  return "ok";
}

describe(".dpkg packages", () => {
  it("round-trips the deck, its cards and its media", async () => {
    const pkg = await buildPackage(SLUG, 3, content(), [
      { bytes: png, ext: "png", mime: "image/png" },
      { bytes: png, ext: "png", mime: "image/png" },
    ]);
    const unpacked = await unpackDpkg(pkg);

    expect(unpacked.manifest.slug).toBe(SLUG);
    expect(unpacked.manifest.version).toBe(3);
    expect(unpacked.manifest.media).toHaveLength(1);
    expect([...unpacked.media.values()][0]).toEqual(png);

    const read = readDpkgContent(unpacked, await opener());
    expect(read.name).toBe("Spanish basics");
    expect(read.fileTags).toEqual(["languages"]);
    expect(read.cards.map((c) => c.id)).toEqual(content().cards.map((c) => c.id));
    expect(read.cards[2]).toMatchObject({ type: "cloze", clozeText: "perro", clozeOrder: 0 });
  });

  it("keeps an exam deck's settings, filled in where the author left gaps", async () => {
    const plain = await unpackDpkg(await buildPackage(SLUG, 1, content()), { includeMedia: false });
    expect(plain.manifest.exam).toBeNull();
    const exam = await unpackDpkg(
      await buildPackage(SLUG, 1, content(), [], { ...DEFAULT_EXAM_SETTINGS, questionCount: 10, passScorePct: 80 }),
      { includeMedia: false }
    );
    expect(exam.manifest.exam).toEqual({ ...DEFAULT_EXAM_SETTINGS, questionCount: 10, passScorePct: 80 });
    expect(() => parseDpkgManifest(JSON.stringify({ ...exam.manifest, exam: "yes" }))).toThrow(DpkgError);
  });

  it("can skip media when only the deck is needed", async () => {
    const pkg = await buildPackage(SLUG, 1, content(), [{ bytes: png, ext: "png", mime: "image/png" }]);
    const unpacked = await unpackDpkg(pkg, { includeMedia: false });
    expect(unpacked.media.size).toBe(0);
    expect(unpacked.manifest.media).toHaveLength(1);
  });

  it("refuses a deck.db that does not match its manifest", async () => {
    const files = unzipSync(await buildPackage(SLUG, 1, content()));
    files["deck.db"] = new Uint8Array([...files["deck.db"], 0]);
    expect(await codeOf(unpackDpkg(zipSync(files)))).toBe("hash_mismatch");
  });

  it("never surfaces files the manifest does not list", async () => {
    const files = unzipSync(await buildPackage(SLUG, 1, content()));
    files[`media/${"a".repeat(64)}.png`] = png;
    files["../escape.txt"] = strToU8("x");
    const unpacked = await unpackDpkg(zipSync(files));
    expect(unpacked.media.size).toBe(0);
  });

  it("refuses a format newer than this build reads", () => {
    const manifest = { formatVersion: 99, slug: SLUG, dbSha256: "0".repeat(64), version: 1, title: "x", schemaVersion: 1, cardCount: 1, createdAt: "" };
    expect(() => parseDpkgManifest(JSON.stringify(manifest))).toThrow(
      expect.objectContaining({ code: "newer_format" })
    );
  });

  it("refuses files that are not packages and packages over the limit", async () => {
    expect(await codeOf(unpackDpkg(strToU8("not a zip")))).toBe("not_a_package");
    const pkg = await buildPackage(SLUG, 1, content());
    expect(await codeOf(unpackDpkg(pkg, { limits: { maxEntryBytes: 10 } }))).toBe("too_large");
  });

  it("refuses card ids that could name a user's own card", async () => {
    const short = { ...content(), cards: [{ ...card(SLUG, "card_1", "a", "b"), id: "card_abc12" }] };
    const unpacked = await unpackDpkg(await buildPackage(SLUG, 1, short));
    const opened = await opener();
    expect(() => readDpkgContent(unpacked, opened)).toThrow(expect.objectContaining({ code: "invalid_deck" }));
  });
});
