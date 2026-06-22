import { mock } from "bun:test";

type RouteSpec = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
type Routes = Record<string, RouteSpec | ((url: URL, init?: RequestInit) => RouteSpec)>;

export interface FetchMock {
  /** Every request made while the mock is installed. */
  calls: Array<{ url: URL; method: string; init?: RequestInit }>;
  restore: () => void;
}

/**
 * Replace global.fetch, routing by URL substring. Keys are "/path" or "METHOD /path"; the first
 * key whose path the request URL CONTAINS wins. Unmatched requests return 501 (so a missing mock
 * is loud, not a silent real network call). Use in a test, restore() in afterEach.
 */
export function mockFetch(routes: Routes): FetchMock {
  const original = global.fetch;
  const calls: FetchMock["calls"] = [];

  global.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : (input as Request).url;
    const url = new URL(urlStr);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, init });

    let spec: RouteSpec | ((u: URL, i?: RequestInit) => RouteSpec) | undefined;
    for (const [key, val] of Object.entries(routes)) {
      const [m, path] = key.includes(" ") ? key.split(/\s+/) : ["", key];
      if (m && m.toUpperCase() !== method) continue;
      if (urlStr.includes(path!)) {
        spec = val;
        break;
      }
    }
    if (!spec) return new Response(`no mock for ${method} ${urlStr}`, { status: 501 });

    const r = typeof spec === "function" ? spec(url, init) : spec;
    const headers = new Headers(r.headers);
    if (r.json !== undefined) {
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers });
    }
    return new Response(r.text ?? "", { status: r.status ?? 200, headers });
  }) as unknown as typeof fetch;

  return { calls, restore: () => { global.fetch = original; } };
}