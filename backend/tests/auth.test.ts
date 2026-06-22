import { beforeEach, describe, expect, test } from "bun:test";

import { middleware } from "../auth";
import { prismaFake, resetPrisma } from "./helpers/prisma-fake";
import { __setUser, makeUser, resetSupabase } from "./helpers/supabase-fake";
import { makeNext, makeReq, makeRes } from "./helpers/express-mock";

// auth.ts keeps a process-wide tokenCache + provisionedUsers Set (Bun runs one process), so each
// test uses UNIQUE tokens + user ids to avoid cross-test contamination.
describe("auth middleware", () => {
  beforeEach(() => {
    resetPrisma();
    resetSupabase();
  });

  test("401 when there is no Authorization header", async () => {
    const res = makeRes();
    const next = makeNext();
    await middleware(makeReq(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("401 when Supabase resolves no user", async () => {
    __setUser(null);
    const res = makeRes();
    const next = makeNext();
    await middleware(makeReq({ headers: { authorization: "bad-token" } }), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("happy path: provisions the user, sets req.userId, calls next()", async () => {
    __setUser(makeUser({ id: "u-1", email: "a@b.com" }));
    prismaFake.user.upsert.mockResolvedValue({});
    const req = makeReq({ headers: { authorization: "tok-1" } });
    const next = makeNext();
    await middleware(req, makeRes(), next);
    expect(req.userId).toBe("u-1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(prismaFake.user.upsert).toHaveBeenCalledTimes(1);
  });

  test("token cache: a repeat call with the same token skips Supabase + provisioning", async () => {
    __setUser(makeUser({ id: "u-2", email: "c@d.com" }));
    prismaFake.user.upsert.mockResolvedValue({});
    const tok = "tok-2";
    await middleware(makeReq({ headers: { authorization: tok } }), makeRes(), makeNext());

    // Flip the backing user to null — if the cache works, the 2nd call still succeeds from cache.
    __setUser(null);
    const req2 = makeReq({ headers: { authorization: tok } });
    const next2 = makeNext();
    await middleware(req2, makeRes(), next2);
    expect(req2.userId).toBe("u-2");
    expect(next2).toHaveBeenCalledTimes(1);
  });

  test("provisioning failure → 500, does not call next()", async () => {
    __setUser(makeUser({ id: "u-3", email: "e@f.com" }));
    prismaFake.user.upsert.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    const next = makeNext();
    await middleware(makeReq({ headers: { authorization: "tok-3" } }), res, next);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});
