import { parseDirectoryDeckInfo, parseDirectoryImportRequest } from "../remote";

describe("directory import links", () => {
  it("accepts a slug and a ticket", () => {
    expect(parseDirectoryImportRequest({ deck: "spanish-basics", ticket: "AbCdEfGhIjKlMnOp_1234" })).toEqual({
      slug: "spanish-basics",
      ticket: "AbCdEfGhIjKlMnOp_1234",
    });
  });

  it("refuses anything that could steer the download elsewhere", () => {
    expect(parseDirectoryImportRequest({ deck: "../x", ticket: "AbCdEfGhIjKlMnOp" })).toBeNull();
    expect(parseDirectoryImportRequest({ deck: "ok", ticket: "https://evil.example/x.dpkg" })).toBeNull();
    expect(parseDirectoryImportRequest({ deck: "ok" })).toBeNull();
  });

  it("reads deck info and refuses a malformed reply", () => {
    expect(parseDirectoryDeckInfo('{"slug":"a-b","title":"T","version":2,"cardCount":5,"sizeBytes":10}')).toEqual({
      slug: "a-b", title: "T", version: 2, cardCount: 5, sizeBytes: 10,
    });
    expect(parseDirectoryDeckInfo('{"slug":"A B","title":"T","version":2}')).toBeNull();
    expect(parseDirectoryDeckInfo("not json")).toBeNull();
  });
});
