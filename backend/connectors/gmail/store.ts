// ─────────────────────────────────────────────────────────────────────────
// Gmail connection STORE — the only place that reads/writes the gmail_connection row and
// touches the refresh token. Encryption happens HERE on the way in, decryption on the way out,
// so no other module ever holds a plaintext refresh token longer than one call.
//   • saveConnection      — upsert (encrypts the refresh token first)
//   • getConnectionStatus — safe metadata for the UI (NO token)
//   • loadForSend         — { googleEmail, refreshToken } decrypted, for the send path only
//   • deleteConnection    — remove the row, return the token so the caller can revoke it
// ─────────────────────────────────────────────────────────────────────────
import { prisma } from "../../db.js";
import { encryptToken, decryptToken } from "../crypto.js";

export async function saveConnection(p: {
  userId: string;
  googleEmail: string;
  refreshToken: string;
  scopes: string;
}): Promise<void> {
  const enc = encryptToken(p.refreshToken);
  const data = {
    googleEmail: p.googleEmail,
    refreshTokenEnc: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    scopes: p.scopes,
  };
  await prisma.gmailConnection.upsert({
    where: { userId: p.userId },
    create: { userId: p.userId, ...data },
    update: data,
  });
}

/** UI-safe view of the connection — never includes the token. null = not connected. */
export async function getConnectionStatus(
  userId: string,
): Promise<{ googleEmail: string; scopes: string; connectedAt: Date } | null> {
  const c = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: { googleEmail: true, scopes: true, createdAt: true },
  });
  return c ? { googleEmail: c.googleEmail, scopes: c.scopes, connectedAt: c.createdAt } : null;
}

/** Decrypted credentials for the send path. null = not connected. */
export async function loadForSend(
  userId: string,
): Promise<{ googleEmail: string; refreshToken: string } | null> {
  const c = await prisma.gmailConnection.findUnique({ where: { userId } });
  if (!c) return null;
  return {
    googleEmail: c.googleEmail,
    refreshToken: decryptToken({ ciphertext: c.refreshTokenEnc, iv: c.iv, authTag: c.authTag }),
  };
}

/** Delete the row and return the (decrypted) refresh token so the route can revoke it at Google. */
export async function deleteConnection(userId: string): Promise<string | null> {
  const conn = await loadForSend(userId);
  await prisma.gmailConnection.deleteMany({ where: { userId } });
  return conn?.refreshToken ?? null;
}
