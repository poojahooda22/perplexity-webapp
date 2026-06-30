# Production Checklist

> Pre-launch and post-launch checklist for shipping a WebGL/GPU-heavy app to production.
> Covers WebGL reliability, performance budgets, monitoring, and deployment.
> Informed by real production performance-review forensics.

---

## Pre-Launch Gate (Ship Blockers)

Every item below MUST be verified before production deployment. A single failure blocks the release.

### 1. Hot Path Safety

- [ ] All console.log removed from render loop (useFrame, simulation-layer render, scene composite)
- [ ] Verify: `grep -r "console.log" <render-loop-dir>/` returns only error handlers
- [ ] No setState calls inside useFrame (causes 60 re-renders/second)
- [ ] No per-frame object allocation (new Material, new Vector3, new Color inside useFrame)
- [ ] `performance.mark()` used instead of console.log for render loop diagnostics
- [ ] DevTools-safe: app runs stable for 30 minutes with Chrome DevTools open

### 2. WebGL Context Loss Recovery

- [ ] `webglcontextlost` event listener registered on canvas element
- [ ] `webglcontextrestored` event listener triggers full resource re-creation
- [ ] Test protocol: call `renderer.forceContextLoss()` and verify recovery
- [ ] User state (node graph, properties, undo history) preserved through context loss
- [ ] All Three.js textures, materials, and geometries re-created after restore
- [ ] FBO pools (cache + scratch) re-initialized after restore
- [ ] Ping-pong simulation buffers re-allocated after restore
- [ ] User-facing toast/notification shown during recovery ("Restoring canvas...")

### 3. FBO Lifecycle Management

- [ ] `releaseCache(nodeId)` called when nodes are deleted from the graph
- [ ] `getCachedNodeIds()` (or equivalent) implemented on the FBO pool manager
- [ ] Orphan detection: after node deletion, verify no FBOs exist for removed nodeIds
- [ ] `hashMapRef` cleared for removed nodes on topology change
- [ ] Scratch pool FBOs returned after multi-pass render completes (not leaked)
- [ ] Ping-pong buffers disposed when simulation nodes are deleted
- [ ] Test: delete 10 nodes, verify `renderer.info.memory` shows reduced texture count

### 4. VRAM Budget

- [ ] VRAM hard cap implemented (2GB default, configurable via environment variable)
- [ ] FBO pool manager constructor enforces: maxCacheTargets <= floor(VRAM_CAP / bytesPerFBO)
- [ ] VRAM usage reported to telemetry: currentFBOs * bytesPerFBO
- [ ] Warning logged when VRAM usage exceeds 75% of budget
- [ ] Error boundary triggered when VRAM budget exceeded (graceful fallback, not crash)
- [ ] Test at multiple resolutions: 1080p (16.6MB/FBO), 1440p (24.9MB/FBO), 4K (66.4MB/FBO)

### 5. Bundle Size

- [ ] Main chunk < 500KB compressed (gzip or brotli)
- [ ] Three.js tree-shaken (import from `three/src/` not `three`)
- [ ] Node/effect definitions lazy-loaded via dynamic `import()` on first use
- [ ] The node-graph canvas loaded via framework-level dynamic import (not in initial bundle)
- [ ] R3F Canvas loaded via framework-level dynamic import
- [ ] Shader GLSL strings not included in initial bundle (loaded on demand)
- [ ] Bundle analyzer run against your build output
- [ ] No duplicate Three.js in bundle (check for multiple three versions)

### 6. Shader Compilation Safety

- [ ] Error boundary wraps R3F Canvas component
- [ ] Shader compilation errors caught and reported (not silent failure)
- [ ] Fallback UI shown when shader compilation fails (not white screen)
- [ ] Shader warm-up pass implemented: 1x1 dummy render on topology change
- [ ] Warm-up compiles all new shader variants before full-resolution render
- [ ] Compilation time per material logged to telemetry (target: <100ms each)
- [ ] Test: introduce intentionally broken GLSL, verify error boundary catches it

### 7. Performance Telemetry

- [ ] FPS tracking: p50, p95 percentiles reported every 60 seconds
- [ ] VRAM usage tracking: total FBO bytes reported every 60 seconds
- [ ] FBO pool utilization: cache pool %, scratch pool % reported
- [ ] Hash cache hit rate: computed per 60-second window
- [ ] LRU eviction rate: evictions per minute reported
- [ ] Orphan count: FBOs for deleted nodes reported
- [ ] All metrics sent to Sentry Performance or custom dashboard
- [ ] Alert configured: FPS p95 < 20 triggers notification
- [ ] Alert configured: VRAM > 80% budget triggers notification

