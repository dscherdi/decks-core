import type { AiSession } from "../../database/types";

/** A source path as a name: the file, without its folder or extension. */
export function sourceDisplayName(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const file = trimmed.split("/").pop() ?? trimmed;
  return file.replace(/\.(md|markdown|pdf|canvas)$/i, "") || trimmed;
}

/** What to call a session: its source, or for a prompt-only session what was first asked. */
export function sessionName(
  session: Pick<AiSession, "sourceRef" | "turns">,
  maxPromptChars = 60,
): string | null {
  const fromSource = sourceDisplayName(session.sourceRef);
  if (fromSource) return fromSource;
  const asked = session.turns.find((t) => t.role === "user")?.text.trim();
  if (!asked) return null;
  return asked.length > maxPromptChars ? `${asked.slice(0, maxPromptChars)}…` : asked;
}
