import {
    DK_TOKEN_REGEX,
    clozeBindingKey,
    edgeBindingKey,
    extractAnchorTokens,
    extractLineAnchors,
    findAnchorSpans,
    formatAnchorToken,
    headerBindingKey,
    isAnchorCommentBody,
    nodeBindingKey,
    questionBindingKey,
    reverseBindingKey,
    stripAnchorTokens,
    titleBindingKey,
    titleClozeBindingKey,
} from "../anchors";
import { generateAnchorId } from "../hash";

describe("anchor token grammar", () => {
    it("matches exactly %%dk:<role>:<id>%%", () => {
        expect("%%dk:h:x7f2%%".match(new RegExp(DK_TOKEN_REGEX.source))).toBeTruthy();
        expect("%%dk:c:0abc9%%".match(new RegExp(DK_TOKEN_REGEX.source))).toBeTruthy();
        expect("%%dk:t:a1%%".match(new RegExp(DK_TOKEN_REGEX.source))).toBeTruthy();
        expect("%%dk:o:zz%%".match(new RegExp(DK_TOKEN_REGEX.source))).toBeTruthy();
        expect("%%dk:q:x7f2%%".match(new RegExp(DK_TOKEN_REGEX.source))).toBeTruthy();
    });

    it("rejects unknown roles, uppercase ids, spaces and empty ids", () => {
        for (const bad of [
            "%%dk:x:abc%%",
            "%%dk:h:ABC%%",
            "%%dk:h: abc%%",
            "%%dk:h:%%",
            "%%dk:h:ab c%%",
            "%%dk:hh:abc%%",
            "%% dk:h:abc%%",
        ]) {
            expect(bad.match(new RegExp(DK_TOKEN_REGEX.source))).toBeNull();
        }
    });

    it("identifies anchor comment bodies for notes exclusion", () => {
        expect(isAnchorCommentBody("dk:h:x7f2")).toBe(true);
        expect(isAnchorCommentBody(" dk:c:abc ")).toBe(true);
        expect(isAnchorCommentBody("dk:q:x7f2")).toBe(true);
        expect(isAnchorCommentBody("a real note")).toBe(false);
        expect(isAnchorCommentBody("dk:h:x7f2 extra")).toBe(false);
    });
});

describe("stripAnchorTokens", () => {
    it("removes an appended token together with its preceding space", () => {
        expect(stripAnchorTokens("Paris is the capital. %%dk:h:x7f2%%")).toBe(
            "Paris is the capital.",
        );
    });

    it("removes multiple tokens and is idempotent", () => {
        const input = "a %%dk:h:one%% b %%dk:c:two%%";
        const once = stripAnchorTokens(input);
        expect(once).toBe("a b");
        expect(stripAnchorTokens(once)).toBe(once);
    });

    it("leaves non-anchor comments untouched", () => {
        expect(stripAnchorTokens("text %%a note%%")).toBe("text %%a note%%");
    });

    it("works across multi-line strings", () => {
        expect(stripAnchorTokens("l1 %%dk:h:a%%\nl2 %%dk:c:b%%")).toBe("l1\nl2");
    });
});

describe("extractAnchorTokens / extractLineAnchors", () => {
    it("returns tokens in order with cleaned text", () => {
        const { cleaned, tokens } = extractAnchorTokens("word ==foo== %%dk:c:ab1%%");
        expect(cleaned).toBe("word ==foo==");
        expect(tokens).toEqual([{ role: "c", id: "ab1" }]);
    });

    it("indexes anchors by line", () => {
        const { lines, anchors } = extractLineAnchors([
            "Question body",
            "cloze ==x== line %%dk:c:aa%%",
            "last line %%dk:h:bb%%",
        ]);
        expect(lines).toEqual(["Question body", "cloze ==x== line", "last line"]);
        expect(anchors).toEqual([
            { role: "c", id: "aa", lineIndex: 1 },
            { role: "h", id: "bb", lineIndex: 2 },
        ]);
    });
});

