/**
 * Reads the `media` manifest from an Anki `.apkg`. Two formats exist:
 *   - Legacy JSON: `{"0":"file.mp3","1":"img.jpg",...}` (entry key → filename).
 *   - Modern protobuf `MediaEntries`: top-level field 1 is a repeated
 *     `MediaEntry`; each entry's field 1 is its `name` (string) and its 0-based
 *     position is the numbered media-blob key.
 *
 * Both are normalized to the same `filename → entryKey` map the importer uses.
 * Pure bytes — no DOM, reused by the plugin and the mobile app.
 */

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** True when the bytes begin with the zstd frame magic `28 B5 2F FD`. */
export function isZstd(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZSTD_MAGIC[0] &&
    bytes[1] === ZSTD_MAGIC[1] &&
    bytes[2] === ZSTD_MAGIC[2] &&
    bytes[3] === ZSTD_MAGIC[3]
  );
}

/** Parse the `media` manifest into a `filename → entryKey` map. */
export function parseMediaManifest(bytes: Uint8Array): Map<string, string> {
  const byName = new Map<string, string>();
  if (!bytes || bytes.length === 0) return byName;

  if (looksLikeJson(bytes)) {
    try {
      const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (json && typeof json === "object") {
        for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
          if (typeof value === "string") byName.set(value, key);
        }
      }
      return byName;
    } catch {
      // Not JSON after all — fall through to the protobuf reader.
    }
  }

  parseProtobufManifest(bytes, byName);
  return byName;
}

// The legacy map is a JSON object → first non-whitespace byte is `{`.
function looksLikeJson(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x7b; // '{'
  }
  return false;
}

function parseProtobufManifest(bytes: Uint8Array, byName: Map<string, string>): void {
  let pos = 0;
  let index = 0;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 1 && wire === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      const end = pos + len;
      const name = readEntryName(bytes, pos, end);
      if (name) byName.set(name, String(index));
      index++;
      pos = end;
    } else {
      pos = skipField(bytes, pos, wire);
    }
  }
}

// A MediaEntry's field 1 (wire type 2) is its filename.
function readEntryName(bytes: Uint8Array, start: number, end: number): string | null {
  let pos = start;
  while (pos < end) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 1 && wire === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      return new TextDecoder().decode(bytes.subarray(pos, Math.min(pos + len, end)));
    }
    pos = skipField(bytes, pos, wire);
  }
  return null;
}

function skipField(bytes: Uint8Array, pos: number, wire: number): number {
  switch (wire) {
    case 0: // varint
      return readVarint(bytes, pos)[1];
    case 2: { // length-delimited
      const [len, afterLen] = readVarint(bytes, pos);
      return afterLen + len;
    }
    case 5: // 32-bit
      return pos + 4;
    case 1: // 64-bit
      return pos + 8;
    default:
      return bytes.length; // unknown wire type → stop
  }
}

// Base-128 varint → [value, nextPosition]. Uses multiplication so values past
// 32 bits don't overflow (manifest values are small, but stay correct anyway).
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
