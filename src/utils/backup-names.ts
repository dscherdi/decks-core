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
 *
 * Automatic backups stay one per day per device, so retention still counts
 * days. A backup someone asks for, or one taken before a restore, adds the time
 * (`backup-<date>-<HHmmss>-<device>.db`) so it never replaces an earlier one.
 * Older parsers read that segment as part of the device id, so they list it too.
 */

const PREFIX = "backup-";
const SUFFIX = ".db";
/** `YYYY-MM-DD`. */
const DATE_LENGTH = 10;
/** `HHmmss`. */
const TIME = /^\d{6}$/;

export interface ParsedBackupName {
  /** Local date the backup was taken, `YYYY-MM-DD`. */
  date: string;
  /** The device that wrote it, or null for a backup from before this format. */
  deviceId: string | null;
  /** Local time of a backup that is not the day's automatic one, `HHmmss`. */
  time: string | null;
}

/** Trim a device id to something short enough to read in a filename. */
function shortDevice(deviceId: string): string {
  return deviceId.replace(/[^a-z0-9-]/gi, "").slice(0, 16);
}

export function buildBackupFilename(
  date: string,
  deviceId?: string | null,
  time?: string | null
): string {
  const segments = [date];
  if (time && TIME.test(time)) segments.push(time);
  const device = deviceId ? shortDevice(deviceId) : "";
  if (device) segments.push(device);
  return `${PREFIX}${segments.join("-")}${SUFFIX}`;
}

/** `HHmmss` in local time, for a backup that must not replace the day's. */
export function backupTimeOfDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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
  if (rest === "") return { date, deviceId: null, time: null };
  if (!rest.startsWith("-")) return null;

  let tail = rest.slice(1);
  let time: string | null = null;
  const timed = /^(\d{6})(?:-(.*))?$/.exec(tail);
  if (timed) {
    time = timed[1];
    tail = timed[2] ?? "";
    if (tail === "") return { date, deviceId: null, time };
  }
  // Anything with a space or a punctuation mark is a copy, not a device.
  if (!/^[a-z0-9-]+$/i.test(tail)) return null;
  return { date, deviceId: tail, time };
}

/** Epoch ms for sorting, from the name alone. */
export function backupTimestamp(filename: string): number {
  const parsed = parseBackupFilename(filename);
  if (!parsed) return 0;
  const clock = parsed.time
    ? `${parsed.time.slice(0, 2)}:${parsed.time.slice(2, 4)}:${parsed.time.slice(4, 6)}`
    : "12:00:00";
  const ms = Date.parse(`${parsed.date}T${clock}`);
  return Number.isNaN(ms) ? 0 : ms;
}
