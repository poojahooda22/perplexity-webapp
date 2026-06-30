---
name: production-engineering
description: Production Engineering for GPU/WebGL-heavy web applications — keeping graphics-intensive apps alive at scale. Error recovery and error boundaries, performance monitoring and telemetry, GPU/VRAM memory management and leak prevention, deployment and CDN/edge caching, graceful degradation and GPU-tier fallback, WebGL context-loss detection and recovery, Sentry/observability integration, bundle optimization and code splitting, distributed tracing, OOM/crash recovery, and load/stress testing. Use when a WebGL/Three.js/R3F/canvas/shader app needs to ship, monitor, recover, or degrade gracefully in production.
metadata:
  priority: 70
  sessionStart: false
  docs: []
  pathPatterns:
    - '**/error-boundary*'
    - '**/sentry*'
    - '**/monitoring*'
    - '**/health-check*'
  bashPatterns:
    - 'sentry'
    - 'bundle'
    - 'deploy'
    - 'production'
  importPatterns:
    - '@sentry/nextjs'
    - '@sentry/browser'
  promptSignals:
    phrases:
      - 'production'
      - 'context loss'
      - 'memory leak'
      - 'error boundary'
      - 'Sentry'
      - 'bundle size'
      - 'graceful degradation'
      - 'load testing'
      - 'WebGL error'
      - 'crash recovery'
      - 'VRAM'
      - 'deploy'
      - 'Vercel'
      - 'performance budget'
      - 'shader warm-up'
      - 'FBO orphan'
      - 'context lost'
      - 'telemetry'
    allOf: []
    anyOf:
      - 'webgl'
      - 'shader'
      - 'gpu'
      - 'canvas'
      - 'fbo'
      - 'scene'
      - 'three'
      - 'render'
      - 'vram'
      - 'texture'
      - 'embed'
      - 'runtime'
      - 'context loss'
      - 'context lost'
      - 'memory leak'
      - 'frame rate'
      - 'fps'
    noneOf: []
    minScore: 4
---

# Production Engineering — Keeping WebGL Applications Alive at Scale

> Everything needed to ship, monitor, and maintain a WebGL-heavy live editor in production.
> Error recovery, performance monitoring, memory management, deployment, graceful degradation.
> Battle-tested patterns from Figma, Canva, and game studios — applied to a GPU/WebGL rendering pipeline.

---

## Decision Tree

```
Production question arrives
|
+-- "App won't load / white screen"
|   +-- WebGL context creation failed ------> REF 02: webgl-context-management
|   +-- Bundle too large -------------------> REF 06: bundle-optimization
|   +-- Asset loading failed ---------------> REF 07: cdn-caching-strategy
|   +-- Shader compilation error ------------> REF 01: error-boundaries-webgl
|
+-- "Performance degradation in production"
|   +-- Memory growing over time -----------> REF 05: memory-management-production
|   +-- Frame drops after N minutes --------> REF 03: performance-monitoring-production
|   +-- VRAM exhaustion --------------------> REF 05: memory-management-production
|   +-- FBO pool thrashing -----------------> REF 05: memory-management-production
|   +-- Hash cache miss rate high ----------> REF 03: performance-monitoring-production
|
+-- "WebGL context lost"
|   +-- Recovery protocol ------------------> REF 02: webgl-context-management
|   +-- Prevention strategies --------------> REF 01: error-boundaries-webgl
|   +-- Post-recovery resource rebuild -----> REF 02 + REF 05
|
+-- "Error tracking / monitoring"
|   +-- Sentry integration -----------------> REF 04: error-tracking-observability
|   +-- Performance dashboards -------------> REF 03: performance-monitoring-production
|   +-- GPU-specific error capture ---------> REF 04: error-tracking-observability
|
+-- "Deployment to Vercel"
|   +-- WebGL bundle optimization ----------> REF 08: vercel-deployment-webgl
|   +-- Asset preloading strategy ----------> REF 07: cdn-caching-strategy
|   +-- Code splitting for shaders ---------> REF 06: bundle-optimization
|   +-- Edge caching configuration ---------> REF 08: vercel-deployment-webgl
|
+-- "Graceful degradation"
|   +-- WebGL2 not available ---------------> REF 09: graceful-degradation
|   +-- Mobile GPU limitations -------------> REF 09: graceful-degradation
|   +-- Low VRAM devices -------------------> REF 09 + REF 05
|   +-- GPU tier detection -----------------> REF 09: graceful-degradation
|
+-- "Load testing"
|   +-- Stress test with N nodes -----------> REF 10: load-stress-testing
|   +-- Concurrent user testing ------------> REF 10: load-stress-testing
|   +-- Rapid undo/redo stress test --------> REF 10: load-stress-testing
|   +-- Memory pressure simulation ---------> REF 10 + REF 05
|
+-- "Pre-launch readiness"
    +-- Full production checklist ----------> REF 11: production-checklist
```

