import type { DirectoryDeckRecord } from "./DirectoryStore";
import { dpkgMediaPath, parseDpkgManifest } from "./manifest";

/** The stored file names (`<sha256>.<ext>`) of the media a package lists. */
export function directoryDeckMediaNames(manifestJson: string): string[] {
  try {
    return parseDpkgManifest(manifestJson).media.map((entry) => dpkgMediaPath(entry).slice("media/".length));
  } catch {
    return [];
  }
}

/**
 * Files that only removed packages list, each with the latest removal. A media folder can be shared
 * with other devices, so a file nobody here has heard of is never a candidate.
 */
export function directoryMediaToPrune(records: readonly DirectoryDeckRecord[]): Map<string, string> {
  const live = new Set<string>();
  for (const record of records) {
    if (record.removedAt === null) for (const name of directoryDeckMediaNames(record.manifestJson)) live.add(name);
  }
  const prune = new Map<string, string>();
  for (const record of records) {
    const removedAt = record.removedAt;
    if (removedAt === null) continue;
    for (const name of directoryDeckMediaNames(record.manifestJson)) {
      if (live.has(name)) continue;
      const known = prune.get(name);
      if (!known || known < removedAt) prune.set(name, removedAt);
    }
  }
  return prune;
}
