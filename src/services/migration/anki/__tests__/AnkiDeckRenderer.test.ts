import { AnkiDeckRenderer } from "../AnkiDeckRenderer";
import type { AnkiParsedCard, AnkiScheduling } from "../AnkiTypes";
import { encodeAnchorValue, stripAnchorTokens } from "../../../../utils/anchors";
import type { AnkiEarlierRow } from "../AnkiDeckRenderer";
import { hash64 } from "../../../../utils/hash";

// Layout assertions ignore anchor tokens (inline and own-line); emission has
// dedicated tests below.
const clean = (s: string): string =>
  s
    .split("\n")
    .filter((line) => !/^%%dk:[hctoq]:[a-z0-9]+%%$/.test(line.trim()))
    .map((line) => stripAnchorTokens(line))
    .join("\n");

const NEW_SCHED: AnkiScheduling = {
  type: 0,
  queue: 0,
  due: 0,
  ivl: 0,
  factor: 0,
  reps: 0,
  lapses: 0,
  data: "{}",
};

function basic(partial: Partial<AnkiParsedCard>): AnkiParsedCard {
  return {
    noteId: 1,
    cardId: 10,
    ord: 0,
    kind: partial.isCloze ? "cloze" : "basic",
    isCloze: false,
    deckName: "Deck",
    front: "Front",
    back: "Back",
    notes: "",
    media: [],
    scheduling: NEW_SCHED,
    ...partial,
  };
}

