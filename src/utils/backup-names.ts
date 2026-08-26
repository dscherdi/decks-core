/**
 * Backup filenames, shared by both surfaces.
 *
 * The name used to be `backup-<date>.db`, with nothing in it to say which
 * device wrote it. Two devices reviewing on the same day therefore wrote the
 * same path, and in a synced vault that means one silently replaces the other or
 * the sync service forks it. A device segment makes them distinct files.
 *
 * Both surfaces must agree on this, and both must keep reading the old shape —
 * every backup already on disk has it.
 */

const PREFIX = "backup-";
const SUFFIX = ".db";
/** `YYYY-MM-DD`. */
const DATE_LENGTH = 10;

export interface ParsedBackupName {
  /** Local date the backup was taken, `YYYY-MM-DD`. */
  date: string;
  /** The device that wrote it, or null for a backup from before this format. */
  deviceId: string | null;
}

/** Trim a device id to something short enough to read in a filename. */
function shortDevice(deviceId: string): string {
  return deviceId.replace(/[^a-z0-9-]/gi, "").slice(0, 16);
}

export function buildBackupFilename(date: string, deviceId?: string | null): string {
  const device = deviceId ? shortDevice(deviceId) : "";
  return device
    ? `${PREFIX}${date}-${device}${SUFFIX}`
    : `${PREFIX}${date}${SUFFIX}`;
}

/**
 * Read a backup filename, or null when it is not one.
 *
 * Returning null for anything unrecognised is what keeps a sync service's
 * conflict copy — `backup-2026-08-18 2.db` — from being listed as a backup and
 * counted toward retention, where it could evict a real one.
 */
export function parseBackupFilename(filename: string): ParsedBackupName | null {
  if (!filename.startsWith(PREFIX) || !filename.endsWith(SUFFIX)) return null;
  const stem = filename.slice(PREFIX.length, filename.length - SUFFIX.length);
  const date = stem.slice(0, DATE_LENGTH);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const rest = stem.slice(DATE_LENGTH);
  if (rest === "") return { date, deviceId: null };
  if (!rest.startsWith("-")) return null;

  const deviceId = rest.slice(1);
  // Anything with a space or a punctuation mark is a copy, not a device.
  if (!/^[a-z0-9-]+$/i.test(deviceId)) return null;
  return { date, deviceId };
}

/** Epoch ms for sorting, from the name alone. */
export function backupTimestamp(filename: string): number {
  const parsed = parseBackupFilename(filename);
  if (!parsed) return 0;
  const ms = Date.parse(`${parsed.date}T12:00:00`);
  return Number.isNaN(ms) ? 0 : ms;
}
