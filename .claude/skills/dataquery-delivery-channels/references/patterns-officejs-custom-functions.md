# Pattern: The Office.js Custom-Function Excel Add-in (`=LUMINA.SERIES(...)`) — Full Recipe

> **Layer:** `patterns-*` (concrete build recipe — the live spreadsheet delivery channel, fully specified).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line — the DataQuery/Fusion-class
> market-data platform. **NOT Lumina.** Lumina is a separate repo (Bun + Express + Prisma + Supabase +
> Upstash) that is merely the filesystem home for this research; do not wire any of this TypeScript/Office.js
> into Lumina's app code.
> **Stack assumption:** the channel front-end is an **Office Web Add-in** (TypeScript + Webpack +
> `custom-functions-metadata-plugin`), loaded into Excel; it calls **our own `/series` query API** (the
> FastAPI service specified by the sibling `patterns-series-retrieval-endpoint.md` /
> `python-fastapi-data-service` skills). The add-in is the **client**; our gateway is the **server**.
> **Derives from:** the DataQuery delivery-channel roster — DataQuery ships an **Excel add-in** as a
> first-class channel alongside the REST API, the Python SDK, and the web UI
> ([jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery), fetched in the project 03
> doc). Bloomberg's incumbent is the `BDH`/`BDP`/`BDS` worksheet functions; ours is `=LUMINA.SERIES(...)`.
> This doc turns "ship an Excel formula that pulls a series from our gateway" into every JSDoc tag, manifest
> element, auth step, error code, and production gotcha, with runnable code.

---

## 0. The on-ramp (plain language, then the rest is dense)

A markets analyst lives in Excel. The single most valuable thing we can give them is a **worksheet function**
that pulls a series straight from our gateway into a cell — type `=LUMINA.SERIES("UST10Y","2020-01-01","2024-12-31","m")`,
press Enter, and a column of monthly 10-year-Treasury yields **spills down** the sheet. That is exactly what
Bloomberg's `=BDH(...)` and our incumbent DataQuery's Excel add-in do. It is a delivery channel, not a new
data source: the numbers come from the same `/series` endpoint the web UI and the Python SDK hit.

The technology is an **Office Web Add-in** — an HTML/JS web app that Excel hosts in an embedded webview, plus
a small JSON metadata file that registers your JS functions as worksheet formulas. There are exactly **four**
things this recipe has to get right, and three of them are non-obvious traps that fail silently in production:

1. **The function + its metadata** (§2–§4). You write a TypeScript function with `@customfunction` JSDoc; a
   Webpack plugin auto-generates the `functions.json` metadata Excel reads. Return a `string[][]`/`number[][]`
   2-D array to get a spilled range.
2. **The shared runtime** (§6) — **the #1 production gotcha.** A custom function in the *default*
   JavaScript-only runtime gets only **"simple CORS"** (no custom headers, no cookies, GET/HEAD/POST only).
   The moment you add an `Authorization: Bearer …` header to fetch from our gateway, the request **fails with
   a network error**. The fix is to declare a **shared runtime** with `lifetime="long"` in the manifest, which
   grants **full CORS** to custom functions. Miss this and every authenticated fetch dies.
3. **Streaming** (§5) — for live-ish prices you don't `return` a value, you take a
   `CustomFunctions.StreamingInvocation` parameter and call `invocation.setResult(...)` repeatedly, wiring
   `invocation.onCanceled` to tear down the timer/socket. Streaming functions **cannot** use `@cancelable`;
   that is a hard, documented incompatibility people get wrong.
