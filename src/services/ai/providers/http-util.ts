import { HttpStatusError, type HttpClient, type HttpRequest, type HttpResponse } from "../HttpClient";
import { AiError } from "../types";
import { I18n } from "../../../i18n/I18n";

/** The backend's machine-readable reason, or "" for a non-JSON body. */
function bodyCode(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      return String(parsed.code);
    }
  } catch {
    // Not JSON — the caller falls through to a generic message.
  }
  return "";
}

/** Map the backend's quota reason onto a localized, actionable message. */
function quotaMessage(body: string): string {
  const s = I18n.t.settings.ai;
  const code = bodyCode(body);
  if (code === "daily_quota_exceeded") return s.dailyLimitReached;
  if (code === "trial_exhausted") return s.trialExhausted;
  return s.subscriptionNone;
}

// Null means "not one of ours" — a BYO provider's body is often the only clue
// (a rejected key, an unknown model), so the caller shows it rather than a stock line.
function hostedMessage(body: string, status: number): string | null {
  const s = I18n.t.settings.ai;
  const code = bodyCode(body);
  if (code === "rate_limited") return s.rateLimited;
  if (code === "upstream_unavailable") {
    return status === 429 ? s.serviceBusy : s.serviceUnavailable;
  }
  return null;
}

/** Throw if the request has already been aborted. */
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AiError("aborted", "Request was cancelled");
  }
}

/**
 * Perform an HTTP request, normalizing transport failures and non-2xx
 * responses into typed AiErrors. Returns the response on success (2xx).
 */
export async function sendJson(
  http: HttpClient,
  req: HttpRequest,
): Promise<HttpResponse> {
  checkAborted(req.signal);
  let res: HttpResponse;
  try {
    res = await http.request(req);
  } catch (e) {
    throw new AiError(
      "network_error",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (res.status < 200 || res.status >= 300) throw httpFailure(res.status, res.text);
  return res;
}

/** The typed error for a non-2xx response, the same for a request and a stream. */
export function httpFailure(status: number, text: string): AiError {
  if (status === 429) {
    return new AiError("rate_limited", hostedMessage(text, status) ?? I18n.t.settings.ai.rateLimited, status);
  }
  // 402 carries a machine-readable reason from the hosted backend, which decides
  // whether the user should wait until tomorrow or subscribe.
  if (status === 402) return new AiError("quota_exceeded", quotaMessage(text), status);
  return new AiError(
    "provider_error",
    hostedMessage(text, status) ?? `Provider returned ${status}: ${truncate(text)}`,
    status,
  );
}

export interface StreamOptions {
  /** Fail when no byte arrives within this long. */
  firstByteMs?: number;
  /** Fail when the stream goes this long without a byte once it has started. */
  idleMs?: number;
  /** Called on every chunk, keep-alives included. */
  onActivity?: () => void;
}

/**
 * Stream a request as Server-Sent Events, invoking `onData` with the payload of
 * each `data:` line (the trailing JSON, or `[DONE]`). Buffers across chunk
 * boundaries so a `data:` line split between two network chunks is still parsed
 * once. Throws `provider_error` if the transport has no streaming support.
 */
export async function streamSse(
  http: HttpClient,
  req: HttpRequest,
  onData: (payload: string) => void,
  opts: StreamOptions = {},
): Promise<void> {
  if (!http.stream) {
    throw new AiError("provider_error", "Streaming is not supported by the transport");
  }
  checkAborted(req.signal);

  // Our own controller, linked by hand to the caller's, so a silence can end the request.
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  req.signal?.addEventListener("abort", forward, { once: true });
  let silence: "first_byte" | "idle" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number | undefined, phase: "first_byte" | "idle"): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = ms ? setTimeout(() => {
      silence = phase;
      controller.abort();
    }, ms) : undefined;
  };
  arm(opts.firstByteMs, "first_byte");

  let buffer = "";
  const drainLines = (final: boolean): void => {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      emit(line);
    }
    if (final && buffer.length > 0) {
      emit(buffer);
      buffer = "";
    }
  };
  const emit = (line: string): void => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("data:")) {
      onData(trimmed.slice(5).trim());
    }
  };

  try {
    await http.stream({ ...req, signal: controller.signal }, (chunk) => {
      arm(opts.idleMs, "idle");
      opts.onActivity?.();
      buffer += chunk;
      drainLines(false);
    });
  } catch (e) {
    if (silence) {
      throw new AiError(
        "timeout",
        silence === "first_byte" ? I18n.t.settings.ai.noResponse : I18n.t.settings.ai.streamStalled,
      );
    }
    if (e instanceof AiError) throw e;
    if (e instanceof HttpStatusError) throw httpFailure(e.status, e.body);
    throw new AiError("network_error", e instanceof Error ? e.message : String(e));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    req.signal?.removeEventListener("abort", forward);
  }
  drainLines(true);
}

/** Parse a JSON response body, mapping malformed bodies to provider_error. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError("provider_error", "Provider returned non-JSON response");
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