describe("AnkiDeckRenderer", () => {
  it("renders one header-paragraph entry per card with a deck tag", () => {
    const cards = [
      basic({ deckName: "German::01 Hallo", front: "Hallo", back: "Hello" }),
      basic({ noteId: 2, cardId: 11, deckName: "German::01 Hallo", front: "Tschüss", back: "Bye" }),
    ];
    const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(decks).toHaveLength(1);
    const deck = decks[0];
    expect(deck.relativePath).toBe("German/01 Hallo");
    expect(deck.tag).toBe("decks/anki/german/01-hallo");
    expect(clean(deck.content)).toContain("tags:\n  - decks/anki/german/01-hallo");
    expect(clean(deck.content)).toContain("## Hallo\n\nHello");
    expect(clean(deck.content)).toContain("## Tschüss\n\nBye");
  });

  it("keeps forward and reverse templates as independent entries", () => {
    const cards = [
      basic({ ord: 0, front: "Das Wetter", back: "The weather" }),
      basic({ cardId: 11, ord: 1, front: "The weather", back: "Das Wetter" }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("## Das Wetter\n\nThe weather");
    expect(clean(deck.content)).toContain("## The weather\n\nDas Wetter");
  });

  it("renders cloze cards as a 1-col table per deck, deduped by note", () => {
    const clozeCard = (ord: number, clozeText: string): AnkiParsedCard =>
      basic({
        cardId: 20 + ord,
        ord,
        isCloze: true,
        front: "Du trinkst ==jeden Tag== ==Bier==.",
        back: "Du trinkst ==jeden Tag== ==Bier==.",
        clozeBody: "Du trinkst ==jeden Tag== ==Bier==.",
        clozeText,
        clozeOrder: ord,
      });
    const decks = AnkiDeckRenderer.render([clozeCard(0, "jeden Tag"), clozeCard(1, "Bier")], "decks/anki", 2);
    expect(clean(decks[0].content)).toContain("| Front |\n| --- |");
    // Same note → one row.
    const occurrences = clean(decks[0].content).split("Du trinkst ==jeden Tag== ==Bier==.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("splits cards across files mirroring the :: hierarchy", () => {
    const cards = [
      basic({ deckName: "German::01 Hallo", front: "a" }),
      basic({ noteId: 2, cardId: 11, deckName: "German::02 Wetter", front: "b" }),
    ];
    const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(decks.map((d) => d.relativePath)).toEqual(["German/01 Hallo", "German/02 Wetter"]);
  });

  it("appends notes after a --- in header-paragraph format", () => {
    const cards = [basic({ front: "Hallo", back: "Hello", notes: "informal greeting" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("## Hallo\n\nHello\n\n---\n\ninformal greeting");
  });

  it("promotes notes into back when back is empty (no dangling ---)", () => {
    const cards = [basic({ front: "Hallo", back: "", notes: "only notes" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("## Hallo\n\nonly notes");
    expect(clean(deck.content)).not.toContain("---\n\n");
  });

  it("aggregates table-routed cards (no notes) into a single 2-col table", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", tableLayout: true }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye", tableLayout: true }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front | Back |\n| --- | --- |");
    expect(clean(deck.content)).toContain("| Hallo | Hello |");
    expect(clean(deck.content)).toContain("| Tschüss | Bye |");
    expect(clean(deck.content)).not.toContain("| Notes |");
    // One aggregated table, not one per card.
    expect(clean(deck.content).split("| Front | Back |").length - 1).toBe(1);
  });

  it("groups table cards by structure: a 2-col table and a separate 3-col table", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", notes: "informal", tableLayout: true }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye", tableLayout: true }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front | Back | Notes |\n| --- | --- | --- |");
    expect(clean(deck.content)).toContain("| Hallo | Hello | informal |");
    expect(clean(deck.content)).toContain("| Front | Back |\n| --- | --- |");
    expect(clean(deck.content)).toContain("| Tschüss | Bye |");
    // The no-notes card is NOT padded into the 3-col table.
    expect(clean(deck.content)).not.toContain("| Tschüss | Bye |  |");
  });

  it("renders a no-front media card as a table row (front cell = the image)", () => {
    const card = basic({ front: "![[img1.jpg]]", back: "![[img2.jpg]]", tableLayout: true });
    const [deck] = AnkiDeckRenderer.render([card], "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front | Back |\n| --- | --- |");
    expect(clean(deck.content)).toContain("| ![[img1.jpg]] | ![[img2.jpg]] |");
  });

  it("collapses a deck with >= 50 header-paragraph basics into a table", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "line a\nline b\nline c", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front | Back |");
    expect(clean(deck.content)).not.toContain("## Q0"); // no header-paragraph sections
  });

  it("keeps < 50 header-paragraph basics as header-paragraph sections", () => {
    const cards = Array.from({ length: 49 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "line a\nline b", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("## Q0");
    expect(clean(deck.content)).not.toContain("| Front | Back |");
  });

  it("does not promote block-markdown cards in the volume fallback", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "ans", tableLayout: false })
    );
    cards.push(
      basic({ noteId: 999, cardId: 999, front: "Truth table", back: "| A | B |\n| --- | --- |\n| w | f |", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front | Back |"); // the 50 plain cards aggregated
    expect(clean(deck.content)).toContain("## Truth table"); // the table card stays header-paragraph
    expect(clean(deck.content)).toContain("| A | B |\n| --- | --- |\n| w | f |"); // its table renders intact
  });

  it("keeps empty-back cards header-paragraph even above the volume threshold", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "ans", tableLayout: false })
    );
    cards.push(basic({ noteId: 999, cardId: 999, front: "OnlyFront", back: "", notes: "a note", tableLayout: false }));
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front | Back |"); // the 50 went into a table
    expect(clean(deck.content)).toContain("## OnlyFront"); // the empty-back one stayed header-paragraph
  });

  it("renders a templated cloze (with extras) as a tag-bound table", () => {
    const cloze = basic({
      isCloze: true,
      front: "Du trinkst ==jeden Tag== Bier.",
      back: "Du trinkst ==jeden Tag== Bier.",
      clozeBody: "Du trinkst ==jeden Tag== Bier.",
      clozeText: "jeden Tag",
      clozeOrder: 0,
      templateTag: "anki-tpl-cloze/m",
      templateRow: { headers: ["Text", "Extra"], cells: ["Du trinkst ==jeden Tag== Bier.", "![[img.jpg]]"] },
    });
    const [deck] = AnkiDeckRenderer.render([cloze], "decks/anki", 2);
    expect(clean(deck.content)).toContain("#anki-tpl-cloze/m");
    expect(clean(deck.content)).toContain("| Text | Extra |");
    expect(clean(deck.content)).toContain("| Du trinkst ==jeden Tag== Bier. | ![[img.jpg]] |");
  });

  it("emits a 1-col cloze table with the sentence as the cell", () => {
    const cloze = basic({
      isCloze: true,
      front: "header",
      back: "Du trinkst ==jeden Tag== Bier.",
      clozeBody: "Du trinkst ==jeden Tag== Bier.",
      clozeText: "jeden Tag",
      clozeOrder: 0,
    });
    const [deck] = AnkiDeckRenderer.render([cloze], "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Front |\n| --- |\n| Du trinkst ==jeden Tag== Bier. |");
  });

  it("escapes pipes and newlines in table cells", () => {
    const cards = [basic({ front: "a|b", back: "line1\nline2", tableLayout: true })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| a\\|b | line1<br>line2 |");
  });

  it("trims trailing whitespace in table cells (no padded columns)", () => {
    const cards = [basic({ front: "Q   ", back: "answer line   \n   more   ", tableLayout: true })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(clean(deck.content)).toContain("| Q | answer line<br>   more |");
    expect(clean(deck.content)).not.toContain("  |"); // no padded trailing whitespace before a pipe
  });

  it("renders template cards as a tag-bound multi-field table", () => {
    const tpl = basic({
      kind: "template",
      deckName: "Vocab",
      front: "火",
      back: "ひ",
      templateTag: "anki-tpl/vocab-0",
      templateRow: { headers: ["Word", "Reading", "Meaning"], cells: ["火", "ひ", "fire"] },
    });
    const [deck] = AnkiDeckRenderer.render([tpl], "decks/anki", 2);
    expect(clean(deck.content)).toContain("## Vocab #anki-tpl/vocab-0");
    expect(clean(deck.content)).toContain("| Word | Reading | Meaning |");
    expect(clean(deck.content)).toContain("| 火 | ひ | fire |");
  });

  it("renders occlusion cards as one decks-occlusion block per image", () => {
    const occ = (maskId: string): AnkiParsedCard =>
      basic({
        kind: "occlusion",
        deckName: "Anatomy",
        front: "![[heart.png]]",
        back: "",
        imageRef: "[[heart.png]]",
        imagePath: "heart.png",
        maskId,
        masks: [
          { id: "m1", x: 10, y: 20, w: 15, h: 8, answer: "" },
          { id: "m2", x: 50, y: 30, w: 12, h: 6, answer: "" },
        ],
      });
    const [deck] = AnkiDeckRenderer.render([occ("m1"), occ("m2")], "decks/anki", 2);
    expect(clean(deck.content)).toContain("```decks-occlusion");
    expect(clean(deck.content)).toContain("image: '[[heart.png]]'");
    expect(clean(deck.content)).toContain("id: m1");
    expect(clean(deck.content)).toContain("id: m2");
    // One block for the shared image (not one per mask).
    expect(clean(deck.content).split("```decks-occlusion").length - 1).toBe(1);
  });

  describe("note tags (grouped by tag-set)", () => {
    it("appends a card's tags to its header-paragraph header", () => {
      const cards = [basic({ front: "Hallo", back: "Hello", tags: ["greetings", "01-basics"] })];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      // Sorted, each prefixed with #.
      expect(clean(deck.content)).toContain("## Hallo #01-basics #greetings\n\nHello");
    });

    it("splits a table into one section per tag-set, tags on the header", () => {
      const cards = [
        basic({ front: "A", back: "1", tableLayout: true, tags: ["x"] }),
        basic({ noteId: 2, cardId: 11, front: "B", back: "2", tableLayout: true, tags: ["x"] }),
        basic({ noteId: 3, cardId: 12, front: "C", back: "3", tableLayout: true, tags: ["y"] }),
      ];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      // Two tables — #x groups A+B, #y has C.
      expect(clean(deck.content)).toContain("## Deck #x\n\n| Front | Back |\n| --- | --- |\n| A | 1 |\n| B | 2 |");
      expect(clean(deck.content)).toContain("## Deck #y\n\n| Front | Back |\n| --- | --- |\n| C | 3 |");
    });

    it("aggregates same-tag cards into a single table", () => {
      const cards = [
        basic({ front: "A", back: "1", tableLayout: true, tags: ["x"] }),
        basic({ noteId: 2, cardId: 11, front: "B", back: "2", tableLayout: true, tags: ["x"] }),
      ];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(clean(deck.content).match(/\| Front \| Back \|/g) ?? []).toHaveLength(1);
    });
  });

  describe("section ordering (by tag, then A–Z)", () => {
    it("orders untagged first, then tag groups A–Z, headers A–Z within each", () => {
      const cards = [
        basic({ noteId: 1, cardId: 1, front: "Zebra", back: "z" }),
        basic({ noteId: 2, cardId: 2, front: "Beta", back: "b", tags: ["alpha"] }),
        basic({ noteId: 3, cardId: 3, front: "Apple", back: "a", tags: ["alpha"] }),
        basic({ noteId: 4, cardId: 4, front: "Mango", back: "m" }),
        basic({ noteId: 5, cardId: 5, front: "Kiwi", back: "k", tags: ["beta"] }),
      ];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      const at = (h: string): number => clean(deck.content).indexOf(`## ${h}`);
      // Untagged (Mango, Zebra) come before any tagged section.
      expect(at("Mango")).toBeLessThan(at("Apple #alpha"));
      expect(at("Zebra")).toBeLessThan(at("Apple #alpha"));
      // Untagged sorted A–Z.
      expect(at("Mango")).toBeLessThan(at("Zebra"));
      // Within #alpha, A–Z.
      expect(at("Apple #alpha")).toBeLessThan(at("Beta #alpha"));
      // Tag groups A–Z: all #alpha before #beta.
      expect(at("Beta #alpha")).toBeLessThan(at("Kiwi #beta"));
    });
  });

  describe("multi-line cloze layout", () => {
    const longCloze = (over: Partial<AnkiParsedCard> = {}): AnkiParsedCard => {
      const body =
        "Plan d'étude d'un arc paramétré\n\na) ==Réduction de l'intervalle==\n\nb) ==Etude aux bornes==";
      return basic({ isCloze: true, front: body, back: body, clozeBody: body, clozeOrder: 0, ...over });
    };

    it("renders a multi-paragraph cloze with a title line as header-paragraph", () => {
      const [deck] = AnkiDeckRenderer.render([longCloze()], "decks/anki", 2);
      expect(clean(deck.content)).toContain(
        "## Plan d'étude d'un arc paramétré\n\na) ==Réduction de l'intervalle==\n\nb) ==Etude aux bornes=="
      );
      // No flattened table row for this card.
      expect(clean(deck.content)).not.toContain("<br><br>");
    });

    it("puts the cloze's tags on its header-paragraph header", () => {
      const [deck] = AnkiDeckRenderer.render([longCloze({ tags: ["09-courbes"] })], "decks/anki", 2);
      expect(clean(deck.content)).toContain("## Plan d'étude d'un arc paramétré #09-courbes\n\n");
    });

    it("keeps a short single-paragraph cloze in the 1-col table", () => {
      const short = basic({
        isCloze: true,
        front: "Du trinkst ==Bier==.",
        back: "Du trinkst ==Bier==.",
        clozeBody: "Du trinkst ==Bier==.",
        clozeOrder: 0,
      });
      const [deck] = AnkiDeckRenderer.render([short], "decks/anki", 2);
      expect(clean(deck.content)).toContain("| Front |\n| --- |\n| Du trinkst ==Bier==. |");
    });
  });

  describe("splitting large decks", () => {
    const CAP = 1000;
    // One single-card note per index (distinct noteId/cardId/front).
    const manyNotes = (count: number, deckName = "Spanish"): AnkiParsedCard[] =>
      Array.from({ length: count }, (_, i) =>
        basic({ noteId: i + 1, cardId: 1000 + i, deckName, front: `q${i}`, back: `a${i}` })
      );

    const cardIds = (decks: { cards: AnkiParsedCard[] }[]): number[] =>
      decks.flatMap((d) => d.cards.map((c) => c.cardId)).sort((a, b) => a - b);

    it("keeps a deck at the cap as a single unsuffixed file", () => {
      const decks = AnkiDeckRenderer.render(manyNotes(CAP), "decks/anki", 2);
      expect(decks).toHaveLength(1);
      expect(decks[0].relativePath).toBe("Spanish");
    });

    it("splits a deck over the cap into subfoldered, padded part-files", () => {
      const decks = AnkiDeckRenderer.render(manyNotes(CAP + 1), "decks/anki", 2);
      expect(decks).toHaveLength(2);
      expect(decks.map((d) => d.relativePath)).toEqual(["Spanish/Spanish 01", "Spanish/Spanish 02"]);
      // Same tag across chunks (identity is the path, not the tag).
      expect(new Set(decks.map((d) => d.tag))).toEqual(new Set(["decks/anki/spanish"]));
    });

    it("with split=false keeps an over-cap deck as one unsuffixed file", () => {
      const input = manyNotes(CAP + 1);
      const decks = AnkiDeckRenderer.render(input, "decks/anki", 2, false);
      expect(decks).toHaveLength(1);
      expect(decks[0].relativePath).toBe("Spanish");
      expect(decks[0].cards).toHaveLength(CAP + 1);
    });

    it("with split=false still separates subdecks into distinct files", () => {
      const cards = [
        basic({ deckName: "German::01 Hallo", front: "a" }),
        basic({ noteId: 2, cardId: 11, deckName: "German::02 Wetter", front: "b" }),
      ];
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2, false);
      expect(decks.map((d) => d.relativePath)).toEqual(["German/01 Hallo", "German/02 Wetter"]);
    });

    it("honors a custom cardsPerFile cap when splitting", () => {
      const decks = AnkiDeckRenderer.render(manyNotes(250), "decks/anki", 2, true, 100);
      expect(decks.map((d) => d.relativePath)).toEqual([
        "Spanish/Spanish 01",
        "Spanish/Spanish 02",
        "Spanish/Spanish 03",
      ]);
      expect(decks.map((d) => d.cards.length)).toEqual([100, 100, 50]);
      expect(Math.max(...decks.map((d) => d.cards.length))).toBeLessThanOrEqual(100);
    });

    it("ignores cardsPerFile when split=false (one file)", () => {
      const decks = AnkiDeckRenderer.render(manyNotes(250), "decks/anki", 2, false, 100);
      expect(decks).toHaveLength(1);
      expect(decks[0].relativePath).toBe("Spanish");
      expect(decks[0].cards).toHaveLength(250);
    });

    it("partitions every card exactly once across chunks", () => {
      const input = manyNotes(CAP + 1);
      const decks = AnkiDeckRenderer.render(input, "decks/anki", 2);
      const ids = cardIds(decks);
      expect(ids).toHaveLength(input.length);
      expect(new Set(ids).size).toBe(input.length); // no dupes
      expect(ids).toEqual(input.map((c) => c.cardId).sort((a, b) => a - b));
    });

    it("never splits a note across chunks (forward+reverse stay together)", () => {
      // 999 single-card notes, then one 2-card note straddling the cap boundary.
      const cards = [
        ...manyNotes(999),
        basic({ noteId: 5000, cardId: 9000, ord: 0, front: "fwd", back: "rev" }),
        basic({ noteId: 5000, cardId: 9001, ord: 1, front: "rev", back: "fwd" }),
      ];
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      const chunkWith = (id: number) => decks.findIndex((d) => d.cards.some((c) => c.cardId === id));
      const a = chunkWith(9000);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(chunkWith(9001)).toBe(a); // both halves of the note in one chunk
    });

    it("keeps all ords of a cloze note in one chunk with a single deduped entry", () => {
      const cloze = (ord: number, clozeText: string): AnkiParsedCard =>
        basic({
          noteId: 5000,
          cardId: 9000 + ord,
          ord,
          isCloze: true,
          front: "Ich ==trinke== ==Bier==.",
          back: "Ich ==trinke== ==Bier==.",
          clozeBody: "Ich ==trinke== ==Bier==.",
          clozeText,
          clozeOrder: ord,
        });
      const cards = [...manyNotes(999), cloze(0, "trinke"), cloze(1, "Bier")];
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      const idx = decks.findIndex((d) => d.cards.some((c) => c.cardId === 9000));
      expect(decks[idx].cards.filter((c) => c.cardId >= 9000)).toHaveLength(2);
      // The deduped cloze entry renders exactly once in that chunk.
      const occurrences = clean(decks[idx].content).split("Ich ==trinke== ==Bier==.").length - 1;
      expect(occurrences).toBe(1);
    });

    it("is deterministic regardless of input order", () => {
      const input = manyNotes(CAP + 5);
      const shuffled = [...input].reverse();
      const map = (decks: ReturnType<typeof AnkiDeckRenderer.render>) =>
        decks.map((d) => `${d.relativePath}:${d.cards.map((c) => c.cardId).sort((a, b) => a - b).join(",")}`);
      expect(map(AnkiDeckRenderer.render(shuffled, "decks/anki", 2))).toEqual(
        map(AnkiDeckRenderer.render(input, "decks/anki", 2))
      );
    });

    it("never splits a single oversized note", () => {
      const cards = Array.from({ length: CAP + 50 }, (_, i) =>
        basic({ noteId: 7, cardId: 100 + i, ord: i, front: `c${i}`, back: `b${i}` })
      );
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(decks).toHaveLength(1);
      expect(decks[0].cards).toHaveLength(CAP + 50);
    });

    const MEDIA_CAP = 500;
    const embeds = (decks: { cards: AnkiParsedCard[] }[]): number[] =>
      decks.map((d) => d.cards.reduce((s, c) => s + c.media.length, 0));

    it("splits on the media-embed budget even under the card cap", () => {
      // 600 single-card notes × 2 embeds = 1200 embeds > 500, but 600 ≤ 1000 cards.
      const cards = Array.from({ length: 600 }, (_, i) =>
        basic({ noteId: i + 1, cardId: 1000 + i, deckName: "Audio", front: `q${i}`, media: ["a.mp3", "b.mp3"] })
      );
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(decks.length).toBeGreaterThan(1);
      expect(decks[0].relativePath).toBe("Audio/Audio 01"); // subfoldered, not single file
      // Each file's embed total respects the budget (single notes are small).
      expect(Math.max(...embeds(decks))).toBeLessThanOrEqual(MEDIA_CAP);
      // Still partitions every card exactly once.
      expect(decks.flatMap((d) => d.cards).length).toBe(600);
    });

    it("keeps a media-light deck as one file (media cap inert)", () => {
      const cards = Array.from({ length: 300 }, (_, i) =>
        basic({ noteId: i + 1, cardId: 1000 + i, deckName: "Audio", front: `q${i}`, media: ["a.mp3"] })
      );
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(decks).toHaveLength(1); // 300 embeds ≤ 500, 300 cards ≤ 1000
      expect(decks[0].relativePath).toBe("Audio");
    });

    it("never splits a single note that alone exceeds the media budget", () => {
      const cards = Array.from({ length: 400 }, (_, i) =>
        basic({ noteId: 7, cardId: 100 + i, ord: i, front: `c${i}`, media: ["x.mp3", "y.mp3"] })
      );
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(decks).toHaveLength(1); // 800 embeds but one atomic note
      expect(decks[0].cards).toHaveLength(400);
    });
  });

  describe("front disambiguation", () => {
    it("leaves the same front in different decks alone: the tokens keep the ids apart", () => {
      const cards = [
        basic({ noteId: 1, cardId: 10, deckName: "Book::1", front: "object", back: "a thing" }),
        basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "object", back: "to protest" }),
      ];
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(clean(decks.find((d) => d.relativePath === "Book/1")!.content)).toContain("## object\n");
      expect(clean(decks.find((d) => d.relativePath === "Book/2")!.content)).toContain("## object\n");
      expect(AnkiDeckRenderer.decksCardId(cards[0])).not.toBe(AnkiDeckRenderer.decksCardId(cards[1]));
    });

    it("numbers the same front within one deck, deterministically regardless of input order", () => {
      const make = (): AnkiParsedCard[] => [
        basic({ noteId: 1, cardId: 10, front: "found", back: "past of find" }),
        basic({ noteId: 2, cardId: 20, front: "found", back: "to establish" }),
        basic({ noteId: 3, cardId: 30, front: "found", back: "molten metal" }),
      ];
      const forward = AnkiDeckRenderer.render(make(), "decks/anki", 2).map((d) => clean(d.content));
      const reversed = AnkiDeckRenderer.render(make().reverse(), "decks/anki", 2).map((d) => clean(d.content));
      expect(reversed).toEqual(forward);

      const cards = make();
      AnkiDeckRenderer.render(cards, "decks/anki", 2);
      // Lowest (noteId, ord, cardId) keeps the clean front; mutation is in place.
      expect(cards.find((c) => c.noteId === 1)!.front).toBe("found");
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("found (2)");
      expect(cards.find((c) => c.noteId === 3)!.front).toBe("found (3)");
    });

    it("skips a marker that would collide with a real '(2)' note in the same deck", () => {
      const cards = [
        basic({ noteId: 1, cardId: 10, front: "run", back: "a" }),
        basic({ noteId: 2, cardId: 20, front: "run", back: "b" }),
        basic({ noteId: 3, cardId: 30, front: "run (2)", back: "c" }),
      ];
      AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("run (3)");
      expect(cards.find((c) => c.noteId === 3)!.front).toBe("run (2)");
    });

    it("numbers template cards on cells[0] and front together", () => {
      const tmpl = (noteId: number, cardId: number): AnkiParsedCard =>
        basic({
          noteId,
          cardId,
          kind: "template",
          front: "cube",
          back: "a solid",
          templateRow: { headers: ["Word", "Def"], cells: ["cube", "a solid"] },
          templateTag: "model-0",
        });
      const cards = [tmpl(1, 10), tmpl(2, 20)];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      const second = cards.find((c) => c.noteId === 2)!;
      expect(second.front).toBe("cube (2)");
      expect(second.templateRow!.cells[0]).toBe("cube (2)");
      expect(cards.find((c) => c.noteId === 1)!.templateRow!.cells[0]).toBe("cube");
      expect(clean(deck.content)).toContain("| cube (2) |");
    });

    it("leaves cloze fronts untouched", () => {
      const cloze = (noteId: number, cardId: number): AnkiParsedCard =>
        basic({
          noteId,
          cardId,
          isCloze: true,
          front: "The ==sun== is a star.",
          back: "The ==sun== is a star.",
          clozeBody: "The ==sun== is a star.",
          clozeText: "sun",
          clozeOrder: 0,
        });
      const cards = [cloze(1, 10), cloze(2, 20)];
      AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(cards.every((c) => c.front === "The ==sun== is a star.")).toBe(true);
    });

    describe("on a re-import", () => {
      /** The id a render gives this card, from a copy so the card itself stays unrendered. */
      const idOf = (card: AnkiParsedCard): string => {
        const probe = { ...card };
        AnkiDeckRenderer.render([probe], "decks/anki", 2);
        return probe.decksId!;
      };
      const reimport = (cards: AnkiParsedCard[], earlierRows: AnkiEarlierRow[]): void => {
        AnkiDeckRenderer.render(cards, "decks/anki", 2, true, 1000, { earlierRows });
      };

      it("keeps a suffix an earlier import wrote for the card's id", () => {
        const card = basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "tie", back: "necktie" });
        const id = idOf(card);
        // The answer changed in Anki, so only the id ties this row to the card.
        const [deck] = AnkiDeckRenderer.render([card], "decks/anki", 2, true, 1000, {
          earlierRows: [{ id, front: "tie (2)", back: "a tie", path: "Book/2" }],
        });
        expect(card.front).toBe("tie (2)");
        expect(clean(deck.content)).toContain("## tie (2)\n");
      });

      it("drops a suffix whose card changed its front in Anki", () => {
        const card = basic({ noteId: 2, cardId: 20, front: "bow tie", back: "necktie" });
        reimport([card], [{ id: idOf(card), front: "tie (2)", back: "necktie", path: "Deck" }]);
        expect(card.front).toBe("bow tie");
      });

      it("never hands a card's own row to another card", () => {
        const renamed = basic({ noteId: 2, cardId: 20, front: "bow tie", back: "necktie" });
        const added = basic({ noteId: 3, cardId: 30, front: "tie", back: "necktie" });
        reimport([renamed, added], [{ id: idOf(renamed), front: "tie (2)", back: "necktie", path: "Deck" }]);
        expect(renamed.front).toBe("bow tie");
        expect(added.front).toBe("tie");
      });

      it("numbers a new duplicate past a suffix it kept", () => {
        const kept = basic({ noteId: 2, cardId: 20, front: "tie", back: "necktie" });
        const plain = basic({ noteId: 1, cardId: 10, front: "tie", back: "draw" });
        const added = basic({ noteId: 3, cardId: 30, front: "tie", back: "to fasten" });
        reimport([kept, plain, added], [{ id: idOf(kept), front: "tie (2)", back: "necktie", path: "Deck" }]);
        expect(kept.front).toBe("tie (2)");
        expect(plain.front).toBe("tie");
        expect(added.front).toBe("tie (3)");
      });

      it("numbers afresh when two cards of one deck would keep the same front", () => {
        // Note 4 was moved into this deck in Anki, where note 2 already has "w (2)".
        const a = basic({ noteId: 1, cardId: 10, front: "w", back: "a" });
        const b = basic({ noteId: 2, cardId: 20, front: "w", back: "b" });
        const d = basic({ noteId: 4, cardId: 40, front: "w", back: "d" });
        reimport([a, b, d], [
          { id: idOf(b), front: "w (2)", back: "b", path: "Deck" },
          { id: idOf(d), front: "w (2)", back: "d", path: "Other" },
        ]);
        expect([a.front, b.front, d.front]).toEqual(["w", "w (2)", "w (3)"]);
      });

      describe("over an import from before tokens (content ids, no bindings)", () => {
        it("gives each card the number it was written with, in the order numbers were given", () => {
          const tmpl = (ord: number): AnkiParsedCard =>
            basic({
              noteId: 1, cardId: 10 + ord, ord, kind: "template", front: "cube", back: "a solid",
              templateRow: { headers: ["Word", "Def"], cells: ["cube", "a solid"] }, templateTag: "m",
            });
          const cards = [tmpl(1), tmpl(0)];
          // Rows come back in id order, which says nothing about which card had which number.
          reimport(cards, [
            { id: "card_zzz", front: "cube", back: "a solid", path: "Deck" },
            { id: "card_aaa", front: "cube (2)", back: "a solid", path: "Deck" },
          ]);
          expect(cards.find((c) => c.ord === 0)!.front).toBe("cube");
          expect(cards.find((c) => c.ord === 1)!.front).toBe("cube (2)");
        });

        it("keeps the number each deck's file had", () => {
          const one = basic({ noteId: 1, cardId: 10, deckName: "Book::1", front: "tie", back: "necktie" });
          const two = basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "tie", back: "necktie" });
          reimport([one, two], [
            { id: "card_b", front: "tie (2)", back: "necktie", path: "Book/2" },
            { id: "card_a", front: "tie", back: "necktie", path: "Book/1" },
          ]);
          expect(one.front).toBe("tie");
          expect(two.front).toBe("tie (2)");
        });

        it("finds a card with an empty answer by the notes written as its answer", () => {
          const card = basic({ noteId: 2, cardId: 20, front: "w", back: "", notes: "some notes" });
          reimport([card], [{ id: "card_old", front: "w (2)", back: "some notes", path: "Deck" }]);
          expect(card.front).toBe("w (2)");
        });

        it("finds a row in one of the deck's part-files", () => {
          const card = basic({ noteId: 2, cardId: 20, deckName: "Book", front: "tie", back: "necktie" });
          reimport([card], [{ id: "card_old", front: "tie (2)", back: "necktie", path: "Book/Book 02" }]);
          expect(card.front).toBe("tie (2)");
        });
      });
    });
  });

  describe("anchor token emission", () => {
    it("writes a 64-bit id from the Anki note into an own-line h token", () => {
      const cards = [basic({ front: "Hallo", back: "Hello", deckName: "Deck" })];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);

      const id = AnkiDeckRenderer.decksCardId(cards[0]);
      expect(id).toBe(`card_${hash64(`anki:${cards[0].noteId}:${cards[0].ord}`)}`);
      const value = encodeAnchorValue("a", [id])!;
      expect(value.startsWith("0ad")).toBe(true);
      expect(deck.content).toContain(`Hello\n%%dk:h:${value}%%`);
      expect(deck.bindings).toContainEqual({ anchor: `h:${value}`, flashcardId: id });
    });

    it("emits a t token in the first cell for table cards", () => {
      const cards = [
        basic({ front: "Hallo", back: "Hello", deckName: "Deck", tableLayout: true }),
      ];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);

      const value = encodeAnchorValue("a", [AnkiDeckRenderer.decksCardId(cards[0])])!;
      expect(deck.content).toContain(`| Hallo %%dk:t:${value}%% | Hello |`);
    });

    it("packs every deletion of a 1-col cloze table row, each Anki card keyed to its own", () => {
      const sentence = "Du trinkst ==jeden Tag== ==Bier==.";
      const cards = [0, 1].map((ord) =>
        basic({
          noteId: 7,
          cardId: 70 + ord,
          ord,
          isCloze: true,
          clozeBody: sentence,
          back: sentence,
          clozeText: ord === 0 ? "jeden Tag" : "Bier",
          clozeOrder: ord,
          deckName: "Deck",
        })
      );
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);

      const ids = cards.map((c) => AnkiDeckRenderer.decksCardId(c));
      expect(ids[0]).toBe(`ccard_${hash64("anki:7:c0")}`);
      expect(deck.content).toContain(`| ${sentence} %%dk:t:${encodeAnchorValue("p", ids)}%% |`);
    });

    it("keeps the ids an earlier import's bindings pinned", () => {
      const sentence = "Du trinkst ==jeden Tag== ==Bier==.";
      const cards = [
        basic({ noteId: 3, ord: 0, front: "Hallo", back: "Hello", deckName: "Deck" }),
        ...[0, 1].map((ord) =>
          basic({
            noteId: 7,
            cardId: 70 + ord,
            ord,
            isCloze: true,
            clozeBody: sentence,
            back: sentence,
            clozeText: ord === 0 ? "jeden Tag" : "Bier",
            clozeOrder: ord,
            deckName: "Deck",
          })
        ),
      ];
      const pins = new Map([
        [`h:${AnkiDeckRenderer.legacyAnchorValue(3, 0)}`, "card_old1"],
        [`t:${AnkiDeckRenderer.legacyAnchorValue(7, 0)}#1`, "ccard_old2"],
      ]);
      AnkiDeckRenderer.render(cards, "decks/anki", 2, true, 1000, { pins });

      expect(AnkiDeckRenderer.decksCardId(cards[0])).toBe("card_old1");
      expect(AnkiDeckRenderer.decksCardId(cards[1])).toBe(`ccard_${hash64("anki:7:c0")}`);
      expect(AnkiDeckRenderer.decksCardId(cards[2])).toBe("ccard_old2");
    });

    it("re-renders byte-identically (tokens and bindings are deterministic)", () => {
      const cards = () => [
        basic({ front: "Hallo", back: "Hello", deckName: "Deck" }),
        basic({ noteId: 2, cardId: 20, front: "Tschüss", back: "Bye", deckName: "Deck", tableLayout: true }),
      ];
      const first = AnkiDeckRenderer.render(cards(), "decks/anki", 2);
      const second = AnkiDeckRenderer.render(cards(), "decks/anki", 2);

      expect(second[0].content).toBe(first[0].content);
      expect(second[0].bindings).toEqual(first[0].bindings);
    });
  });
});
