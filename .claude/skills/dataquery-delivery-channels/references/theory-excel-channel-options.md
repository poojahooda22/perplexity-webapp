# theory · The Excel Channel — Office.js custom functions vs xlwings Server vs legacy RTD

> **What this doc is.** The *decision* document for the **Excel delivery channel** of the
> **JPM-Markets re-engineering data-analytics product line (NOT Lumina)**. The incumbents
> (`theory-incumbent-channel-models.md`) ship the same logical data through four doors — Web · API ·
> Batch · **Excel** — and DataQuery's Excel add-in (`=` formula in a cell pulls a J.P. Morgan series)
> is the one we are re-engineering here. This doc does the work that comes **before** the build recipe:
> it lays out the only three technical ways to put a live, grounded series into an Excel cell on this
> stack, fires the constraint matrix at each (platform reach · streaming · dev language · CORS/runtime ·
> auth · maintenance), anchors the formula-driver UX to Bloomberg/Refinitiv as the proven reference,
> and **picks one** so `patterns-excel-addin-*.md` can build it without re-litigating the choice.
>
> **Scope note (from `cto-rules.md`).** This product line re-engineers JPM-Markets internal products
> into our own, better. It is a *separate product line*, NOT a feature of Lumina (the Bun + Express
> Perplexity-style app this repo also hosts). Nothing here wires into Lumina's app code. The data plane
> is the new Python/FastAPI/data-engineering line; the Excel add-in is a thin front-end over the same
> `/expressions/time-series` query API the other three channels expose
> (`theory-query-api-contract.md`).

---

## Evidence tiering — read this first

Every load-bearing claim carries one of three tags. The rule is from `cto-rules.md`: **ground every
empirical / version / behavior claim, or mark it `[unverified]` and name what would verify it.**

| Tag | Meaning | What earns it |
|---|---|---|
| **`[verified]`** | Read this run from a primary source — the actual published doc or repo. | A URL + an excerpt I quoted, or a `repo:file` I read. |
| **`[inferred]`** | Not stated verbatim, but follows from two+ `[verified]` observations by first-principles reasoning, with the bridge shown and flagged. | The observations are each `[verified]`; the join is mine. |
| **`[unverified]`** | Could not confirm from a primary source this run (auth-walled portal, 403, binary PDF). Named so a future pass closes it. | I state exactly what doc would verify it. |

**A standing trap this doc enforces.** Marketing pages and old tutorials say "Excel add-in" as if it
were one thing. It is **three incompatible runtimes** with different OS reach, different languages, and
different real-time mechanisms. Conflating them is the "industry-standard claim with no industry named"
the red-team loop (`R70`, goal Q3) exists to catch. Below, every "Excel add-in" claim is tagged for
*which of the three* it describes.

**Versions pinned this run (so a future reader can detect drift):**

- **Office.js Custom Functions requirement sets** — current shipped ceiling is **CustomFunctionsRuntime
  1.5** (`ms.date: 2025-10-17` on the requirement-set page). 1.1 = first version; 1.2 added
  `CustomFunctions.Error`; 1.3 added XLL-streaming compat; 1.4 added data-types integration; 1.5 added
  linked-entities + formula value-preview. `[verified]` — quoted below from
  `learn.microsoft.com/.../custom-functions-requirement-sets`.
- **xlwings** — the streaming/Office.js custom-functions surface is documented at `docs.xlwings.org`
  (page snapshot `0.32.1`) and `server.xlwings.org` (page `latest`). `@server.func` streaming via
  Socket.io shipped with the xlwings Server line. `[verified]`.
- **xlwings PRO license** — *"free for noncommercial usage under the PolyForm Noncommercial License
  1.0.0"*; commercial use needs a paid plan. `[verified]` — quoted below. **This is a licensing gate on
  the xlwings option**, separate from the market-data `commercialOk` gate.

---

## 0. The one-paragraph thesis (the on-ramp)

Putting a live J.P.-Morgan-style series into an Excel cell means writing a **custom function** —
`=LUMINA.SERIES("USDOIS","2020-01-01","")` resolves to a spilled range of dates and values, just like
Bloomberg's `=BDH(...)` or Refinitiv's `=RHistory(...)`. There are exactly **three** mechanisms to back
that function, and they are not interchangeable. **(1) Office.js custom functions** — you write the
function in JavaScript/TypeScript inside a web add-in; Microsoft runs it inside Excel's own sandbox;
runs on **web + Windows + Mac** (the modern, native-Microsoft path). **(2) xlwings Server** — you write
the *same* function in **Python** on your FastAPI backend, and xlwings generates the Office.js shim for
you and pushes streaming updates over a **WebSocket (Socket.io)**; you keep all logic server-side in the
language the rest of the data plane is written in. **(3) Legacy RTD** — a COM `RealTimeData` server
wired to Excel's built-in `=RTD(...)` function; **Windows-only**, no server ships with Office, you build
and register a COM/DCOM component yourself; this is how 2005-era terminals (and Lightstreamer's Excel
bridge) streamed, and it is the path we **avoid**. The decision: **default to Office.js custom functions
in a shared runtime** for reach + zero-COM + native Microsoft support; **reach for xlwings Server only
if** the team wants to keep add-in logic in Python and wants Python-pushed streaming; **never build
RTD** unless a hard constraint forces a Windows-only desktop with no internet egress.

---

## 1. The three approaches, end to end

### 1.1 Approach A — Office.js custom functions (the Microsoft-native path)

