import {
  buildBackupFilename,
  parseBackupFilename,
  backupTimestamp,
} from "../backup-names";

describe("backup filenames", () => {
  it("keeps reading the shape every existing backup already has", () => {
    expect(parseBackupFilename("backup-2026-08-18.db")).toEqual({
      date: "2026-08-18",
      deviceId: null,
    });
    expect(backupTimestamp("backup-2026-08-18.db")).toBe(
      Date.parse("2026-08-18T12:00:00")
    );
  });

  it("round-trips a device segment", () => {
    const name = buildBackupFilename("2026-08-26", "ios-33184bac5813");
    expect(name).toBe("backup-2026-08-26-ios-33184bac5813.db");
    expect(parseBackupFilename(name)).toEqual({
      date: "2026-08-26",
      deviceId: "ios-33184bac5813",
    });
  });

  it("trims a device id long enough to bloat the name", () => {
    const name = buildBackupFilename("2026-08-26", "a-very-long-device-identifier");
    expect(name).toBe("backup-2026-08-26-a-very-long-devi.db");
    expect(parseBackupFilename(name)?.date).toBe("2026-08-26");
  });

  it("gives two devices distinct names on the same day", () => {
    expect(buildBackupFilename("2026-08-26", "mac-b11fbdb32169")).not.toBe(
      buildBackupFilename("2026-08-26", "ios-33184bac5813")
    );
  });

  it("refuses a sync service's conflict copy", () => {
    // This is the point: a copy counted as a backup can evict a real one.
    expect(parseBackupFilename("backup-2026-08-18 2.db")).toBeNull();
    expect(
      parseBackupFilename("backup-2026-08-18 (conflicted copy).db")
    ).toBeNull();
    expect(
      parseBackupFilename("backup-2026-08-18.sync-conflict-20260819.db")
    ).toBeNull();
  });

  it("refuses anything that is not a backup", () => {
    expect(parseBackupFilename("flashcards.db")).toBeNull();
    expect(parseBackupFilename("backup-notadate.db")).toBeNull();
    expect(parseBackupFilename("backup-2026-08-18.db.absorbed-x")).toBeNull();
    expect(backupTimestamp("flashcards.db")).toBe(0);
  });
});
