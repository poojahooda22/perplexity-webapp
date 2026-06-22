// URL-friendly slug from a query, e.g. "Best way to learn Rust?" -> "best-way-to-learn-rust-ab12cd34".
// A random 8-char suffix keeps slugs unique even for identical queries. Pure (uses global crypto).
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "conversation"}-${crypto.randomUUID().slice(0, 8)}`;
}