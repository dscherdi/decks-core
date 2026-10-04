/**
 * Minimal HTTP abstraction so core stays free of any networking implementation
 * (no `fetch`, no `obsidian`). The plugin injects an implementation backed by
 * Obsidian's `requestUrl`, which bypasses CORS for provider REST endpoints.
 */
export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  text: string;
}

/**
 * What `HttpClient.stream` rejects with for a non-2xx response, so the caller can
 * tell a refusal (busy, over quota) from a transport that cannot stream.
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  /**
   * Optional streaming transport. Invokes `onChunk` with decoded text chunks as
   * they arrive (raw provider SSE bytes — the provider parses them), resolves
   * when the stream ends, and rejects with `HttpStatusError` on a non-2xx status
   * or any other error on a transport failure.
   * Honors `req.signal`. `requestUrl` can't stream, so the plugin implements
   * this with `fetch`; absence means callers fall back to `request()`.
   */
  stream?(req: HttpRequest, onChunk: (text: string) => void): Promise<void>;
}