**What it is.** A custom function is *"a function that you define in JavaScript as part of an
add-in"* that Excel evaluates in a cell. `[verified]` —
`learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-overview` ("custom functions
enable developers to add new functions to Excel by defining those functions in JavaScript as part of an
add-in"). The author writes a JS/TS function, tags it with a `@customfunction` JSDoc comment, and ships
it inside an Office Web Add-in (a manifest + a static-hosted JS bundle). Excel renders it with
IntelliSense and runs it inside its own webview/JS sandbox.

**The cell UX it produces:**

```
=LUMINA.SERIES("USDOIS", "2020-01-01", "2024-12-31")
```

…spills a 2-D range of `[date, value]` rows into the worksheet, exactly the
field-selection-in-a-cell shape Bloomberg's `BDH` and Refinitiv's `RHistory` established (§4).

**The minimal function (one-shot fetch).** Custom functions that hit a REST API are asynchronous by
nature — *"Excel needs to wait for the data to arrive…your function must return a JavaScript
`Promise`…Excel automatically waits for the promise to resolve before displaying the result."*
`[verified]` — `custom-functions-web-reqs`. The doc's own canonical fetch example, verbatim:

```javascript
/**
 * Requests the names of the people currently on the International Space Station.
 * @customfunction
 */
function webRequest() {
  let url = "https://www.contoso.com/NumberOfPeopleInSpace"; // hypothetical URL
  return new Promise(function (resolve, reject) {
    fetch(url)
      .then(function (response){ return response.json(); })
      .then(function (json) { resolve(JSON.stringify(json.names)); })
  })
}
```

Our re-engineered version, returning a grounded series with provenance:

```typescript
/**
 * Pull a time series from the Lumina-DQ data plane.
 * @customfunction SERIES
 * @param {string} expression  e.g. "USDOIS" or "DB(JPMAQS,USD_GB10YXR_NSA)"
 * @param {string} startDate   ISO date, inclusive
 * @param {string} [endDate]   ISO date, inclusive; "" = today
 * @returns {Promise<(string|number)[][]>} 2-D [date, value] range that spills
 */
async function series(expression, startDate, endDate) {
  const token = await getAccessToken();              // §5 — OAuth + API key
  const qs = new URLSearchParams({
    expressions: expression, start: startDate, end: endDate || "",
  });
  const res = await fetch(`${API_BASE}/expressions/time-series?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },   // simple-CORS-safe header set §3
  });
  if (!res.ok) {
    // never fabricate — surface the typed failure as a cell error (non-negotiable #1 analog)
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.notAvailable,
      `Lumina-DQ ${res.status}`
    );
  }
  const body = await res.json();
  // body.series[0].observations = [[isoDate, value], ...]
  return body.series[0].observations.map(([d, v]) => [d, v]);
}
```

**The streaming variant (live prices).** A streaming custom function calls `setResult` repeatedly
instead of returning once. *"Streaming functions use the `@streaming` tag and
`CustomFunctions.StreamingInvocation` parameter… they can call `setResult` multiple times to update the
cell value continuously."* `[verified]` — `custom-functions-web-reqs`. The doc's verbatim
interval-poll streamer:

```javascript
/**
 * Streams stock price updates.
 * @customfunction
 * @param {string} ticker Stock ticker symbol.
 * @param {CustomFunctions.StreamingInvocation<number>} invocation
 */
function stockPrice(ticker, invocation) {
  const updateInterval = 10000; // every 10 seconds
  const timer = setInterval(() => {
    fetch(`https://api.example.com/stock/${ticker}`)
      .then(response => response.json())
      .then(data => { invocation.setResult(data.price); })
      .catch(() => {
        invocation.setResult(
          new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable)
        );
      });
  }, updateInterval);
  invocation.onCanceled = () => { clearInterval(timer); };
}
```

And the **WebSocket** streamer — Excel custom functions can hold a persistent socket; the doc says so
explicitly: *"Within a custom function, you can use WebSockets to exchange data over a persistent
connection with a server. WebSockets are useful for real-time data that updates frequently, such as
financial tickers."* `[verified]` — `custom-functions-web-reqs`. Verbatim:

```javascript
/**
 * Streams real-time data via WebSocket.
 * @customfunction
 * @param {string} symbol Data symbol to monitor.
 * @param {CustomFunctions.StreamingInvocation<string>} invocation
 */
function streamWebSocket(symbol, invocation) {
  const ws = new WebSocket('wss://example.com/data');
  ws.onopen = () => { ws.send(JSON.stringify({ subscribe: symbol })); };
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    invocation.setResult(data.value);
  };
  ws.onerror = () => {
    invocation.setResult(
      new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable)
    );
  };
  invocation.onCanceled = () => { ws.close(); };
}
```

**The cancellation contract — read this carefully, it is the #1 leak source.** Excel cancels a function
when the user edits/deletes the referencing cell, when an argument changes (a *new* invocation also
fires), or on manual recalc. *"Proper cleanup in the `onCanceled` callback is important to prevent
unnecessary network requests. Always clear timers, close connections, and abort pending requests."*
`[verified]`. And the ordering caveat that trips people: *"The ordering between the cancellation of the
old function call and the new invocation is **not guaranteed**… Your add-in code should not depend on
`onCanceled` firing before the next invocation."* `[verified]` — `custom-functions-web-reqs`. **Design
your `onCanceled` to be safe regardless of order** — close the *specific* socket this invocation opened,
keyed by invocation, not a shared module-level socket.

**Stream re-use semantics (a scale fact).** *"Excel treats calls to a streaming function with distinct
sets of arguments as different streams. If multiple formulas reference the same streaming function with
the same arguments, Excel reuses the existing stream rather than creating a new one."* `[verified]` —
`custom-functions-web-reqs`. **Consequence for us:** 500 cells all calling `=LUMINA.QUOTE("AAPL")` open
**one** stream, not 500. But 500 cells each on a *different* ticker open 500 sockets — that is the
client-side fan-out ceiling the R-SCALE battery (Q2) makes you name (§7).

**Runtime requirement — why "shared runtime" is non-optional for us.** Custom functions can run in two
runtimes:

- **JavaScript-only runtime** (the default, on Windows/Mac when *not* shared). *"This runtime is
  optimized for fast calculation but has fewer APIs."* `[verified]` —
  `custom-functions-runtime`. There is a **documentation contradiction** worth flagging: the
  `custom-functions-runtime` page says the JS-only runtime requires *"Same Origin Policy and simple
  CORS… simple CORS… only supports simple methods (GET, HEAD, POST)… field names Accept,
  Accept-Language, Content-Language… Content-Type… application/x-www-form-urlencoded, text/plain, or
  multipart/form-data."* `[verified]`. But the newer `testing/runtimes` page (ms.date 2025-11-06)
  describes the JS-only runtime as *"a JavaScript engine supplemented with support for WebSockets, **Full
  CORS**…and client-side storage… It doesn't support local storage or cookies."* `[verified]`. **The
  reconciliation:** the JS-only runtime gained Full CORS over time; the older custom-functions page is
  stale on this point. The *safe, contradiction-proof* engineering call: **use a shared runtime**, where
  *"Custom functions will have full CORS support"* is stated unambiguously (`configure-...-shared-runtime`,
  `[verified]`) — and the `Authorization: Bearer` header (a *non-simple* header) is needed for our
  auth anyway, so simple-CORS would block us regardless. `[inferred]` — bridge: `Bearer` is not in the
  simple-CORS allowed header set quoted above, therefore the JS-only-runtime-as-simple-CORS reading
  cannot carry our auth; shared runtime is required.

- **Shared runtime** (a *browser-type* runtime shared by the task pane + ribbon + custom functions).
  *"With a shared runtime, you'll have better coordination across your add-in and access to the DOM and
  CORS from all parts of your add-in."* `[verified]` — `configure-...-shared-runtime`. It also unlocks
  *"Custom functions can call Office.js APIs to read spreadsheet document data"* and full CORS. The
  manifest cost is small (the `<Runtimes>`/`lifetime="long"` block, §6).

**Platform reach.** Office.js custom functions run on **Excel on the web, Excel on Windows (M365
subscription), Excel on Mac (M365 subscription)**, and **retail-perpetual / LTSC** at the stated builds.
`[verified]` — the requirement-set table (§2). **Not supported on iPad**, and **not on
volume-licensed perpetual Office 2021 or earlier** at the *modern* runtime levels. `[verified]` —
*"Excel custom functions aren't currently supported in Office on iPad or volume-licensed perpetual
versions of Office 2021 or earlier on Windows."*

---

### 1.2 Approach B — xlwings Server (the Python-pushed path)

**What it is.** xlwings Server lets you write the add-in's logic in **Python** and have xlwings produce
the Office.js custom function on top of it. The decorator is imported from `xlwings.server` — *"The
decorators for Office.js are imported from `xlwings.server` instead of `xlwings`."* `[verified]` —
`docs.xlwings.org/.../officejs_custom_functions`. The minimal function:

```python
from xlwings import server

