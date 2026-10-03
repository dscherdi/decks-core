import { dependsOnBinding, helloOp, olderDevices } from "../AnchorUpgrader";
import { encodeAnchorValue } from "../../utils/anchors";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1);

function log(deviceId: string, daysAgo: number, lines: unknown[]) {
  return {
    deviceId,
    modified: NOW - daysAgo * DAY,
    text: async () => lines.map((line) => JSON.stringify(line)).join("\n"),
  };
}

describe("dependsOnBinding", () => {
  it("is true only for minted note tokens", () => {
    expect(dependsOnBinding("h:abc")).toBe(true);
    expect(dependsOnBinding("c:abc#1")).toBe(true);
    expect(dependsOnBinding("p:abc:rev")).toBe(true);
    expect(dependsOnBinding(`h:${encodeAnchorValue("a", ["card_abc"])}`)).toBe(false);
    expect(dependsOnBinding("e:edge1")).toBe(false);
    expect(dependsOnBinding(null)).toBe(false);
  });
});

describe("olderDevices", () => {
  const rate = { hlc: "x", s: 1, v: 1, o: "rate", p: {} };

  it("names an active device whose log never announced id-carrying tokens", async () => {
    const hello = { hlc: "y", s: 2, v: 1, ...helloOp() };
    const found = await olderDevices(
      [log("new", 1, [rate, hello]), log("old", 2, [rate]), log("asleep", 90, [rate])],
      NOW
    );
    expect(found).toEqual(["old"]);
  });

  it("ignores a malformed line", async () => {
    const found = await olderDevices(
      [{ deviceId: "odd", modified: NOW, text: async () => '{"o":"client_hello", broken' }],
      NOW
    );
    expect(found).toEqual(["odd"]);
  });
});
