import { AnkiCollectionParser, parseAnkiTags } from "../AnkiCollectionParser";
import type { RawDatabase, RawStatement } from "../../../FlashcardSynchronizer";

type Row = Record<string, string | number | Uint8Array>;

describe("parseAnkiTags", () => {
  it("splits on whitespace and trims Anki's surrounding spaces", () => {
    expect(parseAnkiTags(" math science ")).toEqual(["math", "science"]);
  });
  it("converts :: hierarchy to /", () => {
    expect(parseAnkiTags("subject::algebra::groups")).toEqual(["subject/algebra/groups"]);
  });
  it("keeps tags that start with a digit", () => {
    expect(parseAnkiTags("09-Courbes-en-representation-parametrique")).toEqual([
      "09-Courbes-en-representation-parametrique",
    ]);
  });
  it("drops all-numeric tags (invalid in Obsidian)", () => {
    expect(parseAnkiTags("123 2024")).toEqual([]);
  });
  it("keeps Unicode (accented) letters", () => {
    expect(parseAnkiTags("00-Trigonométrie Algèbre")).toEqual(["00-Trigonométrie", "Algèbre"]);
  });
  it("sanitizes illegal characters to - and de-dupes", () => {
    expect(parseAnkiTags("a!b a!b")).toEqual(["a-b"]);
  });
  it("returns an empty array for empty input", () => {
    expect(parseAnkiTags("")).toEqual([]);
  });
});

