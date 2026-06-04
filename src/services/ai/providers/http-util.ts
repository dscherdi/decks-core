import type { HttpClient, HttpRequest, HttpResponse } from "../HttpClient";
import { AiError } from "../types";

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
  if (res.status === 429) {
    throw new AiError("rate_limited", truncate(res.text), res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new AiError(
      "provider_error",
      `Provider returned ${res.status}: ${truncate(res.text)}`,
      res.status,
    );
  }
  return res;
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
): Promise<void> {
  if (!http.stream) {
    throw new AiError("provider_error", "Streaming is not supported by the transport");
  }
  checkAborted(req.signal);

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
    await http.stream(req, (chunk) => {
      buffer += chunk;
      drainLines(false);
    });
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError("network_error", e instanceof Error ? e.message : String(e));
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
