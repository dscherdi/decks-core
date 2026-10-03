import {
  buildCritiqueMessages,
  parseVerdicts,
  serializeForCritique,
  settleVerdicts,
  isKeptOverFlag,
  type CardVerdict,
  type CritiqueCard,
  type RubricCode,
} from "../critique-prompt";
import {
  INVALID_QUESTION_FIXES,
  fixActionFor,
  fixFields,
  fixInstructionFor,
  fixedCard,
  isQuestionShaped,
} from "../fixes";
import { AiCritiqueService } from "../AiCritiqueService";
import { CARD_DELIMITER } from "../prompts";
import type { HttpClient, HttpRequest } from "../HttpClient";
import type { AiProviderConfig } from "../types";

const c = (id: string, front: string, back = "b"): CritiqueCard => ({
  id,
  card: { front, back, notes: "" },
});

const block = (
  id: string,
  verdict: string,
  codes = "",
  fix = "",
): string => `ID: ${id}\nVERDICT: ${verdict}\nCODES: ${codes}\nFIX: ${fix}\n${CARD_DELIMITER}\n`;

describe("parseVerdicts", () => {
  it("reads a pass and a flagged verdict", () => {
    const text =
      block("1", "pass") +
      block("2", "flagged", "enumeration", "Split into three cards.");
    expect(parseVerdicts(text)).toEqual([
      { id: "1", verdict: "pass", codes: [], fix: "" },
      {
        id: "2",
        verdict: "flagged",
        codes: ["enumeration"],
        fix: "Split into three cards.",
      },
    ]);
  });

  it("treats a card with codes as flagged even when the verdict line says pass", () => {
    // A model that names a violation has found one; the codes are the
    // actionable half, so they win over the label.
    const [v] = parseVerdicts(block("1", "pass", "answer_leak", "Reword it."));
    expect(v.verdict).toBe("flagged");
    expect(v.codes).toEqual(["answer_leak"]);
  });

  it("drops codes it does not recognise rather than poisoning the card", () => {
    const [v] = parseVerdicts(block("1", "flagged", "enumeration, wibble"));
    expect(v.codes).toEqual(["enumeration"]);
  });

  it("normalises spacing and hyphens in codes", () => {
    const [v] = parseVerdicts(block("1", "flagged", "two facts, answer-leak"));
    expect(v.codes).toEqual(["two_facts", "answer_leak"]);
  });

  it("dedupes repeated codes", () => {
    const [v] = parseVerdicts(block("1", "flagged", "trivial, trivial"));
    expect(v.codes).toEqual(["trivial"]);
  });

  it("skips a block with no id instead of throwing", () => {
    // Half a parse should leave cards unjudged, never break the round.
    const text = `VERDICT: flagged\n${CARD_DELIMITER}\n` + block("2", "pass");
    expect(parseVerdicts(text).map((v) => v.id)).toEqual(["2"]);
  });

  it("carries no fix on a passing card", () => {
    const [v] = parseVerdicts(block("1", "pass", "", "should not appear"));
    expect(v.fix).toBe("");
  });
});

describe("fixActionFor", () => {
  it("maps each code to its one obvious next step", () => {
    expect(fixActionFor(["enumeration"])).toBe("cloze");
    expect(fixActionFor(["two_facts"])).toBe("split");
    expect(fixActionFor(["answer_leak"])).toBe("rewrite");
    expect(fixActionFor(["unanswerable_alone"])).toBe("add_context");
    expect(fixActionFor(["trivial"])).toBe("rewrite");
  });

  it("prefers splitting, then a cloze, when a card breaks several rules", () => {
    // A card carrying several facts cannot be fixed by rewording it.
    expect(fixActionFor(["enumeration", "two_facts"])).toBe("split");
    expect(fixActionFor(["answer_leak", "enumeration"])).toBe("cloze");
    expect(fixActionFor(["unanswerable_alone", "two_facts"])).toBe("split");
  });

  it("splits a list question, which cannot become a cloze", () => {
    expect(fixActionFor(["enumeration"], "mcq")).toBe("split");
    expect(fixActionFor(["enumeration"], "basic")).toBe("cloze");
  });

  it("offers nothing for a card that broke no rule", () => {
    expect(fixActionFor([])).toBeNull();
  });
});