---

## Non-Negotiables

| # | Rule | Rationale |
|---|------|-----------|
| 1 | WebGL context loss MUST be recoverable — user never loses work | Context loss happens on ~0.5% of sessions (GPU driver update, sleep/wake, VRAM pressure). If the app crashes, the user loses their composition. Figma recovers silently; we must too. |
| 2 | Bundle size for initial load MUST be under 500KB compressed | Lazy-load materials, shaders, and non-critical node/effect definitions. Eagerly importing the entire node/material library can balloon into a multi-MB monolithic bundle. Use framework-level dynamic imports and dynamic `import()`. |
| 3 | VRAM usage MUST be monitored with hard cap (2GB default, configurable) | Even on a 24GB card, other apps share VRAM. The hard cap prevents runaway FBO allocation. Calculate as `maxCache * width * height * 8` (RGBA16F). Reduce `maxCacheTargets` if budget exceeded. |
| 4 | Error boundaries MUST catch and recover from shader compilation failures | A single malformed GLSL uniform or missing #define must NOT crash the entire canvas. Error boundary shows fallback, logs to Sentry, and allows re-render on fix. |
| 5 | Performance telemetry MUST track: FPS, VRAM, FBO pool utilization, hash cache hit rate | Without metrics, production issues are invisible. Telemetry feeds Sentry performance dashboard and enables proactive alerting before users complain. |
| 6 | No `console.log` in hot paths (`useFrame`, render loop, per-frame callbacks) | A real production freeze was traced to ~2,100 log entries/second causing a Chrome heap balloon to 2-4GB, triggering a TDR cascade that froze a high-spec workstation. Use `performance.mark()` instead. |
| 7 | FBO orphans MUST be cleaned up on node deletion | A common defect: the cache-release call (e.g. `releaseCache(nodeId)`) exists but is never invoked on deletion, so deleted nodes' FBOs persist until LRU eviction. Each orphan = 16.6MB VRAM at 1080p RGBA16F. |
| 8 | Shader warm-up pass MUST pre-compile on topology change | Simultaneous shader recompilation of 3+ materials during a render frame can exceed Windows TDR timeout (2 seconds), causing GPU reset. Warm up with 1x1 dummy render. |

---

## GPU Pipeline Production Concerns

> The patterns below assume a GPU rendering pipeline built around an **FBO compositor** (a render loop
> that composites node/effect outputs through pooled framebuffer objects) and an **FBO pool manager**
> (cache + scratch pools with LRU eviction and a VRAM budget). Map the class/function names to your own
> pipeline's equivalents.

### FBO Compositor Health Monitoring

The compositor is the heart of the rendering pipeline. Production monitoring must track:

- **Pool sizes:** Cache pool (default 24) and scratch pool (default 8) utilization
- **Eviction rates:** LRU evictions per minute — high rates indicate maxCache too low or topology thrashing
- **Cache hit rate:** Hash-based render cache should achieve >90% for static scenes (no animation)
- **Orphan count:** FBOs belonging to deleted nodes still in the cache pool

