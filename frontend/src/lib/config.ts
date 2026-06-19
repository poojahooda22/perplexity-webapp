// Backend URL. Set BUN_PUBLIC_BACKEND_URL in Vercel (prod) and in frontend/.env.local
// (dev) — Bun inlines `process.env.BUN_PUBLIC_*` at build/transpile time, so the literal
// value (not a `process` reference) ends up in the browser bundle. Falls back to the
// local dev server if unset.
export const BACKEND_URL =
  process.env.BUN_PUBLIC_BACKEND_URL || "http://localhost:3001";
