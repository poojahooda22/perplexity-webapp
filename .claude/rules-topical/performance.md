# Performance — The User-Delight Floor on Every Frame, Every Request, Every Click

> **Status.** Topical, always-loaded for the trigger paths in §1. Read at the start of every task that affects what a user sees, hears, clicks, or waits for. Performance is the substance of "feels instant" — and "feels instant" is the substance of why anyone keeps using the product.
>
> **Loading.** Always re-load when (a) editing any of §1's trigger paths, (b) writing or reviewing a plan that includes a perf claim, (c) responding to the operator's "this feels slow" / "why did this jank" / "how fast is this", (d) measuring or reporting any timing number.
>
> **Companion rules.** The project's CTO/operating policy on performance derivation (measurement, not vibes) and on the hallucinated-metric anti-pattern. A sister scalability rule, if present (scalability is the shape of the curve, performance is each point on it). The project's operating rules on cache-invalidation discipline (which prevents perf cliffs) and on AI-discipline (goal anchor — perf claims drift fastest; re-run from a clean state).

---

## §1 — Trigger paths (this rule fires on every edit to any of these)

Performance is touched by almost every change in this codebase. The trigger paths are the surfaces where a bad edit ships a visible regression to every user simultaneously. Map the surfaces below to the actual paths in *this* project; the point is the **category of surface**, not the exact filename.

| Surface | Why it ships to felt-experience |
|---|---|
| **Hot render/animation loop** (any per-frame callback, real-time UI, canvas/graphics tick) | 60fps floor / 120fps stretch; one allocation per frame × hours of session = visible jank + GC stalls |
| **Heavy client-side compute** (any in-browser pipeline that runs on a user action — compile, transform, parse, render) | A multi-second compute on a user action = a visible "Working…" stall |
| **Shipped SDK / embeddable runtime / loader** (any code a third party loads) | Every consumer pays the download + parse + execute cost; a tight gzip budget is the constraint |
| **Bundle + build** (bundler config, `package.json`, dynamic imports) | Bundle shape determines TTI on every first visit; CI build time determines deploy velocity |
| **Page load paths** (route handlers, layout/loading boundaries, entry HTML) | LCP / INP / CLS measured at p75 on real field data; below "good" = SEO + perceived-quality hit |
| **Data fetching** (API clients, query layer, server actions, route handlers) | Every round-trip is felt as wait time; a request waterfall = sequential load |
| **Animations + interactions** (anything with CSS `transition`/`animation`, pointer handlers) | Compositor-thread vs main-thread = jank-resistant vs jank-prone; pointer handler cost = INP |
| **Long lists + media** (any list/grid view, image/thumbnail loaders) | Scroll perf at 1000+ items; decode cost on first paint |
| **Complex stateful UI** (large component trees, graph/diagram editors, selection-driven views) | Re-render storms on state change; selector design determines whether a large view drops frames |
| **Autosave + sync** (background persistence, beacon paths, optimistic writes) | Beacon timing affects unload behavior; sync cadence affects keystroke responsiveness |

---

## §2 — The principle: user-perception physics is arithmetic, not preference

Performance is not "make it fast." It is **deriving each budget from physics and then engineering inside it.** The budgets are not negotiable because they come from how human nervous systems perceive delay and how browsers compose pixels — both of which were fixed long before this codebase existed.

**Jakob Nielsen, the three thresholds (Usability Engineering, 1993 — derived from neuropsychology, stable for 30+ years):**

| Threshold | Felt as | Engineering implication |
|---|---|---|
| **≤ 0.1s** | Instantaneous | No spinner needed; UI may render the result immediately |
| **≤ 1.0s** | Flow uninterrupted but noticeable | Optimistic UI / skeleton acceptable; loading state OK |
| **≤ 10s** | Attention limit | Beyond this, users tab away — work must show real progress, not a generic spinner |

