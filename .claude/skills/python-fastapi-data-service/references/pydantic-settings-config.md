# patterns-pydantic-settings-config — typed configuration & secrets as the single source of truth

> **Scope.** Typed configuration & secrets for the **JPM-Markets re-engineering data-analytics
> product line (NOT Lumina)** — a Python / FastAPI / data-engineering service. One validated
> `Settings` object (pydantic-settings v2 `BaseSettings`), env precedence, nested settings models,
> fail-fast startup, and a `@lru_cache get_settings()` dependency that is overridable in tests.
> This is the config **source of truth**: every module reads config through it, nothing reads
> `os.environ` directly.
>
> **This is a `patterns-*` recipe** (concrete build), not generic theory. It assumes you are
> building the FastAPI data-service described by `SKILL.md`. It pins exact versions and quotes
> primary docs + library source inline.

**Pinned versions (verify before building — this line moves fast):**

- `pydantic-settings` **2.14.2**, released **2026-06-19**, requires **Python ≥ 3.10** (supports
  3.10–3.14), built for **Pydantic v2**. — [PyPI: pydantic-settings](https://pypi.org/project/pydantic-settings/)
- `pydantic` v2 (any current 2.x). pydantic-settings is a **separate package** from `pydantic` — it
  was split out of pydantic-v1's `pydantic.BaseSettings` and now ships independently.
- Install: `pip install pydantic-settings` (or `uv add pydantic-settings`). It is **not** pulled in
  by `pip install pydantic` — installing pydantic alone and importing `from pydantic import
  BaseSettings` raises a `PydanticImportError` telling you to install `pydantic-settings`.

---

## 0. Why this exists — the one-sentence contract

> **Every configuration value and every secret enters the process through exactly one validated
> `Settings` object, constructed once at startup; if a required value is missing or the wrong type,
> the process refuses to start.**

This kills four classes of production incident, each of which is otherwise invisible in a 1× demo
and lethal at 100×/10,000×:

1. **The `KeyError` at 3am** — `os.environ["DATABASE_URL"]` deep in a request handler, only hit on
   the one code path nobody tested. With `BaseSettings`, a missing required field is a startup
   crash, not a runtime 500 three hours into the deploy.
2. **The silent string-typed port** — `int(os.environ.get("PORT", "8000"))` scattered in 12 files,
   one of which forgot the `int(`. pydantic coerces and validates types **once**, centrally.
3. **The leaked secret** — a real `DATABASE_URL` with a password committed in `config.py` or a
   `.env` that slipped past `.gitignore`. The discipline below (real values only ever in the
   environment / a secrets dir, `.env` for local non-secret defaults, `.env` gitignored,
   `.env.example` committed) makes the leak structurally hard.
4. **The drifting config** — three modules each with their own idea of the Redis URL. One object,
   injected everywhere, means one answer.

---

## 1. The default precedence order — memorize it, it is load-bearing

When you construct `Settings()`, pydantic-settings merges values from multiple **sources**. The
default priority, **highest wins**, is (quoting the primary docs verbatim):

> "1. If `cli_parse_args` is enabled, arguments passed in at the CLI. 2. Arguments passed to the
> `Settings` class initialiser. 3. Environment variables... 4. Variables loaded from a dotenv
> (`.env`) file. 5. Variables loaded from the secrets directory. 6. The default field values for the
> `Settings` model."
> — [pydantic-settings docs, Settings Management](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)

So, top to bottom:

| Rank | Source | Class | In our build |
|---|---|---|---|
| 1 (highest) | CLI args (if `cli_parse_args=True`) | `CliSettingsSource` | off by default; useful for an admin CLI |
| 2 | **init kwargs** `Settings(foo=...)` | `InitSettingsSource` | **how tests inject overrides** |
| 3 | **environment variables** (`os.environ`) | `EnvSettingsSource` | **how Fly/Docker injects prod** |
| 4 | **`.env` file** | `DotEnvSettingsSource` | **local-dev defaults only** |
| 5 | **secrets dir** (one file per secret) | `SecretsSettingsSource` | Docker/K8s/Fly file-mounted secrets |
| 6 (lowest) | field **defaults** in the model | `DefaultSettingsSource` | the safe baseline |

**Two consequences that catch people:**

- **A real environment variable beats `.env`.** This is exactly what you want: `.env` holds local
  defaults; on Fly the platform-injected env var overrides them. The docs state it plainly: env vars
  "will always take priority over values loaded from a dotenv file," and both "take priority over
  values loaded from the secrets directory."
- **`.env` and env vars beat the secrets dir.** If you mount a Docker secret *and* also set the same
  name as an env var, the env var wins. Keep these non-overlapping to avoid confusion.

### How the precedence is actually implemented (source-level, so you trust it)

In `pydantic_settings/main.py`, `settings_customise_sources` returns the default tuple **in priority
order, first = highest**:

```python
# pydantic_settings/main.py — default ordering
return init_settings, env_settings, dotenv_settings, file_secret_settings
```

`_settings_init_sources` appends the defaults source at the end (lowest priority):

```python
sources = cls.settings_customise_sources(...) + (default_settings,)
```

Then `_settings_build_values` folds them with `deep_update`, **iterating in order so the first
source's values survive**:

```python
# simplified from pydantic_settings/main.py
for source in sources:
    source_state = source()
    state = deep_update(source_state, state)   # `state` (already-higher-priority) wins
```

`deep_update(source_state, state)` writes `source_state` first, then overlays the
already-accumulated `state` on top — so values from **earlier (higher-priority) sources persist
through subsequent updates**. Net: **the first source in the tuple has the highest priority.**
(Verified against `pydantic_settings/main.py@main`.)

You almost never need to touch this. But knowing it means you can confidently override it (§9).

---

## 2. The base recipe — one `Settings`, instantiated once

This is the file every other module imports. In our service, put it at `app/config.py`.

```python
# app/config.py
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",                 # local-dev defaults; absent in prod, that's fine
        env_file_encoding="utf-8",
        env_prefix="",                   # set e.g. "APP_" to namespace all vars (see §5)
        env_nested_delimiter="__",       # APP__DB__HOST -> db.host  (see §6)
        secrets_dir="/run/secrets",      # Docker/K8s/Fly file secrets (see §7)
        case_sensitive=False,            # DB_HOST and db_host both match `db_host`
        extra="ignore",                  # see the WARNING below — DO NOT use the BaseSettings default here
        validate_default=True,           # already the BaseSettings default; validate even defaults
    )

    # --- required (no default) -> FAIL FAST if missing ---
    database_url: str                    # the process will not start without this
    redis_url: str

    # --- optional with safe defaults ---
    app_name: str = "markets-data-service"
    environment: str = "local"           # "local" | "staging" | "production"
    log_level: str = "INFO"
    port: int = 8000                     # coerced from the string env var, validated as int
    request_timeout_s: float = 10.0

    # --- a secret with an alias that reads a conventional env name ---
    twelvedata_api_key: str | None = Field(
        default=None, validation_alias="TWELVEDATA_API_KEY"
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The single config source of truth. Constructed once; cached forever.

    Read once (disk/env access is slow), cache the result, hand the SAME object to
    everyone via FastAPI's dependency injection. Override in tests with
    app.dependency_overrides + get_settings.cache_clear().
    """
    return Settings()
```

> **WARNING — `extra` default for `BaseSettings` is `'forbid'`, not `'ignore'`.** Verified in
> `pydantic_settings/main.py@main`: `BaseSettings.model_config` ships
> `extra='forbid', arbitrary_types_allowed=True, validate_default=True, case_sensitive=False,
> enable_decoding=True`. With `extra='forbid'`, **any** unrelated environment variable whose name
> matches a field-shaped pattern can raise a `ValidationError` — and worse, in environments like
> CI/Docker the process inherits dozens of unrelated env vars. In practice you almost always want
> `extra="ignore"` on a `BaseSettings` so the universe of ambient env vars (`PATH`, `HOME`,
> `FLY_*`, etc.) doesn't trip startup. Set it **explicitly** — do not rely on the default.
> (`extra='ignore'` tells pydantic to drop keys that don't map to a field;
> `'forbid'` rejects them; `'allow'` keeps them as extra attributes.)

**Why `@lru_cache(maxsize=1)`** — straight from the FastAPI docs:

> "Reading a file from disk is normally a costly (slow) operation, so you probably want to do it only
> once... [`@lru_cache`] will return the same value that was returned the first time, instead of
> computing it again... the `Settings` object will be created only once, the first time it's
> called." — [FastAPI: Settings and Environment Variables](https://fastapi.tiangolo.com/advanced/settings/)

`maxsize=1` is intentional: there is exactly one settings object; we are using `lru_cache` as a
**typed, thread-safe, lazy singleton**, not as a cache with many keys. `get_settings()` takes no
arguments, so one cache slot is all that can ever be used — but stating `maxsize=1` documents intent.

---

## 3. Fail-fast at startup — the whole point

A **required field** is one declared with **no default** (and not `Optional`). If its value is
absent from every source, `Settings()` raises `pydantic.ValidationError`. We want that error to
happen **at process boot**, not on the first request that touches the field.

### Force construction at import/startup

`get_settings()` is lazy. To fail fast, **call it during application startup**, before the server
accepts traffic. The FastAPI **lifespan** is the right hook:

```python
# app/main.py
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Construct + validate the Settings object BEFORE serving the first request.
    # A missing/invalid required field raises pydantic.ValidationError here and the
    # process exits non-zero -> the orchestrator (Fly/K8s) reports a failed deploy
    # instead of serving 500s.
    settings = get_settings()
    app.state.settings = settings  # optional convenience handle
    # ... open DB pool, redis pool, etc. using `settings` ...
    yield
    # ... close pools ...


app = FastAPI(lifespan=lifespan)
```

If you skip the lifespan and let the first request construct settings, a missing var becomes a
runtime 500 during traffic. With the lifespan call, a bad config is a **clean failed deploy** — Fly
keeps the previous healthy version running. That is the difference between "deploy rejected, old
version still up" and "new version live and 500ing."

### What a missing required field looks like

```
pydantic_core._pydantic_core.ValidationError: 2 validation errors for Settings
database_url
  Field required [type=missing, input_value={...}, input_type=dict]
redis_url
  Field required [type=missing, input_value={...}, input_type=dict]
```

Clear, names the exact fields, exits non-zero. This is the behavior we are buying.

### Required vs optional — the type *is* the policy

```python
class Settings(BaseSettings):
    database_url: str                 # REQUIRED — no default -> fail fast
    sentry_dsn: str | None = None     # OPTIONAL — explicit None default, feature simply off
    cache_ttl_s: int = 300            # OPTIONAL with a real default
```

Rule of thumb: **if the service cannot function correctly without it, make it required (no
default).** If the service degrades gracefully without it (an optional integration, a tunable),
give it a default. Never give a *secret* a placeholder default like `"changeme"` — that converts a
loud startup failure into a silent wrong-credentials failure.

### Cross-field validation at startup with `model_validator`

Some invariants span fields (e.g. "in production, `debug` must be off; `database_url` must not point
at localhost"). Enforce them at construction so they also fail fast:

```python
from pydantic import model_validator
from typing_extensions import Self


class Settings(BaseSettings):
    environment: str = "local"
    debug: bool = False
    database_url: str

    @model_validator(mode="after")
    def _guard_production(self) -> Self:
        if self.environment == "production":
            if self.debug:
                raise ValueError("debug must be False in production")
            if "localhost" in self.database_url or "127.0.0.1" in self.database_url:
                raise ValueError("production database_url points at localhost")
        return self
```

`mode="after"` runs once the object is fully built and typed, so you compare real values. A raised
`ValueError` becomes part of the same startup `ValidationError`.

---

## 4. All the `SettingsConfigDict` fields that matter

`SettingsConfigDict` is a `TypedDict` extending pydantic's `ConfigDict`. Below are the fields you
actually use for a data-service, with **verified defaults** (from `pydantic_settings/main.py@main`,
`BaseSettings.model_config`).

| Field | Type | Default | What it does |
|---|---|---|---|
| `env_file` | `str \| Path \| list \| None` | `None` | dotenv path(s). A list loads in order, **later overrides earlier**. |
| `env_file_encoding` | `str \| None` | `None` | encoding for the dotenv file(s); use `"utf-8"`. |
| `env_prefix` | `str` | `''` | prepended to every env-var name this model reads (§5). |
| `env_prefix_target` | `'variable' \| 'all'` | `'variable'` | whether the prefix also applies to aliased fields (§5). |
| `env_nested_delimiter` | `str \| None` | `None` | splits env names into nested models, e.g. `__` (§6). |
| `env_nested_max_split` | `int \| None` | `None` | caps how many times a name is split — needed when field names contain the delimiter (§6). |
| `env_ignore_empty` | `bool` | `False` | if `True`, an empty-string env var is treated as **unset** (falls through to lower-priority sources). |
| `env_parse_none_str` | `str \| None` | `None` | a literal string (e.g. `"null"`) that parses to `None`. |
| `env_parse_enums` | `bool \| None` | `None` | parse enum **names** from env strings. |
| `secrets_dir` | `str \| Path \| seq \| None` | `None` | directory(ies) of one-file-per-secret (§7). |
| `case_sensitive` | `bool` | `False` | if `False`, env names match fields case-insensitively. |
| `extra` | `'ignore' \| 'allow' \| 'forbid'` | `'forbid'` ⚠️ | behavior for env vars that don't map to a field. **Set to `'ignore'`** (§2 warning). |
| `validate_default` | `bool` | `True` | validate default values too (already on for `BaseSettings`). |
| `nested_model_default_partial_update` | `bool` | `False` | merge partial nested overrides onto a nested model's default instead of requiring the whole object (§6). |
| `enable_decoding` | `bool` | `True` | JSON-decode complex types (list/dict/model) from env strings (§8). |
| `cli_parse_args` | `bool \| ...` | `False` | turn on CLI args as the top-priority source. |

Plus file-source-specific fields you'll only meet if you add those sources (§9): `yaml_config_section`,
`pyproject_toml_depth`, `pyproject_toml_table_header`. (Verified against the
[API reference](https://docs.pydantic.dev/latest/api/pydantic_settings/).)

---

## 5. `env_prefix` — namespacing your variables

A bare field `database_url` reads the env var `DATABASE_URL` (case-insensitive). Set
`env_prefix="MKT_"` and it reads `MKT_DATABASE_URL` instead. This is how you avoid colliding with
ambient platform variables and how you signal "these belong to my service."

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MKT_")
    database_url: str        # reads env var MKT_DATABASE_URL
    port: int = 8000         # reads env var MKT_PORT
```

**Prefix + alias interaction.** By default (`env_prefix_target='variable'`) the prefix is applied to
the **field name** but **not** to an explicit `alias`/`validation_alias`. Quoting the docs:

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='TARGET_')
    foo: str = Field(alias='FooAlias')   # reads FooAlias (NO prefix)
    bar: str                             # reads TARGET_BAR (prefix applied)
```

Set `env_prefix_target='all'` to apply the prefix to aliases too (`TARGET_FooAlias`). Most teams
keep the default and reserve aliases for "read this specific conventional name regardless of prefix"
(e.g. the upstream's own `TWELVEDATA_API_KEY`).

— [pydantic-settings docs, env_prefix](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)

---

## 6. Nested settings models — structure your config the way your service is structured

A flat `Settings` with 40 fields rots. Group related config into nested `BaseModel`s — one per
subsystem (DB, Redis, object store, each provider). pydantic-settings maps nested env vars onto them
via `env_nested_delimiter`.

```python
# app/config.py
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseModel):
    host: str = "localhost"
    port: int = 5432
    name: str = "markets"
    user: str = "postgres"
    password: str = ""                       # from a secret in prod (see §7)
    pool_min: int = 2
    pool_max: int = 16

    @property
    def dsn(self) -> str:
        return (
            f"postgresql://{self.user}:{self.password}"
            f"@{self.host}:{self.port}/{self.name}"
        )


class RedisSettings(BaseModel):
    url: str = "redis://localhost:6379/0"
    max_connections: int = 20


class ObjectStoreSettings(BaseModel):
    endpoint_url: str | None = None          # e.g. an S3-compatible endpoint
    bucket: str = "market-data"
    access_key_id: str = ""
    secret_access_key: str = ""              # secret


class ProviderKeys(BaseModel):
    twelvedata: str | None = None
    finnhub: str | None = None
    coingecko: str | None = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_nested_delimiter="__",           # the splitter for nested names
        env_prefix="MKT_",
        extra="ignore",
        case_sensitive=False,
        nested_model_default_partial_update=True,   # see the note below
    )

    environment: str = "local"
    db: DatabaseSettings = DatabaseSettings()
    redis: RedisSettings = RedisSettings()
    object_store: ObjectStoreSettings = ObjectStoreSettings()
    providers: ProviderKeys = ProviderKeys()
```

With `env_prefix="MKT_"` and `env_nested_delimiter="__"`, the environment maps like this:

```bash
MKT_ENVIRONMENT=production
MKT_DB__HOST=db.internal
MKT_DB__PORT=5432
MKT_DB__PASSWORD=...        # better: a secret file, see §7
MKT_REDIS__URL=redis://default:...@redis.internal:6379/0
MKT_OBJECT_STORE__BUCKET=market-data-prod
MKT_PROVIDERS__TWELVEDATA=...
```

Read in code:

```python
settings = get_settings()
settings.db.host          # "db.internal"
settings.db.dsn           # the assembled postgresql:// DSN
settings.redis.url
settings.providers.twelvedata
```

### How nested parsing actually works (with the JSON-override subtlety)

From the docs, a nested env var can be set **either** as a single JSON blob on the parent **or**
field-by-field with the delimiter, and **the field-level vars override the JSON**:

```python
class DeepSubModel(BaseModel):
    v4: str

class SubModel(BaseModel):
    v1: str
    v2: bytes
    v3: int
    deep: DeepSubModel

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_nested_delimiter='__')
    v0: str
    sub_model: SubModel

# env:
#   V0=0
#   SUB_MODEL='{"v1": "json-1", "v2": "json-2"}'
#   SUB_MODEL__V2=nested-2
#   SUB_MODEL__V3=3
#   SUB_MODEL__DEEP__V4=v4
#
# result:
# {'v0': '0', 'sub_model': {'v1': 'json-1', 'v2': b'nested-2',
#                           'v3': 3, 'deep': {'v4': 'v4'}}}
```

> "Nested environment variables take precedence over the top-level environment variable JSON."
> — [pydantic-settings docs, nested env vars](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)

### `env_nested_max_split` — when your field names contain the delimiter

If you use `_` as the delimiter (not recommended; prefer `__`) and a field is named `max_split`, the
parser can't tell where the path ends. Cap the split count:

```python
class LLMConfig(BaseModel):
    model_name: str

class GenerationConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_nested_delimiter='_',
        env_nested_max_split=1,     # split on the FIRST `_` only
        env_prefix='GENERATION_',
    )
    llm: LLMConfig
# GENERATION_LLM_MODEL_NAME=gpt-4  ->  llm.model_name = "gpt-4"
```

**Best practice: use `__` (double underscore) as the delimiter.** Single `_` collides with the
underscores already in field names; `__` is unambiguous and is the community convention.

### `nested_model_default_partial_update` — override one nested field without restating the whole model

By default, if a nested model has a default instance, setting one nested env var **replaces the
whole nested object**, dropping the other defaults — a classic footgun (see
[pydantic-settings#154](https://github.com/pydantic/pydantic-settings/issues/154)). Set
`nested_model_default_partial_update=True` so a partial override **merges** onto the default:

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_nested_delimiter="__",
        nested_model_default_partial_update=True,
    )
    db: DatabaseSettings = DatabaseSettings()   # has its own field defaults

# With partial update ON:
#   MKT...DB__HOST=db.internal
#   -> db.host = "db.internal", db.port still 5432, db.pool_max still 16  ✓
# With it OFF (default):
#   the same single override could leave the other db.* fields unset/default-stripped.
```

For a data-service with richly-defaulted nested config, **turn this on.**

---

## 7. Secrets — from the environment / a secrets dir, **never** committed

### The principle (12-factor)

> "The twelve-factor app stores config in environment variables... env vars are easy to change
> between deploys without changing any code; unlike config files, there is little chance of them
> being checked into the code repo accidentally." — [12factor.net/config](https://12factor.net/config)
>
> "Always commit `.env.example`, never commit `.env`." — config best-practice consensus.

Rules for this service:

1. **Real secret values live in the environment (Fly secrets) or a mounted secrets dir.** Never in
   `config.py`, never in a committed `.env`, never as a field default.
2. **`.env` is gitignored and holds local-dev defaults only** — non-secret, or throwaway local
   passwords for a docker-compose Postgres that never leaves your laptop.
3. **`.env.example` is committed** — every key with a placeholder, no real value. It is the
   documentation of "what this service needs to run."
4. **A secret has no default, or a `None` default** — so a missing prod secret fails fast (§3), and
   so it can never silently fall back to a baked-in value.

### `.gitignore` / `.env.example`

```gitignore
# .gitignore
.env
.env.*
!.env.example
```

```dotenv
# .env.example  (committed — placeholders only)
MKT_ENVIRONMENT=local
MKT_DB__HOST=localhost
MKT_DB__PORT=5432
MKT_DB__USER=postgres
MKT_DB__PASSWORD=__set_locally__
MKT_REDIS__URL=redis://localhost:6379/0
MKT_PROVIDERS__TWELVEDATA=__your_key_here__
```

### Secrets dir — one file per secret (Docker / K8s / Fly volumes)

`secrets_dir` points at a directory where **each file's name is the field name and its contents are
the value**. This is the Docker/Kubernetes secrets convention.

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(secrets_dir="/run/secrets")
    database_password: str
```

```
/run/secrets/
  database_password        # file contents: "super_secret_password"
```

**Nested secrets** use the same delimiter in the filename:

```
/run/secrets/
  db__password             # -> settings.db.password
  object_store__secret_access_key
```

**Multiple secrets dirs** — pass a tuple; **later paths override earlier**:

```python
model_config = SettingsConfigDict(secrets_dir=("/var/run", "/run/secrets"))
```

> The secrets dir sits **below** env vars and `.env` in precedence (§1) — an env var of the same name
> wins. Keep your secret names exclusive to one mechanism. — [pydantic-settings docs, secrets](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)

A **missing** `secrets_dir` is silently ignored (so the same `Settings` works locally where
`/run/secrets` doesn't exist); a path that exists but **isn't a directory** raises.

### `SecretStr` — don't leak secrets into logs

Type secret fields as `pydantic.SecretStr` so they don't render in `repr()`/log lines / tracebacks:

```python
from pydantic import SecretStr

class Settings(BaseSettings):
    twelvedata_api_key: SecretStr | None = None

s = get_settings()
print(s)                              # twelvedata_api_key=SecretStr('**********')
s.twelvedata_api_key.get_secret_value()   # the real string, only when you ask
```

This is the difference between a stray `logger.info(settings)` being harmless vs. shipping your API
key to your log aggregator. Use `SecretStr` for every credential.

---

## 8. Parsing complex / list / dict values from env

pydantic-settings **JSON-decodes** complex-typed fields from their env string by default
(`enable_decoding=True`):

```python
class Settings(BaseSettings):
    allowed_origins: list[str]
    rate_limits: dict[str, int]

# env:
#   ALLOWED_ORIGINS=["https://a.example","https://b.example"]
#   RATE_LIMITS={"default": 100, "premium": 1000}
```

If you'd rather take comma-separated input, disable JSON decoding and supply a `before` validator —
globally with `enable_decoding=False`, or per-field with the `NoDecode` annotation:

```python
from typing import Annotated
from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode

class Settings(BaseSettings):
    symbols: Annotated[list[str], NoDecode]

    @field_validator("symbols", mode="before")
    @classmethod
    def _split(cls, v: str) -> list[str]:
        return [s.strip() for s in v.split(",")]

# env: SYMBOLS=AAPL,MSFT,GOOG  ->  ["AAPL","MSFT","GOOG"]
```

The inverse — force JSON parsing on one field while `enable_decoding=False` globally — is the
`ForceDecode` annotation. (Both `NoDecode`/`ForceDecode` are importable from `pydantic_settings`.)
— [pydantic-settings docs, parsing](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)

---

## 9. Customising sources — add TOML/YAML, reorder, or disable

Override `settings_customise_sources` (a classmethod) to change the source set. The five params are
fixed; return a tuple **in priority order (first = highest)**.

**Add a TOML config file as a low-priority source** (e.g. a committed `config.toml` of non-secret
defaults, overridden by env in prod):

```python
from pydantic_settings import (
    BaseSettings, PydanticBaseSettingsSource, TomlConfigSettingsSource, SettingsConfigDict,
)

class Settings(BaseSettings):
    model_config = SettingsConfigDict(toml_file="config.toml")
    app_name: str
    port: int = 8000

    @classmethod
    def settings_customise_sources(
        cls, settings_cls,
        init_settings, env_settings, dotenv_settings, file_secret_settings,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # init > env > dotenv > secrets > TOML(defaults)
        return (
            init_settings, env_settings, dotenv_settings,
            file_secret_settings, TomlConfigSettingsSource(settings_cls),
        )
```

Built-in file sources you can drop in: `JsonConfigSettingsSource`, `YamlConfigSettingsSource`,
`TomlConfigSettingsSource`, `PyprojectTomlConfigSettingsSource`, plus
`GoogleSecretManagerSettingsSource` (GCP). — [API reference](https://docs.pydantic.dev/latest/api/pydantic_settings/)

**Disable a source** by omitting it. To ignore `.env` entirely (e.g. in CI where only env vars
should count):

```python
@classmethod
def settings_customise_sources(cls, settings_cls, init_settings,
                               env_settings, dotenv_settings, file_secret_settings):
    return init_settings, env_settings, file_secret_settings   # dotenv dropped
```

**Reorder** (rarely needed) — e.g. make env beat init:

```python
return env_settings, init_settings, file_secret_settings
```

> Do this only with a documented reason. The default order (init > env > dotenv > secrets >
> defaults) is correct for ~99% of services and is what tests assume.

For a data-service that wants config from a **single global default object plus per-deploy env
overrides**, the default sources are exactly right — you rarely customise here. The most common real
use is adding a TOML/YAML defaults file for the long tail of tunables you don't want as 40 env vars.

---

## 10. The FastAPI dependency wiring — inject, never import the instance

**Never** do `from app.config import settings` where `settings = Settings()` at module top level.
That constructs settings at import time (defeats the lifespan fail-fast hook, and is impossible to
override in tests). Always go through `get_settings()` as a **dependency**.

```python
# app/deps.py
from typing import Annotated
from fastapi import Depends
from app.config import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]
```

```python
# app/routers/quotes.py
from fastapi import APIRouter
from app.deps import SettingsDep

router = APIRouter()

@router.get("/health")
async def health(settings: SettingsDep):
    return {"app": settings.app_name, "env": settings.environment}
```

— pattern and the `Annotated[Settings, Depends(get_settings)]` form are
[straight from the FastAPI docs](https://fastapi.tiangolo.com/advanced/settings/).

### Using settings to build other singletons (DB/Redis pools)

The pools also depend on settings; build them once in the lifespan and stash on `app.state`, then
expose them as their own dependencies:

```python
# app/main.py (lifespan, continued)
import asyncpg
from app.config import get_settings

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()                     # fail-fast validation here
    app.state.settings = settings
    app.state.pg_pool = await asyncpg.create_pool(
        dsn=settings.db.dsn, min_size=settings.db.pool_min, max_size=settings.db.pool_max,
    )
    yield
    await app.state.pg_pool.close()
```

```python
# app/deps.py
from fastapi import Request
def get_pg_pool(request: Request):
    return request.app.state.pg_pool
PgPool = Annotated["asyncpg.Pool", Depends(get_pg_pool)]
```

Config flows **once** from `Settings` -> the pools -> the handlers. There is exactly one place each
value is read.

---

## 11. Overriding settings in tests — two mechanisms, know when to use each

### A) `app.dependency_overrides` — override per-request injection

The cleanest way to give a route a different `Settings` is to replace the **dependency**, not the
environment. From the FastAPI docs:

```python
# tests/test_info.py
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import app, get_settings

def get_settings_override():
    return Settings(admin_email="testing_admin@example.com")

app.dependency_overrides[get_settings] = get_settings_override
client = TestClient(app)

def test_app():
    data = client.get("/info").json()
    assert data["admin_email"] == "testing_admin@example.com"
```

This bypasses `lru_cache` entirely for routes (FastAPI calls the override, not `get_settings`), and
**doesn't touch global env state** — so tests don't leak into each other. Prefer this for
route-level tests. Reset with `app.dependency_overrides.clear()` in a fixture teardown.

> Note `Settings(admin_email=...)` uses **init kwargs** — the highest-priority source (§1) — so the
> override is honored regardless of what's in the env/`.env`.

### B) `monkeypatch.setenv` + `get_settings.cache_clear()` — when you must exercise the parsing

When the thing under test **is** the settings-loading logic (precedence, nested parsing, a validator),
set the env and bust the cache so a fresh `Settings()` is constructed:

```python
# tests/test_config.py
import pytest
from app.config import get_settings, Settings

@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()        # before
    yield
    get_settings.cache_clear()        # after — don't leak a cached object across tests

def test_required_field_fails_fast(monkeypatch):
    monkeypatch.delenv("MKT_DATABASE_URL", raising=False)
    monkeypatch.setenv("MKT_REDIS__URL", "redis://localhost:6379/0")
    with pytest.raises(Exception):    # pydantic.ValidationError
        Settings(_env_file=None)      # _env_file=None -> ignore .env, test pure env

def test_nested_override(monkeypatch):
    monkeypatch.setenv("MKT_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("MKT_REDIS__URL", "redis://localhost:6379/0")
    monkeypatch.setenv("MKT_DB__HOST", "override.internal")
    get_settings.cache_clear()
    assert get_settings().db.host == "override.internal"
```

**Key test-only init args** (underscore-prefixed, supported by `BaseSettings.__init__`):

- `Settings(_env_file=None)` — **load no dotenv file**, so the test sees only real env vars.
- `Settings(_env_file="tests/fixtures/test.env")` — load a specific dotenv for the test.
- `Settings(_secrets_dir=tmp_path)` — point the secrets dir at a pytest `tmp_path` you populated.
- `Settings(_env_file_encoding="utf-8")`.

> **The cache-clear discipline is mandatory.** `@lru_cache` makes `get_settings()` a singleton; a
> test that changes the env but forgets `cache_clear()` will silently get the **previous** test's
> object. The `autouse` fixture above clears before and after every test — make it a habit.

---

## 12. How Fly / Docker env maps onto `Settings` — the local/prod split

The whole design rests on **one split**: `.env` for local, **real environment** for deployed.

### Local development

- `.env` (gitignored) provides defaults; `DotEnvSettingsSource` reads it.
- You run `uvicorn app.main:app --reload`; `Settings()` reads `.env` + your shell env.
- Local secrets are throwaway (a docker-compose Postgres password that never leaves the laptop).

### Docker / docker-compose

- **Build-time:** never `COPY .env` into the image and never bake secrets into layers (they persist
  in image history). The image is config-free.
- **Run-time:** inject via `environment:` / `env_file:` in compose, or `-e` flags, or **Docker
  secrets** mounted at `/run/secrets/<name>` (matches our `secrets_dir`).

```yaml
# docker-compose.yml (excerpt)
services:
  api:
    image: markets-data-service
    environment:
      MKT_ENVIRONMENT: production
      MKT_DB__HOST: db
      MKT_REDIS__URL: redis://redis:6379/0
    secrets:
      - db__password           # mounted at /run/secrets/db__password -> settings.db.password
secrets:
  db__password:
    file: ./secrets/db_password.txt
```

Because **env vars outrank `.env` outrank the secrets dir** (§1), you can layer: image-level
defaults, compose env overrides, file secrets for the credentials.

### Fly.io

Fly has **two** mechanisms, and they map onto two of our sources:

1. **Non-secret config → `[env]` in `fly.toml`** (committed, visible, plain env vars):

   ```toml
   # fly.toml
   [env]
     MKT_ENVIRONMENT = "production"
     MKT_PORT = "8080"
     MKT_DB__HOST = "markets-db.internal"
     MKT_REDIS__URL = "redis://markets-redis.internal:6379/0"
   ```

2. **Secrets → `fly secrets set`** (encrypted vault, injected as env vars at boot):

   ```bash
   fly secrets set MKT_DB__PASSWORD=... MKT_PROVIDERS__TWELVEDATA=...
   ```

   > "An app's secrets are available as **environment variables at runtime** on every Machine...
   > injected into your Machine as environment variables at boot time." — [Fly.io: Secrets and Fly
   > Apps](https://fly.io/docs/apps/secrets/)

   So on Fly, **both** `[env]` and `fly secrets` arrive as **environment variables** — which means
   both are read by `EnvSettingsSource` (precedence rank 3), above any `.env`. You do **not** ship a
   `.env` to Fly; there is no `.env` in the deployed image. `DotEnvSettingsSource` simply finds no
   file and contributes nothing. That's the intended behavior — the same `Settings` class works in
   both worlds.

   > `fly secrets set` "updates each Machine... [with] a restart of the Machine." Because settings
   > are read once at boot, a secret change requires that restart to take effect — which Fly does
   > automatically. Use `fly secrets set --stage` + `fly deploy` to batch a secret change into a
   > deploy. — [Fly.io secrets](https://fly.io/docs/apps/secrets/)

| Fly mechanism | Arrives as | pydantic source / rank | Use for |
|---|---|---|---|
| `[env]` in `fly.toml` | env var | `EnvSettingsSource` (3) | non-secret per-deploy config |
| `fly secrets set` | env var (encrypted vault → boot) | `EnvSettingsSource` (3) | credentials, API keys |
| (local) `.env` | dotenv file | `DotEnvSettingsSource` (4) | local-dev only; not shipped |

**The net rule:** in production, *everything* comes through the environment (whether `[env]` or
`fly secrets`); locally, the same names come through `.env`. One `Settings` class, two delivery
mechanisms, identical field names.

---

## 13. One global `Settings` vs. per-module settings

A real question for a multi-module data-service: one big `Settings`, or several smaller ones?

**Default: ONE `Settings` with nested sub-models (§6).** Reasons:

- **Single fail-fast point.** Constructing one object at startup validates *all* config at once. N
  separate settings objects = N places a missing var can surprise you, and possibly later than boot.
- **One precedence story.** Same env/`.env`/secrets rules apply uniformly. Per-module objects can
  drift into inconsistent `env_prefix`/`case_sensitive` configs.
- **One injection point.** `SettingsDep` everywhere; `settings.db`, `settings.redis`,
  `settings.providers` give you the namespacing without the fragmentation.

**When to split** — only when a module is **genuinely independent and separately deployable** (a
true microservice boundary, not just a Python package). Then it gets its own `Settings` with its own
`env_prefix`, and the boundary is real. Inside one deployable service, **nested sub-models, not
separate `BaseSettings` classes.**

A reasonable middle ground for very large config: keep one `Settings`, but let each subsystem define
its own nested `BaseModel` in its own module (`app/db/config.py` exports `DatabaseSettings`), and
the root `Settings` composes them. You get module ownership of fields **and** one validated object.

---

## 14. Anti-patterns — mistake → fix

| Mistake | Why it bites | Fix |
|---|---|---|
| `os.environ["DATABASE_URL"]` scattered in handlers | `KeyError` at runtime on an untested path; no type coercion; no central list of required config | one `Settings` model with a required `database_url: str`; inject `SettingsDep` |
| `settings = Settings()` at module top level | constructs at import (before lifespan), un-overridable in tests | `@lru_cache def get_settings()`; call it in lifespan; inject as a dependency |
| Relying on `BaseSettings` default `extra='forbid'` | ambient env vars (PATH, FLY_*, CI vars) trip `ValidationError` at boot | set `extra="ignore"` explicitly in `SettingsConfigDict` |
| Secret with a default like `api_key: str = "changeme"` | a missing prod secret silently uses the placeholder → wrong-credentials failure, not a loud crash | no default (required) or `= None`; never a real-looking placeholder |
| Committing `.env` with real values | credential leak in git history | `.env` gitignored; commit `.env.example` (placeholders); real values only in env/secrets |
| `print(settings)` / `logger.info(settings)` with raw `str` secret fields | secrets land in logs/aggregators | type credentials as `SecretStr`; `.get_secret_value()` only at point of use |
| `COPY .env` into the Docker image | secrets persist in image layers forever | config-free image; inject env at runtime (compose env / Docker secrets / `fly secrets`) |
| Single `_` as `env_nested_delimiter` | collides with underscores in field names; ambiguous parsing | use `__`; or set `env_nested_max_split` if you must use `_` |
| Test changes env but forgets `get_settings.cache_clear()` | gets the previous test's cached object; flaky, order-dependent tests | autouse fixture that `cache_clear()`s before+after; or use `dependency_overrides` |
| One nested env var wipes the rest of a defaulted nested model | other nested defaults silently dropped (issue #154) | `nested_model_default_partial_update=True` |
| 40 flat fields on one `Settings` | unreadable; no subsystem ownership | group into nested `BaseModel`s (`db`, `redis`, `providers`) with `env_nested_delimiter="__"` |
| Reading config from a global object AND re-reading env in the same module | two sources of truth; they can disagree | everything goes through `get_settings()`; nothing else reads `os.environ` |

---

## 15. Copy-paste starter (the whole thing)

```python
# app/config.py
from functools import lru_cache

from pydantic import BaseModel, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing_extensions import Self


class DatabaseSettings(BaseModel):
    host: str = "localhost"
    port: int = 5432
    name: str = "markets"
    user: str = "postgres"
    password: SecretStr = SecretStr("")
    pool_min: int = 2
    pool_max: int = 16

    @property
    def dsn(self) -> str:
        return (
            f"postgresql://{self.user}:{self.password.get_secret_value()}"
            f"@{self.host}:{self.port}/{self.name}"
        )


class RedisSettings(BaseModel):
    url: str = "redis://localhost:6379/0"
    max_connections: int = 20


class ProviderKeys(BaseModel):
    twelvedata: SecretStr | None = None
    finnhub: SecretStr | None = None
    coingecko: SecretStr | None = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="MKT_",
        env_nested_delimiter="__",
        secrets_dir="/run/secrets",
        case_sensitive=False,
        extra="ignore",                      # NOT the BaseSettings default 'forbid'
        nested_model_default_partial_update=True,
    )

    # required -> fail fast at startup
    environment: str = "local"               # local | staging | production

    # nested subsystems
    db: DatabaseSettings = DatabaseSettings()
    redis: RedisSettings = RedisSettings()
    providers: ProviderKeys = ProviderKeys()

    # service tunables
    app_name: str = "markets-data-service"
    log_level: str = "INFO"
    port: int = 8000
    request_timeout_s: float = 10.0

    @model_validator(mode="after")
    def _guard_production(self) -> Self:
        if self.environment == "production" and "localhost" in self.db.host:
            raise ValueError("production db.host points at localhost")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
```

```python
# app/deps.py
from typing import Annotated
from fastapi import Depends
from app.config import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]
```

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.config import get_settings

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()        # <-- fail-fast validation happens here
    app.state.settings = settings
    yield

app = FastAPI(lifespan=lifespan)

@app.get("/health")
async def health():
    s = app.state.settings
    return {"app": s.app_name, "env": s.environment}
```

---

## Sources (read directly for this reference)

- [pydantic-settings on PyPI](https://pypi.org/project/pydantic-settings/) — version **2.14.2**,
  released 2026-06-19, Python ≥ 3.10.
- [pydantic-settings — Settings Management (concepts)](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)
  — precedence order, `SettingsConfigDict` fields, nested env vars, secrets dir,
  `settings_customise_sources`, complex-type parsing, aliases, multiple dotenv files.
- [pydantic-settings — API reference](https://docs.pydantic.dev/latest/api/pydantic_settings/) —
  `SettingsConfigDict` field list, built-in source classes (`InitSettingsSource`,
  `EnvSettingsSource`, `DotEnvSettingsSource`, `SecretsSettingsSource`, TOML/YAML/JSON/GCP sources).
- `pydantic_settings/main.py@main` — verified `BaseSettings.model_config` defaults (`extra='forbid'`,
  `case_sensitive=False`, `validate_default=True`, `enable_decoding=True`) and the
  `_settings_build_values` precedence (first source = highest priority via `deep_update`).
- [pydantic-settings#154](https://github.com/pydantic/pydantic-settings/issues/154) — nested-default
  partial-update footgun → `nested_model_default_partial_update`.
- [FastAPI — Settings and Environment Variables](https://fastapi.tiangolo.com/advanced/settings/) —
  `@lru_cache get_settings()`, `Annotated[Settings, Depends(get_settings)]`, `dependency_overrides`,
  `cache_clear()`.
- [12factor.net — Config](https://12factor.net/config) — store config in the environment; never
  commit secrets.
- [Fly.io — Secrets and Fly Apps](https://fly.io/docs/apps/secrets/) — `fly secrets set`, secrets
  injected as env vars at boot, Machine restart on change.
- [Fly.io — App configuration (fly.toml)](https://fly.io/docs/reference/configuration/) — the
  `[env]` table for non-secret config.
