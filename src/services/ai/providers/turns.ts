import type { ProviderCompleteRequest } from "./AiProvider";

export type TurnRole = "user" | "assistant";

export interface Turn {
  role: TurnRole;
  text: string;
}

/**
 * Ordered non-system turns derived from a request: the static first user
 * message, an optional dynamic assistant turn (cards-so-far), and an optional
 * trailing user turn (the instruction/continue trigger). Always starts with a
 * user turn.
 */
export function buildTurns(req: ProviderCompleteRequest): Turn[] {
  const turns: Turn[] = [{ role: "user", text: req.user }];
  if (req.priorAssistant) turns.push({ role: "assistant", text: req.priorAssistant });
  if (req.followupUser) turns.push({ role: "user", text: req.followupUser });
  return turns;
}

/**
 * Merge adjacent same-role turns into one (joined by a blank line). Providers
 * whose APIs reject consecutive same-role messages (Claude, Gemini) use this;
 * OpenAI keeps the turns separate to preserve a byte-identical cache prefix.
 */
export function coalesceAdjacentRoles(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.text = `${last.text}\n\n${turn.text}`;
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}