### 8. Stress Testing

- [ ] 200-node stress test passes at 30fps minimum on target hardware
- [ ] Target hardware: MacBook Pro M2 (16GB RAM, integrated GPU)
- [ ] Target hardware: Windows laptop with NVIDIA GTX 1660 (6GB VRAM)
- [ ] Rapid undo/redo: 50 operations in 5 seconds, no crash, no memory spike
- [ ] Rapid node creation: add 50 nodes in 10 seconds, FBO pool stays within budget
- [ ] Rapid edge creation: connect 50 edges in 10 seconds, no hash thrashing
- [ ] Memory stability: 30-minute idle scene, VRAM growth < 10MB
- [ ] Tab switch test: switch away for 5 minutes, switch back, scene renders correctly

### 9. Mobile / Tablet Testing

- [ ] iPad Pro (M2): app loads, canvas renders, 30fps with 10 nodes
- [ ] Samsung Galaxy Tab S9: app loads, canvas renders (reduced quality acceptable)
- [ ] Touch events work: node selection, property editing, canvas pan/zoom
- [ ] GPU tier detection active: lower-tier devices get reduced quality automatically
- [ ] Reduced quality mode: half-resolution FBOs, fewer multi-pass effects
- [ ] WebGL2 availability checked: fallback message shown if not supported
- [ ] Max texture units checked: warn if device has fewer than 16 texture units

### 10. Error Tracking

- [ ] Sentry SDK installed and configured (`@sentry/nextjs`)
- [ ] Source maps uploaded to Sentry on each deploy
- [ ] WebGL-specific error grouping: shader compilation, context loss, OOM
- [ ] Custom breadcrumbs: compositor state (pool sizes, active nodes, edge count)
- [ ] GPU info captured: renderer string via `WEBGL_debug_renderer_info`
- [ ] User context: scene complexity (node count, edge count, total primitives)
- [ ] Performance tracing: render loop duration, FBO allocation time
- [ ] Rate limiting: max 10 error reports per session to avoid Sentry flood

### 11. CDN and Caching

- [ ] Static assets (JS, CSS, fonts) served with immutable cache headers
- [ ] `Cache-Control: public, max-age=31536000, immutable` for hashed assets
- [ ] Dynamic assets (API responses) use appropriate cache headers
- [ ] Vercel edge caching configured for static assets
- [ ] Asset preloading: critical JS chunks preloaded via `<link rel="preload">`
- [ ] Font files preloaded to prevent FOUT (Flash of Unstyled Text)
- [ ] No cache-busting query strings (use content hashing instead)

### 12. Code Splitting

- [ ] Dynamic `import()` active for node/material definitions (the full library)
- [ ] Materials instantiated on first use, not at import time
- [ ] The node-graph UI loaded via framework-level dynamic import with SSR disabled
- [ ] R3F Canvas loaded via framework-level dynamic import with SSR disabled
- [ ] Three.js imported from `three/src/` paths for tree-shaking
- [ ] Chunk naming strategy: meaningful names (not just hash)
- [ ] Loading states shown during lazy component load

---

## Post-Launch Monitoring Checklist

### Continuous Metrics (Dashboard)

These metrics must be monitored continuously after launch.

| Metric | Green | Yellow | Red | Action on Red |
|--------|-------|--------|-----|---------------|
| FPS p50 | > 55 | 40-55 | < 40 | Investigate render loop, check for shader recompilation |
| FPS p95 | > 30 | 20-30 | < 20 | Page alert, check for memory leak or FBO thrashing |
| VRAM growth (idle) | < 5MB/hr | 5-10MB/hr | > 10MB/hr | Memory leak, check dispose() calls and orphan FBOs |
| Hash cache hit rate | > 90% | 70-90% | < 70% | Hash function too sensitive or topology thrashing |
| Context loss rate | < 0.1% sessions | 0.1-0.5% | > 0.5% | VRAM budget too aggressive, check mobile devices |
| Error rate | < 0.5% sessions | 0.5-2% | > 2% | Shader compilation or asset loading failures |
| LRU eviction rate | < 5/min | 5-15/min | > 15/min | Increase maxCacheTargets or optimize topology |
| Bundle load time (4G) | < 3s | 3-5s | > 5s | Code splitting regression, check bundle analyzer |

