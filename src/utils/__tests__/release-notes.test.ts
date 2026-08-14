import { shouldShowReleaseNotes } from "../release-notes";

describe("showing release notes after an update", () => {
  it("shows them once per version, not on every launch", () => {
    expect(shouldShowReleaseNotes("2.6.0", "2.5.7")).toBe(true);
    // The version is recorded as soon as they are shown, so the next launch
    // must be silent — this is the difference between a notice and a nuisance.
    expect(shouldShowReleaseNotes("2.6.0", "2.6.0")).toBe(false);
  });

  it("shows them on a fresh install, where nothing has been seen", () => {
    expect(shouldShowReleaseNotes("2.6.0", "")).toBe(true);
    expect(shouldShowReleaseNotes("2.6.0", undefined)).toBe(true);
  });

  // Rolling back is still a different build from the one last shown.
  it("shows them on a downgrade", () => {
    expect(shouldShowReleaseNotes("2.5.7", "2.6.0")).toBe(true);
  });

  // Without a version there is nothing to compare, so every launch would count
  // as a change and reopen the notes forever.
  it("stays silent when there is no current version", () => {
    expect(shouldShowReleaseNotes("", "2.6.0")).toBe(false);
    expect(shouldShowReleaseNotes(undefined, "")).toBe(false);
  });

  describe("when a first install is greeted some other way", () => {
    const firstRunSilent = { showOnFirstInstall: false };

    it("says nothing on a first run — there is no 'new' to report yet", () => {
      expect(shouldShowReleaseNotes("1.2.0", "", firstRunSilent)).toBe(false);
      expect(shouldShowReleaseNotes("1.2.0", undefined, firstRunSilent)).toBe(false);
    });

    // The first run still has to record what it saw, or the upgrade after it
    // looks like another first run and stays silent too.
    it("still shows them on the upgrade that follows", () => {
      expect(shouldShowReleaseNotes("1.3.0", "1.2.0", firstRunSilent)).toBe(true);
      expect(shouldShowReleaseNotes("1.3.0", "1.3.0", firstRunSilent)).toBe(false);
    });
  });
});
