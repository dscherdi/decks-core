/**
 * Minimal protobuf reader for Anki's schema-18 config blobs (notetype/template
 * configs). It extracts top-level scalar fields by number — not a full decoder.
 * Pure bytes, DOM-free.
 */

export interface ProtoScalars {
  /** First length-delimited (string) value for `field`, or undefined. */
  string(field: number): string | undefined;
  /** First varint value for `field`, or undefined. */
  uint(field: number): number | undefined;
}

export function readProtoScalars(bytes: Uint8Array): ProtoScalars {
  const strings = new Map<number, string>();
  const uints = new Map<number, number>();
  let pos = 0;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [value, after] = readVarint(bytes, pos);
      pos = after;
      if (!uints.has(field)) uints.set(field, value);
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      const end = pos + len;
      if (!strings.has(field)) strings.set(field, new TextDecoder().decode(bytes.subarray(pos, end)));
      pos = end;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      break; // unknown wire type (groups) — stop
    }
  }
  return { string: (f) => strings.get(f), uint: (f) => uints.get(f) };
}

// Base-128 varint → [value, nextPosition]. Multiplication keeps values past 32
// bits correct (Anki configs stay small, but this stays safe regardless).
function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 1;
  let p = pos;
  while (p < bytes.length) {
    const b = bytes[p++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  return [result, p];
}
