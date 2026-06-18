// In production set BUN_PUBLIC_BACKEND_URL (in Vercel) to the deployed backend URL,
// e.g. https://perplexity-backend.vercel.app. It's inlined at build time (build.ts
// env: "BUN_PUBLIC_*"). Falls back to the local dev server.
export const BACKEND_URL =
  process.env.BUN_PUBLIC_BACKEND_URL ||
  (import.meta.env && import.meta.env.BUN_PUBLIC_BACKEND_URL) ||
  "http://localhost:3001";
