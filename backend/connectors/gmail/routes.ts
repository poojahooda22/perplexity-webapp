// ─────────────────────────────────────────────────────────────────────────
// Gmail connector ROUTES — the HTTP surface, mounted at /connectors/gmail in index.ts.
//
//   GET    /start     (auth)  → 302 to Google's consent screen
//   GET    /callback  (PUBLIC)→ Google redirects the BROWSER here; identity comes from the
//                               sealed `state`, NOT an auth header — so it must NOT use middleware
//   GET    /status    (auth)  → { connected, googleEmail?, scopes?, connectedAt? }
//   POST   /send      (auth)  → { to, subject, body, cc?, bcc? } → { id, threadId }
//   DELETE /          (auth)  → disconnect (delete row + revoke at Google)
//
// Per-ROUTE middleware (not router-level) precisely because /callback has to stay public.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { middleware, type AuthenticatedRequest } from "../../auth.js";
import {
  buildAuthUrl,
  openState,
  exchangeCode,
  refreshAccess,
  revokeToken,
  emailFromIdToken,
  GMAIL_SCOPES,
} from "./oauth.js";
import { saveConnection, getConnectionStatus, deleteConnection } from "./store.js";
import { sendGmail, GmailNotConnectedError, GmailAuthError } from "./send.js";

export const gmailRouter = Router();

// Where to bounce the browser back to after the OAuth round-trip (the frontend Connectors page).
function frontendUrl(): string {
  return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

// ── GET /start ──────────────────────────────────────────────────────────
// Begin the connect flow. Returns the consent URL as JSON (NOT a 302): this endpoint is behind
// auth, so the SPA calls it with fetch() + Authorization header, then navigates the browser to
// the returned URL itself. A server redirect would drop the auth header on the browser hop.
gmailRouter.get("/start", middleware, (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: "unauthorised" });
  try {
    res.json({ url: buildAuthUrl(req.userId) });
  } catch (e) {
    console.error("[gmail/start] failed:", e);
    res.status(500).json({ error: "Could not start Gmail connect flow." });
  }
});

// ── GET /callback (PUBLIC) ───────────────────────────────────────────────
// Google redirects the browser here with ?code & ?state (or ?error). We verify state,
// exchange the code, store the encrypted refresh token, then redirect back to the app.
gmailRouter.get("/callback", async (req, res) => {
  const back = (status: string) => res.redirect(`${frontendUrl()}/connectors?gmail=${status}`);

  if (typeof req.query.error === "string") return back("denied"); // user clicked "Cancel"
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) return back("error");

  try {
    const { userId, codeVerifier } = openState(state); // throws on tamper/expiry
    const tokens = await exchangeCode(code, codeVerifier);

    // prompt=consent + access_type=offline means Google returns a refresh_token here. If it's
    // somehow absent, we can't persist a reusable connection — ask the user to retry.
    if (!tokens.refresh_token) {
      console.error("[gmail/callback] no refresh_token returned");
      return back("error");
    }
    const googleEmail = emailFromIdToken(tokens.id_token) ?? "unknown";
    await saveConnection({
      userId,
      googleEmail,
      refreshToken: tokens.refresh_token,
      scopes: tokens.scope ?? GMAIL_SCOPES.join(" "),
    });
    return back("connected");
  } catch (e) {
    console.error("[gmail/callback] failed:", e);
    return back("error");
  }
});

// ── GET /status ──────────────────────────────────────────────────────────
gmailRouter.get("/status", middleware, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: "unauthorised" });
  const status = await getConnectionStatus(req.userId);
  if (!status) return res.json({ connected: false });
  res.json({ connected: true, ...status });
});

// ── POST /send ─────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
gmailRouter.post("/send", middleware, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: "unauthorised" });

  const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  const subject = typeof req.body?.subject === "string" ? req.body.subject : "";
  const body = typeof req.body?.body === "string" ? req.body.body : "";
  const cc = typeof req.body?.cc === "string" ? req.body.cc.trim() : undefined;
  const bcc = typeof req.body?.bcc === "string" ? req.body.bcc.trim() : undefined;

  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: "A valid 'to' address is required." });
  if (!subject.trim() && !body.trim()) {
    return res.status(400).json({ error: "Provide a subject and/or body." });
  }
  if (body.length > 200_000) return res.status(413).json({ error: "Email body is too large." });

  try {
    const result = await sendGmail({ userId: req.userId, to, subject, body, cc, bcc });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof GmailNotConnectedError) {
      return res.status(409).json({ error: "Gmail is not connected.", code: "not_connected" });
    }
    if (e instanceof GmailAuthError) {
      return res.status(401).json({ error: "Gmail authorization expired — reconnect.", code: "reconnect" });
    }
    console.error("[gmail/send] failed:", e);
    res.status(502).json({ error: "Sending failed. Please try again." });
  }
});

// ── DELETE / ─────────────────────────────────────────────────────────────
gmailRouter.delete("/", middleware, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: "unauthorised" });
  const token = await deleteConnection(req.userId);
  if (token) await revokeToken(token).catch((e) => console.warn("[gmail/disconnect] revoke failed:", e));
  res.json({ ok: true });
});
