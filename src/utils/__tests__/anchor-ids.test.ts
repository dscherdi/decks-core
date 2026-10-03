// Tokens that carry card ids: the value is the id, so any device resolves a card
// from the note alone. Minted values from 2.6.0 onwards must never decode.
import {
    cardIdForKey,
    decodeAnchorValue,
    encodeAnchorValue,
    isIdKey,
    isIdValue,
    stripAnchorTokens,
    formatAnchorToken,
} from "../anchors";
import { generateAnchorId, generateClozeFlashcardId, generateFlashcardId, generateReverseFlashcardId, hash64 } from "../hash";

describe("id-carrying anchor values", () => {
    it("round-trips one card, a reverse pair and a cloze line", () => {
        const front = generateFlashcardId("What is ATP?");
        const reverse = generateReverseFlashcardId("The cell's energy currency");
        const a = encodeAnchorValue("a", [front])!;
        const b = encodeAnchorValue("b", [front, reverse])!;
        const c1 = generateClozeFlashcardId("Paris", "capital", 0);
        const c2 = generateClozeFlashcardId("Paris", "France", 1);
        const p = encodeAnchorValue("p", [c1, null, c2])!;

        expect(decodeAnchorValue(a)).toEqual({ kind: "a", ids: [front] });
        expect(decodeAnchorValue(b)).toEqual({ kind: "b", ids: [front, reverse] });
        expect(decodeAnchorValue(p)).toEqual({ kind: "p", ids: [c1, null, c2] });
        expect(cardIdForKey(`h:${b}`)).toBe(front);
        expect(cardIdForKey(`h:${b}:rev`)).toBe(reverse);
        expect(cardIdForKey(`c:${p}#2`)).toBe(c2);
        expect(cardIdForKey(`c:${p}#1`)).toBeNull();
        expect(cardIdForKey(`t:${p}#0`)).toBe(c1);
    });

    it("never decodes a minted value, including the bare 0 an empty front mints", () => {
        for (const minted of [generateAnchorId("Q"), generateAnchorId("anki:1:0"), generateAnchorId(""), "x7f2", "0", "0abc9"]) {
            expect(isIdValue(minted)).toBe(false);
            expect(cardIdForKey(`h:${minted}`)).toBeNull();
        }
        expect(generateAnchorId("")).toBe("0");
    });

    it("ignores a kind the role can't carry, and malformed payloads", () => {
        const a = encodeAnchorValue("a", [generateFlashcardId("Q")])!;
        const p = encodeAnchorValue("p", [generateClozeFlashcardId("Q", "x", 0)])!;
        expect(cardIdForKey(`c:${a}#0`)).toBeNull();
        expect(cardIdForKey(`o:${a}`)).toBeNull();
        expect(cardIdForKey(`h:${p}`)).toBeNull();
        expect(cardIdForKey(`h:${a}:rev`)).toBeNull();
        expect(decodeAnchorValue("0a6abc")).toBeNull(); // payload shorter than one id
        expect(decodeAnchorValue("0a6000000")).toBeNull(); // the forward card is never unassigned
        expect(decodeAnchorValue("0b6abcdef")).toBeNull(); // a pair needs two ids
        expect(isIdKey("e:edge1")).toBe(false);
        expect(isIdKey("p:author")).toBe(false);
    });

    it("refuses ids it can't carry rather than writing a wrong one", () => {
        expect(encodeAnchorValue("a", ["ccard_abc"])).toBeNull();
        expect(encodeAnchorValue("a", ["card_0"])).toBeNull();
        expect(encodeAnchorValue("a", ["scard_abc"])).toBeNull();
        expect(encodeAnchorValue("a", [`card_${"z".repeat(14)}`])).toBeNull();
        expect(encodeAnchorValue("b", [generateFlashcardId("Q")])).toBeNull();
    });

    it("widens to 13 characters per id when any id needs it", () => {
        const wide = `card_${hash64("anki:guid:0")}`;
        const value = encodeAnchorValue("a", [wide])!;
        expect(value.startsWith("0ad")).toBe(true);
        expect(cardIdForKey(`t:${value}`)).toBe(wide);
        const mixed = encodeAnchorValue("p", [`ccard_${hash64("x")}`, generateClozeFlashcardId("Q", "y", 1)])!;
        expect(decodeAnchorValue(mixed)?.ids[1]).toBe(generateClozeFlashcardId("Q", "y", 1));
    });

    it("stays inside the token grammar every shipped parser strips", () => {
        const value = encodeAnchorValue("b", [generateFlashcardId("Q"), generateReverseFlashcardId("A")])!;
        const line = `The answer ${formatAnchorToken("h", value)}`;
        expect(stripAnchorTokens(line)).toBe("The answer");
        // The 2.6.0 grammar, verbatim: new values must still be stripped by it.
        expect(line.replace(/[ \t]*%%dk:([hcto]):([a-z0-9]+)%%/g, "")).toBe("The answer");
    });
});

describe("hash64", () => {
    it("is deterministic, never 0, and at most 13 base36 characters", () => {
        expect(hash64("anki:123:0")).toBe(hash64("anki:123:0"));
        expect(hash64("a")).not.toBe(hash64("b"));
        for (const input of ["", "a", "Größe", "日本語", "x".repeat(5000)]) {
            const out = hash64(input);
            expect(out).toMatch(/^[1-9a-z][0-9a-z]{0,12}$/);
        }
    });

    it("matches 64-bit FNV-1a over UTF-16 code units", () => {
        // Reference values computed with BigInt arithmetic.
        expect(hash64("")).toBe("33niihzj4ux45");
        expect(hash64("anki:123:0")).toBe("38xof287xqbv4");
    });
});