@server.func
def hello(name):
    return f"Hello {name}!"
```

It is, architecturally, **Approach A with the JS written for you in Python** — the cell still runs an
Office.js custom function, but the *implementation* lives on your FastAPI server, and xlwings ships the
thin Office.js shim + manifest. xlwings explicitly supports FastAPI: *"To run the backend with FastAPI,
run… `python app/server_fastapi.py`… the quickstart repo contains various implementations such as
`app/server_fastapi.py`."* `[verified]` — xlwings server-deployment search result. **This matters for
us**: our data plane is already FastAPI (`python-fastapi-data-service` skill), so the add-in becomes one
more router on the same app.

**The streaming model — this is the RTD successor.** xlwings' streaming functions are async generators
that `yield`, and xlwings states they replace RTD: *"streaming functions don't use a local COM server.
Instead, the process runs as a background task on xlwings Server and pushes updates via WebSockets
(using Socket.io)."* `[verified]` —
`docs.xlwings.org/.../officejs_custom_functions`. And the positioning, verbatim from the changelog
context: streaming functions *"are the successor of RealTimeData/RTD functions."* `[verified]` —
search result over `docs.xlwings.org` changelog. The connect-once-stream-to-the-whole-company pitch:
*"you can connect to your data source in a single place and stream the values to every Excel
installation in your entire organization."* `[verified]` — `server.xlwings.org/.../custom_functions`.

The canonical streaming example (a live crypto quote), verbatim:

```python
import asyncio
import httpx
import pandas as pd
from xlwings import server

@server.func
@server.ret(date_format="hh:mm:ss", index=False)
async def btc_price(base_currency="USD"):
    while True:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://cex.io/api/ticker/BTC/{base_currency}"
            )
        response_data = response.json()
        response_data["timestamp"] = pd.to_datetime(
            int(response_data["timestamp"]), unit="s"
        )
        df = pd.DataFrame(response_data, index=[0])
        df = df[["pair", "timestamp", "bid", "ask"]]
        yield df
        await asyncio.sleep(1)
```

**The async discipline xlwings enforces** (and why it pairs with our stack): *"you're moving in the
async world with streaming functions, so you shouldn't use long-running blocking operations… use one of
the async libraries such as `httpx` or `aiohttp` instead of `requests`."* `[verified]`. Our data plane
already standardizes on **one shared `httpx.AsyncClient`** (`python-fastapi-data-service`), so a
streaming function reuses the same upstream client and connection pool.

**Conversion/typing power for free.** xlwings does the pandas↔Excel marshalling: a returned
`pd.DataFrame` *"automatically spills into surrounding cells"*; `@arg`/`@ret`/type hints control
index/header/date formatting; *"Since v0.32.0, type hints can replace or complement decorators."*
`[verified]` — `server.xlwings.org/.../custom_functions`. Example:

```python
import pandas as pd
from xlwings import server

@server.func
@server.arg("df", pd.DataFrame, index=False, header=False)
@server.ret(index=False, header=False)
def correl2(df):
    return df.corr()
```

**Error semantics.** *"Whenever there's an error in Python, the cell value will show `#VALUE!`."* A
production switch hides internals: *"Production mode (`XLWINGS_ENVIRONMENT=prod`) shows only
`xlwings.XlwingsError`; development mode shows all errors."* `np.nan`/`pd.NA` → Excel `#NUM!`.
`[verified]`. This maps cleanly onto our "never fabricate, surface a typed failure" rule — a failed
upstream raises `XlwingsError("unavailable")` and the cell shows `#VALUE!`, never a stale number.

**The license gate (decision-relevant).** xlwings Server's add-in features are **xlwings PRO**, which is
*"free for noncommercial usage under the PolyForm Noncommercial License 1.0.0… to use xlwings PRO in a
commercial context beyond the trial, you need to enroll in a paid plan."* `[verified]` — search result
over `xlwings.org/pricing` + `docs.xlwings.org/.../license`. *"xlwings PRO licenses are developer
licenses… allow royalty-free deployments to unlimited internal and external end-users and servers…
deploy keys… are bound to a specific version of xlwings."* `[verified]`. **So Approach B carries a
recurring commercial license cost and a version-pinned deploy key** that Approach A (Microsoft-native,
MIT-licensed Office.js) does not. This is a real, named trade-off — not a footnote.

**Platform reach.** Because the cell-side artifact is still an Office.js custom function, xlwings Server
inherits the **same web + Windows + Mac reach** as Approach A. `[inferred]` — bridge: xlwings emits
Office.js custom functions (`[verified]`), and Office.js custom functions' reach is the requirement-set
table (`[verified]`), so the reach is identical; the difference is *where the logic runs*, not *where
the cell runs*.

---

### 1.3 Approach C — legacy RTD server (the COM path we avoid)

**What it is.** Excel has a built-in worksheet function, `=RTD(...)`, that pulls live values from a
**COM automation server** you register on the machine. *"The RTD function retrieves real-time data from
a program that supports COM automation."* `[verified]` — Microsoft Support `RTD function`. The cell
formula shape:

