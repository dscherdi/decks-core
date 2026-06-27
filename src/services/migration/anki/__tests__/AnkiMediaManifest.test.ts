import { isZstd, parseMediaManifest } from "../AnkiMediaManifest";

const enc = new TextEncoder();

// Minimal protobuf encoders for building MediaEntries test bytes.
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
function lenDelimited(field: number, payload: number[]): number[] {
  return [(field << 3) | 2, ...varint(payload.length), ...payload];
}
function mediaEntry(name: string): number[] {
  // MediaEntry { string name = 1; uint64 size = 2; }
  const nameField = lenDelimited(1, [...enc.encode(name)]);
  const sizeField = [(2 << 3) | 0, ...varint(name.length)];
  return [...nameField, ...sizeField];
}
function mediaEntries(names: string[]): Uint8Array {
  const bytes: number[] = [];
  for (const name of names) bytes.push(...lenDelimited(1, mediaEntry(name)));
  return new Uint8Array(bytes);
}

describe("parseMediaManifest", () => {
  it("reads the legacy JSON map as filename → entry key", () => {
    const bytes = enc.encode(JSON.stringify({ "0": "a.mp3", "1": "b.jpg" }));
    const map = parseMediaManifest(bytes);
    expect(map.get("a.mp3")).toBe("0");
    expect(map.get("b.jpg")).toBe("1");
    expect(map.size).toBe(2);
  });

  it("reads the protobuf MediaEntries manifest, keyed by entry order", () => {
    const map = parseMediaManifest(mediaEntries(["a.mp3", "b.jpg", "img-oa-O.svg"]));
    expect(map.get("a.mp3")).toBe("0");
    expect(map.get("b.jpg")).toBe("1");
    expect(map.get("img-oa-O.svg")).toBe("2");
    expect(map.size).toBe(3);
  });

  it("handles unicode filenames in protobuf entries", () => {
    const map = parseMediaManifest(mediaEntries(["schön.mp3"]));
    expect(map.get("schön.mp3")).toBe("0");
  });

  it("returns an empty map for empty input", () => {
    expect(parseMediaManifest(new Uint8Array()).size).toBe(0);
  });
});

describe("isZstd", () => {
  it("detects the zstd frame magic", () => {
    expect(isZstd(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00]))).toBe(true);
  });

  it("rejects non-zstd bytes", () => {
    expect(isZstd(enc.encode("{\"0\":\"a.mp3\"}"))).toBe(false); // JSON
    expect(isZstd(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(isZstd(new Uint8Array([0x28, 0xb5]))).toBe(false); // too short
  });
});
