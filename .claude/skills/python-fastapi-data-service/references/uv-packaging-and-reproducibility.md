# uv — Packaging, Dependency Management & Reproducibility

> **Scope.** This reference is for the **JPM-Markets re-engineering data-analytics product line (NOT Lumina).**
> That line is a **new Python / FastAPI / data-engineering service** — a different stack from Lumina's
> Bun + Express + Prisma + Upstash app. Here we standardize on **[Astral `uv`](https://docs.astral.sh/uv/)**
> as the single tool for Python version management, dependency resolution, virtual environments, and the
> reproducible-build chain that the Docker doc consumes.
>
> **Pinned versions (verify before relying on a version-specific behavior):**
> - `uv` **0.11.24**, released 2026-06-23 — current PyPI release at time of writing
>   ([pypi.org/project/uv](https://pypi.org/project/uv/)). The `0.11.x` series is current; `0.11.0`
>   shipped earlier in 2026, `0.11.23` on 2026-06-19, `0.11.24` on 2026-06-23
>   ([astral-sh/uv releases](https://github.com/astral-sh/uv/releases)).
> - License: **`MIT OR Apache-2.0`** (dual) — verbatim PyPI classifier
>   ([pypi.org/project/uv](https://pypi.org/project/uv/)). Permissive; safe to vendor in CI/Docker.
> - `uv` is **pre-1.0**. Read [§11 "Pin uv itself"](#11-pin-uv-itself-the-pre-10-rule) before trusting
>   long-lived reproducibility — the binary's own version is part of the reproducibility surface until 1.0.
> - Python target for the line: **3.12+** (see [§7](#7-python-version-pinning-python-version--requires-python)).
>
> Every concrete claim below is cited inline to a primary Astral doc, the PyPI page, the uv GitHub repo,
> or the relevant PEP. Where a number or behavior is version-specific it is tagged; where the upstream
> docs were silent it is flagged `[unverified]`.

---

## 0. The one-paragraph version (read this first)

`uv` is one Rust binary that replaces `pip`, `pip-tools`, `virtualenv`, `pyenv`, `pipx`, and Poetry for a
project. You declare **broad** requirements in `pyproject.toml` (`fastapi`, `pydantic>2`), uv resolves them
**once** into a **universal, cross-platform** `uv.lock` (exact versions + hashes for Linux/macOS/Windows),
and **`uv sync`** materializes that lock into a `.venv`. You **commit `uv.lock`** to version control so every
machine and every CI run installs byte-identical dependency trees
([locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/),
[project layout](https://docs.astral.sh/uv/concepts/projects/layout/)). In CI and Docker you run
`uv sync --locked` to **assert** the lock is current (fail otherwise) — that single flag is the difference
between "reproducible" and "hopefully reproducible." Everything in this doc is the discipline around that
chain.

---

## 1. Why uv, and what it actually is

### 1.1 One tool, written in Rust, for the whole lifecycle

uv is "an extremely fast Python package and project manager, written in Rust" — the official one-line
description on both the [projects guide](https://docs.astral.sh/uv/guides/projects/) and the
[PyPI page](https://pypi.org/project/uv/). The single binary does, in one process and one cache:

| Concern | Legacy tool(s) | uv subcommand |
|---|---|---|
| Resolve a dependency graph | `pip` / `pip-tools` (`pip-compile`) | `uv lock`, `uv add` |
| Install into an environment | `pip install` | `uv sync`, `uv pip install` |
| Create / manage virtualenvs | `virtualenv`, `python -m venv` | `uv venv` (implicit `.venv`) |
| Install & switch Python itself | `pyenv` | `uv python install` / `uv python pin` |
| Run a tool in an ephemeral env | `pipx` | `uvx` (alias for `uv tool run`) |
| Project metadata + lockfile | Poetry / PDM | `pyproject.toml` + `uv.lock` |

Per the uv–Poetry comparison, uv "consolidates multiple tools into one binary, replacing pyenv, pip,
pip-tools, pipx, virtualenv, and Poetry itself"
([pydevtools: how do uv and Poetry compare](https://pydevtools.com/handbook/explanation/how-do-uv-and-poetry-compare/)).

**Why this matters for a data service.** A market-data analytics service has a *lot* of native, version-
sensitive dependencies — `asyncpg`/`psycopg`, `numpy`/`pyarrow`, `polars`/`pandas`, ML or stats libs — where
"works on my machine" is a real and expensive failure. One tool that pins the Python interpreter *and* the
dependency graph *and* resolves them universally collapses the surface where reproducibility leaks.

### 1.2 The speed claim — and why it is load-bearing, not vanity

uv resolves with a **parallelized PubGrub-style** algorithm and a global content-addressed cache.
Reported figures (third-party benchmarks, treat as order-of-magnitude not gospel):

- Resolution "0.12 seconds with a warm cache and 1.45 seconds with a cold cache, compared to Poetry's
  12.30 seconds"; "uv resolves and installs dependencies 10–100× faster than Poetry"
  ([techplained benchmarks 2026](https://www.techplained.com/python-uv-vs-pip-vs-poetry-vs-pdm),
  [pydevtools comparison](https://pydevtools.com/handbook/explanation/how-do-uv-and-poetry-compare/)).

The reason this is **load-bearing** and not a micro-optimization: every CI run does a cold-or-warm resolve+
install, every Docker image build does one, every developer's first checkout does one. At Poetry's
10–30s `install` you tolerate skipping `--locked` to save time; at uv's sub-second sync you can afford to
**always** assert the lock and **always** sync from scratch in CI — speed is what makes the *correct*
reproducibility discipline (below) cheap enough to actually follow.

> `[unverified]` The exact benchmark numbers above are third-party (techplained/pydevtools), not measured by
> us this session. Treat them as "uv is roughly an order of magnitude faster, sub-second on small projects."
> The *mechanism* (Rust + PubGrub + parallel + shared cache) is documented by Astral.

### 1.3 Standards posture — PEP 621 / PEP 508 / PEP 735

uv is deliberately **standards-native**, which is the second reason to pick it over Poetry's historical
proprietary format:

- Project metadata is **PEP 621** (`[project]` table), dependency specifiers are **PEP 508**, dependency
  groups are **PEP 735** (`[dependency-groups]`). "uv uses PEP 621 metadata and PEP 508 dependency
  specifiers exclusively, meaning any PEP 621-compliant tool can read a uv project's pyproject.toml without
  modification" ([techplained](https://www.techplained.com/python-uv-vs-pip-vs-poetry-vs-pdm)).
- The only uv-proprietary surfaces are `[tool.uv]` (uv-specific config) and `uv.lock` (the lockfile format
  is uv-specific — see [§3.4](#34-the-lockfile-is-uv-specific-and-versioned)).

The payoff: if uv is ever wrong for this line, the `[project]` table is portable to pip, PDM, Hatch, or
Poetry 2.x without rewriting your dependency declarations. You are not locked in at the *metadata* layer —
only the lockfile would need regenerating by the new tool. That exit ramp is itself a reason it's a safe v1.

---

## 2. `pyproject.toml` — the broad requirements (what you hand-edit)

`pyproject.toml` is the **single** source of *declared intent*: project metadata + the version **ranges** you
will accept. It is the file humans edit; `uv.lock` is the file uv writes. The split is the whole game.

> "Unlike `pyproject.toml`, which specifies the broad requirements of your project, the lockfile contains
> the exact resolved versions that are installed in the project environment."
> — [project layout](https://docs.astral.sh/uv/concepts/projects/layout/)

### 2.1 A minimal application (non-packaged) for this line

`uv init market-data-service` (default = application) produces, verbatim from
[init concepts](https://docs.astral.sh/uv/concepts/projects/init/):

```toml
[project]
name = "example-app"
version = "0.1.0"
description = "Add your description here"
readme = "README.md"
requires-python = ">=3.11"
dependencies = []
```

Critically: **"It does not include a build system, it is not a package and will not be installed into the
environment"** ([init concepts](https://docs.astral.sh/uv/concepts/projects/init/)). For a FastAPI service
this is usually what you want — you run code, you don't `pip install` your own service. See
[§8](#8-packaged-vs-application-non-packaged--the-build-system-decision) for the full decision.

### 2.2 A realistic data-service `pyproject.toml`

This is the shape the JPM-Markets data-analytics service v1 should start from. Every field is annotated.

```toml
[project]
name = "market-data-service"
version = "0.1.0"
description = "Market-data analytics API (FastAPI + TimescaleDB)"
readme = "README.md"
# Concrete floor: the language features and typing we depend on (3.12 structural
# pattern matching maturity, perf, typing). See §7 for requires-python vs .python-version.
requires-python = ">=3.12"

# RUNTIME deps — the things the deployed service imports. BROAD ranges, not pins.
# uv pins the exact version in uv.lock; here you state the contract you accept.
dependencies = [
    "fastapi>=0.115,<0.120",        # API framework
    "uvicorn[standard]>=0.34,<0.40", # ASGI server; [standard] pulls uvloop/httptools
    "pydantic>=2.9,<3",             # request/response models + settings
    "pydantic-settings>=2.6,<3",    # 12-factor config from env
    "asyncpg>=0.30,<0.31",          # async Postgres/TimescaleDB driver
    "httpx>=0.28,<0.29",            # upstream market-data HTTP client
    "orjson>=3.10,<4",              # fast JSON for hot serialization paths
]

# DEV/TEST deps — PEP 735 groups. NOT published, NOT in the runtime image (see §6, §9).
[dependency-groups]
dev = [
    "ruff>=0.8,<0.13",              # lint + format
    "mypy>=1.13,<2",               # type-check
    {include-group = "test"},       # dev implies test (nesting, §6.4)
]
test = [
    "pytest>=8.3,<9",
    "pytest-asyncio>=0.24,<0.30",   # async test support for the asyncpg/httpx paths
    "anyio>=4.6,<5",
    "respx>=0.21,<0.30",            # mock httpx upstreams deterministically
]

# uv-specific config (the only proprietary table besides the lockfile).
[tool.uv]
# This is an APPLICATION, not a library: do not try to build/install it as a package.
# (Equivalent to having no [build-system]; explicit is clearer — see §8.3.)
package = false
```

> **Version pins above are illustrative ranges, not "today's exact versions."** Always run `uv add <pkg>`
> (which writes a sensible lower-bound) and let `uv.lock` capture the exact resolved version. Do **not**
> hand-type exact `==` pins in `dependencies` — that's the lockfile's job ([§3](#3-uvlock--the-exact-resolution-what-uv-writes)).

### 2.3 Specifier syntax you will actually use (PEP 508)

From [dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/), verbatim example:

```toml
[project]
dependencies = [
  "tqdm >=4.66.2,<5",                                  # version range (lower floor, major ceiling)
  "torch ==2.2.2",                                     # exact (rare in app deps; prefer ranges)
  "transformers[torch] >=4.39.3,<5",                   # with extras
  "importlib_metadata >=7.1.0; python_version < '3.10'", # environment marker (conditional)
]
```

Key patterns (same source):

| Pattern | Meaning |
|---|---|
| `>=1.2,<2` | floor + major ceiling — **the default you want** for app deps |
| `==2.1.*` | match the `2.1` series only |
| `~=1.2.3` | compatible release — equivalent to `>=1.2.3,<1.3` |
| `pkg[extra1,extra2]` | install with extras (e.g. `uvicorn[standard]`) |
| `pkg ; python_version < '3.10'` | **environment marker** — conditional install |

**Environment markers** are how you express platform/version conditionality without forking files. Examples
(verbatim, [dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/)):

```bash
uv add "jax; sys_platform == 'linux'"
uv add "numpy; python_version >= '3.11'"
```

Marker variables: `sys_platform`, `platform_system`, `python_version`, `implementation_name`, combined with
`and` / `or` / parentheses. The universal lockfile records **all** marker branches in one file
([§3.2](#32-universal--cross-platform-the-key-property)).

---

## 3. `uv.lock` — the exact resolution (what uv writes)

### 3.1 What it is

`uv.lock` is the **resolved** counterpart to `pyproject.toml`'s declared ranges. Definitions, verbatim from
[project layout](https://docs.astral.sh/uv/concepts/projects/layout/):

- It "captures the packages that would be installed across all possible Python markers such as operating
  system, architecture, and Python version."
- It contains "the exact resolved versions that are installed in the project environment" — including
  **hashes** for integrity.
- It "is a human-readable TOML file **but is managed by uv and should not be edited manually**."
- It "is automatically created and updated" by `uv sync` / `uv run`, or explicitly via `uv lock`.

### 3.2 Universal / cross-platform — the key property

The single most important property for reproducibility: **one `uv.lock` resolves every platform at once.**

> "A single `uv.lock` captures resolution for Linux, macOS, and Windows."
> — [pydevtools comparison](https://pydevtools.com/handbook/explanation/how-do-uv-and-poetry-compare/)

This is *categorically different* from pip-tools, where you maintain `requirements-linux.txt`,
`requirements-macos.txt`, `requirements-win.txt` — one compile per target. uv resolves the full
marker-conditional graph once. The migration guide is explicit that this collapse is the point:

> "The old approach required separate locked files per platform. uv's universal resolution eliminates this …
> The resulting `uv.lock` is valid on all platforms."
> — [pip-to-project migration](https://docs.astral.sh/uv/guides/migration/pip-to-project/)

For a data service whose developers are on macOS/Windows laptops and whose production is Linux containers,
this means the lock you test against on a Mac is the *same* lock that resolves the Linux container — no
"works locally, breaks in Docker" drift from a re-resolve.

### 3.3 Commit `uv.lock` to version control — non-negotiable

> "This file should be checked into version control, allowing for consistent and reproducible installations
> across machines." — [project layout](https://docs.astral.sh/uv/concepts/projects/layout/)

| File | Commit? | Why |
|---|---|---|
| `pyproject.toml` | **Yes** | source of declared intent |
| `uv.lock` | **Yes** | the reproducibility contract — exact versions + hashes |
| `.python-version` | **Yes** | pins the dev/CI interpreter ([§7](#7-python-version-pinning-python-version--requires-python)) |
| `.venv/` | **No** | machine-local; uv writes an internal `.gitignore` inside `.venv` to exclude it |

On `.venv`: "it is **not** recommended to include the `.venv` directory in version control; it is
automatically excluded from `git` with an internal `.gitignore` file"
([project layout](https://docs.astral.sh/uv/concepts/projects/layout/)). You never commit the environment —
only the recipe (`uv.lock`) and the interpreter pin (`.python-version`).

A team `.gitignore` for the service:

```gitignore
# uv / Python environment — never commit the materialized env
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.mypy_cache/
# DO commit: pyproject.toml, uv.lock, .python-version
```

### 3.4 The lockfile is uv-specific *and* versioned

> "The `uv.lock` format is specific to uv and not usable by other tools."
> — [project layout](https://docs.astral.sh/uv/concepts/projects/layout/)

This is the one true lock-in surface. To hand the resolution to another tool, **export** it (see
[§10.4](#104-exporting-to-requirementstxt--pylocktoml-pep-751)).

The lockfile carries its **own** version/revision, and this is treated as part of uv's **public API**:

- `version` field (currently **`1`**): major schema version. "uv will reject lockfiles with different major
  versions." Bumped only on a breaking change.
- `revision` field (currently **`3`** at uv 0.11.x): minor, backward-compatible additions (e.g. new metadata
  fields like `upload-time`).
- Per uv's [versioning policy](https://docs.astral.sh/uv/reference/policies/versioning/): "The `uv.lock`
  schema version is considered part of the public API, and so will only be incremented in a minor release as
  a breaking change."

(Field names/values per [astral-sh/uv#15220](https://github.com/astral-sh/uv/issues/15220) and the
[deepwiki lockfile management](https://deepwiki.com/astral-sh/uv/7.2-lockfile-management) write-up;
cross-checked against the versioning policy page above.)

**Why this matters for the pre-1.0 pin ([§11](#11-pin-uv-itself-the-pre-10-rule)):** a *newer* uv may write a
*newer* `revision` (e.g. add a field) that an *older* uv in another developer's path or an older CI image
cannot read cleanly — producing spurious "lockfile out of date" churn or read errors. Pinning the uv version
across the team and CI keeps the `revision` they all read/write identical. `uv lock --force` can rewrite the
lock in the newest format when you deliberately upgrade
([astral-sh/uv#15220](https://github.com/astral-sh/uv/issues/15220)).

---

## 4. The core workflow — `add` / `sync` / `run` / `lock`

These four commands are 95% of daily use. The mental model:

```
edit intent ─▶ uv add <pkg>   (mutate pyproject.toml + re-lock + sync)
                    │
            uv.lock (exact)
                    │
        uv sync ────┼──── materialize .venv from the lock
                    │
        uv run  ────┴──── auto-verify+sync, then exec in .venv
```

### 4.1 `uv add` / `uv remove` — change a dependency

`uv add` mutates `pyproject.toml`, updates `uv.lock`, and syncs `.venv` in one shot. Verbatim examples
([projects guide](https://docs.astral.sh/uv/guides/projects/),
[dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/)):

```bash
uv add requests                       # add to [project.dependencies]
uv add 'requests==2.31.0'             # with a version constraint
uv add git+https://github.com/psf/requests
uv add -r requirements.txt -c constraints.txt   # import from a requirements file
uv add httpx --dev                    # add to [dependency-groups].dev
uv add httpx --group lint             # add to a named group
uv add httpx --optional network       # add to [project.optional-dependencies] (an extra)
```

Remove / modify:

```bash
uv remove requests
uv add "httpx>0.1.0"                            # update the declared constraint
uv add "httpx>0.1.0" --upgrade-package httpx    # force a version upgrade while changing the constraint
```

> **Always prefer `uv add` over hand-editing `[project.dependencies]`** — `uv add` re-resolves and re-locks
> atomically, so `uv.lock` can never silently fall behind `pyproject.toml`. Hand-editing then forgetting to
> `uv lock` is exactly the drift `--locked` exists to catch ([§5](#5-the-reproducibility-flags---locked-vs--frozen)).

### 4.2 `uv lock` — (re)resolve only

`uv lock` resolves the declared ranges into `uv.lock` **without** touching the environment. Use it when you
want to update the lock and review the diff before syncing:

```bash
uv lock                       # create/update uv.lock from pyproject.toml
uv lock --check               # verify uv.lock is up-to-date; exit non-zero if not (no writes)
uv lock --upgrade             # re-resolve, allowing ALL packages to move to newest allowed
uv lock --upgrade-package requests           # upgrade just one package to its latest allowed
uv lock --upgrade-package requests==2.32.0   # upgrade one package to a specific version
uv lock --force               # rewrite the lock in the newest format (revision bump)
```

(`uv lock`, `--upgrade`, `--upgrade-package`, `--check` per
[locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/); `--force` per
[astral-sh/uv#15220](https://github.com/astral-sh/uv/issues/15220).)

**Upgrade semantics — the important nuance:** a new upstream release does **not** invalidate your lock. uv
only re-resolves when *your declared metadata* changes:

> "When considering if the lockfile is up-to-date, uv will check if it matches the project metadata."
> Changes to dependencies or constraints that exclude the locked version trigger updates. "New upstream
> package releases don't automatically invalidate lockfiles — explicit upgrades are required."
> — [locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/)

This is **a feature for reproducibility**: your build is frozen against the world until you *choose*
`uv lock --upgrade`. Floating to "latest" is opt-in, never accidental.

### 4.3 `uv sync` — materialize the environment

`uv sync` makes `.venv` exactly match `uv.lock`. By default it **locks if needed, then installs**:

```bash
uv sync                       # ensure lock current, then install into .venv
uv sync --locked              # assert lock is current (error if not), then install — CI/prod default (§5)
uv sync --frozen              # install from lock as-is, NO currency check (§5)
uv sync --no-dev              # exclude the default dev group (production install)
```

**`uv sync` is "exact" by default** — it *removes* packages from `.venv` that aren't in the lock:

> "`uv sync` performs 'exact' syncing by default, removing packages absent from the lockfile. Retain
> extraneous packages with `uv sync --inexact`."
> — [locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/)

That exactness is *desirable* — it guarantees `.venv` is precisely the lock, with no leftover cruft from a
package you `uv remove`d. (`uv run`, by contrast, is **inexact** by default — see §4.4 — so a stray ad-hoc
`uv pip install` survives between runs; pass `uv run --exact` to force exactness there too.)

### 4.4 `uv run` — execute, auto-verifying the lock first

`uv run` is the primary entry point: it **keeps the project in sync before every execution**, then runs your
command in `.venv` — no manual activation.

> "`uv run` executes scripts or commands in your project environment. It automatically keeps the project in
> sync before execution." — [projects guide](https://docs.astral.sh/uv/guides/projects/)

```bash
uv run main.py                        # run a script in .venv (auto-sync first)
uv run -- uvicorn app.main:app --reload --port 8000   # run the FastAPI dev server
uv run pytest                         # run tests (env synced first — no "did I install pytest?")
uv run -- flask run -p 3000           # '--' separates uv flags from the program's flags
uv run --locked pytest                # assert lock current before running (CI)
uv run --frozen main.py               # run from lock without a currency check
uv run --no-sync main.py              # skip the sync step entirely (implies --frozen)
```

The migration guide's framing: `uv run pytest` replaces
`pip install -r requirements-dev.txt && python -m pytest` — "`uv run` automatically syncs the environment
before execution" ([pip-to-project](https://docs.astral.sh/uv/guides/migration/pip-to-project/)).

> **You almost never `source .venv/bin/activate`.** `uv run` is the activation. The manual path still exists
> (`uv sync` then `source .venv/bin/activate` on Unix / `.venv\Scripts\activate` on Windows,
> [projects guide](https://docs.astral.sh/uv/guides/projects/)) but it's the exception, not the workflow.

### 4.5 `uv venv` — explicit environment, explicit Python

uv creates `.venv` automatically, but you can be explicit (e.g. to force a Python version for the env):

```bash
uv venv                        # create .venv (default Python)
uv venv --python 3.12.7        # create .venv on a specific interpreter
```

(`uv venv --python` per [python-versions concepts](https://docs.astral.sh/uv/concepts/python-versions/).)

---

## 5. The reproducibility flags — `--locked` vs `--frozen`

This is the heart of "reproducible." Both flags **refuse to mutate `uv.lock`**, but they answer different
questions. Memorize the distinction; it's the single most consequential thing in this doc.

### 5.1 The verbatim definitions

From the [uv CLI reference](https://docs.astral.sh/uv/reference/cli/) (quoted exactly):

**`--locked`**
> "Assert that the `uv.lock` will remain unchanged [env: `UV_LOCKED=`]. Requires that the lockfile is
> up-to-date. **If the lockfile is missing or needs to be updated, uv will exit with an error.**"

**`--frozen`**
> "Run without updating the `uv.lock` file [env: `UV_FROZEN=`]. Instead of checking if the lockfile is
> up-to-date, **uses the versions in the lockfile as the source of truth.** If the lockfile is missing, uv
> will exit with an error."

**`--no-sync`**
> "Avoid syncing the virtual environment [env: `UV_NO_SYNC=`]. **Implies `--frozen`**, as the project
> dependencies will be ignored (i.e., the lockfile will not be updated, since the environment will not be
> synced regardless)."

### 5.2 The difference, stated plainly

| | `--locked` | `--frozen` |
|---|---|---|
| Checks the lock matches `pyproject.toml`? | **Yes** — errors if stale | **No** — trusts the lock blindly |
| Updates the lock? | Never | Never |
| Fails if lock missing? | Yes | Yes |
| Question it answers | "Is this lock **current** *and* correct?" | "Install **exactly** this lock, don't think." |
| Env var | `UV_LOCKED=1` | `UV_FROZEN=1` |

- **`--locked` = "verify + use."** It is a **guard**: if someone edited `pyproject.toml` (added a dep,
  changed a range) but forgot to re-run `uv lock`, `--locked` **fails the build**. This is exactly what you
  want in CI — it makes "the lockfile is out of date" a *failing check*, not a silent re-resolve that
  produces a different tree than was reviewed.
- **`--frozen` = "use, blindly."** It does **not** compare the lock to `pyproject.toml` at all; it just
  installs whatever the lock says. Faster (skips the metadata check) but **will not catch drift**. Use it
  when you *know* the lock is authoritative and the `pyproject.toml` may be partially staged (the classic
  case: a Docker layer where `uv.lock` + `pyproject.toml` are bind-mounted but the workspace members aren't
  copied yet — see [§9.2](#92-the-two-stage-dependency-then-project-pattern)).

### 5.3 The decision rule

| Context | Flag | Reason |
|---|---|---|
| Local dev, iterating | *(none)* — bare `uv run` / `uv sync` | let uv re-lock as you edit |
| **CI: lint/test/build** | **`uv sync --locked`** | **fail if lock is stale** — the reproducibility guard |
| Pre-commit / PR check | `uv lock --check` | assert lock current without installing |
| Docker, full source present | `uv sync --locked` | same guard, in the image build |
| Docker, partial source (deps layer) | `uv sync --frozen --no-install-project` | lock is truth; project not copied yet (§9) |
| "Just run it, lock is gospel" | `--frozen` | skip the metadata check for speed |

**One-line heuristic:** **`--locked` in CI, `--frozen` only inside Docker layer tricks.** If you find
yourself reaching for `--frozen` in CI, you almost certainly want `--locked` — you *want* the drift to fail.

### 5.4 `uv lock --check` — the pure assertion

If you only want to **verify** the lock is current (e.g. a fast pre-commit hook or a dedicated CI step) with
**no install**:

```bash
uv lock --check        # exit 0 if uv.lock is up-to-date; non-zero (error) otherwise
```

This is the lightest reproducibility gate. A common CI pattern: a cheap `uv lock --check` job that fails a PR
the instant `pyproject.toml` and `uv.lock` diverge, *before* the expensive test matrix runs.
(`uv lock --check` per [locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/).)

---

## 6. Dependency groups — dev/test deps live *in* `pyproject.toml`

The old world had `requirements.txt` + `requirements-dev.txt` + `requirements-test.txt` as **separate
files**. uv folds them into **one** `pyproject.toml` using **PEP 735 dependency groups**. There is no
separate dev-requirements file.

### 6.1 The table

Verbatim from [dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/):

```toml
[dependency-groups]
dev = ["pytest >=8.1.1,<9"]
lint = ["ruff"]
test = ["pytest"]
```

Three distinct dependency surfaces, and you must not confuse them:

| Table | Standard | Published to PyPI? | Selected by | Purpose |
|---|---|---|---|---|
| `[project.dependencies]` | PEP 621 | **Yes** | always | runtime requirements |
| `[project.optional-dependencies]` (extras) | PEP 621 | **Yes** | `pkg[extra]` syntax / `--extra` | optional *published* features |
| `[dependency-groups]` | PEP 735 | **No (local only)** | `--group` / `--all-groups` | dev/test/lint tooling |

(Comparison tables verbatim from [dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/).)

**The rule for a data *service* (not a library):** your dev/test/lint tools go in `[dependency-groups]`, not
in extras. Extras are a *published library* concept (`pip install pandas[plot]`). A service publishes
nothing, so its tooling is groups, full stop. Production images then exclude all groups
([§9.3](#93-production-image-no-dev-deps)).

### 6.2 Adding to groups

Verbatim ([dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/)):

```bash
uv add --dev pytest          # creates/updates the dev group
uv add --group lint ruff     # creates/updates a named 'lint' group
uv add --optional plot matplotlib   # adds to extras (for libraries, not services)
```

### 6.3 Syncing groups

The **`dev` group is special-cased as included by default**; everything else is opt-in. Verbatim from
[locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/) and
[dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/):

```bash
uv sync                       # includes dev (default), excludes other groups
uv sync --no-dev              # exclude the dev group (production)
uv sync --only-dev            # ONLY the dev group
uv sync --group lint          # add a named group on top of defaults
uv sync --all-groups          # include every group
uv sync --only-group lint     # ONLY lint group — no defaults, no the project itself
uv sync --no-group test       # exclude the test group
uv sync --no-default-groups   # exclude ALL default groups
```

> "Development dependencies from `[dependency-groups]` (PEP 735) are synced by default. The `dev` group is
> special-cased as included." And: "**Group exclusions always take precedence over inclusions.**"
> — [locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/)

That last rule matters: `uv sync --all-groups --no-group test` gives you everything *except* `test` — the
`--no-group` wins.

### 6.4 Two power features: default-groups and nesting

**Customize which groups are default** (`[tool.uv]`, verbatim
[dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/)):

```toml
[tool.uv]
default-groups = ["dev", "foo"]     # these sync by default
# default-groups = "all"            # or: every group syncs by default
```

**Nest groups** so `dev` pulls in `lint` + `test` (verbatim, same source):

```toml
[dependency-groups]
dev = [
  {include-group = "lint"},
  {include-group = "test"}
]
lint = ["ruff"]
test = ["pytest"]
```

Now `uv sync` (default = `dev`) installs ruff + pytest, while a CI job that only needs linting runs
`uv sync --only-group lint` and gets *just* ruff — no pytest, smaller, faster. This lets one
`pyproject.toml` serve "full dev env", "lint-only CI job", "test-only CI job", and "prod (`--no-dev`)" with
no extra files.

**Per-group Python floor** (verbatim, same source) — occasionally useful when a dev tool needs a newer
Python than the runtime floor:

```toml
[project]
requires-python = ">=3.10"

[dependency-groups]
dev = ["pytest"]

[tool.uv.dependency-groups]
dev = {requires-python = ">=3.12"}
```

### 6.5 Legacy `dev-dependencies` (you'll see it in older repos)

Pre-PEP-735 uv projects used (verbatim,
[dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/)):

```toml
[tool.uv]
dev-dependencies = ["pytest"]
```

"This merges with `[dependency-groups]` `dev` section during migration." For new work in this line, use
`[dependency-groups]` — `dev-dependencies` is the legacy spelling, kept only for back-compat.

---

## 7. Python-version pinning — `.python-version` & `requires-python`

uv manages the **interpreter itself**, not just packages. There are **two** independent knobs, and conflating
them is a common mistake.

### 7.1 The two knobs

| Knob | Where | Type | Answers |
|---|---|---|---|
| `requires-python` | `pyproject.toml` `[project]` | a **range** (`>=3.12`) | "which Pythons is this project *compatible* with?" |
| `.python-version` | repo root file | a **concrete** version (`3.12.7`) | "which Python does *this checkout* dev/test against?" |

Verbatim from [python-versions concepts](https://docs.astral.sh/uv/concepts/python-versions/):

> "**Key Distinction**: `requires-python` defines acceptable version ranges for dependency resolution;
> `.python-version` pins a concrete development version."

And on resolution: with `requires-python`, "the first Python version that is compatible with the requirement
will be used, unless a version is otherwise requested" (same source).

**For this line:** set `requires-python = ">=3.12"` (the compatibility contract — affects how dependencies
resolve their own `python_version` markers) **and** pin `.python-version` to a concrete patch (the exact
interpreter the whole team + CI runs). Both committed.

### 7.2 Installing and pinning Python

uv downloads standalone CPython builds (no system Python needed). Verbatim commands
([python-versions concepts](https://docs.astral.sh/uv/concepts/python-versions/)):

```bash
uv python install 3.12.7        # install a specific patch
uv python install 3.12          # install latest patch of 3.12
uv python install '>=3.11,<3.13'  # install matching a constraint
uv python install 3.11 3.12 3.13  # install several (for a test matrix)

uv python pin 3.12.7            # write .python-version = 3.12.7 for THIS project
uv python pin --global 3.12.7   # set a global default

uv python list                  # list available/installed versions
uv python list --only-installed
uv python find '>=3.12'         # find an interpreter satisfying a constraint
```

> "uv searches for `.python-version` files in the working directory and parent directories." Create one with
> `uv python pin <version>`. "Any of the request formats … can be used, though **use of a version number is
> recommended for interoperability with other tools.**"
> — [python-versions concepts](https://docs.astral.sh/uv/concepts/python-versions/)

### 7.3 Where Python comes from (and why "no system Python" is a reproducibility win)

CPython distributions come from Astral's **`python-build-standalone`** project — "self-contained,
highly-portable, and performant" builds ([python-versions concepts](https://docs.astral.sh/uv/concepts/python-versions/)).
uv's discovery order (same source): managed installs → `PATH` → (Windows registry/Store) → download a
managed build if none found.

Because uv can **install** the exact interpreter, the pinned `.python-version` is reproducible **without**
relying on the host having that Python — a fresh CI runner or a teammate with no Python at all gets the
identical interpreter. That removes "the host's Python is 3.11.2 but mine is 3.12.7" from the drift surface
entirely. Control automatic downloads with `python-downloads = "manual"` or `--no-python-downloads` if your
CI must use a provisioned interpreter (same source).

### 7.4 Recommended pin for this line

```bash
uv python pin 3.12.7    # → writes .python-version  (commit it)
```

```toml
# pyproject.toml
[project]
requires-python = ">=3.12"
```

> Why 3.12+ as the floor: it's a maintained, performance-improved CPython with mature typing and pattern-
> matching that the data-service code targets. `>=3.12` keeps the door open for 3.13/3.14 in the test matrix
> while `.python-version` nails the default dev/CI interpreter to one patch. `[unverified]` "3.12 is the
> right floor" is a *project policy choice* for this line, not a uv requirement — uv supports Python 3.8–3.15
> per the [PyPI classifiers](https://pypi.org/project/uv/).

---

## 8. Packaged vs application (non-packaged) — the `[build-system]` decision

This trips people up: **whether your project gets installed into its own `.venv` depends on whether it has a
`[build-system]`.** For a FastAPI *service* the answer is usually "no build system, don't install me."

### 8.1 The rule

From [init concepts](https://docs.astral.sh/uv/concepts/projects/init/):

- **Application (default, `uv init`)** → **no `[build-system]`** → "it is **not a package and will not be
  installed into the environment.**" Only its *dependencies* are installed; your own code runs from the
  source tree.
- **Packaged app (`uv init --package`)** or **library (`uv init --lib`)** → **has `[build-system]`** → the
  project itself is built and installed (editable by default).

Verbatim application `pyproject.toml` (no build system):

```toml
[project]
name = "example-app"
version = "0.1.0"
description = "Add your description here"
readme = "README.md"
requires-python = ">=3.11"
dependencies = []
```

Verbatim packaged `pyproject.toml` (`uv init --package`):

```toml
[project]
name = "example-pkg"
version = "0.1.0"
description = "Add your description here"
readme = "README.md"
requires-python = ">=3.11"
dependencies = []

[project.scripts]
example-pkg = "example_pkg:main"

[build-system]
requires = ["uv_build>=0.11.24,<0.12"]
build-backend = "uv_build"
```

(Note the build backend `uv_build` and its version range track the uv version — another reason to pin uv,
§11.)

### 8.2 Which one for the JPM-Markets data service?

| You want… | Choose | Marker |
|---|---|---|
| A FastAPI service you `uv run uvicorn ...` | **Application** (non-packaged) | no `[build-system]` |
| A CLI tool published to an internal index | **Packaged app** (`--package`) | has `[build-system]`, `[project.scripts]` |
| A shared library imported by other services | **Library** (`--lib`) | has `[build-system]`, `py.typed`, `src/` |

For **v1 of the data-analytics API → Application (non-packaged).** You don't publish the service; you run it.
Skipping the build/install step means `uv sync` only installs *dependencies*, not your own code — faster
syncs and no "is my own package installed editable?" confusion.

> Trade-off to be aware of: a non-packaged app has no `src/`-layout import isolation by default. If the
> service grows into something you want to `pip install` (e.g. to ship a CLI alongside the API, or for
> clean test isolation), `uv init --package` and the `src/` layout is the upgrade path. Document the choice;
> don't drift into it.

### 8.3 Forcing non-packaged explicitly

If you have a `[build-system]` for some reason but **don't** want the project installed, force it
([dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/) `package` source;
init concepts):

```toml
[tool.uv]
package = false
```

Being explicit (`package = false`) is clearer to a reader than "infer non-packaged from the *absence* of a
`[build-system]`." Recommended for the service's `pyproject.toml`.

---

## 9. The reproducibility chain into Docker (handoff to the Docker doc)

This doc owns *declaring* and *locking*; the Docker doc owns *baking into an image*. The seam is exactly the
`--locked`/`--frozen` discipline above. Here's the chain so the Docker doc can assume it.

### 9.1 Pin the uv binary in the image

Copy a **pinned** uv from the official image — never `latest` (verbatim,
[Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)):

```dockerfile
# Pin by tag:
COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/

# Or, for maximum reproducibility, pin by SHA256 digest:
COPY --from=ghcr.io/astral-sh/uv@sha256:2381d6aa60c326b71fd40023f921a0a3b8f91b14d5db6b90402e65a635053709 /uv /uvx /bin/
```

The digest form is the strongest pin — it cannot be re-pointed by a re-tag. This is the Docker-layer
realization of [§11](#11-pin-uv-itself-the-pre-10-rule).

### 9.2 The two-stage (dependency-then-project) pattern

Install **dependencies** in one cached layer, then **project code** in a second — so editing your source
doesn't bust the dependency layer. Verbatim
([Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

COPY . /app

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked
```

Note **`--locked`** in both stages (assert lock current) and **`--no-install-project`** in the first
(install *only* dependencies; your project isn't copied yet). Verbatim flag def:
**"`--no-install-project`: Do not install the current project … By default, the current project is installed
into the environment with all of its dependencies"** ([CLI reference](https://docs.astral.sh/uv/reference/cli/)).

For **workspaces**, the docs use `--frozen` for the initial members-not-yet-present sync, then `--locked`
(verbatim, [Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)):

```dockerfile
RUN uv sync --frozen --no-install-workspace
COPY . /app
RUN uv sync --locked
```

This is the canonical legitimate use of `--frozen`: the lock is truth, but the source tree is deliberately
partial in that layer, so the metadata check `--locked` does would spuriously fail.

### 9.3 Production image: no dev deps

Strip dev/test groups and compile bytecode for the runtime image (verbatim,
[Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)):

```dockerfile
ENV UV_NO_DEV=1
ENV UV_COMPILE_BYTECODE=1

RUN uv sync --locked --compile-bytecode
```

(`UV_NO_DEV=1` == `--no-dev`; excludes `[dependency-groups]`. `UV_COMPILE_BYTECODE=1` pre-compiles `.pyc` so
the container starts faster.)

Cache/link-mode tuning for layered filesystems (same source):

```dockerfile
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,target=/root/.cache/uv uv sync
```

Multi-stage, non-editable install (copy only `.venv` to the final stage):

```dockerfile
RUN uv sync --locked --no-editable
```

### 9.4 The chain, summarized

```
.python-version (pinned interpreter)  ─┐
pyproject.toml (broad ranges)         ─┼─▶ uv.lock (exact, universal, committed)
                                       │
                pinned uv binary  ─────┤
                                       ▼
        Docker: COPY pinned uv  →  uv sync --locked --no-install-project  (deps layer, cached)
                                →  COPY source  →  uv sync --locked        (project layer)
                                →  UV_NO_DEV=1 uv sync --locked --compile-bytecode  (prod)
```

Every link is pinned: the interpreter (`.python-version`), the dependency graph (`uv.lock`), and the tool
that reads them (pinned uv). That triad is what "reproducible" means here, and `--locked` is the assertion
that the triad hasn't silently drifted. The Docker doc builds on top of this — it does not re-derive it.

---

## 10. Migrating from pip / pip-tools

Most Python services start as `requirements.txt` + a venv. The migration to a uv project is mechanical.
Full guide: [pip-to-project migration](https://docs.astral.sh/uv/guides/migration/pip-to-project/).

### 10.1 The conceptual shift

> "**From pip's model:** Multiple files manage dependencies (requirements.in, requirements.txt,
> requirements-dev.txt, platform-specific variants). **To uv's model:** Single `pyproject.toml` declares
> dependencies; single `uv.lock` locks all platforms universally; dependency groups replace separate dev
> files." — [pip-to-project migration](https://docs.astral.sh/uv/guides/migration/pip-to-project/)

### 10.2 The steps (verbatim commands)

```bash
# 1. Initialize the project (creates a baseline pyproject.toml)
uv init

# 2. Import base deps, preserving currently-locked versions via the old lock as constraints
uv add -r requirements.in -c requirements.txt

# 3. Dev deps become the dev GROUP
uv add --dev -r requirements-dev.in -c requirements-dev.txt
#   If requirements-dev.in pulls in base via '-r', strip that line first:
sed '/^-r /d' requirements-dev.in | uv add --dev -r - -c requirements-dev.txt

# 4. Other categories become named groups
uv add -r requirements-docs.in -c requirements-docs.txt --group docs
```

The `-c` (constraints) flag is the key to a *clean* migration: it pins to your currently-working versions so
"none of your dependency versions change during transition"
([pip-to-project](https://docs.astral.sh/uv/guides/migration/pip-to-project/)). You migrate the *structure*
first, upgrade versions later as a separate, reviewable `uv lock --upgrade`.

### 10.3 The command translation table

Verbatim from [pip-to-project migration](https://docs.astral.sh/uv/guides/migration/pip-to-project/):

| Old (pip / pip-tools) | New (uv) |
|---|---|
| `pip install fastapi` | `uv add fastapi` |
| `pip install -r requirements.txt` | `uv sync` |
| `pip install -r requirements-dev.txt && python -m pytest` | `uv run pytest` |
| `source .venv/bin/activate` (then run) | *(implicit)* `uv run …` |
| `requirements.in` (unversioned) | `pyproject.toml` with version specs |
| `requirements.txt` (single platform) | `uv.lock` (universal, all platforms) |
| `requirements-dev.txt` (separate file) | `[dependency-groups] dev = [...]` |
| `-e ./path` in requirements.in | `{ path = "...", editable = true }` in `[tool.uv.sources]` |

Editable / path / git deps migrate into `[tool.uv.sources]` (verbatim example,
[pip-to-project](https://docs.astral.sh/uv/guides/migration/pip-to-project/)):

```toml
[project]
dependencies = ["path-dep", "editable-path-dep", "git-dep"]

[tool.uv.sources]
path-dep = { path = "./path-dep" }
editable-path-dep = { path = "./editable-path-dep", editable = true }
git-dep = { git = "https://github.com/astral-sh/git-dep" }
```

### 10.4 Exporting to `requirements.txt` / `pylock.toml` (PEP 751)

When a downstream tool (an old deploy script, a security scanner, a non-uv consumer) needs a plain
requirements file, **export** the lock rather than abandoning it (verbatim,
[locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/)):

```bash
uv export --format requirements.txt   # classic pip-installable lock
uv export --format pylock.toml        # PEP 751 standardized lock (cross-tool)
uv export --format cyclonedx1.5       # SBOM for supply-chain scanning
```

`pylock.toml` is the emerging **PEP 751** standardized lock that *other* tools can read — your escape hatch
from "`uv.lock` is uv-specific" ([§3.4](#34-the-lockfile-is-uv-specific-and-versioned)). The canonical truth
stays `uv.lock`; exports are derived artifacts you regenerate, never hand-edit.

---

## 11. Pin uv itself — the pre-1.0 rule

`uv` is **pre-1.0** (current 0.11.24). Three of the reproducibility-relevant surfaces are tied to the **uv
binary's own version**, so the binary is part of the reproducibility contract — not just the lockfile:

1. **The lockfile `revision`.** A newer uv may write a newer `uv.lock` revision (new fields); an older uv
   reading it can churn or error. The schema is "part of the public API" but *minor* schema bumps land in
   minor releases ([versioning policy](https://docs.astral.sh/uv/reference/policies/versioning/),
   [astral-sh/uv#15220](https://github.com/astral-sh/uv/issues/15220)). See [§3.4](#34-the-lockfile-is-uv-specific-and-versioned).
2. **Resolver behavior.** Pre-1.0, resolution heuristics can change between minor versions; the same
   `pyproject.toml` could resolve slightly differently under a different uv. Pinning uv pins the resolver.
3. **The `uv_build` backend version** in packaged projects tracks the uv version
   (`requires = ["uv_build>=0.11.24,<0.12"]`, [§8.1](#81-the-rule)).

**Therefore: pin the uv version everywhere it runs** — locally (team convention / a `.tool-versions` or
`mise`/`asdf` pin if you use one `[unverified]`), in CI, and in Docker. The official CI pin (verbatim,
[GitHub Actions integration](https://docs.astral.sh/uv/guides/integration/github/)):

> "It is considered best practice to pin to a specific uv version, e.g., with:"

```yaml
- name: Install uv
  uses: astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b # v8.1.0
  with:
    version: "0.11.24"
```

And the Docker pin (verbatim, [Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)):

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:0.11.24 /uv /uvx /bin/
```

> **The asymmetry to internalize:** committing `uv.lock` pins *what* gets installed; pinning the uv binary
> pins *the tool that reads and writes that lock*. Pre-1.0, you need **both** — a pinned lock read by an
> unpinned, drifting tool is only half-reproducible. Post-1.0 the binary pin becomes a nicety; today it's
> part of the contract.

### 11.1 A complete CI job (assembled from the verbatim snippets)

```yaml
# .github/workflows/ci.yml — JPM-Markets data-analytics service
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.12", "3.13"]
    steps:
      - uses: actions/checkout@v4

      - name: Install uv (pinned)
        uses: astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b # v8.1.0
        with:
          version: "0.11.24"
          enable-cache: true            # built-in uv cache between runs

      - name: Set up Python
        run: uv python install          # respects .python-version
        # (matrix override) or set UV_PYTHON: ${{ matrix.python-version }}
        env:
          UV_PYTHON: ${{ matrix.python-version }}

      - name: Assert lockfile is current   # the reproducibility GUARD — fails on drift
        run: uv lock --check

      - name: Install (locked) with dev+test groups
        run: uv sync --locked --all-extras --dev

      - name: Lint
        run: uv run ruff check .

      - name: Type-check
        run: uv run mypy .

      - name: Test
        run: uv run pytest tests
```

(`astral-sh/setup-uv` pin, `enable-cache`, `uv python install`, `uv sync --locked --all-extras --dev`,
`uv run pytest` all verbatim from
[GitHub Actions integration](https://docs.astral.sh/uv/guides/integration/github/); `uv lock --check` from
[locking & syncing](https://docs.astral.sh/uv/concepts/projects/sync/). The `UV_PYTHON` matrix env var is the
documented multi-version approach, same GitHub integration doc.)

The two reproducibility gates in this job: **`uv lock --check`** (fail if `pyproject.toml`/`uv.lock`
diverged) and **`uv sync --locked`** (fail if not current, then install exact). Either one alone catches
drift; together they fail *early* (cheap check before the matrix) and *defensively* (the install also
asserts).

---

## 12. uv vs Poetry — why uv for v1

The data line standardizes on uv over Poetry/PDM/pip-tools for v1. The decision, with evidence:

| Axis | uv | Poetry | Verdict for the data service |
|---|---|---|---|
| **Speed** | Rust + parallel PubGrub; sub-second sync on small projects; "10–100× faster" | Python resolver; `install` 10–30s | uv — CI/Docker re-resolve cost is paid on *every* build |
| **Metadata standard** | PEP 621 `[project]` exclusively; readable by any compliant tool | Legacy `[tool.poetry]`; PEP 621 only since Poetry 2.0 (Jan 2025), many repos still legacy | uv — no proprietary metadata lock-in |
| **Lockfile** | `uv.lock`, **one file** covers Linux/macOS/Windows | `poetry.lock`; "may have incomplete hash coverage on non-native platforms" | uv — true universal lock = the laptop-vs-container guarantee |
| **Python version mgmt** | **Built in** (`uv python install 3.12`, python-build-standalone) | **Not built in** — delegates to pyenv | uv — one tool pins the interpreter *and* the deps |
| **Tool scope** | One binary replaces pyenv/pip/pip-tools/pipx/virtualenv/Poetry | Narrower; delegates Python + tool-run | uv — fewer moving parts in the reproducibility chain |
| **Dependency groups** | PEP 735 standardized | Poetry groups predate the standard (proprietary) | uv — standards-compliant, cross-tool |
| **Maturity** | **Pre-1.0** (0.11.x) — must pin the binary (§11) | Mature, 2.x | Poetry's edge; mitigated by pinning uv |
| **License** | `MIT OR Apache-2.0` | MIT | both permissive — neutral |

Evidence: [pydevtools comparison](https://pydevtools.com/handbook/explanation/how-do-uv-and-poetry-compare/),
[techplained benchmarks](https://www.techplained.com/python-uv-vs-pip-vs-poetry-vs-pdm),
[pip-to-project migration](https://docs.astral.sh/uv/guides/migration/pip-to-project/),
[python-versions concepts](https://docs.astral.sh/uv/concepts/python-versions/),
[PyPI license classifier](https://pypi.org/project/uv/).

**The one honest knock against uv is pre-1.0 status** — and it's exactly why [§11](#11-pin-uv-itself-the-pre-10-rule)
exists. With the binary pinned in CI + Docker + team config, the pre-1.0 risk collapses to "we choose when to
bump uv," which is the same opt-in posture as choosing when to `uv lock --upgrade`. Given that, uv's
universal lock + built-in Python management + PEP-621 portability + speed make it the correct v1 choice for a
greenfield data service. **Exit ramp if uv ever disappoints:** the PEP-621 `[project]` table ports to PDM /
Hatch / Poetry 2.x unchanged; only `uv.lock` would be regenerated (and `uv export --format pylock.toml`
already hands you a PEP-751 lock for the transition).

> `[unverified]` "Poetry 2.0 shipped PEP 621 support in January 2025" is per the pydevtools comparison page,
> not verified against Poetry's own changelog this session. The *direction* (Poetry adopting PEP 621 later
> than uv, with legacy projects lingering) is well-attested; the exact date should be confirmed if it becomes
> load-bearing.

---

## 13. Cheat sheet

```bash
# ── Project lifecycle ──────────────────────────────────────────────
uv init market-data-service          # new application (non-packaged, no build-system)
uv init --package svc                # packaged app (build-system + scripts + src/)
uv init --lib shared-lib             # library (build-system + py.typed + src/)

# ── Dependencies ───────────────────────────────────────────────────
uv add fastapi "pydantic>2"          # runtime deps (broad ranges → pyproject.toml)
uv add --dev ruff mypy pytest        # dev group
uv add --group lint ruff             # named group
uv remove httpx                      # drop a dep (re-locks + re-syncs)
uv add -r requirements.in -c requirements.txt   # migrate from pip, pinning current versions

# ── Lock + sync (the reproducibility core) ─────────────────────────
uv lock                              # (re)resolve → uv.lock
uv lock --check                      # ASSERT lock current (no writes) — CI gate
uv lock --upgrade                    # opt-in: bump everything to newest allowed
uv lock --upgrade-package fastapi    # bump one package
uv sync                              # materialize .venv from lock (incl. dev group)
uv sync --locked                     # ASSERT current, then install — CI/prod default
uv sync --frozen                     # install from lock, NO check — Docker layer tricks only
uv sync --no-dev                     # production install (drop dev/test groups)
uv sync --only-group lint            # just one group (e.g. lint-only CI job)

# ── Run ────────────────────────────────────────────────────────────
uv run -- uvicorn app.main:app --reload     # dev server (auto-syncs first)
uv run pytest                                # tests (env guaranteed synced)
uv run --locked pytest                       # assert lock before running

# ── Python interpreter ─────────────────────────────────────────────
uv python install 3.12.7             # install an exact interpreter (standalone build)
uv python pin 3.12.7                 # write .python-version (commit it)
uv python list                       # show available/installed

# ── Export / interop ───────────────────────────────────────────────
uv export --format requirements.txt  # derive a pip-installable lock
uv export --format pylock.toml       # PEP 751 standardized lock (cross-tool)
```

**The four rules to never break:**
1. **Commit** `uv.lock` + `.python-version` + `pyproject.toml`; **never** commit `.venv/`.
2. **`uv add`**, never hand-edit `[project.dependencies]` then forget to re-lock.
3. **`--locked`** (or `uv lock --check`) in every CI/Docker path — make drift a *failing build*, not a silent
   re-resolve.
4. **Pin the uv binary** (CI `version:`, Docker `COPY --from=ghcr.io/astral-sh/uv:0.11.24`) until uv hits 1.0.

---

## Sources

Primary (Astral docs — read this session):
- [uv projects guide](https://docs.astral.sh/uv/guides/projects/) — project structure, `uv add`/`sync`/`run`/`build`, version commands.
- [Locking & syncing concepts](https://docs.astral.sh/uv/concepts/projects/sync/) — `--locked`/`--frozen`/`--no-sync`, `uv lock --check`, exact vs inexact, groups syncing, `--upgrade`, `uv export`.
- [Dependencies concepts](https://docs.astral.sh/uv/concepts/projects/dependencies/) — PEP 508 specifiers, `[dependency-groups]` (PEP 735), extras, `[tool.uv.sources]`, default-groups, nesting, `package = false`.
- [Project layout concepts](https://docs.astral.sh/uv/concepts/projects/layout/) — `uv.lock` definition, universal/cross-platform, commit-to-VCS, uv-specific format, `.venv` exclusion.
- [Python versions concepts](https://docs.astral.sh/uv/concepts/python-versions/) — `.python-version` vs `requires-python`, `uv python install/pin/list`, python-build-standalone, discovery order.
- [Project init concepts](https://docs.astral.sh/uv/concepts/projects/init/) — application vs packaged vs library, `[build-system]` presence, `uv_build` backend.
- [pip-to-project migration guide](https://docs.astral.sh/uv/guides/migration/pip-to-project/) — `uv add -r … -c …`, requirements→groups, command translation, sources.
- [GitHub Actions integration](https://docs.astral.sh/uv/guides/integration/github/) — `astral-sh/setup-uv` pinned, `enable-cache`, `uv python install`, `uv sync --locked`, `UV_PYTHON` matrix.
- [Docker integration](https://docs.astral.sh/uv/guides/integration/docker/) — pinned uv `COPY --from`, two-stage `--no-install-project`, `--locked`/`--frozen`, `UV_NO_DEV`/`UV_COMPILE_BYTECODE`/`UV_LINK_MODE`.
- [CLI reference](https://docs.astral.sh/uv/reference/cli/) — verbatim `--locked`/`--frozen`/`--no-sync`/`--no-install-project` definitions.
- [Versioning policy](https://docs.astral.sh/uv/reference/policies/versioning/) — lockfile schema as public API, pre-1.0 stance.

Version / license / release:
- [pypi.org/project/uv](https://pypi.org/project/uv/) — uv **0.11.24** (2026-06-23), license **`MIT OR Apache-2.0`**, Python 3.8–3.15.
- [astral-sh/uv releases](https://github.com/astral-sh/uv/releases) — 0.11.x release cadence (0.11.23 on 2026-06-19, 0.11.24 on 2026-06-23).
- [astral-sh/uv#15220](https://github.com/astral-sh/uv/issues/15220) — lockfile `version`/`revision` fields, `uv lock --force`.
- [deepwiki: uv lockfile management](https://deepwiki.com/astral-sh/uv/7.2-lockfile-management) — lockfile version/revision semantics (secondary).

Comparison (secondary — benchmarks/claims, treat numbers as order-of-magnitude):
- [pydevtools: how do uv and Poetry compare](https://pydevtools.com/handbook/explanation/how-do-uv-and-poetry-compare/).
- [techplained: uv vs pip vs Poetry vs PDM benchmarks 2026](https://www.techplained.com/python-uv-vs-pip-vs-poetry-vs-pdm).
