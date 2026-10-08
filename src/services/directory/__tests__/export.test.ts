import type { Flashcard } from "../../../database/types";
import { serializeOcclusionBack, parseOcclusionBack } from "../../occlusion/OcclusionV2";
import { buildDirectoryCards, collectCardEmbeds, listVaultEmbeds, rewriteVaultEmbeds } from "../export";
import { deriveDirectoryCardId } from "../ids";
import { listDirectoryMediaRefs } from "../media-refs";

const FLAG = { sha256: "a".repeat(64), ext: "png" };
const SOUND = { sha256: "b".repeat(64), ext: "mp3" };
const resolve = (path: string) =>
  path === "flags/fr.png" || path === "fr.png" ? FLAG : path === "audio/bonjour.mp3" ? SOUND : null;

function card(over: Partial<Flashcard>): Flashcard {
  return {
    id: "card_x",
    deckId: "deck_1",
    front: "",
    back: "",
    type: "header-paragraph",
    sourceFile: "French.md",
    contentHash: "",
    breadcrumb: "",
    notes: "",
    hint: "",
    clozeText: null,
    clozeOrder: null,
    sourceNodeId: null,
    edgeId: null,
    templateRow: null,
    state: "review",
    dueDate: "2026-10-10T00:00:00.000Z",
    interval: 1440,
    repetitions: 3,
    difficulty: 4,
    stability: 9,
    lapses: 1,
    lastReviewed: "2026-10-01T00:00:00.000Z",
    created: "",
    modified: "",
    tags: [],
    suspendedAt: null,
    buriedUntil: null,
    anchor: null,
    ...over,
  };
}

describe("exporting a deck's cards", () => {
  it("finds local embeds in every form and ignores web links", () => {
    const text = '![[flags/fr.png|200]] ![map](flags/fr.png) <audio src="audio/bonjour.mp3"> ![x](https://e.com/a.png)';
    expect(listVaultEmbeds(text)).toEqual(["flags/fr.png", "audio/bonjour.mp3"]);
  });

  it("points embeds at packaged media and reports what it cannot package", () => {
    const { text, unresolved } = rewriteVaultEmbeds("![[flags/fr.png|200]] and ![[Some note]]", resolve);
    expect(text).toBe(`![[media/${FLAG.sha256}.png|200]] and ![[Some note]]`);
    expect(unresolved).toEqual(["Some note"]);
    expect(listDirectoryMediaRefs(text)).toEqual([FLAG]);
  });

  it("derives ids, leaves scheduling behind and skips canvas-only types", () => {
    const result = buildDirectoryCards("someone/french", [
      card({ id: "card_fr", front: "France", back: "![[fr.png]] Paris" }),
      card({ id: "scard_edge", type: "spatial", edgeId: "e1" }),
    ], resolve);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      id: deriveDirectoryCardId("someone/french", "card_fr"),
      back: `![[media/${FLAG.sha256}.png]] Paris`,
    });
    expect(result.cards[0]).not.toHaveProperty("stability");
    expect(result.skipped).toEqual([{ id: "scard_edge", reason: "unsupported_type" }]);
  });

  it("carries multiple-choice questions only from an exam deck", () => {
    const question = card({ id: "qcard_gas", type: "multiple-choice", front: "Noble gas?", back: "- [ ] Oxygen\n- [x] Argon" });
    expect(buildDirectoryCards("chem", [question], resolve).skipped).toEqual([{ id: "qcard_gas", reason: "unsupported_type" }]);
    const exam = buildDirectoryCards("chem", [question], resolve, { exam: true });
    expect(exam.skipped).toEqual([]);
    expect(exam.cards[0]).toMatchObject({ type: "multiple-choice", back: "- [ ] Oxygen\n- [x] Argon" });
  });

  it("moves an occlusion card's image into the package", () => {
    const back = serializeOcclusionBack({ __v: 2, image: "![[flags/fr.png]]", masks: [] });
    const occlusion = card({ id: "ocard_1", type: "image-occlusion-v2", back });
    expect(collectCardEmbeds([occlusion])).toEqual(["flags/fr.png"]);
    const [built] = buildDirectoryCards("someone/french", [occlusion], resolve).cards;
    expect(parseOcclusionBack(built.back)?.image).toBe(`media/${FLAG.sha256}.png`);
  });

  it("gives the same card the same id in every export", () => {
    const a = buildDirectoryCards("someone/french", [card({ id: "card_fr", front: "France", back: "Paris" })], resolve);
    const b = buildDirectoryCards("someone/french", [card({ id: "card_fr", front: "France", back: "Paris!" })], resolve);
    expect(a.cards[0].id).toBe(b.cards[0].id);
    expect(a.cards[0].contentHash).not.toBe(b.cards[0].contentHash);
  });
});

describe("author to learner round trip", () => {
  it("installs exactly the cards the author exported, with media and new scheduling", async () => {
    const { mainDb, opener, rows, singleDeck, sqlJs } = await import("./helpers");
    const { writeDpkgDeckDb } = await import("../deck-db");
    const { packDpkg, unpackDpkg } = await import("../archive");
    const { importDpkgContent } = await import("../import");
    const { directoryDeckId } = await import("../ids");

    const authored = [
      card({ id: "card_fr", front: "France", back: "![[flags/fr.png]] Paris" }),
      card({ id: "ccard_c1", type: "cloze", front: "La {{c1::tour}}", back: "La tour", clozeText: "tour", clozeOrder: 0 }),
    ];
    const built = buildDirectoryCards("someone/french", authored, resolve);
    const SQL = await sqlJs();
    const deckDb = new SQL.Database();
    writeDpkgDeckDb(deckDb, "someone/french", singleDeck("French", built.cards), "2026-10-01T00:00:00.000Z");
    const { bytes } = await packDpkg({
      manifest: {
        publisher: { id: "someone", name: "Someone" }, slug: "french", version: 1, title: "French", description: "", language: "fr", subject: "",
        tags: [], license: "", cardCount: built.cards.length, typeCounts: {}, createdAt: "2026-10-01T00:00:00.000Z", generator: "test",
        decks: [{ key: "", title: "French", cardCount: built.cards.length, exam: null }],
      },
      deckDb: deckDb.export(),
      cardsJson: JSON.stringify(built.cards),
      media: [{ bytes: new Uint8Array([1, 2, 3]), ext: "png", mime: "image/png" }],
    });
    deckDb.close();

    const learner = await mainDb();
    const contents = await unpackDpkg(bytes);
    importDpkgContent(learner, contents, "sha", await opener(), "2026-10-02T00:00:00.000Z");
    const installed = rows(learner, "SELECT id, back, state, repetitions, last_reviewed FROM flashcards WHERE deck_id = ? ORDER BY id", [directoryDeckId("someone/french")]);
    expect(installed.map((r) => r.id)).toEqual(built.cards.map((c) => c.id).sort());
    expect(installed.every((r) => r.state === "new" && r.repetitions === 0 && r.last_reviewed === null)).toBe(true);
    expect(installed.find((r) => r.id === deriveDirectoryCardId("someone/french", "card_fr"))?.back).toContain(`media/`);
  });
});
