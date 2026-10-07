import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo, type Zippable } from "fflate";
import { CURRENT_SCHEMA_VERSION } from "../../database/schema-version";
import { sha256Hex } from "../../utils/sha256";
import {
  DPKG_FORMAT_VERSION,
  DpkgError,
  dpkgMediaPath,
  parseDpkgManifest,
  type DpkgManifest,
  type DpkgMediaEntry,
} from "./manifest";

export const DPKG_MANIFEST_PATH = "manifest.json";
export const DPKG_DECK_DB_PATH = "deck.db";
export const DPKG_CARDS_JSON_PATH = "cards.json";

const MEDIA_ENTRY_PATTERN = /^media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/;

export interface DpkgLimits {
  maxPackageBytes: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  maxMediaFiles: number;
}

export const DEFAULT_DPKG_LIMITS: DpkgLimits = {
  maxPackageBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxMediaFiles: 20_000,
};

export interface DpkgContents {
  manifest: DpkgManifest;
  deckDb: Uint8Array;
  cardsJson: string | null;
  /** Keyed by sha256; empty when media was not requested. */
  media: Map<string, Uint8Array>;
}

export interface UnpackDpkgOptions {
  includeMedia?: boolean;
  /** Check every hash and size against the manifest. On by default. */
  verify?: boolean;
  limits?: Partial<DpkgLimits>;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Read a package. Only the expected entries are inflated, within the size limits. */
export async function unpackDpkg(bytes: Uint8Array, options: UnpackDpkgOptions = {}): Promise<DpkgContents> {
  const limits = { ...DEFAULT_DPKG_LIMITS, ...options.limits };
  const includeMedia = options.includeMedia ?? true;
  const verify = options.verify ?? true;

  if (bytes.length > limits.maxPackageBytes) {
    throw new DpkgError("too_large", "The package is larger than allowed");
  }
  if (!isZip(bytes)) throw new DpkgError("not_a_package", "The file is not a Decks package");

  let uncompressed = 0;
  let mediaFiles = 0;
  const admit = (file: UnzipFileInfo): boolean => {
    const isMedia = MEDIA_ENTRY_PATTERN.test(file.name);
    const wanted =
      file.name === DPKG_MANIFEST_PATH ||
      file.name === DPKG_DECK_DB_PATH ||
      file.name === DPKG_CARDS_JSON_PATH ||
      (isMedia && includeMedia);
    if (!wanted) return false;
    if (isMedia && ++mediaFiles > limits.maxMediaFiles) {
      throw new DpkgError("too_large", "The package holds too many media files");
    }
    if (file.originalSize > limits.maxEntryBytes) {
      throw new DpkgError("too_large", `${file.name} is larger than allowed`);
    }
    uncompressed += file.originalSize;
    if (uncompressed > limits.maxUncompressedBytes) {
      throw new DpkgError("too_large", "The package expands beyond the allowed size");
    }
    return true;
  };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: admit });
  } catch (error) {
    if (error instanceof DpkgError) throw error;
    throw new DpkgError("not_a_package", "The package could not be read");
  }

  const manifestBytes = entries[DPKG_MANIFEST_PATH];
  if (!manifestBytes) throw new DpkgError("missing_entry", "The package has no manifest.json");
  const manifest = parseDpkgManifest(strFromU8(manifestBytes));

  const deckDb = entries[DPKG_DECK_DB_PATH];
  if (!deckDb) throw new DpkgError("missing_entry", "The package has no deck.db");
  if (verify && (await sha256Hex(deckDb)) !== manifest.dbSha256) {
    throw new DpkgError("hash_mismatch", "deck.db does not match its manifest");
  }

  const media = new Map<string, Uint8Array>();
  if (includeMedia) {
    const listed = new Map(manifest.media.map((entry) => [dpkgMediaPath(entry), entry]));
    for (const [name, data] of Object.entries(entries)) {
      if (!MEDIA_ENTRY_PATTERN.test(name)) continue;
      const entry = listed.get(name);
      // Files the manifest does not name are never surfaced.
      if (!entry) continue;
      if (verify && (data.length !== entry.size || (await sha256Hex(data)) !== entry.sha256)) {
        throw new DpkgError("hash_mismatch", `${name} does not match its manifest`);
      }
      media.set(entry.sha256, data);
    }
    const missing = manifest.media.find((entry) => !media.has(entry.sha256));
    if (missing) throw new DpkgError("missing_entry", `The package is missing ${dpkgMediaPath(missing)}`);
  }

  const cardsJsonBytes = entries[DPKG_CARDS_JSON_PATH];
  return {
    manifest,
    deckDb,
    cardsJson: cardsJsonBytes ? strFromU8(cardsJsonBytes) : null,
    media,
  };
}

export interface DpkgMediaInput {
  bytes: Uint8Array;
  ext: string;
  mime: string;
}

export type DpkgManifestDraft = Omit<DpkgManifest, "formatVersion" | "schemaVersion" | "media" | "dbSha256" | "exam"> & {
  exam?: DpkgManifest["exam"];
};

export interface PackDpkgInput {
  manifest: DpkgManifestDraft;
  deckDb: Uint8Array;
  cardsJson: string;
  media: DpkgMediaInput[];
}

/** Write a package. Media is stored uncompressed (already-compressed formats) and deduplicated. */
export async function packDpkg(input: PackDpkgInput): Promise<{ bytes: Uint8Array; manifest: DpkgManifest }> {
  const mediaEntries: DpkgMediaEntry[] = [];
  const files: Zippable = {};
  const seen = new Set<string>();
  for (const item of input.media) {
    const sha256 = await sha256Hex(item.bytes);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const entry: DpkgMediaEntry = { sha256, ext: item.ext.toLowerCase(), mime: item.mime, size: item.bytes.length };
    mediaEntries.push(entry);
    files[dpkgMediaPath(entry)] = [item.bytes, { level: 0 }];
  }

  const manifest: DpkgManifest = {
    ...input.manifest,
    exam: input.manifest.exam ?? null,
    formatVersion: DPKG_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    media: mediaEntries,
    dbSha256: await sha256Hex(input.deckDb),
  };
  // Round-trip through the parser so a package is never written that this build would refuse.
  parseDpkgManifest(JSON.stringify(manifest));

  const ordered: Zippable = {
    [DPKG_MANIFEST_PATH]: strToU8(JSON.stringify(manifest, null, 2)),
    [DPKG_DECK_DB_PATH]: input.deckDb,
    [DPKG_CARDS_JSON_PATH]: strToU8(input.cardsJson),
    ...files,
  };
  return { bytes: zipSync(ordered, { level: 6 }), manifest };
}