### Weekly Review

- [ ] Review Sentry error dashboard: new error types, regression trends
- [ ] Review performance dashboard: FPS percentiles, VRAM trends
- [ ] Check bundle size: compare against previous deploy (flag >5% increase)
- [ ] Review user feedback: context loss reports, performance complaints
- [ ] Verify source maps: recent deploy errors show readable stack traces

### Monthly Review

- [ ] Run full 200-node stress test on latest build
- [ ] Test on mobile devices: iPad Pro, Galaxy Tab (new OS versions)
- [ ] Review VRAM budget: adjust maxCacheTargets based on real user GPU data
- [ ] Audit Three.js bundle: check for new tree-shaking opportunities
- [ ] Review and rotate Sentry DSN if needed

---

## Performance Budget

Hard limits that must not be exceeded. Violations block deployment.

### Load Performance

| Metric | Budget | Measurement |
|--------|--------|-------------|
| Initial load (compressed) | < 500KB | Main JS chunk, gzip or brotli |
| First Contentful Paint | < 1.5s | Lighthouse on 4G throttling |
| Time to Interactive | < 2.5s | Lighthouse on 4G throttling |
| Largest Contentful Paint | < 3.0s | Lighthouse on 4G throttling |
| Total blocking time | < 200ms | Lighthouse on 4G throttling |
| Cumulative Layout Shift | < 0.1 | Lighthouse (canvas should not shift) |

### Runtime Performance

| Metric | Budget | Measurement |
|--------|--------|-------------|
| FPS (target) | 60fps | requestAnimationFrame timing |
| FPS (minimum acceptable) | 30fps | p95 over 60-second window |
| Shader compilation time | < 100ms per material | performance.measure() around compile |
| FBO allocation time | < 1ms per target | performance.measure() around WebGLRenderTarget creation |
| Hash computation | < 0.1ms per node per frame | performance.measure() in hash function |
| useFrame callback | < 8ms total | performance.measure() around entire useFrame |
| React re-renders (idle) | 0 per second | React DevTools Profiler |

### Memory Budget

| Resource | Budget | Calculation |
|----------|--------|-------------|
| VRAM total | < 2GB | Sum of all FBOs + textures |
| Cache FBOs (1080p) | < 400MB | 24 FBOs x 16.6MB each |
| Scratch FBOs (1080p) | < 133MB | 8 FBOs x 16.6MB each |
| Simulation ping-pong (1080p) | < 100MB | 3 sim nodes x 2 buffers x 16.6MB |
| JS heap (tab) | < 2GB | performance.measureUserAgentSpecificMemory() |
| JS heap growth (idle) | < 5MB/hour | Measure over 30 minutes, extrapolate |

---

## Vercel Deployment Configuration

### next.config.js Requirements

```javascript
/** @type {import("next").NextConfig} */
const nextConfig = {
  // Standalone output for optimized Docker/serverless deployment
  output: "standalone",

  // Webpack configuration for WebGL/Three.js
  webpack: (config, { isServer }) => {
    // GLSL shader file support
    config.module.rules.push({
      test: /\.(glsl|vs|fs|vert|frag)$/,
      use: ["raw-loader", "glslify-loader"],
    });

    // Prevent Three.js from being bundled on server
    if (isServer) {
      config.externals.push("three");
    }

    return config;
  },

  // Image optimization (for texture assets)
  images: {
    formats: ["image/avif", "image/webp"],
  },

  // Headers for caching
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};
```

### Vercel Project Settings

| Setting | Value | Why |
|---------|-------|-----|
| Framework Preset | Next.js | Auto-detected |
| Build Command | `next build` | Standard |
| Output Directory | `.next` | Standard |
| Node.js Version | 20.x | LTS, required for Next.js 15+ |
| Serverless Function Region | iad1 (US East) | Closest to primary user base |
| Edge Function Regions | All | For static asset caching |

### Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| NEXT_PUBLIC_SENTRY_DSN | Sentry error tracking | Yes |
| SENTRY_AUTH_TOKEN | Source map upload | Yes (build time) |
| SENTRY_ORG | Sentry organization slug | Yes (build time) |
| SENTRY_PROJECT | Sentry project slug | Yes (build time) |
| NEXT_PUBLIC_VRAM_BUDGET_MB | VRAM hard cap in MB (default: 2048) | No |
| NEXT_PUBLIC_MAX_CACHE_FBOS | Max cache pool size (default: 24) | No |
| NEXT_PUBLIC_ENABLE_TELEMETRY | Enable performance telemetry (default: true) | No |

