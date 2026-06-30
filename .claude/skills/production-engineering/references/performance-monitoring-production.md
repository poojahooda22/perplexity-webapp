# Performance Monitoring for WebGL Applications in Production

> Real User Monitoring, Core Web Vitals, FPS tracking, GPU segmentation, alerting, and dashboard patterns for Three.js/R3F applications deployed on Vercel.

## Table of Contents

1. [FPS Monitoring with requestAnimationFrame](#fps-monitoring-with-requestanimationframe)
2. [Core Web Vitals Impact](#core-web-vitals-impact)
3. [FPS Percentile Tracking](#fps-percentile-tracking)
4. [GPU/Browser/OS Segmentation](#gpubrowseros-segmentation)
5. [Vercel Speed Insights Integration](#vercel-speed-insights-integration)
6. [Custom Performance Events](#custom-performance-events)
7. [Alerting Thresholds](#alerting-thresholds)
8. [Dashboard Design](#dashboard-design)
9. [Long Task Detection](#long-task-detection)
10. [Render Pipeline Profiling](#render-pipeline-profiling)

---

## FPS Monitoring with requestAnimationFrame

### Accurate FPS Measurement

Do NOT use `Date.now()` for FPS measurement. Use `performance.now()` which is
monotonic and high-resolution. Also do not simply count frames per second --
use a rolling window for stable readings.

```typescript
// lib/perf/fpsMonitor.ts

export interface FPSSnapshot {
  fps: number;           // Frames per second (smoothed)
  frameTime: number;     // Average frame time in ms
  frameTimeP95: number;  // 95th percentile frame time
  frameTimeP99: number;  // 99th percentile frame time
  jank: number;          // Number of frames >33ms in the window
  timestamp: number;
}

export class FPSMonitor {
  private frameTimes: number[] = [];
  private lastTime: number = 0;
  private readonly windowSize: number;
  private readonly onSnapshot: (snapshot: FPSSnapshot) => void;
  private readonly snapshotIntervalMs: number;
  private lastSnapshotTime: number = 0;
  private rafId: number = 0;
  private running: boolean = false;

  constructor(options: {
    windowSize?: number;         // Number of frames to average over
    snapshotIntervalMs?: number; // How often to emit snapshots
    onSnapshot: (snapshot: FPSSnapshot) => void;
  }) {
    this.windowSize = options.windowSize ?? 120; // ~2 seconds at 60fps
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 2000;
    this.onSnapshot = options.onSnapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.lastSnapshotTime = this.lastTime;
    this.tick(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;

    const delta = now - this.lastTime;
    this.lastTime = now;

    // Skip the first frame (delta is meaningless)
    if (delta > 0 && delta < 1000) {
      this.frameTimes.push(delta);

      // Keep only the latest window
      if (this.frameTimes.length > this.windowSize) {
        this.frameTimes.shift();
      }
    }

    // Emit snapshot at interval
    if (now - this.lastSnapshotTime >= this.snapshotIntervalMs) {
      this.lastSnapshotTime = now;
      if (this.frameTimes.length > 10) {
        this.onSnapshot(this.computeSnapshot());
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  private computeSnapshot(): FPSSnapshot {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avgFrameTime = sum / count;

    const p95Index = Math.floor(count * 0.95);
    const p99Index = Math.floor(count * 0.99);

    const jankThreshold = 33.33; // Below 30fps
    const jankCount = sorted.filter((t) => t > jankThreshold).length;

    return {
      fps: Math.round(1000 / avgFrameTime),
      frameTime: Math.round(avgFrameTime * 100) / 100,
      frameTimeP95: Math.round(sorted[p95Index] * 100) / 100,
      frameTimeP99: Math.round(sorted[p99Index] * 100) / 100,
      jank: jankCount,
      timestamp: Date.now(),
    };
  }

  /**
   * Get current FPS without waiting for the next snapshot interval.
   */
  getCurrentFPS(): number {
    if (this.frameTimes.length < 5) return 0;
    const recent = this.frameTimes.slice(-30);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return Math.round(1000 / avg);
  }
}
```

### React Hook for FPS Monitoring

```tsx
// lib/perf/useFPSMonitor.ts

import { useEffect, useRef, useState } from 'react';
import { FPSMonitor, FPSSnapshot } from './fpsMonitor';

export function useFPSMonitor(enabled: boolean = true): FPSSnapshot | null {
  const [snapshot, setSnapshot] = useState<FPSSnapshot | null>(null);
  const monitorRef = useRef<FPSMonitor | null>(null);

  useEffect(() => {
    if (!enabled) {
      monitorRef.current?.stop();
      monitorRef.current = null;
      return;
    }

    const monitor = new FPSMonitor({
      windowSize: 120,
      snapshotIntervalMs: 2000,
      onSnapshot: setSnapshot,
    });

    monitorRef.current = monitor;
    monitor.start();

    return () => {
      monitor.stop();
    };
  }, [enabled]);

  return snapshot;
}
```

### R3F Frame Timing via useFrame

```tsx
// lib/perf/useFrameTiming.ts

import { useFrame } from '@react-three/fiber';
import { useRef, useCallback } from 'react';

interface FrameTimingStats {
  jsTime: number;    // Time spent in JS (useFrame callbacks)
  gpuTime: number;   // Estimated GPU time (total frame - JS)
  totalTime: number; // Total frame time
}

/**
 * Measure time spent in the render pipeline per frame.
 * Attach this to the highest-priority useFrame to capture full JS overhead.
 */
export function useFrameTiming(
  onStats?: (stats: FrameTimingStats) => void
): void {
  const lastFrameEnd = useRef(0);
  const jsTimes = useRef<number[]>([]);

  // First priority: capture start of JS execution
  useFrame(() => {
    const now = performance.now();
    if (lastFrameEnd.current > 0) {
      const totalFrame = now - lastFrameEnd.current;
      const jsTime = jsTimes.current.reduce((a, b) => a + b, 0);
      const gpuTime = Math.max(0, totalFrame - jsTime);

      onStats?.({ jsTime, gpuTime, totalTime: totalFrame });
    }
    jsTimes.current = [];
    lastFrameEnd.current = now;
  }, -Infinity); // Highest priority (runs first)

  // Lowest priority: capture end of JS execution
  useFrame(() => {
    const now = performance.now();
    const elapsed = now - lastFrameEnd.current;
    jsTimes.current.push(elapsed);
  }, Infinity); // Lowest priority (runs last)
}
```

---

## Core Web Vitals Impact

### How WebGL Affects Core Web Vitals

WebGL applications have unique challenges with Core Web Vitals:

```
Metric   WebGL Impact                              Typical Issue
---      ---                                       ---
LCP      Canvas is often the LCP element.          Large bundle delays first paint.
         Canvas starts black, then renders.         LCP fires late (after shaders compile).

CLS      Canvas resize causes layout shift.         DPR changes on external monitor.
         Property panel resize shifts canvas.       Responsive layout changes.

INP      Heavy useFrame blocks main thread.         Slider drag during render causes jank.
         Shader compilation freezes input.          First interaction compiles shaders.
         GC pauses from texture churn.              Frequent texture allocation.

FID      Initial shader compilation blocks input.   First click unresponsive.
         (Deprecated in favor of INP)
```

### Measuring LCP for Canvas

```typescript
// lib/perf/webVitals.ts

/**
 * Canvas elements count as LCP candidates.
 * The LCP time is when the canvas first paints non-transparent content.
 * We can improve LCP by:
 * 1. Showing a placeholder image (instantly painted) that the canvas replaces
 * 2. Lazy-loading heavy effects after first meaningful paint
 * 3. Precompiling shaders during loading screen
 */
export function observeLCP(
  callback: (lcpMs: number, element: string) => void
): void {
  if (!('PerformanceObserver' in window)) return;

  const observer = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1] as any;
    if (lastEntry) {
      callback(
        lastEntry.startTime,
        lastEntry.element?.tagName || 'unknown'
      );
    }
  });

  observer.observe({ type: 'largest-contentful-paint', buffered: true });
}

/**
 * Measure CLS specifically around canvas resize events.
 */
export function observeCLS(
  callback: (clsScore: number) => void
): void {
  if (!('PerformanceObserver' in window)) return;

  let clsScore = 0;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as any[]) {
      if (!entry.hadRecentInput) {
        clsScore += entry.value;
      }
    }
    callback(clsScore);
  });

  observer.observe({ type: 'layout-shift', buffered: true });
}

/**
 * Measure INP (Interaction to Next Paint).
 * Critical for WebGL apps where main thread is busy with render loop.
 */
export function observeINP(
  callback: (inpMs: number, interactionType: string) => void
): void {
  if (!('PerformanceObserver' in window)) return;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as any[]) {
      // INP considers the worst interaction
      callback(entry.duration, entry.name);
    }
  });

  try {
    observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {
    // event type not supported in all browsers
  }
}
```

### Improving INP for WebGL Apps

```typescript
// lib/perf/mainThreadYielding.ts

/**
 * Yield to the main thread between expensive operations.
 * Prevents long tasks that block input processing.
 *
 * Use this in data processing, not in the render loop.
 * The render loop should be fast enough to not need yielding.
 */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    // scheduler.yield() is the modern API (Chrome 129+)
    if ('scheduler' in globalThis && 'yield' in (globalThis as any).scheduler) {
      (globalThis as any).scheduler.yield().then(resolve);
    } else {
      // Fallback: setTimeout(0) yields to the event loop
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Process an array in chunks, yielding between chunks.
 * Use for operations like parsing shader source, loading primitives, etc.
 */
export async function processInChunks<T, R>(
  items: T[],
  process: (item: T) => R,
  chunkSize: number = 10
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    for (const item of chunk) {
      results.push(process(item));
    }

    if (i + chunkSize < items.length) {
      await yieldToMain();
    }
  }

  return results;
}
```

---

## FPS Percentile Tracking

### Why Percentiles Matter More Than Average FPS

Average FPS hides jank. A session with 59fps average could be:
- Scenario A: Steady 59fps (great experience)
- Scenario B: 60fps with occasional drops to 15fps (terrible jank)

Both have the same average. Percentiles reveal the difference.

```
Metric         What It Tells You
---            ---
P50 FPS        Typical experience for most users
P95 FPS        Experience during heavy moments (scrolling, resizing)
P99 FPS        Worst jank spikes (shader compilation, GC pauses)
P99.9 FPS      Catastrophic hitches (context loss, memory pressure)
```

### Percentile Tracker

```typescript
// lib/perf/percentileTracker.ts

/**
 * Reservoir sampling for maintaining approximate percentiles
 * over a large number of observations without unbounded memory.
 */
export class PercentileTracker {
  private readonly reservoir: number[];
  private readonly maxSize: number;
  private count: number = 0;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
    this.reservoir = [];
  }

  add(value: number): void {
    this.count += 1;

    if (this.reservoir.length < this.maxSize) {
      this.reservoir.push(value);
    } else {
      // Reservoir sampling: replace random element with decreasing probability
      const j = Math.floor(Math.random() * this.count);
      if (j < this.maxSize) {
        this.reservoir[j] = value;
      }
    }
  }

  percentile(p: number): number {
    if (this.reservoir.length === 0) return 0;

    const sorted = [...this.reservoir].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  median(): number {
    return this.percentile(50);
  }

  p95(): number {
    return this.percentile(95);
  }

  p99(): number {
    return this.percentile(99);
  }

  getStats(): {
    count: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
    mean: number;
  } {
    if (this.reservoir.length === 0) {
      return { count: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, mean: 0 };
    }

    const sorted = [...this.reservoir].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count: this.count,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      mean: sum / sorted.length,
    };
  }

  reset(): void {
    this.reservoir.length = 0;
    this.count = 0;
  }
}
```

### Session-Level FPS Tracking

```typescript
// lib/perf/sessionFPSTracker.ts

import { PercentileTracker } from './percentileTracker';

interface SessionFPSReport {
  sessionId: string;
  durationMs: number;
  fpsP50: number;
  fpsP95: number;
  fpsP99: number;
  frameTimeP50: number;
  frameTimeP95: number;
  frameTimeP99: number;
  jankFrames: number;       // Frames > 33ms
  severeJankFrames: number; // Frames > 100ms
  totalFrames: number;
  gpu: string;
  browser: string;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  layerCount: number;
}

export class SessionFPSTracker {
  private readonly sessionId: string;
  private readonly startTime: number;
  private readonly fpsTracker: PercentileTracker;
  private readonly frameTimeTracker: PercentileTracker;
  private jankFrames: number = 0;
  private severeJankFrames: number = 0;
  private totalFrames: number = 0;
  private lastFrameTime: number = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startTime = Date.now();
    this.fpsTracker = new PercentileTracker(5000);
    this.frameTimeTracker = new PercentileTracker(5000);
  }

  recordFrame(now: number): void {
    if (this.lastFrameTime > 0) {
      const dt = now - this.lastFrameTime;
      if (dt > 0 && dt < 1000) {
        const fps = 1000 / dt;
        this.fpsTracker.add(fps);
        this.frameTimeTracker.add(dt);
        this.totalFrames += 1;

        if (dt > 33.33) this.jankFrames += 1;
        if (dt > 100) this.severeJankFrames += 1;
      }
    }
    this.lastFrameTime = now;
  }

  getReport(gpu: string, layerCount: number): SessionFPSReport {
    return {
      sessionId: this.sessionId,
      durationMs: Date.now() - this.startTime,
      fpsP50: Math.round(this.fpsTracker.percentile(50)),
      fpsP95: Math.round(this.fpsTracker.percentile(95)),
      fpsP99: Math.round(this.fpsTracker.percentile(99)),
      frameTimeP50: Math.round(this.frameTimeTracker.percentile(50) * 10) / 10,
      frameTimeP95: Math.round(this.frameTimeTracker.percentile(95) * 10) / 10,
      frameTimeP99: Math.round(this.frameTimeTracker.percentile(99) * 10) / 10,
      jankFrames: this.jankFrames,
      severeJankFrames: this.severeJankFrames,
      totalFrames: this.totalFrames,
      gpu,
      browser: navigator.userAgent,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      layerCount,
    };
  }
}
```

---

## GPU/Browser/OS Segmentation

### Collecting GPU Information

```typescript
// lib/perf/gpuInfo.ts

export interface GPUProfile {
  renderer: string;        // e.g., "ANGLE (NVIDIA GeForce RTX 3080)"
  vendor: string;          // e.g., "Google Inc. (NVIDIA)"
  tier: 'low' | 'mid' | 'high' | 'unknown';
  isSoftwareRenderer: boolean;
  isIntegratedGPU: boolean;
  isMobile: boolean;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: [number, number];
  maxDrawBuffers: number;
  webglVersion: 1 | 2;
}

export function getGPUProfile(): GPUProfile {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

  if (!gl) {
    return {
      renderer: 'no-webgl',
      vendor: 'no-webgl',
      tier: 'unknown',
      isSoftwareRenderer: true,
      isIntegratedGPU: false,
      isMobile: /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent),
      maxTextureSize: 0,
      maxRenderbufferSize: 0,
      maxViewportDims: [0, 0],
      maxDrawBuffers: 0,
      webglVersion: 1,
    };
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const vendor = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR);

  const isWebGL2 = gl instanceof WebGL2RenderingContext;

  const profile: GPUProfile = {
    renderer,
    vendor,
    tier: classifyGPUTier(renderer),
    isSoftwareRenderer: isSoftware(renderer),
    isIntegratedGPU: isIntegrated(renderer),
    isMobile: /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxViewportDims: gl.getParameter(gl.MAX_VIEWPORT_DIMS) as [number, number],
    maxDrawBuffers: isWebGL2
      ? gl.getParameter((gl as WebGL2RenderingContext).MAX_DRAW_BUFFERS)
      : 1,
    webglVersion: isWebGL2 ? 2 : 1,
  };

  // Clean up the probe context
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();

  return profile;
}

function classifyGPUTier(renderer: string): 'low' | 'mid' | 'high' | 'unknown' {
  const r = renderer.toLowerCase();

  // Software renderers
  if (r.includes('swiftshader') || r.includes('llvmpipe') || r.includes('software')) {
    return 'low';
  }

  // High-end desktop GPUs
  if (
    /rtx\s*[3-5]\d{3}/i.test(r) ||        // RTX 3000/4000/5000 series
    /rx\s*(6[89]|7[0-9])\d{2}/i.test(r) || // RX 6800+, 7000 series
    /apple\s*m[2-9]/i.test(r) ||            // Apple M2+
    /a\d{2,}\s*pro/i.test(r)                // Apple A-series Pro
  ) {
    return 'high';
  }

  // Mid-range
  if (
    /rtx\s*[2]\d{3}/i.test(r) ||        // RTX 2000 series
    /gtx\s*1[0-9]{3}/i.test(r) ||       // GTX 1000 series
    /rx\s*(5[5-9]|6[0-7])\d{2}/i.test(r) || // RX 5500-6700
    /apple\s*m1/i.test(r) ||              // Apple M1
    /intel.*iris.*plus/i.test(r) ||       // Intel Iris Plus
    /intel.*xe/i.test(r)                  // Intel Xe
  ) {
    return 'mid';
  }

  // Low-end integrated
  if (
    /intel.*hd\s*(4|5|6)\d{3}/i.test(r) || // Intel HD 4000-6000
    /intel.*uhd\s*(6[0-2])\d/i.test(r) ||   // Intel UHD 620 etc.
    /mali/i.test(r) ||                        // ARM Mali
    /adreno\s*[3-5]\d{2}/i.test(r) ||       // Qualcomm Adreno 300-500
    /powervr/i.test(r)                        // PowerVR
  ) {
    return 'low';
  }

  return 'unknown';
}

function isSoftware(renderer: string): boolean {
  const r = renderer.toLowerCase();
  return (
    r.includes('swiftshader') ||
    r.includes('llvmpipe') ||
    r.includes('software') ||
    r.includes('mesa') && r.includes('llvm')
  );
}

function isIntegrated(renderer: string): boolean {
  const r = renderer.toLowerCase();
  return (
    r.includes('intel') ||
    r.includes('mali') ||
    r.includes('adreno') ||
    r.includes('powervr') ||
    r.includes('apple gpu') // Apple integrated
  );
}
```

### Browser/OS Detection for Segmentation

```typescript
// lib/perf/environmentInfo.ts

export interface EnvironmentInfo {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  isMobile: boolean;
  screenResolution: string;
  dpr: number;
  memoryGB: number | null;    // navigator.deviceMemory
  hardwareConcurrency: number; // CPU cores
  connectionType: string | null;
}

export function getEnvironmentInfo(): EnvironmentInfo {
  const ua = navigator.userAgent;

  return {
    browser: detectBrowser(ua),
    browserVersion: detectBrowserVersion(ua),
    os: detectOS(ua),
    osVersion: detectOSVersion(ua),
    isMobile: /Mobile|Android|iPhone|iPad/i.test(ua),
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    dpr: window.devicePixelRatio || 1,
    memoryGB: (navigator as any).deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    connectionType: (navigator as any).connection?.effectiveType ?? null,
  };
}

function detectBrowser(ua: string): string {
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  return 'Other';
}

function detectBrowserVersion(ua: string): string {
  const match = ua.match(/(Chrome|Firefox|Edg|Safari|Version)\/(\d+[\d.]*)/);
  return match ? match[2] : 'unknown';
}

function detectOS(ua: string): string {
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac OS')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Other';
}

function detectOSVersion(ua: string): string {
  const patterns: Record<string, RegExp> = {
    Windows: /Windows NT (\d+\.\d+)/,
    macOS: /Mac OS X (\d+[._]\d+[._]?\d*)/,
    Android: /Android (\d+[\d.]*)/,
    iOS: /OS (\d+[_]\d+)/,
  };

  for (const [, pattern] of Object.entries(patterns)) {
    const match = ua.match(pattern);
    if (match) return match[1].replace(/_/g, '.');
  }
  return 'unknown';
}
```

---

## Vercel Speed Insights Integration

### Setup

```bash
npm install @vercel/speed-insights
```

### Integration with Next.js

```tsx
// app/layout.tsx

import { SpeedInsights } from '@vercel/speed-insights/next';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
```

### Custom Web Vitals Reporting

```tsx
// app/layout.tsx or a client component

'use client';

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    // Vercel Speed Insights captures these automatically.
    // Use this hook for custom processing.

    switch (metric.name) {
      case 'LCP':
        if (metric.value > 2500) {
          console.warn(`[WebVitals] LCP is slow: ${metric.value}ms`);
          // Check if the LCP element is the canvas
          // If so, consider showing a placeholder image
        }
        break;
      case 'INP':
        if (metric.value > 200) {
          console.warn(`[WebVitals] INP is slow: ${metric.value}ms`);
          // Likely caused by heavy useFrame blocking main thread
        }
        break;
      case 'CLS':
        if (metric.value > 0.1) {
          console.warn(`[WebVitals] CLS is high: ${metric.value}`);
          // Check for canvas resize without CSS containment
        }
        break;
    }

    // Send to custom analytics
    sendToAnalytics({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      navigationType: metric.navigationType,
    });
  });

  return null;
}

function sendToAnalytics(data: Record<string, any>): void {
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon('/api/vitals', JSON.stringify(data));
  }
}
```

### Custom Metrics for WebGL

Vercel Speed Insights only captures standard Web Vitals. For WebGL-specific
metrics, use custom performance marks and measures:

```typescript
// lib/perf/customMarks.ts

/**
 * Mark key moments in the WebGL lifecycle for performance tracing.
 */
export const PerfMarks = {
  // Canvas initialization
  canvasMount: () => performance.mark('webgl:canvas-mount'),
  contextCreated: () => performance.mark('webgl:context-created'),
  shadersCompiled: () => performance.mark('webgl:shaders-compiled'),
  firstRender: () => performance.mark('webgl:first-render'),

  // Effect loading
  effectLoadStart: (name: string) => performance.mark(`webgl:effect-load-start:${name}`),
  effectLoadEnd: (name: string) => {
    performance.mark(`webgl:effect-load-end:${name}`);
    performance.measure(
      `webgl:effect-load:${name}`,
      `webgl:effect-load-start:${name}`,
      `webgl:effect-load-end:${name}`
    );
  },

  // Time to interactive canvas
  measureTimeToFirstRender: () => {
    try {
      performance.measure(
        'webgl:time-to-first-render',
        'webgl:canvas-mount',
        'webgl:first-render'
      );
      const measure = performance.getEntriesByName('webgl:time-to-first-render')[0];
      return measure?.duration ?? null;
    } catch {
      return null;
    }
  },
};
```

---

## Custom Performance Events

### Event Taxonomy for WebGL Apps

```typescript
// lib/perf/performanceEvents.ts

type PerfEventCategory =
  | 'render'        // Frame rendering events
  | 'shader'        // Shader compilation/errors
  | 'texture'       // Texture upload/disposal
  | 'fbo'           // Framebuffer operations
  | 'interaction'   // User interactions affecting GPU
  | 'lifecycle'     // Context loss, restoration, mount, unmount
  | 'memory';       // Memory-related events

interface PerfEvent {
  category: PerfEventCategory;
  action: string;
  label?: string;
  value?: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

class PerformanceEventBus {
  private readonly listeners: Set<(event: PerfEvent) => void> = new Set();
  private readonly buffer: PerfEvent[] = [];
  private readonly maxBufferSize: number;

  constructor(maxBufferSize: number = 1000) {
    this.maxBufferSize = maxBufferSize;
  }

  emit(event: Omit<PerfEvent, 'timestamp'>): void {
    const fullEvent: PerfEvent = {
      ...event,
      timestamp: Date.now(),
    };

    // Buffer for batch sending
    this.buffer.push(fullEvent);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Notify listeners
    for (const listener of this.listeners) {
      listener(fullEvent);
    }
  }

  subscribe(listener: (event: PerfEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): PerfEvent[] {
    const events = [...this.buffer];
    this.buffer.length = 0;
    return events;
  }
}

export const perfEvents = new PerformanceEventBus();

// Usage examples:
//
// perfEvents.emit({
//   category: 'shader',
//   action: 'compile',
//   label: 'BloomMaterial',
//   value: 12, // ms to compile
// });
//
// perfEvents.emit({
//   category: 'texture',
//   action: 'upload',
//   label: 'noise-512x512',
//   value: 1048576, // bytes
// });
//
// perfEvents.emit({
//   category: 'lifecycle',
//   action: 'context-lost',
//   metadata: { layerCount: 5, textureCount: 12 },
// });
```

---

## Alerting Thresholds

### Production Alert Definitions

```typescript
// lib/perf/alerts.ts

interface AlertRule {
  name: string;
  metric: string;
  condition: 'above' | 'below';
  threshold: number;
  windowMinutes: number;
  severity: 'info' | 'warning' | 'critical';
  description: string;
}

export const ALERT_RULES: AlertRule[] = [
  // FPS alerts
  {
    name: 'fps-p50-low',
    metric: 'fps.p50',
    condition: 'below',
    threshold: 30,
    windowMinutes: 5,
    severity: 'critical',
    description: 'Median FPS below 30 for 5+ minutes across sessions',
  },
  {
    name: 'fps-p95-low',
    metric: 'fps.p95',
    condition: 'below',
    threshold: 20,
    windowMinutes: 5,
    severity: 'warning',
    description: 'P95 FPS below 20 (jank during heavy operations)',
  },
  {
    name: 'fps-p99-critical',
    metric: 'fps.p99',
    condition: 'below',
    threshold: 10,
    windowMinutes: 1,
    severity: 'critical',
    description: 'P99 FPS below 10 (severe hitches)',
  },

  // Web Vitals alerts
  {
    name: 'lcp-slow',
    metric: 'lcp.p75',
    condition: 'above',
    threshold: 4000,
    windowMinutes: 15,
    severity: 'warning',
    description: 'P75 LCP above 4s (poor rating)',
  },
  {
    name: 'inp-slow',
    metric: 'inp.p75',
    condition: 'above',
    threshold: 500,
    windowMinutes: 15,
    severity: 'warning',
    description: 'P75 INP above 500ms (poor rating)',
  },
  {
    name: 'cls-high',
    metric: 'cls.p75',
    condition: 'above',
    threshold: 0.25,
    windowMinutes: 15,
    severity: 'warning',
    description: 'P75 CLS above 0.25 (poor rating)',
  },

  // Memory alerts
  {
    name: 'texture-leak',
    metric: 'memory.textures.delta',
    condition: 'above',
    threshold: 20,
    windowMinutes: 10,
    severity: 'critical',
    description: 'Texture count growing by 20+ over 10 minutes (leak)',
  },
  {
    name: 'high-texture-count',
    metric: 'memory.textures.count',
    condition: 'above',
    threshold: 100,
    windowMinutes: 1,
    severity: 'warning',
    description: 'More than 100 active textures',
  },

  // Context loss alerts
  {
    name: 'context-loss-spike',
    metric: 'context.losses.per1000sessions',
    condition: 'above',
    threshold: 10,
    windowMinutes: 60,
    severity: 'critical',
    description: 'Context loss rate spiking above 1% of sessions',
  },

  // Error rate alerts
  {
    name: 'shader-error-rate',
    metric: 'errors.shader.per1000sessions',
    condition: 'above',
    threshold: 5,
    windowMinutes: 60,
    severity: 'critical',
    description: 'Shader errors affecting >0.5% of sessions',
  },
];
```

---

## Dashboard Design

### Key Panels for WebGL Performance Dashboard

```
Dashboard: "WebGL Application Health"

Row 1: Real-Time Overview
  [FPS Gauge: P50]     [FPS Gauge: P95]    [Active Sessions]    [Error Rate]
  Target: 60fps        Target: 45fps       (count)              Target: <0.1%

Row 2: Core Web Vitals (from Vercel Speed Insights)
  [LCP Distribution]   [INP Distribution]  [CLS Distribution]
  Good/NI/Poor pie     Good/NI/Poor pie    Good/NI/Poor pie

Row 3: FPS Over Time
  [Line chart: FPS P50, P95, P99 over last 24 hours]
  Segmented by GPU tier (low/mid/high)

Row 4: GPU Breakdown
  [Bar chart: Session count by GPU renderer (top 10)]
  [Table: GPU → avg FPS, error rate, context loss rate]

Row 5: Error Tracking
  [Shader errors over time]
  [Context losses over time]
  [Top error messages table]

Row 6: Memory
  [Line chart: Avg texture count over time]
  [Line chart: Avg geometry count over time]
  [Leak detection alerts]
```

### Implementing a Simple In-App Performance HUD

```tsx
// lib/perf/PerformanceHUD.tsx

import React, { useEffect, useState } from 'react';
import { useFPSMonitor } from './useFPSMonitor';

interface PerformanceHUDProps {
  visible: boolean;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export function PerformanceHUD({
  visible,
  position = 'bottom-right',
}: PerformanceHUDProps) {
  const fps = useFPSMonitor(visible);
  const [memoryInfo, setMemoryInfo] = useState<{
    textures: number;
    geometries: number;
    programs: number;
  } | null>(null);

  if (!visible || !fps) return null;

  const fpsColor =
    fps.fps >= 55 ? '#4ade80' : fps.fps >= 30 ? '#fbbf24' : '#ef4444';

  const positionStyle: Record<string, string> = {
    'top-left': 'top: 8px; left: 8px;',
    'top-right': 'top: 8px; right: 8px;',
    'bottom-left': 'bottom: 8px; left: 8px;',
    'bottom-right': 'bottom: 8px; right: 8px;',
  };

  return (
    <div
      style={{
        position: 'fixed',
        ...parsePositionStyle(positionStyle[position]),
        zIndex: 99999,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: '#e0e0e0',
        fontFamily: 'monospace',
        fontSize: '11px',
        padding: '6px 10px',
        borderRadius: '4px',
        lineHeight: 1.5,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <div style={{ color: fpsColor, fontWeight: 'bold' }}>
        {fps.fps} FPS
      </div>
      <div>Frame: {fps.frameTime.toFixed(1)}ms</div>
      <div>P95: {fps.frameTimeP95.toFixed(1)}ms</div>
      <div>P99: {fps.frameTimeP99.toFixed(1)}ms</div>
      <div>Jank: {fps.jank}</div>
      {memoryInfo && (
        <>
          <div>Tex: {memoryInfo.textures}</div>
          <div>Geo: {memoryInfo.geometries}</div>
          <div>Prg: {memoryInfo.programs}</div>
        </>
      )}
    </div>
  );
}

function parsePositionStyle(css: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of css.split(';')) {
    const [key, value] = part.split(':').map((s) => s.trim());
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}
```

---

## Long Task Detection

### What Counts as a Long Task

A "long task" is any task that occupies the main thread for more than 50ms.
In WebGL apps, common causes:
- Shader compilation (can take 50-500ms per shader)
- Texture upload for large images (100ms+)
- JavaScript processing in useFrame (garbage collection, physics)
- Layout recalculation after resize

### Long Task Observer

```typescript
// lib/perf/longTaskObserver.ts

interface LongTask {
  duration: number;
  startTime: number;
  name: string;
  attribution: string[];
}

export function observeLongTasks(
  callback: (task: LongTask) => void,
  minDurationMs: number = 50
): () => void {
  if (!('PerformanceObserver' in window)) {
    return () => {};
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= minDurationMs) {
          const attribution = (entry as any).attribution?.map(
            (a: any) => a.containerType || a.containerName || 'unknown'
          ) || [];

          callback({
            duration: entry.duration,
            startTime: entry.startTime,
            name: entry.name,
            attribution,
          });
        }
      }
    });

    observer.observe({ type: 'longtask', buffered: true });

    return () => observer.disconnect();
  } catch {
    // longtask type not supported
    return () => {};
  }
}

/**
 * Track long tasks and correlate them with WebGL operations.
 */
export function createLongTaskCorrelator() {
  let currentOperation: string | null = null;
  const taskLog: Array<LongTask & { operation: string | null }> = [];

  const stopObserving = observeLongTasks((task) => {
    taskLog.push({ ...task, operation: currentOperation });

    if (task.duration > 200) {
      console.warn(
        `[LongTask] ${task.duration.toFixed(0)}ms during "${currentOperation || 'idle'}"`,
      );
    }
  });

  return {
    setOperation: (name: string | null) => {
      currentOperation = name;
    },
    getLog: () => [...taskLog],
    dispose: stopObserving,
  };
}
```

---

## Render Pipeline Profiling

### Profiling Individual Compositor Passes

```typescript
// lib/perf/passProfiler.ts

interface PassTiming {
  name: string;
  durationMs: number;
  drawCalls: number;
  triangles: number;
}

/**
 * Profile each compositor pass (bloom, blur, fog, etc.) separately.
 * Uses renderer.info to measure per-pass draw call overhead.
 *
 * Note: This measures JS/CPU time, not GPU time.
 * True GPU profiling requires EXT_disjoint_timer_query which is
 * limited in WebGL due to Spectre mitigations.
 */
export class PassProfiler {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly timings: Map<string, PassTiming[]> = new Map();
  private readonly maxHistory: number;

  constructor(renderer: THREE.WebGLRenderer, maxHistory: number = 60) {
    this.renderer = renderer;
    this.maxHistory = maxHistory;
  }

  beginPass(name: string): { end: () => void } {
    const info = this.renderer.info;
    const startCalls = info.render.calls;
    const startTriangles = info.render.triangles;
    const startTime = performance.now();

    return {
      end: () => {
        const duration = performance.now() - startTime;
        const drawCalls = info.render.calls - startCalls;
        const triangles = info.render.triangles - startTriangles;

        const timing: PassTiming = {
          name,
          durationMs: duration,
          drawCalls,
          triangles,
        };

        if (!this.timings.has(name)) {
          this.timings.set(name, []);
        }

        const history = this.timings.get(name)!;
        history.push(timing);
        if (history.length > this.maxHistory) {
          history.shift();
        }
      },
    };
  }

  getAverages(): Map<string, { avgMs: number; avgDrawCalls: number }> {
    const result = new Map<string, { avgMs: number; avgDrawCalls: number }>();

    for (const [name, timings] of this.timings) {
      if (timings.length === 0) continue;

      const avgMs =
        timings.reduce((s, t) => s + t.durationMs, 0) / timings.length;
      const avgDrawCalls =
        timings.reduce((s, t) => s + t.drawCalls, 0) / timings.length;

      result.set(name, {
        avgMs: Math.round(avgMs * 100) / 100,
        avgDrawCalls: Math.round(avgDrawCalls * 10) / 10,
      });
    }

    return result;
  }

  reset(): void {
    this.timings.clear();
  }
}
```

### GPU Timer Query (When Available)

```typescript
// lib/perf/gpuTimer.ts

/**
 * GPU timer queries provide actual GPU execution time.
 * However, they are heavily restricted in WebGL due to Spectre:
 * - Chrome: EXT_disjoint_timer_query_webgl2 may be available
 * - Firefox: Disabled by default
 * - Safari: Not available
 *
 * Use as an opt-in diagnostic tool, not for production monitoring.
 */
export class GPUTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: any; // EXT_disjoint_timer_query_webgl2
  private readonly queries: Map<string, WebGLQuery> = new Map();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get available(): boolean {
    return this.ext !== null;
  }

  begin(label: string): void {
    if (!this.ext) return;

    const query = this.gl.createQuery();
    if (!query) return;

    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.queries.set(label, query);
  }

  end(label: string): void {
    if (!this.ext) return;
    if (!this.queries.has(label)) return;

    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  /**
   * Read the result. Must be called on a LATER frame (GPU is async).
   * Returns nanoseconds, or null if not ready.
   */
  readResult(label: string): number | null {
    if (!this.ext) return null;

    const query = this.queries.get(label);
    if (!query) return null;

    // Check for GPU disjoint (result unreliable)
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      this.gl.deleteQuery(query);
      this.queries.delete(label);
      return null;
    }

    // Check if result is available
    const available = this.gl.getQueryParameter(
      query,
      this.gl.QUERY_RESULT_AVAILABLE
    );
    if (!available) return null;

    const nanoseconds = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
    this.gl.deleteQuery(query);
    this.queries.delete(label);

    return nanoseconds;
  }

  dispose(): void {
    for (const query of this.queries.values()) {
      this.gl.deleteQuery(query);
    }
    this.queries.clear();
  }
}
```