// Minimal RawDatabase that answers the parser's prepared statements from
// in-memory tables, matching on a substring of the SQL.
function makeFakeDb(tables: {
  models: unknown;
  decks: unknown;
  cardNotes: Row[];
  crt?: number;
  revlog?: Row[];
  // Schema-18 normalized tables (used when models/decks JSON is empty).
  notetypes?: Row[];
  templates?: Row[];
  fieldRows?: Row[];
  deckRows?: Row[];
}): RawDatabase {
  const rowsFor = (sql: string): Row[] => {
    if (sql.includes("models AS value")) return [{ value: JSON.stringify(tables.models) }];
    if (sql.includes("decks AS value")) return [{ value: JSON.stringify(tables.decks) }];
    if (sql.includes("crt AS crt")) return [{ crt: tables.crt ?? 0 }];
    if (sql.includes("FROM cards c JOIN notes")) return tables.cardNotes;
    if (sql.includes("FROM revlog")) return tables.revlog ?? [];
    if (sql.includes("FROM fields")) return tables.fieldRows ?? [];
    if (sql.includes("FROM templates")) return tables.templates ?? [];
    if (sql.includes("FROM notetypes")) return tables.notetypes ?? [];
    if (sql.includes("FROM decks")) return tables.deckRows ?? [];
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

// Tiny protobuf encoders to build schema-18 config blobs in tests.
function pbVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}
function pbStr(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [(field << 3) | 2, ...pbVarint(bytes.length), ...bytes];
}
function pbInt(field: number, value: number): number[] {
  return [(field << 3) | 0, ...pbVarint(value)];
}
// CardTemplateConfig: f1 = qfmt, f2 = afmt.
function tmplConfig(qfmt: string, afmt: string): Uint8Array {
  return new Uint8Array([...pbStr(1, qfmt), ...pbStr(2, afmt)]);
}
// NotetypeConfig: f1 = kind (1 = cloze), f3 = css.
function notetypeConfig(kind: number, css: string): Uint8Array {
  return new Uint8Array([...(kind ? pbInt(1, kind) : []), ...pbStr(3, css)]);
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

  it("keeps a back with a block-math ($$) answer as header-paragraph", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Prove f=R/2", "Then \\[f=R/2\\] holds."] })],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.back).toContain("$$"); // MathJax \[…\] → $$…$$ block
    expect(card.tableLayout).toBe(false);
  });

  it("keeps a long single-paragraph answer (> 300 chars) as header-paragraph", () => {
    const long = "word ".repeat(80).trim(); // ~400 chars, one line
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Q", long] })],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.back.length).toBeGreaterThan(300);
    expect(card.tableLayout).toBe(false);
  });

  it("keeps a many-line (> 4) soft-wrapped answer as header-paragraph", () => {
    const db = makeFakeDb({
      models: { m1: BASIC_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Q", "a<br>b<br>c<br>d<br>e<br>f"] })],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.back.split("\n").length).toBeGreaterThan(4);
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

  it("imports a >2-field model WITHOUT layout CSS as a basic card (no template)", () => {
    const db = makeFakeDb({
      models: { m1: MULTI_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m1", flds: ["火", "ひ", "fire"] })],
    });
    const result = AnkiCollectionParser.parse(db);
    const card = result.cards[0];
    expect(card.kind).toBe("basic"); // no rich CSS → basic (markdown), not a template
    expect(card.front).toBe("火"); // qfmt {{Word}}
    expect(card.back).toContain("ひ"); // afmt {{Reading}} — {{Meaning}}
    expect(card.back).toContain("fire");
    expect(result.templateFiles).toHaveLength(0);
  });

  it("routes a >2-field model whose answer is a markdown table to header-paragraph", () => {
    const db = makeFakeDb({
      models: { m1: MULTI_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({
          cid: 1,
          nid: 1,
          ord: 0,
          mid: "m1",
          flds: ["Q", "[latex]\\begin{tabular}{c|c} $a$ & $b$ \\\\ $w$ & $f$ \\end{tabular}[/latex]", "x"],
        }),
      ],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.kind).toBe("basic");
    expect(card.back).toContain("| --- |"); // converted markdown table
    expect(card.tableLayout).toBe(false); // block content → header-paragraph, not a cell
  });

  it("uses an HTML template for a multi-field model with CSS layout", () => {
    const richModel = { ...MULTI_MODEL, css: ".card { display: grid; grid-template-columns: 1fr 1fr; }" };
    const db = makeFakeDb({
      models: { m1: richModel },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m1", flds: ["火", "ひ", "fire"] })],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cards[0].kind).toBe("template");
    const tpl = result.templateFiles[0];
    expect(tpl.content).toContain("```decks-html-front");
    expect(tpl.content).toContain("<style>");
  });

  it("derives the template front from the qfmt field, not a field-0 sort index", () => {
    // Refold-style notetype: field 0 is a sequence number; the front the card
    // actually shows is {{Front of Card}} (field 1). The front (and thus the id)
    // must be the word, not the number — otherwise numeric fronts collide across
    // decks and the user sees a bare index.
    const refoldModel = {
      id: "m5",
      name: "Refold",
      type: 0,
      css: ".card { display: grid; grid-template-columns: 1fr 1fr; }",
      flds: [
        { name: "Sort Index" },
        { name: "Front of Card" },
        { name: "Word" },
        { name: "Definition" },
        { name: "word_audio" },
      ],
      tmpls: [
        {
          name: "Card 1",
          ord: 0,
          qfmt: '<div class="tw">{{Front of Card}}</div>{{word_audio}}',
          afmt: "{{FrontSide}}<hr id=answer>{{Definition}}",
        },
      ],
    };
    const db = makeFakeDb({
      models: { m5: refoldModel },
      decks: DECKS,
      cardNotes: [
        cardNote({
          cid: 1, nid: 1, did: "10", ord: 0, mid: "m5",
          flds: ["1", "être", "être", "(v.) to be", "[sound:etre.mp3]"],
        }),
      ],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.kind).toBe("template");
    expect(card.front).toBe("être"); // the word, not "1"
    // Front stays in lockstep with cells[0] (the Decks parser reads cells[0] back).
    expect(card.templateRow?.cells[0]).toBe("être");
    expect(card.templateRow?.headers[0]).toBe("Front of Card");
  });

  it("skips a media-only qfmt field and uses the next text field as the front", () => {
    // If the first qfmt-referenced field is image/audio only, fall through to the
    // first one that carries text.
    const model = {
      id: "m6",
      name: "Picture-first",
      type: 0,
      css: ".card { display: grid; grid-template-columns: 1fr 1fr; }",
      flds: [{ name: "Picture" }, { name: "Symbol" }, { name: "Name" }],
      tmpls: [
        {
          name: "Card 1", ord: 0,
          qfmt: "{{Picture}}<div>{{Symbol}}</div>",
          afmt: "{{FrontSide}}<hr id=answer>{{Name}}",
        },
      ],
    };
    const db = makeFakeDb({
      models: { m6: model },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m6", flds: ['<img src="h.png">', "H", "Hydrogen"] }),
      ],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.kind).toBe("template");
    expect(card.front).toBe("H"); // Symbol, not the image
  });

  it("keeps field 0 as the front when it is the qfmt field (no regression)", () => {
    const richModel = { ...MULTI_MODEL, css: ".card { display: grid; grid-template-columns: 1fr 1fr; }" };
    const db = makeFakeDb({
      models: { m1: richModel },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m1", flds: ["火", "ひ", "fire"] })],
    });
    const card = AnkiCollectionParser.parse(db).cards[0];
    expect(card.kind).toBe("template");
    expect(card.front).toBe("火"); // qfmt {{Word}} == field 0
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

  it("resolves an occlusion base image whose filename has spaces", () => {
    const ioModel = {
      id: "m4",
      name: "Image Occlusion Enhanced",
      type: 0,
      flds: [{ name: "ID" }, { name: "Image" }, { name: "Question Mask" }, { name: "Original Mask" }],
      tmpls: [{ name: "IO", ord: 0, qfmt: '<div id="io-overlay">x</div>', afmt: "{{FrontSide}}" }],
    };
    const svg =
      '<svg width="100" height="50"><g><title>Masks</title><rect id="x-oa-1" x="10" y="5" width="20" height="10"/></g></svg>';
    const db = makeFakeDb({
      models: { m4: ioModel },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m4", flds: ["x-oa-1", '<img src="S Block Diagram.png">', '<img src="x-oa-1-Q.svg">', '<img src="x-oa-O.svg">'] }),
      ],
    });
    const getMediaText = (name: string): string | undefined => (name === "x-oa-O.svg" ? svg : undefined);
    const card = AnkiCollectionParser.parse(db, { getMediaText }).cards[0];
    expect(card.kind).toBe("occlusion");
    expect(card.imagePath).toBe("S Block Diagram.png");
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

  it("collects spaced-filename images inside cloze answers + extras (full names)", () => {
    const db = makeFakeDb({
      models: { m2: CLOZE_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({
          cid: 1,
          nid: 7,
          did: "10",
          ord: 0,
          mid: "m2",
          flds: ["id-7", 'Rate Law: {{c1::<img src="1st Order Rate Law.png">}}', '<img src="Rate Law Chart (1).png">'],
        }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cards[0].clozeBody).toBe("Rate Law: ==![[1st Order Rate Law.png]]==");
    expect(result.mediaFiles).toContain("1st Order Rate Law.png");
    expect(result.mediaFiles).toContain("Rate Law Chart (1).png");
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

  it("reads models/decks from schema-18 tables when col JSON is empty", () => {
    // Schema 18: col.models/col.decks are empty; data lives in normalized tables.
    const db = makeFakeDb({
      models: {},
      decks: {},
      notetypes: [
        { id: 100, name: "Basic", config: notetypeConfig(0, ".card{color:black}") },
        { id: 200, name: "Cloze", config: notetypeConfig(1, ".cloze{color:blue}") },
      ],
      fieldRows: [
        { ntid: 100, ord: 0, name: "Front" },
        { ntid: 100, ord: 1, name: "Back" },
        { ntid: 200, ord: 0, name: "Text" },
      ],
      templates: [
        { ntid: 100, ord: 0, name: "Card 1", config: tmplConfig("{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}") },
        { ntid: 200, ord: 0, name: "Cloze", config: tmplConfig("{{cloze:Text}}", "{{cloze:Text}}") },
      ],
      deckRows: [{ id: 10, name: "Parent\x1fChild" }],
      cardNotes: [
        cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "100", flds: ["Hund", "dog"] }),
        cardNote({ cid: 2, nid: 2, did: "10", ord: 0, mid: "200", flds: ["Du trinkst {{c1::jeden Tag}} Bier."] }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cardCount).toBe(2);

    const basic = result.cards.find((c) => c.kind === "basic");
    expect(basic?.front).toBe("Hund");
    expect(basic?.back).toBe("dog");
    expect(basic?.deckName).toBe("Parent::Child"); // \x1f → ::

    const cloze = result.cards.find((c) => c.isCloze);
    expect(cloze?.clozeBody).toBe("Du trinkst ==jeden Tag== Bier.");
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
