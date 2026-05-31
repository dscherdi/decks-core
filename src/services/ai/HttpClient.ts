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
}