4. **Auth + provenance + errors** (§7–§9). The add-in obtains a token (Office SSO `getAccessToken`, or
   client-credentials, or the user's API key), caches it via `OfficeRuntime.storage`, attaches it to every
   `/series` call, and surfaces the **`commercialOk` provenance** to an adjacent cell/comment so the analyst
   knows the licence on the number they just pulled. Failed fetches return a typed Excel error
   (`#N/A` + message) — never a fabricated number (Lumina non-negotiable #1 applies to *this* product line
   too: *tools fetch, never invent*).

Everything below is the detail behind those four. The synchronous-custom-functions feature is **preview only
and must not ship** (§10). The **xlwings-server** alternative (a Python `@func` decorator + WebSocket
streaming) is the brief escape hatch if we want the function *body* in Python instead of TS (§11).

**Version pins (verified 2026-06):** Office.js production lib at
`https://appsforoffice.microsoft.com/lib/1/hosted/office.js`; custom-functions APIs at **CustomFunctionsRuntime
1.1+** (the `1.1` requirement set is where `setResult`, `address`, `onCanceled` land —
[custom-functions-runtime ref](https://learn.microsoft.com/en-us/javascript/api/custom-functions-runtime/customfunctions.streaminginvocation));
`isInValuePreview` needs 1.5, `parameterAddresses` needs 1.3); **SharedRuntime 1.1** requirement set;
`Identity API 1.3` for SSO; `custom-functions-metadata-plugin` (the `CustomFunctionsMetadataPlugin` Webpack
plugin, [OfficeDev/Office-Addin-Scripts](https://github.com/OfficeDev/Office-Addin-Scripts/blob/master/packages/custom-functions-metadata-plugin/README.md)).

---

## 1. The shape at a glance (what we ship)

| Piece | File | What it is | Source anchor |
|---|---|---|---|
| The function(s) | `src/functions/functions.ts` | TS with `@customfunction` JSDoc; `LUMINA.SERIES`, `LUMINA.QUOTE`, `LUMINA.STREAM` | [custom-functions-json-autogeneration](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration) |
| The metadata | `functions.json` (**autogenerated**) | maps each `@customfunction` to a worksheet formula | `CustomFunctionsMetadataPlugin` |
| The runtime host | `src/taskpane/taskpane.html` + `.ts` | the **single** shared-runtime page that hosts functions + task pane | [configure-shared-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime) |
| The manifest | `manifest.xml` (or `manifest.json`) | declares the add-in, the **shared runtime (`lifetime="long"`)**, SSO `WebApplicationInfo`, hosting URLs | same |
| The build | `webpack.config.js` | runs the metadata plugin, bundles `functions` + `taskpane` chunks into the shared page | same |
| The server | **our FastAPI gateway** (separate repo/service) | `GET /series` + CORS allowing the add-in origin + `Authorization` | `patterns-series-retrieval-endpoint.md` |

The cardinal mental model, copied directly from the docs: **"On Windows or on Mac, your add-in will run code
for ribbon buttons, custom functions, and the task pane in separate runtime environments… not being able to
access all CORS functionality from a custom function. However, you can configure your Office Add-in to share
code in the same runtime… this enables… access to the task pane DOM and CORS from all parts of your add-in"**
([configure-shared-runtime, "About the shared runtime"](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime)).

That single paragraph is why §6 (shared runtime) is load-bearing for *every* other section: without it, auth
headers and full CORS don't work, and §7 (auth) and §8 (provenance fetch) collapse.

---

## 2. The custom-function definition — `=LUMINA.SERIES(...)`

### 2.1 The anatomy of a custom function

A custom function is an ordinary exported JS/TS function plus a JSDoc comment whose first tag is
`@customfunction`. The metadata generator reads the JSDoc to learn the function id, display name, parameter
types, optionality, and return dimensionality. **The function logic and the metadata are two separate
artifacts** — the `.ts` is the body; `functions.json` is the contract Excel reads. The plugin keeps them in
sync at build time so you never hand-edit JSON ([custom-functions-json-autogeneration](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration):
*"We provide a Webpack plugin that uses these JSDoc tags to automatically create the JSON metadata file at
build time. Using the plugin saves you from the effort of manually editing the JSON metadata file"*).

### 2.2 `=LUMINA.SERIES(id, from, to, freq)` returning a spilled range

This is the headline function. It calls our `GET /series` and returns a **2-D array** so Excel spills the
result down/right. The `@customfunction` tag's two optional positional args are `id` and `name`:
`@customfunction <id> <name>` — if omitted, the JS function name (uppercased, illegal chars stripped) becomes
both. We want the **namespace prefix `LUMINA.`** in the display name so the formula autocompletes as
`LUMINA.SERIES` (the period is an allowed `name` character —
[json-autogeneration "#name"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration):
*"Allowed characters: Letters… numbers, period (.), and underscore (\_). Must start with a letter"*).

```typescript
// src/functions/functions.ts
/* global fetch, OfficeRuntime, CustomFunctions */

const GATEWAY = "https://api.lumina-markets.example"; // our FastAPI /series host

/**
 * Pulls a time series from the Lumina markets gateway and spills it down the sheet.
 * Column 1 = date (ISO), column 2 = value. The first row is a header.
 *
 * @customfunction SERIES LUMINA.SERIES
 * @param {string} id        Series id, e.g. "UST10Y", "SPX", "BTCUSD".
 * @param {string} from      Start date, ISO "YYYY-MM-DD" (or "" for earliest).
 * @param {string} to        End date, ISO "YYYY-MM-DD" (or "" for latest).
 * @param {string} [freq]    Frequency: d|w|m|q|a. Optional; defaults to native.
 * @returns {string[][]}     A 2-D array (date, value) that spills as a dynamic array.
 * @helpurl https://docs.lumina-markets.example/excel/series
 */
export async function series(
  id: string,
  from: string,
  to: string,
  freq?: string
): Promise<(string | number)[][]> {
  // 1) Validate early, fail with a precise Excel error (never a wrong number).
  if (!id) {
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.invalidValue,
      "LUMINA.SERIES: a series id is required."
    );
  }

  // 2) Build the request to OUR gateway (the same /series contract as the web UI).
  const qs = new URLSearchParams({ ids: id });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (freq) qs.set("frequency", freq);

  // 3) Attach the cached bearer token (see §7). This REQUIRES the shared runtime (§6).
  const token = await getToken();

  try {
    const res = await fetch(`${GATEWAY}/series?${qs.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      // Map an HTTP failure to a typed Excel error, never a fabricated value.
      throw new CustomFunctions.Error(
        CustomFunctions.ErrorCode.notAvailable,
        `LUMINA.SERIES: gateway returned ${res.status}.`
      );
    }

    const body = await res.json();
    // Our envelope: { data: [{id, points:[{t, v}...], provenance:{commercialOk,...}}], ... }
    const block = body.data?.[0];
    if (!block || !Array.isArray(block.points)) {
      throw new CustomFunctions.Error(
        CustomFunctions.ErrorCode.notAvailable,
        "LUMINA.SERIES: no data for that id/range."
      );
    }

    // 4) Build the spilled 2-D array: header row + one [date, value] row per point.
    const rows: (string | number)[][] = [["Date", id]];
    for (const p of block.points) {
      rows.push([p.t, p.v]);
    }

    // 5) Side-channel the provenance to a comment/adjacent cell (see §8).
    await stampProvenance(id, block.provenance);

    return rows;
  } catch (err) {
    // A CustomFunctions.Error rethrows cleanly to the cell; anything else -> #N/A.
    if (err instanceof CustomFunctions.Error) throw err;
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.notAvailable,
      "LUMINA.SERIES: network or parse failure."
    );
  }
}
```

**Why a `Promise`/`async` return is mandatory here:** any custom function that fetches external data is
asynchronous by nature, and **"Excel automatically waits for the promise to resolve before displaying the
result in the cell"** ([custom-functions-web-reqs, "Functions that return data from external sources"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs):
*"Return a JavaScript Promise to Excel. Resolve the Promise with the final value using the callback function"*).
A custom function **can return a promise that provides the value when the promise is resolved. If the promise
is rejected, then the custom function will throw an error**
([json-autogeneration, "Promise"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).
While the promise is pending, the cell shows **`#BUSY!`** (the documented in-flight indicator —
[xlwings officejs note](https://docs.xlwings.org/): *"the cell will show `#BUSY!` during calculation"*).

### 2.3 Spilling: the 2-D array contract

Returning a 2-D array is how a single formula fills neighboring cells ("spilling" / a dynamic-array formula).
Excel reads the array shape:

- `[['first'], ['second'], ['third']]` → **spills down** (each inner array is one row).
- `[['first', 'second', 'third']]` → **spills right** (one row, many columns).
- `[['apples', 1, 'pounds'], ['oranges', 3, 'pounds']]` → **rectangular** (both).

This is verbatim the documented dynamic-array behavior
([custom-functions-dynamic-arrays](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-dynamic-arrays):
*"Return a two-dimensional array to create a custom function that spills results… If neighboring cells contain
data, the formula displays a `#SPILL!` error"*). For `LUMINA.SERIES` we spill **down** with a header row, which
is the analyst-friendly shape (date column + value column the user can chart directly).

The matching JSDoc return type is the **matrix type**: `@returns {string[][]}` / `{number[][]}` / `{any[][]}`.
**"Use a two-dimensional array type to have the parameter or return value be a matrix of values. For example,
the type `number[][]` indicates a matrix of numbers"**
([json-autogeneration, "Matrix type"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).

> **`#SPILL!` is a real production failure, not a theoretical one.** If the analyst puts `=LUMINA.SERIES(...)`
> next to a column that already has data, the spill is blocked and the whole formula shows `#SPILL!`. There is
> nothing the add-in can do about it — it is the user's sheet layout. Document it in the `@helpurl` page and in
> the task pane: "place the formula where the result has room to spill."

### 2.4 Companion scalar function `=LUMINA.QUOTE(id)`

For a single value (a quote in one cell), return a scalar, not a matrix:

```typescript
/**
 * Returns the latest value for a series as a single number.
 * @customfunction QUOTE LUMINA.QUOTE
 * @param {string} id Series id, e.g. "SPX".
 * @returns {number} The latest value.
 */
export async function quote(id: string): Promise<number> {
  const token = await getToken();
  const res = await fetch(`${GATEWAY}/series?ids=${encodeURIComponent(id)}&latest=true`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.notAvailable,
      `LUMINA.QUOTE: gateway returned ${res.status}.`
    );
  }
  const body = await res.json();
  const v = body.data?.[0]?.points?.at(-1)?.v;
  if (typeof v !== "number") {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, "LUMINA.QUOTE: no value.");
  }
  return v;
}
```

### 2.5 Optional and typed parameters

- **Optional param:** square-bracket the name in JS JSDoc — `@param {string} [freq]` — or use a TS `?`/default.
  **The default value for an optional parameter is `null`**
  ([json-autogeneration, "@param" note](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).
- **Types** convert inputs before the function runs: `boolean | number | string`; matrix `number[][]`;
  `any` (no conversion). If you declare `{number}` and the cell holds text, Excel coerces or errors before
  your code runs. **"By specifying a parameter type, Excel will convert values into that type before calling
  the function. If the type is `any`, no conversion will be performed"**
  ([json-autogeneration, "Types"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).

---

## 3. The full JSDoc tag reference (the metadata language)

Every supported tag, what it does, and whether it matters for our gateway-fetching functions. Tags are read by
the `custom-functions-metadata-plugin` at build time
([json-autogeneration, "Supported JSDoc tags"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).

| Tag | Syntax | Effect | Use in our add-in |
|---|---|---|---|
| `@customfunction` | `@customfunction <id> <name>` | **Required.** Marks the function; sets id + display name. | Yes — `@customfunction SERIES LUMINA.SERIES` etc. |
| *(description)* | untagged text in the JSDoc | Help text shown in the formula picker. | Yes — one clear sentence per function. |
| `@param` | `@param {type} name desc` (JS) / `@param name desc` (TS) | Param type/name/desc; `[name]` = optional. | Yes. |
| `@returns` | `@returns {type}` | Return type; **`{string[][]}` etc. = spilled matrix**. | Yes — matrix for `SERIES`, scalar for `QUOTE`. |
| `@streaming` | `@streaming` | Streaming function: takes `StreamingInvocation`, returns `void`, calls `setResult` repeatedly. | Yes — `LUMINA.STREAM` (§5). |
| `@cancelable` | `@cancelable` | Async one-value function that runs cleanup on cancel via `CancelableInvocation.oncanceled`. | **No — mutually exclusive with `@streaming`** (§5.4). |
| `@volatile` | `@volatile` | Recalculated on **every** calc, even with unchanged args. Use sparingly. | Rarely — only a "now()"-style helper. |
| `@requiresAddress` | `@requiresAddress` | `invocation.address` = the calling cell's address. Last param must be `Invocation`. | Optional — useful to write provenance to an adjacent cell (§8). |
| `@requiresParameterAddresses` | `@requiresParameterAddresses` | `invocation.parameterAddresses` = input ranges. Needs a matrix `@returns`. | Rarely. |
| `@helpurl` | `@helpurl <url>` | A "more info" link shown in Excel. | Yes — point to our docs. |
| `@excludeFromAutoComplete` | `@excludeFromAutoComplete` | Hides the function from the formula menu. | No (we want discoverability). |
| `@supportSync` | `@supportSync` | **Preview** synchronous support. **Do not ship** (§10). | **No.** |
| `@capturesCallingObject` | — | Data-types feature (entity as first arg). | No. |
| `@customenum` | `@customenum {type}` | Declares a custom enum for params. | Optional (e.g. a `freq` enum). |
| `@linkedEntityLoadService` | — | Linked-entity load service. | No. |

**Two hard mutual-exclusions to memorize** (the source states them explicitly):

- **`@streaming` ⊕ `@cancelable`** — *"A function can't have both `@cancelable` and `@streaming` tags"*
  ([json-autogeneration, "@cancelable"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).
  Streaming functions get cancel cleanup through `invocation.onCanceled`, **not** the `@cancelable` tag (§5.4).
- **`@supportSync` ⊕ (`@streaming` | `@volatile`)** — *"Synchronous custom functions can't be streaming or
  volatile… If you use the `@supportSync` tag with `@volatile` or `@streaming`, Excel ignores the synchronous
  support"* ([custom-functions-synchronous](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-synchronous)).

### 3.1 What the autogenerated `functions.json` actually looks like

You never write this by hand, but you must be able to read it to debug. For the `SERIES` function above, the
plugin emits roughly:

```json
{
  "allowCustomDataForDataTypeAny": false,
  "functions": [
    {
      "id": "SERIES",
      "name": "LUMINA.SERIES",
      "description": "Pulls a time series from the Lumina markets gateway and spills it down the sheet.",
      "helpUrl": "https://docs.lumina-markets.example/excel/series",
      "parameters": [
        { "name": "id",   "description": "Series id...",   "type": "string", "dimensionality": "scalar" },
        { "name": "from", "description": "Start date...",  "type": "string", "dimensionality": "scalar" },
        { "name": "to",   "description": "End date...",    "type": "string", "dimensionality": "scalar" },
        { "name": "freq", "description": "Frequency...",   "type": "string", "dimensionality": "scalar", "optional": true }
      ],
      "result": { "type": "string", "dimensionality": "matrix" },
      "options": { "stream": false, "cancelable": false, "requiresAddress": false, "volatile": false }
    }
  ]
}
```

Key fields the plugin derives from JSDoc: `result.dimensionality: "matrix"` comes from `@returns {string[][]}`;
`parameters[].dimensionality` and `optional` come from `@param`; `options.stream`/`cancelable`/`volatile`/
`requiresAddress` come from the respective tags. (Shape per
[custom-functions-json manual metadata reference](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json);
the autogenerator produces this same schema.)

### 3.2 Build wiring — the Webpack plugin

Install and register the plugin; the function source file is its `input` and **the `output` must be
`"functions.json"`**:

```bash
npm install custom-functions-metadata-plugin
```

```javascript
// webpack.config.js (excerpt)
const CustomFunctionsMetadataPlugin = require("custom-functions-metadata-plugin");

module.exports = {
  // ...
  plugins: [
    new CustomFunctionsMetadataPlugin({
      output: "functions.json",          // MUST be exactly "functions.json"
      input: "./src/functions/functions.ts", // use the .ts source, NOT the transpiled .js
    }),
    // ... HtmlWebpackPlugin etc.
  ],
};
```

Verbatim rules: *"Change the `input` path and filename as needed… but the `output` value must be
`functions.json`. If you're using TypeScript, use the `*.ts` source file name, not the transpiled `*.js`
file."* and *"When Webpack runs, it creates the functions.json file and puts it in memory in development mode,
or in the /dist folder in production mode"*
([json-autogeneration, "CustomFunctionsMetadataPlugin" / "Run the tool"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).
**Multiple source files** → make `input` an **array** of paths *and* set `entry.functions` to the same array
(both steps required, per the same doc).

---

## 4. Returning a spilled range — worked examples

The four canonical spill shapes, copied from the dynamic-arrays doc and adapted, plus our series shape:

```typescript
/** @customfunction @returns {string[][]} spills DOWN */
export function spillDown(): string[][] { return [["first"], ["second"], ["third"]]; }

/** @customfunction @returns {string[][]} spills RIGHT */
export function spillRight(): string[][] { return [["first", "second", "third"]]; }

/** @customfunction @returns {any[][]} spills RECTANGLE */
export function spillRectangle(): (string | number)[][] {
  return [
    ["apples", 1, "pounds"],
    ["oranges", 3, "pounds"],
    ["pears", 5, "crates"],
  ];
}
```

(Shapes verbatim from
[custom-functions-dynamic-arrays, "Code samples"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-dynamic-arrays).)

For `LUMINA.SERIES` we build the matrix from the gateway response (`§2.2`). The important production detail:
**include the error rows inline when a single point in a batch fails.** A dynamic array can carry per-cell
errors — *"a custom function could output the array `[1],[#NUM!],[3]`"*
([custom-functions-errors, "Handle errors when working with dynamic arrays"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-errors)).
So a partial-failure series (e.g. a few missing observations) spills with `#N/A` in just those cells rather
than failing the whole formula:

```typescript
const rows: (string | number | CustomFunctions.Error)[][] = [["Date", id]];
for (const p of block.points) {
  if (p.v == null) {
    rows.push([p.t, new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable)]);
  } else {
    rows.push([p.t, p.v]);
  }
}
return rows;
```

---

## 5. Streaming functions — `=LUMINA.STREAM(id)` for live-ish updates

### 5.1 What a streaming function is (and how it differs from async)

A normal async function resolves its promise **once**. A streaming function never returns a value — it takes a
final parameter of type `CustomFunctions.StreamingInvocation<T>`, and pushes new values into the cell by
calling **`invocation.setResult(value)` repeatedly**. The cell updates each time, with no user refresh.
Verbatim: *"Streaming functions differ from regular asynchronous functions in that they can call `setResult`
multiple times to update the cell value continuously, rather than returning a single result"*
([custom-functions-web-reqs, "Make a streaming function"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)).
The `setResult` signature is **`setResult: (value: ResultType | Error) => void`** and **"may be called more
than once"** ([StreamingInvocation ref](https://learn.microsoft.com/en-us/javascript/api/custom-functions-runtime/customfunctions.streaminginvocation)).
Streaming was added in **CustomFunctionsRuntime 1.1**.

Declare it **either** with the `@streaming` JSDoc tag **or** simply by typing the last parameter as
`StreamingInvocation` (both work; we use the tag for clarity). The function **returns `void`** and **exceptions
thrown by a streaming function are ignored** — you signal errors through `setResult(new CustomFunctions.Error(...))`
([json-autogeneration, "@streaming"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration):
*"Streaming functions don't return values directly, instead they call `setResult(result)` using the last
parameter… Exceptions thrown by a streaming function are ignored. `setResult()` may be called with Error to
indicate an error result"*).

### 5.2 Streaming from our gateway (polling)

The simplest live-ish channel polls `/series?latest` on an interval and pushes each value. This is the right
default for "live-ish" market data because it composes with our Redis-cached, cron-warmed `/series` endpoint
(no socket fan-out needed on the gateway):

```typescript
/**
 * Streams the latest value of a series, polling the gateway every `intervalSec` seconds.
 * @customfunction STREAM LUMINA.STREAM
 * @param {string} id Series id, e.g. "BTCUSD".
 * @param {number} [intervalSec] Poll interval in seconds (default 10).
 * @param {CustomFunctions.StreamingInvocation<number>} invocation
 */
export function stream(
  id: string,
  intervalSec: number | undefined,
  invocation: CustomFunctions.StreamingInvocation<number>
): void {
  const periodMs = (intervalSec && intervalSec > 0 ? intervalSec : 10) * 1000;
  let aborted = false;

  const tick = async () => {
    if (aborted) return;
    try {
      const token = await getToken();
      const res = await fetch(`${GATEWAY}/series?ids=${encodeURIComponent(id)}&latest=true`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const v = body.data?.[0]?.points?.at(-1)?.v;
      if (typeof v === "number") {
        invocation.setResult(v);                 // push the new value into the cell
      } else {
        invocation.setResult(new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable));
      }
    } catch {
      // Return #N/A on a failed poll; keep the stream alive for the next tick.
      invocation.setResult(new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable));
    }
  };

  void tick();                                   // fire immediately, then on interval
  const timer = setInterval(() => void tick(), periodMs);

  // MANDATORY cleanup — see §5.3.
  invocation.onCanceled = () => {
    aborted = true;
    clearInterval(timer);
  };
}
```

This mirrors the documented stock-price streamer that fetches every 10 s and returns `#N/A` on failure
([custom-functions-web-reqs, "Streaming data from a web service"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)).

### 5.3 `onCanceled` is mandatory cleanup (not optional)

When Excel cancels a streaming call, your `setInterval`/socket keeps running unless you stop it. The doc is
blunt: *"Proper cleanup in the `onCanceled` callback is important to prevent unnecessary network requests.
Always clear timers, close connections, and abort pending requests when a function is canceled"*
([custom-functions-web-reqs, "Cancel a function"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)).
Excel cancels in three documented situations: the user edits/deletes the referencing cell; an argument
changes (which **also** triggers a new invocation); or the user forces recalculation. Two consequences:

1. **Ordering is not guaranteed.** *"The ordering between the cancellation of the old function call and the new
   invocation is not guaranteed… Your add-in code should not depend on `onCanceled` firing before the next
   invocation."* So make cleanup idempotent (our `aborted` flag + `clearInterval` is safe to run any time).
2. **Same-args streams are reused.** *"If multiple formulas reference the same streaming function with the same
   arguments, Excel reuses the existing stream rather than creating a new one."* This is free de-duplication —
   100 cells with `=LUMINA.STREAM("SPX")` share **one** poll loop, not 100. (Both quotes:
   [custom-functions-web-reqs, "Cancel a function"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs).)

### 5.4 The `@cancelable` trap (the documented incompatibility)

A common mistake is to reach for `@cancelable` to get the cancel hook. **`@cancelable` does not apply to
streaming functions.** The doc states it twice:

- *"A streaming function can't use the `@cancelable` tag, but streaming functions can include an `onCanceled`
  callback function. Only asynchronous custom functions which return one value can use the `@cancelable` JSDoc
  tag"* ([custom-functions-web-reqs, "Cancel a function"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)).
- *"A function can't have both `@cancelable` and `@streaming` tags"*
  ([json-autogeneration, "@cancelable"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)).

The relationship between the three invocation interfaces, from the type hierarchy
([StreamingInvocation ref](https://learn.microsoft.com/en-us/javascript/api/custom-functions-runtime/customfunctions.streaminginvocation)
*"Extends CustomFunctions.CancelableInvocation"*):

```
CustomFunctions.Invocation              // address, parameterAddresses, functionName, isInValuePreview
        ▲ extends
CustomFunctions.CancelableInvocation     // + onCanceled   (used by @cancelable one-value funcs)
        ▲ extends
CustomFunctions.StreamingInvocation<T>   // + setResult(value: T | Error): void   (streaming funcs)
```

So a `StreamingInvocation` **already has** `onCanceled` (inherited from `CancelableInvocation`) plus
`setResult`. You wire `invocation.onCanceled = () => {...}` — you never tag the function `@cancelable`.

### 5.5 Streaming a spilled array

`setResult` can take a 2-D array too — combine streaming with dynamic arrays to push a whole updating table.
The type is `StreamingInvocation<number[][]>`:

```typescript
/**
 * @customfunction
 * @param {number} amount Increment per second.
 * @param {CustomFunctions.StreamingInvocation<number[][]>} invocation A dynamic array.
 */
function increment(amount: number, invocation: CustomFunctions.StreamingInvocation<number[][]>): void {
  let a = 0, b = 1, c = 2;
  const timer = setInterval(() => {
    a += amount; b += amount; c += amount;
    invocation.setResult([[a], [b], [c]]);     // spills down, updates every second
  }, 1000);
  invocation.onCanceled = () => clearInterval(timer);
}
```

(Verbatim pattern from
[custom-functions-dynamic-arrays, "Streaming dynamic arrays"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-dynamic-arrays).)

### 5.6 WebSocket streaming (when the gateway pushes)

If our worker exposes a WebSocket price feed (the `worker/` Fly.io transport pattern), a streaming function can
hold the socket open instead of polling — lower latency, fewer requests. The doc's WebSocket streamer:

```typescript
/**
 * @customfunction
 * @param {string} symbol
 * @param {CustomFunctions.StreamingInvocation<string>} invocation
 */
function streamWebSocket(symbol: string, invocation: CustomFunctions.StreamingInvocation<string>): void {
  const ws = new WebSocket("wss://feed.lumina-markets.example");
  ws.onopen = () => ws.send(JSON.stringify({ subscribe: symbol }));
  ws.onmessage = (event) => invocation.setResult(JSON.parse(event.data).value);
  ws.onerror = () =>
    invocation.setResult(new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable));
  invocation.onCanceled = () => ws.close();    // MUST close the socket on cancel
}
```

(Verbatim from
[custom-functions-web-reqs, "Receiving data via WebSockets"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs):
*"WebSockets are useful for real-time data… your custom function can open a connection with a server and then
automatically receive messages… without having to explicitly poll the server"*.)

**Auth note for WebSockets:** browsers can't set custom headers on the `WebSocket` handshake, so the bearer
token goes in the URL query string or a `subscribe` message after open — never an `Authorization` header. Same
shared-runtime requirement applies for the cross-origin socket.

---

## 6. The shared runtime — THE #1 production gotcha

### 6.1 The failure, stated precisely

A custom function in the **default JavaScript-only runtime** can only make **"simple CORS"** requests. Verbatim
from the runtime doc: *"custom functions must use additional security measures when making XmlHttpRequests,
requiring Same Origin Policy and simple CORS. A simple CORS implementation cannot use cookies and only supports
simple methods (GET, HEAD, POST). Simple CORS accepts simple headers with field names `Accept`,
`Accept-Language`, `Content-Language`. You can also use a `Content-Type` header… provided that the content
type is `application/x-www-form-urlencoded`, `text/plain`, or `multipart/form-data`"*
([custom-functions-runtime, "Request external data"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-runtime)).

**`Authorization` is not a simple header.** So the moment our `series()` function adds
`Authorization: Bearer …` (which it must, to authenticate to our gateway — §2.2, §7), the request is no longer
"simple", and in the JS-only runtime it **fails with a network error**. This is exactly the behavior reported
in the field:

- [OfficeDev/office-js#1383](https://github.com/OfficeDev/office-js/issues/1383): *"POST requests consistently
  fail; `XMLHttpRequest` returns status code 0; `fetch()` throws 'Network request failed'… same-origin and
  simple GET requests work. Code works correctly when executed outside custom functions."*
- [OfficeDev/office-js#2178](https://github.com/OfficeDev/office-js/issues/2178): a CORS error fetching an
  external API **with a Basic `Authorization` header** from a custom function; the issue underscores that the
  shared runtime alone isn't sufficient if the **server** doesn't also send the right CORS headers (§6.4).

The fix is to move custom functions into the **shared runtime**, which the doc says is the only place they get
**full** CORS: *"Custom functions will have full CORS support… [and] can call Office.js APIs to read
spreadsheet document data"* — listed under "Excel add-ins only" benefits of a shared runtime
([configure-shared-runtime, "About the shared runtime"](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime)).

### 6.2 The runtime lifetime must be `long`

A shared runtime needs `lifetime="long"`, and the doc spells out *why* it matters for our use case verbatim:
*"The `lifetime` property is set to `long`, so that your add-in can take advantage of features, such as
starting your add-in when the document opens, continuing to run code after the task pane is closed, or **using
CORS and DOM from custom functions**. If you set the property to `short`… your add-in will start when one of
your ribbon buttons is pressed, but it may shut down after your ribbon handler is done running"*
([configure-shared-runtime, "Configure the manifest"](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime)).

### 6.3 The manifest config — both manifest formats

**Add-in-only (XML) manifest.** Two parts: declare the requirement set, and add the `<Runtime>` with
`lifetime="long"`.

```xml
<!-- 1) Requirements section: declare SharedRuntime 1.1 -->
<Requirements>
  <Sets DefaultMinVersion="1.1">
    <Set Name="SharedRuntime" MinVersion="1.1"/>
  </Sets>
</Requirements>

<!-- 2) Inside <VersionOverrides>, the <Runtimes> block under <Host>. -->
<VersionOverrides ...>
  <Hosts>
    <Host ...>
      <Runtimes>
        <Runtime resid="Taskpane.Url" lifetime="long" />
      </Runtimes>
      <!-- ... -->
      <!-- The custom-functions <Page> must source from Taskpane.Url, not Functions.Page.Url -->
      <AllFormFactors>
        <Page>
          <SourceLocation resid="Taskpane.Url"/>
        </Page>
      </AllFormFactors>
      <!-- The FunctionFile must also point at Taskpane.Url -->
      <FunctionFile resid="Taskpane.Url"/>
    </Host>
  </Hosts>
</VersionOverrides>
```

Critical, verbatim warnings from the doc:

- *"The shared runtime won't load if the `resid` uses different values in the manifest. If you change the value
  to something other than `Taskpane.Url`, be sure to also change the value in all locations."*
- *"The `<Runtimes>` section must be entered after the `<Host>` element in the exact order shown."*
- *"If you generated an Excel add-in with custom functions, find the `<Page>` element. Then change the source
  location from `Functions.Page.Url` to `Taskpane.Url`."* and the `<FunctionFile>` `resid` from `Commands.Url`
  to `Taskpane.Url`.

(All from
[configure-shared-runtime, "Add-in only manifest" tab](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime).)

**Unified (JSON) manifest for Microsoft 365.** Set `requirements.capabilities` to include `SharedRuntime` 1.1
and the runtime `lifetime` to `long`:

```json
"runtimes": [
  {
    "requirements": {
      "capabilities": [
        { "name": "AddinCommands", "minVersion": "1.1" },
        { "name": "SharedRuntime", "minVersion": "1.1" }
      ]
    },
    "id": "SharedRuntime",
    "type": "general",
    "code": { "page": "https://localhost:3000/taskpane.html" },
    "lifetime": "long",
    "actions": [
      { "id": "TaskPaneRuntimeShow", "type": "openPage" },
      { "id": "action", "type": "executeFunction" }
    ]
  }
]
```

(Verbatim JSON from
[configure-shared-runtime, "Unified manifest" tab](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime).)

**Webpack consequence.** A shared-runtime project loads `functions.js` and `commands.js` **into the task-pane
page** rather than separate `functions.html`/`commands.html` pages. Remove the `functions.html`/`commands.html`
`HtmlWebpackPlugin` entries and add `functions`/`commands` to the `taskpane.html` chunks:

```javascript
new HtmlWebpackPlugin({
  filename: "taskpane.html",
  template: "./src/taskpane/taskpane.html",
  chunks: ["polyfill", "taskpane", "commands", "functions"],
}),
```

(Per
[configure-shared-runtime, "Configure the webpack.config.js file"](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime).)

> **Yeoman shortcut.** `yo office` → choose **"Excel Custom Functions using a Shared Runtime"** scaffolds all
> of the above correctly (the doc's recommended starting point). Use it for greenfield; the manual steps above
> are for retrofitting or understanding what the generator did.

### 6.4 Shared runtime is necessary but not sufficient — the server must do CORS too

The other half of the #2178 lesson: the **gateway** must return the right CORS response. Even with the shared
runtime, a cross-origin authenticated fetch requires a CORS **preflight** (`OPTIONS`) to succeed and the
response to allow our header + origin. On the FastAPI side (the `python-fastapi-data-service` skill):

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://addin.lumina-markets.example",          # our add-in's hosting origin
        "https://localhost:3000",                        # sideload dev
    ],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Authorization", "Accept", "Content-Type"],
    allow_credentials=False,                              # bearer token, not cookies
)
```

The add-in's hosting origin (where `taskpane.html`/`functions.js` are served) must be on `allow_origins`, and
`Authorization` must be on `allow_headers`, or the browser blocks the response **before your `fetch` `.then`
ever runs** — which surfaces in the cell as `#N/A` and in the F12 console as a CORS error. This is the single
most common "it works in Postman but not in Excel" failure.

### 6.5 HTTPS and webview requirements

- **HTTPS only.** Add-in pages and all `fetch` targets must be HTTPS in production; Excel runs the add-in in an
  embedded webview that blocks mixed content. Sideload dev uses `https://localhost` with a dev cert (Office
  tooling installs one).
- **Webview engine.** On Windows, modern Office uses the **WebView2 (Edge Chromium)** runtime; older builds may
  use the legacy IE/EdgeHTML webview where `fetch`/`Promise`/`async` may need the `core-js` + `regenerator-runtime`
  polyfills the Yeoman template already includes (the `polyfill` chunk in the Webpack config). Keep the polyfill
  chunk for broad-Office-version support.

---

## 7. Authentication into our gateway

There are three viable token strategies. All three end with a **bearer token cached in the add-in** and
attached to every `/series` call. The shared runtime (§6) is a prerequisite for all of them because the
`Authorization` header needs full CORS.

### 7.1 Strategy A — Office SSO (`getAccessToken` + on-behalf-of) — best for org deployment

When the add-in is deployed inside a Microsoft 365 tenant, the cleanest path is **Office Single Sign-On**:
Office hands you a token for the signed-in user with no second login. The flow
([sso-in-office-add-ins, "How legacy Office SSO works"](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins)):

1. Your JS calls `OfficeRuntime.auth.getAccessToken()`. *"If the user is already signed in to Office, the
   Office host will return the access token with the claims of the signed in user."*
2. You send that **bootstrap token** to our gateway in the `Authorization` header.
3. Our gateway runs the **OAuth 2.0 On-Behalf-Of (OBO) flow** to exchange it for whatever downstream token it
   needs, and authorizes the user.

```typescript
// In the add-in: get the Office SSO token (NEVER cache it yourself; Office caches it).
async function getOfficeSsoToken(): Promise<string> {
  // allowSignInPrompt surfaces the sign-in UI if the user isn't signed in yet.
  return await OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: true });
}
```

Hard rules from the doc, quoted:

- *"Always call `getAccessToken` when you need an access token. Office will cache the access token (or request
  a new one if it expired.) Don't cache or store the access token using your own code."* — so for SSO you do
  **not** use `OfficeRuntime.storage`; Office is the cache.
- *"As a best security practice, always use the server-side code to make Microsoft Graph calls… Never return
  the OBO token to the client."*
- Requires the **Identity API 1.3** requirement set and a **`WebApplicationInfo`** manifest element with the
  Entra app `id` + `resource` (Application ID URI):

```xml
<WebApplicationInfo>
  <Id>5661fed9-f33d-4e95-b6cf-624a34a2f51d</Id>
  <Resource>api://addin.lumina-markets.example/5661fed9-f33d-4e95-b6cf-624a34a2f51d</Resource>
  <Scopes>
    <Scope>openid</Scope>
    <Scope>profile</Scope>
    <Scope>user.read</Scope>
  </Scopes>
</WebApplicationInfo>
```

```json
// Unified manifest equivalent:
"webApplicationInfo": {
  "id": "a661fed9-f33d-4e95-b6cf-624a34a2f51d",
  "resource": "api://addin.lumina-markets.example/a661fed9-f33d-4e95-b6cf-624a34a2f51d"
}
```

(Both verbatim from
[sso-in-office-add-ins, "Configure the add-in"](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins).)
**Handle error code `13003`** (SSO unsupported for some account types) by falling back to Strategy B/C — the
doc explicitly warns *"You should not rely on SSO as your add-in's only method of authentication."*

> **Modern recommendation:** Microsoft now points new add-ins at **MSAL + Nested App Authentication (NAA)**
> rather than the legacy SSO flow above
> ([sso-in-office-add-ins top note](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins):
> *"For a modern authentication experience… use the Microsoft Authentication Library (MSAL) with nested app
> authentication (NAA)"*). The bootstrap→OBO concept is identical; NAA changes the client library. Pin the NAA
> path for a fresh build and keep legacy `getAccessToken` as the documented fallback.

### 7.2 Strategy B — the user's API key — simplest, works outside M365

If our product issues per-user **API keys** (the DataQuery / FRED model), the analyst pastes their key once
into the **task pane**, and the add-in caches it for the custom functions to use. Because custom functions and
the task pane share the runtime (§6), they can share an in-memory variable **and** `OfficeRuntime.storage`
(the persistent, cross-runtime key-value store):

```typescript
// Task pane: user pastes their key; persist it for custom functions to read.
async function saveApiKey(key: string): Promise<void> {
  await OfficeRuntime.storage.setItem("lumina_api_key", key);
}

// Custom function side: read the cached key (10 MB key-value store, survives runtime restarts).
async function getApiKeyToken(): Promise<string> {
  const key = await OfficeRuntime.storage.getItem("lumina_api_key");
  if (!key) {
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.notAvailable,
      "Sign in via the Lumina task pane to set your API key."
    );
  }
  return key;
}
```

`OfficeRuntime.storage` is the documented cross-runtime store: *"a persistent, unencrypted, key-value storage
system… offers 10 MB of data per domain… tokens for user authentication may be stored in the `Storage` object
because it can be accessed by both a custom function… and a task pane"*
([custom-functions-runtime, "Store and access data"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-runtime)).
Methods: `getItem`, `getItems`, `setItem`, `setItems`, `removeItem`, `removeItems`, `getKeys` (there is no
`clear`; use `removeItems`). **It is unencrypted** — fine for a scoped API key the user can revoke, less ideal
for long-lived high-privilege secrets.

### 7.3 Strategy C — OAuth client-credentials (the add-in itself authenticates)

For a service-to-service token where the **add-in** (not the user) authenticates — e.g. a desk-wide read-only
key — use the OAuth 2.0 **client-credentials** grant. **Never put a client secret in the add-in bundle** (it
ships to every user's machine). Instead, the **task pane** or a tiny token-broker route on our gateway holds
the secret, mints a short-lived token, and the custom function reads it from `OfficeRuntime.storage`:

```typescript
// A token-broker call: our gateway exchanges its server-held secret for a short-lived token.
async function refreshBrokeredToken(): Promise<string> {
  const res = await fetch(`${GATEWAY}/auth/token`, { method: "POST" }); // gateway holds the secret
  const { access_token, expires_in } = await res.json();
  await OfficeRuntime.storage.setItem("lumina_token", access_token);
  await OfficeRuntime.storage.setItem("lumina_token_exp", String(Date.now() + expires_in * 1000));
  return access_token;
}
```

### 7.4 The unified `getToken()` with expiry-aware caching

All three strategies funnel through one helper the functions call. Cache + refresh on expiry:

```typescript
let _memToken: { value: string; exp: number } | null = null;

export async function getToken(): Promise<string> {
  // 1) Office SSO path (preferred in M365): Office caches, so just call it.
  if (typeof OfficeRuntime?.auth?.getAccessToken === "function") {
    try {
      return await OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: true });
    } catch (e: any) {
      if (e?.code !== 13003) throw e; // 13003 => fall through to key/broker
    }
  }

  // 2) In-memory fast path.
  if (_memToken && _memToken.exp > Date.now() + 30_000) return _memToken.value;

  // 3) Persistent store (API key never expires; brokered token has an exp).
  const exp = Number(await OfficeRuntime.storage.getItem("lumina_token_exp")) || Infinity;
  if (exp > Date.now() + 30_000) {
    const stored = await OfficeRuntime.storage.getItem("lumina_token")
      ?? await OfficeRuntime.storage.getItem("lumina_api_key");
    if (stored) {
      _memToken = { value: stored, exp };
      return stored;
    }
  }

  // 4) Refresh a brokered token, or prompt sign-in via the dialog (§7.5).
  return await refreshBrokeredToken();
}
```

### 7.5 The dialog fallback (no shared runtime, or interactive sign-in)

If you ever run custom functions **without** a shared runtime (e.g. a fast-calc-only add-in), there is no DOM,
no `localStorage`, and you must drive sign-in through **`OfficeRuntime.displayWebDialog`** (note: *not*
`Office.ui.displayDialogAsync`, which is the task-pane runtime's API). The flow
([custom-functions-authentication](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-authentication)):
the function opens a web dialog → the dialog page authenticates and calls `Office.ui.messageParent(token)` →
the function caches the token in `OfficeRuntime.storage`. The documented helper:

```typescript
function getTokenViaDialog(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    OfficeRuntime.displayWebDialog(url, {
      height: "50%",
      width: "50%",
      onMessage: (message, dialog) => {
        resolve(message);          // the dialog called Office.ui.messageParent(token)
        dialog.close();
      },
      onRuntimeError: (error) => reject(error),
    }).catch(reject);
  });
}
```

> **Decision:** for *this* product line, ship with a **shared runtime + Strategy A (SSO) or B (API key)**. The
> dialog/JS-only-runtime path (§7.5) is documented here only as the fallback for an environment that can't use
> a shared runtime — it is strictly worse (no full CORS, harder token sharing) and we should not choose it.

---

## 8. Surfacing provenance (`commercialOk`) to the sheet

A core non-negotiable of this product line (inherited from Lumina's `commercial-ok` gate): **every displayed
series carries a `Provenance` with a `commercialOk` boolean, and we surface it.** In a spreadsheet there is no
"footer" — so the add-in writes provenance to an **adjacent cell or a cell comment** so the analyst sees the
licence on the number they pulled. This needs Office.js DOM/host APIs, which **only work in the shared runtime**
(another reason §6 is mandatory: *"Custom functions can call Office.js APIs to read spreadsheet document
data"* — and, in the shared runtime, write it too).

```typescript
import "office-js"; // Excel namespace available in the shared runtime

async function stampProvenance(
  id: string,
  provenance: { source: string; commercialOk: boolean; asOf?: string; attribution?: string }
): Promise<void> {
  const note =
    `Lumina ${id} • source: ${provenance.source} • ` +
    `commercialOk: ${provenance.commercialOk ? "GREEN ✅" : "RED ⛔ informational only"}` +
    (provenance.asOf ? ` • as-of ${provenance.asOf}` : "") +
    (provenance.attribution ? ` • ${provenance.attribution}` : "");

  await Excel.run(async (ctx) => {
    const cell = ctx.workbook.getActiveCell();
    // Attach a comment to the spilling anchor cell carrying the provenance string.
    cell.load("address");
    await ctx.sync();
    ctx.workbook.comments.add(cell.address, note);
    await ctx.sync();
  });
}
```

Design notes:

- **`commercialOk: false` (RED)** sources can still be pulled into a sheet for *informational, attributed*
  analysis — the gate governs the *display licence*, not access. The comment text makes the licence explicit so
  the user doesn't redistribute a RED number. This mirrors the project rule verbatim:
  *"A RED source can still be built against for an informational, attributed feature… you just keep the gate
  `false` and show attribution."* (the project's `commercial-ok-gate` rule).
- Prefer a **comment** over a clobbered adjacent cell so we never overwrite the user's own data. Alternatively,
  a `=LUMINA.PROVENANCE(id)` companion function returns the provenance string into a cell the user places.
- Never fabricate provenance. If the gateway's envelope lacks a `provenance` block, write
  `commercialOk: unknown` and treat it as RED — *the default is `false`.*

---

## 9. Error surfacing in a cell

### 9.1 The error model

A custom function signals an error by **throwing** (non-streaming) or **`setResult`-ing** (streaming) a
`CustomFunctions.Error(code, message?)`. The `ErrorCode` → cell-value mapping
([custom-functions-errors, "The CustomFunctions.Error object"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-errors)):

| `CustomFunctions.ErrorCode` | Cell shows | Use it when |
|---|---|---|
| `notAvailable` | `#N/A` | gateway unreachable / no data / failed fetch (**our default failure**) |
| `invalidValue` | `#VALUE!` | a parameter is the wrong type/shape (bad id, bad date) |
| `invalidNumber` | `#NUM!` | a numeric arg is out of range |
| `divisionByZero` | `#DIV/0` | (n/a for us) |
| `nullReference` | `#NULL!` | ranges don't intersect |
| `invalidName` | `#NAME?` | **input-only** (can't be an output) |
| `invalidReference` | `#REF!` | **input-only** (can't be an output) |

**Only `#VALUE!` and `#N/A` support a custom message string** that appears in the cell's error-indicator
menu: *"The `#VALUE!` and `#N/A` errors also support custom error messages. Custom error messages are
displayed in the error indicator menu, which is accessed by hovering over the error flag"*
([custom-functions-errors](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-errors)).
So our two workhorses are:

```typescript
// No data / network failure -> #N/A with a typed message:
throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, "LUMINA.SERIES: gateway 503.");

// Bad input -> #VALUE! with a typed message:
throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, "LUMINA.SERIES: 'from' must be YYYY-MM-DD.");
```

### 9.2 `#BUSY!` is not an error — it's "in flight"

While a promise is pending, the cell shows **`#BUSY!`**. This is **not** something you throw; it is Excel's
own indicator that an async/streaming function is still computing. Don't try to "handle" it — but **do** keep
fetches fast or batch them, because a sheet full of `#BUSY!` cells stuck for seconds is a bad experience.
(xlwings documents the same indicator: *"the cell will show `#BUSY!` during calculation"* —
[xlwings officejs](https://docs.xlwings.org/).) Default a streaming value so an offline first-tick shows
something instead of indefinite `#BUSY!` — the doc advises *"setting a default streaming value to handle cases
when a request is made but you are offline"*
([custom-functions-web-reqs, "Cancel a function"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)).

### 9.3 The `try…catch → typed error` discipline

By default Excel returns `#VALUE!` for any unhandled exception
([custom-functions-errors, "Use try...catch blocks"](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-errors):
*"By default, Excel returns `#VALUE!` for unhandled errors or exceptions"*). That is opaque to the user. Always
wrap the fetch and convert to a **specific** typed error — the doc's reference pattern returns `#N/A` on a
failed REST call:

```typescript
function getComment(commentID: number) {
  return fetch(`https://www.contoso.com/comments/${commentID}`)
    .then((data) => data.json())
    .then((json) => json.body)
    .catch(() => {
      throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable);
    });
}
```

This is the single most important grounding rule for *this* product line in spreadsheet form: **a failed fetch
returns a typed `#N/A`, never a fabricated number, never a stale value silently dressed as live.** It is the
spreadsheet expression of non-negotiable #1.

---

## 10. Synchronous custom functions are PREVIEW — do not ship

There is a `@supportSync` tag and a synchronous-custom-functions feature that lets a function participate in
Excel's evaluate / conditional-format processes. **It is public preview and explicitly banned from production.**
Verbatim, twice:

- *"Synchronous custom functions are available in public preview and subject to change based on feedback. Do
  not use synchronous custom functions in a production add-in."*
  ([custom-functions-synchronous](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-synchronous)).
- It also requires the **beta** Office.js CDN (`/lib/beta/hosted/office.js`) and `@types/office-js-preview` —
  which we never ship to production.

Additional disqualifiers even if it shipped:

- *"Synchronous custom functions don't support write operations with Office JavaScript APIs… Calling a write
  operation in a synchronous custom function may cause Excel to freeze."* — incompatible with our
  provenance-stamping (§8).
- *"Synchronous custom functions can't be streaming or volatile."* — incompatible with `LUMINA.STREAM` (§5).
- *"When a synchronous custom function takes a significant amount of time to complete, Excel might temporarily
  block the user interface"* — a synchronous network fetch would freeze the UI; our functions are network-bound
  by nature.

**Rule for this product line:** every Lumina function is **async** (returns a `Promise`) or **streaming**.
Never `@supportSync`. (Note the tag is *ignored* anyway if combined with `@streaming`/`@volatile`.)

---

## 11. The xlwings-server alternative (Python function body) — brief recipe

If we'd rather write the function **body** in Python (reuse our pandas/Pydantic stack from the data-plane
skills) instead of TypeScript, **xlwings Server** is the production-grade option. It still ships an Office.js
add-in to Excel, but the add-in is a thin shim that round-trips each custom-function call to a **Python server**
that holds the logic. Streaming runs as a background task on the server and pushes updates over **WebSockets
(Socket.io)** — no local COM/RTD server.

### 11.1 A plain function

```python
# custom_functions.py  (xlwings expects this module by default)
from xlwings.server import func          # decorators come from xlwings.server, not xlwings

@func
def hello(name):
    return f"Hello {name}!"
```

*"The simplest custom function only requires the `@server.func` decorator, and the decorators for Office.js are
imported from `xlwings.server` instead of `xlwings`. By default, xlwings expects the functions to live in a
module called `custom_functions.py`."*
([xlwings server custom-functions](https://server.xlwings.org/en/latest/custom_functions/)).

### 11.2 A streaming function = an async generator

The killer feature: a streaming function is just an **`async def` that `yield`s** — and you can `yield` a
pandas `DataFrame` to spill a whole table that updates:

```python
import asyncio
import numpy as np
import pandas as pd
from xlwings.server import func

@func
async def streaming_random(rows, cols):
    """A streaming function pushing updates of a random DataFrame every second."""
    rng = np.random.default_rng()
    while True:
        matrix = rng.standard_normal(size=(rows, cols))
        df = pd.DataFrame(matrix, columns=[f"col{i+1}" for i in range(matrix.shape[1])])
        yield df                       # each yield pushes a new spilled result to Excel
        await asyncio.sleep(1)
```

*"To create a streaming function, you simply need to write an asynchronous generator… streaming functions
don't use a local COM server. Instead, the process runs as a background task on xlwings Server and pushes
updates via WebSockets (using Socket.io) to Excel… you can connect to your data source in a single place and
stream the values to every Excel installation in your entire company."*
([xlwings docs, officejs custom functions](https://docs.xlwings.org/);
[xlwings server custom-functions](https://server.xlwings.org/en/latest/custom_functions/)).

For a `LUMINA.SERIES` equivalent, the Python body would call our internal FastAPI `/series` (in-process or via
`httpx`) and return a `DataFrame` — exactly the data-plane code the `python-fastapi-data-service` and
`patterns-series-retrieval-endpoint` skills already specify.

### 11.3 The trade-off (when to pick which)

| Concern | Office.js (TS) recipe (§2–§9) | xlwings Server (Python) (§11) |
|---|---|---|
| Function body language | TypeScript/JS | **Python** (reuse pandas/Pydantic) |
| Logic location | in the add-in (client webview) | **on our server** (one source of truth, push to all installs) |
| Streaming | `setResult` + `onCanceled` (client polls/sockets) | **`async def` + `yield`**, server pushes via Socket.io |
| Infra to run | static hosting for the add-in only | **a running Python server** (the data-plane service) + WebSocket transport |
| Auth | SSO / API key in the add-in (§7) | xlwings Server auth (server-side) |
| Licensing | xlwings Server is a **paid/commercial** product (xlwings PRO) | same — factor the licence cost |
| `commercialOk` provenance | stamp via Office.js DOM (§8) | return as extra `DataFrame` columns / comments server-side |
| Best when | we want zero server for the channel, or full client control | we want **one Python codebase** driving the function logic for the whole desk |

**Recommendation for this product line:** default to the **Office.js TypeScript recipe** (§2–§9) because (a) it
needs no additional always-on server beyond our existing gateway, (b) it keeps the channel fully in our control
without a third-party commercial dependency, and (c) the streaming + auth + provenance story is fully covered
by primary Microsoft APIs above. Reach for **xlwings Server** only if the desk's requirement is *"the function
logic must be Python, centrally hosted, and identical across every analyst's Excel"* — its server-push-to-all
model is genuinely better for that one requirement, at the cost of running (and licensing) the xlwings server.

---

## 12. Manifest, sideload, and deploy

### 12.1 The complete shared-runtime XML manifest skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>11111111-2222-3333-4444-555555555555</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Lumina Markets</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Lumina Markets" />
  <Description DefaultValue="Pull market data series into Excel via =LUMINA.SERIES()." />
  <Hosts><Host Name="Workbook" /></Hosts>

  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="SharedRuntime" MinVersion="1.1"/>
    </Sets>
  </Requirements>

  <DefaultSettings><SourceLocation resid="Taskpane.Url" /></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>

  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Workbook">
        <Runtimes>
          <Runtime resid="Taskpane.Url" lifetime="long" />
        </Runtimes>
        <AllFormFactors>
          <ExtensionPoint xsi:type="CustomFunctions">
            <Script><SourceLocation resid="Functions.Script.Url" /></Script>
            <Page><SourceLocation resid="Taskpane.Url" /></Page>
            <Metadata><SourceLocation resid="Functions.Metadata.Url" /></Metadata>
            <Namespace resid="Functions.Namespace" />
          </ExtensionPoint>
        </AllFormFactors>
        <DesktopFormFactor>
          <GetStarted><Title resid="GetStarted.Title"/><Description resid="GetStarted.Description"/></GetStarted>
          <FunctionFile resid="Taskpane.Url" />
          <!-- ribbon controls omitted for brevity -->
        </DesktopFormFactor>
      </Host>
    </Hosts>

    <Resources>
      <bt:Urls>
        <bt:Url id="Taskpane.Url"            DefaultValue="https://addin.lumina-markets.example/taskpane.html" />
        <bt:Url id="Functions.Script.Url"    DefaultValue="https://addin.lumina-markets.example/functions.js" />
        <bt:Url id="Functions.Metadata.Url"  DefaultValue="https://addin.lumina-markets.example/functions.json" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Functions.Namespace"  DefaultValue="LUMINA" />
        <bt:String id="GetStarted.Title"     DefaultValue="Lumina Markets" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="GetStarted.Description" DefaultValue="Use =LUMINA.SERIES(id, from, to, freq)." />
      </bt:LongStrings>
    </Resources>

    <!-- SSO: add WebApplicationInfo here for getAccessToken (§7.1) -->
    <WebApplicationInfo>
      <Id>5661fed9-f33d-4e95-b6cf-624a34a2f51d</Id>
      <Resource>api://addin.lumina-markets.example/5661fed9-f33d-4e95-b6cf-624a34a2f51d</Resource>
      <Scopes><Scope>openid</Scope><Scope>profile</Scope></Scopes>
    </WebApplicationInfo>
  </VersionOverrides>
</OfficeApp>
```

The `<Namespace resid="Functions.Namespace">` of `LUMINA` is what makes the formula appear as **`LUMINA.SERIES`**
in Excel — the namespace prefixes every function id from `functions.json`.

### 12.2 Sideload (dev)

The fast loop is the Office tooling:

```bash
npm start          # webpack-dev-server on https://localhost:3000 + sideloads into Excel
# (office-addin-debugging registers the manifest and opens Excel with the add-in loaded)
npm stop           # unregisters and stops the dev server
```

Manual sideload alternatives (when `npm start` can't drive the host): Excel on the web → **Insert → Office
Add-ins → Upload My Add-in → pick `manifest.xml`**; Excel desktop (Windows) → a **trusted network share**
catalog pointed at the manifest folder. For testing details see
[deploy-and-publish](https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish).

### 12.3 Production deploy

1. **Host the static assets** (`taskpane.html`, `functions.js`, `functions.json`, icons) on HTTPS — any static
   host/CDN works; the add-in is a static web app. Update all `<bt:Url>` `DefaultValue`s to the production
   origin (and add that origin to the gateway's CORS allow-list — §6.4).
2. **Org-internal deploy → Centralized Deployment.** An M365 admin uploads the manifest in the **Microsoft 365
   admin center** (Integrated Apps / Add-ins) to push it to users/groups. *"Admins can deploy Office Add-ins
   for users in their organization by using the centralized deployment feature in the Microsoft 365 admin
   center… select the option to upload the manifest"* — note centralized deployment **requires Exchange Online
   mailboxes** ([manage-deployment-of-add-ins](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins),
   [centralized-deployment-of-add-ins](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/centralized-deployment-of-add-ins)).
3. **Public distribution → Microsoft Marketplace (AppSource)** for an add-in anyone can install (subject to
   validation, including the SSO manifest-format requirement noted in §7.1).
4. **SSO consent gotcha:** *"If your add-in is deployed by one or more admins… adding new scopes to the manifest
   will require the admin to consent to the updates. Users will be blocked from the add-in until consent is
   granted"* ([sso-in-office-add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins)).
   Lock scopes early; scope changes are a deploy event, not a code event.

---

## 13. Production gotchas checklist (the things that bite)

| # | Gotcha | Symptom | Fix | Source |
|---|---|---|---|---|
| 1 | **No shared runtime** → only "simple CORS" | authenticated `fetch`/POST fails; `XHR.status === 0`; "Network request failed" | declare shared runtime, `lifetime="long"`, SharedRuntime 1.1 | [#1383](https://github.com/OfficeDev/office-js/issues/1383); [configure-shared-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime) |
| 2 | **Server CORS not configured** | fetch blocked even *with* shared runtime; CORS error in F12 | gateway must allow the add-in origin + `Authorization` header + `OPTIONS` | [#2178](https://github.com/OfficeDev/office-js/issues/2178) |
| 3 | **`resid` mismatch** in manifest | shared runtime silently won't load | use `Taskpane.Url` consistently in `<Runtime>`, `<Page>`, `<FunctionFile>` | [configure-shared-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime) |
| 4 | **`@cancelable` on a streaming fn** | metadata build error / ignored cleanup | use `invocation.onCanceled`, never `@cancelable`, with `@streaming` | [web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs) |
| 5 | **No `onCanceled` cleanup** | leaked timers/sockets; runaway network requests | clear timers / close sockets / abort fetches in `onCanceled` | [web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs) |
| 6 | **Assuming `onCanceled` fires before re-invoke** | stale-state race on arg change | make cleanup idempotent; don't order-depend | [web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs) |
| 7 | **`output` not `"functions.json"`** | Excel doesn't see the functions | plugin `output` must be exactly `functions.json`; input = `.ts` source | [json-autogeneration](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration) |
| 8 | **`localStorage` in a custom function** | `undefined`/throws (no `window`) | use `OfficeRuntime.storage` (cross-runtime, 10 MB) | [custom-functions-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-runtime) |
| 9 | **Caching the SSO token yourself** | stale/expired token leaks | call `getAccessToken` each time; Office caches it | [sso-in-office-add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins) |
| 10 | **Client secret in the bundle** | secret ships to every user | broker the token server-side; never embed a secret | OAuth client-credentials best practice |
| 11 | **`#SPILL!`** on `LUMINA.SERIES` | formula errors next to existing data | give the result room; document it | [dynamic-arrays](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-dynamic-arrays) |
| 12 | **Shipping `@supportSync`** | preview API; UI freeze risk; needs beta CDN | never ship synchronous custom functions | [custom-functions-synchronous](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-synchronous) |
| 13 | **Returning a fabricated number on failure** | silently wrong analysis | throw a typed `#N/A`/`#VALUE!`; never invent | [custom-functions-errors](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-errors) (+ non-negotiable #1) |
| 14 | **No HTTPS / mixed content** | webview blocks the page/fetch | everything HTTPS; dev cert for `localhost` | [custom-functions-web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs) |

---

## 14. R-SCALE: which tier this channel survives

The Excel channel is a **read** surface (it pulls series; it never writes contested state), so the scale battery
is about read fan-out, not atomic writes.

- **Tier 1 (demo):** one analyst, a handful of `=LUMINA.SERIES` cells. Works as written. The polling streamer at
  10 s and the cached `/series` endpoint are plenty.
- **Tier 100 (a desk):** hundreds of analysts, thousands of cells. The two load-multipliers are (a) **streaming
  poll storms** and (b) **per-cell fan-out**. Mitigations, all already in our stack:
  - Excel **de-duplicates same-arg streams** (one poll loop for N identical cells — §5.3), so 500 cells of
    `=LUMINA.STREAM("SPX")` are **one** poll, not 500. This is free and load-bearing.
  - The `/series` endpoint is **Redis-cached + cron-warmed** (compute-once-serve-many): the add-in's polls hit a
    warm cache, not the upstream provider. A spike of Excel polls is absorbed by the cache, not the DB.
  - **Batch** multiple ids into one `/series?ids=a,b,c` call rather than one fetch per cell (the endpoint caps at
    20 ids/request per the series-retrieval contract) — the doc explicitly suggests *"batching up multiple API
    requests"* ([web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)).
- **Tier 10,000 (whole firm):** raise poll intervals (30–60 s for slow series), switch hot live series to the
  **WebSocket** transport (§5.6) so the worker pushes instead of every client polling, and rely on the cache's
  stale-while-revalidate so a thundering herd of opens at 9:30am market-open is served stale-but-instant while
  one background refresh runs. The **break** at this tier is the upstream provider rate budget — which the
  gateway's cache + rate-limiter owns, *not* the add-in. The add-in must never be the thing that decides to skip
  the cache.

**What breaks if you ignore this:** a naive build where every cell fetches the upstream directly (no gateway
cache, no stream de-dup) turns a 200-analyst desk opening their dashboards at market open into a self-inflicted
DDoS on the upstream provider and an instant rate-limit ban. The channel's scale safety lives in the **gateway**
(cache + budget), and the add-in's job is only to (a) batch, (b) let Excel de-dup streams, and (c) poll at a
sane interval.

---

## 15. Citations (primary sources, all fetched/confirmed 2026-06)

- **Custom functions runtime (JS-only) + simple-CORS + `OfficeRuntime.storage`** —
  [learn.microsoft.com/.../excel/custom-functions-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-runtime)
- **Receive/handle data: async Promise, streaming, `onCanceled`, WebSockets, the `@cancelable` exclusion** —
  [learn.microsoft.com/.../excel/custom-functions-web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)
- **Autogenerate JSON metadata: all JSDoc tags, matrix type, the `CustomFunctionsMetadataPlugin`, `@streaming`/`@supportSync`/`@volatile` rules** —
  [learn.microsoft.com/.../excel/custom-functions-json-autogeneration](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-json-autogeneration)
- **Dynamic arrays / spilled ranges + streaming dynamic arrays + `#SPILL!`** —
  [learn.microsoft.com/.../excel/custom-functions-dynamic-arrays](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-dynamic-arrays)
- **Errors: `CustomFunctions.Error`, `ErrorCode` enum, `#N/A`/`#VALUE!` messages, try/catch, default `#VALUE!`** —
  [learn.microsoft.com/.../excel/custom-functions-errors](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-errors)
- **Synchronous custom functions are PREVIEW (do not ship)** —
  [learn.microsoft.com/.../excel/custom-functions-synchronous](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-synchronous)
- **Shared runtime config: `lifetime="long"`, SharedRuntime 1.1, XML + JSON manifest, webpack, "full CORS from custom functions"** —
  [learn.microsoft.com/.../develop/configure-your-add-in-to-use-a-shared-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime)
- **Authentication for custom functions: `OfficeRuntime.storage`, `OfficeRuntime.displayWebDialog`, `Office.ui.messageParent`** —
  [learn.microsoft.com/.../excel/custom-functions-authentication](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-authentication)
- **SSO: `OfficeRuntime.auth.getAccessToken`, OBO flow, `WebApplicationInfo`, Identity API 1.3, error 13003, NAA note** —
  [learn.microsoft.com/.../develop/sso-in-office-add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins)
- **`CustomFunctions.StreamingInvocation` (`setResult: (value: ResultType | Error) => void`, extends `CancelableInvocation`, API set 1.1)** —
  [learn.microsoft.com/.../custom-functions-runtime/customfunctions.streaminginvocation](https://learn.microsoft.com/en-us/javascript/api/custom-functions-runtime/customfunctions.streaminginvocation)
- **`CustomFunctions.Invocation` (`address`, `parameterAddresses`, `functionName`, `isInValuePreview`)** —
  [learn.microsoft.com/.../custom-functions-runtime/customfunctions.invocation](https://learn.microsoft.com/en-us/javascript/api/custom-functions-runtime/customfunctions.invocation)
- **Shared-runtime CORS field reports** —
  [github.com/OfficeDev/office-js/issues/1383](https://github.com/OfficeDev/office-js/issues/1383),
  [github.com/OfficeDev/office-js/issues/2178](https://github.com/OfficeDev/office-js/issues/2178)
- **xlwings Server custom functions (`@func` from `xlwings.server`, `async def`+`yield` streaming, Socket.io WebSocket, `#BUSY!`)** —
  [server.xlwings.org/en/latest/custom_functions/](https://server.xlwings.org/en/latest/custom_functions/),
  [docs.xlwings.org/.../officejs_custom_functions](https://docs.xlwings.org/)
- **Centralized deployment (M365 admin center, Exchange Online requirement)** —
  [learn.microsoft.com/.../admin/manage/manage-deployment-of-add-ins](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins),
  [learn.microsoft.com/.../admin/manage/centralized-deployment-of-add-ins](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/centralized-deployment-of-add-ins)