describe("fixInstructionFor", () => {
  it("lets the rubric's suggestion stand in for a generic rewrite", () => {
    expect(fixInstructionFor("rewrite", "Ask about the cause")).toBe("Ask about the cause");
    expect(fixInstructionFor("split", "")).toMatch(/single-idea/);
  });

  it("keeps its own instruction for fixes with a shape of their own", () => {
    expect(fixInstructionFor("flatten", "anything")).toMatch(/flat task list/);
    expect(fixInstructionFor("type_in", "anything")).toMatch(/few words/);
    expect(fixInstructionFor("even_out", "Option B is longest.")).toMatch(/length.*Option B is longest\./s);
  });

  it("offers a flat list or a type-in for a question that does not parse", () => {
    expect(INVALID_QUESTION_FIXES).toEqual(["flatten", "type_in"]);
    expect(isQuestionShaped("type_in")).toBe(false);
    expect(isQuestionShaped("rewrite")).toBe(true);
    expect(isQuestionShaped(undefined)).toBe(true);
  });
});

describe("settleVerdicts", () => {
  const flagged = (id: string, codes: RubricCode[]): CardVerdict => ({ id, verdict: "flagged", codes, fix: "Split it" });
  const cloze = { id: "c", card: { front: "States", back: "They are ==solid==, ==liquid== and ==gas==.", notes: "" } };
  const list = { id: "l", card: { front: "Name the three states", back: "Solid, liquid, gas", notes: "" } };

  it("passes a cloze that blanks each item, whatever the model said about lists", () => {
    const [v] = settleVerdicts([flagged("c", ["enumeration"])], [cloze]);
    expect(v).toEqual({ id: "c", verdict: "pass", codes: [], fix: "" });
  });

  it("keeps the card's other faults", () => {
    const [v] = settleVerdicts([flagged("c", ["enumeration", "answer_leak"])], [cloze]);
    expect(v.verdict).toBe("flagged");
    expect(v.codes).toEqual(["answer_leak"]);
  });

  it("leaves a plain list flagged", () => {
    const [v] = settleVerdicts([flagged("l", ["enumeration"])], [list]);
    expect(v.codes).toEqual(["enumeration"]);
  });

  it("leaves a single blank flagged: one blank still holds the whole list", () => {
    const one = { id: "o", card: { front: "States", back: "They are ==solid, liquid and gas==.", notes: "" } };
    expect(settleVerdicts([flagged("o", ["enumeration"])], [one])[0].codes).toEqual(["enumeration"]);
  });

  it("drops option faults from a flashcard, which has no options", () => {
    const card = { id: "f", card: { front: "What is the median?", back: "The middle value.", notes: "" } };
    const [only] = settleVerdicts([flagged("f", ["length_cue"])], [card], "basic");
    expect(only).toEqual({ id: "f", verdict: "pass", codes: [], fix: "" });
    const [mixed] = settleVerdicts([flagged("f", ["length_cue", "two_facts"])], [card], "basic");
    expect(mixed.codes).toEqual(["two_facts"]);
    const [question] = settleVerdicts([flagged("f", ["length_cue"])], [card], "mcq");
    expect(question.codes).toEqual(["length_cue"]);
  });
});