([nngroup.com/articles/response-times-3-important-limits](https://www.nngroup.com/articles/response-times-3-important-limits/))

**The Google Chrome team's RAIL model — the operational budget per phase:**

| Phase | Total window | App budget | Source of overhead |
|---|---|---|---|
| **Response** (input handling) | 100ms | **50ms** | Browser rendering takes the other 50ms |
| **Animation** (per frame at 60Hz) | 16.67ms | **~10ms** | Browser needs ~6ms to render |
| **Animation** (per frame at 120Hz) | 8.33ms | **~2ms** | Same browser overhead, half the wall |
| **Idle** (per idle task) | 50ms | 50ms | Beyond this, you steal from the next Response budget |
| **Load** (initial, mid-range mobile + slow 3G) | 5s | 5s | TCP slow start + parse + execute |

([web.dev/articles/rail](https://web.dev/articles/rail))

**Core Web Vitals — Google's measured-at-p75 production metrics (March 2024 baseline):**

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| **LCP** (Largest Contentful Paint) | ≤ 2.5s | 2.5s – 4.0s | > 4.0s |
| **INP** (Interaction to Next Paint) | ≤ 200ms | 200ms – 500ms | > 500ms |
| **CLS** (Cumulative Layout Shift) | ≤ 0.1 | 0.1 – 0.25 | > 0.25 |

INP replaced FID on **March 12, 2024**. FID measured only the first interaction's input delay; INP measures every interaction throughout the session. Stricter, more representative of real felt-experience. ([web.dev/blog/inp-cwv-march-12](https://web.dev/blog/inp-cwv-march-12), [debugbear.com/docs/core-web-vitals-metrics](https://www.debugbear.com/docs/core-web-vitals-metrics))

**Karri Saarinen (Linear, on the engineering culture behind 60fps everything):** *"We don't ship things that feel slow. If it's slow, it's not done."* 60fps is a filter applied before merge, not a goal optimized toward after ship. ([linear.app/quality/02](https://linear.app/quality/02))

**Donald Knuth — the misused quote, in full context:** *"We should forget about small efficiencies, say about 97% of the time: premature optimization is the root of all evil. Yet we should not pass up our opportunities in that critical 3%."* Knuth was arguing **for** rigorous attention to the 3% that matters, **against** waste on the 97% that does not. Cargo-cult citation of the first half to avoid measurement is the opposite of what he meant. ([hlopko.com/2019/08/03/premature-optimization](https://hlopko.com/2019/08/03/premature-optimization/))

The bar this rule installs: **every perf claim has a measurement, a harness, and a real-device check; every felt-experience surface has a named budget; every regression caught at p75 of real users is a build failure.**

---

## §3 — The performance dimensions (every load-bearing edit answers each touched dimension)

Not every dimension applies to every project — a pure-backend service has no LCP, a non-graphical app has no GPU compile. Answer the dimensions your edit actually touches.

| # | Dimension | Question | Authoritative measurement |
|---|---|---|---|
| 1 | **First-paint / LCP** | How long until the largest element renders? | Lighthouse, field data (CrUX), real device |
| 2 | **Interactivity / INP** | How long after a click until the next paint? | DevTools Performance, field data |
| 3 | **Animation frame rate** | Does the frame budget hold under realistic load? | DevTools Performance, FPS meter on real hardware |
| 4 | **GPU / heavy-compute warmup** (if the project has one) | First-use cost on a cold cache? | Real-browser timing harness on real hardware |
| 5 | **Data fetch latency** | How long does an API round-trip take p50 / p95? | DevTools Network, server/DB logs |
| 6 | **Bundle size + TTI** | Per-route gzipped JS + Time to Interactive? | Bundle analyzer, Lighthouse |
| 7 | **Client compute speed** (if the project has one) | How long does the in-browser pipeline take on a typical input? | In-browser timing harness |
| 8 | **Canvas / large-view FPS** | Pan / zoom / drag / scroll on a realistic scene at 60fps? | DevTools Performance, real device |
| 9 | **Asset / media decode** | Time from blob arrival to pixel paint? | Performance Observer entries |
| 10 | **Re-render cost** | How many framework re-renders fire per user gesture? | Framework profiler (e.g. React DevTools Profiler) |
| 11 | **CSS / layout / paint** | Does an animation trigger layout or only composite? | DevTools Rendering panel (paint flashing) |

Research artifacts on perf-touching paths name what was measured, on what hardware, with what numbers. Anything else is a hallucinated metric (see the project's hallucinated-metric anti-pattern).

---

## §4 — The pattern catalogue (what senior-staff teams actually ship)

### §4.1 — Data fetching (Dimensions 1, 5)

**Resource hint operational thresholds (3-source consensus: Google web.dev + MDN + DebugBear):**

| Hint | Cost | Saves | When to use |
|---|---|---|---|
| `dns-prefetch` | cheap | DNS lookup | All cross-origin domains |
| `preconnect` | TCP + TLS handshake (idle conns close after ~10s) | **100–500ms per cross-origin connection on high-latency** | Limit to 1–2 most critical cross-origin domains |
| `preload` | priority bump | none if resource was going to load anyway | Critical above-the-fold resource only |
| `prefetch` | low-priority background fetch during idle | future navigation's RTT | Likely-next-navigation only |

([enterno.io/en/articles/prefetch-preload-preconnect](https://enterno.io/en/articles/prefetch-preload-preconnect))

**TCP slow start — the 14KB rule:** RFC 6928 sets the initial congestion window at 10 packets × MSS ≈ **14,320 bytes.** Content delivered in the first roundtrip that fits in this window needs zero additional TCP roundtrips. A tight gzip budget for any shipped/embedded entry script is not arbitrary — exceeding ~14KB moves it from "one trip" to "two trips" territory; exceeding ~30KB adds another, ~50–150ms on a 3G connection. ([tylercipriani.com/blog/2016/09/25/the-14kb-in-the-tcp-initial-window](https://tylercipriani.com/blog/2016/09/25/the-14kb-in-the-tcp-initial-window/))

**HTTP/3 gain shape (DebugBear consensus):** strongest on mobile + unstable networks (QUIC eliminates TCP head-of-line blocking at packet level); marginal on desktop + stable connection. Not always worth the deployment complexity for desktop-heavy products. ([debugbear.com/blog/http3-vs-http2-performance](https://www.debugbear.com/blog/http3-vs-http2-performance))

**Streaming SSR + Selective Hydration (React 19 + a modern meta-framework):** Suspense boundaries define streaming units. The shell renders immediately, a fallback shows until data resolves, the chunk swaps in. **Selective hydration** prioritizes hydrating whichever subtree the user first interacts with, not top-down DOM order. Measured: time-to-usable-search 1.8s → 0.9s; INP p75 ~30% improvement after converting a list to Server Components with a small client island. ([makersden.io: streaming + selective hydration](https://makersden.io/blog/suspense-streaming-selective-hydation-driving-next-level-speed-in-react-and-nextjs))

**Suspense waterfall anti-pattern:** nested Suspense boundaries load **sequentially** — inner waits for outer. Sibling Suspense boundaries load in parallel. The fix: hoist fetches to the highest common ancestor; pass unresolved Promises down; or use `Promise.all` to initiate independent fetches simultaneously. **This is the default behavior and the most common source of unexpected slow loads in Suspense-based codebases.** ([sergiodxa.com: avoid waterfalls in React Suspense](https://sergiodxa.com/tutorials/avoid-waterfalls-in-react-suspense), [Sentry: fetch waterfall in React](https://blog.sentry.io/fetch-waterfall-in-react/))

**Server Components default.** Meta-frameworks with an RSC-capable router default every component to a Server Component unless explicitly opted into a client boundary (`"use client"`). Server Component code is never sent to the client — zero bundle impact. Measured: Server Components reduce client JS by up to **70%** on component-heavy routes. Make non-interactive routes (dashboards, marketing pages, settings) Server-Component-first by default. ([digitalapplied.com/blog/nextjs-16-performance-server-components-guide](https://www.digitalapplied.com/blog/nextjs-16-performance-server-components-guide))

**Cache-Control + stale-while-revalidate:** CDN/edge rule of thumb — `stale-while-revalidate` duration ≥ 5× `s-maxage` to keep edge hit rates high. Monitor the edge-cache status header (e.g. `x-vercel-cache: HIT/MISS/STALE` or the equivalent for your CDN). ([vercel.com/blog/vercel-cache-api-nextjs-cache](https://vercel.com/blog/vercel-cache-api-nextjs-cache))

### §4.2 — Framework / render performance (Dimensions 2, 10)

**Concurrent rendering — when each hook applies (don't blanket-apply):**

| Hook | What it does | When to use |
|---|---|---|
| `useTransition` | Marks an update as non-urgent; React can interrupt for higher-priority events | You control the trigger (filter button, view switch, sort) |
| `useDeferredValue` | Provides a "lagging copy" of a value; the expensive component reads stale until React catches up | Third-party input drives change (search text controlling an expensive list) |

**Critical:** these are **perceived-performance optimizations via scheduling**, not raw-performance optimizations. They cause double-renders and add scheduling overhead. **Do not memo-everywhere-by-reflex; do not transition-everything-by-reflex.** ([React 19 Concurrency Deep Dive — DEV](https://dev.to/a1guy/react-19-concurrency-deep-dive-mastering-usetransition-and-starttransition-for-smoother-uis-51eo))

**`useMemo` / `useCallback` — measured cost:**
1. Dependency comparison on every render (shallow eq — small but not free)
2. Extra memory retention (cached values stay alive longer)
3. Cognitive load on the dependency array (a wrong dep is worse than no memo)

**Measured breakeven:** benefits appear only after **~1,000+ items** in a computation. Below that, hook overhead exceeds the savings. Dan Abramov's consensus position: profile first; memo only when measurement shows the savings outweigh the hook overhead. Defensive memoization is mechanical cargo-culting. ([blog.logrocket.com: when not to use useMemo](https://blog.logrocket.com/when-not-to-use-usememo-react-hook/), [willamesoares.com: useMemo addiction](https://willamesoares.com/posts/the-usememo-usecallback-addiction))

**React Compiler 1.0 (stable late 2025):** build-time automatic memoization at finer granularity than `React.memo` / `useMemo` / `useCallback`. Measured real-world: Sanity Studio 20–30% render-time + latency reduction; Wakelet 10% LCP + 15% INP gain (30% INP gain on pure React components). **Cannot safely memoize code dependent on `useRef`** (mutable, non-reactive by definition) — for any hot path built on stable refs read inside a per-frame callback, the compiler correctly leaves that path alone. ([infoq.com/news/2025/12/react-compiler-meta](https://www.infoq.com/news/2025/12/react-compiler-meta/))

**Zustand selector discipline (`useSyncExternalStoreWithSelector` under the hood):**

| Pattern | Subscription cost |
|---|---|
| `const { x, y } = useStore()` | Re-renders on **any** store change |
| `useStore(s => s.x)` | Re-renders only when `s.x` changes (Object.is) |
| `useStore(s => ({ x: s.x, y: s.y }))` | Re-renders **every render** — `Object.is` returns false for every new object reference |
| Selector calling `.map()`/`.filter()` inside body | Re-renders every render unless wrapped in memo + shallow-eq |

Extract multi-property selectors to stable functions defined **outside** the component. Selectors returning primitives are always safe. ([pmndrs/zustand discussion #3228](https://github.com/pmndrs/zustand/discussions/3228))

**List virtualization (TanStack Virtual recommended for new projects):** any list > ~100 items unvirtualized is a regression waiting to happen on mobile. At 1,000+ unvirtualized DOM nodes, mobile Chrome drops frames. TanStack Virtual handles 1M cells (1000×1000) at 60fps with ~60 DOM elements maintained at any time. ([tanstack.com/virtual/latest](https://tanstack.com/virtual/latest))

### §4.3 — GPU / WebGL2 (Dimensions 3, 4, 8 — applies only to projects with a graphics/canvas pipeline)

> Keep this section only if the project actually has a WebGL/Canvas/GPU surface. For a non-graphical app, skip §4.3 entirely.

**`KHR_parallel_shader_compile` — the warmup discipline:** non-blocking poll of `COMPLETION_STATUS_KHR`. The browser compiles shaders on background threads; the engine continues. Without it, `gl.getProgramParameter(program, gl.LINK_STATUS)` blocks the main thread until link completes.

**Driver support reality:** Chrome / Chromium expose the extension (WebGL 1.0 + 2.0). **Firefox does NOT support it** (Mozilla Bug 1736076). Safari unconfirmed. Production implication: **on Firefox, all shader compilation is blocking and serial.** Design any warmup to be correct even when the extension is absent. ([MDN: KHR_parallel_shader_compile](https://developer.mozilla.org/en-US/docs/Web/API/KHR_parallel_shader_compile), [Khronos registry](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/))

**Three.js / Babylon.js / PlayCanvas converged warmup pattern:** compile programs during idle time before they are needed; poll `COMPLETION_STATUS_KHR` each frame if available; fall back to a synchronous check on link if not. **Never synchronously compile inside the first render frame of a user interaction.** Encode warmup as a scoped, pre-allocated step keyed by the program set, so the cold path pays its cost off the critical interaction.

**Uniform vs `#define` for structural shader variants (the link-time arithmetic):** `uniform int uMode` keeps **all** branches reachable at link time — the driver must compile and allocate registers for every path. `#define MODE 3` preprocessed before compilation eliminates unreachable branches at parse time. A shader with 8 structural modes: **~8× faster link.** Use `#define` for structural axes (shape type, render mode, lighting model); reserve uniforms for genuinely dynamic values. Not preference — arithmetic. ([webglfundamentals.org/webgl-shaders-and-glsl](https://webglfundamentals.org/webgl/lessons/webgl-shaders-and-glsl.html), [toji.dev/webgpu-best-practices/dynamic-shader-construction](https://toji.dev/webgpu-best-practices/dynamic-shader-construction.html))

**Draw call thresholds (3-source consensus):**

| Draw calls per frame | Result |
|---|---|
| < 100 | 60fps on most devices |
| 100 – 500 | strain visible on mobile / low-end |
| > 500 | even powerful GPUs struggle |

`InstancedMesh` reduces N objects sharing a material from N draw calls to **1**. CPU-GPU pipeline mechanic: WebGL is single-threaded on the CPU side; every state change (program switch, texture bind, uniform upload) and draw call executes sequentially. **GPU utilization can be 40% while frame rate is constrained because the CPU can't feed commands fast enough.** Batching addresses the CPU bottleneck, not the GPU. ([velasquezdaniel.com: rendering 100k spheres](https://velasquezdaniel.com/blog/rendering-100k-spheres-instantianing-and-draw-calls/), [threejsroadmap.com: draw calls the silent killer](https://threejsroadmap.com/blog/draw-calls-the-silent-killer))

**GPU state change cost hierarchy (most → least expensive):**
1. **Program switch** (`gl.useProgram`) — triggers state validation, potentially a full pipeline re-emit
2. **Framebuffer binding** — changes the render target
3. **Texture binding** — invalidates the texture cache
4. **Uniform upload** — pure data transfer, cheapest

Minimize program switches first. Group draw calls by material/program, then framebuffer, then texture set. A well-designed compositor groups its passes exactly this way — programs grouped by material, render targets grouped by pool.

**FBO ping-pong:** WebGL2 cannot simultaneously read and write the same texture — ping-pong is mandatory. Two pre-allocated FBOs swap on every step; **neither is ever freed and re-allocated mid-frame.** The pathological alternative — allocate a render target per simulation step — triggers GPU memory allocation, potentially forces a GPU timeline flush, and destroys texture cache locality. Encode the two-pool swap structurally so a per-step allocation can never sneak in. ([ostefani.dev/tech-notes/ping-pong-technique](https://ostefani.dev/tech-notes/ping-pong-technique))

**Three.js / R3F pitfalls (R3F docs + Discover Three.js):**
- Adding / removing lights triggers recompilation of **all** shader programs. Use `light.visible = false` or `light.intensity = 0` (a state change, not a recompile).
- Three.js does NOT garbage-collect GPU resources. `geometry.dispose()` / `material.dispose()` / `texture.dispose()` must be called explicitly. Failing = VRAM leak.
- Non-power-of-two textures disable mipmapping; increase memory.
- Only update uniforms when they change. Redundant uniform uploads still cost CPU time.
- **Inside a per-frame callback (`useFrame`), mutate Three.js properties via refs directly — never call `setState`.** `setState` routes through the React scheduler → reconciliation → incompatible with a 60fps budget. ([r3f.docs.pmnd.rs/advanced/pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls), [discoverthreejs.com/tips-and-tricks](https://discoverthreejs.com/tips-and-tricks/))

**Mobile Safari shader gotchas:**
- `mediump float` (10-bit mantissa) causes gradient banding on iOS Metal-backed WebGL. Some noise functions only work correctly at `highp` on Safari iOS.
- `sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453` (the legacy GPU Gems hash) produces driver-dependent stripe artifacts at `mediump`. A modern integer hash (PCG / interleaved-gradient-noise) is the defense.
- Safari uses the Metal backend; different state-machine semantics from the Chrome/Firefox OpenGL model; some extensions absent. Test on real Safari iOS, not Chrome with "iPhone" device emulation. ([webglfundamentals.org: WebGL precision issues](https://webglfundamentals.org/webgl/lessons/webgl-precision-issues.html))

**KTX2 + BasisU texture compression:** the container transcodes to a GPU-native compressed format at runtime (S3TC/DXT desktop, ETC2 Android, PVRTC iOS). Compressed textures stay compressed in GPU VRAM — they upload faster and consume less bandwidth than RGBA PNG/JPEG. Measured: 32% total loaded size reduction on a sample model. Three.js + Babylon.js both support via `KHR_texture_basisu`. ([donmccurdy.com/2024/02/11/web-texture-formats](https://www.donmccurdy.com/2024/02/11/web-texture-formats/))

### §4.4 — Bundle size + load (Dimension 6)

**Tree-shaking mechanics (2-step process):**
1. The bundler marks unused exports across module boundaries
2. The minifier removes dead code within each file

`"sideEffects": false` in `package.json` tells the bundler the entire package is safe to prune. Without it, the bundler conservatively retains all imports. Bundler comparison:
- **Webpack:** safely deletes side-effect-laden CSS + JS in a subtree
- **esbuild:** deletes side-effect-laden JS but NOT CSS
- **Rollup:** more conservative, doesn't delete side-effect-laden JS without explicit config

For any shipped/embedded script with a tight gzip target, `"sideEffects": false` on all packages in the chain is **not optional** — it is the mechanism that makes the budget achievable. ([webpack.js.org/guides/tree-shaking](https://webpack.js.org/guides/tree-shaking/))

**esbuild architecture (Evan Wallace, formerly of Figma):** written in Go; native code + efficient memory management; algorithms parallelize parsing + printing + source-map generation across all CPU cores; the AST is visited in fewer passes than Webpack/Rollup. Result: **10–100× faster** than Webpack/Rollup builds. Architecture beats micro-optimization. ([github.com/evanw/esbuild/blob/main/docs/architecture.md](https://github.com/evanw/esbuild/blob/main/docs/architecture.md))

**Code splitting discipline:** dynamic imports create separate bundles loaded on demand. **Risk:** over-eager splitting creates a waterfall — the main bundle loads, renders, discovers it needs chunk A, fetches A, renders, discovers it needs B. Each network roundtrip is jank if the chunks are on the critical path. **Rule: split routes, not within routes.** Within a route, prefer a single bundle unless the component is hidden behind an explicit user action (modal, second-click panel).

**Service Worker caching:** intercept fetch, serve from local cache, make repeat visits near-instant for unchanged assets. Workbox `staleWhileRevalidate` is the correct default for versioned JS — serve from cache immediately, update in the background. A version-locked, rarely-changing CDN asset is an ideal candidate.

### §4.5 — Client-compute performance (Dimension 7 — applies only to projects with an in-browser compute pipeline)

> Keep this section only if the project runs a non-trivial compute pipeline in the browser (a compiler, transformer, parser, layout engine, simulation). For a thin client, skip §4.5.

**Roslyn red-green trees (Eric Lippert, Roslyn architect — the canonical incremental-compilation pattern):**

| Tree | Properties | Cost |
|---|---|---|
| **Green** | Immutable, no parent refs, bottom-up, caches width not absolute position | Shared between edits — unchanged nodes reused |
| **Red** | Lazy wrappers over green; supplies parent refs, absolute positions, the IDE-facing API | Created on demand, GC'd after use |

**Performance property:** a one-character edit → only the nodes on the path from that character to the root need rebuilding. All other green nodes are reused. **This is the mechanism behind sub-millisecond re-parse in large source files.** Implication for any incremental pipeline: when only one input changed, avoid rebuilding the full tree/DAG — reuse the unchanged subtree. ([ericlippert.com/2012/06/08/red-green-trees](https://ericlippert.com/2012/06/08/red-green-trees/))

**Content-addressed caching (Turborepo / Bazel model):** hash the source files + `package.json` deps + env vars + build config. A hash match → the build output is restored in milliseconds, the task never re-executes. **Measured: up to 85% CI time reduction.** The mechanism generalizes — any deterministic stage of a pipeline (same input → same output) is a content-addressed-caching candidate. ([turborepo.dev/docs/crafting-your-repository/caching](https://turborepo.dev/docs/crafting-your-repository/caching))

**Off-main-thread compute (Web Workers via Comlink):** postMessage baseline 0–1ms for the message itself; the cost is serialization/deserialization of the payload. Surma's measured benchmark: serializing 4,000 objects = 20–30ms — which cancels the benefit of moving a ~100ms process off-thread. **Workers only pay off when the computation cost substantially exceeds the serialization cost.** For a pipeline processing a payload structured to minimize serialized size, Workers are appropriate. For micro-tasks (a single small update), the overhead exceeds the benefit. ([surma.dev/things/is-postmessage-slow](https://surma.dev/things/is-postmessage-slow/))

### §4.6 — Canvas / large-view performance (Dimensions 3, 8, 10 — applies to graphics/canvas/large-stateful-view surfaces)

**Figma's architecture (the Figma-class playbook for canvas perf):** the document model + canvas renderer is C++ compiled to WebAssembly via Emscripten. JavaScript (TypeScript + React) handles the UI panels, collaboration, and app logic. The two communicate through a well-defined bridge.

Measured:
- **Load time:** WebAssembly cut Figma's load time by **3×** regardless of document size
- **Rendering:** the canvas area (geometry, vector rasterization, compositing) runs on the GPU via WebGL (migrating to WebGPU); UI panels run in the React/HTML layer
- **Bridge discipline:** the separation means GPU rendering never contends with React reconciliation — two different threads, two different rendering contexts

([figma.com/blog/webassembly-cut-figmas-load-time-by-3x](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/), [figma.com/blog/keeping-figma-fast](https://www.figma.com/blog/keeping-figma-fast/))

**The general pattern: a stable-ref bridge between the framework and the render loop.** Sync stable refs via layout effects, read them inside the per-frame callback with zero allocation. GPU/render work runs independently of the framework's scheduler; cross-thread communication is minimized; allocation inside the hot path is zero. When editing such a surface → preserve the bridge discipline; never introduce framework-state reads inside the per-frame path.

**Pointer event handling (web.dev animations):** pointer events fire at the device sample rate (1000Hz gaming mouse, 60Hz trackpad, 30Hz mobile touch). Processing each synchronously on the main thread = a budget conflict with the 10ms frame budget. Correct pattern:
1. `{ passive: true }` on pointer/touch listeners — the browser scrolls/pans on the compositor thread without waiting for the JS handler
2. Accumulate pointer events within a frame, process in the next `requestAnimationFrame` callback (coalescing)
3. For pan/zoom, prefer `transform` on a wrapper rather than repainting canvas content — the compositor handles the transform without the main thread

### §4.7 — Animation + interaction (Dimensions 2, 3, 11)

**Compositor-thread properties (web.dev animations guide):** the browser rendering pipeline = **Style → Layout → Paint → Composite.** Properties that trigger layout (width, height, top, left, margin, padding) force all four stages. Properties triggering only paint (background-color, box-shadow) force Paint + Composite. **Only `transform` and `opacity` can be promoted to compositor-only** — they skip Style, Layout, Paint entirely.

**Compositor-thread animation** runs on a separate thread from the main thread. It stays smooth even when JavaScript executes a blocking task (heavy compute, framework reconciliation, a slow round-trip). This is why splash/loading animations should use CSS (compositor-thread) — they must survive JS-thread starvation during a cold-start or heavy-compute stall. ([web.dev/articles/animations-and-performance](https://web.dev/articles/animations-and-performance), [dbaron.org/log/20150916-compositor-animations](https://dbaron.org/log/20150916-compositor-animations))

**`will-change` anti-pattern:** it creates a new GPU layer. Applied to too many elements → exhausts GPU memory → worse perf than no optimization. Apply `will-change` only to elements that will animate within the **next 200ms**, and only if you measured a problem. Defensive blanket-application is a regression. ([MDN: will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change))

**`requestAnimationFrame` vs `setInterval`:**

| Timer | Behavior | Use case |
|---|---|---|
| `requestAnimationFrame` | Syncs with display refresh (60Hz, 120Hz, 144Hz auto); pauses on a hidden tab (battery) | All visual updates |
| `setInterval` / `setTimeout` | Wall-clock scheduled; callbacks land mid-frame (jank); runs in background tabs (drains CPU) | Non-visual: polling, delayed notifications, rate limiting |

**Use rAF for visuals; use timers for logic.** ([redev.rocks: understanding requestAnimationFrame](https://redev.rocks/articles/understanding-requestanimationframe/))

**Pointer event coalescing:** browsers coalesce pointer move events — multiple between frames → only the latest is delivered to the rAF callback. `getCoalescedEvents()` provides intermediate positions, useful for pressure-sensitive paths; unnecessary for pan/zoom.

---

## §5 — Measurement: what is authoritative vs what is theater

### §5.1 — Synthetic vs RUM (3-source consensus)

| Type | Tools | What it measures | When authoritative |
|---|---|---|---|
| **Synthetic** | Lighthouse, WebPageTest, CI runs | Controlled env, reproducible, no user noise | Catching regressions in CI before ship |
| **RUM** | Field data (CrUX), SpeedCurve, Calibre, DebugBear | Real user data, real device variance, real network | Production reality (field data feeds Core Web Vitals + Search Console) |

**The danger of optimizing on dev machines:** a developer on a high-end laptop without throttling gets timings 4–10× faster than a real user on a mid-range Android. DevTools CPU throttling profiles (4× "Mobile", 6× "Low-end Mobile") approximate but don't perfectly reproduce hardware behavior. **Real device testing is the only authoritative source for mobile claims.** ([rumvision.com: synthetic vs RUM](https://www.rumvision.com/blog/understanding-the-difference-between-core-web-vitals-tools/))

### §5.2 — Software rasterizers are not a GPU (repeated because this gets violated)

A software rasterizer (e.g. SwiftShader, which headless browsers default to when no GPU is available) is a **CPU-based renderer**. It compiles shaders via a completely different code path from any real GPU driver. **Shader-compilation timings from a headless run with a software rasterizer are NOT representative of any real-world Chrome / Firefox / Safari user.** Sub-100ms compile claims from a software rasterizer are hallucinated production metrics — real GPU link times for complex shaders are 200–900ms on first compile.

**Run GPU perf harnesses on real devices or real browser instances with GPU flags enabled.** `--use-angle=gl` forces Chrome onto the native OpenGL path. A headless software-rasterizer run is suitable for testing the correctness of output pixels, NOT for timing shader compilation. ([chromium.googlesource.com: SwiftShader docs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md))

### §5.3 — Chrome DevTools Performance trace vs flame graphs

The Performance tab records: main thread + GPU thread + rasterization thread + frame timing. The flame graph shows which functions consumed time in which frames. For a per-frame render loop:
- **GPU thread trace gap + full main thread** = a CPU-side bottleneck (draw call submission, uniform upload)
- **GPU thread full + main thread idle** = a GPU-side bottleneck (shader execution, fill rate)

Brendan Gregg's flame-graph methodology (collapsing call stacks, percentages of total samples) applies directly to the Performance tab output.

### §5.4 — In-codebase perf harnesses (the only sources a perf claim should cite)

Build the project a small set of named, repeatable harnesses and make every perf claim cite one of them. A representative set:

| Surface | Harness | What it measures |
|---|---|---|
| App-shell navigation | A scripted production-build nav timer | Route-switch + prefetch timings in production build |
| GPU / heavy-compute warmup (if applicable) | Real browser with an instrumentation flag | Actual link/compute time on real hardware |
| Bundle size | Production build + bundle analyzer | Per-route gzipped JS |
| CWV in prod | Field data (CrUX) from Search Console / analytics | LCP / INP / CLS at p75 of real users |

**Perf claims cite one of these or are flagged `[unverified]`.** "Feels fast on my machine" is not evidence. Rank every number on the evidence ladder (real-artifact measurement outranks derivation outranks citation outranks recall) — and a claim's stated confidence may not exceed its rung.

---

## §6 — Concrete budgets table (every number citation-anchored)

> The graphics/SDK-specific rows below (shader link, draw calls, gzip-budget for an embedded script) apply only to projects with those surfaces. Adopt the rows your project actually has, and set project-specific budgets (e.g. your own SDK gzip target) from your own contract.

| Metric | Budget | Source |
|---|---|---|
| Response input handling | 50ms (100ms total) | [web.dev RAIL](https://web.dev/articles/rail) |
| Frame budget at 60Hz | 10ms app work (16.67ms total) | [web.dev RAIL](https://web.dev/articles/rail) |
| Frame budget at 120Hz | ~2ms app work (8.33ms total) | Frame arithmetic |
| LCP "good" | ≤ 2.5s | [web.dev CWV](https://web.dev/articles/vitals) |
| INP "good" | ≤ 200ms | [web.dev CWV](https://web.dev/articles/vitals) |
| CLS "good" | ≤ 0.1 | [web.dev CWV](https://web.dev/articles/vitals) |
| Nielsen instantaneous | ≤ 0.1s | [nngroup.com](https://www.nngroup.com/articles/response-times-3-important-limits/) |
| Nielsen flow uninterrupted | ≤ 1.0s | [nngroup.com](https://www.nngroup.com/articles/response-times-3-important-limits/) |
| Nielsen attention limit | ≤ 10s | [nngroup.com](https://www.nngroup.com/articles/response-times-3-important-limits/) |
| Embedded-script gzip budget (set per project) | e.g. ≤ 14KB / ≤ 30KB | TCP-window arithmetic + project SDK contract |
| TCP initial congestion window | ~14,320 bytes (10 × MSS) | [RFC 6928](https://tylercipriani.com/blog/2016/09/25/the-14kb-in-the-tcp-initial-window/) |
| First shader link (cold, real GPU) | 200–900ms | research consensus + real-device measurement |
| Safe draw call budget (60fps most devices) | < 100/frame | [velasquezdaniel.com](https://velasquezdaniel.com/blog/rendering-100k-spheres-instantianing-and-draw-calls/) |
| Max draw calls before GPU strain | ~500/frame | [threejsroadmap.com](https://threejsroadmap.com/blog/draw-calls-the-silent-killer) |
| postMessage round-trip (msg only) | 0–1ms | [surma.dev](https://surma.dev/things/is-postmessage-slow/) |
| postMessage serializing 4k objects | 20–30ms | [surma.dev](https://surma.dev/things/is-postmessage-slow/) |
| `preconnect` savings on high-latency | 100–500ms per cross-origin | [enterno.io](https://enterno.io/en/articles/prefetch-preload-preconnect) |
| `useMemo` breakeven (computation size) | ~1,000+ items | [logrocket.com](https://blog.logrocket.com/when-not-to-use-usememo-react-hook/) |
| React Compiler real-world INP gain | 15–30% | [infoq.com](https://www.infoq.com/news/2025/12/react-compiler-meta/) |
| Turborepo CI time reduction | up to 85% | [turborepo.dev](https://turborepo.dev/docs/crafting-your-repository/caching) |
| KTX2 vs PNG/JPEG bytes (sample) | 32% reduction | [donmccurdy.com](https://www.donmccurdy.com/2024/02/11/web-texture-formats/) |
| WebAssembly vs JS canvas perf | 3× load-time reduction (Figma) | [figma.com](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/) |
| Selective hydration INP improvement | ~30% p75 | [makersden.io](https://makersden.io/blog/suspense-streaming-selective-hydation-driving-next-level-speed-in-react-and-nextjs) |
| Server Components client-JS reduction | up to 70% | [digitalapplied.com](https://www.digitalapplied.com/blog/nextjs-16-performance-server-components-guide) |
| Per-route gzip floor | < 200KB | [Next.js docs](https://nextjs.org/docs/app/guides/package-bundling) |
| Unvirtualized list mobile-jank threshold | ~1,000+ DOM nodes | [tanstack.com/virtual](https://tanstack.com/virtual/latest) |

---

## §7 — Anti-pattern catalogue (every row sourced; reaching for any of these mid-edit = STOP)

| Anti-pattern | What ships | Why it fails / measurement | Source |
|---|---|---|---|
| **`useMemo` / `useCallback` on everything** | Defensive memo on every value/function | No benefit < ~1,000 items; adds dep-comparison overhead every render | [logrocket.com](https://blog.logrocket.com/when-not-to-use-usememo-react-hook/), [willamesoares.com](https://willamesoares.com/posts/the-usememo-usecallback-addiction) |
| **`transform: translateZ(0)` "for perf" without measurement** | Applied broadly | Creates a new GPU layer per element; exhausts VRAM | [web.dev animations guide](https://web.dev/articles/animations-guide) |
| **`will-change` on every animated element** | Defensive blanket-apply | Exhausts GPU memory; hurts perf | [MDN will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change) |
| **`setInterval` for animation** | Heartbeat-style scheduled draws | Off-display-sync (jank); runs in background tabs (battery drain) | [redev.rocks](https://redev.rocks/articles/understanding-requestanimationframe/) |
| **Software-rasterizer timings as production claims** | "Compile takes 80ms" sourced from a headless run | A different code path from any real GPU; real cold link is 200–900ms | [chromium SwiftShader docs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md) |
| **`setState` inside a per-frame callback (`useFrame`)** | React state mutation per frame | Routes through the React scheduler → reconciliation → incompatible with 60fps | [r3f.docs.pmnd.rs pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls) |
| **Per-frame texture / FBO allocation** | `new WebGLRenderTarget()` inside the hot path | GPU alloc → timeline flush → cache locality destroyed | [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) |
| **`uniform int uMode` for structural shader variants** | Switch-statement in a shader keyed by a uniform | Driver compiles all branches; link cost scales with reachable code (~8× for 8 modes) | [webglfundamentals](https://webglfundamentals.org/webgl/lessons/webgl-shaders-and-glsl.html) |
| **Over-eager dynamic imports** | Splitting inside route bodies | A sequential chunk waterfall on every nav | [vercel.com perf docs](https://vercel.com/docs) |
| **Web Workers for sub-millisecond tasks** | Worker wrapping a single small compute | postMessage serialization (20–30ms for 4k objects) > the computation savings | [surma.dev](https://surma.dev/things/is-postmessage-slow/) |
| **Misquoting Knuth to skip measurement** | "Premature optimization is the root of all evil" → ship without profiling | Misreads Knuth (he advocated FOR the critical 3%) | [hlopko.com Knuth quote in full](https://hlopko.com/2019/08/03/premature-optimization/) |
| **Zustand selector returning a new object** | `useStore(s => ({ x, y }))` | `Object.is` false every render → re-render on any store change | [pmndrs/zustand #3228](https://github.com/pmndrs/zustand/discussions/3228) |
| **Nested Suspense boundaries for parallel data** | Inner `<Suspense>` inside outer for sibling fetches | Sequential load — inner waits for outer | [sergiodxa.com Suspense waterfall](https://sergiodxa.com/tutorials/avoid-waterfalls-in-react-suspense), [Sentry blog](https://blog.sentry.io/fetch-waterfall-in-react/) |
| **`mediump float` on mobile Safari** | Default precision in a fragment shader | Gradient banding; some noise functions break | [webglfundamentals precision](https://webglfundamentals.org/webgl/lessons/webgl-precision-issues.html) |
| **Disposing retained warmup materials** | "Cleaning up after warmup" | Invalidates the shader/program cache; re-pays compile cost on next use | Three.js docs |
| **Adding/removing Three.js lights at runtime** | `scene.add(light)` mid-session | Triggers recompilation of ALL shader programs | [discoverthreejs.com](https://discoverthreejs.com/tips-and-tricks/) |
| **Unvirtualized list > 100 items on mobile** | `.map()` rendering 1,000+ DOM nodes | Mobile Chrome drops frames | [tanstack.com/virtual](https://tanstack.com/virtual/latest), [web.dev virtualize](https://web.dev/articles/virtualize-long-lists-react-window) |
| **Barrel-file imports breaking tree-shaking** | `import { X } from '~/components'` | Includes every barrel export in the bundle | [Next.js barrel discussion](https://lightrun.com/answers/vercel-next-js-tree-shaking-doesnt-work-with-typescript-barrel-files) |
| **Defensive object pooling in JS** | Manual freelist for plain objects | JS engines already optimize allocation; pooling adds GC pressure + complexity | V8 docs / measurement |
| **Reporting "feels fast on my dev machine" as a perf claim** | Vibe check on dev hardware | 4–10× faster than real mid-range Android | [rumvision.com](https://www.rumvision.com/blog/understanding-the-difference-between-core-web-vitals-tools/) |

---

## §8 — Catch-yourself triggers (you are about to ship a junior-level perf take if you think any of these)

**The perf interrogation (fire at every diff on a §1 trigger path, in writing, before the triggers below):**

1. What runs per frame after this diff that did not run per frame before? Per keystroke? Per pointer move? Name each addition or state "nothing new on the hot path."
2. What allocates inside the hot path? One object per frame is 216,000 allocations per hour of session — GC pressure the user feels as jank.
3. Is this the cold path or the warm path — and was the COLD path measured (first render, first mount, empty cache), or only the warm steady state?
4. What is the cost at the product's own limits — the largest realistic scene/document, the longest list, the most embeds/widgets on one page?
5. Which thread pays — main, compositor, GPU, worker? Work moved is not work removed; name the new owner and its budget.
6. Does this hold the 10ms frame budget on the WORST supported device, or on the dev machine? A 4× CPU-throttle run is the floor of credibility for any mobile claim.
7. What did the measurement compare against — is there a before number from the same harness, same device, same input? A lone after-number is not a measurement; it is a screenshot of a speedometer.
8. If this regresses, what catches it before a user does — a CI budget gate, a perf harness, or nothing?

- *"This feels fast."* — On what device? Throttled how? p50 or p75? Without a number, this is vibes. Cite a measurement or flag `[unverified]`.
- *"Let me add `useMemo` here."* — What's the computation cost? If you can't show it exceeds the hook overhead, the memo is noise.
- *"Just wrap it in `useTransition`."* — Concurrent hooks are perceived-perf optimizations via scheduling, not raw-perf. Double-renders + scheduling overhead. Use deliberately.
- *"I'll throw it in a Web Worker for perf."* — postMessage serialization is 20–30ms for 4k objects. Does the computation cost > serialization cost? If not, the worker makes it slower.
- *"`tsc --noEmit` is green so the feature works."* — Type-correctness ≠ feature-correctness ≠ perf-correctness. Visual verify on a real device. Measure the perf with a real harness.
- *"Premature optimization is the root of all evil."* — Knuth was arguing FOR rigor on the critical 3%. If you haven't measured which side of the line this is on, you cannot cite the quote.
- *"I'll add `will-change` to make it smooth."* — Did you measure jank first? Did you confirm this element animates within the next 200ms? If no to either, `will-change` regresses memory + perf.
- *"Let me dynamic-import this component."* — Does this create a network waterfall on the critical path? If the chunk is needed for first paint, splitting hurts. Split routes, not within routes.
- *"`setInterval(draw, 16)` should give me 60fps."* — Off-display-sync; runs in background tabs; batters battery. Use `requestAnimationFrame` for visuals, always.
- *"Headless tests show shader compile is 80ms."* — Headless usually means a software rasterizer, not a GPU. Real GPU cold link is 200–900ms. Use a real-browser harness.
- *"I'll just `Promise.all` these N fetches."* — N small now is large later; sequential Suspense waterfalls are the default failure mode. Hoist fetches to a common ancestor, parallel from there.
- *"Adding this light at runtime is fine."* — Three.js recompiles ALL shader programs on light add/remove. Use `light.visible = false` / `intensity = 0` instead.
- *"Selector inside the component is convenient."* — A selector returning a new object/array literal defeats Zustand's subscription optimization. Define stable selectors outside the component.
- *"This list only has 500 items, virtualization is overkill."* — 500 unvirtualized DOM nodes already cause jank on mid-range mobile. Virtualize above ~100 items.
- *"`s-maxage=60` is good enough; we don't need stale-while-revalidate."* — Edge rule of thumb: `swr` ≥ 5× `s-maxage` to keep the edge hit rate high. Without it, every-60s users pay the origin RTT.
- *"Lighthouse score is 95, we're fine."* — Lighthouse is synthetic on dev-class hardware. Field data at p75 of real users is the production reality. Check both.

---

## §9 — Pre-ship performance audit (run before staging any diff on a §1 trigger path)

For every load-bearing perf-touching edit, sweep these in writing. Output → PR description / plan file / end-of-turn summary, scope-appropriate.

1. **Dimensions touched.** Which of §3's axes? Name each.
2. **Budget per dimension.** What's the target (cite the §6 table)? What's the current measured number? What's the new measured number?
3. **Harness named.** Where did the number come from (a scripted nav timer / real-browser instrumentation / DevTools Performance / Lighthouse / field data)? If "feels fast", reject — that is §5 theater.
4. **Real-device check.** Was this measured on real mobile (or at least 4× CPU throttle)? If desktop-only, flag the gap.
5. **Anti-pattern check.** Cross-walk every row of §7. Any apply? If yes, justify with measurement or rework.
6. **Pair-contract sweep.** If this surface has a contracted twin (editor + runtime + compile output, or any mirrored pair the project's operating rules define), update the mirror sites and measure perf on each.
7. **Cynical question.** *Has a senior-staff team at Linear / Figma / Vercel / the Google Chrome team / a relevant OSS core solved this exact perf shape? What did they ship? Cite the blog / repo / paper.* If you can't answer, research was shallow — research deeper.
8. **Honest "I don't know."** Any unmeasured dimension → flag explicitly. Hidden uncertainty is worse than named uncertainty.

Any "no" on 3 / 4 / 6 / 7, or any unjustified "yes" on 5 → rework. Do not ship.

---

## §10 — Why this rule exists

Performance is the substance of user delight. There is no "we'll polish the perf later" — perf is felt the moment the user touches the product, every interaction, every frame. A view that takes 4 seconds to update trains the user not to iterate. A component that stalls the UI for 200ms on click trains them to mistrust it. An SDK that adds 80KB to the customer's bundle trains the customer never to embed a second instance. Every perf regression is a tax on every interaction with the product, levied silently, compounded across millions of touches.

**The product's reputation depends on the felt-experience holding up to Figma-class scrutiny.** Figma's load time, Linear's 60fps everything, Notion's perceived instant feedback — those are not marketing claims, they are engineering disciplines that filter what ships. This rule is the operational distillation that lets every agent apply the same filter on every edit, without waiting for the regression to ship and the user to flinch. Encode the discipline structurally where you can (zero-allocation per-frame callbacks, scoped warmup, compositor-thread splash, software-rasterizer rejection, cache-invalidation discipline) so the filter runs automatically.

**Felt-slow is not done.** Karri Saarinen's bar is the bar. The math is real: 60Hz = 10ms app budget; 120Hz = 2ms; INP good is 200ms; LCP good is 2.5s; a tight SDK gzip budget exists because ~14KB is the TCP initial window. Every number traces to physics or to a measurement from a senior-staff engineering team that proved the pattern at scale. There are no opinions here — only constraints, derivations, and citations.

The bar this rule installs: every perf claim is measured on a real-device harness, every regression is caught before merge, every anti-pattern is swept before staging, every budget cites its source. Cosmetics — "I think this is faster," "feels smoother now," "should be okay on mobile" — fails on sight. Substance — "p75 INP improved from 280ms to 180ms via converting a list to TanStack Virtual; measured on a Pixel 6a with 4× CPU throttle; harness output linked" — is the bar.

**The user will not tell you the product feels slow. They will just stop using it.** This rule is how that doesn't happen.

---

## §11 — Source

Directive from the operator. Research basis: 25+ web searches across the performance dimensions (user-perception physics, data fetching, framework perf, GPU/WebGL2, bundle + load, client-compute perf, canvas/large-view, animation, measurement, anti-patterns, named experts). Source categories satisfied: (1) production codebases (React, Three.js, R3F, Babylon, esbuild, TanStack Virtual, Turborepo) — (2) industry-leader engineering blogs (Linear, Figma, Vercel, the Google Chrome team, Sentry, Surma, donmccurdy.com) — (3) books/papers (Nielsen 1993, Knuth 1974, Eric Lippert's Roslyn red-green essays, RFC 6928) — (4) vendor docs (web.dev, MDN, React docs, meta-framework docs, Khronos, Chromium internals) — (5) Stack Exchange / GitHub issues (PlayCanvas KHR_parallel_shader_compile #1474, esbuild #3456, Zustand discussions #3228). Industry consensus established on the load-bearing claims; disagreements named (useMemo breakeven, HTTP/3 deployment ROI, React Compiler adoption).

The anti-pattern catalogue, named-expert quotes, and budget-derivation framing all trace directly to research findings. The performance-dimensions framing (§3) and the concrete-budgets table (§6) are the operational distillations that let this rule be invocable as a checklist rather than read as a manifesto.

---

## §12 — Index entry

For the rule index in `.claude/rules/README.md`:

- **performance.md — The user-delight floor on every frame, every request, every click.** Every perf claim cites a measurement, a harness, and a real-device check. Performance dimensions (LCP / INP / animation FPS / GPU compile / data fetch / bundle + TTI / client-compute speed / canvas FPS / asset decode / re-render cost / CSS layout/paint) with concrete budgets derived from physics (RAIL, Core Web Vitals, Nielsen, frame arithmetic, TCP slow start). A software rasterizer is not a GPU. 60Hz = 10ms app budget; 120Hz = 2ms. Felt-slow is not done — the Linear bar is the bar. Companion to a scalability rule.
