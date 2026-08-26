/**
 * The file operations anchor stamping needs, and nothing else.
 *
 * Stamping writes a token into the note a card came from, so it has to read and
 * rewrite markdown. That is the only platform-specific thing about it — the rest
 * is parsing and binding logic that both surfaces already share. Keeping the
 * seam this small is what lets the stamper live here rather than twice.
 */
export interface NoteAccess {
  /** Current text, or null when the note is gone. */
  read(path: string): Promise<string | null>;

  /**
   * Read, transform, write — in one step where the platform can do that.
   *
   * Obsidian's `Vault.process` is atomic against its own concurrent writes, and
   * passing the callback through rather than doing read-then-write here is what
   * preserves that. The edit must be pure: it can be called more than once.
   */
  process(path: string, edit: (current: string) => string): Promise<void>;

  /** Last-modified epoch ms, or 0 when the platform cannot say. */
  mtime(path: string): Promise<number>;

  /** A frontmatter string property, or null when absent. */
  readProperty(path: string, key: string): Promise<string | null>;

  /** Set one frontmatter property, leaving the rest of the note untouched. */
  writeProperty(path: string, key: string, value: string): Promise<void>;
}