```
Health Status Thresholds:
  GREEN:  cacheHitRate > 90%, evictionRate < 5/min, orphanCount = 0
  YELLOW: cacheHitRate 70-90%, evictionRate 5-15/min, orphanCount 1-3
  RED:    cacheHitRate < 70%, evictionRate > 15/min, orphanCount > 3
```

### FBO Pool Manager VRAM Budget Enforcement

VRAM budget must be enforced at construction time:

```typescript
// Budget calculation:
bytesPerFBO = width * height * 4 * 2  // RGBA16F = 8 bytes/pixel
totalBudget = maxCache * bytesPerFBO
if (totalBudget > VRAM_HARD_CAP) {
  maxCacheTargets = Math.floor(VRAM_HARD_CAP / bytesPerFBO)
}
```

At 1080p (1920x1080), each FBO = 16.6MB. Max budget scenarios:

| Resolution | FBOs at 2GB Cap | FBOs at 1GB Cap |
|------------|-----------------|-----------------|
| 1080p      | 120             | 60              |
| 1440p      | 67              | 33              |
| 4K         | 30              | 15              |

### Hash Cache Effectiveness

The hash-based render cache skips re-rendering nodes whose inputs have not changed. Monitor:

- **Hit rate:** Percentage of frames where cached FBO is reused (target: >90% for static scenes)
- **Hash computation cost:** Should be <0.1ms per node per frame
- **Invalidation patterns:** Topology changes (edge add/remove) should clear affected hashes only, not all hashes

### Lazy Material Registration

Materials should be instantiated on first use, not at import time:

- Replace static `import './node-defs/...'` with dynamic `import()` on first use
- A node/material registry accepts a loader function; the material is created on demand
- Expected: substantially less GLSL parsed at boot, large reduction in initial bundle

### Shader Warm-Up Pass

On first frame after topology change:

1. Identify all new/changed shader variants
2. Compile each with a 1x1 dummy render target (no visible output)
3. Only then proceed with full-resolution render
4. Reference: Unreal Engine's PSO (Pipeline State Object) pre-caching

---

## Reference Index (10 files + 1 checklist)

### Core Recovery & Error Handling

| # | File | Lines | When to Load |
|---|------|-------|---|
| 01 | `error-boundaries-webgl.md` | ~500 | React error boundaries for Canvas, fallback UI, recovery from shader compilation failures, per-node error isolation |
| 02 | `webgl-context-management.md` | ~600 | Context loss detection via `webglcontextlost` event, recovery protocol (resource re-creation order), prevention via VRAM budget, Three.js `forceContextLoss()` testing |

### Performance & Monitoring

| # | File | Lines | When to Load |
|---|------|-------|---|
| 03 | `performance-monitoring-production.md` | ~500 | FPS RUM (Real User Monitoring), Core Web Vitals for GPU apps, custom metrics (FBO pool, hash cache), Vercel Analytics integration, alerting thresholds |
| 04 | `error-tracking-observability.md` | ~500 | Sentry for WebGL errors, custom breadcrumbs for compositor state, GPU info capture (`WEBGL_debug_renderer_info`), shader compilation error grouping, source map configuration |

### Memory & Resources

| # | File | Lines | When to Load |
|---|------|-------|---|
| 05 | `memory-management-production.md` | ~600 | GPU resource tracking (FBO count, texture count, buffer count), leak prevention patterns, VRAM budgeting, `performance.measureUserAgentSpecificMemory()`, Three.js `dispose()` audit checklist |

### Bundle & Deployment

| # | File | Lines | When to Load |
|---|------|-------|---|
| 06 | `bundle-optimization.md` | ~500 | Three.js tree-shaking (import from `three/src/`), code splitting with `next/dynamic`, lazy primitive loading, shader code deduplication, bundle analyzer configuration |
| 07 | `cdn-caching-strategy.md` | ~400 | Shader file caching, asset preloading with `<link rel="preload">`, cache invalidation on deploy, Vercel edge caching headers, immutable asset hashing |
| 08 | `vercel-deployment-webgl.md` | ~500 | Build optimization (standalone output), preview environments for shader testing, edge caching for static assets, serverless function cold start mitigation, `next.config.js` for WebGL apps |

