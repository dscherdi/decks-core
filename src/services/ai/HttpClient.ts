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

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  /**
   * Optional streaming transport. Invokes `onChunk` with decoded text chunks as
   * they arrive (raw provider SSE bytes — the provider parses them), resolves
   * when the stream ends, and rejects on a non-2xx status or transport error.
   * Honors `req.signal`. `requestUrl` can't stream, so the plugin implements
   * this with `fetch`; absence means callers fall back to `request()`.
   */
  stream?(req: HttpRequest, onChunk: (text: string) => void): Promise<void>;
}
