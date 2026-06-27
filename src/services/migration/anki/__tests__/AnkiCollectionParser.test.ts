import { AnkiCollectionParser } from "../AnkiCollectionParser";
import type { RawDatabase, RawStatement } from "../../../FlashcardSynchronizer";

type Row = Record<string, string | number>;

// Minimal RawDatabase that answers the parser's prepared statements from
// in-memory tables, matching on a substring of the SQL.
function makeFakeDb(tables: {
  models: unknown;
  decks: unknown;
  cardNotes: Row[];
  crt?: number;
  revlog?: Row[];
}): RawDatabase {
  const rowsFor = (sql: string): Row[] => {
    if (sql.includes("models AS value")) return [{ value: JSON.stringify(tables.models) }];
    if (sql.includes("decks AS value")) return [{ value: JSON.stringify(tables.decks) }];
    if (sql.includes("crt AS crt")) return [{ crt: tables.crt ?? 0 }];
    if (sql.includes("FROM cards c JOIN notes")) return tables.cardNotes;
    if (sql.includes("FROM revlog")) return tables.revlog ?? [];
    return [];
  };
  return {
    prepare(sql: string): RawStatement {
      const rows = rowsFor(sql);
      let index = -1;
      return {
        bind: () => true,
        step: () => ++index < rows.length,
        get: () => [],
        getAsObject: () => rows[index] as Record<string, string | number>,
        run: () => undefined,
        free: () => undefined,
      };
    },
    run: () => undefined,
  };
}

const SEP = "\x1f";

// 2-field model → basic front/back path (≤2 fields).
const BASIC_MODEL = {
  id: "m1",
  name: "Basic",
  type: 0,
  flds: [{ name: "German" }, { name: "English" }],
  tmpls: [
    { name: "Card 1", ord: 0, qfmt: "{{German}}", afmt: "{{FrontSide}}<hr id=answer>{{English}}" },
    { name: "Card 2", ord: 1, qfmt: "{{English}}", afmt: "{{FrontSide}}<hr id=answer>{{German}}" },
  ],
};

// >2-field model → template-bound table-row path.
const MULTI_MODEL = {
  id: "m1",
  name: "Vocabulary",
  type: 0,
  flds: [{ name: "Word" }, { name: "Reading" }, { name: "Meaning" }],
  tmpls: [
    {
      name: "Card 1",
      ord: 0,
      qfmt: "<b>{{Word}}</b>",
      afmt: "{{FrontSide}}<hr id=answer>{{Reading}} — {{Meaning}}",
    },
  ],
};

