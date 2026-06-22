// Route `global.fetch` by pathname. This is the single mock boundary for the whole data layer:
// api.ts / finance-api.ts / discover-api.ts all hit `fetch(`${BACKEND_URL}${path}`)`, so stubbing
// fetch exercises the REAL parsing + hooks + components together (true to "test every API case")
// while staying fully offline. No `mock.module` on hooks/components → no cross-file mock leakage.
import { mock } from "bun:test";

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Stream the body as chunks (for the streaming /perplexity_ask endpoints). */
  stream?: string | string[];
}

export interface FetchCallInfo {
  url: URL;
  pathname: string;
  method: string;
  body: unknown;
  headers: Headers;
}

type RouteHandler = (info: FetchCallInfo) => MockResponse | Promise<MockResponse>;
/** Either a single catch-all handler, or a map keyed by "/path" or "METHOD /path". */
export type Routes = Record<string, MockResponse | RouteHandler> | RouteHandler;

let originalFetch: typeof fetch | undefined;

export interface FetchMockControls {
  /** Every call made through the mock, in order — assert URLs / bodies / query params on these. */
  calls: FetchCallInfo[];
  fn: ReturnType<typeof mock>;
}

export function mockFetch(routes: Routes): FetchMockControls {
  if (originalFetch === undefined) originalFetch = globalThis.fetch;
  const calls: FetchCallInfo[] = [];

  const fn = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(rawUrl, "http://localhost:3001");
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? (input as Request).method : "GET") ??
      "GET"
    ).toUpperCase();
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined),
    );
    let body: unknown;
    const rawBody = init?.body;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const info: FetchCallInfo = { url, pathname: url.pathname, method, body, headers };
    calls.push(info);

    let route: MockResponse | RouteHandler | undefined;
    if (typeof routes === "function") route = routes;
    else route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];

    if (!route) {
      return makeResponse({ status: 404, json: { error: `no fetch mock for ${method} ${url.pathname}` } });
    }
    const resolved = typeof route === "function" ? await route(info) : route;
    return makeResponse(resolved);
  });

  globalThis.fetch = fn as unknown as typeof fetch;
  return { calls, fn };
}

function makeResponse(r: MockResponse): Response {
  const headers = new Headers({ "content-type": "application/json", ...(r.headers ?? {}) });
  if (r.stream !== undefined) {
    const chunks = Array.isArray(r.stream) ? r.stream : [r.stream];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: r.status ?? 200, headers });
  }
  const payload = r.text !== undefined ? r.text : r.json !== undefined ? JSON.stringify(r.json) : "";
  return new Response(payload, { status: r.status ?? 200, headers });
}

/** Restore the original fetch. Called from the global afterEach. */
export function restoreFetch(): void {
  if (originalFetch !== undefined) globalThis.fetch = originalFetch;
}
