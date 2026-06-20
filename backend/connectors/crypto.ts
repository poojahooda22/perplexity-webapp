// ─────────────────────────────────────────────────────────────────────────
// Connector CRYPTO — AES-256-GCM for two jobs:
//   1. encryptToken / decryptToken — seal the long-lived Gmail REFRESH TOKEN before it
//      goes into Postgres. The 256-bit key lives ONLY in env (GMAIL_TOKEN_ENC_KEY), never
//      in the DB, so a database leak alone yields ciphertext, not a working token.
//   2. seal / unseal — pack an arbitrary small object into ONE opaque, tamper-proof,
//      URL-safe string. Used for the OAuth `state` param so the flow is STATELESS: we don't
//      need Redis or a session to remember the user + PKCE verifier between /start and the
//      Google redirect back to /callback — it all rides (encrypted) in `state`.
//
// GCM gives us confidentiality AND integrity (the authTag): unseal() THROWS if a single
// byte was tampered with, which is exactly the CSRF/forgery guarantee we want on `state`.
//
// The key is loaded LAZILY (first use), not at import — so importing this module can never
// crash the serverless boot if the env var is missing (same pattern as auth.ts's Supabase client).
// ─────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

let _key: Buffer | null = null;
function key(): Buffer {
  if (_key) return _key;
  const raw = process.env.GMAIL_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "GMAIL_TOKEN_ENC_KEY is not set. Generate one with 32 random bytes, base64-encoded.",
    );
  }
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    throw new Error(
      `GMAIL_TOKEN_ENC_KEY must decode to 32 bytes (AES-256); got ${k.length}. ` +
        "Generate a fresh 32-byte base64 key.",
    );
  }
  _key = k;
  return k;
}

/** The three parts of an AES-GCM ciphertext, all base64 — the exact columns on GmailConnection. */
export interface Sealed {
  ciphertext: string;
  iv: string; // 12-byte GCM nonce, UNIQUE per encryption
  authTag: string; // GCM integrity tag
}

/** Encrypt a secret string for storage. A fresh random IV every call (never reuse a GCM nonce). */
export function encryptToken(plaintext: string): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt what encryptToken produced. Throws if the authTag doesn't verify (tamper/wrong key). */
export function decryptToken(s: Sealed): string {
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(s.iv, "base64"));
  decipher.setAuthTag(Buffer.from(s.authTag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(s.ciphertext, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

// base64 ⇄ base64url (URL-safe: no +, /, or = so it's clean in a query string).
const toUrl = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (u: string) => u.replace(/-/g, "+").replace(/_/g, "/");

/**
 * Encrypt + encode an object into one opaque URL-safe token (for the OAuth `state`).
 * Format: base64url(iv).base64url(authTag).base64url(ciphertext)
 */
export function seal(payload: unknown): string {
  const { ciphertext, iv, authTag } = encryptToken(JSON.stringify(payload));
  return [iv, authTag, ciphertext].map(toUrl).join(".");
}

/**
 * Reverse of seal(). THROWS if the token is malformed or fails the GCM integrity check —
 * callers should treat a throw as "invalid/forged state" and reject the request.
 */
export function unseal<T>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed sealed token");
  const [iv, authTag, ciphertext] = parts.map(fromUrl) as [string, string, string];
  return JSON.parse(decryptToken({ iv, authTag, ciphertext })) as T;
}
