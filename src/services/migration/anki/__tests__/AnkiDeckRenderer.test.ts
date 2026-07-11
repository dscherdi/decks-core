import { AnkiDeckRenderer } from "../AnkiDeckRenderer";
import type { AnkiParsedCard, AnkiScheduling } from "../AnkiTypes";

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
    expect(deck.content).toContain("tags:\n  - decks/anki/german/01-hallo");
    expect(deck.content).toContain("## Hallo\n\nHello");
    expect(deck.content).toContain("## Tschüss\n\nBye");
  });

  it("keeps forward and reverse templates as independent entries", () => {
    const cards = [
      basic({ ord: 0, front: "Das Wetter", back: "The weather" }),
      basic({ cardId: 11, ord: 1, front: "The weather", back: "Das Wetter" }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Das Wetter\n\nThe weather");
    expect(deck.content).toContain("## The weather\n\nDas Wetter");
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
    expect(decks[0].content).toContain("| Front |\n| --- |");
    // Same note → one row.
    const occurrences = decks[0].content.split("Du trinkst ==jeden Tag== ==Bier==.").length - 1;
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
    expect(deck.content).toContain("## Hallo\n\nHello\n\n---\n\ninformal greeting");
  });

  it("promotes notes into back when back is empty (no dangling ---)", () => {
    const cards = [basic({ front: "Hallo", back: "", notes: "only notes" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Hallo\n\nonly notes");
    expect(deck.content).not.toContain("---\n\n");
  });

  it("aggregates table-routed cards (no notes) into a single 2-col table", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", tableLayout: true }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye", tableLayout: true }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| Hallo | Hello |");
    expect(deck.content).toContain("| Tschüss | Bye |");
    expect(deck.content).not.toContain("| Notes |");
    // One aggregated table, not one per card.
    expect(deck.content.split("| Front | Back |").length - 1).toBe(1);
  });

  it("groups table cards by structure: a 2-col table and a separate 3-col table", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", notes: "informal", tableLayout: true }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye", tableLayout: true }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back | Notes |\n| --- | --- | --- |");
    expect(deck.content).toContain("| Hallo | Hello | informal |");
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| Tschüss | Bye |");
    // The no-notes card is NOT padded into the 3-col table.
    expect(deck.content).not.toContain("| Tschüss | Bye |  |");
  });

  it("renders a no-front media card as a table row (front cell = the image)", () => {
    const card = basic({ front: "![[img1.jpg]]", back: "![[img2.jpg]]", tableLayout: true });
    const [deck] = AnkiDeckRenderer.render([card], "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| ![[img1.jpg]] | ![[img2.jpg]] |");
  });

  it("collapses a deck with >= 50 header-paragraph basics into a table", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "line a\nline b\nline c", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |");
    expect(deck.content).not.toContain("## Q0"); // no header-paragraph sections
  });

  it("keeps < 50 header-paragraph basics as header-paragraph sections", () => {
    const cards = Array.from({ length: 49 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "line a\nline b", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Q0");
    expect(deck.content).not.toContain("| Front | Back |");
  });

  it("does not promote block-markdown cards in the volume fallback", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "ans", tableLayout: false })
    );
    cards.push(
      basic({ noteId: 999, cardId: 999, front: "Truth table", back: "| A | B |\n| --- | --- |\n| w | f |", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |"); // the 50 plain cards aggregated
    expect(deck.content).toContain("## Truth table"); // the table card stays header-paragraph
    expect(deck.content).toContain("| A | B |\n| --- | --- |\n| w | f |"); // its table renders intact
  });

  it("keeps empty-back cards header-paragraph even above the volume threshold", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "ans", tableLayout: false })
    );
    cards.push(basic({ noteId: 999, cardId: 999, front: "OnlyFront", back: "", notes: "a note", tableLayout: false }));
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |"); // the 50 went into a table
    expect(deck.content).toContain("## OnlyFront"); // the empty-back one stayed header-paragraph
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
    expect(deck.content).toContain("#anki-tpl-cloze/m");
    expect(deck.content).toContain("| Text | Extra |");
    expect(deck.content).toContain("| Du trinkst ==jeden Tag== Bier. | ![[img.jpg]] |");
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
    expect(deck.content).toContain("| Front |\n| --- |\n| Du trinkst ==jeden Tag== Bier. |");
  });

  it("escapes pipes and newlines in table cells", () => {
    const cards = [basic({ front: "a|b", back: "line1\nline2", tableLayout: true })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| a\\|b | line1<br>line2 |");
  });

  it("trims trailing whitespace in table cells (no padded columns)", () => {
    const cards = [basic({ front: "Q   ", back: "answer line   \n   more   ", tableLayout: true })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Q | answer line<br>   more |");
    expect(deck.content).not.toContain("  |"); // no padded trailing whitespace before a pipe
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
    expect(deck.content).toContain("## Vocab #anki-tpl/vocab-0");
    expect(deck.content).toContain("| Word | Reading | Meaning |");
    expect(deck.content).toContain("| 火 | ひ | fire |");
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
    expect(deck.content).toContain("```decks-occlusion");
    expect(deck.content).toContain("image: '[[heart.png]]'");
    expect(deck.content).toContain("id: m1");
    expect(deck.content).toContain("id: m2");
    // One block for the shared image (not one per mask).
    expect(deck.content.split("```decks-occlusion").length - 1).toBe(1);
  });

  describe("note tags (grouped by tag-set)", () => {
    it("appends a card's tags to its header-paragraph header", () => {
      const cards = [basic({ front: "Hallo", back: "Hello", tags: ["greetings", "01-basics"] })];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      // Sorted, each prefixed with #.
      expect(deck.content).toContain("## Hallo #01-basics #greetings\n\nHello");
    });

    it("splits a table into one section per tag-set, tags on the header", () => {
      const cards = [
        basic({ front: "A", back: "1", tableLayout: true, tags: ["x"] }),
        basic({ noteId: 2, cardId: 11, front: "B", back: "2", tableLayout: true, tags: ["x"] }),
        basic({ noteId: 3, cardId: 12, front: "C", back: "3", tableLayout: true, tags: ["y"] }),
      ];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      // Two tables — #x groups A+B, #y has C.
      expect(deck.content).toContain("## Deck #x\n\n| Front | Back |\n| --- | --- |\n| A | 1 |\n| B | 2 |");
      expect(deck.content).toContain("## Deck #y\n\n| Front | Back |\n| --- | --- |\n| C | 3 |");
    });

    it("aggregates same-tag cards into a single table", () => {
      const cards = [
        basic({ front: "A", back: "1", tableLayout: true, tags: ["x"] }),
        basic({ noteId: 2, cardId: 11, front: "B", back: "2", tableLayout: true, tags: ["x"] }),
      ];
      const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(deck.content.match(/\| Front \| Back \|/g) ?? []).toHaveLength(1);
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
      const at = (h: string): number => deck.content.indexOf(`## ${h}`);
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
      expect(deck.content).toContain(
        "## Plan d'étude d'un arc paramétré\n\na) ==Réduction de l'intervalle==\n\nb) ==Etude aux bornes=="
      );
      // No flattened table row for this card.
      expect(deck.content).not.toContain("<br><br>");
    });

    it("puts the cloze's tags on its header-paragraph header", () => {
      const [deck] = AnkiDeckRenderer.render([longCloze({ tags: ["09-courbes"] })], "decks/anki", 2);
      expect(deck.content).toContain("## Plan d'étude d'un arc paramétré #09-courbes\n\n");
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
      expect(deck.content).toContain("| Front |\n| --- |\n| Du trinkst ==Bier==. |");
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
      const occurrences = decks[idx].content.split("Ich ==trinke== ==Bier==.").length - 1;
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
    it("appends a marker to identical basic fronts across sub-decks", () => {
      const cards = [
        basic({ noteId: 1, cardId: 10, deckName: "Book::1", front: "object", back: "a thing" }),
        basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "object", back: "to protest" }),
      ];
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      const d1 = decks.find((d) => d.relativePath === "Book/1")!;
      const d2 = decks.find((d) => d.relativePath === "Book/2")!;
      expect(d1.content).toContain("## object\n");
      expect(d2.content).toContain("## object (2)\n");
      // Lowest (noteId, ord, cardId) keeps the clean front; mutation is in place.
      expect(cards.find((c) => c.noteId === 1)!.front).toBe("object");
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("object (2)");
    });

    it("assigns markers deterministically regardless of input order", () => {
      const make = (): AnkiParsedCard[] => [
        basic({ noteId: 1, cardId: 10, deckName: "Book::1", front: "found", back: "past of find" }),
        basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "found", back: "to establish" }),
        basic({ noteId: 3, cardId: 30, deckName: "Book::3", front: "found", back: "molten metal" }),
      ];
      const forward = AnkiDeckRenderer.render(make(), "decks/anki", 2).map((d) => d.content);
      const reversed = AnkiDeckRenderer.render(make().reverse(), "decks/anki", 2).map((d) => d.content);
      expect(reversed).toEqual(forward);

      const cards = make();
      AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(cards.find((c) => c.noteId === 1)!.front).toBe("found");
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("found (2)");
      expect(cards.find((c) => c.noteId === 3)!.front).toBe("found (3)");
    });

    it("skips a synthetic marker that would collide with a real '(2)' note", () => {
      const cards = [
        basic({ noteId: 1, cardId: 10, deckName: "Book::1", front: "run", back: "a" }),
        basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "run", back: "b" }),
        basic({ noteId: 3, cardId: 30, deckName: "Book::3", front: "run (2)", back: "c" }),
      ];
      AnkiDeckRenderer.render(cards, "decks/anki", 2);
      // noteId 2's "run" would become "run (2)", but that front already exists →
      // it skips to "run (3)". The real "run (2)" is left as-is.
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("run (3)");
      expect(cards.find((c) => c.noteId === 3)!.front).toBe("run (2)");
    });

    it("suffixes every occurrence of a RESERVED front (taken by another vault deck)", () => {
      const cards = [
        basic({ noteId: 1, cardId: 10, front: "tie", back: "necktie" }),
        basic({ noteId: 2, cardId: 20, front: "sphere", back: "a ball" }),
      ];
      AnkiDeckRenderer.render(cards, "decks/anki", 2, true, 1000, new Set(["tie"]));
      // "tie" already lives in another deck → the imported one becomes its own
      // card instead of being silently merged; unrelated fronts untouched.
      expect(cards.find((c) => c.noteId === 1)!.front).toBe("tie (2)");
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("sphere");
    });

    it("numbers reserved + within-batch duplicates consecutively", () => {
      const cards = [
        basic({ noteId: 1, cardId: 10, deckName: "Book::1", front: "tie", back: "necktie" }),
        basic({ noteId: 2, cardId: 20, deckName: "Book::2", front: "tie", back: "draw result" }),
      ];
      AnkiDeckRenderer.render(cards, "decks/anki", 2, true, 1000, new Set(["tie"]));
      expect(cards.find((c) => c.noteId === 1)!.front).toBe("tie (2)");
      expect(cards.find((c) => c.noteId === 2)!.front).toBe("tie (3)");
    });

    it("keeps a reserved template card's front and cells[0] in lockstep", () => {
      const card = basic({
        noteId: 1,
        cardId: 10,
        kind: "template",
        front: "cube",
        back: "a solid",
        templateRow: { headers: ["Word", "Meaning"], cells: ["cube", "a solid"] },
        templateTag: "anki-tmpl-x",
      });
      AnkiDeckRenderer.render([card], "decks/anki", 2, true, 1000, new Set(["cube"]));
      expect(card.front).toBe("cube (2)");
      expect(card.templateRow!.cells[0]).toBe("cube (2)");
    });

    it("a reserved '(2)' variant pushes the synthetic marker to '(3)'", () => {
      const cards = [basic({ noteId: 1, cardId: 10, front: "run", back: "a" })];
      AnkiDeckRenderer.render(cards, "decks/anki", 2, true, 1000, new Set(["run", "run (2)"]));
      expect(cards[0].front).toBe("run (3)");
    });

    it("disambiguates template cards on cells[0] and front together", () => {
      const tmpl = (noteId: number, cardId: number, deckName: string): AnkiParsedCard =>
        basic({
          noteId,
          cardId,
          deckName,
          kind: "template",
          front: "cube",
          back: "a solid",
          templateRow: { headers: ["Word", "Def"], cells: ["cube", "a solid"] },
          templateTag: "model-0",
        });
      const cards = [tmpl(1, 10, "Book::1"), tmpl(2, 20, "Book::2")];
      const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
      const second = cards.find((c) => c.noteId === 2)!;
      expect(second.front).toBe("cube (2)");
      expect(second.templateRow!.cells[0]).toBe("cube (2)");
      expect(cards.find((c) => c.noteId === 1)!.templateRow!.cells[0]).toBe("cube");
      expect(decks.find((d) => d.relativePath === "Book/2")!.content).toContain("| cube (2) |");
    });

    it("leaves cloze fronts untouched", () => {
      const cloze = (noteId: number, cardId: number, deckName: string): AnkiParsedCard =>
        basic({
          noteId,
          cardId,
          deckName,
          isCloze: true,
          front: "The ==sun== is a star.",
          back: "The ==sun== is a star.",
          clozeBody: "The ==sun== is a star.",
          clozeText: "sun",
          clozeOrder: 0,
        });
      const cards = [cloze(1, 10, "Book::1"), cloze(2, 20, "Book::2")];
      AnkiDeckRenderer.render(cards, "decks/anki", 2);
      expect(cards.every((c) => c.front === "The ==sun== is a star.")).toBe(true);
    });
  });
});
