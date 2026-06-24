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

const STANDARD_MODEL = {
  id: "m1",
  name: "Standard",
  type: 0,
  flds: [{ name: "German" }, { name: "English" }, { name: "Image" }, { name: "Audio" }],
  tmpls: [
    {
      name: "Card 1",
      ord: 0,
      qfmt: "{{German}}{{#Image}}{{Image}}{{/Image}}",
      afmt: "{{FrontSide}}<hr id=answer>{{English}}{{Audio}}",
    },
    { name: "Card 2", ord: 1, qfmt: "{{English}}", afmt: "{{FrontSide}}<hr id=answer>{{German}}{{Audio}}" },
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
  it("maps field roles for forward and reverse templates", () => {
    const db = makeFakeDb({
      models: { m1: STANDARD_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({ cid: 1, nid: 1, ord: 0, mid: "m1", flds: ["Das Wetter", "The weather", "", ""] }),
        cardNote({ cid: 2, nid: 1, ord: 1, mid: "m1", flds: ["Das Wetter", "The weather", "", ""] }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cardCount).toBe(2);

    const forward = result.cards.find((c) => c.ord === 0);
    expect(forward?.front).toBe("Das Wetter");
    expect(forward?.back).toBe("The weather");

    const reverse = result.cards.find((c) => c.ord === 1);
    expect(reverse?.front).toBe("The weather");
    expect(reverse?.back).toBe("Das Wetter");
  });

  it("rewrites image/audio fields to embeds and collects media", () => {
    const db = makeFakeDb({
      models: { m1: STANDARD_MODEL },
      decks: DECKS,
      cardNotes: [
        cardNote({
          cid: 1,
          nid: 1,
          ord: 0,
          mid: "m1",
          flds: ["haben", "to have", '<img src="img.jpg">', "[sound:a.mp3]"],
        }),
      ],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cards[0].front).toBe("haben"); // header stays text-only
    expect(result.cards[0].back).toContain("to have"); // answer side (afmt)
    expect(result.cards[0].back).toContain("![[a.mp3]]"); // audio is on the answer side
    expect(result.cards[0].notes).toContain("![[img.jpg]]"); // front-side image relocated to notes
    expect(result.mediaFiles).toEqual(["a.mp3", "img.jpg"]);
  });

  it("surfaces template-unreferenced fields as notes", () => {
    const model = {
      id: "m3",
      name: "WithExtra",
      type: 0,
      flds: [{ name: "Front" }, { name: "Back" }, { name: "Source" }],
      tmpls: [
        { name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" },
      ],
    };
    const db = makeFakeDb({
      models: { m3: model },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m3", flds: ["Q", "A", "Book p.5"] })],
    });
    const result = AnkiCollectionParser.parse(db);
    expect(result.cards[0].front).toBe("Q");
    expect(result.cards[0].back).toBe("A");
    expect(result.cards[0].notes).toContain("**Source:** Book p.5");
  });

  it("skips image-occlusion note types", () => {
    const ioModel = {
      id: "m4",
      name: "Image Occlusion Enhanced",
      type: 0,
      flds: [{ name: "Image" }, { name: "Question Mask" }],
      tmpls: [{ name: "IO", ord: 0, qfmt: '<div id="io-overlay">{{Question Mask}}</div>', afmt: "{{FrontSide}}" }],
    };
    const db = makeFakeDb({
      models: { m4: ioModel },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, ord: 0, mid: "m4", flds: ["img", "mask"] })],
    });
    expect(AnkiCollectionParser.parse(db).cardCount).toBe(0);
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
    expect(cloze.front).toBe("You drink beer every day."); // Translation field as header
  });

  it("resolves deck names and counts notes", () => {
    const db = makeFakeDb({
      models: { m1: STANDARD_MODEL },
      decks: DECKS,
      cardNotes: [cardNote({ cid: 1, nid: 1, did: "10", ord: 0, mid: "m1", flds: ["a", "b", "", ""] })],
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
