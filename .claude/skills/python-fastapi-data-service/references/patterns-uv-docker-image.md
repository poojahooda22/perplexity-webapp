# patterns-uv-docker-image.md

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (a NEW Python/FastAPI
> backend, **NOT** Lumina's Bun/Express/Vercel app). This recipe is the **production container image**
> for the Python data plane: a multi-stage `Dockerfile` built on the official `uv` image that produces a
> small, reproducible, fast-cold-start image that ships to **Fly.io**. It is the Python-line analogue of
> Lumina's `worker/` Fly deploy — the long-lived process that *can* hold sockets and run heavy ingest,
> i.e. exactly the work Lumina's non-negotiable #4 forbids on the Vercel serverless path. Greenfield —
> there are no codebase `file:line` anchors yet; everything below is a build recipe grounded in primary
> docs and the canonical Astral example repo.

**What this doc decides for you, up front (the verdicts):**

1. **Install uv by `COPY --from` a pinned image tag, never `curl | sh`, never `pip install uv`, never
   `:latest`.** `COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/` copies a single static binary
   from a registry image into your build stage. Pinning the tag (or, for paranoid reproducibility, the
   `@sha256:` digest) makes the build deterministic. ([uv Docker guide — "it is best practice to pin to a
   specific uv version"](https://docs.astral.sh/uv/guides/integration/docker/#installing-uv))
2. **Multi-stage: a `builder` that has uv, a runtime that does not.** The final image ships only the
   `.venv` and your source; uv itself (and the whole build toolchain) is left behind in the builder
   stage. This is the documented `multistage.Dockerfile` from
   [`astral-sh/uv-docker-example`](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile).
3. **Two-step locked sync, dependencies first.** `uv sync --locked --no-install-project` (deps only, from
   a *bind-mount* of `uv.lock`+`pyproject.toml`) → `COPY . /app` → `uv sync --locked` (now the project
   itself). Dependencies change rarely and your code changes every commit; splitting them puts the
   expensive layer above the cheap one so Docker's layer cache survives a code edit.
4. **`--mount=type=cache` on `/root/.cache/uv`** persists uv's download/build cache *across builds*
   without baking it into a layer. Combined with `UV_LINK_MODE=copy`, this is the single biggest rebuild
   speedup.
5. **`ENV UV_COMPILE_BYTECODE=1`** compiles `.py` → `.pyc` at install time so the first request doesn't
   pay the compile cost — directly buys cold-start latency on Fly, which is the metric that matters for a
   scale-to-zero / fresh-machine data plane.
6. **`--locked`, not `--frozen` for a single-project service** — `--locked` *asserts the lockfile is
   up-to-date* and **fails the build** if `pyproject.toml` drifted from `uv.lock`. That failure is a
   feature: it catches "someone edited deps but forgot to re-lock" at build time, not in production.
7. **Non-root user, `0.0.0.0`, one process per container.** Fly (and any orchestrator) handles
   replication at the machine level; the container runs a single `fastapi run` / `uvicorn` process bound
   to `0.0.0.0:8080`, never `--workers N` inside the image, never `127.0.0.1`.

**Pinned versions referenced (verify against your repo at build time — June 2026):**

| Thing | Version (current) | Source |
|---|---|---|
| `uv` | **0.11.24** (released **2026-06-23**) | [github.com/astral-sh/uv/releases](https://github.com/astral-sh/uv/releases) |
| uv image base used here | `ghcr.io/astral-sh/uv:python3.12-trixie-slim` (Debian 13 "Trixie") | [uv Docker guide — available images](https://docs.astral.sh/uv/guides/integration/docker/#available-images) |
| FastAPI CLI (`fastapi run`) | **`fastapi[standard]` 0.11x** (ships the `fastapi` CLI) | [fastapi.tiangolo.com/deployment/docker](https://fastapi.tiangolo.com/deployment/docker/) |
| Uvicorn | **0.3x** | [fastapi.tiangolo.com/deployment/server-workers](https://fastapi.tiangolo.com/deployment/server-workers/) |
| Python | **3.12** (slim-trixie) — pin the same minor in builder and runtime | [uv-docker-example](https://github.com/astral-sh/uv-docker-example) |
| Fly default `internal_port` | **8080** | [fly.io/docs/reference/configuration](https://fly.io/docs/reference/configuration/) |

---

## Table of contents

1. [Why a custom image at all — and where this image runs (Fly, not Vercel)](#1-why-and-where)
2. [The five-second mental model of the build](#2-mental-model)
3. [Installing uv: `COPY --from` a pinned tag (and the digest-pin upgrade)](#3-installing-uv)
4. [Choosing the base image: `uv:python3.x-trixie-slim` vs `python:3.x-slim` + COPY uv](#4-base-image)
5. [The dependency-layer caching contract (the load-bearing trick)](#5-caching-contract)
6. [`--mount=type=cache` and `UV_LINK_MODE=copy` — why both are needed](#6-cache-mount)
7. [`--locked` vs `--frozen` vs `--no-install-project` — the exact semantics](#7-locked-frozen)
8. [`UV_COMPILE_BYTECODE=1` and the cold-start payoff](#8-bytecode)
9. [The env-var block — every `UV_*` that belongs in the image, annotated](#9-env-vars)
10. [The multi-stage split: builder → slim runtime](#10-multistage)
11. [`.dockerignore` — excluding `.venv` (non-negotiable) and the rest](#11-dockerignore)
12. [Non-root user, `PYTHONUNBUFFERED`, and the runtime ENV](#12-nonroot)
13. [The CMD: `fastapi run` vs `uvicorn` vs `uv run`, `0.0.0.0`, `$PORT`, EXPOSE](#13-cmd)
14. [One process per container — replication is Fly's job, not the image's](#14-one-process)
15. [The full annotated production Dockerfile (single-project FastAPI service)](#15-full-dockerfile)
16. [Variant A — managed Python (standalone), when you don't want the system interpreter](#16-variant-standalone)
17. [Variant B — distroless / smallest possible runtime](#17-variant-distroless)
18. [Variant C — a non-package app (no `[project]` / `src/` layout)](#18-variant-flat)
19. [Variant D — the data-ingest worker image (heavy deps, COPY-based bulk loads)](#19-variant-worker)
20. [Healthcheck, signals, and graceful shutdown (SIGTERM, lifespan)](#20-healthcheck)
21. [Fly.io wiring: `fly.toml`, `internal_port`, `$PORT`, deploy](#21-fly)
22. [Image-size and cold-start numbers — what to expect and how to measure](#22-numbers)
23. [BuildKit, build cache in CI, and `--cache-from`](#23-buildkit-ci)
24. [Anti-patterns quick table](#24-anti-patterns)
25. [Output contract for this recipe](#25-output-contract)
26. [Sources](#26-sources)

---

## 1. Why a custom image at all — and where this image runs (Fly, not Vercel) <a name="1-why-and-where"></a>

The data-analytics product line is a **Python/FastAPI** service that owns: TimescaleDB ingest, the
time-series query API, continuous-aggregate refreshes, and any long-running fetch loops. None of that
fits a serverless function:

- **Heavy/scheduled ingest** (nightly XBRL, COPY-bulk market loads) needs a long-lived process and a
  warm DB pool — the same reason Lumina's `worker/` lives on **Fly.io** and Lumina's non-negotiable #4
  forbids sockets/timers on Vercel.
- **A warm `asyncpg.Pool`** (see `patterns-python-connection-layer.md`) wants a process that stays up
  between requests; cold serverless re-opens the pool every invocation.

So this image is built to ship to **Fly Machines** (or any Docker host / Kubernetes), not to a serverless
platform. That single fact drives most of the choices below: a real long-lived process, a single Uvicorn
worker per machine (Fly scales by adding machines), binding to `0.0.0.0:8080`, and obsessing over
**cold-start** because a fresh Fly machine (scale-to-zero, autoscale-up, or a deploy) pays the image's
import + bytecode-compile cost on its first request.

> **The contract this doc enforces:** the image that reaches Fly is **(a) reproducible** (pinned uv, a
> committed `uv.lock`, `--locked`), **(b) small** (multi-stage, slim base, no uv in the runtime), and
> **(c) fast to cold-start** (bytecode pre-compiled, deps pre-installed, no install at boot).

---

## 2. The five-second mental model of the build <a name="2-mental-model"></a>

```
┌─ builder stage (has uv) ───────────────────────────────────┐
│  1. COPY uv binary in from ghcr.io/astral-sh/uv:0.11.24      │
│  2. bind-mount uv.lock + pyproject.toml (NOT copied → no layer)
│     uv sync --locked --no-install-project   ← deps only      │
│        └── cached layer; survives a code edit                │
│  3. COPY . /app                              ← your source    │
│  4. uv sync --locked                         ← install project
│        └── small, fast, re-runs on every code change          │
│  produces: /app/.venv  (a self-contained virtualenv)          │
└────────────────────────────────────────────────────────────┘
            │  COPY --from=builder /app /app
            ▼
┌─ runtime stage (NO uv) ────────────────────────────────────┐
│  python:3.12-slim-trixie  (must match builder's interpreter) │
│  + non-root user, PATH=/app/.venv/bin, PYTHONUNBUFFERED=1     │
│  CMD: fastapi run --host 0.0.0.0 --port 8080 …               │
└────────────────────────────────────────────────────────────┘
```

Two `uv sync` calls, two bind/cache mounts, two stages. The cleverage is entirely in **ordering** (deps
before code) and **mounts** (cache + bind, not COPY) — that is what makes the rebuild after a one-line
code change take ~2 s instead of re-downloading every wheel.

---

## 3. Installing uv: `COPY --from` a pinned tag (and the digest-pin upgrade) <a name="3-installing-uv"></a>

uv ships as **two static binaries**, `uv` and `uvx`, published inside a set of OCI images on GitHub
Container Registry. The documented, fastest way to get uv into a build is to `COPY` those binaries out of
the registry image — no network install, no Python needed to bootstrap uv:

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/
```

The uv docs are explicit that this is **the** recommended form and that you must pin:

> "it is best practice to pin to a specific uv version, e.g., with:
> `COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/`"
> — [docs.astral.sh/uv/guides/integration/docker — Installing uv](https://docs.astral.sh/uv/guides/integration/docker/#installing-uv)

**Three rules:**

1. **Pin the tag.** `:latest` makes every build a moving target — a uv release between two builds can
   change resolution or flag behavior and your "no-code-change" rebuild silently differs. Pin `0.11.24`
   (the current release, [2026-06-23](https://github.com/astral-sh/uv/releases)).
2. **For maximum reproducibility, pin the digest** (the tag can be re-pushed; a digest cannot):
   ```dockerfile
   COPY --from=ghcr.io/astral-sh/uv@sha256:<digest> /uv /uvx /bin/
   ```
   This is the form the uv docs give for "maximum reproducibility." Resolve the digest with
   `docker buildx imagetools inspect ghcr.io/astral-sh/uv:0.11.24` and commit it.
3. **`COPY` to `/bin/`** (the example uses `/bin/`). The binaries are self-contained; no `PATH` change is
   needed because `/bin` is already on `PATH`.

**Why not the alternatives:**

| Method | Verdict | Why |
|---|---|---|
| `COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/` | ✅ **use this** | Single static binary, no network at install, pinnable to a digest. |
| `pip install uv` | ❌ | Drags pip + a network round-trip + a Python resolve into the build; slower and adds a moving dependency. |
| `curl -LsSf https://astral.sh/uv/install.sh \| sh` | ❌ | Network-dependent at build time, version not pinned unless you also pin the installer URL; defeats reproducibility. |
| Base image `ghcr.io/astral-sh/uv:python3.12-trixie-slim` (uv + Python in one) | ✅ for the **builder** stage | uv is already present; you skip the `COPY --from` line. See §4. Still keep uv out of the **runtime** stage. |

---

## 4. Choosing the base image: `uv:python3.x-trixie-slim` vs `python:3.x-slim` + COPY uv <a name="4-base-image"></a>

There are two equivalent ways to get **both** Python and uv into the builder stage:

**Option 1 — use the uv image that already bundles Python (what the canonical example does):**

```dockerfile
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim AS builder
# uv is already at /usr/local/bin/uv — no COPY --from needed
```

This is exactly the [`astral-sh/uv-docker-example/multistage.Dockerfile`](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile)
builder line. The uv project publishes a matrix of these: `python3.10/3.11/3.12/3.13` × Debian
(`bookworm`/`trixie`, full and `-slim`) and `alpine`. ([uv Docker guide — Available
images](https://docs.astral.sh/uv/guides/integration/docker/#available-images))

**Option 2 — start from the official Python image and copy uv in:**

```dockerfile
FROM python:3.12-slim-trixie AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/
```

This is the form the uv docs show in their multi-stage example. It decouples the Python base (you control
it) from the uv version (pinned by the `COPY --from` tag), which is slightly cleaner when you want to bump
uv and Python independently.

**Recommendation for this product line:** **Option 2** — `FROM python:3.12-slim-trixie` + an explicit
pinned `COPY --from=...uv:0.11.24`. Reasons: (a) the uv version is visible and digest-pinnable on one
line; (b) the *runtime* stage already has to be `python:3.12-slim-trixie` (it cannot be the uv image —
the runtime must not contain uv), so using the same `python:3.12-slim-trixie` for the builder guarantees
the interpreter path matches between stages, which the docs flag as a hard requirement:

> "It is important to use the image that matches the builder, as the path to the Python executable must be
> the same, e.g., using `python:3.11-slim-trixie` will fail."
> — [uv-docker-example/multistage.Dockerfile](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile)

**`trixie` vs `bookworm`:** uv's Debian images moved from Debian 12 "Bookworm" to Debian 13 "Trixie" — use
`trixie-slim` for new builds; it's the current default. ([uv changelog / image
notes](https://github.com/astral-sh/uv/blob/main/CHANGELOG.md))

**`slim` vs `alpine`:** prefer **`slim` (Debian)** over `alpine` for a data service. Alpine uses musl
libc; scientific/database wheels (`numpy`, `pandas`, `pyarrow`, `asyncpg`'s C extension, `psycopg[binary]`)
ship **manylinux** (glibc) wheels — on musl, pip/uv falls back to building from source, which (a) needs a
compiler toolchain in the image and (b) is dramatically slower. Debian-slim gets the prebuilt wheels.
This is a well-known foot-gun for Python data images; `slim-trixie` is the safe default.

---

## 5. The dependency-layer caching contract (the load-bearing trick) <a name="5-caching-contract"></a>

This is the single most important thing in the file. Docker caches layers top-to-bottom and invalidates
**from the first changed instruction down**. So you order instructions **inverse to how often they
change**: things that rarely change go first.

Dependencies (`uv.lock`) change a few times a week; your source changes every commit. Therefore:

```dockerfile
# STEP 1 — install ONLY dependencies, from a bind-mount of the two lock inputs.
#          This layer is invalidated ONLY when uv.lock or pyproject.toml change.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

# STEP 2 — now bring in the source and install the project itself.
#          This layer is invalidated on EVERY code change, but it's cheap:
#          deps are already installed, so it only builds/links your package.
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked
```

The uv docs state the rationale verbatim:

> "`uv sync --no-install-project` will install the dependencies of the project but not the project
> itself. Since the project changes frequently, but its dependencies are generally static, this can be a
> big time saver."
> — [uv Docker guide — Intermediate layers](https://docs.astral.sh/uv/guides/integration/docker/#intermediate-layers)

**Two subtle but critical details:**

1. **`uv.lock` and `pyproject.toml` are `--mount=type=bind`, not `COPY`.** A bind mount makes the file
   available *during that one `RUN`* without adding it to the image layer. If you `COPY uv.lock
   pyproject.toml ./` instead, that COPY becomes a layer — and then any change to *either* file (even a
   version bump in a comment) invalidates the cache exactly the same, but you've also now got those files
   baked into an intermediate layer for no benefit. Bind-mounting is cleaner and is what the canonical
   example does.

2. **The `COPY . /app` between the two syncs is the cache boundary.** Everything above it (the deps
   layer) is reused across builds as long as the lockfile is unchanged. So a one-line edit to a route
   handler re-runs only STEP 2 — install-the-project — which links your already-built dependencies and
   compiles your changed module. On a real service this is the difference between a ~2 s rebuild and a
   30–120 s one.

**Watch the `.dockerignore`** (§11): if `.venv` or `__pycache__` leak into the `COPY . /app`, the source
layer's hash changes on every build (because `.venv` contents differ machine-to-machine) and you lose the
cache you just carefully built.

---

## 6. `--mount=type=cache` and `UV_LINK_MODE=copy` — why both are needed <a name="6-cache-mount"></a>

```dockerfile
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked
```

`--mount=type=cache,target=/root/.cache/uv` mounts a **BuildKit cache volume** at uv's cache directory
(`/root/.cache/uv` by default for root). Unlike a layer, this cache:

- **persists across builds on the same builder** (downloaded wheels, built source dists, the
  package-metadata index), so a fresh build of an unchanged dependency set never re-downloads;
- is **not** part of the produced image (it lives in BuildKit's cache, not in a layer) — so it doesn't
  bloat the shipped image.

This requires **BuildKit** (the default builder in modern Docker / `docker buildx`). With BuildKit off,
`--mount` lines are a syntax error. (Fly's remote builder and GitHub Actions both run BuildKit by
default.)

**`UV_LINK_MODE=copy` is the partner setting.** By default uv tries to **hardlink** packages from its
cache into the target venv to save space. But the cache (the BuildKit volume) and the venv (`/app/.venv`,
a normal layer) are on **different filesystems**, and you cannot hardlink across filesystems — uv emits a
warning and falls back to copy anyway. Setting `UV_LINK_MODE=copy` makes that explicit and silences the
warning:

> "Changing the `UV_LINK_MODE` silences warnings about not being able to link files since the cache and
> sync target are on separate file systems."
> — [uv Docker guide — Caching](https://docs.astral.sh/uv/guides/integration/docker/#caching)

The canonical Dockerfile sets it as a build env:

```dockerfile
# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy
```
— [uv-docker-example/Dockerfile](https://github.com/astral-sh/uv-docker-example/blob/main/Dockerfile)

> **Together:** `--mount=type=cache` gives you a persistent download cache; `UV_LINK_MODE=copy` makes uv
> populate the venv from that cache cleanly. Use both, always, in a Docker build.

---

## 7. `--locked` vs `--frozen` vs `--no-install-project` — the exact semantics <a name="7-locked-frozen"></a>

These three flags decide *whether the build trusts your lockfile and whether it fails on drift*. Get them
right or you ship a non-reproducible image.

| Flag | Exact behavior (uv CLI reference) | Use in image build? |
|---|---|---|
| `--locked` | "Assert that the `uv.lock` will remain unchanged." Errors the build if `uv.lock` is **out of date** vs `pyproject.toml`. (env: `UV_LOCKED`) | ✅ **default for a single-project service.** Build fails loudly if deps drifted from the lock — catches "edited deps, forgot to re-lock." |
| `--frozen` | "Run without updating the `uv.lock` file." Installs strictly from the lock and **does not even check** it against `pyproject.toml`. (env: `UV_FROZEN`) | ✅ for **workspaces** (see below), or when the build context deliberately omits some `pyproject.toml` files. |
| `--no-install-project` | "Do not install the current project." Installs **dependencies only**, leaving your package out. (env: `UV_NO_INSTALL_PROJECT`) | ✅ on the **first** sync (the deps-only layer). |

— flag descriptions quoted from [docs.astral.sh/uv/reference/cli — `uv sync`](https://docs.astral.sh/uv/reference/cli/).

**Why `--locked` and not `--frozen` for a normal service:** `--locked` is a *guarantee*. If a teammate
edits `pyproject.toml` to bump `pandas` but forgets `uv lock`, the `--locked` build **fails** — exactly
where you want the failure, in CI, not silently shipping an old `pandas`. `--frozen` would happily install
the stale lock and hide the drift. The build-time failure is the whole point.

**When `--frozen` is correct — workspaces.** If your project is a **uv workspace** (multiple member
packages), uv "cannot assert that the `uv.lock` file is up-to-date without each of the workspace member
`pyproject.toml` files, so we use `--frozen` instead of `--locked` to skip the check during the initial
sync" — because the deps-only layer bind-mounts only the root lock + `pyproject.toml`, not every member.
([uv Docker guide — Non-editable installs / workspaces](https://docs.astral.sh/uv/guides/integration/docker/#intermediate-layers)).
For this product line, start as a **single project** and use `--locked`; only switch to `--frozen` if you
adopt the workspace layout.

**`--no-install-project` only goes on the FIRST sync.** The second `uv sync --locked` (after `COPY .`)
omits it so the project itself gets installed.

**Optional: `--no-editable`.** By default uv installs the project (and workspace members) as **editable**
(a `.pth` pointing at your source). For a shipped image you often want a **non-editable** install so the
package is materialized into `site-packages` and you don't depend on the source tree staying in place:
`uv sync --locked --no-editable`. ([`--no-editable`: "Install any editable dependencies, including the
project and any workspace members, as non-editable" — uv sync
reference](https://docs.astral.sh/uv/reference/cli/)). The canonical example keeps the default editable
install and copies the whole `/app` (source included) to the runtime, which also works — choose
`--no-editable` if you want to drop the source from the runtime layer.

---

## 8. `UV_COMPILE_BYTECODE=1` and the cold-start payoff <a name="8-bytecode"></a>

```dockerfile
ENV UV_COMPILE_BYTECODE=1
```

> `UV_COMPILE_BYTECODE` — "Equivalent to the `--compile-bytecode` command-line argument. If set, uv will
> compile Python source files to bytecode after installation."
> — [uv environment-variables reference](https://docs.astral.sh/uv/reference/environment/)

**What it does and why it matters for a Fly cold-start.** Python normally compiles each imported `.py`
module to a `.pyc` **on first import** and caches it in `__pycache__`. In a fresh container that
first-import compile happens during your *first request after boot* — every module in FastAPI, Starlette,
Pydantic, SQLAlchemy, asyncpg, numpy, pandas gets compiled the first time it's imported. On a large data
service that's measurable added latency on the first request of a new machine.

`UV_COMPILE_BYTECODE=1` moves that work to **build time**: uv compiles every installed module's bytecode
right after install, so the `.pyc` files are already present in `/app/.venv` when the container boots. The
first request imports compiled bytecode directly. The uv docs frame it exactly this way:

> "you can set the `UV_COMPILE_BYTECODE` environment variable to ensure that all commands within the
> Dockerfile compile bytecode. This is useful for faster startup times (at the cost of increased
> installation time)."
> — [uv Docker guide — Compiling bytecode](https://docs.astral.sh/uv/guides/integration/docker/#compiling-bytecode)

**The trade-off:** the *build* is slower (it compiles everything) and the image is slightly larger (it
now contains the `.pyc` files alongside the `.py`). For a service you build once and cold-start many
times, that trade is strongly worth it — you pay compile cost once in CI instead of on every fresh
machine's first request. Set it as an `ENV` in the **builder** stage (so both `uv sync` calls honor it).

---

## 9. The env-var block — every `UV_*` that belongs in the image, annotated <a name="9-env-vars"></a>

Put these as `ENV` in the **builder** stage so every uv command in the build honors them. Each is quoted
from the [uv environment-variables reference](https://docs.astral.sh/uv/reference/environment/) unless
noted.

```dockerfile
# Compile .py -> .pyc at install time -> faster container cold start.
ENV UV_COMPILE_BYTECODE=1

# Copy packages from the cache instead of hardlinking (cache & venv are on
# different filesystems under --mount=type=cache; silences the link warning).
ENV UV_LINK_MODE=copy

# Don't install dev/test dependency groups into the production image.
ENV UV_NO_DEV=1

# Use the SYSTEM interpreter from the base image; don't let uv download a
# managed Python (so the runtime stage's interpreter matches the builder's).
ENV UV_PYTHON_DOWNLOADS=0
```

| Variable | Set to | Why in a production image |
|---|---|---|
| `UV_COMPILE_BYTECODE` | `1` | Pre-compile bytecode → cold-start win (§8). "compile Python source files to bytecode after installation." |
| `UV_LINK_MODE` | `copy` | Cache & venv on different FS under cache-mount; avoids the hardlink fallback warning (§6). "If set, uv will use this as a link mode." |
| `UV_NO_DEV` | `1` | "If set, uv will exclude development dependencies." Keeps pytest/ruff/mypy out of the shipped image — smaller image, smaller attack surface. (Equivalent to `--no-dev` on each sync.) |
| `UV_PYTHON_DOWNLOADS` | `0` | "Whether uv should allow Python downloads" — disable so uv uses the base image's system Python. The canonical multistage example sets this so the same interpreter path exists in both stages; if you let uv *download* a managed Python it must be copied across stages (see Variant A, §16). |
| `UV_CACHE_DIR` | *(usually unset)* | "uv will use this directory for caching instead of the default." Only set if you mount the cache somewhere other than `/root/.cache/uv` — then point the `--mount` target at the same path. |
| `UV_PROJECT_ENVIRONMENT` | *(usually unset)* | "the path to the directory to use for a project virtual environment." Default `.venv`; override only if you must place the venv outside `/app`. |
| `UV_LOCKED` / `UV_FROZEN` | *(prefer the flag)* | The env equivalents of `--locked`/`--frozen`. Prefer the explicit flag on the `uv sync` line so the build reads self-documentingly, but the env works too. |

> **Note on `UV_NO_DEV` vs `--no-dev`:** setting `UV_NO_DEV=1` makes *both* `uv sync` calls exclude dev
> deps without repeating `--no-dev`. The canonical multistage example does exactly this with `ENV
> UV_NO_DEV=1`. ([uv-docker-example/multistage.Dockerfile](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile))

---

## 10. The multi-stage split: builder → slim runtime <a name="10-multistage"></a>

The build stage has uv + the build cache + dev tooling; the runtime stage has **only** the produced
virtualenv and your source. You move the result across with one `COPY --from`:

```dockerfile
FROM python:3.12-slim-trixie
COPY --from=builder --chown=nonroot:nonroot /app /app
ENV PATH="/app/.venv/bin:$PATH"
```

Three things make this work:

1. **The venv is relocatable *as long as the interpreter path matches*.** A uv/virtualenv venv hardcodes
   the absolute path to the Python interpreter it was built against. That's why the runtime base **must**
   be the same Python minor + same path as the builder (`python:3.12-slim-trixie` ↔
   `python:3.12-slim-trixie`). Mismatch → the venv's `python` symlink points at a non-existent
   interpreter → boot fails. (Quoted requirement in §4.)

2. **`ENV PATH="/app/.venv/bin:$PATH"`** activates the venv without `source activate`. Putting the venv's
   `bin` first on `PATH` means `python`, `fastapi`, `uvicorn`, and your console scripts resolve to the
   venv's copies. This is the documented activation method:
   > "Place executables in the environment at the front of the path: `ENV PATH=\"/app/.venv/bin:$PATH\"`"
   > — [uv Docker guide — Using the environment](https://docs.astral.sh/uv/guides/integration/docker/#using-the-environment)

3. **uv is *not* in the runtime stage.** The runtime base is plain `python:3.12-slim-trixie` (no `COPY
   --from=ghcr.io/astral-sh/uv`). You never run uv at boot; you run the already-installed app. This is
   what keeps the runtime image small and is the entire point of the multi-stage split.

> **Do not run `uv sync` or `uv run` in the runtime CMD on a service you want to cold-start fast.** `uv
> run` re-checks the environment on every invocation. The dev `Dockerfile` uses `CMD ["uv", "run",
> "fastapi", "dev", …]` *deliberately* to re-sync for hot-reload — that is a **dev** convenience. The
> **production** `multistage.Dockerfile` ships `CMD ["fastapi", "run", …]` with no uv at all. See §13.

---

## 11. `.dockerignore` — excluding `.venv` (non-negotiable) and the rest <a name="11-dockerignore"></a>

The uv docs call this out specifically:

> "It is best practice to add `.venv` to a `.dockerignore` file in your repository to prevent it from
> being included in image builds."
> — [uv Docker guide — Caching / `.dockerignore`](https://docs.astral.sh/uv/guides/integration/docker/#caching)

**Why `.venv` *must* be ignored:** your local `.venv` is built for **your** OS/arch and absolute path. If
`COPY . /app` drags it in, you either (a) overwrite the freshly-built in-container `.venv` with a broken
host one, or at minimum (b) change the `COPY` layer's hash on every build (host venv contents differ), so
you lose the layer cache from §5. Ignoring it is non-negotiable.

A complete `.dockerignore` for a Python/FastAPI data service:

```gitignore
# --- the non-negotiable one (uv docs) ---
.venv/
venv/
ENV/

# --- Python build/cache cruft ---
__pycache__/
*.py[cod]
*.egg-info/
.eggs/
build/
dist/
*.so

# --- test / lint / type caches (never needed in the image) ---
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
htmlcov/
.tox/
.hypothesis/

# --- VCS, IDE, OS ---
.git/
.gitignore
.github/
.idea/
.vscode/
.DS_Store

# --- secrets & local config (NEVER ship into an image) ---
.env
.env.*
*.pem
*.key

# --- docs / dev-only ---
README.md
docs/
notebooks/
*.ipynb
.claude/

# --- the Dockerfile itself & compose (not needed inside the image) ---
Dockerfile
docker-compose*.yml
.dockerignore
```

> **Security note (mirrors Lumina's `.env` discipline):** `.env`, `*.pem`, `*.key` in `.dockerignore`
> means a secret never gets baked into a layer. Secrets reach the running container via Fly secrets
> (`fly secrets set`) → environment at runtime, never via `COPY`. A secret in an image layer is
> permanent and extractable even if a later layer deletes it.

---

## 12. Non-root user, `PYTHONUNBUFFERED`, and the runtime ENV <a name="12-nonroot"></a>

**Non-root user.** Run the app as an unprivileged user. The canonical multistage example creates a system
`nonroot` user/group with fixed uid/gid and `--chown`s the copied app to it:

```dockerfile
# Setup a non-root user
RUN groupadd --system --gid 999 nonroot \
 && useradd --system --gid 999 --uid 999 --create-home nonroot

COPY --from=builder --chown=nonroot:nonroot /app /app
...
USER nonroot
```
— [uv-docker-example/multistage.Dockerfile](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile)

Why: a container escape from a root process is far worse than from uid 999. Fixed `--gid 999 --uid 999`
keeps file ownership stable across rebuilds. `--system` makes it a system account (no login, no password
aging). `USER nonroot` must come **after** all the `apt-get install` / `COPY` that need root, and
**before** the `CMD`.

**`PYTHONUNBUFFERED=1`.** Set in both stages (or at least the runtime). The canonical example:

```dockerfile
# Keeps Python from buffering stdout and stderr to avoid situations where
# the application crashes without emitting any logs due to buffering.
ENV PYTHONUNBUFFERED=1
```

Without it, Python buffers stdout/stderr; a container that crashes can do so **before** flushing its logs,
so you see nothing in `fly logs` and debug blind. With `=1`, every log line is written immediately. This
is mandatory for any containerized service.

**Other runtime ENV worth setting:**

```dockerfile
ENV PYTHONDONTWRITEBYTECODE=1   # don't write .pyc at runtime (we pre-compiled in build);
                                #   keeps the read-only-ish runtime FS clean
ENV PYTHONFAULTHANDLER=1        # dump a Python traceback on a fatal signal (segfault) -> debuggable
```

> `PYTHONDONTWRITEBYTECODE=1` and `UV_COMPILE_BYTECODE=1` are *complementary*: the latter writes `.pyc`
> at **build** time (good), the former stops the **runtime** from re-writing them (the runtime FS is the
> non-root user's, and you've already compiled). Don't confuse them.

---

## 13. The CMD: `fastapi run` vs `uvicorn` vs `uv run`, `0.0.0.0`, `$PORT`, EXPOSE <a name="13-cmd"></a>

### 13.1 — `fastapi run` is FastAPI's official production entrypoint

FastAPI's deployment docs recommend the `fastapi` CLI's `run` command (which wraps Uvicorn) over invoking
`uvicorn` directly:

> "FastAPI's official documentation recommends using `fastapi run`."
> Example: `CMD ["fastapi", "run", "app/main.py", "--port", "80"]`
> — [fastapi.tiangolo.com/deployment/docker](https://fastapi.tiangolo.com/deployment/docker/)

For this service, binding to `0.0.0.0` and Fly's default `8080`:

```dockerfile
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "src/jpm_data_service/main.py"]
```

The canonical uv multistage example uses the package-path form (no explicit port, defaults to 8000):

```dockerfile
CMD ["fastapi", "run", "--host", "0.0.0.0", "src/uv_docker_example"]
```
— [uv-docker-example/multistage.Dockerfile](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile)

### 13.2 — Use the EXEC form (JSON array), never the shell form

```dockerfile
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "src/jpm_data_service/main.py"]   # ✅ exec form
# CMD fastapi run --host 0.0.0.0 src/jpm_data_service/main.py                                    # ❌ shell form
```

FastAPI's docs are explicit:

> "Always use the exec form ... The exec form ensures FastAPI can shutdown gracefully and trigger lifespan
> events." — [fastapi.tiangolo.com/deployment/docker](https://fastapi.tiangolo.com/deployment/docker/)

In shell form, the process runs as a child of `/bin/sh -c`, which **does not forward SIGTERM** to your
app — so Fly's "send SIGTERM, then SIGKILL after the grace period" shutdown never reaches Uvicorn, your
lifespan `shutdown` never runs, in-flight requests are dropped, and the DB pool isn't closed cleanly.
Exec form makes your process PID 1 and gives it the signal directly (see §20).

### 13.3 — `0.0.0.0` is mandatory on Fly

> "Your app must listen on `0.0.0.0` (not `localhost`, not `127.0.0.1`) on the port specified by
> `internal_port` in your `fly.toml`." — [fly.io/docs (deployment guidance)](https://fly.io/docs/languages-and-frameworks/dockerfile/)

`127.0.0.1` binds only the loopback inside the container; Fly's proxy connects from outside the container
namespace and cannot reach it → health checks fail, the deploy is marked unhealthy. Always `--host
0.0.0.0`.

### 13.4 — Port: literal `8080` vs `$PORT`

Two valid approaches:

**(a) Pin the port literally to Fly's default and match `fly.toml`** (recommended — simplest, and JSON
exec form can't expand `$PORT` anyway):

```dockerfile
EXPOSE 8080
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "src/jpm_data_service/main.py"]
```

with `fly.toml` `[http_service] internal_port = 8080`.

**(b) Honor a runtime `$PORT` env var** (needed if a platform injects the port). The exec form **cannot**
expand `$PORT` (no shell), so either use a tiny shell-form wrapper *or* let FastAPI read it. The cleanest
exec-form-compatible way is to set `PORT` in `fly.toml`/`fly secrets` and read it in your app's entry, or
use a `["sh","-c", …]` wrapper:

```dockerfile
# only if you truly need $PORT expansion — note this re-introduces the shell,
# so add an explicit signal-forwarding shim or use exec inside:
CMD ["sh", "-c", "exec fastapi run --host 0.0.0.0 --port ${PORT:-8080} src/jpm_data_service/main.py"]
```

The `exec` keyword inside the `sh -c` **replaces** the shell with Uvicorn so SIGTERM is forwarded — that
recovers the graceful-shutdown property the exec form gives for free. **Prefer approach (a)** unless a
platform forces `$PORT` on you; Fly does not (it lets you pin `internal_port`).

### 13.5 — `uvicorn` directly (if you don't want the FastAPI CLI)

Equivalent, if you'd rather not depend on `fastapi[standard]`:

```dockerfile
CMD ["uvicorn", "jpm_data_service.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

`fastapi run` ultimately *is* Uvicorn with sensible production defaults (it picks `uvloop`/`httptools`
when available). Use `fastapi run` for the better defaults and the graceful-shutdown wiring; use `uvicorn`
directly if you want explicit control or a leaner dependency set.

### 13.6 — Never `uv run` in production CMD

The dev `Dockerfile` ships `CMD ["uv", "run", "fastapi", "dev", …]` and its own comment says so:

> "Note in production, you should use `fastapi run` instead."
> — [uv-docker-example/Dockerfile](https://github.com/astral-sh/uv-docker-example/blob/main/Dockerfile)

`uv run` re-validates/syncs the environment on every start (adding boot latency) and pulls uv into the
runtime. Production ships `fastapi run`/`uvicorn` against the pre-built `.venv` on `PATH`.

### 13.7 — `EXPOSE` is documentation (and a Fly hint)

`EXPOSE 8080` does not publish a port — it's metadata. FastAPI's example Dockerfile doesn't even include
it. But on Fly, `EXPOSE` is used as a **hint** by `fly launch` to set `internal_port` when it scaffolds
`fly.toml`. Include `EXPOSE 8080` for that convenience and as documentation of the listen port. The
actual contract is `--port` (what the app binds) ↔ `internal_port` (what Fly routes to) — those two
numbers must match.

---

## 14. One process per container — replication is Fly's job, not the image's <a name="14-one-process"></a>

Do **not** put `--workers N` in the production CMD for an orchestrated deploy. FastAPI's docs:

> "you probably would want to have a single (Uvicorn) process per container, as you would already be
> handling replication at the cluster level."
> — [fastapi.tiangolo.com/deployment/docker](https://fastapi.tiangolo.com/deployment/docker/)

On Fly you scale by **adding machines** (`fly scale count N`, or autoscaling), each running one container
with one Uvicorn process. Reasons one-process-per-machine beats `--workers N`-in-one-container:

- **Independent health & restart.** Fly health-checks and restarts a *machine*; a crashed worker inside a
  multi-worker container is invisible to the orchestrator.
- **Clean horizontal scale + metrics.** CPU/memory per machine maps 1:1 to one process; with N workers in
  one box the numbers blur.
- **The GIL anyway.** A single Python process is single-threaded for CPU under the GIL; the way to use
  more cores is more processes — and Fly gives you more *machines*, each a process, which is the same
  parallelism with better isolation.

**When `--workers` is right:** a single bare VM running one container that must use all cores and you are
*not* running a cluster/orchestrator. That's not this deployment. For Fly, one process per machine; let
Fly do the replication.

> **Mirrors Lumina's worker model:** Lumina's `worker/` is one Fly process holding the WebSocket fan-out;
> it scales by Fly, not by forking workers inside the image. Same discipline here.

---

## 15. The full annotated production Dockerfile (single-project FastAPI service) <a name="15-full-dockerfile"></a>

This is the canonical recipe for this product line — a `src/`-layout FastAPI service that ships to Fly. It
is the [`astral-sh/uv-docker-example/multistage.Dockerfile`](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile)
with the uv version pinned, the port set to Fly's `8080`, and every line annotated.

```dockerfile
# syntax=docker/dockerfile:1.7
# ^ pin the Dockerfile frontend so --mount=type=cache/bind syntax is guaranteed available.

# =============================================================================
# STAGE 1 — builder: has uv, builds the virtualenv, then is thrown away.
# =============================================================================
FROM python:3.12-slim-trixie AS builder

# Bring uv in as a static binary from a PINNED registry image (not :latest).
# For maximum reproducibility, replace the tag with an @sha256:<digest> pin.
COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/

# --- uv build-time behavior (all from the uv env-var reference) ------------
# Pre-compile .py -> .pyc at install time => faster container COLD START.
ENV UV_COMPILE_BYTECODE=1
# Copy from the cache instead of hardlinking (cache & venv are on different
# filesystems under --mount=type=cache); silences the link-mode warning.
ENV UV_LINK_MODE=copy
# Exclude dev/test dependency groups from the production image.
ENV UV_NO_DEV=1
# Use the base image's SYSTEM Python; do NOT download a managed interpreter,
# so the runtime stage's interpreter path matches exactly.
ENV UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# --- STEP 1: install ONLY dependencies (the rarely-changing layer) ----------
# uv.lock and pyproject.toml are BIND-mounted (not COPYed) so they don't become
# a layer; the --mount=type=cache persists uv's download cache across builds.
# This layer is invalidated ONLY when uv.lock or pyproject.toml change.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

# --- STEP 2: copy the source and install the PROJECT itself -----------------
# This layer rebuilds on every code change, but it's cheap: deps are already
# present, so uv only installs your package (and compiles its bytecode).
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked

# =============================================================================
# STAGE 2 — runtime: NO uv, just the venv + source. Small and fast to boot.
# =============================================================================
FROM python:3.12-slim-trixie

# IMPORTANT: must be the SAME image as the builder. The venv hardcodes the
# absolute interpreter path; python:3.11-slim-trixie here would fail to boot.

# Run as an unprivileged, fixed-uid system user.
RUN groupadd --system --gid 999 nonroot \
 && useradd  --system --gid 999 --uid 999 --create-home nonroot

# Copy the built application (incl. /app/.venv) from the builder, owned by nonroot.
COPY --from=builder --chown=nonroot:nonroot /app /app

# Activate the venv by putting it first on PATH (no `source activate` needed).
ENV PATH="/app/.venv/bin:$PATH"

# Unbuffered stdout/stderr so logs flush even if the app crashes (visible in `fly logs`).
ENV PYTHONUNBUFFERED=1
# Don't re-write .pyc at runtime; we already compiled bytecode at build time.
ENV PYTHONDONTWRITEBYTECODE=1
# Dump a Python traceback on a fatal signal (segfault) for debuggability.
ENV PYTHONFAULTHANDLER=1

USER nonroot
WORKDIR /app

# Document the listen port (also a hint to `fly launch` for internal_port).
EXPOSE 8080

# Single Uvicorn process, bound to 0.0.0.0 on Fly's default internal_port.
# EXEC form (JSON array) => the process is PID 1 and receives SIGTERM directly
# => graceful shutdown + FastAPI lifespan events fire on `fly deploy`/restart.
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "src/jpm_data_service/main.py"]
```

**Line-by-line invalidation map (what triggers a rebuild of what):**

| Edit you make | Layers that rebuild |
|---|---|
| Edit a route handler / any `.py` under `src/` | only STEP 2 (`COPY . /app` + `uv sync --locked`) and below — fast |
| Add/bump a dependency (`pyproject.toml` + `uv lock`) | STEP 1 (deps) and everything below — slow, but rare |
| Bump uv version (`:0.11.24` → `:0.11.25`) | the `COPY --from` line and below |
| Bump Python (`3.12` → `3.13` in **both** stages) | everything |

---

## 16. Variant A — managed Python (standalone), when you don't want the system interpreter <a name="16-variant-standalone"></a>

If you'd rather **not** rely on the base image's Python (e.g. you want a specific patch version uv
manages, or a `python:*-slim` doesn't ship the minor you need), let uv **download** a standalone Python
and copy it across stages. This is the uv project's
[`standalone.Dockerfile`](https://github.com/astral-sh/uv-docker-example/blob/main/standalone.Dockerfile)
shape. The key difference: `UV_PYTHON_DOWNLOADS` is **enabled** in the builder, and you must copy both the
managed Python *and* the venv into the runtime, because the runtime image has no system Python at all.

```dockerfile
FROM debian:trixie-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1
# Pin the managed Python explicitly; uv will DOWNLOAD it (downloads enabled).
ENV UV_PYTHON_INSTALL_DIR=/python
ENV UV_PYTHON=python3.12
# (UV_PYTHON_DOWNLOADS is left at its default 'automatic' — uv may fetch Python)

WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked

# Runtime has NO system Python; copy BOTH the managed interpreter and the venv.
FROM debian:trixie-slim
RUN groupadd --system --gid 999 nonroot \
 && useradd  --system --gid 999 --uid 999 --create-home nonroot
COPY --from=builder --chown=nonroot:nonroot /python /python
COPY --from=builder --chown=nonroot:nonroot /app /app
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
USER nonroot
WORKDIR /app
EXPOSE 8080
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "src/jpm_data_service/main.py"]
```

**When to use:** you need a specific CPython patch version, or you want a `debian:trixie-slim` base
(without the `python:` image's pre-installed interpreter) for full control. **Default to the system-Python
recipe in §15** — it's simpler and one fewer thing to copy. The uv docs cover both:
[Using the system Python vs a managed Python](https://docs.astral.sh/uv/guides/integration/docker/#installing-a-project).

---

## 17. Variant B — distroless / smallest possible runtime <a name="17-variant-distroless"></a>

For the smallest, most-hardened runtime, copy the venv (and the managed Python from Variant A) onto a
**distroless** base — an image with no shell, no package manager, almost nothing but libc and the runtime
you put there.

```dockerfile
# ... builder stage identical to Variant A (managed Python into /python) ...

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /python /python
COPY --from=builder /app /app
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
# distroless 'nonroot' tag runs as uid 65532; or use the :nonroot variant image.
USER 65532
WORKDIR /app
EXPOSE 8080
# distroless has no shell, so EXEC form is mandatory (it already is).
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "src/jpm_data_service/main.py"]
```

**Trade-offs of distroless:**

| Pro | Con |
|---|---|
| Smallest image, smallest attack surface (no shell, no apt) | No `sh` → you cannot `fly ssh console` into a shell to debug; no `curl`/`wget` for HTTP healthchecks (must use an exec/TCP check) |
| No package manager to exploit | Harder to add a runtime native lib (`libpq`, etc.) — must `COPY` it from the builder |
| `:nonroot` variant runs unprivileged by default | A native-dependency mistake surfaces only at runtime, with no shell to investigate |

**Recommendation:** start with the **slim** runtime (§15) — it has a shell for `fly ssh console`
debugging, which you will want early in a greenfield service. Move to **distroless** only once the image
is stable and you're optimizing size/hardening for production. uv documents the distroless path:
[uv Docker guide — distroless final image](https://docs.astral.sh/uv/guides/integration/docker/).

---

## 18. Variant C — a non-package app (no `[project]` / `src/` layout) <a name="18-variant-flat"></a>

If your app is **not** structured as an installable package (no `[project]` table, just `main.py` +
modules at the repo root), `uv sync` still installs the dependencies but there's no project to "install."
Two adjustments:

1. Add `--no-install-project` to **both** syncs (there is nothing to install as a project), **or** keep
   the project table and use the `src/` layout from §15 (preferred — it's cleaner and `fastapi run
   pkg` works).
2. Point the CMD at the module file path rather than a package:

```dockerfile
# both syncs are deps-only for a flat (non-package) app:
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project
COPY . /app
# no second project-install sync needed for a flat app
...
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8080", "main.py"]
```

**Recommendation:** **use the package + `src/` layout** (§15) for a real service. It makes the install
reproducible, gives you a clean import root, avoids `sys.path` surprises, and lets `fastapi run
your_pkg` work. Reserve the flat layout for a throwaway.

---

## 19. Variant D — the data-ingest worker image (heavy deps, COPY-based bulk loads) <a name="19-variant-worker"></a>

The data plane has two kinds of process from one repo: the **API** (serves the time-series query routes)
and the **ingest worker** (nightly/streaming loads into TimescaleDB via `COPY`, continuous-aggregate
refreshes — see `patterns-ingestion-upsert.md` and `theory-continuous-aggregates.md`). They share the
same `pyproject.toml`/`uv.lock`, so they should share the **same builder stage** and differ only in the
final CMD and (optionally) the dependency groups installed.

Two clean approaches:

**(a) One image, two CMDs (chosen at deploy via Fly process groups).** Build one image (§15); Fly's
`[processes]` table runs different commands from the same image:

```toml
# fly.toml
[processes]
  api    = "fastapi run --host 0.0.0.0 --port 8080 src/jpm_data_service/main.py"
  worker = "python -m jpm_data_service.ingest.run"
```

Then the Dockerfile's `CMD` is just the default (api), and `fly deploy` runs both process groups from one
image. This is the recommended pattern — one build, one image, two roles — and mirrors how Lumina keeps
the worker alongside the app.

**(b) Two final stages, one builder.** If the worker needs **heavy extra deps** (e.g. `pyarrow`,
`scikit-learn`) the API doesn't, split them into a uv dependency **group** and install the right group per
target image:

```dockerfile
# builder installs the FULL set once (cached):
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --group worker   # include the worker group
```

`--group worker` is the documented way to pull in a named dependency group ("Include dependencies from the
specified dependency group." — [uv sync reference](https://docs.astral.sh/uv/reference/cli/)). For the API
image, omit `--group worker` (or use `--no-default-groups` + only the groups you need) so the API stays
lean.

**Recommendation:** start with **(a) one image + Fly process groups** — simplest, fewest images to keep in
sync. Split images only when the worker's deps materially bloat the API image's size/attack surface.

---

## 20. Healthcheck, signals, and graceful shutdown (SIGTERM, lifespan) <a name="20-healthcheck"></a>

**Signals — the exec-form payoff (recap from §13.2).** When Fly redeploys or stops a machine it sends
**SIGTERM**, waits a grace period, then **SIGKILL**. For your app to shut down cleanly (finish in-flight
requests, run the FastAPI `lifespan` shutdown, close the `asyncpg.Pool`), SIGTERM must reach *your
process*. The JSON **exec form** makes your process PID 1 so it gets the signal directly. The **shell
form** inserts `/bin/sh -c` as PID 1, which by default does **not** forward SIGTERM → your app is
SIGKILLed → no graceful shutdown, dropped connections, leaked DB connections. This is why FastAPI's docs
mandate exec form (§13.2) and why the `sh -c` escape hatch in §13.4 uses `exec` to replace the shell.

**FastAPI lifespan does the cleanup.** Pair the SIGTERM-reaches-PID-1 guarantee with a lifespan that
opens/closes the pool:

```python
# src/jpm_data_service/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
import asyncpg, os

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(dsn=os.environ["DATABASE_URL"], min_size=2, max_size=10)
    try:
        yield
    finally:
        await app.state.pool.close()   # runs on SIGTERM thanks to exec-form CMD

app = FastAPI(lifespan=lifespan)

@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
```

**HEALTHCHECK / Fly checks.** Two options:

- **Fly-native check (preferred)** — define it in `fly.toml`, not the Dockerfile, so Fly's proxy probes
  it and gates the deploy:
  ```toml
  [[http_service.checks]]
    method   = "GET"
    path     = "/healthz"
    interval = "10s"
    timeout  = "2s"
    grace_period = "5s"
  ```
- **Dockerfile `HEALTHCHECK`** — works for plain Docker hosts but needs a tool to probe with. On a
  **slim** image you have `python` but maybe not `curl`; use a Python one-liner so you don't add a curl
  dependency:
  ```dockerfile
  HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz').status==200 else 1)"
  ```
  On **distroless** (no shell, maybe no full stdlib networking) prefer the Fly-native TCP/HTTP check
  instead — distroless can't run a `HEALTHCHECK` shell command.

> **Use the Fly-native check for the deploy gate** (it controls rolling-deploy health), and treat the
> Dockerfile `HEALTHCHECK` as a portability nicety for non-Fly hosts.

---

## 21. Fly.io wiring: `fly.toml`, `internal_port`, `$PORT`, deploy <a name="21-fly"></a>

The image from §15 deploys to Fly with a `fly.toml` whose `internal_port` matches the `--port` your CMD
binds. Minimal config:

```toml
# fly.toml
app            = "jpm-data-service"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port       = 8080          # MUST equal the --port in the CMD and the EXPOSE
  force_https         = true
  auto_stop_machines  = "stop"        # scale to zero when idle (cold-start matters! see §22)
  auto_start_machines = true
  min_machines_running = 0            # set >=1 to keep a warm machine and avoid cold starts

  [[http_service.checks]]
    method = "GET"
    path   = "/healthz"
    interval = "10s"
    timeout  = "2s"
    grace_period = "5s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"                     # raise for pandas/numpy-heavy ingest

[processes]
  api    = "fastapi run --host 0.0.0.0 --port 8080 src/jpm_data_service/main.py"
  # worker = "python -m jpm_data_service.ingest.run"   # uncomment for Variant D
```

Key facts (from [fly.io/docs/reference/configuration](https://fly.io/docs/reference/configuration/) and
the [Dockerfile deploy guide](https://fly.io/docs/languages-and-frameworks/dockerfile/)):

- **`internal_port` default is 8080**; it must equal what your app binds (`--port 8080`) and the app must
  bind `0.0.0.0`. Mismatch = failed health checks = the deploy never goes healthy.
- **`EXPOSE 8080` in the Dockerfile** is what `fly launch` reads to *guess* `internal_port` when
  scaffolding — keep them consistent.
- **Secrets** (`DATABASE_URL`, API keys) go via `fly secrets set DATABASE_URL=...` → injected as env at
  runtime. Never `COPY` a `.env` (it's in `.dockerignore`, §11) and never bake a secret in a layer.
- **`auto_stop_machines = "stop"` + `min_machines_running = 0`** = **scale to zero**. Cheap, but the next
  request cold-starts a machine — that's exactly why `UV_COMPILE_BYTECODE=1` (§8) earns its keep. If you
  cannot tolerate the cold-start, set `min_machines_running = 1` to keep one warm.
- **Deploy:** `fly deploy` builds (on Fly's remote BuildKit builder by default, so `--mount=type=cache`
  works) and rolls the machines. Use `fly deploy --local-only` to build with your local Docker.

> **Why the cold-start obsession is real here:** a scale-to-zero Fly app pays, on the first request after
> idle, the full **container boot + Python import + (without bytecode pre-compile) module compile**. The
> image choices in this doc — slim base, pre-installed deps, pre-compiled bytecode — are precisely the
> levers that shrink that first-request latency.

---

## 22. Image-size and cold-start numbers — what to expect and how to measure <a name="22-numbers"></a>

**Image size — rough, measure your own.** Sizes depend entirely on your dependency set; the structural
deltas are what's reliable:

| Layer / choice | Approx contribution | Note |
|---|---|---|
| `python:3.12-slim-trixie` runtime base | ~120–150 MB | the floor; `slim` not full `python:3.12` (~1 GB) |
| FastAPI + Uvicorn + Pydantic + Starlette | ~30–50 MB | the web stack |
| `asyncpg` (+ `psycopg[binary]` if used) | ~10–30 MB | DB drivers |
| `pandas` + `numpy` + `pyarrow` (if present) | **~200–400 MB** | the dominant cost for a data service — this is why you must split worker-only heavy deps (Variant D) |
| Pre-compiled `.pyc` (`UV_COMPILE_BYTECODE=1`) | a few % over the `.py` size | the cold-start trade |
| **uv NOT in runtime** (multi-stage) | **−~30 MB saved** | the multi-stage payoff |
| dev deps NOT in runtime (`UV_NO_DEV=1`) | −(pytest+ruff+mypy+...) | typically tens of MB |

**The structural wins, in order of impact:** (1) `slim` not full Python (saves ~800 MB); (2) split heavy
data deps out of the API image (Variant D, can halve the API image); (3) multi-stage drops uv + build
cache from the runtime; (4) `UV_NO_DEV` drops the test/lint toolchain.

**Measure size:**
```bash
docker build -t jpm-data-service:test .
docker images jpm-data-service:test                 # see the size
docker history jpm-data-service:test --no-trunc     # which layer costs what
# or use `dive jpm-data-service:test` for an interactive layer/waste breakdown
```

**Cold-start — what `UV_COMPILE_BYTECODE=1` buys.** The first request to a fresh container imports the
whole dependency tree. With bytecode pre-compiled, those imports read `.pyc` directly; without it, each
module compiles on first import during that request. The magnitude scales with how much code you import
(FastAPI + Pydantic + SQLAlchemy + pandas is a lot of modules), so it's most worth it for a heavy data
service. The uv docs state the trade plainly: faster startup at the cost of longer install/build (§8).

**Measure cold-start:**
```bash
# time from container start to first successful /healthz
docker run --rm -p 8080:8080 jpm-data-service:test &
time bash -c 'until curl -sf localhost:8080/healthz >/dev/null; do sleep 0.05; done'
```
Run it twice — with and without `UV_COMPILE_BYTECODE=1` in the builder — to get *your* delta. Don't quote
a generic percentage; measure the real number on your dependency set (per cto-rules: "improves perf by N%"
with no harness is a hallucinated metric).

---

## 23. BuildKit, build cache in CI, and `--cache-from` <a name="23-buildkit-ci"></a>

**BuildKit is required** for `--mount=type=cache` / `--mount=type=bind`. It's the default in modern Docker
and in `docker buildx`. Force it locally if needed: `DOCKER_BUILDKIT=1 docker build .`. Add the frontend
pin so the syntax is guaranteed:

```dockerfile
# syntax=docker/dockerfile:1.7
```

**The cache-mount caveat in ephemeral CI.** The `--mount=type=cache` volume lives on the *builder host*.
On an ephemeral CI runner (a fresh GitHub Actions VM each run), that cache is empty every time — so the
in-build uv cache helps only within a single build, not across CI runs. To persist across CI runs, export
the **layer** cache:

```bash
# GitHub Actions with buildx — persist layers between runs:
docker buildx build \
  --cache-from type=gha \
  --cache-to   type=gha,mode=max \
  -t jpm-data-service:ci .
```

This makes the carefully-ordered layers (§5) — especially the deps layer — survive across CI runs, so a
code-only PR reuses the cached dependency layer and builds in seconds. (`type=registry` is the
alternative: push/pull the cache to a registry.)

**On Fly's remote builder** (`fly deploy` default), the builder is a persistent Fly Machine, so the
`--mount=type=cache` *does* persist between your deploys — another reason to prefer the remote builder for
day-to-day deploys.

---

## 24. Anti-patterns quick table <a name="24-anti-patterns"></a>

| ❌ Anti-pattern | ✅ Fix | Why |
|---|---|---|
| `COPY --from=ghcr.io/astral-sh/uv:latest` | Pin: `uv:0.11.24` (or `@sha256:` digest) | `:latest` makes "no-change" rebuilds non-reproducible (§3). |
| `pip install uv` / `curl … install.sh \| sh` in the build | `COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/` | Single static binary, no network at install, pinnable (§3). |
| `COPY uv.lock pyproject.toml ./` then `uv sync` | `--mount=type=bind,source=uv.lock,...` | Bind-mount keeps the lock out of a layer; same cache behavior, cleaner (§5). |
| One `uv sync` after `COPY . /app` | Two syncs: deps (`--no-install-project`) then project | Splitting puts deps above code so a code edit reuses the deps layer (§5). |
| No `--mount=type=cache,target=/root/.cache/uv` | Add the cache mount to every `uv sync` | Re-downloads every wheel on each build (§6). |
| `uv sync` without `UV_LINK_MODE=copy` | `ENV UV_LINK_MODE=copy` | Cache & venv on different FS → hardlink fails & warns; copy is correct (§6). |
| `uv sync` (no `--locked`) | `uv sync --locked` | `--locked` fails the build on lock drift — catches "forgot to re-lock" (§7). |
| `--frozen` on a single-project service | `--locked` | `--frozen` hides lock/`pyproject` drift; `--locked` asserts it (§7). |
| No `UV_COMPILE_BYTECODE=1` | `ENV UV_COMPILE_BYTECODE=1` in the builder | First request of every fresh machine pays the bytecode-compile cost (§8). |
| `.venv` committed / not in `.dockerignore` | `.venv/` in `.dockerignore` | A host venv leaks in, breaks the in-container venv & busts the cache (§11). |
| `.env` / `*.pem` reachable by `COPY .` | List them in `.dockerignore`; use `fly secrets` | A secret baked in a layer is permanent and extractable (§11). |
| uv present in the **runtime** image | Multi-stage; runtime base = plain `python:*-slim`, no uv | Ships the build tool you never run at runtime; bigger image (§10). |
| Builder `3.12`, runtime `3.11` | Same `python:3.12-slim-trixie` in both stages | venv hardcodes the interpreter path; mismatch fails to boot (§4, §10). |
| `alpine` base for a pandas/numpy service | `slim-trixie` (Debian/glibc) | musl → no manylinux wheels → builds from source, slow & needs a toolchain (§4). |
| `CMD uv run fastapi dev …` in production | `CMD ["fastapi","run","--host","0.0.0.0","--port","8080",...]` | `uv run`/`dev` re-syncs at boot & pulls uv into runtime; the example's own comment says use `run` in prod (§13). |
| Shell-form CMD (`CMD fastapi run …`) | Exec form (JSON array) | Shell form doesn't forward SIGTERM → no graceful shutdown / lifespan (§13, §20). |
| `--host 127.0.0.1` / `localhost` | `--host 0.0.0.0` | Fly's proxy can't reach loopback inside the container → unhealthy (§13). |
| `--workers 4` baked into the image | One process per container; scale via Fly machines | Orchestrator can't see a dead in-container worker; blurs metrics (§14). |
| Running as root | `USER nonroot` (fixed uid/gid 999) after installs | A container escape from root is far worse than from uid 999 (§12). |
| No `PYTHONUNBUFFERED=1` | Set it in the runtime | Crash-before-flush hides the logs you need to debug (§12). |

---

## 25. Output contract for this recipe <a name="25-output-contract"></a>

A Dockerfile for this product line is **done** only when:

1. **uv is installed by a PINNED `COPY --from`** — `ghcr.io/astral-sh/uv:0.11.24` (or an `@sha256:`
   digest), never `:latest`, never `pip install uv`.
2. **It is multi-stage** — a builder that has uv and a runtime (`python:*-slim-trixie`, **same minor as
   the builder**) that does **not**.
3. **Dependencies are installed before the project**, in two syncs: `uv sync --locked
   --no-install-project` (deps, from a **bind-mount** of `uv.lock`+`pyproject.toml`) → `COPY . /app` →
   `uv sync --locked`.
4. **Both syncs use `--mount=type=cache,target=/root/.cache/uv`** and the build sets **`UV_LINK_MODE=copy`**.
5. **`UV_COMPILE_BYTECODE=1`** is set in the builder (cold-start), and **`--locked`** (not `--frozen`,
   unless it's a workspace) guards the lock.
6. **`UV_NO_DEV=1`** (no dev deps in the image) and **`UV_PYTHON_DOWNLOADS=0`** (system interpreter, paths
   match) are set — or, for the managed-Python variant, the interpreter is copied across stages.
7. **`.dockerignore` excludes `.venv`** (and `.env`/secrets/caches/VCS).
8. **The runtime activates the venv via `ENV PATH="/app/.venv/bin:$PATH"`**, runs as a **non-root** user,
   and sets **`PYTHONUNBUFFERED=1`**.
9. **The CMD is exec-form**, runs **one** Uvicorn process via **`fastapi run`** (or `uvicorn`) bound to
   **`0.0.0.0`** on the port that **matches Fly's `internal_port` (8080)**, with **no `--workers`** and
   **no `uv run`/`fastapi dev`**.
10. **A `/healthz` route exists**, the lifespan closes the DB pool on shutdown, and a Fly health check
    gates the deploy. Image size and cold-start are **measured** (not asserted) for the actual dependency
    set.

Any item missing means the image is either non-reproducible, bloated, slow to cold-start, or unsafe — the
exact failures this recipe exists to prevent.

---

## 26. Sources <a name="26-sources"></a>

**Primary — uv (Astral):**
- [Using uv in Docker — full guide](https://docs.astral.sh/uv/guides/integration/docker/) — `COPY --from`
  pinned-tag install, multi-stage, `--mount=type=cache`/`bind`, `uv sync --locked --no-install-project`,
  `UV_COMPILE_BYTECODE`, `UV_LINK_MODE=copy`, `.dockerignore` `.venv`, distroless final image,
  `ENV PATH="/app/.venv/bin:$PATH"`, the `--frozen` vs `--locked` workspace note, intermediate layers.
- [uv environment-variables reference](https://docs.astral.sh/uv/reference/environment/) — exact
  descriptions for `UV_COMPILE_BYTECODE`, `UV_LINK_MODE`, `UV_NO_DEV`, `UV_PYTHON_DOWNLOADS`,
  `UV_CACHE_DIR`, `UV_PROJECT_ENVIRONMENT`, `UV_FROZEN`, `UV_LOCKED`, `UV_NO_SYNC`, `UV_PYTHON`.
- [uv CLI reference — `uv sync` / `uv run`](https://docs.astral.sh/uv/reference/cli/) — flag semantics for
  `--locked`, `--frozen`, `--no-install-project`, `--no-dev`, `--no-editable`, `--compile-bytecode`,
  `--group`, `--no-default-groups`; `uv run --no-sync`/`--frozen`.
- [astral-sh/uv-docker-example — `multistage.Dockerfile`](https://github.com/astral-sh/uv-docker-example/blob/main/multistage.Dockerfile)
  — the canonical multi-stage Dockerfile reproduced (and annotated) in §15, incl. the non-root user, the
  `python:3.12-slim-trixie` runtime, `UV_NO_DEV=1`, `UV_PYTHON_DOWNLOADS=0`, and `CMD ["fastapi","run",...]`.
- [astral-sh/uv-docker-example — `Dockerfile`](https://github.com/astral-sh/uv-docker-example/blob/main/Dockerfile)
  — the single-stage dev image, the `ENV UV_LINK_MODE=copy` comment, `PYTHONUNBUFFERED=1`, and the
  explicit "in production, you should use `fastapi run` instead" comment on the dev `uv run fastapi dev` CMD.
- [astral-sh/uv-docker-example — `standalone.Dockerfile`](https://github.com/astral-sh/uv-docker-example/blob/main/standalone.Dockerfile)
  — the managed-Python variant copied in §16.
- [uv releases](https://github.com/astral-sh/uv/releases) — current version **0.11.24** (2026-06-23),
  used to pin the `COPY --from` tag.
- [uv CHANGELOG](https://github.com/astral-sh/uv/blob/main/CHANGELOG.md) — the Debian image move from
  "Bookworm" → "Trixie".

**Primary — FastAPI:**
- [FastAPI — Deployment with Docker](https://fastapi.tiangolo.com/deployment/docker/) — `CMD ["fastapi",
  "run", ...]`, the **exec-form** requirement and graceful-shutdown rationale, single-process-per-container
  philosophy, `--proxy-headers` behind a load balancer, `--workers` only for the non-cluster case.
- [FastAPI — Server Workers](https://fastapi.tiangolo.com/deployment/server-workers/) — Uvicorn workers
  vs one-process-per-container.

**Primary — Fly.io:**
- [Fly — Deploy with a Dockerfile](https://fly.io/docs/languages-and-frameworks/dockerfile/) — `0.0.0.0`
  bind requirement, `EXPOSE` → `internal_port` inference.
- [Fly — App configuration (fly.toml)](https://fly.io/docs/reference/configuration/) — `internal_port`
  (default 8080), `[http_service]`, `[processes]`, health checks, `auto_stop_machines` /
  `min_machines_running` (scale-to-zero ↔ cold-start).

**Cross-reference (this skill / repo):**
- `patterns-python-connection-layer.md` (sibling) — the `asyncpg.Pool` opened/closed in the FastAPI
  lifespan that this image's CMD runs.
- `patterns-ingestion-upsert.md`, `theory-continuous-aggregates.md` (timescaledb-timeseries skill) — the
  ingest-worker process behind Variant D.
- Lumina non-negotiable #4 (`CLAUDE.md`) — sockets/timers/heavy work go in a Fly worker, not on
  serverless; this image is that worker for the Python data-analytics line.
