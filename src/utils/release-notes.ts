export interface ReleaseNotesOptions {
  /**
   * Whether a first run — nothing seen yet — counts as something to show.
   *
   * The plugin says yes: an install lands in a vault that already has notes, so
   * the notes are the introduction. A surface that greets a first run some other
   * way passes false, and then only an actual change of version shows them.
   */
  showOnFirstInstall?: boolean;
}

/**
 * Whether to show the release notes for this run.
 *
 * True on a version change in either direction — a downgrade is still a
 * different build from the one the user was last shown.
 */
export function shouldShowReleaseNotes(
  currentVersion: string | undefined,
  lastSeenVersion: string | undefined,
  options: ReleaseNotesOptions = {},
): boolean {
  // No version to compare is not an update; showing on every launch would be
  // worse than never showing.
  if (!currentVersion) return false;
  const { showOnFirstInstall = true } = options;
  if (!lastSeenVersion) return showOnFirstInstall;
  return currentVersion !== lastSeenVersion;
}