### Resilience & Testing

| # | File | Lines | When to Load |
|---|------|-------|---|
| 09 | `graceful-degradation.md` | ~500 | GPU tier detection (`detect-gpu` library), reduced quality modes (half-res FBOs, fewer passes), WebGL1 fallback strategy, mobile GPU limitations (max texture units, max FBO size), user-facing quality settings |
| 10 | `load-stress-testing.md` | ~500 | 200-node stress test protocol, rapid undo/redo (50 operations in 5 seconds), memory pressure simulation, headless GPU testing with Puppeteer, CI integration for performance regression |

### Launch Readiness

| # | File | Lines | When to Load |
|---|------|-------|---|
| 11 | `production-checklist.md` | ~350 | Pre-launch gate checklist, post-launch monitoring checklist, performance budgets, deployment specifics, recommended thresholds |

---

## Related Topics

When the task spills beyond production ops, these adjacent areas often come up together:

| Topic | When it overlaps |
|-------|------------------|
| Three.js resource management | Dispose patterns, material lifecycle, renderer state |
| WebGL debugging & testing | Debugging production WebGL errors — context info, shader debug, texture inspection |
| FBO pool engineering | FBO pool sizing, eviction strategy, VRAM budget calculation, pool-manager internals |
| Node-graph architecture | Node deletion cleanup, topology change detection, edge lifecycle events that trigger FBO operations |
| Compiler / build output | Compiled output bundle optimization, shader deduplication in compiled scenes |

---

## Key Source Files (map to your project)

These are the kinds of files the rules above apply to. Substitute your project's equivalents.

| File (example) | Relevance |
|------|-----------|
| The FBO compositor / render-loop component | Main render loop — all hot-path rules apply here |
| The FBO pool manager | VRAM budget, pool sizing, eviction, orphan cleanup |
| The graph↔renderer bridge store | Bridge between the node UI and the renderer — topology change detection |
| The node/material registry | Material registration — lazy loading target |
| Any prior performance-review/forensics doc | Freeze forensic analysis — root causes and fixes |

---

## Representative Production Findings

The kind of findings a performance review surfaces, that inform every production decision:

1. **Console.log in hot paths caused system freeze** — thousands of entries/sec overwhelmed Chrome DevTools, triggered a TDR cascade. Once fixed, it must never regress.
2. **FBO orphan leak** — the cache-release call never invoked on node deletion. An LRU cap prevents an outright crash but wastes 16.6MB per orphan.
3. **Entire node/material library loaded eagerly** — a multi-MB monolithic bundle. Code splitting can cut initial load substantially.
4. **No VRAM budget monitoring** — At 1080p a max pool might be only ~3% of a 24GB discrete card, but the same pool is ~18% on a 4GB mobile GPU.
5. **Shader recompilation can stall GPU** — several materials recompiling simultaneously can exceed the Windows TDR timeout.

---

## Anti-Patterns (Things That Will Kill Production)

| Anti-Pattern | Why It Kills | Fix |
|--------------|-------------|-----|
| `console.log` inside `useFrame` | Chrome DevTools heap balloon, TDR cascade | `performance.mark()` or conditional `debug` flag |
| Creating `new THREE.Material()` per frame | Shader recompilation every frame, VRAM leak | Create once, update uniforms only |
| `document.createElement('canvas')` without cleanup | Canvas elements persist in DOM, leak GPU context | Track and remove in cleanup/dispose |
| `gl.readPixels()` in render loop | GPU pipeline stall (sync read) | Use async readback or `WebGL2RenderingContext.fenceSync` |
| Unbounded undo history with FBO snapshots | Each snapshot = 16.6MB at 1080p | Cap undo depth, use hash references instead of copies |
| `window.addEventListener` without cleanup in R3F components | Listener accumulation on HMR/re-mount | Return cleanup function from `useEffect` |