describe("formatAnchorToken + binding keys", () => {
    it("formats round-trippable tokens", () => {
        const token = formatAnchorToken("h", "x7f2");
        expect(token).toBe("%%dk:h:x7f2%%");
        expect(extractAnchorTokens(token).tokens).toEqual([{ role: "h", id: "x7f2" }]);
    });

    it("round-trips and strips q tokens", () => {
        const token = formatAnchorToken("q", "ab12");
        expect(token).toBe("%%dk:q:ab12%%");
        expect(extractAnchorTokens(token).tokens).toEqual([{ role: "q", id: "ab12" }]);
        expect(stripAnchorTokens(`- [ ] Nitrogen ${token}`)).toBe("- [ ] Nitrogen");
    });

    it("builds the documented key shapes", () => {
        expect(headerBindingKey("x")).toBe("h:x");
        expect(clozeBindingKey("x", 1)).toBe("c:x#1");
        expect(reverseBindingKey("h:x")).toBe("h:x:rev");
        expect(titleBindingKey("x")).toBe("p:x");
        expect(titleClozeBindingKey("x", 2)).toBe("p:x#2");
        expect(edgeBindingKey("edge1")).toBe("e:edge1");
        expect(edgeBindingKey("edge1", 0)).toBe("e:edge1#0");
        expect(nodeBindingKey("node1")).toBe("n:node1");
        expect(questionBindingKey("x")).toBe("q:x");
    });
});

describe("generateAnchorId", () => {
    it("is deterministic and base36 lowercase", () => {
        const a = generateAnchorId("What is the capital of France?");
        expect(a).toBe(generateAnchorId("What is the capital of France?"));
        expect(a).toMatch(/^[a-z0-9]+$/);
    });

    it("salts by occurrence", () => {
        const base = generateAnchorId("front");
        expect(generateAnchorId("front", 1)).not.toBe(base);
        expect(generateAnchorId("front", 1)).toBe(generateAnchorId("front", 1));
    });
});

describe("findAnchorSpans", () => {
    const splice = (line: string): string =>
        findAnchorSpans(line)
            .slice()
            .reverse()
            .reduce((acc, s) => acc.slice(0, s.start) + acc.slice(s.end), line);

    it("returns nothing for a line with no token", () => {
        expect(findAnchorSpans("plain text")).toEqual([]);
        expect(findAnchorSpans("")).toEqual([]);
    });

    it("includes the preceding space so the span matches stripAnchorTokens", () => {
        expect(findAnchorSpans("Text %%dk:c:ab12%%")).toEqual([
            { role: "c", id: "ab12", start: 4, end: 18 },
        ]);
    });

    it("handles a token at offset 0 and a tab separator", () => {
        expect(findAnchorSpans("%%dk:h:x1%%")).toEqual([
            { role: "h", id: "x1", start: 0, end: 11 },
        ]);
        expect(findAnchorSpans("a\t%%dk:h:x1%%")[0].start).toBe(1);
    });

    it("returns multiple tokens in order", () => {
        const spans = findAnchorSpans("a %%dk:c:aa%% b %%dk:c:bb%%");
        expect(spans.map((s) => s.id)).toEqual(["aa", "bb"]);
        expect(spans[0].start).toBeLessThan(spans[1].start);
    });

    it("keeps a table row well formed when the span is spliced out", () => {
        expect(splice("| chat %%dk:t:bb22%% | Au |")).toBe("| chat | Au |");
    });

    it("ignores malformed tokens", () => {
        for (const bad of ["%%dk:x:abc%%", "%%dk:h:ABC%%", "%%dk:h:%%", "%% dk:h:abc%%"]) {
            expect(findAnchorSpans(bad)).toEqual([]);
        }
    });

    it("does not carry regex state between calls", () => {
        const line = "Text %%dk:c:ab12%%";
        expect(findAnchorSpans(line)).toEqual(findAnchorSpans(line));
    });

    it("splices to exactly what stripAnchorTokens produces", () => {
        for (const line of [
            "Text %%dk:c:ab12%%",
            "%%dk:h:x1%%",
            "| chat %%dk:t:bb22%% | Au |",
            "a %%dk:c:aa%% b %%dk:c:bb%%",
            "no tokens here",
        ]) {
            expect(splice(line)).toBe(stripAnchorTokens(line));
        }
    });
});
