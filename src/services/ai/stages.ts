import { I18n } from "../../i18n/I18n";

/** Where a generation is, for the line the user watches while waiting. */
export type GenerationStage =
  | { kind: "reading"; done: number; total: number }
  | { kind: "sending" }
  | { kind: "server"; step: string; done?: number; total?: number }
  | { kind: "thinking"; since: number }
  | { kind: "writing"; card: number }
  | { kind: "section"; index: number; total: number; label: string }
  | { kind: "retrying" };

/** The stage in words; `now` makes the thinking time tick. */
export function stageLabel(stage: GenerationStage, now: number): string {
  const t = I18n.t.modals.aiGenerator;
  switch (stage.kind) {
    case "reading":
      return I18n.format(t.stageReading, { done: stage.done, total: stage.total });
    case "sending":
      return t.stageSending;
    case "server":
      return t.stageServer;
    case "thinking":
      return I18n.format(t.stageThinking, { seconds: Math.max(0, Math.floor((now - stage.since) / 1000)) });
    case "writing":
      return I18n.format(t.stageWriting, { n: stage.card });
    case "section":
      return I18n.format(t.stageSection, { index: stage.index, total: stage.total, label: stage.label });
    case "retrying":
      return t.stageRetrying;
  }
}

/** After this long with the stream open but no answer text, the model is taken to be thinking. */
export const SILENT_THINKING_MS = 3_000;
