import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type {
  AiProvider,
  ProviderCompleteRequest,
  CompleteResult,
  StreamEvents,
  StreamResult,
  StreamTimeouts,
} from "./AiProvider";
import { parseJsonBody, sendJson, streamSse } from "./http-util";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }>;
}

interface ReasoningDetail {
  type?: string;
  text?: unknown;
  summary?: unknown;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      /** Thinking text; servers name it either way. */
      reasoning?: unknown;
      reasoning_content?: unknown;
      reasoning_details?: ReasoningDetail[];
    };
    finish_reason?: string | null;
  }>;
  error?: { code?: unknown; message?: unknown };
  /** A step reported by the hosted backend before the model starts. */
  decks?: { stage?: { step?: unknown; done?: unknown; total?: unknown } };
}

/** The thinking text a chunk carries, from whichever field the server used. */
export function reasoningOf(delta: NonNullable<NonNullable<ChatCompletionChunk["choices"]>[number]["delta"]>): string {
  const direct = delta.reasoning ?? delta.reasoning_content;
  if (typeof direct === "string") return direct;
  // Encrypted details carry no readable text and are skipped.
  return (delta.reasoning_details ?? [])
    .filter((d) => d.type !== "reasoning.encrypted")
    .map((d) => (typeof d.text === "string" ? d.text : typeof d.summary === "string" ? d.summary : ""))
    .join("");
}

/**
 * OpenAI Chat Completions, also reused by the openai-compatible provider
 * (Ollama, LM Studio, vLLM, …) which speaks the same wire format.
 */
export class OpenAiProvider implements AiProvider {
  readonly id: AiProviderId;

  constructor(
    protected readonly config: AiProviderConfig,
    protected readonly http: HttpClient,
  ) {
    this.id = config.provider;
  }

  protected endpoint(): string {
    return "https://api.openai.com/v1/chat/completions";
  }

  /** Whether to request strict JSON output (hosted OpenAI supports it). */
  protected useJsonResponseFormat(): boolean {
    return true;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  protected buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
    const firstUserContent = req.images?.length
      ? [
          { type: "text", text: req.user },
          ...req.images.map((im) => ({
            type: "image_url",
            image_url: { url: `data:${im.mimeType};base64,${im.dataBase64}` },
          })),
        ]
      : req.user;
    // Emit messages separately (no coalescing): keeping the source-notes user
    // message on its own preserves a byte-identical system+user cache prefix.
    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: firstUserContent },
    ];
    if (req.priorAssistant) {
      messages.push({ role: "assistant", content: req.priorAssistant });
    }
    if (req.followupUser) {
      messages.push({ role: "user", content: req.followupUser });
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
    };
    if (this.useJsonResponseFormat() && req.json !== false) {
      body["response_format"] = { type: "json_object" };
    }
    return body;
  }

  async complete(req: ProviderCompleteRequest): Promise<string> {
    return (await this.completeWithMeta(req)).text;
  }

  async completeWithMeta(req: ProviderCompleteRequest): Promise<CompleteResult> {
    const res = await sendJson(this.http, {
      url: this.endpoint(),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });

    const parsed = parseJsonBody(res.text) as ChatCompletionResponse;
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new AiError("invalid_output", "Response had no message content");
    }
    return { text: content, finishReason: choice?.finish_reason ?? undefined };
  }

  /** Hosted endpoints answer quickly or not at all; a local server may load a model first. */
  streamTimeouts(): StreamTimeouts {
    return { firstByteMs: 60_000, idleMs: 60_000 };
  }

  async completeStream(
    req: ProviderCompleteRequest,
    onDelta: (text: string) => void,
    events?: StreamEvents,
  ): Promise<StreamResult> {
    const body = { ...this.buildBody(req), stream: true };
    let finishReason: string | undefined;
    await streamSse(
      this.http,
      {
        url: this.endpoint(),
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      },
      (data) => {
        if (data === "[DONE]") return;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          return;
        }
        // An error after the stream opened arrives as a chunk, not a status.
        if (chunk.error) {
          const message = typeof chunk.error.message === "string" ? chunk.error.message : "Stream failed";
          throw new AiError("provider_error", message);
        }
        const stage = chunk.decks?.stage;
        if (stage && typeof stage.step === "string") {
          events?.onServerStage?.({
            step: stage.step,
            done: typeof stage.done === "number" ? stage.done : undefined,
            total: typeof stage.total === "number" ? stage.total : undefined,
          });
          return;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta) {
          const thought = reasoningOf(choice.delta);
          if (thought) events?.onReasoning?.(thought);
          const delta = choice.delta.content;
          if (typeof delta === "string" && delta) onDelta(delta);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      },
      { ...this.streamTimeouts(), onActivity: events?.onActivity },
    );
    return { finishReason };
  }
}
