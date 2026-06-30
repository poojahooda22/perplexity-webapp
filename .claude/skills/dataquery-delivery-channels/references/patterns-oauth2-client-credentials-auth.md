# patterns · OAuth2 `client_credentials` machine-to-machine auth for a data API channel

> **Product line.** This reference belongs to the **`dataquery-delivery-channels` dev-skill** of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina.** That line is a *separate*
> product (the DataQuery / Fusion re-engineering, "Project 3"), built on a **new Python / FastAPI /
> data-engineering stack** — *not* Lumina's Bun + Express + Prisma + Supabase + Upstash stack. Nothing
> here is wired into Lumina's runtime; the two only share a filesystem home for the research
> ([`cto-rules.md`](../../../rules/cto-rules.md) §"Scope note"). Greenfield: there are no codebase
> `file:line` anchors yet — everything below is a build recipe grounded in primary specs, vendor docs,
> and real library source read this session.
>
> **What this doc is.** The **channel-auth recipe** — the *auth half* of every delivery channel the
> DataQuery re-engineering exposes (the REST `/timeseries` endpoint, the bulk-file download endpoint, the
> SSE/stream endpoint, and the agent-tool gateway). It covers **both sides of the wire**:
> - **SERVER side** (we are the data API): issue and verify bearer JWTs, scope keys per least-privilege,
>   validate the `aud`/resource claim, and the API-key alternative — stored hashed, never plaintext.
> - **CONSUMER side** (we call an upstream like JPM DataQuery, *or* our own agent calls our own API):
>   mint a token via `client_credentials`, cache it in memory, refresh it **before** expiry with an
>   aggressive buffer, de-duplicate concurrent refreshes, and retry exactly one `401` with a fresh token.
>
> **The one rule this whole doc enforces.** **No human, no refresh token, no long-lived secret on the
> wire.** `client_credentials` is the *only* correct OAuth grant for a service that authenticates *itself*
> — there is no user to redirect, no consent screen, no refresh-token state machine. You mint a
> short-lived bearer, cache it, and re-mint when it ages out. Every other complexity in this file is in
> service of *that* loop being fast, safe, and never the bottleneck.

---

## 0. The thirty-second answer (read this first)