### Preview Deployments

Every PR gets a preview deployment. Use these for:

- [ ] Visual regression testing: compare canvas output between preview and production
- [ ] Shader testing: new materials/primitives tested in isolation
- [ ] Performance comparison: Lighthouse scores between preview and production
- [ ] Bundle size comparison: `next build` output shows chunk sizes

### Production Deployment Checklist

Run before every production deployment:

1. [ ] All pre-launch gate items pass (see above)
2. [ ] Bundle size compared to previous deploy (flag >5% increase)
3. [ ] Preview deployment tested manually (canvas renders, nodes work)
4. [ ] Sentry release created with source maps uploaded
5. [ ] Database migrations applied (if any)
6. [ ] Feature flags set correctly for production
7. [ ] Rollback plan documented (previous deployment URL saved)

---

## Incident Response Playbook

### Scenario: Mass Context Loss Reports

1. Check Sentry for `webglcontextlost` error spike
2. Check affected GPU vendors via `WEBGL_debug_renderer_info` breadcrumbs
3. If single vendor: likely driver update, add to known issues
4. If all vendors: check VRAM budget, reduce maxCacheTargets
5. If mobile only: reduce FBO resolution for mobile tier

### Scenario: FPS Degradation After Deploy

1. Compare bundle sizes: check for accidental eager import regression
2. Check shader compilation times: new material may be expensive
3. Check hash cache hit rate: topology change handling may have regressed
4. Check FBO pool utilization: eviction rate spike indicates pool thrashing
5. Rollback if FPS p95 < 20 in production

### Scenario: White Screen on Load

1. Check Sentry for JavaScript errors (not WebGL)
2. Check bundle loading: network tab for failed chunk loads
3. Check WebGL context creation: `canvas.getContext("webgl2")` may fail
4. Check for SSR hydration mismatch (Three.js/R3F must be client-only)
5. Verify framework-level dynamic import with SSR disabled for canvas components

### Scenario: Memory Leak Over Time

1. Check `renderer.info.memory.textures`: should not grow in idle scenes
2. Check FBO orphan count: deleted nodes should not leave FBOs
3. Check undo history size: each undo state should not store FBO copies
4. Check event listener count: HMR may accumulate listeners
5. Profile with Chrome Memory tab: take heap snapshots at t=0, t=5min, t=30min

---

## Verification Commands

Quick commands to verify production readiness:

```bash
# Set these to your project's source dirs
RENDER_DIR=<render-loop-dir>   # e.g. the FBO-compositor / render-loop module
SRC_DIR=<source-dir>           # e.g. the WebGL/renderer source root

# Check for console.log in hot paths
grep -rn "console.log" "$RENDER_DIR" --include="*.ts" --include="*.tsx" | grep -v "error\|warn\|catch"

# Check bundle size (after build) — adjust to your bundler/build command
npm run build 2>&1 | grep -E "^(Route|\+|Size)"

# Check for setState in useFrame
grep -rn "setState\|set(" "$RENDER_DIR" --include="*.tsx" | grep -B5 "useFrame"

# Check Three.js tree-shaking (should import from three/src/)
grep -rn "from .three." "$SRC_DIR" --include="*.ts" --include="*.tsx" | grep -v "three/src" | head -20

# Check for missing dispose() calls
grep -rn "new THREE" "$SRC_DIR" --include="*.ts" --include="*.tsx" | grep -v "test\|spec"

# Verify error boundaries exist around canvas
grep -rn "ErrorBoundary\|error-boundary" "$SRC_DIR" --include="*.tsx" | head -10

# Check dynamic imports for node/material definitions
grep -rn "import.*node-defs" "$SRC_DIR" --include="*.ts" --include="*.tsx" | head -20
```

---

## Sign-Off

Before production deployment, the following roles must sign off:

| Role | Responsibility | Sign-Off Criteria |
|------|---------------|-------------------|
| Engineering Lead | Code quality, test coverage | All pre-launch gate items pass |
| GPU Engineer | WebGL stability, VRAM budget | Stress test passes, context loss recovery verified |
| Product Owner | Feature completeness, UX | Manual testing on preview deployment |
| SRE/DevOps | Monitoring, alerting, rollback | Sentry configured, alerts set, rollback tested |