```
=RTD(ProgID, Server, Topic1, [Topic2], ...)
```

- **ProgID** — the registered COM class of your RTD server, e.g. Interactive Brokers'
  `"Tws.TwsRtdServerCtrl"`. `[verified]` — `interactivebrokers.github.io/tws-api/tws_rtd_server`.
- **Server** — `""` for a local server. `[verified]`.
- **Topics** — the strings your server interprets as "what to stream" (ticker, field, etc.). `[verified]`.

A real IB example, verbatim from the IB docs: ProgID `"Tws.TwsRtdServerCtrl"`, Server `""`, then
ticker/topic strings; *"TWS RTD Server API formula is not case-sensitive."* `[verified]`.

**Why we avoid it — four hard facts, each cited:**

1. **Windows-only, by construction.** RTD is COM. *"RTD relies on Windows COM technology, which means
   it does not work on macOS… the TWS RTD Server API technology is supported on Windows Environment
   only."* `[verified]` — IB docs + the RTD search synthesis. There is **no path to Excel-on-the-web or
   Excel-on-Mac**. That alone disqualifies it for a product whose reach pitch is "every Excel."

2. **No server ships with Office — you build and register a COM/DCOM component.** Excel provides the
   `=RTD()` *consumer*; the *server* is yours to author, COM-register (`ProgID`), and ideally
   digitally sign. *"The ProgID must be the name of a registered COM automation add-in… installed on the
   local computer… RTD servers should be digitally signed; if not, the server may not load and a `#N/A`
   error will be displayed."* `[verified]` — RTD search synthesis. Microsoft's own
   how-to-build-an-RTD-server article is now under **previous-versions / content-retirement**
   (`learn.microsoft.com/.../previous-versions/...create-realtimedata-server-in-excel`, and the related
   support article resolves to *"The content that you're looking for is now retired"*). `[verified]` —
   fetched this run. The path is in maintenance-mode retirement, not active development.

