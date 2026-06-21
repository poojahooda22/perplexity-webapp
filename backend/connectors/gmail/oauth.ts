// ─────────────────────────────────────────────────────────────────────────
// Gmail OAUTH — the authorization-code-with-PKCE flow against Google, as pure functions
// (no Express here; routes.ts wires these to HTTP). Four jobs:
//   • buildAuthUrl   — the consent URL we redirect the user to (offline + PKCE + sealed state)
//   • exchangeCode   — swap the ?code Google sends back for { refresh_token, access_token, … }
//   • refreshAccess  — mint a fresh ~1h access token from the stored refresh token
//   • revokeToken    — invalidate a token on disconnect
//
// Why PKCE even though we're a confidential client (we have a client secret)? Defense in depth,
// and the verifier never leaves our server — it rides ENCRYPTED inside `state` (see crypto.seal),
// so the whole flow stays STATELESS (no Redis/session needed between /start and /callback).
//
// Scopes: `openid email` (so the id_token carries the connected address — no extra API call) +
// `gmail.send` (send-only; SENSITIVE but needs NO CASA audit — the deliberate MVP boundary).
// ─────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import { seal, unseal } from "../crypto.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send", // send-only (sensitive)
  "https://www.googleapis.com/auth/gmail.readonly", // read inbox/messages (restricted)
];
const STATE_TTL_MS = 10 * 60 * 1000; // a consent screen left open longer than this must restart

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_CLIENT_ID is not set");
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return v;
}
function redirectUri(): string {
  const v = process.env.GMAIL_OAUTH_REDIRECT_URI;
  if (!v) throw new Error("GMAIL_OAUTH_REDIRECT_URI is not set");
  return v;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** What we encrypt into `state`: who started the flow + the PKCE verifier + a freshness deadline. */
interface StatePayload {
  userId: string;
  codeVerifier: string;
  nonce: string;
  exp: number; // ms epoch
}

export interface GoogleTokens {
  refresh_token?: string; // only present on the FIRST consent (access_type=offline + prompt=consent)
  access_token: string;
  expires_in: number; // seconds
  scope: string;
  id_token?: string;
}

/**
 * Build the Google consent URL to redirect the user to. Generates a fresh PKCE pair and seals
 * { userId, verifier, nonce, exp } into `state` so /callback can recover them without server state.
 */
export function buildAuthUrl(userId: string): string {
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = seal({
    userId,
    codeVerifier,
    nonce: b64url(crypto.randomBytes(12)),
    exp: Date.now() + STATE_TTL_MS,
  } satisfies StatePayload);

  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline", // ← required to receive a refresh_token
    prompt: "consent", // ← force the consent screen so a refresh_token is (re)issued every time
    include_granted_scopes: "true",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Open + validate the sealed state from /callback. Throws on tamper (GCM) or expiry. */
export function openState(state: string): StatePayload {
  const p = unseal<StatePayload>(state); // throws if forged/tampered
  if (!p?.userId || !p?.codeVerifier || typeof p.exp !== "number") {
    throw new Error("invalid state payload");
  }
  if (Date.now() > p.exp) throw new Error("state expired — restart the connect flow");
  return p;
}

/** Exchange the authorization `code` (with the PKCE verifier) for tokens. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      client_secret: clientSecret(),
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as GoogleTokens;
}

/** Mint a fresh access token from the stored refresh token (Google omits refresh_token here). */
export async function refreshAccess(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

/** Revoke a refresh/access token at Google on disconnect. Best-effort: caller may ignore failure. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
}

/**
 * Pull the connected account's email out of an id_token (a JWT). We DON'T verify the signature —
 * the token came directly from Google's token endpoint over TLS in exchangeCode, so it's trusted;
 * we only base64url-decode the payload. Returns null if absent/unparseable.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}