const CLOZE_MODEL = {
  id: "m2",
  name: "Cloze",
  type: 1,
  flds: [{ name: "ID" }, { name: "Text" }, { name: "Translation" }],
  tmpls: [{ name: "Cloze", ord: 0, qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}{{Translation}}" }],
};

const DECKS = {
  "1": { id: "1", name: "Default" },
  "10": { id: "10", name: "German::01 Hallo" },
};

describe("AnkiCollectionParser", () => {
  it("maps field roles for forward and reverse templates (2-field basic)", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Das Wetter", "The weather"] }),
        cardNote({ cid: 2, nid: 1, ord: 1, mid: "m1", flds: ["Das Wetter", "The weather"] }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cardCount).toBe(2);

    const forward = result.cards.find((c) => c.ord === 0);
    expect(forward?.kind).toBe("basic");
    expect(forward?.front).toBe("Das Wetter");
    expect(forward?.back).toBe("The weather");

    const reverse = result.cards.find((c) => c.ord === 1);
    expect(reverse?.front).toBe("The weather");
    expect(reverse?.back).toBe("Das Wetter");
  });

  it("rewrites image/audio fields to embeds and collects media (basic)", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ['haben<img src="img.jpg">', "to have[sound:a.mp3]"] }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cards[0].front).toBe("haben"); // header stays text-only
    expect(result.cards[0].back).toContain("to have");
    expect(result.cards[0].back).toContain("![[a.mp3]]"); // audio on the answer side
    expect(result.cards[0].notes).toContain("![[img.jpg]]"); // front-side image relocated to notes
    expect(result.mediaFiles).toEqual(["a.mp3", "img.jpg"]);
  });

  it("escalates a compact single-paragraph basic card to a table layout", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Hund", "dog"] })],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.kind).toBe("basic");
    expect(card.tableLayout).toBe(true);
  });

  it("keeps a multi-paragraph basic answer as header-paragraph (no table)", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Q", "line one<br><br>line two"] })],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.back).toContain("\n\n"); // genuinely multi-paragraph
    expect(card.tableLayout).toBe(false);
  });

  it("uses the front media as the front (no synthetic 'Card <id>' header) for a front-less card", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ['<img src="img1.jpg">', '<img src="img2.jpg">'] }),
      ],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.kind).toBe("basic");
    expect(card.front).toBe("![[img1.jpg]]");
    expect(card.back).toBe("![[img2.jpg]]");
    expect(card.front).not.toMatch(/^Card /);
    expect(card.tableLayout).toBe(true);
  });

  it("imports a >2-field model as a template-bound table row", () => {
    const db = makeFakeDb({
      models: { m1: MULTI_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m1", flds: ["火", "ひ", "fire"] })],
    });
    const result = AnkiCollectionParser.parse(db);
    const card = result.cards[0];
    expect(card.kind).toBe("template");
    expect(card.templateRow?.headers).toEqual(["Word", "Reading", "Meaning"]);
    expect(card.templateRow?.cells).toEqual(["火", "ひ", "fire"]);
    expect(card.templateTag).toBe("anki-tpl/vocabulary-0");

    // A template file is generated for the model, keeping {{Field}} refs.
    expect(result.templateFiles).toHaveLength(1);
    const tpl = result.templateFiles[0];
    expect(tpl.tag).toBe("anki-tpl/vocabulary-0");
    expect(tpl.content).toContain("```decks-html-front");
    expect(tpl.content).toContain("<b>{{Word}}</b>");
    expect(tpl.content).toContain("{{Reading}} — {{Meaning}}");
  });

  it("skips image-occlusion notes when no media reader is provided", () => {
    const ioModel = {
      id: "m4",
      name: "Image Occlusion Enhanced",
      type: 0,
      flds: [{ name: "ID" }, { name: "Image" }, { name: "Question Mask" }],
      tmpls: [{ name: "IO", ord: 0, qfmt: '<div id="io-overlay">{{Question Mask}}</div>', afmt: "{{FrontSide}}" }],
    };
    const db = makeFakeDb({
      models: { m4: ioModel },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m4", flds: ["x-oa-1", '<img src="b.png">', "mask"] })],
    });
    expect(AnkiCollectionParser.parse(db).cardCount).toBe(0);
  });

  it("imports image-occlusion notes as occlusion cards via the SVG masks", () => {
    const ioModel = {
      id: "m4",
      name: "Image Occlusion Enhanced",
      type: 0,
      flds: [{ name: "ID" }, { name: "Image" }, { name: "Question Mask" }, { name: "Original Mask" }],
      tmpls: [{ name: "IO", ord: 0, qfmt: '<div id="io-overlay">x</div>', afmt: "{{FrontSide}}" }],
    };
    const svg =
      '<svg width="100" height="50"><g><title>Masks</title>' +
      '<rect id="x-oa-1" x="10" y="5" width="20" height="10"/>' +
      '<rect id="x-oa-2" x="50" y="25" width="30" height="20"/></g></svg>';
    const db = makeFakeDb({
      models: { m4: ioModel },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m4", flds: ["x-oa-1", '<img src="b.png">', '<img src="x-oa-1-Q.svg">', '<img src="x-oa-O.svg">'] }),
        cardNote({ cid: 2, nid: 2, did: "10", ord: 0, mid: "m4", flds: ["x-oa-2", '<img src="b.png">', '<img src="x-oa-2-Q.svg">', '<img src="x-oa-O.svg">'] }),
      ],
    });
    const getMediaText = (name: string): string | undefined => (name === "x-oa-O.svg" ? svg : undefined);
    const result = AnkiCollectionParser.parse(db, { getMediaText });
    expect(result.cards).toHaveLength(2);
    const card = result.cards[0];
    expect(card.kind).toBe("occlusion");
    expect(card.imagePath).toBe("b.png");
    expect(card.masks).toHaveLength(2);
    expect(card.masks?.[0]).toMatchObject({ id: "x-oa-1", x: 10, y: 10, w: 20, h: 20, answer: "" });
    expect(result.cards.map((c) => c.maskId).sort()).toEqual(["x-oa-1", "x-oa-2"]);
    expect(result.mediaFiles).toContain("b.png");
  });

  it("converts cloze notes to ==highlight== bodies", () => {
    const db = makeFakeDb({
      models: { m2: CLOZE_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({
          cid: 1,
          nid: 5,
          did: "10",
          ord: 0,
          mid: "m2",
          flds: ["id-5", "Du trinkst {{c1::jeden Tag}} Bier.", "You drink beer every day."],
        }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    const cloze = result.cards[0];
    expect(cloze.isCloze).toBe(true);
    expect(cloze.clozeBody).toBe("Du trinkst ==jeden Tag== Bier.");
    expect(cloze.clozeText).toBe("jeden Tag");
    // Front is the cloze sentence (drives the id); the Translation extra binds a template.
    expect(cloze.front).toBe("Du trinkst ==jeden Tag== Bier.");
    expect(cloze.templateRow?.headers).toEqual(["Text", "Translation"]);
    expect(cloze.templateRow?.cells).toEqual(["Du trinkst ==jeden Tag== Bier.", "You drink beer every day."]);
    expect(cloze.templateTag).toBe("anki-tpl-cloze/cloze");
    const tpl = result.templateFiles.find((t) => t.tag === "anki-tpl-cloze/cloze");
    expect(tpl?.content).toContain("```decks-md-front\n{{Text}}\n```");
    expect(tpl?.content).toContain("```decks-md-notes\n{{Translation}}\n```");
  });

  it("emits a pure cloze (no extras) without a template, multi-line per line", () => {
    const plainCloze = {
      id: "m5",
      name: "Cloze",
      type: 1,
      flds: [{ name: "Text" }],
      tmpls: [{ name: "Cloze", ord: 0, qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}" }],
    };
    const db = makeFakeDb({
      models: { m5: plainCloze },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m5", flds: ["List the types<br>{{c1::Mono<br>Oligo}}"] }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    const card = result.cards[0];
    expect(card.templateRow).toBeUndefined();
    expect(card.front).toBe(card.clozeBody);
    // Multi-line cloze answer → one highlight per line.
    expect(card.clozeBody).toContain("==Mono==");
    expect(card.clozeBody).toContain("==Oligo==");
    expect(result.templateFiles).toHaveLength(0);
  });

  it("resolves deck names and counts notes", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m1", flds: ["a", "b"] })],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cards[0].deckName).toBe("German::01 Hallo");
    expect(result.noteCount).toBe(1);
  });
});

function cardNote(opts: {
  cid: number;
  nid: number;
  did?: string;
  ord: number;
  mid: string;
  flds: string[];
  ivl?: number;
  reps?: number;
}): Row {
  return {
    cid: opts.cid,
    nid: opts.nid,
    did: opts.did ?? "1",
    ord: opts.ord,
    ctype: 0,
    queue: 0,
    due: 0,
    ivl: opts.ivl ?? 0,
    factor: 0,
    reps: opts.reps ?? 0,
    lapses: 0,
    data: "{}",
    mid: opts.mid,
    flds: opts.flds.join(SEP),
  };
}
