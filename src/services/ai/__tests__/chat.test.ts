import {
  buildChatMessages,
  parseChatAnswer,
  recentTurns,
  CHAT_HISTORY_TURNS,
  CHAT_DECK_CARDS,
} from "../chat";

describe("parseChatAnswer", () => {
  it("reads the answer, its pages and its gaps", () => {
    const got = parseChatAnswer(
      [
        "ANSWER: Chebyshev bounds the share of values outside k standard deviations.",
        "PAGES: 73, 74",
        "GAP: Tschebyscheff-Ungleichung · p. 73",
        "GAP: Perzentilbänder · p. 77",
      ].join("\n"),
    );
    expect(got.text).toContain("Chebyshev bounds");
    expect(got.pages).toEqual([73, 74]);
    expect(got.gaps).toEqual([
      { term: "Tschebyscheff-Ungleichung", page: 73 },
      { term: "Perzentilbänder", page: 77 },
    ]);
  });

  it("keeps a multi-line answer together", () => {
    const got = parseChatAnswer("ANSWER: first line\nsecond line\nPAGES: 70");
    expect(got.text).toBe("first line\nsecond line");
    expect(got.pages).toEqual([70]);
  });

  it("takes an unlabelled reply as the answer rather than dropping it", () => {
    const got = parseChatAnswer("The source does not say.");
    expect(got.text).toBe("The source does not say.");
    expect(got.pages).toEqual([]);
    expect(got.gaps).toEqual([]);
  });

  it("deduplicates and orders the pages", () => {
    expect(parseChatAnswer("ANSWER: x\nPAGES: 74, 70, 74").pages).toEqual([70, 74]);
  });

  it("reads a gap with no page", () => {
    expect(parseChatAnswer("ANSWER: x\nGAP: Indexzahlen").gaps).toEqual([
      { term: "Indexzahlen", page: null },
    ]);
  });

  it("drops an empty gap line rather than staging a nameless one", () => {
    expect(parseChatAnswer("ANSWER: x\nGAP:\nGAP: p. 5").gaps).toEqual([]);
  });

  it("tolerates a gap written with a comma", () => {
    expect(parseChatAnswer("ANSWER: x\nGAP: Boxplots, p. 76").gaps).toEqual([
      { term: "Boxplots", page: 76 },
    ]);
  });

  it("ignores prose after the labels rather than folding it into the pages", () => {
    const got = parseChatAnswer("ANSWER: a\nPAGES:\nGAP: T · p. 73");
    expect(got.pages).toEqual([]);
    expect(got.text).toBe("a");
  });
});

describe("recentTurns", () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`,
  }));

  it("reaches back a bounded number of turns", () => {
    expect(recentTurns(history)).toHaveLength(CHAT_HISTORY_TURNS);
    expect(recentTurns(history)[0].question).toBe("q4");
  });

  it("keeps a short history whole", () => {
    expect(recentTurns(history.slice(0, 2))).toHaveLength(2);
  });
});

describe("buildChatMessages", () => {
  it("lists the destination deck's cards, capped", () => {
    const deck = Array.from({ length: CHAT_DECK_CARDS + 10 }, (_, i) => `Front ${i}`);
    const { user } = buildChatMessages({ question: "What did I miss?", source: "[p. 1] text", deck });
    expect(user).toContain("Cards already in the destination deck:");
    expect(user).toContain(`- Front ${CHAT_DECK_CARDS - 1}`);
    expect(user).not.toContain(`- Front ${CHAT_DECK_CARDS}\n`);
  });

  it("leaves the deck out when there is none", () => {
    const { user } = buildChatMessages({ question: "q", source: "s" });
    expect(user).not.toContain("destination deck");
  });

  const base = { question: "what is the median?", source: "[p. 61] text" };

  it("puts the rubric in the system message and the source in the user one", () => {
    const { system, user } = buildChatMessages(base);
    expect(system).toContain("[p. N]");
    expect(user).toContain("[p. 61] text");
    expect(system).not.toContain("[p. 61] text");
  });

  it("sends the cards already made, so 'what did I miss' has a comparison", () => {
    const { user } = buildChatMessages({ ...base, staged: ["What is the mean?"] });
    expect(user).toContain("What is the mean?");
  });

  it("sends the known gaps as ground truth rather than leaving them to a guess", () => {
    const { user } = buildChatMessages({ ...base, uncovered: ["Perzentilband"] });
    expect(user).toContain("Perzentilband");
  });

  it("includes only the recent turns of a long history", () => {
    const history = Array.from({ length: 9 }, (_, i) => ({
      question: `ZZ_Q${i}_ZZ`,
      answer: "a",
    }));
    const { user } = buildChatMessages({ ...base, history });
    expect(user).not.toContain("ZZ_Q0_ZZ");
    expect(user).toContain("ZZ_Q8_ZZ");
  });

  it("asks the question last, after everything it is grounded in", () => {
    const { user } = buildChatMessages({ ...base, staged: ["x"] });
    expect(user.lastIndexOf("what is the median?")).toBeGreaterThan(
      user.indexOf("[p. 61] text"),
    );
  });
});
