import { readProtoScalars } from "../proto";

const enc = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}
function strField(field: number, value: string): number[] {
  const bytes = [...enc.encode(value)];
  return [(field << 3) | 2, ...varint(bytes.length), ...bytes];
}
function varintField(field: number, value: number): number[] {
  return [(field << 3) | 0, ...varint(value)];
}

describe("readProtoScalars", () => {
  it("reads string and varint fields by number (CardTemplateConfig shape)", () => {
    const buf = new Uint8Array([...strField(1, "{{Front}}"), ...strField(2, "{{FrontSide}}<hr>{{Back}}")]);
    const p = readProtoScalars(buf);
    expect(p.string(1)).toBe("{{Front}}");
    expect(p.string(2)).toBe("{{FrontSide}}<hr>{{Back}}");
    expect(p.string(3)).toBeUndefined();
  });

  it("reads kind (varint) + css (string) like NotetypeConfig, skipping other fields", () => {
    const buf = new Uint8Array([
      ...varintField(1, 1), // kind = cloze
      ...varintField(4, 12345), // some other varint
      ...strField(3, ".card { color: red; }"), // css
    ]);
    const p = readProtoScalars(buf);
    expect(p.uint(1)).toBe(1);
    expect(p.string(3)).toBe(".card { color: red; }");
    expect(p.uint(99)).toBeUndefined();
  });

  it("returns undefined for an empty buffer", () => {
    const p = readProtoScalars(new Uint8Array());
    expect(p.string(1)).toBeUndefined();
    expect(p.uint(1)).toBeUndefined();
  });
});
