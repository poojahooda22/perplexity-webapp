# Emergency Triage Playbook: Production Engineering

> 11pm production emergency? Follow these checklists top-to-bottom. Each step takes < 10 seconds.
> Stop at the first step that reveals the problem. Fix it. Ship it. Sleep.

---

## Production Down Triage

**Goal:** The app is broken in production. Find where and why.

### Step 1: Deployment Health
```bash
# Is the Vercel deployment healthy?
# Check: vercel dashboard or vercel CLI
# If deployment failed -> rollback to previous deployment immediately
# If deployment succeeded but app is broken -> client-side issue
```

### Step 2: Client vs Server
```
// Check Sentry (or your error tracker):
// - Server errors (500s) -> API/SSR issue
// - Client errors (TypeError, ReferenceError) -> JS bundle issue
// - No errors at all -> rendering issue (WebGL silent failure)
// If no error tracker: check browser console on the production URL
```

### Step 3: WebGL Isolation
```
// Does the non-WebGL part of the app work?
// - Can you navigate to pages without the canvas?
// - Does the editor UI load (panels, menus)?
// YES -> WebGL/compositor specific. Jump to the Three.js resource-management triage.
// NO -> general app failure. Check build output, missing env vars.
```

### Step 4: GPU Vendor Check
```
// Check Sentry tags or user reports for GPU info:
// - Intel integrated -> known lower performance, may hit limits
// - NVIDIA/AMD discrete -> should work, check driver version
// - Apple Silicon -> WebGL2 via ANGLE, some extensions missing
// If only one vendor is affected -> GPU-specific shader bug
```

### Step 5: Browser Isolation
```
// Test on Chrome, Firefox, Safari:
// - Chrome only -> likely a V8/Blink specific issue
// - Firefox only -> ANGLE vs native GL difference
// - Safari only -> WebGL2 support gaps, check for missing extensions
// - All browsers -> fundamental rendering or app logic bug
```

---

## Memory Leak in Production

**Goal:** Users report the app gets slow over time. Find the leak.

### Step 1: Texture Count Over Time
```js
// Log renderer.info.textures every 10 seconds:
setInterval(() => console.log('textures:', renderer.info.textures), 10000);
// Should plateau after initial load
// If growing linearly -> texture leak (materials not disposed)
// If growing in steps -> leak triggered by specific user action
```

### Step 2: JS Heap Timeline
```
// Chrome DevTools -> Performance tab -> Record 60 seconds of usage
// Look at the memory timeline (JS Heap):
// - Sawtooth pattern (up then GC drops) = normal
// - Staircase pattern (up, GC, but baseline increases) = JS leak
// Take heap snapshots before/after to diff retained objects
```

### Step 3: GPU Process Memory
```
// Navigate to chrome://gpu in a new tab
// Check "GPU Memory" section
// Compare before and after 5 minutes of app usage
// If GPU memory grows unbounded -> VRAM leak (FBO or texture)
// Cross-reference with your FBO pool manager's stats
```

### Step 4: Material Disposal
```js
// COMMON LEAK: When a node is removed from the graph:
// - Its Three.js material must be .dispose()'d
// - Its textures must be .dispose()'d
// - Its render targets must be .dispose()'d
// Check: is the node removal handler calling dispose on all GPU resources?
// Check: are materials created inside useFrame? (creates new material EVERY frame)
```

### Step 5: Event Listener Cleanup
```js
// COMMON LEAK: useEffect without cleanup
// useEffect(() => {
//   window.addEventListener('resize', handler);
//   return () => window.removeEventListener('resize', handler); // <-- THIS
// }, []);
// Check: every useEffect that adds listeners MUST return a cleanup function
// Check: every subscription (store, event emitter) MUST unsubscribe on unmount
```

---

## User Reports "It Is Slow"

**Goal:** Diagnose performance for a specific user without access to their machine.

### Step 1: Device Classification
```
// Ask or check analytics:
// - Integrated GPU (Intel UHD, Intel Iris) -> 50% of discrete GPU perf
// - Entry discrete (GTX 1650, RX 6500) -> baseline expectation
// - High-end discrete (RTX 3070+, RX 6800+) -> should be fast
// - Apple M1/M2 -> good but WebGL via ANGLE has overhead
// Integrated GPU users: set expectations, reduce default quality
```

### Step 2: Node Count Check
```
// How many nodes in their project?
// Integrated GPU budget:
//   < 20 nodes at 1080p -> should be fine
//   20-50 nodes -> borderline, may need optimization
//   > 50 nodes -> expected to be slow on integrated
// Discrete GPU budget:
//   < 50 nodes -> should be fine
//   50-100 nodes -> may need hash cache tuning
//   > 100 nodes -> architectural limit, need LOD or culling
```

### Step 3: Video Node Check
```
// Any video source nodes in the project?
// Video decode happens on CPU, then uploads to GPU texture every frame
// This is DOUBLE the work: CPU decode + GPU upload + GPU render
// Multiple video nodes multiply this cost
// Fix: reduce video resolution, or use MediaRecorder for offline render
```

### Step 4: Resolution Reduction
```js
// Quick win: reduce canvas DPR (device pixel ratio)
// Default is window.devicePixelRatio (often 2x on Retina)
// Setting dpr={1} cuts pixel count by 75% on 2x displays
// Setting dpr={0.5} cuts by 93% (looks blurry but tests if GPU-bound)
// If FPS doubles with lower DPR -> GPU fill-rate bound
```

### Step 5: Cache Aggressiveness
```
// Increase hash cache TTL to reduce re-renders:
// - Default TTL: N frames of unchanged hash before promoting to STATIC
// - Increase to 2x or 3x default
// - Trade-off: slightly stale visuals during rapid editing
// - For "viewing" mode (not editing): set TTL very high
// This is the single biggest perf lever for large node graphs
```

---

## Quick Reference: Production Red Flags

| Signal | Meaning | Action |
|--------|---------|--------|
| 500 errors in Sentry | Server-side crash | Check API routes, env vars |
| White screen, no errors | JS bundle failed to load | Check CDN, CSP headers |
| Black canvas only | WebGL init failed | Check GPU blocklist, context limits |
| Slow after 10 min | Memory leak | Profile textures + heap over time |
| Slow on Intel GPU | Expected perf gap | Reduce DPR, limit node count |
| One browser only | Browser-specific bug | Check WebGL extensions, ANGLE |

---

*Last updated: 2026-03-26. If this playbook saved your night, add the fix to the relevant skill reference.*
