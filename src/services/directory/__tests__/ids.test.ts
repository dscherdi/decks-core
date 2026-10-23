import { isValidDirectorySlug, slugifyDirectoryTitle } from "../ids";

describe("slugifyDirectoryTitle", () => {
  it("spells out umlauts", () => {
    expect(slugifyDirectoryTitle("Übungsaufgaben")).toBe("uebungsaufgaben");
    expect(slugifyDirectoryTitle("Länder-Themen")).toBe("laender-themen");
    expect(slugifyDirectoryTitle("Mündliche Prüfung")).toBe("muendliche-pruefung");
    expect(slugifyDirectoryTitle("Ökologie und Ähnliches")).toBe("oekologie-und-aehnliches");
  });

  it("spells out umlauts written as a base letter plus a combining mark", () => {
    expect(slugifyDirectoryTitle("Übungsaufgaben".normalize("NFD"))).toBe("uebungsaufgaben");
  });

  it("spells out ß", () => {
    expect(slugifyDirectoryTitle("Straße")).toBe("strasse");
    expect(slugifyDirectoryTitle("GROẞE PAUSE")).toBe("grosse-pause");
  });

  it("drops other accents", () => {
    expect(slugifyDirectoryTitle("Español básico")).toBe("espanol-basico");
    expect(slugifyDirectoryTitle("Français élémentaire")).toBe("francais-elementaire");
  });

  it("trims to the maximum slug length without a trailing hyphen", () => {
    expect(slugifyDirectoryTitle("a".repeat(100))).toBe("a".repeat(80));
    expect(slugifyDirectoryTitle(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
    expect(slugifyDirectoryTitle("ü".repeat(50))).toBe("ue".repeat(40));
    expect(isValidDirectorySlug(slugifyDirectoryTitle("Prüfung ".repeat(20)))).toBe(true);
  });
});
