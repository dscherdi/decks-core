import { carryBodyAnchors, carryRowToken, refitPackedValue } from "../anchor-carry";
import { decodeAnchorValue, encodeAnchorValue } from "../anchors";

function packed(ids: (string | null)[]): string {
  const value = encodeAnchorValue("p", ids);
  if (value === null) throw new Error("cannot encode");
  return value;
}

function ids(value: string | null): (string | null)[] | undefined {
  return value === null ? undefined : decodeAnchorValue(value)?.ids;
}

describe("refitPackedValue", () => {
  const value = packed(["ccard_aaa", "ccard_bbb"]);

  it("keeps each id with the deletion of the same text", () => {
    expect(ids(refitPackedValue(value, ["heart", "blood"], ["blood", "heart"]))).toEqual([
      "ccard_bbb",
      "ccard_aaa",
    ]);
  });

  it("leaves an inserted deletion unassigned", () => {
    expect(ids(refitPackedValue(value, ["heart", "blood"], ["new", "heart", "blood"]))).toEqual([
      null,
      "ccard_aaa",
      "ccard_bbb",
    ]);
  });

  it("pairs a reworded deletion with the id left over", () => {
    expect(ids(refitPackedValue(value, ["heart", "blood"], ["Heart", "blood"]))).toEqual([
      "ccard_aaa",
      "ccard_bbb",
    ]);
  });

  it("drops the token when no deletion is left", () => {
    expect(refitPackedValue(value, ["heart", "blood"], [])).toBeNull();
  });

  it("passes other kinds through", () => {
    const single = encodeAnchorValue("a", ["card_abc"])!;
    expect(refitPackedValue(single, [], [])).toBe(single);
    expect(refitPackedValue("mintedx", ["a"], [])).toBe("mintedx");
  });
});

describe("carryBodyAnchors", () => {
  it("carries a token on an unchanged line as it was", () => {
    const token = `%%dk:c:${packed(["ccard_aaa"])}%%`;
    const body = ["The ==heart== pumps."];
    carryBodyAnchors([`The ==heart== pumps. ${token}`], body);
    expect(body).toEqual([`The ==heart== pumps. ${token}`]);
  });

  it("refits an id-carrying token to its rewritten line", () => {
    const body = ["Intro.", "The ==heart== pumps ==blood== and ==lymph==."];
    carryBodyAnchors(
      ["Intro.", `The ==heart== moves ==blood==. %%dk:c:${packed(["ccard_aaa", "ccard_bbb"])}%%`],
      body
    );
    expect(body[1]).toBe(
      `The ==heart== pumps ==blood== and ==lymph==. %%dk:c:${packed(["ccard_aaa", "ccard_bbb", null])}%%`
    );
  });

  it("drops a minted token whose line was rewritten", () => {
    const body = ["The ==heart== beats."];
    carryBodyAnchors(["The ==heart== pumps. %%dk:c:abc%%"], body);
    expect(body).toEqual(["The ==heart== beats."]);
  });

  it("keeps the header token on its own line after the body", () => {
    const body = ["New answer.", ""];
    carryBodyAnchors(["Old answer.", "%%dk:h:0a6abc123%%"], body);
    expect(body).toEqual(["New answer.", "%%dk:h:0a6abc123%%", ""]);
  });
});

describe("carryRowToken", () => {
  it("refits a packed row token to the edited cloze cell", () => {
    const value = packed(["ccard_aaa", "ccard_bbb"]);
    const row = `| word %%dk:t:${value}%% | The ==heart== and ==lungs== |`;
    const token = carryRowToken(
      row,
      ["word", "The ==heart== and ==lungs=="],
      ["word", "The ==lungs== and ==heart=="]
    );
    expect(token && ids(token.id)).toEqual(["ccard_bbb", "ccard_aaa"]);
  });

  it("keeps a single-card row token whatever the edit", () => {
    const value = encodeAnchorValue("a", ["card_abc"])!;
    const token = carryRowToken(`| chat %%dk:t:${value}%% | cat |`, ["chat", "cat"], ["chien", "dog"]);
    expect(token).toEqual({ role: "t", id: value });
  });
});