describe("fixFields and fixedCard", () => {
  const card = { front: "States of matter", back: "Solid, liquid and gas" };

  it("sends a cloze fix as a cloze, and reads its sentence back as the answer", () => {
    expect(fixFields(card, "cloze")).toEqual({
      type: "cloze",
      front: "States of matter",
      sentence: "Solid, liquid and gas",
    });
    const back = fixedCard({ type: "cloze", front: "States of matter", sentence: "The three are ==solid==, ==liquid== and ==gas==." });
    expect(back).toEqual({ front: "States of matter", back: "The three are ==solid==, ==liquid== and ==gas==." });
  });

  it("sends every other fix as the card it is", () => {
    expect(fixFields(card, "split")).toEqual({ type: "header-paragraph", ...card });
    expect(fixedCard({ type: "header-paragraph", ...card })).toEqual(card);
  });

  it("refuses a shape a staged card cannot hold", () => {
    expect(fixedCard({ type: "image-occlusion", listItem: "x" })).toBeNull();
  });
});

describe("serializeForCritique", () => {
  it("gives every card an id the verdict can be matched back to", () => {
    const text = serializeForCritique([c("r1", "Q1"), c("r2", "Q2")]);
    expect(text).toContain("ID: r1");
    expect(text).toContain("ID: r2");
    expect(text.split(CARD_DELIMITER)).toHaveLength(3);
  });

  it("omits an empty NOTES line", () => {
    expect(serializeForCritique([c("r1", "Q")])).not.toContain("NOTES:");
  });
});

describe("AiCritiqueService", () => {
  const config: AiProviderConfig = {
    provider: "openai",
    model: "m",
    apiKey: "k",
  };

  const httpReturning = (content: string): HttpClient => ({
    request: (_req: HttpRequest) =>
      Promise.resolve({
        status: 200,
        headers: {},
        text: JSON.stringify({ choices: [{ message: { content } }] }),
      }),
  });

  it("returns a verdict per card", async () => {
    const svc = new AiCritiqueService(
      httpReturning(block("a", "pass") + block("b", "flagged", "trivial")),
    );
    const { verdicts } = await svc.critique(config, {
      cards: [c("a", "Q1"), c("b", "Q2")],
    });
    expect(verdicts.map((v) => v.verdict)).toEqual(["pass", "flagged"]);
  });

  it("ignores a verdict for a card it never asked about", () => {
    const svc = new AiCritiqueService(
      httpReturning(block("a", "pass") + block("ghost", "flagged", "trivial")),
    );
    return svc
      .critique(config, { cards: [c("a", "Q1")] })
      .then(({ verdicts }) => {
        expect(verdicts.map((v) => v.id)).toEqual(["a"]);
      });
  });

  it("makes no call for an empty round", async () => {
    let called = false;
    const http: HttpClient = {
      request: () => {
        called = true;
        return Promise.reject(new Error("should not be called"));
      },
    };
    const { verdicts } = await new AiCritiqueService(http).critique(config, {
      cards: [],
    });
    expect(verdicts).toEqual([]);
    expect(called).toBe(false);
  });

  it("throws missing_key rather than silently judging nothing", async () => {
    const svc = new AiCritiqueService(httpReturning(""));
    await expect(
      svc.critique({ provider: "openai", model: "m" }, { cards: [c("a", "Q")] }),
    ).rejects.toMatchObject({ code: "missing_key" });
  });
});

describe("buildCritiqueMessages", () => {
  it("puts the rubric in the system message and the cards in the user one", () => {
    const { system, user } = buildCritiqueMessages({ cards: [c("a", "Q")] });
    expect(system).toContain("enumeration");
    expect(system).toContain("VERDICT: pass | flagged");
    expect(user).toContain("ID: a");
    expect(system).not.toContain("ID: a");
  });
});

describe("isKeptOverFlag", () => {
  it("tells a card kept despite its flag from one that passed", () => {
    expect(isKeptOverFlag({ verdict: "pass", codes: ["enumeration"] })).toBe(true);
    expect(isKeptOverFlag({ verdict: "pass", codes: [] })).toBe(false);
    expect(isKeptOverFlag({ verdict: "flagged", codes: ["enumeration"] })).toBe(false);
  });
});
