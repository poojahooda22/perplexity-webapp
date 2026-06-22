import { describe, expect, test } from "bun:test";

import { decryptToken, encryptToken, seal, unseal } from "../../connectors/crypto";

// GMAIL_TOKEN_ENC_KEY is set to a valid 32-byte base64 key in tests/setup/test-preload.ts.

describe("seal / unseal (stateless OAuth `state` crypto)", () => {
  test("round-trips an arbitrary object", () => {
    const payload = { userId: "u1", codeVerifier: "verifier", nonce: "n", exp: 123 };
    expect(unseal<typeof payload>(seal(payload))).toEqual(payload);
  });

  test("produces a URL-safe, 3-part token (no +, /, =)", () => {
    const t = seal({ a: 1 });
    expect(t).not.toMatch(/[+/=]/);
    expect(t.split(".")).toHaveLength(3);
  });

  test("throws on a tampered token (GCM integrity = CSRF/forgery guard)", () => {
    const t = seal({ a: 1 });
    const tampered = t.slice(0, -2) + (t.endsWith("A") ? "BC" : "AA");
    expect(() => unseal(tampered)).toThrow();
  });

  test("throws on a malformed token", () => {
    expect(() => unseal("not-three-parts")).toThrow("malformed sealed token");
  });
});

describe("encryptToken / decryptToken (refresh-token vault)", () => {
  test("round-trips a secret and uses a fresh IV each call", () => {
    const a = encryptToken("refresh-token");
    const b = encryptToken("refresh-token");
    expect(a.iv).not.toBe(b.iv); // GCM nonce must never repeat
    expect(decryptToken(a)).toBe("refresh-token");
  });
});