3. **It is the *predecessor* technology.** The whole reason xlwings calls its streaming functions *"the
   successor of RealTimeData/RTD"* (`[verified]`, §1.2) is that the industry moved off COM-RTD to
   web/WebSocket delivery. Real terminals still *offer* RTD bridges (Bloomberg via Lightstreamer's
   .NET RTD server; *"a DLL library acting as an RTD Server, which receives updates from Lightstreamer
   Server… and injects them into Excel"* — `[verified]`, `lightstreamer.com/blog/...rtd-integration`),
   but that is a **bridge for legacy desktops**, not the modern delivery surface. Bloomberg's *modern*
   delivery is B-PIPE/cloud + the web/desktop API, with RTD as a compatibility layer. `[inferred]` —
   bridge: Lightstreamer markets RTD as legacy-Excel integration while Bloomberg's product page leads
   with cloud/real-time-feed; the RTD bridge is the back-compat door.

4. **DCOM deployment + signing + registry is heavy ops.** RTD-over-DCOM can be centralized (*"you
   could even deploy a centralized remote RTD Server… across your network"*, `[verified]`,
   Lightstreamer), but that means DCOM security configuration, per-machine COM registration, and code
   signing — Windows enterprise-IT work with no web equivalent. For a greenfield, internet-connected
   product, this is strictly more operational surface than hosting a static JS bundle + a web API.

**When RTD is the *only* answer** (so we're honest, per `cto-rules.md`): an **air-gapped Windows desktop
with no outbound internet**, where the data source is a local C++/.NET process and the only IPC Excel
offers without a webview is COM. That is the legacy-trading-floor box. Our product is internet-delivered
to "every Excel," so this constraint does not bind us. If a future enterprise customer demands an
air-gapped on-prem desktop, RTD (or an xlwings *local* COM UDF — a *different* xlwings mode from the
Server path) re-enters scope; flag it then, do not pre-build it.

---

## 2. Platform reach & version floor — the requirement-set table (verbatim)

This is the load-bearing reach fact for Approaches A and B. From
`learn.microsoft.com/en-us/javascript/api/requirement-sets/excel/custom-functions-requirement-sets`
(`ms.date 2025-10-17`), the **minimum** builds/versions, quoted `[verified]`:

| Requirement set | Web | Windows (M365 sub) | Windows (retail perpetual) | Windows (VL perpetual / LTSC) | Mac | iPad |
|---|---|---|---|---|---|---|
| **CustomFunctionsRuntime 1.5** | Supported | 2504 (Build 18730.20088) | Not supported | Not supported | 16.96 (25042933) | Not supported |
| **CustomFunctionsRuntime 1.4** | Supported | 2208 (Build 15601.20148) | Not supported | Not supported | 16.64 (22081401) | Not supported |
| **CustomFunctionsRuntime 1.3** | Supported | 2008 (Build 13127.20296) | 2311 (Build 17029.20126) | Office 2021: 2108 (Build 14332.20011) | 16.40 (20081000) | Not supported |
| **CustomFunctionsRuntime 1.2** | Supported | 1909 (Build 11929.20934) | 2311 (Build 17029.20126) | Office 2021: 2108 (Build 14332.20011) | 16.34 (20020900) | Not supported |
| **CustomFunctionsRuntime 1.1** | Supported | 1903 (Build 11425.20156) | 2311 (Build 17029.20126) | Office 2021: 2108 (Build 14332.20011) | 16.34 (20020900) | Not supported |

**Reading the table for our build:**

- **Streaming + a Bearer-auth fetch needs nothing beyond 1.1** for the basic streaming/`StreamingInvocation`
  API (streaming is original-version). So our **floor is CustomFunctionsRuntime 1.1** → Web (always),
  Windows M365 ≥ 1903, Mac ≥ 16.34, Office-2021 perpetual ≥ 2108. `[inferred]` — bridge: the
  streaming docs use APIs present since 1.1 (`StreamingInvocation`, `setResult`, `onCanceled` are not
  flagged to a later set in `custom-functions-web-reqs`); only data-types (1.4) / linked-entities (1.5)
  raise the floor, and we use neither at MVP.
- **iPad is out, everywhere, every version.** If "Excel on iPad" is a required surface, **no custom
  function path exists** — that is a hard product constraint, not a tuning knob. `[verified]`.
- **Volume-licensed perpetual Office 2021/earlier is out** at modern levels. Enterprise customers on VL
  perpetual see *"Not supported."* `[verified]`. The web client is the fallback for them.

**Shared-runtime reach is a *separate* requirement set.** The shared runtime we need (§1.1) is gated by
**SharedRuntime 1.1**, declared in the manifest's capabilities; *"For a list of clients that support the
SharedRuntime 1.1 requirement set, see Shared runtime requirement sets."* `[verified]` —
`configure-...-shared-runtime`. **`[unverified]`** — I did not fetch the SharedRuntime version table
this run; verify the SharedRuntime 1.1 floor against
`learn.microsoft.com/.../requirement-sets/common/shared-runtime-requirement-sets` before pinning the
final supported-version statement, because the *effective* floor is `max(CustomFunctionsRuntime 1.1,
SharedRuntime 1.1)`.

---

## 3. The CORS / runtime constraint, made precise

This is where teams lose a day. The rules, each cited:

- **No shared runtime (JS-only runtime, Windows/Mac native):** the *older* doc restricts to **simple
  CORS** — GET/HEAD/POST, only `Accept`/`Accept-Language`/`Content-Language` (+ limited `Content-Type`)
  headers, **no cookies**. `[verified]` — `custom-functions-runtime`. The *newer* runtimes doc says the
  JS-only runtime now has **Full CORS + WebSockets** (but no cookies/localStorage). `[verified]` —
  `testing/runtimes`. **These two primary docs disagree** (§1.1). We do not bet on the resolution.
- **Shared runtime (browser-type runtime):** **Full CORS** is stated unambiguously — *"Custom functions
  will have full CORS support."* `[verified]` — `configure-...-shared-runtime`. Plus DOM, plus
  Office.js document reads.
- **On the web, custom functions *always* run in a browser-type runtime** regardless of the shared-runtime
  setting — *"Excel custom functions: JavaScript-only (but browser when the runtime is shared)… on the
  web: browser."* `[verified]` — `testing/runtimes` feature/runtime table. So the web surface has full
  CORS by default; the Windows/Mac native surface is the one that *needs* the shared runtime to
  guarantee it.

**Server-side requirement we own.** Whichever runtime, our **FastAPI data plane must emit the right CORS
response headers** for the add-in's origin (the static-host origin of the JS bundle, e.g.
`https://addin.lumina-dq.com`) and must **allow the `Authorization` header** (a non-simple header → it
forces a CORS *preflight* `OPTIONS`). `[inferred]` — bridge: `Bearer` auth is a non-simple header
(not in the simple-CORS set quoted §1.1), therefore the browser issues a preflight, therefore the server
must answer `OPTIONS` with `Access-Control-Allow-Headers: Authorization`. This is FastAPI
`CORSMiddleware` config; pin the exact origins, never `*` with credentials.

**Auth headers and simple-CORS are mutually exclusive** — another reason the shared runtime (full CORS)
is the right default: it removes the simple-CORS header constraint entirely.

---

## 4. The formula-driver UX reference — Bloomberg & Refinitiv

Our cell UX is not invented; it copies the two products every finance analyst already knows. This
section is the **product-shape anchor** (red-team goal Q3/Q4: name the leaders, cite the pattern, prove
ours matches the proven one rather than a naive variation).

**Bloomberg — `BDP` / `BDH` / `BDS`.** `[verified]` — multiple library desktop guides (`wu.ac.at`
Bloomberg Excel desktop guide; `guides.library.upenn.edu/bloomberg/excel`; `libguides.hkust.edu.hk`):

- **`BDP`** (Bloomberg Data Point) = current/snapshot single value:
  `=BDP("AAPL US Equity", "PX_LAST")`.
- **`BDH`** (Bloomberg Data History) = historical time series:
  `=BDH(Security, Field, StartDate, EndDate, [options])`, e.g.
  `=BDH("SAP GR Equity","BEST_PE_RATIO","20050101","","BEST_FPERIOD_OVERRIDE=1GY","per=M")`. `[verified]`.
- **`BDS`** (Bloomberg Data Set) = bulk/multi-row datasets.
- **Field overrides in-formula**: `=BDP("AAPL US Equity","PX_LAST","CURRENCY","EUR")` returns the price
  converted to EUR. `[verified]`.
- **Security syntax**: `(Ticker)(MarketSector)`, e.g. `TGT Equity`. `[verified]`.
- **BQL** (Bloomberg Query Language) is the newer cloud-evaluated layer: *"define the data **and** the
  analytics… aggregation/trend/filtering/scoring/ranking/zscore… to get the answer rather than the
  data."* `[verified]`. The lesson: the formula can carry *computation*, not just *retrieval* — a
  Tier-3 ambition for our expression language (`theory-query-api-contract.md`), not MVP.

**Refinitiv / LSEG Workspace (ex-Eikon) — `TR` / `RData` / `RHistory`.** `[verified]` — LSEG/Bocconi
build-formula guide; Refinitiv developer community:

- **`TR`** = real-time + fundamental retrieval with descriptive field language.
- **`RHistory`** = historical time series, e.g. `INTERVAL:1D` / `1W` / `1MO` / `TICK` controls the
  periodicity. `[verified]`.
- Eikon *"supports real-time streaming data directly into Excel cells — critical for trading desks that
  need millisecond-level updates on FX pairs or equity quotes."* `[verified]`.
- A documented cost we should beat: *"New users often require formal training… weeks of practice before
  becoming proficient with Eikon's formula syntax."* `[verified]`. **Our edge:** a *small, learnable*
  formula set (`SERIES`, `QUOTE`, maybe `META`) plus a **task-pane formula-builder** (the shared
  runtime's task pane) that writes the formula for the user — exactly the affordance Bloomberg/Refinitiv
  bolt on to tame their own complexity.

**The two UX laws we inherit from both:**

1. **One formula = one grounded series, field-selected in the cell.** The function name picks the
   *shape* (point vs history), the first arg picks the *instrument/expression*, later args pick
   *fields/overrides/date-range*. This is the `=LUMINA.SERIES(expression, start, end, [field])`
   signature directly.
2. **Provenance lives next to the value, not inside it.** Bloomberg analysts read the source/asof from
   the field metadata, not the number. Our re-engineering: a **sibling `=LUMINA.META(...)` cell**, or a
   cell **comment/note** carrying `{provider, asOf, commercialOk}`, so the displayed number stays a
   clean number while its grounding is one cell away. This satisfies the non-negotiable that **every
   displayed series carries provenance** (`commercial-ok-gate.md`) without polluting the value cell.
   Build recipe in `patterns-excel-addin-*.md`.

---

## 5. Auth into the add-in — OAuth + the API key

The add-in must authenticate the user into the same identity the Web/API channels use, then call our
data plane with a token. The mechanism depends on the runtime.

**Shared runtime (our default) — straightforward.** The task pane is a normal web page in a browser-type
runtime with DOM + full CORS + the dialog API. Run the standard OAuth 2.0 Authorization-Code-with-PKCE
flow in the task pane (or an `Office.ui.displayDialogAsync` popup), store the access token in memory +
`localStorage` (available in the browser runtime), and the custom functions — sharing that runtime —
read the same token via a shared module variable. `[inferred]` — bridge: shared runtime = one
browser-type runtime for task pane + custom functions (`testing/runtimes`, `[verified]`), so a token the
task pane holds is in-process reachable by the custom function; no cross-runtime marshalling needed.

**No-shared-runtime (JS-only runtime) — the documented dance** (we don't use this, but it's the fallback
and explains why shared runtime is worth it). The JS-only runtime has **no `localStorage`/`window`**;
you must use `OfficeRuntime.storage` (a 10 MB key-value store) + `OfficeRuntime.displayWebDialog` (the
JS-only-runtime dialog, *not* `Office.ui.displayDialogAsync`). `[verified]` —
`custom-functions-authentication`: *"When you need to authenticate from a custom function add-in that
doesn't use a shared runtime, your code should check `OfficeRuntime.storage` to see if the access token
was already acquired. If not, use `OfficeRuntime.displayWebDialog` to authenticate the user, retrieve
the access token, and then store the token in `OfficeRuntime.storage`."* The documented flow:

1. Cell calls a custom function. 2. Function uses `OfficeRuntime.dialog` to send credentials to an auth
site. 3. Site returns an access token to the dialog page. 4. Dialog calls `Office.ui.messageParent`
to send the token back. 5. Function stores it via `OfficeRuntime.storage.setItem`. 6. Task pane reads it
via `OfficeRuntime.storage.getItem`. `[verified]`. Verbatim store/retrieve:

```javascript
/** @customfunction */
function storeValue(key, value) {
  return OfficeRuntime.storage.setItem(key, value).then(
    () => `Success: key '${key}' saved.`,
    (error) => `Error saving '${key}': ${error}`
  );
}
```

The doc's hard rules on **where NOT to store tokens** (we obey these regardless of runtime):

- **Not `localStorage`** — *"custom functions that don't use a shared runtime don't have access to the
  global `window` object and therefore have no access to data stored in `localStorage`."* `[verified]`.
- **Not `Office.context.document.settings`** — *"This location isn't secure and information can be
  extracted by anyone using the add-in."* `[verified]`. **This is also our defense against the
  confused-deputy class** (Lumina non-negotiable #6 analog): the token/secret is never persisted into
  the *document*, only into runtime-scoped storage.

**The API-key layer.** Beyond the user OAuth token, our data plane (like DataQuery) authenticates the
*client* — DataQuery is *"available via Web, Excel, SFTP, email and API"* over an **OAuth client**
(`theory-incumbent-channel-models.md`, `[verified]`). For the add-in:

- **User identity** → OAuth access token (who is asking; drives entitlement/row-level data access).
- **Client identity** → the add-in's registered OAuth client_id (which app is asking; not a secret in a
  PKCE public client).
- **No long-lived secret in the bundle.** A custom-function add-in is a static JS bundle the user can
  read; **never embed a client secret or a service API key in it.** Use PKCE (public client, no secret)
  and let the data plane mint short-lived tokens. `[inferred]` — bridge: the bundle is
  user-readable (it's a webview asset), and `custom-functions-authentication` warns against insecure
  storage; therefore any embedded secret is exposed → PKCE public-client is the only safe model.

**Streaming + token expiry — the one extra concern.** A streaming function may run for hours; its token
expires. Design: the streaming function (or the shared WebSocket layer) must **refresh the token and
re-auth the socket on 401**, not silently freeze. On unrecoverable auth failure, emit a typed
`CustomFunctions.Error(notAvailable)` — *never a stale last value dressed as live* (the "metric in a
costume / sign-can-be-wrong" trap, red-team F4). `[inferred]` from the cancellation/error contract
(`[verified]`) + the no-fabrication rule.

---

## 6. The manifest — what each approach actually ships

**Approach A / B (Office.js)** ship a **web add-in manifest** + a **static-hosted JS bundle**. For the
shared runtime, the add-in-only (XML) manifest needs the requirement + a `<Runtimes>` block with
`lifetime="long"`. Verbatim from `configure-...-shared-runtime` `[verified]`:

```xml
<Requirements>
  <Sets DefaultMinVersion="1.1">
    <Set Name="SharedRuntime" MinVersion="1.1"/>
  </Sets>
</Requirements>
```

```xml
<VersionOverrides ...>
  <Hosts>
    <Host ...>
      <Runtimes>
        <Runtime resid="Taskpane.Url" lifetime="long" />
      </Runtimes>
    ...
    </Host>
```

…and the equivalent unified-manifest (manifest.json) `runtimes` array declaring both `AddinCommands 1.1`
and `SharedRuntime 1.1` capabilities, `"id": "SharedRuntime"`, `"lifetime": "long"`. `[verified]`. The
*"lifetime needs to be **long** so that your add-in can take advantage of features, such as… using CORS
and DOM from custom functions."* `[verified]`.

**Three deployment routes for the manifest** (same for A and B), `[verified]` — xlwings/Office docs:
sideload (dev), Microsoft 365 admin center (internal org-wide), Office add-in store (public). For an
enterprise re-engineering, **admin-center centralized deployment** is the realistic distribution
mechanism (push the add-in to every employee's Excel), which mirrors DataQuery's enterprise install.

**Approach C (RTD)** ships no web manifest — it ships a **COM server binary** that must be installed +
COM-registered (ProgID) + ideally code-signed on each Windows machine, or DCOM-configured for a central
server. `[verified]` — §1.3. This is MSI/installer + registry territory, not static web hosting.

---

## 7. The constraint matrix (the decision table)

Each axis below is fired at all three approaches with a cited basis. This is the artifact the build
recipe (`patterns-*`) is allowed to assume.

| Axis | A — Office.js custom fns | B — xlwings Server | C — legacy RTD |
|---|---|---|---|
| **Platform reach** | Web + Windows (M365/retail-perpetual) + Mac. **No iPad; no VL-perpetual ≤2021** at modern levels. `[verified]` §2 | **Same as A** (emits Office.js cell artifact). `[inferred]` §1.2 | **Windows-only.** No web, no Mac. `[verified]` §1.3 |
| **Real-time streaming** | Yes — `@streaming` + `StreamingInvocation.setResult` (poll **or** WebSocket). `[verified]` §1.1 | Yes — async-generator `yield`, pushed over **WebSocket/Socket.io**; the explicit "RTD successor." `[verified]` §1.2 | Yes — that's RTD's whole job (COM push). `[verified]` §1.3 |
| **Dev language** | **JS/TS** (logic in the add-in). | **Python** (logic on FastAPI; JS shim generated). `[verified]` §1.2 | C++/C#/.NET COM server. `[verified]` §1.3 |
| **CORS / runtime** | Full CORS in **shared runtime** (always full on web). `[verified]` §3 | Same; backend owns CORS headers. `[inferred]` | N/A (COM, no HTTP/CORS layer). |
| **Auth into add-in** | OAuth+PKCE in task pane (shared runtime) → token shared in-process. `[verified]` §5 | Same (Office.js auth model) **+** server-side session. | OS/COM identity or app-specific; no web OAuth path. |
| **License/cost** | **MIT Office.js, Microsoft-native, free.** | **xlwings PRO** — free non-commercial, **paid for commercial**; version-pinned deploy key. `[verified]` §1.2 | Microsoft `=RTD()` free; **your COM server** is your cost; Microsoft how-to retired. `[verified]` §1.3 |
| **Distribution** | Web manifest → sideload / **M365 admin center** / store. `[verified]` §6 | Same manifest model. `[verified]` | Per-machine COM register + sign / DCOM. `[verified]` §6 |
| **Maintenance** | Static bundle + web manifest; track CustomFunctionsRuntime version drift. | Static bundle **+ a running FastAPI server you operate** + xlwings version/deploy-key pinning. | COM registry + signing + DCOM security; legacy/retiring docs. `[verified]` |
| **Where logic lives** | In Excel's webview (client). | On your server (Python). `[verified]` | In the COM server (desktop). |
| **R-SCALE ceiling (Q2)** | Client fan-out: N distinct-arg streams = N sockets; same-arg cells de-dupe to 1. `[verified]` §1.1. Server bears the fetch load → your data plane's cache/SWR. | Server holds **one background task per stream per client** → the server is the bottleneck; scale = your FastAPI/worker capacity. `[inferred]` §1.2 | Single desktop COM process; DCOM-central is bespoke. `[verified]` |

**The R-SCALE read (named, not assumed — red-team Q2):**

- **Tier 1 (demo):** any of the three works. A handful of cells, one user.
- **Tier 2 (early traction, thousands of users, 10k cells):** Office.js shifts load to your **data
  plane**, which is already the compute-once-serve-many cached series API (`patterns-series-retrieval-*`,
  `patterns-server-side-downsampling-*`). The add-in is a thin client; the ceiling is the *API*, which
  we already designed for scale. xlwings Server adds **its own server tier** holding one async
  background task per active stream — a *second* stateful service to scale and an extra hop. `[inferred]`
  — bridge: xlwings streams run *"as a background task on xlwings Server"* (`[verified]`), so concurrent
  streams = concurrent server tasks = a server-capacity ceiling Approach A does not add.
- **Tier 3 (lakhs of cells, spike):** Office.js + a cached series API + SWR + cron-warm is the
  compute-once-serve-many shape that survives. A streaming socket per distinct subscription, fanned out
  through the data plane's stream layer (not per-cell direct-to-upstream), is the discipline. The
  upstream provider is hit *once per series* by the data plane, never once per cell — exactly the "print
  the flyer once" rule (`product-at-scale.md`).

---

## 8. Pre-mortem — "six months out, the Excel channel failed. Why?"

Per `cto-rules.md`, name the failure modes now.

1. **We shipped to "every Excel" and an enterprise customer was on iPad / VL-perpetual Office 2019.**
   The add-in silently doesn't load. **Mitigation:** the supported-surface statement (§2) is a
   *contract* surfaced to sales; the web client is the documented fallback; never promise iPad.
   `[verified]` basis.
2. **CORS preflight failures in the field.** The `Authorization` header forces a preflight the data
   plane didn't answer for the add-in origin; works in dev (same origin) breaks in prod. **Mitigation:**
   pin add-in origin in FastAPI `CORSMiddleware` with `Authorization` in allow-headers; test from the
   *deployed* origin, not localhost. §3.
3. **Streaming sockets leak because `onCanceled` assumed ordering.** A shared module-level socket got
   closed by a new invocation's cleanup. **Mitigation:** key each socket to its invocation; make
   `onCanceled` order-independent (the doc's explicit warning, §1.1). `[verified]`.
4. **Stale-value-as-live on token expiry.** A multi-hour stream's token expired; the cell kept showing
   the last value. That is a *fabricated-currency* failure (number looks live, isn't). **Mitigation:**
   refresh-on-401; on hard failure emit `notAvailable`, never hold the last value. §5.
5. **(xlwings path) the PRO license/commercial-cost or version-pinned deploy key bit us.** Chose
   Approach B for Python ergonomics, then hit the commercial license + the deploy-key-bound-to-version
   upgrade friction. **Mitigation:** if Python ergonomics aren't decisive, default to Approach A (no
   license gate); if B is chosen, budget the PRO plan and the version-pin upgrade cadence up front.
   `[verified]` §1.2.
6. **A secret leaked from the bundle.** Someone embedded a service API key in the add-in JS to "simplify
   auth." It's a static, user-readable asset. **Mitigation:** PKCE public client, zero secrets in the
   bundle, short-lived tokens minted server-side. §5.

---

## 9. Recommendation (the verdict the build recipe assumes)

**Default: Approach A — Office.js custom functions in a shared runtime.** Reasons, ranked:

1. **Reach + Microsoft-native.** Web + Windows + Mac with no COM, no second server, MIT-licensed
   Office.js, M365-admin-center distribution. `[verified]` §2, §6. The reach pitch ("every Excel")
   survives on three of four surfaces; iPad is the only gap and it is unavoidable on *any* custom-fn
   path. `[verified]` §2.
2. **The add-in is a thin client over the API we already built.** A custom function is `fetch` +
   `setResult`; all grounding, caching, licensing, and scale live in the FastAPI data plane the other
   three channels share. No new stateful tier. §7.
3. **Full CORS + auth via the shared runtime** removes the simple-CORS constraint and gives a clean
   OAuth+PKCE task-pane flow with in-process token sharing. §3, §5. `[verified]`.
4. **Lowest maintenance/ops** — static bundle + web manifest; the only drift to track is the
   CustomFunctionsRuntime/SharedRuntime version floor. §7.

**Choose Approach B — xlwings Server — only if** at least one of these is decisive:

- The team strongly prefers **keeping all add-in logic in Python** (the language of the rest of the data
  plane), accepting a second running server and the xlwings PRO **commercial license** + version-pinned
  deploy keys. `[verified]` §1.2.
- You want **Python-pushed streaming** (async-generator `yield` over Socket.io) as the *primary* model
  and value xlwings' pandas↔Excel marshalling enough to pay for it. `[verified]` §1.2.

  B is a legitimate, shipped pattern (it produces the same Office.js cell artifact, §1.2) — it is **not**
  a downgrade in reach, only a trade of "JS in the client, no license" for "Python on a server, PRO
  license." Decide on **team language + license budget**, not on capability.

**Avoid Approach C — legacy RTD — unless** a hard constraint forces a **Windows-only, air-gapped
desktop** with a local non-web data source (§1.3). It is Windows-only, ships no server (you build +
COM-register + sign one), and is the *predecessor* technology xlwings/Office moved past; Microsoft's own
build-an-RTD-server guide is retired. `[verified]` §1.3. For an internet-delivered "every Excel"
product, it is strictly more ops for strictly less reach.

**Falsifiability test for this recommendation:** the verdict flips to B if the team's add-in-logic
language is mandated Python *and* the commercial license cost is approved; it flips to C only if a signed
customer requirement is "Excel-on-Windows, no internet egress." Absent either, A stands.

---

## 10. What the build recipe (`patterns-excel-addin-*.md`) inherits from this doc

The picked design, stated so the recipe doesn't re-derive it:

- **Approach A**, **shared runtime**, **CustomFunctionsRuntime ≥ 1.1** + **SharedRuntime 1.1** floor
  (verify the SharedRuntime version table, §2 `[unverified]`).
- **Two functions at MVP:** `=LUMINA.SERIES(expression, start, end, [field])` (Promise-returning,
  one-shot, spills a `[date,value]` range) and `=LUMINA.QUOTE(symbol)` (streaming, `StreamingInvocation`,
  WebSocket-backed). Optional `=LUMINA.META(expression)` for sibling-cell provenance.
- **Auth:** OAuth 2.0 + PKCE in the task pane; token shared in-process; **no secrets in the bundle**;
  refresh-on-401 for long streams.
- **Backend:** the same `/expressions/time-series` query API the other channels use
  (`theory-query-api-contract.md`); **FastAPI `CORSMiddleware`** pinned to the add-in origin with
  `Authorization` allowed.
- **Provenance:** a sibling `META` cell or cell comment carrying `{provider, asOf, commercialOk}` — the
  value cell stays a clean number (§4).
- **Never fabricate:** a failed/over-budget/over-entitlement fetch returns `CustomFunctions.Error(...)` /
  `#VALUE!`, never a stale or invented value (§5, §8).

---

## References (primary sources read this run)

| Source | What it grounded | Tag |
|---|---|---|
| `learn.microsoft.com/.../excel/custom-functions-web-reqs` | Promise fetch, `@streaming`/`StreamingInvocation`/`setResult`, `onCanceled` + ordering caveat, WebSocket streamer, stream re-use semantics | `[verified]` |
| `learn.microsoft.com/.../excel/custom-functions-runtime` | JS-only runtime, simple-CORS restriction, `OfficeRuntime.storage` | `[verified]` |
| `learn.microsoft.com/.../testing/runtimes` | JS-only vs browser vs shared runtime, Full CORS + WebSockets in JS-only runtime (the newer claim), per-platform runtime table | `[verified]` |
| `learn.microsoft.com/.../develop/configure-your-add-in-to-use-a-shared-runtime` | Shared-runtime manifest (XML + JSON), `lifetime="long"`, full-CORS-in-shared-runtime statement, distribution | `[verified]` |
| `learn.microsoft.com/.../requirement-sets/excel/custom-functions-requirement-sets` | The version/build table (1.1–1.5), iPad/VL-perpetual exclusions, requirement-set history | `[verified]` |
| `learn.microsoft.com/.../excel/custom-functions-authentication` | No-shared-runtime auth dance, `OfficeRuntime.displayWebDialog`, `OfficeRuntime.storage`, where-not-to-store-tokens | `[verified]` |
| `docs.xlwings.org/.../pro/server/officejs_custom_functions` · `server.xlwings.org/.../custom_functions` | `@server.func`, async-generator streaming, Socket.io/WebSocket = RTD successor, httpx async discipline, `@arg`/`@ret`, error/`#VALUE!` semantics, connect-once-stream-to-org | `[verified]` |
| `xlwings.org/pricing` · `docs.xlwings.org/.../license` (via search) | PRO = PolyForm Noncommercial free / paid commercial; developer/deploy-key model | `[verified]` |
| `interactivebrokers.github.io/tws-api/tws_rtd_server` | `=RTD(ProgID,Server,...)`, `Tws.TwsRtdServerCtrl`, Windows-only COM, TWS-running requirement | `[verified]` |
| Microsoft Support `RTD function` + retired `create-realtimedata-server-in-excel` | RTD = COM automation, registration/signing, build-your-own-server, content retirement | `[verified]` |
| `lightstreamer.com/blog/...rtd-integration` + Bloomberg B-PIPE product page | RTD-over-COM/DCOM as a *legacy-Excel bridge*; modern delivery is cloud/feed | `[verified]` / `[inferred]` |
| Bloomberg Excel desktop guides; LSEG/Refinitiv build-formula guides | `BDP`/`BDH`/`BDS`/BQL + `TR`/`RHistory`/`RData` formula-driver UX, overrides, training-cost | `[verified]` |
| `jpmorgan.com/markets/dataquery` (via `theory-incumbent-channel-models.md`) | DataQuery Excel as one of four channels over one OAuth client | `[verified]` |

**Open items for a future pass (`[unverified]`):**
1. The **SharedRuntime 1.1 version/build table** — fetch
   `learn.microsoft.com/.../requirement-sets/common/shared-runtime-requirement-sets` to pin the
   *effective* supported-version floor (§2).
2. The exact **current xlwings version** and its CustomFunctionsRuntime compatibility note (page
   snapshots seen were 0.32.1 / `latest`; confirm the live version before pinning a deploy key).
3. Whether the JS-only-runtime **Full-CORS** claim (newer `testing/runtimes`) is now authoritative over
   the older simple-CORS claim — re-read both pages' `ms.date` next pass; until resolved, **shared
   runtime is the safe default** and the recommendation does not depend on the resolution.
