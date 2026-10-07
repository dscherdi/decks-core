import { strToU8, unzipSync, zipSync } from "fflate";
import { unpackDpkg } from "../archive";
import { DpkgError, parseDpkgManifest } from "../manifest";
import { readDpkgContent } from "../import";
import { buildPackage, card, opener, singleDeck } from "./helpers";
import { DEFAULT_EXAM_SETTINGS } from "../../../database/types";

const SLUG = "spanish-basics";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function cards() {
  return [
    card(SLUG, "card_1a", "hola", "hello"),
    card(SLUG, "rcard_1a", "hello", "hola"),
    card(SLUG, "ccard_2b", "El {{c1::perro}}", "El perro", { type: "cloze", clozeText: "perro", clozeOrder: 0 }),
  ];
}

function content() {
  return singleDeck("Spanish basics", cards(), [], ["languages"]);
}

function course() {
  return {
    decks: [
      { key: "vocabulary", name: "Vocabulary", fileTags: ["vocab"], cards: cards().slice(0, 2) },
      { key: "grammar", name: "Grammar", fileTags: [], cards: cards().slice(2) },
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
    expect(read.decks).toHaveLength(1);
    expect(read.decks[0]).toMatchObject({ key: "", name: "Spanish basics", fileTags: ["languages"] });
    expect(read.decks[0].cards.map((c) => c.id)).toEqual(cards().map((c) => c.id));
    expect(read.decks[0].cards[2]).toMatchObject({ type: "cloze", clozeText: "perro", clozeOrder: 0 });
  });

  it("carries several decks, each with its own cards, in the author's order", async () => {
    const unpacked = await unpackDpkg(await buildPackage(SLUG, 1, course(), [], {}, "Spanish course"));
    expect(unpacked.manifest.title).toBe("Spanish course");
    expect(unpacked.manifest.decks.map((deck) => [deck.key, deck.title, deck.cardCount])).toEqual([
      ["vocabulary", "Vocabulary", 2],
      ["grammar", "Grammar", 1],
    ]);
    const read = readDpkgContent(unpacked, await opener());
    expect(read.decks.map((deck) => [deck.key, deck.fileTags, deck.cards.map((c) => c.id)])).toEqual([
      ["vocabulary", ["vocab"], cards().slice(0, 2).map((c) => c.id)],
      ["grammar", [], cards().slice(2).map((c) => c.id)],
    ]);
  });

  it("keeps each exam deck's settings, filled in where the author left gaps", async () => {
    const plain = await unpackDpkg(await buildPackage(SLUG, 1, content()), { includeMedia: false });
    expect(plain.manifest.decks[0].exam).toBeNull();
    const exam = await unpackDpkg(
      await buildPackage(SLUG, 1, course(), [], { grammar: { ...DEFAULT_EXAM_SETTINGS, questionCount: 10, passScorePct: 80 } }),
      { includeMedia: false }
    );
    expect(exam.manifest.decks.map((deck) => deck.exam)).toEqual([
      null,
      { ...DEFAULT_EXAM_SETTINGS, questionCount: 10, passScorePct: 80 },
    ]);
    const decks = exam.manifest.decks.map((deck) => ({ ...deck, exam: "yes" }));
    expect(() => parseDpkgManifest(JSON.stringify({ ...exam.manifest, decks }))).toThrow(DpkgError);
  });

  it("reads a package written before decks were listed as one deck", async () => {
    const unpacked = await unpackDpkg(await buildPackage(SLUG, 1, content()), { includeMedia: false });
    const { decks, ...rest } = unpacked.manifest;
    const legacy = parseDpkgManifest(JSON.stringify({ ...rest, exam: { passScorePct: 90 } }));
    expect(legacy.decks).toEqual([
      { key: "", title: decks[0].title, cardCount: 3, exam: { ...DEFAULT_EXAM_SETTINGS, passScorePct: 90 } },
    ]);
  });

  it("refuses a deck list that names a deck twice, misses a key or miscounts", async () => {
    const { manifest } = await unpackDpkg(await buildPackage(SLUG, 1, course()), { includeMedia: false });
    const [vocabulary, grammar] = manifest.decks;
    const variants = [
      [vocabulary, { ...grammar, key: "vocabulary" }],
      [vocabulary, { ...grammar, key: "" }],
      [vocabulary, { ...grammar, cardCount: 5 }],
      [{ ...vocabulary, key: "Vocab ulary" }, grammar],
    ];
    for (const decks of variants) {
      expect(() => parseDpkgManifest(JSON.stringify({ ...manifest, decks }))).toThrow(DpkgError);
    }
  });

  it("refuses a package whose decks do not match its manifest", async () => {
    const files = unzipSync(await buildPackage(SLUG, 1, course()));
    const unpacked = await unpackDpkg(zipSync(files), { includeMedia: false });
    const opened = await opener();
    const swapped = {
      ...unpacked,
      manifest: { ...unpacked.manifest, decks: unpacked.manifest.decks.map((deck) => ({ ...deck, key: `${deck.key}-x` })) },
    };
    expect(() => readDpkgContent(swapped, opened)).toThrow(expect.objectContaining({ code: "invalid_deck" }));
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
    const short = singleDeck("Short", [{ ...card(SLUG, "card_1", "a", "b"), id: "card_abc12" }]);
    const unpacked = await unpackDpkg(await buildPackage(SLUG, 1, short));
    const opened = await opener();
    expect(() => readDpkgContent(unpacked, opened)).toThrow(expect.objectContaining({ code: "invalid_deck" }));
  });
});