A data API has no users at the channel boundary — it has **services** calling it (a quant's batch job,
our own agent's tool layer, a partner's ETL). Services authenticate with the **OAuth 2.0 client
credentials grant** (RFC 6749 §4.4): the client POSTs its own `client_id` + `client_secret` to a
`/token` endpoint and gets back a short-lived **bearer access token** (a signed JWT), typically valid
15 min – 1 hr. It then sends `Authorization: Bearer <jwt>` on every API call. ([RFC 6749 §4.4 — the
grant where "the client is also the resource owner"](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4);
[Microsoft Entra — "two-legged OAuth … server-to-server interactions that run in the background, without
immediate interaction with a user"](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).)

There is **no refresh token** in this grant — and that is correct, not a gap. ([RFC 6749 §4.4.3 — "A
refresh token SHOULD NOT be included."](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4.3))
A user flow uses a refresh token to avoid re-prompting a human; a service has no human, so it just
**re-presents its credentials** to `/token` when the token expires. ([Microsoft Entra — "refresh tokens
will never be granted with this flow as `client_id` and `client_secret` … can be used to obtain an
access token instead."](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow))

So the whole pattern is two short loops:

**CONSUMER loop** — get-or-mint, cached:
1. Token in memory and **not within the expiry buffer**? Use it.
2. Else mint a new one from `/token` (under a per-client lock so 50 concurrent callers cause **one**
   mint, not 50), cache it with its `expires_in`, use it.
3. A `401` despite a "valid" cached token (clock skew / mid-flight rotation)? **Drop the cache, mint
   once, retry the request once.** Never loop.

**SERVER loop** — verify, locally:
1. Read the `Bearer` JWT off the request.
2. Verify its signature against a **cached JWKS** (fetched once, refreshed on `kid` miss) — *local*, no
   network call per request.
3. Check `exp`, `iss`, and **`aud`** (the resource/audience claim — JPM's is
   `JPMC:URI:RS-06785-DataQueryExternalApi-PROD`), then check the token's **`scope`** against what this
   endpoint requires (least privilege).
4. Reject with `401`/`403` on any failure. **Never** verify against the live authorization server on the
   hot path (that's introspection — reserved for opaque tokens / immediate-revocation needs).

API keys are the *simpler* alternative for trusted internal callers — **store them hashed (SHA-256, not
bcrypt), with a public prefix for lookup, compared in constant time** — and OAuth is the right default
for scoped, rotating, cross-boundary access. The repo non-negotiable that governs both: **a secret
(`client_secret`, API key, `userId`) is injected by closure into the call site — never supplied by the
model, never in a query string, never read fresh from a tool argument**
([`skill-layer-law.md`](../../../rules/skill-layer-law.md); `CLAUDE.md` non-negotiable #6).

If that's all you needed, stop here. The rest is the exact wire formats, the runnable Python for both
sides, the caching/refresh/de-dup mechanics with the JPM SDK's `0.9` buffer, the JWKS-vs-introspection
decision, the API-key store schema, the cert-auth alternative, and the mapping to the repo's Supabase
JWT-validation pattern.

---

## Table of contents

1. [Why `client_credentials` and not authorization-code](#1-why-client-credentials)
2. [The wire: the `/token` request and response, verbatim](#2-the-wire)
3. [The CONSUMER side — mint, cache, refresh-before-expiry, de-dup, retry-one-401](#3-consumer-side)
4. [The JPM DataQuery SDK, read at the source — the `0.9` buffer + the `aud` resource](#4-jpm-sdk)
5. [The SERVER side — issue a JWT, then verify it locally against cached JWKS](#5-server-side)
6. [Scopes per key — least privilege, and the `aud`/resource claim](#6-scopes-and-aud)
7. [Local JWKS verification vs token introspection — the decision](#7-jwks-vs-introspection)
8. [API keys vs OAuth — when each, and the hashed-key store](#8-api-keys)
9. [Secret handling — the repo's inject-by-closure non-negotiable](#9-secret-handling)
10. [The certificate-auth alternative (DataQuery's `CERT_BASE_URL`)](#10-cert-auth)
11. [Mapping to the repo's Supabase JWT validation + the gateway](#11-repo-mapping)
12. [Worked end-to-end: mint → call → verify, both sides runnable](#12-worked-end-to-end)
13. [Anti-patterns specific to channel auth](#13-anti-patterns)
14. [Output contract — the grading rubric for a channel-auth PR](#14-output-contract)
15. [Pinned versions + sources](#15-sources)

---

## 1. Why `client_credentials` and not authorization-code <a id="1-why-client-credentials"></a>

OAuth 2.0 defines four core grant types (RFC 6749). Three of them — authorization-code, implicit,
resource-owner-password — exist to get a token **on behalf of a human user** who is present and can be
redirected to a login page. The fourth, **client credentials**, is the one where **the client *is* the
resource owner**: it is accessing *its own* resources, so there is no third party whose permission must
be obtained. ([oauth.net — "the Client Credentials grant type is used by clients to obtain an access
token outside of the context of a user … typically used by clients to access resources about themselves
rather than to access a user's resources."](https://oauth.net/2/grant-types/client-credentials/))

A data API at the channel boundary has **no user**. The caller is a batch job, an ETL pipeline, our own
agent's tool layer, a partner's backend. There is nobody to show a consent screen to, nobody to redirect.
This is the textbook definition of the grant Microsoft calls *two-legged OAuth* and labels for "daemons
or service accounts" that "run in the background, without immediate interaction with a user."
([Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).)

### 1.1 The "no refresh token" property is a feature, not a missing piece

The single most common junior mistake here is to look for a refresh token and try to build a refresh
flow. **There is none, by spec.** RFC 6749 is explicit at two points:

- §1.5 — the four core grant types "do not include a refresh token" for client credentials in the sense
  that re-presenting credentials is the renewal mechanism.
- §4.4.3 (the client-credentials *response* section) — **"A refresh token SHOULD NOT be included."**
  ([RFC 6749 §4.4.3](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4.3).)

The reasoning is mechanical: a refresh token exists so a user does not have to re-enter a password. A
service holds its `client_secret` permanently and can re-authenticate *itself* any time it likes —
calling `/token` again *is* the refresh. ([Auth0 community — "M2M clients can authenticate directly using
their credentials, there's no need to 'refresh' tokens like in user flows. Instead, they request a new
access token on demand."](https://community.auth0.com/t/get-refresh-token-when-requesting-client-credentials/111184);
codestudy.net — "in practice, most authorization servers (Auth0, Okta, Azure AD) do not return refresh
tokens when using Client Credential Flow.")

> **The mental model.** A user-flow token is a hotel key card you top up at the front desk (refresh
> token) so you don't re-show your passport. A service token is a turnstile token from a machine that
> takes coins (your `client_secret`) — when it expires you just feed another coin. There is no "top up."

### 1.2 Token lifetime: short, by design

Client-credential access tokens are deliberately short-lived. The point of a short TTL is to **bound the
blast radius of a leak** — a stolen token is useless in minutes. ([authgear M2M guide — "Short as
possible while still enabling operations — 5–60 minutes is common."](https://www.authgear.com/post/the-complete-guide-to-machine-to-machine-m2m-authentication/);
scalekit — "the short-lived token bounds the damage from a leak.")

| Issuer | Default access-token TTL | Source |
|---|---|---|
| Auth0 (client credentials) | 86400 s (24 h) default, **5–15 min recommended for M2M** | [Auth0 community](https://community.auth0.com/t/how-do-i-change-m2m-access-token-lifetime/184148) |
| Microsoft Entra | `expires_in: 3599` (≈1 h) in the documented response | [Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow) |
| authgear guidance | 5–60 min | [authgear](https://www.authgear.com/post/the-complete-guide-to-machine-to-machine-m2m-authentication/) |

**Design rule for our channel:** issue **15-minute** access tokens for our own API. Short enough that a
leaked token expires fast; long enough that the consumer's cache turns over only ~4×/hour, so the `/token`
endpoint never becomes a hot path. A 15-min token with the consumer's 0.9 buffer (§4) re-mints at ~13.5
min — about 107 mints/day per client. That is nothing.

> **R-SCALE note.** The `/token` endpoint is itself a scale surface. At 10,000× (lakhs of consumers) a
> naive "mint on every call" would hammer it. The consumer-side cache (§3) is what keeps it cold:
> *compute-once-serve-many for tokens* — mint once per 13.5 min, serve from memory in between. This is
> the same compute-once-serve-many discipline the repo applies to finance cards
> ([`product-at-scale.md`](../../../rules/product-at-scale.md)). A channel-auth PR that mints per request
> is a Tier-1 implementation masquerading as Tier-3.

---

## 2. The wire: the `/token` request and response, verbatim <a id="2-the-wire"></a>

Every `client_credentials` exchange is the same two messages. Here they are from three independent
primary sources so you can see the invariants vs the per-issuer variation.

### 2.1 The request (`POST /token`, `application/x-www-form-urlencoded`)

**Auth0** ([call-your-api docs](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-credentials-flow/call-your-api-using-the-client-credentials-flow)):

```bash
curl --request POST \
  --url 'https://{yourDomain}/oauth/token' \
  --header 'content-type: application/x-www-form-urlencoded' \
  --data grant_type=client_credentials \
  --data client_id={yourClientId} \
  --data client_secret={yourClientSecret} \
  --data audience=YOUR_API_IDENTIFIER
```

**Microsoft Entra** ([v2 docs](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow))
— note `scope` (with the `/.default` suffix) replaces `audience`:

```http
POST /{tenant}/oauth2/v2.0/token HTTP/1.1
Host: login.microsoftonline.com:443
Content-Type: application/x-www-form-urlencoded

client_id=00001111-aaaa-2222-bbbb-3333cccc4444
&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default
&client_secret=A1bC2dE3fH4iJ5kL6mN7oP8qR9sT0u
&grant_type=client_credentials
```

The **invariant** across all issuers (RFC 6749 §4.4.2): `grant_type=client_credentials` is mandatory;
the client authenticates with `client_id`+`client_secret`; an optional `scope` narrows the grant. The
**variation**: how you name the target API — Auth0 uses `audience`, Entra uses a resource-suffixed
`scope`, JPM DataQuery uses an `aud` form field carrying a resource URI (§4).

**Client authentication placement (RFC 6749 §2.3.1).** Credentials may go in the **HTTP Basic header**
(`Authorization: Basic base64(client_id:client_secret)`) — the *preferred* method — or in the request
**body** as form fields, which the spec calls "NOT RECOMMENDED and SHOULD be limited to clients unable to
… utilize HTTP Basic." ([RFC 6749 §2.3.1](https://datatracker.ietf.org/doc/html/rfc6749#section-2.3.1).)
In practice most M2M code uses the body form (it's simpler and every server accepts it); prefer Basic
where the upstream supports it. **Either way the secret is URL-encoded and goes over TLS only — never in
a query string** (query strings land in access logs and `Referer` headers).

### 2.2 The response (HTTP 200, `application/json`)

Auth0 / RFC shape:

```json
{
  "access_token": "eyJz93a...k4laUWw",
  "token_type": "Bearer",
  "expires_in": 86400
}
```

Microsoft Entra shape (≈1 h token, note **no `refresh_token`**):

```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6Ik1uQ19WWmNBVGZNNXBP..."
}
```

The three fields you act on:

| Field | Meaning | What you do with it |
|---|---|---|
| `access_token` | the bearer JWT | put on `Authorization: Bearer …`; cache it |
| `token_type` | always `Bearer` here | assert it equals `Bearer` (case-insensitive); error otherwise |
| `expires_in` | **seconds** of validity from *now* | compute `expires_at = now + expires_in`; refresh **before** that with a buffer (§3) |

Note: **no `refresh_token`** in either response — exactly as §1.1 said. If your issuer *does* return one
for client credentials (some misconfigured servers do), ignore it; you don't need it.

---

## 3. The CONSUMER side — mint, cache, refresh-before-expiry, de-dup, retry-one-401 <a id="3-consumer-side"></a>

This is the half you write when **we are the caller** — our Python data plane fetching from an upstream
(JPM DataQuery, a partner API), *or* our own agent's tool layer calling our own channel. Five
requirements, in order of how often they bite:

1. **Cache the token in memory** keyed by `(token_url, client_id, scope/aud)`. Never mint per request.
2. **Refresh *before* expiry, with a buffer** — never wait for a `401`. The JPM SDK uses a **0.9
   multiplier on `expires_in`** (§4); we adopt it.
3. **De-duplicate concurrent refreshes** — 50 coroutines hitting an expired cache must trigger **one**
   `/token` call, not 50 (the single-flight / request-coalescing pattern).
4. **Retry exactly one `401`** with a freshly minted token — covers clock skew and mid-flight key
   rotation — then give up. Never loop on `401`.
5. **Be process-safe** — the cache is per-process; that's fine, but the lock must be too.

### 3.1 The synchronous reference implementation (httpx + threading.Lock)

```python
# auth/client_credentials.py — consumer-side token manager (sync, for batch/worker use)
from __future__ import annotations
import time
import threading
import httpx


class TokenError(RuntimeError):
    """Raised when a /token mint fails after the allowed attempts."""


class ClientCredentialsToken:
    """
    Mints, caches, and refreshes an OAuth2 client_credentials bearer token.

    - Refreshes BEFORE expiry using `buffer` (0.9 => refresh at 90% of lifetime).
    - De-duplicates concurrent refreshes with a single lock (single-flight).
    - Exposes `header()` for callers and `invalidate()` for the retry-one-401 path.
    """

    def __init__(
        self,
        *,
        token_url: str,
        client_id: str,
        client_secret: str,           # injected by closure at the call site (see §9)
        audience: str | None = None,  # JPM: the JPMC:URI:RS-...-PROD resource id
        scope: str | None = None,     # Entra-style; mutually-exclusive-ish with audience
        http: httpx.Client,
        buffer: float = 0.9,          # the JPM SDK's TOKEN_EXPIRY_BUFFER (§4)
    ) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._audience = audience
        self._scope = scope
        self._http = http
        self._buffer = buffer

        self._access_token: str | None = None
        self._refresh_at: float = 0.0          # monotonic deadline to re-mint at
        self._lock = threading.Lock()          # single-flight guard

    # ---- public API -----------------------------------------------------

    def header(self) -> dict[str, str]:
        """Return {'Authorization': 'Bearer ...'}, minting/refreshing if needed."""
        return {"Authorization": f"Bearer {self._get()}"}

    def invalidate(self) -> None:
        """Force the next call to re-mint. Used by the retry-one-401 path."""
        with self._lock:
            self._access_token = None
            self._refresh_at = 0.0

    # ---- internals ------------------------------------------------------

    def _get(self) -> str:
        # Fast path: a fresh-enough token, no lock contention on the common case.
        token = self._access_token
        if token is not None and time.monotonic() < self._refresh_at:
            return token

        # Slow path: need a (re)mint. Take the lock so only ONE coroutine/thread
        # actually hits /token; the rest block, then re-read the now-fresh cache.
        with self._lock:
            # Re-check under the lock — another thread may have minted while we waited.
            if self._access_token is not None and time.monotonic() < self._refresh_at:
                return self._access_token
            self._mint_locked()
            assert self._access_token is not None
            return self._access_token

    def _mint_locked(self) -> None:
        """MUST be called with self._lock held."""
        data = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        if self._audience:
            data["aud"] = self._audience      # JPM DataQuery form-field name (§4)
        if self._scope:
            data["scope"] = self._scope

        try:
            resp = self._http.post(
                self._token_url,
                data=data,                    # form-urlencoded; httpx sets the header
                headers={"Accept": "application/json"},
                timeout=httpx.Timeout(10.0, connect=5.0),
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            # A 401 here means the CREDENTIALS are wrong (not the access token) —
            # do not retry, surface it. (Distinct from a 401 on the data call.)
            raise TokenError(
                f"/token mint failed: {e.response.status_code} {e.response.text[:200]}"
            ) from e
        except httpx.HTTPError as e:
            raise TokenError(f"/token request failed: {e!r}") from e

        body = resp.json()
        if (body.get("token_type") or "").lower() != "bearer":
            raise TokenError(f"unexpected token_type: {body.get('token_type')!r}")

        self._access_token = body["access_token"]
        # Refresh at buffer * lifetime so we never serve a token within its last 10%.
        expires_in = float(body.get("expires_in", 900))      # default 15 min if absent
        self._refresh_at = time.monotonic() + expires_in * self._buffer
```

**Why each line earns its place:**

- **Fast-path read before the lock.** The common case — token is fresh — must not serialize on a mutex.
  We read `self._access_token` and the deadline *outside* the lock; only a miss takes the lock. This is
  the standard double-checked-locking shape and is why a single shared token object scales to thousands
  of concurrent callers. ([oneuptime — request coalescing: "Instead of ten requests hitting your
  database, one request fetches the data and ten clients receive the result."](https://oneuptime.com/blog/post/2026-01-23-request-coalescing-python/view))
- **Re-check under the lock.** Between losing the fast-path race and acquiring the lock, another thread
  may have already minted. Re-checking avoids a redundant `/token` call — the actual de-dup.
- **`buffer = 0.9`.** Refresh at 90% of lifetime. A 15-min token re-mints at 13.5 min, so a token is
  *never* handed to a caller in its last 90 s — that margin absorbs clock skew between us and the
  authorization server and the in-flight time of the request that *uses* the token. (This exact constant
  is the JPM SDK's `TOKEN_EXPIRY_BUFFER = 0.9`; §4.)
- **`401` on `/token` ≠ `401` on the data call.** A `401` from `/token` means *bad credentials* — never
  retried, surfaced as `TokenError`. A `401` from the *data* endpoint means *bad/expired access token* —
  retried once (§3.3). Conflating the two is a real bug; keep them in different code paths.

### 3.2 The async variant (FastAPI / async data plane — `asyncio.Lock`)

The async data plane (the `python-fastapi-data-service` skill's shared `httpx.AsyncClient`) needs the
same logic with `asyncio.Lock`. The single-flight is identical; only the primitive changes.

```python
# auth/client_credentials_async.py
import asyncio
import time
import httpx


class AsyncClientCredentialsToken:
    def __init__(self, *, token_url, client_id, client_secret,
                 audience=None, scope=None, http: httpx.AsyncClient, buffer: float = 0.9):
        self._token_url, self._client_id, self._client_secret = token_url, client_id, client_secret
        self._audience, self._scope, self._http, self._buffer = audience, scope, http, buffer
        self._access_token: str | None = None
        self._refresh_at: float = 0.0
        self._lock = asyncio.Lock()

    async def header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {await self._get()}"}

    async def invalidate(self) -> None:
        async with self._lock:
            self._access_token, self._refresh_at = None, 0.0

    async def _get(self) -> str:
        token = self._access_token
        if token is not None and time.monotonic() < self._refresh_at:
            return token
        async with self._lock:
            if self._access_token is not None and time.monotonic() < self._refresh_at:
                return self._access_token        # someone minted while we waited
            await self._mint_locked()
            return self._access_token            # type: ignore[return-value]

    async def _mint_locked(self) -> None:
        data = {"grant_type": "client_credentials",
                "client_id": self._client_id, "client_secret": self._client_secret}
        if self._audience: data["aud"] = self._audience
        if self._scope:    data["scope"] = self._scope
        resp = await self._http.post(self._token_url, data=data,
                                     headers={"Accept": "application/json"},
                                     timeout=httpx.Timeout(10.0, connect=5.0))
        resp.raise_for_status()
        body = resp.json()
        self._access_token = body["access_token"]
        self._refresh_at = time.monotonic() + float(body.get("expires_in", 900)) * self._buffer
```

> **The async pitfall.** A single `asyncio.Lock` serializes refreshes within **one event loop / one
> process**. It does **not** coordinate across multiple Uvicorn workers or Fly machines — each process
> mints its own token. That is *fine and expected*: per-process token caches are independent and cheap;
> you are not contending on a shared resource, just minting N tokens for N processes. Do **not** reach
> for Redis/a distributed lock here — you'd be adding a network round-trip to save a mint that costs
> nothing. (Reserve distributed locks for *contested writes*, per
> [`product-at-scale.md`](../../../rules/product-at-scale.md) — token mints are not contested.)

### 3.3 Retry exactly one `401` with a fresh token (the wrapper)

A token can be valid in your cache yet rejected by the server — clock skew, or the authorization server
rotated its signing key mid-flight. The correct response is: **drop the cached token, mint a fresh one,
retry the request once.** Then stop — a second `401` is a real authz failure, not a stale token.

```python
# auth/with_bearer.py — the data-call wrapper that owns the retry-one-401 rule
import httpx
from .client_credentials import ClientCredentialsToken, TokenError


def call_with_bearer(
    http: httpx.Client,
    token: ClientCredentialsToken,
    method: str,
    url: str,
    **kwargs,
) -> httpx.Response:
    headers = {**kwargs.pop("headers", {}), **token.header()}
    resp = http.request(method, url, headers=headers, **kwargs)

    if resp.status_code == 401:
        # Stale/rotated token: invalidate, mint fresh, retry EXACTLY once.
        token.invalidate()
        headers = {**kwargs.get("headers", {}), **token.header()}
        resp = http.request(method, url, headers=headers, **kwargs)
        # If it's STILL 401, this is a genuine authz failure — let the caller see it.

    return resp
```

**Why "exactly once" and not a retry loop:** an unbounded retry on `401` turns a permissions
misconfiguration into a tight loop hammering both `/token` and the data endpoint — a self-inflicted DoS
and a great way to get your client rate-limited or blocked. One retry covers the only *recoverable*
cause (a stale token); anything beyond that is unrecoverable and must surface. (The same "retry the
transient class, fail-fast the permanent class" discipline the data-plane skills apply to upstream
fetches.)

---

## 4. The JPM DataQuery SDK, read at the source — the `0.9` buffer + the `aud` resource <a id="4-jpm-sdk"></a>

This is the incumbent we are re-engineering, so its auth code is the reference design. Two community
clients implement the JPM DataQuery OAuth flow; reading both shows the canonical pattern and one real
divergence.

### 4.1 macrosynergy — the constants and the buffer

From [`macrosynergy/download/dataquery.py`](https://github.com/macrosynergy/macrosynergy/blob/develop/macrosynergy/download/dataquery.py)
(read this session), the DataQuery OAuth client is configured with:

```python
OAUTH_TOKEN_URL:     str   = "https://authe.jpmchase.com/as/token.oauth2"
OAUTH_BASE_URL:      str   = "https://api-developer.jpmorgan.com/research/dataquery-authe/api/v2"
OAUTH_DQ_RESOURCE_ID: str  = "JPMC:URI:RS-06785-DataQueryExternalApi-PROD"
TOKEN_EXPIRY_BUFFER: float = 0.9   # refresh at 90% of the token's lifetime
```

and the `DataQueryOAuth` class forwards these to a parent `JPMorganOAuth`:

```python
class DataQueryOAuth(JPMorganOAuth):
    def __init__(self, client_id, client_secret, proxy=None,
                 token_url=OAUTH_TOKEN_URL, dq_base_url=OAUTH_BASE_URL,
                 dq_resource_id=OAUTH_DQ_RESOURCE_ID,
                 application_name="DataQueryHttpAPI", **kwargs):
        super().__init__(client_id=client_id, client_secret=client_secret,
                         auth_url=token_url, root_url=dq_base_url,
                         resource=dq_resource_id, proxies=proxy,
                         application_name=application_name, **kwargs)
```

Three things to take from this:

1. **The token endpoint is a dedicated host** (`authe.jpmchase.com/as/token.oauth2`) separate from the
   data host (`api-developer.jpmorgan.com/.../v2`). Your `token_url` and `base_url` are different;
   don't assume the token comes from the data host.
2. **`resource` (the `aud` claim) is `JPMC:URI:RS-06785-DataQueryExternalApi-PROD`.** This is JPM's
   resource URI — the *audience* the token is minted for. The DataQuery resource server *checks* this on
   every call (this is exactly the `aud` validation RFC 9068 mandates; §6). Our consumer-side
   `audience` param maps to this.
3. **`TOKEN_EXPIRY_BUFFER = 0.9`** — the exact constant our consumer code adopts in §3. JPM's own SDK
   refreshes at 90% of lifetime; we are not inventing the 0.9, we are matching the incumbent.

The token-validity check, from the parent `JPMorganOAuth` (read this session), compares a stored
creation time + lifetime against now:

```python
# JPMorganOAuth._is_valid_token() — the macrosynergy/macrosynergy 'develop' variant
self._stored_token["created_at"] + datetime.timedelta(
    seconds=self._stored_token["expires_in"]
) > datetime.datetime.now(datetime.timezone.utc)
```

and the token request payload is:

```python
{"grant_type": "client_credentials",
 "aud": resource,                 # JPMC:URI:RS-...-PROD
 "client_id": client_id,
 "client_secret": client_secret}
```

A `401` from `/token` raises `AuthenticationError`; the parent catches
`requests.exceptions.HTTPError` status 401 specifically.

> **An honest divergence to record.** The `macrosynergy/macrosynergy` `develop` source above checks
> `created_at + expires_in > now` *without* re-applying the `0.9` buffer in that one expression — the
> `TOKEN_EXPIRY_BUFFER` constant is applied where the refresh deadline is *set*, not in the validity
> comparison. Our §3 implementation folds the buffer into the deadline (`_refresh_at = now +
> expires_in * 0.9`), which is the cleaner single-source-of-truth form and is behaviorally what the
> `0.9` constant exists to achieve. The takeaway is the *constant and its intent* (refresh before the
> last 10% of life), which both clients share; the exact arithmetic placement is an implementation
> detail. `[verified against the develop branch this session — pin the SHA when you vendor it]`

### 4.2 The official SDK — `DATAQUERY_BEARER_TOKEN` and the bearer-token escape hatch

The official [`jpmorganchase/dataquery-sdk`](https://github.com/jpmorganchase/dataquery-sdk) (read this
session) advertises "OAuth 2.0 with token caching and refresh" as a built-in feature and reads
credentials from env vars:

| Env var | Role |
|---|---|
| `DATAQUERY_CLIENT_ID` | OAuth client id |
| `DATAQUERY_CLIENT_SECRET` | OAuth client secret |
| `DATAQUERY_BEARER_TOKEN` | **alternative to OAuth** — a pre-minted bearer, used when `DATAQUERY_OAUTH_ENABLED=false` |
| `DATAQUERY_OAUTH_ENABLED` | `true` by default; set `false` to use the bearer-token path |
| `DATAQUERY_BASE_URL` / `DATAQUERY_FILES_BASE_URL` | data + bulk-file hosts |
| `DATAQUERY_MAX_RETRIES` / `DATAQUERY_TIMEOUT` / `DATAQUERY_RATE_LIMIT_RPM` | retry/timeout/rate-budget |

The CLI exposes `dataquery auth test` — "perform a token exchange and report the failure mode" — which is
a good pattern to copy: a one-shot mint-and-report command so an operator can diagnose a credential
problem without running the whole pipeline.

**The `DATAQUERY_BEARER_TOKEN` escape hatch matters for our design.** It is the "I already have a token,
just use it" mode — useful in CI, or behind a corporate proxy that mints tokens out-of-band. Our channel
should expose the same: a `STATIC_BEARER` config that, when present, *bypasses* the mint loop and uses
the supplied token verbatim. But note: a static bearer **does not auto-refresh** — it's the consumer's
job to rotate it. Document that loudly; a silently-expired static bearer is a confusing 2 a.m. failure.

---

## 5. The SERVER side — issue a JWT, then verify it locally against cached JWKS <a id="5-server-side"></a>

This is the half you write when **we are the data API**. Two jobs: **issue** access tokens at our own
`/token` endpoint, and **verify** them on every protected request — *locally*, against a cached JWKS, so
verification is a CPU operation, not a network call.

### 5.1 Issuing a JWT access token (RS256 / ES256, asymmetric)

Sign access tokens with an **asymmetric** key (RS256 or ES256), never a shared HMAC secret. The reason
is operational: with asymmetric keys, **resource servers verify with the *public* key** (published at a
JWKS endpoint) and never need the private signing key. A single private key lives only in the issuer; a
leak of a verifier (a resource server) leaks nothing. ([Supabase — new projects "created after 1st May
2025 will be created with an RSA asymmetric key by default … verification is done locally usually without
a network request"](https://supabase.com/docs/guides/auth/signing-keys).)

The token's payload must carry the RFC 9068 claims so any resource server can validate it: **`iss`,
`exp`, `aud`, `sub`, `client_id`, `iat`, `jti`, and `scope`**. ([RFC 9068 — "The payload must contain
`iss`, `exp`, `aud`, `sub`, `client_id`, `iat`, and `jti` … the `scope` claim should also be present if
scopes were requested."](https://datatracker.ietf.org/doc/html/rfc9068).)

```python
# server/issue_token.py — our /token endpoint mints these (PyJWT, RS256)
import time
import uuid
import jwt   # PyJWT 2.13.x

ISSUER = "https://data-api.example.com"
TTL_SECONDS = 900   # 15-minute access tokens (our design rule, §1.2)


def issue_access_token(*, private_key: str, kid: str, client_id: str,
                       audience: str, granted_scopes: list[str]) -> tuple[str, int]:
    now = int(time.time())
    payload = {
        "iss": ISSUER,                       # who minted it
        "sub": client_id,                    # the service principal (no user => sub == client)
        "aud": audience,                     # the resource this token is FOR (§6) — RS-...-PROD style
        "client_id": client_id,              # RFC 9068 required
        "iat": now,
        "exp": now + TTL_SECONDS,
        "jti": str(uuid.uuid4()),            # unique id => enables a revocation denylist if ever needed
        "scope": " ".join(granted_scopes),   # space-delimited, per RFC 6749
    }
    token = jwt.encode(
        payload, private_key, algorithm="RS256",
        headers={"kid": kid},                # so verifiers pick the right JWKS key
    )
    return token, TTL_SECONDS
```

([PyJWT — `jwt.encode({"some": "payload"}, private_key, algorithm="RS256")`](https://pyjwt.readthedocs.io/en/latest/usage.html);
the `kid` header is what lets a verifier select the right public key from the JWKS.)

Publish the public half at `GET /.well-known/jwks.json` as a JWK Set. Rotating the signing key means:
generate a new keypair with a new `kid`, **add** its public JWK to the published set (keep the old one
during a grace window so in-flight tokens still verify), start signing with the new `kid`, then drop the
old JWK after the longest token TTL has elapsed. This is the same overlap-during-rotation discipline as
API-key rotation (§8.4).

### 5.2 Verifying a JWT locally against a cached JWKS (the hot path)

On every protected request, verify the bearer **without calling the authorization server**. PyJWT's
`PyJWKClient` fetches the JWKS once, caches it, and refreshes on a `kid` miss:

```python
# server/verify_token.py — local JWKS verification (PyJWT)
import jwt
from jwt import PyJWKClient

# Built once at app startup and reused. PyJWKClient caches the JWK Set in-process
# (default lifespan 300 s) and only re-fetches when the cache is empty/expired or a kid misses.
_jwks_client = PyJWKClient(
    "https://data-api.example.com/.well-known/jwks.json",
    cache_jwk_set=True,        # default True — the in-memory JWKS cache
    lifespan=300,              # seconds; re-fetch JWKS at most every 5 min
)

EXPECTED_ISS = "https://data-api.example.com"


class TokenInvalid(Exception):
    """401 — bad signature / expired / wrong issuer or audience."""


def verify_access_token(token: str, *, required_audience: str) -> dict:
    try:
        # Selects the signing key by the token's `kid`; auto-refreshes JWKS on a kid miss.
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],                 # PIN the algo — never accept the header's choice blindly
            audience=required_audience,           # validates `aud` — see §6 / RFC 9068
            issuer=EXPECTED_ISS,                  # validates `iss`
            options={
                "require": ["exp", "iat", "iss", "aud", "sub"],
                "verify_exp": True,
                "verify_aud": True,
                "verify_iss": True,
            },
        )
    except jwt.ExpiredSignatureError as e:
        raise TokenInvalid("token expired") from e
    except jwt.InvalidAudienceError as e:
        raise TokenInvalid("wrong audience") from e
    except jwt.InvalidTokenError as e:        # base class: bad signature, bad iss, malformed, etc.
        raise TokenInvalid(f"invalid token: {e}") from e
    return claims
```

([PyJWT — `PyJWKClient(url)` + `jwks_client.get_signing_key_from_jwt(token)`, and
`jwt.decode(token, signing_key, audience=..., algorithms=["RS256"])`](https://pyjwt.readthedocs.io/en/latest/usage.html);
the JWK Set cache "is enabled by default … lifespan defaulting to 300 seconds," and "if the `kid` is not
found in the current key set, `PyJWKClient` automatically refreshes the JWKS from the endpoint and retries
before raising an error.")

**The three load-bearing verification rules:**

1. **Pin `algorithms=["RS256"]`.** If you pass the algorithm from the token *header* you open the
   classic algorithm-confusion attack (an attacker sets `alg: none` or `alg: HS256` and signs with the
   public key as an HMAC secret). PyJWT "parses and verifies the algorithm in the header, and since you
   specify RS256 as the expected algorithm, if the header contains a different algorithm (like HS256),
   PyJWT will reject the token." ([PyJWT usage](https://pyjwt.readthedocs.io/en/latest/usage.html).) Pin
   it; never trust the header.
2. **Always validate `aud`.** "Without audience validation, a token issued for one API can be replayed
   against a different API protected by the same authorization server." ([RFC 9068](https://datatracker.ietf.org/doc/html/rfc9068).)
   This is `verify_aud=True` + the `audience=` argument. §6 is the whole story.
3. **Always validate `exp` and `iss`.** Expired tokens and tokens from an unexpected issuer are rejected.
   `require=[...]` additionally rejects tokens *missing* a mandatory claim — defense against a malformed
   token that happens to verify.

> **The JWKS-availability trade.** Local verification depends on the JWKS being fetchable. "Downloading
> the `jwks_uri` provides better security if keys are revoked, but risks validation failure if the
> Authorization Server is down." ([renzolucioni / PyJWT pattern](https://renzolucioni.com/verifying-jwts-with-jwks-and-pyjwt/).)
> Mitigate by caching the JWKS in-process (PyJWKClient does) so a transient AS outage doesn't break
> verification — you keep verifying with the last-known keys until the cache lifespan elapses.

---

## 6. Scopes per key — least privilege, and the `aud`/resource claim <a id="6-scopes-and-aud"></a>

Two different claims do two different jobs. Getting them straight is the difference between a real authz
model and security theater.

### 6.1 `aud` (audience / resource) — *which API* is this token for

`aud` answers "which resource server may accept this token." It is set at mint time from the consumer's
requested `audience`/`resource`/`scope` and is **mandatory** in RFC 9068; **every resource server must
validate it** (§5.2 rule 2). JPM's is `JPMC:URI:RS-06785-DataQueryExternalApi-PROD` (§4). If our channel
exposes multiple resource servers (timeseries vs bulk-file vs agent-gateway), each gets its **own `aud`
URI**, so a token minted for the timeseries API is *rejected* by the bulk-file API — even though the same
authorization server minted both. That rejection is the entire point: `aud` stops token replay across
your own APIs.

```text
aud = JPMC:URI:RS-06785-DataQueryExternalApi-PROD     # JPM's production DataQuery resource (real, §4)
aud = urn:our-data-api:timeseries:prod                # our timeseries channel
aud = urn:our-data-api:bulkfiles:prod                 # our bulk-file channel  (different server, different aud)
```

### 6.2 `scope` — *what may this token do* at that API (least privilege)

`scope` answers "what operations." It is a space-delimited list of permission strings the resource
server checks **per endpoint**. Issue each client only the scopes it needs — "always request the minimum
scope needed for the call; this limits damage if the token is exfiltrated." ([authgear](https://www.authgear.com/post/the-complete-guide-to-machine-to-machine-m2m-authentication/);
scalekit — "the scoped permissions limit what a compromised client can do.")

Design a scope taxonomy for the channel and grant per client:

```text
timeseries:read         # GET /timeseries
catalog:read            # GET /catalog, /datasets
bulkfiles:download      # GET /files/{id}
admin:keys:rotate       # POST /admin/keys/rotate   (operator clients only)
```

Enforcement on the server side is a small dependency in front of each route:

```python
# server/scopes.py — FastAPI dependency that enforces a required scope
from fastapi import Depends, Header, HTTPException
from .verify_token import verify_access_token, TokenInvalid

THIS_API_AUD = "urn:our-data-api:timeseries:prod"


def require_scope(required: str):
    def _dep(authorization: str = Header(...)) -> dict:
        if not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "missing bearer token")
        token = authorization[7:]
        try:
            claims = verify_access_token(token, required_audience=THIS_API_AUD)
        except TokenInvalid as e:
            raise HTTPException(401, str(e))
        granted = set((claims.get("scope") or "").split())
        if required not in granted:
            # 403, not 401: the caller IS authenticated, just not authorized for THIS action.
            raise HTTPException(403, f"missing scope: {required}")
        return claims
    return _dep


# usage in a router:
# @router.get("/timeseries")
# def get_timeseries(claims: dict = Depends(require_scope("timeseries:read"))): ...
```

**`401` vs `403`** is a real distinction the rubric checks: `401` = "I don't know who you are" (bad/absent
token); `403` = "I know who you are, you're not allowed this" (good token, missing scope). Returning
`403` for a missing scope tells the caller *re-mint won't help — ask an admin for the scope*, which is
the correct, actionable signal.

> **`aud` is checked at verification (§5.2), `scope` is checked per-route (here).** A junior build
> conflates them or skips `aud`. Both are non-negotiable: `aud` stops cross-API replay, `scope` enforces
> least privilege within an API.

---

## 7. Local JWKS verification vs token introspection — the decision <a id="7-jwks-vs-introspection"></a>

There are two ways a resource server can validate a token. Pick by token format and revocation need.

| | **Local JWKS verification** (default) | **Introspection** (RFC 7662) |
|---|---|---|
| How | verify signature + claims with the cached public key, in-process | POST the token to the AS's `/introspect`; trust its `active: true/false` reply |
| Network per request | **none** (after JWKS is cached) | **one round-trip to the AS, every request** |
| Works for | self-contained **JWT** access tokens | **opaque** tokens (no readable structure) *and* JWTs |
| Revocation latency | up to the token TTL (15 min) | **immediate** (AS knows the moment it's revoked) |
| Use when | tokens are JWTs, signature+`exp` suffice, low revocation need | tokens are opaque, OR revocation must be instant |

([RFC 7662 — introspection "to determine the active state of an OAuth 2.0 token … the most important
parameter is `active`"](https://datatracker.ietf.org/doc/html/rfc7662); scalekit — *"If tokens are opaque
AND revocation must be immediate → use introspection. If tokens are JWTs AND signature + exp suffice AND
low revocation needs → local validation instead."*; authgear — *"verify locally for performance but fall
back to introspection if the signature is unknown or `kid` is missing."*)

**Verdict for our channel: local JWKS verification.** Our access tokens are short-lived JWTs (15 min), so
the worst-case revocation lag *is* 15 minutes — acceptable for a data API. Introspection's per-request
round-trip would make our `aud`/`scope` check a network call instead of a CPU op, defeating the entire
point of a self-contained token at scale. Keep introspection in your back pocket for one case only:
**immediate revocation** of a specific compromised client mid-session — and even then a `jti` denylist
(checked in-process against a small Redis set) is cheaper than full introspection.

> **R-SCALE consequence.** At 10,000× concurrent callers, *local* verify is the only design that holds:
> it's a signature check (microseconds) against an in-memory key. Introspection at that scale would add a
> synchronous AS call to *every* request — the AS becomes the bottleneck and a single point of failure
> for the whole channel. This is the compute-once-serve-many principle applied to *trust*: fetch the
> verification key once, verify millions of tokens against it locally.

---

## 8. API keys vs OAuth — when each, and the hashed-key store <a id="8-api-keys"></a>

OAuth `client_credentials` is the right default for **scoped, rotating, cross-boundary** access. But a
plain **API key** is the right tool for **simple, trusted, internal** callers where the OAuth ceremony
buys nothing. Know which you're building.

### 8.1 The decision

| | **API key** | **OAuth client_credentials** |
|---|---|---|
| Shape | one static string in a header | a flow that mints short-lived JWTs |
| Integration cost | trivial (one header, no flow) | a token client (§3) |
| Lifetime | **forever until rotated** | **minutes** (auto-expires) |
| Scoping | coarse (per-key, if you build it) | fine (`scope` claim, standardized) |
| Leak blast radius | large + indefinite | small + minutes |
| Best for | internal service, trusted partner, a CLI | cross-org, SaaS consumption, anything crossing a trust boundary |

([WorkOS — "Static API keys are the simplest to integrate (one header, no flow), the easiest to leak (a
single string valid forever until rotated)."](https://workos.com/blog/api-keys-vs-m2m-applications);
MojoAuth/scalekit — "OAuth 2.0 Client Credentials is the right default for cross-organization
integrations, SaaS API consumption, and any service-to-service traffic that crosses a trust boundary.")

**Verdict for our channel:** offer **both**. OAuth `client_credentials` is the front door for external
and scoped access. An API key is a convenience door for our *own* internal services (e.g. the FastAPI
data plane calling its own admin endpoint) where a full OAuth client is overkill. Both run through the
same scope-enforcement dependency (§6) — an API key maps to a row that carries its granted scopes.

### 8.2 Store keys HASHED — SHA-256, not bcrypt

**Never store an API key in plaintext.** Store only its **hash**, and verify by hashing the incoming key
and comparing. The right hash for an API key is **SHA-256, not bcrypt/argon2**:

> "Never store keys in plain text; hash all keys with SHA-256 before storing them … SHA-256 is a good
> choice over bcrypt or argon2 because API keys have high entropy, making brute-force attacks
> impractical; SHA-256 is fast, which matters when validating keys on every API request."
> ([Zuplo / oneuptime](https://zuplo.com/blog/api-key-authentication))

The reasoning is the inverse of password hashing. Passwords are *low entropy* (humans pick `password1`),
so you deliberately make hashing *slow* (bcrypt) to throttle brute force. An API key is a 256-bit random
string — *high entropy* — so brute force is already impossible; a slow hash buys nothing and **costs you
CPU on every single request**. "Bcrypt is slow by design … if you have a ton of users pounding on your
API, your bottleneck will be CPU and memory." ([cybersierra](https://cybersierra.co/blog/bcrypt-performance-issues-api/).)

### 8.3 The store schema + verification (prefix lookup + constant-time compare)

Give every key a **public prefix** (for lookup + secret-scanner identification) and an opaque secret half.
Store the prefix in clear (it's not secret) and the SHA-256 of the full key.

```text
key as issued to the client:   dqk_live_8f3aa1c4e9b2...   (prefix "dqk_live_" + 32 random bytes, base62)
stored row:
  id           uuid
  key_prefix   text   "dqk_live_8f3aa1c4"     -- first chars, indexed, for O(1) lookup
  key_hash     text   sha256(full_key) hex    -- the only copy of the secret half
  scopes       text[] {"timeseries:read","catalog:read"}
  status       text   active | expiring | revoked
  expires_at   timestamptz null
  created_at   timestamptz
```

```python
# server/api_keys.py — issue + verify an API key
import secrets
import hashlib
import hmac

PREFIX = "dqk_live_"


def issue_api_key() -> tuple[str, str, str]:
    """Returns (full_key_shown_once, key_prefix_stored, key_hash_stored)."""
    body = secrets.token_urlsafe(32)          # 256 bits of entropy
    full_key = f"{PREFIX}{body}"
    key_prefix = full_key[: len(PREFIX) + 8]  # prefix + a few chars => indexable lookup handle
    key_hash = hashlib.sha256(full_key.encode()).hexdigest()
    # Persist key_prefix, key_hash, scopes, status. NEVER persist full_key.
    return full_key, key_prefix, key_hash     # show full_key to the user ONCE, then forget it


def verify_api_key(presented: str, stored_hash: str) -> bool:
    candidate = hashlib.sha256(presented.encode()).hexdigest()
    # Constant-time compare so the server can't be timing-attacked into leaking the hash.
    return hmac.compare_digest(candidate, stored_hash)
```

The four properties this gives you, each cited:

- **Hashed at rest** — a DB dump leaks no usable key. ([Zuplo](https://zuplo.com/blog/api-key-authentication).)
- **Prefix for lookup + identification** — "a common best practice is to add a prefix … developers and
  secret scanners can immediately tell what service the key belongs to." The prefix is your indexed
  lookup handle, so verification is one indexed read, not a full-table scan. ([Zuplo](https://zuplo.com/blog/api-key-authentication).)
- **Constant-time compare** — `hmac.compare_digest` so an attacker can't time the comparison to recover
  the hash byte-by-byte. ([oneuptime — "perform a constant-time comparison against the stored hash."](https://oneuptime.com/blog/post/2026-01-30-how-to-build-api-authentication-patterns/view).)
- **Show-once** — the full key is returned to the user exactly once at creation; you keep only its hash,
  so you *cannot* show it again. This is "irretrievable" key design and is the safer default. ([cybersierra](https://cybersierra.co/blog/secure-api-keys-guide/).)

### 8.4 Key rotation with a grace window

Rotation must not cause downtime. Issue the new key, mark the old one `expiring` with a grace period
(24–72 h), accept **both** during the window, then deactivate the old one:

> "Generate a new key and store its hash, mark the old key as 'expiring' with a grace period (e.g.,
> 24–72 hours), both keys work during the grace period, after the grace period the old key is
> automatically deactivated." ([oneuptime](https://oneuptime.com/blog/post/2026-02-20-api-key-management-best-practices/view).)

This is the same overlap-during-rotation shape as JWT signing-key rotation (§5.1): never a hard cutover,
always an overlap window sized to the in-flight lifetime.

---

## 9. Secret handling — the repo's inject-by-closure non-negotiable <a id="9-secret-handling"></a>

Both halves of this doc handle secrets — the consumer holds a `client_secret`, the server holds a private
signing key and key hashes. The repo's governing rule (which *does* apply to this product line because
it's a stated cross-cutting non-negotiable, even though the line is not Lumina) is:

> **Secure tool args via closure.** `userId`/secrets are injected in the tool factory — the model never
> supplies them (confused-deputy / prompt-injection defense). ([`CLAUDE.md`](../../../../CLAUDE.md)
> non-negotiable #6; [`skill-layer-law.md`](../../../rules/skill-layer-law.md).)

For channel auth this expands to a hard checklist:

1. **The `client_secret` / private key is injected at the call site by closure — never a function
   argument the model (or an untrusted caller) can set.** In our token client (§3), `client_secret` is a
   constructor field set from config at app boot; no request path and no LLM tool ever passes it. This is
   the *confused-deputy* defense: if the agent tool layer calls our channel, the agent supplies the
   *query*, never the *credential*. The credential is closed over in the tool factory.

   ```python
   # GOOD — secret closed over at factory time; the tool the model calls takes NO secret
   def make_timeseries_tool(*, token: ClientCredentialsToken, http: httpx.Client):
       def fetch_timeseries(symbol: str, start: str, end: str) -> dict:   # model controls THESE only
           resp = call_with_bearer(http, token, "GET",
                                   f"{BASE}/timeseries",
                                   params={"symbol": symbol, "start": start, "end": end})
           resp.raise_for_status()
           return resp.json()
       return fetch_timeseries
   # `token` (which holds client_secret) is NEVER a parameter of fetch_timeseries.
   ```

2. **Never in a query string.** Secrets and tokens go in headers (`Authorization`) or the
   form-urlencoded *body* of `/token` — never `?api_key=…`. Query strings are logged by every proxy,
   land in `Referer` headers, and show up in browser history.

3. **Never in `.env` committed to the repo, never in tool args, never echoed to logs.** Config comes
   from the environment / a secrets manager (HashiCorp Vault, cloud KMS) at boot. ([authgear — "generate
   production keys in HSM or KMS"; scalekit — "Client secrets should be protected in secure stores
   (HashiCorp Vault, cloud KMS, CI secret storage)."](https://www.authgear.com/post/the-complete-guide-to-machine-to-machine-m2m-authentication/))
   The repo's `precheck-licensing.mjs` PreToolUse hook *asks* on edits touching `.env`
   ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) §Enforcement) — a reminder that
   secrets and committed files don't mix.

4. **Redact tokens in logs.** When you log a request for debugging, log the *presence* of the
   `Authorization` header, never its value; log a token's `jti`/`client_id`/`exp`, never the token
   string. A token in a log file is a token leak with a long tail.

---

## 10. The certificate-auth alternative (DataQuery's `CERT_BASE_URL`) <a id="10-cert-auth"></a>

A shared `client_secret` is a long-lived bearer of trust — if it leaks, anyone can mint tokens until you
rotate it. The higher-assurance alternative is **certificate-based client authentication**: the client
proves it holds a private key by signing the request, and the secret never travels on the wire.

Two distinct mechanisms wear the "cert" label — don't confuse them:

### 10.1 Private-key JWT client assertion (RFC 7523 — Microsoft's "certificate" case)

Instead of `client_secret`, the client signs a short JWT with its certificate's private key and sends it
as `client_assertion`. Microsoft Entra's documented request:

```http
POST /{tenant}/oauth2/v2.0/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

scope=https%3A%2F%2Fgraph.microsoft.com%2F.default
&client_id=11112222-bbbb-3333-cccc-4444dddd5555
&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer
&client_assertion=eyJhbGciOiJSUzI1NiIsIng1dCI6...M8U3bSUKKJDEg
&grant_type=client_credentials
```

"The parameters for the certificate-based request differ in only one way from the shared secret-based
request: the `client_secret` parameter is replaced by the `client_assertion_type` and `client_assertion`
parameters." ([Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).)
The win: the private key never leaves the client; only a per-request signed assertion does. A captured
assertion is useless after its `exp` (seconds). This is "a higher level of assurance" than a shared
secret. Microsoft also documents a *federated-credential* third case where the JWT comes from *another*
identity provider (workload identity federation) — same wire shape, externally-sourced `client_assertion`.

### 10.2 mTLS / cert-file auth (JPM DataQuery's `CERT_BASE_URL`)

JPM DataQuery additionally offers a **certificate-file auth path** (a `DataQueryCertAuth` class in the
macrosynergy client) that authenticates with a `crt` + `key` file pair plus `username`/`password`,
against a *different base URL* from the OAuth path:

```python
# macrosynergy DataQueryCertAuth (read this session) — the non-OAuth, cert-file path
DataQueryCertAuth(crt=".../client.crt", key=".../client.key",
                  username="...", password="...")
# distinct from DataQueryOAuth — a separate CERT_BASE_URL endpoint, mTLS-style client cert
```

([macrosynergy docs](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html).) Here
the TLS layer itself carries the client certificate (mutual TLS); there's no bearer token at all on that
path. JPM exposes it because some corporate environments mandate client certs over shared secrets.

**Verdict for our channel:** ship `client_secret` (§2) as the v1 default — simplest, universally
supported. Add **private-key-JWT client assertion (§10.1)** as the high-assurance option for partners who
require it (it's a drop-in replacement of two form fields; our `/token` server validates the assertion
signature against the client's registered public key instead of comparing a secret). Treat full mTLS
(§10.2) as a later, infra-heavy option — it pushes cert management into the TLS terminator/load balancer
and is only worth it where a regulated counterparty demands it.

---

## 11. Mapping to the repo's Supabase JWT validation + the gateway <a id="11-repo-mapping"></a>

Although this product line is **not** Lumina, Lumina's repo already implements the *exact* server-side
patterns this doc prescribes — so the repo is a working reference for the shape (read at
`backend/auth.ts`). The mapping is one-to-one:

| This doc (Python data channel) | Lumina's repo (Bun/Express) — `backend/auth.ts` |
|---|---|
| Read `Bearer` JWT off the request | `const token = req.headers.authorization` |
| Verify the JWT **locally** against cached keys | Supabase `getClaims(jwks)` does ES256/RS256 verification "locally usually without a network request" ([Supabase](https://supabase.com/docs/guides/auth/jwts)) |
| Token cache to avoid re-verifying every request | `tokenCache: Map<token, {userId, expiresAt}>` with a 5-min TTL (`backend/auth.ts:28-29`) |
| `kid` → JWKS public key lookup, cached | Supabase server "fetches the JWKS on startup, caches the public keys in memory … reads the `kid` from the incoming JWT, looks up the right key" ([Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)) |
| Reject on bad/absent token → `401` | `if (!user) return res.status(401)` (`backend/auth.ts:49`) |
| Idempotent provisioning of the principal | `provisionedUsers: Set` + `prisma.user.upsert` once per process (`backend/auth.ts:33,53-68`) |

The two differences to internalize:

1. **Lumina validates a *user* JWT (authorization-code, human present); our channel validates a *service*
   JWT (`client_credentials`, no human).** The *verification* mechanics are identical (local JWKS, cached
   keys, `kid` lookup, `exp`/`iss`/`aud` checks); only the *grant that minted the token* differs. Lumina's
   `auth.getUser(token)` is the convenience wrapper; our channel does the equivalent with PyJWT +
   `PyJWKClient` (§5.2) because there's no Supabase user to resolve — just a `client_id` principal.
2. **The token cache pattern is the same idea on both sides of the wire.** Lumina caches *verified*
   tokens server-side (skip re-verification within a TTL); our consumer caches *minted* tokens client-side
   (skip re-minting within the 0.9-buffer window). Both are compute-once-serve-many applied to auth.

**On "the gateway":** Lumina routes *model* calls through the Vercel AI Gateway (a per-call upstream auth
concern), which is orthogonal to channel auth — don't conflate them. The analogy that *does* transfer:
just as Lumina centralizes model-provider credentials behind one gateway so individual call sites never
hold provider keys, our data channel centralizes the `client_secret`/private-signing-key in the token
manager / issuer so individual tool/route call sites never hold them (§9). One credential-holding chokepoint,
many credential-free call sites.

---

## 12. Worked end-to-end: mint → call → verify, both sides runnable <a id="12-worked-end-to-end"></a>

A complete, runnable round-trip: a consumer mints a token and calls our timeseries API; our server
verifies it locally and checks the scope. (Imports condensed; assumes the modules from §3, §5, §6, §8.)

### 12.1 Consumer: mint once, call many (with the retry-one-401)

```python
# consumer_demo.py
import httpx
from auth.client_credentials import ClientCredentialsToken
from auth.with_bearer import call_with_bearer

# Built once at boot. client_secret comes from the environment / secrets manager — NEVER a literal here.
import os
http = httpx.Client(http2=True)
token = ClientCredentialsToken(
    token_url="https://data-api.example.com/oauth/token",
    client_id=os.environ["DATA_API_CLIENT_ID"],
    client_secret=os.environ["DATA_API_CLIENT_SECRET"],   # injected by closure (§9)
    audience="urn:our-data-api:timeseries:prod",          # the aud we mint FOR (§6)
    http=http,
    buffer=0.9,                                            # JPM's TOKEN_EXPIRY_BUFFER (§4)
)

# First call mints a token and caches it; the next 1000 calls in the next ~13.5 min reuse it.
for sym in ("AAPL", "MSFT", "NVDA"):
    resp = call_with_bearer(
        http, token, "GET",
        "https://data-api.example.com/timeseries",
        params={"symbol": sym, "start": "2026-01-01", "end": "2026-06-01"},
    )
    resp.raise_for_status()
    print(sym, len(resp.json()["points"]), "points")
```

### 12.2 Server: our `/token` issuer + the protected route

```python
# server_demo.py  (FastAPI)
from fastapi import FastAPI, Form, Depends, HTTPException
from server.issue_token import issue_access_token
from server.scopes import require_scope

app = FastAPI()

# --- our /token endpoint: client_credentials grant ---------------------------
# In reality: look up the client row by client_id, verify the secret (hashed, constant-time),
# read its granted scopes + allowed audiences, then mint. Simplified here.
@app.post("/oauth/token")
def token(
    grant_type: str = Form(...),
    client_id: str = Form(...),
    client_secret: str = Form(...),
    aud: str = Form(...),
):
    if grant_type != "client_credentials":
        raise HTTPException(400, "unsupported_grant_type")          # RFC 6749 §5.2
    client = lookup_and_verify_client(client_id, client_secret)     # hashed compare (§8.3)
    if client is None:
        raise HTTPException(401, "invalid_client")                  # bad creds => 401, NOT retried by consumer
    if aud not in client.allowed_audiences:
        raise HTTPException(400, "invalid_target")
    access_token, ttl = issue_access_token(
        private_key=SIGNING_PRIVATE_KEY, kid=ACTIVE_KID,
        client_id=client_id, audience=aud, granted_scopes=client.scopes,
    )
    # No refresh_token — by design (RFC 6749 §4.4.3).
    return {"access_token": access_token, "token_type": "Bearer", "expires_in": ttl}

# --- a protected data route: verifies the JWT locally + checks scope ----------
@app.get("/timeseries")
def get_timeseries(symbol: str, start: str, end: str,
                   claims: dict = Depends(require_scope("timeseries:read"))):
    # `claims` is the verified JWT payload: aud/exp/iss already validated (§5.2),
    # scope 'timeseries:read' already enforced (§6). Safe to serve.
    return {"symbol": symbol, "points": load_points(symbol, start, end)}
```

### 12.3 The full sequence, annotated

```text
CONSUMER                         OUR /token                    OUR /timeseries (resource server)
   |                                |                                  |
   | (cache empty / past buffer)    |                                  |
   |  POST /oauth/token             |                                  |
   |   grant_type=client_credentials|                                  |
   |   client_id, client_secret,    |                                  |
   |   aud=urn:...:timeseries:prod  |                                  |
   |------------------------------->| verify client secret (hashed,    |
   |                                |   constant-time) -> mint RS256    |
   |                                |   JWT (iss/exp/aud/scope/jti)     |
   |  200 {access_token, Bearer,    |                                  |
   |       expires_in:900}  (NO     |                                  |
   |       refresh_token)           |                                  |
   |<-------------------------------|                                  |
   | cache token; refresh_at = now  |                                  |
   |   + 900*0.9 = +810s            |                                  |
   |                                |                                  |
   |  GET /timeseries  Authorization: Bearer <jwt>  -------------------->| PyJWKClient: kid -> cached JWKS
   |                                |                                  | jwt.decode(RS256): verify sig,
   |                                |                                  |   exp, iss, aud == this api
   |                                |                                  | scope 'timeseries:read' in token?
   |  200 {points:[...]}  <-------------------------------------------- | yes -> serve
   |                                |                                  |
   |  ... 1000 more calls in next 13.5 min reuse the cached token (no /token hit) ...
   |                                |                                  |
   |  GET /timeseries (token now stale: AS rotated kid)  -------------->| jwt.decode -> 401
   |  401  <----------------------------------------------------------- |
   | token.invalidate(); re-mint;   |                                  |
   |   retry the GET exactly once   |                                  |
   |  GET /timeseries  Authorization: Bearer <fresh jwt> -------------->| verifies -> 200
```

This is the whole channel-auth contract on one diagram: **mint short-lived, cache to the 0.9 buffer,
verify locally against cached JWKS, check `aud` + `scope`, retry one `401` with a fresh token, never a
refresh token.**

---

## 13. Anti-patterns specific to channel auth <a id="13-anti-patterns"></a>

| Anti-pattern | Why it breaks | Fix |
|---|---|---|
| Mint a token on **every** API call | turns `/token` into a hot path; at 10,000× it's the bottleneck; wastes the AS's rate budget | cache per-process; refresh at the 0.9 buffer (§3) |
| Wait for a `401` to refresh | every token's last 10% of life produces failed calls + a retry storm | refresh **before** expiry with the buffer (§3) — proactive, not reactive |
| 50 coroutines each mint on a cache miss | thundering herd on `/token`; the AS may rate-limit or block you | single-flight under one lock; re-check under the lock (§3.1) |
| Retry `401` in a loop | a permissions misconfig becomes a self-DoS hammering two endpoints | retry **exactly once** with a fresh token, then surface (§3.3) |
| Build a refresh-token flow for `client_credentials` | there is none (RFC 6749 §4.4.3); you're inventing a state machine that the grant deliberately omits | re-call `/token`; that *is* the refresh (§1.1) |
| Verify the JWT by calling the AS on every request (introspection-by-default) | a network round-trip per request; the AS is now a SPOF for the whole channel | local JWKS verification; introspect only for opaque tokens / instant revocation (§7) |
| Pass `algorithms` from the token **header** | algorithm-confusion attack (`alg:none` / `HS256`-with-public-key) | pin `algorithms=["RS256"]` at the verifier (§5.2) |
| Skip the `aud` check | a token for API-A replays against API-B behind the same AS | always `verify_aud=True` + per-API `aud` URIs (§6, RFC 9068) |
| Skip the `scope` check (verify == authorize) | any authenticated client can hit any endpoint; no least privilege | enforce `scope` per route (§6); `403` (not `401`) on a missing scope |
| Sign tokens with a shared **HMAC** secret | every resource server needs the signing secret to verify → one leak compromises minting | asymmetric (RS256/ES256); verifiers hold only the public JWKS (§5.1) |
| Store API keys in plaintext (or bcrypt) | plaintext: a DB dump = total compromise. bcrypt: needless CPU on every request | SHA-256 hash + prefix lookup + constant-time compare (§8) |
| Put the token/key in a **query string** | logged by proxies, leaks via `Referer`/history | `Authorization` header (or `/token` form body) only (§9) |
| `client_secret` as a function/tool argument | confused-deputy: an untrusted caller/model can set it | inject by closure at the factory; the call site never holds it (§9, non-negotiable #6) |
| A static bearer (`DATAQUERY_BEARER_TOKEN`-style) with no rotation reminder | silently expires → a confusing 2 a.m. outage | document that static bearers don't auto-refresh; alert before `exp` (§4.2) |

---

## 14. Output contract — the grading rubric for a channel-auth PR <a id="14-output-contract"></a>

A channel-auth change is "done" only if it satisfies all of the following. This is what a reviewer
(and the red-team negation loop, [`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md))
checks.

**Consumer side**
- [ ] Uses `grant_type=client_credentials`; **no** refresh-token logic anywhere (RFC 6749 §4.4.3).
- [ ] Token cached in memory, keyed by `(token_url, client_id, scope/aud)`; not minted per request.
- [ ] Refreshes **before** expiry at a buffer (`0.9` of `expires_in`, matching JPM's `TOKEN_EXPIRY_BUFFER`).
- [ ] Concurrent refreshes de-duplicated by a single lock with a re-check under the lock (single-flight).
- [ ] Exactly **one** `401` retry with a freshly minted token; no retry loop.
- [ ] `client_secret` injected by closure; never a tool/function arg; never in a query string or logged.

**Server side**
- [ ] Tokens signed with an **asymmetric** key (RS256/ES256); public JWKS published at `/.well-known/jwks.json`.
- [ ] Verification is **local** against a **cached** JWKS (`PyJWKClient` or equivalent); no per-request AS call.
- [ ] `algorithms` is **pinned** at the verifier (never read from the token header).
- [ ] `aud`, `iss`, `exp` all validated; required claims enforced (RFC 9068 set).
- [ ] `scope` enforced per route; `403` (not `401`) on a present-but-insufficient token.
- [ ] Introspection used **only** where justified (opaque tokens / instant revocation), not as the default.

**API-key path (if present)**
- [ ] Keys stored **hashed** (SHA-256), never plaintext, never bcrypt; verified with a constant-time compare.
- [ ] Public prefix for indexed lookup + scanner identification; secret half shown once, never re-retrievable.
- [ ] Rotation has an overlap/grace window; revocation is a status flip, not a delete.

**Scale + claims**
- [ ] States the tier it survives and the `/token` + verify behavior at 10,000× (compute-once-serve-many
      on both the consumer cache and the local verify) — per [`product-at-scale.md`](../../../rules/product-at-scale.md).
- [ ] Every version/behavior claim carries a primary-source citation or a `[unverified]` flag (per
      [`cto-rules.md`](../../../rules/cto-rules.md) §3).

---

## 15. Pinned versions + sources <a id="15-sources"></a>

**Pinned (verify at build time — June 2026):**

| Thing | Version / value | Source |
|---|---|---|
| PyJWT | **2.13.0** | [pyjwt.readthedocs.io](https://pyjwt.readthedocs.io/en/latest/usage.html) |
| PyJWKClient JWK-Set cache lifespan (default) | **300 s** | [PyJWT](https://pyjwt.readthedocs.io/en/latest/usage.html) |
| JPM DataQuery `aud` (resource id) | **`JPMC:URI:RS-06785-DataQueryExternalApi-PROD`** | [macrosynergy/macrosynergy `download/dataquery.py` (develop)](https://github.com/macrosynergy/macrosynergy/blob/develop/macrosynergy/download/dataquery.py) |
| JPM DataQuery `OAUTH_TOKEN_URL` | **`https://authe.jpmchase.com/as/token.oauth2`** | same |
| JPM DataQuery `OAUTH_BASE_URL` | **`https://api-developer.jpmorgan.com/research/dataquery-authe/api/v2`** | same |
| JPM SDK refresh buffer `TOKEN_EXPIRY_BUFFER` | **0.9** | same |
| Microsoft Entra documented access-token TTL | `expires_in: 3599` (≈1 h) | [Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow) |
| Recommended M2M token TTL | **5–60 min** (we choose 15 min) | [authgear](https://www.authgear.com/post/the-complete-guide-to-machine-to-machine-m2m-authentication/) |
| API-key hash | **SHA-256** (not bcrypt) | [Zuplo](https://zuplo.com/blog/api-key-authentication) |

**Specs (primary):**
- [RFC 6749 — The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749):
  [§4.4 client credentials](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4),
  [§4.4.3 "A refresh token SHOULD NOT be included"](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4.3),
  [§2.3.1 client authentication (Basic vs body)](https://datatracker.ietf.org/doc/html/rfc6749#section-2.3.1).
- [RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)
  (required claims; `aud` validation mandate).
- [RFC 7662 — OAuth 2.0 Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662)
  (the `active` reply; when to introspect).
- [oauth.net — Client Credentials grant type](https://oauth.net/2/grant-types/client-credentials/).

**Vendor / authorization-server docs:**
- [Microsoft Entra — OAuth 2.0 client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)
  (verbatim request/response for secret, certificate `client_assertion`, and federated-credential cases).
- [Auth0 — client credentials flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-credentials-flow) +
  [call your API](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-credentials-flow/call-your-api-using-the-client-credentials-flow).
- [Supabase — JWTs](https://supabase.com/docs/guides/auth/jwts) +
  [signing keys / asymmetric](https://supabase.com/docs/guides/auth/signing-keys) +
  [`auth.getClaims`](https://supabase.com/docs/reference/javascript/auth-getclaims).

**Library source (read at the source this session):**
- [`jpmorganchase/dataquery-sdk`](https://github.com/jpmorganchase/dataquery-sdk) — env vars,
  `DATAQUERY_BEARER_TOKEN`, OAuth caching/refresh, `dataquery auth test`.
- [`macrosynergy/macrosynergy` `download/dataquery.py` + `jpm_oauth.py`](https://github.com/macrosynergy/macrosynergy/blob/develop/macrosynergy/download/dataquery.py) —
  `DataQueryOAuth`/`JPMorganOAuth`, the constants, the payload, `DataQueryCertAuth`
  ([docs](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html)).
- [PyJWT usage](https://pyjwt.readthedocs.io/en/latest/usage.html) — `encode`/`decode`/`PyJWKClient`.

**Engineering writing (cross-verified):**
- [authgear — The Complete Guide to M2M Authentication](https://www.authgear.com/post/the-complete-guide-to-machine-to-machine-m2m-authentication/).
- [scalekit — OAuth Tokens for M2M](https://www.scalekit.com/blog/oauth-tokens-m2m-authentication) /
  [API keys → OAuth migration](https://www.scalekit.com/blog/migrating-from-api-keys-to-oauth-mcp-servers).
- [WorkOS — API Keys vs M2M Applications](https://workos.com/blog/api-keys-vs-m2m-applications).
- [Zuplo — API Key Authentication Best Practices](https://zuplo.com/blog/api-key-authentication) /
  [oneuptime — API key management](https://oneuptime.com/blog/post/2026-02-20-api-key-management-best-practices/view) /
  [oneuptime — API auth patterns](https://oneuptime.com/blog/post/2026-01-30-how-to-build-api-authentication-patterns/view).
- [cybersierra — bcrypt vs SHA-256 for API keys](https://cybersierra.co/blog/bcrypt-performance-issues-api/) /
  [irretrievable vs retrievable keys](https://cybersierra.co/blog/secure-api-keys-guide/).
- [oneuptime — request coalescing / single-flight in Python](https://oneuptime.com/blog/post/2026-01-23-request-coalescing-python/view).
- [renzolucioni — Verifying JWTs with JWKs and PyJWT](https://renzolucioni.com/verifying-jwts-with-jwks-and-pyjwt/).

**Repo cross-references (Lumina — the working reference for the server-side shape, NOT the same product line):**
- `backend/auth.ts` — Bearer read, `auth.getUser` local validation, token cache (`:28-29`), idempotent
  provisioning (`:33,53-68`).
- [`skill-layer-law.md`](../../../rules/skill-layer-law.md) — inject-by-closure (non-negotiable #6).
- [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) — the `.env` PreToolUse guard.
- [`product-at-scale.md`](../../../rules/product-at-scale.md) — the R-SCALE tier discipline applied to `/token` + verify.
- [`cto-rules.md`](../../../rules/cto-rules.md) — the research/citation standard this doc was written to.
