import { mock } from "bun:test";

// Minimal Express req/res/next doubles for testing middleware + handlers WITHOUT spinning the app.
// res records statusCode / body / headers and every method is a Bun mock for call assertions.

export function makeReq(overrides: Record<string, unknown> = {}) {
  return { headers: {}, body: {}, params: {}, query: {}, ...overrides } as any;
}

export function makeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = mock((code: number) => { res.statusCode = code; return res; });
  res.json = mock((b: unknown) => { res.body = b; return res; });
  res.send = mock((b: unknown) => { res.body = b; return res; });
  res.sendStatus = mock((code: number) => { res.statusCode = code; return res; });
  res.setHeader = mock((k: string, v: string) => { res.headers[k] = v; });
  res.header = mock((k: string, v: string) => { res.headers[k] = v; return res; });
  res.end = mock(() => res);
  return res;
}

export function makeNext() {
  return mock((_err?: unknown) => {});
}