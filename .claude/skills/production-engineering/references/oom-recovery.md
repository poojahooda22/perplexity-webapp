# OOM Recovery for WebGL Applications

> Why WebGL apps are uniquely OOM-prone, memory pressure detection, progressive quality reduction tiers, texture budget management, FBO pool emergency cleanup, TypedArray hygiene, WebGL context loss as OOM signal, Web Worker isolation, mobile-specific limits, and crash recovery via scene state persistence.

## Table of Contents

1. [OOM in WebGL Context](#oom-in-webgl-context)
2. [Memory Pressure Detection](#memory-pressure-detection)
3. [Progressive Quality Reduction](#progressive-quality-reduction)
4. [Texture Budget Manager](#texture-budget-manager)
5. [FBO Pool Pressure Handling](#fbo-pool-pressure-handling)
6. [ArrayBuffer and TypedArray Management](#arraybuffer-and-typedarray-management)
7. [WebGL Context Loss as OOM Signal](#webgl-context-loss-as-oom-signal)
8. [Worker Memory Isolation](#worker-memory-isolation)
9. [Mobile-Specific OOM](#mobile-specific-oom)
10. [Crash Recovery](#crash-recovery)
11. [Anti-Patterns](#anti-patterns)

---

## OOM in WebGL Context

### Why WebGL Apps Are Uniquely OOM-Prone

A standard web app allocates memory in the JS heap, which the browser garbage
collector manages. WebGL apps operate across three separate memory domains, and
the GC only controls one of them:

```
Memory Domain       Who Controls It     What Lives There
─────────────────────────────────────────────────────────────────────
JS Heap             GC (automatic)      Scene JSON, node graph, component state
GPU VRAM            Manual (you)        Textures, FBOs, VBOs, shader programs
CPU Typed Arrays    Manual (you)        Particle buffers, geometry data, image pixels
```

When VRAM is exhausted, the GPU driver kills the WebGL context. The browser
does not throw a catchable exception — it fires `webglcontextlost` and discards
every GPU resource. If you are not listening for this event and handling it
deliberately, the canvas goes black and stays black.

When the JS heap approaches its limit, V8 GC pressure increases until the tab
crashes with an out-of-memory error. TypedArrays (Float32Array, Uint8Array, etc.)
count toward the heap but are NOT collected by GC when a JS reference is dropped
— they require explicit `.buffer` lifecycle management.

### VRAM Consumption Reference (WebGL compositor)

```
Resource                         VRAM Cost (1920×1080)
──────────────────────────────────────────────────────
RGBA8 texture                    8.29 MB
RGBA16F texture (FBO color)      16.59 MB
RGBA32F texture                  33.18 MB
FBO with RGBA16F + Depth32F      24.88 MB
Double-buffered FBO (ping-pong)  49.76 MB
Compositor with 4 FBO layers     ~200 MB
Shader program (compiled binary) 1–5 MB per program
VBO for particle system (100k)   ~2.4 MB

Total for a complex scene with 6 layers:
  Textures:     ~80 MB
  FBOs:         ~150 MB
  Shaders:      ~20 MB
  Geometry:     ~10 MB
  ─────────────────────
  Total:        ~260 MB VRAM

Pressure threshold: >200 MB on mobile, >512 MB on low-end desktop
```

### The OOM Cascade

```
VRAM fills up
  ↓
GPU driver starts evicting resources (invisible to app)
  ↓
Shader programs become invalid (renders go wrong / black)
  ↓
Driver submits TDR (Timeout Detection Recovery) on Windows
  ↓
webglcontextlost fires
  ↓
ALL GPU resources destroyed instantly, no exceptions
  ↓
If unhandled: black canvas, frozen editor, user rage-quit
If handled:   graceful degradation → reduce quality → restore context
```

---

## Memory Pressure Detection

### JS Heap Pressure: `performance.measureUserAgentSpecificMemory()`

```typescript
// lib/memory/pressure-detector.ts

interface MemoryPressureState {
  heapUsedMB: number;
  heapLimitMB: number;
  pressureRatio: number; // 0.0 – 1.0
  level: 'normal' | 'elevated' | 'critical';
}

/**
 * Measure current JS heap usage.
 * Returns null in environments where the API is unavailable
 * (requires cross-origin isolation: COOP/COEP headers).
 */
export async function measureHeapPressure(): Promise<MemoryPressureState | null> {
  if (typeof window === 'undefined') return null;
  if (!('measureUserAgentSpecificMemory' in performance)) return null;

  try {
    const result = await (performance as any).measureUserAgentSpecificMemory();
    const usedMB = result.bytes / (1024 * 1024);

    // V8 heap limit is not directly exposed. Approximate from navigator.deviceMemory.
    // Rule of thumb: browser tabs get ~25% of physical RAM as heap limit.
    const deviceMemoryGB = (navigator as any).deviceMemory ?? 4;
    const estimatedLimitMB = deviceMemoryGB * 1024 * 0.25;

    const ratio = usedMB / estimatedLimitMB;

    return {
      heapUsedMB: parseFloat(usedMB.toFixed(1)),
      heapLimitMB: parseFloat(estimatedLimitMB.toFixed(0)),
      pressureRatio: parseFloat(ratio.toFixed(3)),
      level: ratio > 0.85 ? 'critical' : ratio > 0.65 ? 'elevated' : 'normal',
    };
  } catch {
    return null;
  }
}
```

### Device Memory Classification

```typescript
// lib/memory/device-classification.ts

export type DeviceTier = 'low' | 'mid' | 'high';

export interface DeviceMemoryProfile {
  tier: DeviceTier;
  physicalRAMGB: number;
  vramBudgetMB: number;
  jsHeapBudgetMB: number;
  maxFBOCount: number;
  maxTextureCount: number;
  targetResolutionScale: number; // 0.5 = half-res, 1.0 = full-res
}

export function classifyDevice(): DeviceMemoryProfile {
  const ramGB = (navigator as any).deviceMemory ?? 4;

  if (ramGB <= 2) {
    // iOS Safari on older devices, budget Android phones.
    return {
      tier: 'low',
      physicalRAMGB: ramGB,
      vramBudgetMB: 128,
      jsHeapBudgetMB: 128,
      maxFBOCount: 3,
      maxTextureCount: 8,
      targetResolutionScale: 0.5,
    };
  }

  if (ramGB <= 6) {
    // Mid-range Android, MacBook Air M1, older iPhones.
    return {
      tier: 'mid',
      physicalRAMGB: ramGB,
      vramBudgetMB: 256,
      jsHeapBudgetMB: 512,
      maxFBOCount: 6,
      maxTextureCount: 20,
      targetResolutionScale: 0.75,
    };
  }

  // High-end desktop, MacBook Pro M2/M3, modern flagships.
  return {
    tier: 'high',
    physicalRAMGB: ramGB,
    vramBudgetMB: 512,
    jsHeapBudgetMB: 1024,
    maxFBOCount: 16,
    maxTextureCount: 64,
    targetResolutionScale: 1.0,
  };
}
```

### Continuous Pressure Polling

```typescript
// lib/memory/pressure-monitor.ts

import { measureHeapPressure } from './pressure-detector';
import { classifyDevice } from './device-classification';

type PressureCallback = (level: 'normal' | 'elevated' | 'critical') => void;

export class MemoryPressureMonitor {
  private readonly intervalMs: number;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private readonly callbacks: Set<PressureCallback> = new Set();
  private lastLevel: 'normal' | 'elevated' | 'critical' = 'normal';

  constructor(intervalMs = 10_000) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timerId !== null) return;
    this.timerId = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  onPressureChange(callback: PressureCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private async poll(): Promise<void> {
    const state = await measureHeapPressure();
    if (!state) return;

    if (state.level !== this.lastLevel) {
      this.lastLevel = state.level;
      for (const cb of this.callbacks) {
        cb(state.level);
      }
    }
  }
}

export const pressureMonitor = new MemoryPressureMonitor(10_000);
```

---

## Progressive Quality Reduction

### Quality Tiers

Define explicit tiers that the system can step down through as pressure increases.
Avoid binary "on/off" degradation — that creates jarring visual jumps.

```typescript
// lib/quality/tiers.ts

export type QualityTier = 0 | 1 | 2 | 3;
// 3 = full quality (default)
// 2 = reduced: half-res FBOs, no MSAA
// 1 = minimal: quarter-res, single-pass rendering, no post-processing
// 0 = emergency: static fallback image, WebGL disabled

export interface QualityConfig {
  tier: QualityTier;
  resolutionScale: number;      // Multiplier on canvas size (e.g. 0.5 = half-res)
  fboScale: number;             // Multiplier on FBO size
  postProcessingEnabled: boolean;
  msaaEnabled: boolean;
  maxActiveFBOs: number;
  maxTextures: number;
  particleCount: number;        // Max particles across all effects
  shaderPrecision: 'highp' | 'mediump' | 'lowp';
}

export const QUALITY_TIERS: Record<QualityTier, QualityConfig> = {
  3: {
    tier: 3,
    resolutionScale: 1.0,
    fboScale: 1.0,
    postProcessingEnabled: true,
    msaaEnabled: true,
    maxActiveFBOs: 16,
    maxTextures: 64,
    particleCount: 100_000,
    shaderPrecision: 'highp',
  },
  2: {
    tier: 2,
    resolutionScale: 0.75,
    fboScale: 0.5,
    postProcessingEnabled: true,
    msaaEnabled: false,
    maxActiveFBOs: 8,
    maxTextures: 32,
    particleCount: 50_000,
    shaderPrecision: 'highp',
  },
  1: {
    tier: 1,
    resolutionScale: 0.5,
    fboScale: 0.25,
    postProcessingEnabled: false,
    msaaEnabled: false,
    maxActiveFBOs: 4,
    maxTextures: 12,
    particleCount: 10_000,
    shaderPrecision: 'mediump',
  },
  0: {
    tier: 0,
    resolutionScale: 0,
    fboScale: 0,
    postProcessingEnabled: false,
    msaaEnabled: false,
    maxActiveFBOs: 0,
    maxTextures: 0,
    particleCount: 0,
    shaderPrecision: 'lowp',
  },
};
```

### Quality Controller

```typescript
// lib/quality/controller.ts

import { QUALITY_TIERS, type QualityTier, type QualityConfig } from './tiers';

type TierChangeCallback = (config: QualityConfig, reason: string) => void;

export class QualityController {
  private currentTier: QualityTier = 3;
  private readonly callbacks: Set<TierChangeCallback> = new Set();

  getCurrentConfig(): QualityConfig {
    return QUALITY_TIERS[this.currentTier];
  }

  getCurrentTier(): QualityTier {
    return this.currentTier;
  }

  /**
   * Step down one quality tier. Idempotent at tier 0.
   * @param reason Human-readable reason for logging and Sentry breadcrumbs.
   */
  degradeQuality(reason: string): QualityConfig {
    if (this.currentTier === 0) {
      console.warn('[Quality] Already at minimum tier. Cannot degrade further.');
      return QUALITY_TIERS[0];
    }

    const newTier = (this.currentTier - 1) as QualityTier;
    this.currentTier = newTier;

    console.warn(`[Quality] Degraded to tier ${newTier}: ${reason}`);

    const config = QUALITY_TIERS[newTier];
    for (const cb of this.callbacks) {
      cb(config, reason);
    }

    return config;
  }

  /**
   * Step up one quality tier. Only call when pressure is resolved.
   */
  improveQuality(reason: string): QualityConfig {
    if (this.currentTier === 3) {
      return QUALITY_TIERS[3];
    }

    const newTier = (this.currentTier + 1) as QualityTier;
    this.currentTier = newTier;

    const config = QUALITY_TIERS[newTier];
    for (const cb of this.callbacks) {
      cb(config, reason);
    }

    return config;
  }

  onTierChange(callback: TierChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
}

export const qualityController = new QualityController();
```

---

## Texture Budget Manager

### LRU Eviction Policy

```typescript
// lib/memory/texture-budget.ts

import * as THREE from 'three';

interface TextureEntry {
  texture: THREE.Texture | THREE.DataTexture;
  bytes: number;
  key: string;
  lastUsedAt: number;
}

/**
 * Manages total VRAM consumed by textures.
 * Evicts least-recently-used textures when approaching the budget limit.
 *
 * Usage pattern:
 *   const tex = await textureBudget.acquire(key, () => loadTexture(url));
 *   textureBudget.touch(key); // Call in render loop to update LRU timestamp.
 *   textureBudget.release(key); // Call when a scene node is removed.
 */
export class TextureBudgetManager {
  private readonly budgetBytes: number;
  private readonly entries: Map<string, TextureEntry> = new Map();
  private usedBytes = 0;

  constructor(budgetMB: number) {
    this.budgetBytes = budgetMB * 1024 * 1024;
  }

  /**
   * Acquire a texture, loading it if not cached.
   * If the budget would be exceeded, evict LRU textures first.
   */
  async acquire(
    key: string,
    load: () => Promise<THREE.Texture | THREE.DataTexture>,
    estimatedBytes: number,
  ): Promise<THREE.Texture | THREE.DataTexture> {
    // Cache hit.
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.texture;
    }

    // Evict until there is room.
    while (this.usedBytes + estimatedBytes > this.budgetBytes) {
      const evicted = this.evictLRU();
      if (!evicted) {
        console.error(
          `[TextureBudget] Cannot evict enough textures to fit "${key}" ` +
            `(${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB). ` +
            `Budget: ${(this.budgetBytes / (1024 * 1024)).toFixed(0)} MB, ` +
            `Used: ${(this.usedBytes / (1024 * 1024)).toFixed(1)} MB`,
        );
        break; // Proceed anyway and hope the GPU handles it.
      }
    }

    const texture = await load();
    this.entries.set(key, {
      texture,
      bytes: estimatedBytes,
      key,
      lastUsedAt: Date.now(),
    });
    this.usedBytes += estimatedBytes;

    return texture;
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastUsedAt = Date.now();
    }
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.texture.dispose();
    this.usedBytes -= entry.bytes;
    this.entries.delete(key);
  }

  releaseAll(): void {
    for (const entry of this.entries.values()) {
      entry.texture.dispose();
    }
    this.entries.clear();
    this.usedBytes = 0;
  }

  getStats(): { usedMB: number; budgetMB: number; count: number; pressureRatio: number } {
    return {
      usedMB: parseFloat((this.usedBytes / (1024 * 1024)).toFixed(1)),
      budgetMB: parseFloat((this.budgetBytes / (1024 * 1024)).toFixed(0)),
      count: this.entries.size,
      pressureRatio: this.usedBytes / this.budgetBytes,
    };
  }

  private evictLRU(): boolean {
    let oldest: TextureEntry | null = null;

    for (const entry of this.entries.values()) {
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
        oldest = entry;
      }
    }

    if (!oldest) return false;

    console.warn(
      `[TextureBudget] Evicting LRU texture "${oldest.key}" ` +
        `(${(oldest.bytes / (1024 * 1024)).toFixed(1)} MB, ` +
        `last used ${((Date.now() - oldest.lastUsedAt) / 1000).toFixed(0)}s ago)`,
    );

    this.release(oldest.key);
    return true;
  }
}
```

---

## FBO Pool Pressure Handling

### Pool Exhaustion Protocol

```typescript
// lib/fbo/pool-pressure.ts

import type { WebGLRenderTarget } from 'three';

export type FBOPoolPressureLevel = 'normal' | 'high' | 'exhausted';

export interface FBOPoolStats {
  capacity: number;
  inUse: number;
  available: number;
  pressureLevel: FBOPoolPressureLevel;
}

export class FBOPool {
  private readonly maxSize: number;
  private readonly available: WebGLRenderTarget[] = [];
  private inUse = 0;
  private onExhaustedCallback: (() => void) | null = null;
  private onHighPressureCallback: (() => void) | null = null;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  acquire(
    create: () => WebGLRenderTarget,
  ): WebGLRenderTarget | null {
    if (this.available.length > 0) {
      const fbo = this.available.pop()!;
      this.inUse++;
      this.checkPressure();
      return fbo;
    }

    const totalInPool = this.inUse + this.available.length;
    if (totalInPool >= this.maxSize) {
      console.error(
        `[FBOPool] Pool exhausted (max=${this.maxSize}). Cannot allocate new FBO.`,
      );
      this.onExhaustedCallback?.();
      return null; // Caller must handle null — do not render this layer.
    }

    const fbo = create();
    this.inUse++;
    this.checkPressure();
    return fbo;
  }

  release(fbo: WebGLRenderTarget): void {
    this.inUse = Math.max(0, this.inUse - 1);
    this.available.push(fbo);
  }

  /**
   * Emergency cleanup: release all available FBOs and dispose them.
   * Call when the device enters critical memory pressure.
   * FBOs currently in use are left alone to avoid corrupting the active render.
   */
  emergencyCleanup(): number {
    const count = this.available.length;
    for (const fbo of this.available) {
      fbo.dispose();
    }
    this.available.length = 0;

    console.warn(`[FBOPool] Emergency cleanup: disposed ${count} pooled FBOs.`);
    return count;
  }

  /**
   * Full teardown: dispose everything including in-use FBOs.
   * Only call during context loss recovery, where all GPU resources
   * are already destroyed by the driver anyway.
   */
  destroyAll(allActiveFBOs: WebGLRenderTarget[]): void {
    for (const fbo of this.available) {
      fbo.dispose();
    }
    for (const fbo of allActiveFBOs) {
      fbo.dispose();
    }
    this.available.length = 0;
    this.inUse = 0;
  }

  getStats(): FBOPoolStats {
    return {
      capacity: this.maxSize,
      inUse: this.inUse,
      available: this.available.length,
      pressureLevel: this.getPressureLevel(),
    };
  }

  onExhausted(callback: () => void): void {
    this.onExhaustedCallback = callback;
  }

  onHighPressure(callback: () => void): void {
    this.onHighPressureCallback = callback;
  }

  private getPressureLevel(): FBOPoolPressureLevel {
    const utilization = this.inUse / this.maxSize;
    if (utilization >= 1.0) return 'exhausted';
    if (utilization >= 0.8) return 'high';
    return 'normal';
  }

  private checkPressure(): void {
    const level = this.getPressureLevel();
    if (level === 'exhausted') {
      this.onExhaustedCallback?.();
    } else if (level === 'high') {
      this.onHighPressureCallback?.();
    }
  }
}
```

---

## ArrayBuffer and TypedArray Management

### The GC Does Not Collect TypedArrays Reliably

A common misconception: setting a `Float32Array` reference to `null` does not
guarantee the underlying `ArrayBuffer` is released promptly. V8 GC collects
the wrapper object, but the backing buffer may persist until the next major GC
cycle, which can be seconds or minutes later.

```typescript
// WRONG: "Releasing" a typed array by setting to null.
let particles: Float32Array | null = new Float32Array(100_000 * 4); // 1.6 MB
particles = null;
// The ArrayBuffer backing this may not be collected for a long time.
// On iOS Safari, this has been measured to persist for 30-60 seconds.

// CORRECT: Transfer the buffer to a Worker, then terminate the Worker.
// OR: Use a pool and reuse buffers instead of allocating new ones.
```

### TypedArray Pool

```typescript
// lib/memory/typed-array-pool.ts

/**
 * Reusable pool of Float32Arrays to avoid repeated allocation/GC pressure.
 * All arrays in the pool are the same fixed length.
 *
 * Usage:
 *   const pool = new Float32ArrayPool(4096, 8); // 8 arrays of 4096 floats each
 *   const buf = pool.acquire();   // Get one
 *   pool.release(buf);            // Return it (caller must zero it if needed)
 */
export class Float32ArrayPool {
  private readonly pool: Float32Array[] = [];
  private readonly length: number;
  private readonly maxSize: number;
  private inUse = 0;

  constructor(length: number, maxSize: number) {
    this.length = length;
    this.maxSize = maxSize;

    // Pre-allocate to avoid first-use allocation pressure.
    for (let i = 0; i < Math.ceil(maxSize / 2); i++) {
      this.pool.push(new Float32Array(length));
    }
  }

  acquire(): Float32Array {
    const buf = this.pool.pop();
    if (buf) {
      this.inUse++;
      return buf;
    }

    if (this.inUse >= this.maxSize) {
      console.warn(
        `[Float32ArrayPool] Pool at capacity (${this.maxSize} arrays of ${this.length} floats). ` +
          'Allocating overflow buffer. This is a leak indicator.',
      );
    }

    this.inUse++;
    return new Float32Array(this.length);
  }

  release(buf: Float32Array): void {
    if (buf.length !== this.length) {
      console.error(
        `[Float32ArrayPool] Returned buffer has wrong length (${buf.length} vs ${this.length}). Discarding.`,
      );
      return;
    }

    this.inUse = Math.max(0, this.inUse - 1);

    if (this.pool.length < this.maxSize) {
      this.pool.push(buf);
    }
    // If pool is full, discard — let GC collect it.
  }

  getStats() {
    return {
      pooled: this.pool.length,
      inUse: this.inUse,
      bytesPooled: this.pool.length * this.length * 4,
    };
  }
}
```

---

## WebGL Context Loss as OOM Signal

### Context Loss Event Handling

When the GPU driver kills the context due to VRAM exhaustion, the browser fires
`webglcontextlost`. This is your signal to immediately stop rendering, perform
emergency cleanup, and begin the recovery sequence.

```typescript
// lib/webgl/context-loss-handler.ts

import * as THREE from 'three';
import { qualityController } from '@/lib/quality/controller';
import { saveSceneStateToSessionStorage } from '@/lib/crash-recovery/state-saver';

export class ContextLossHandler {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private isLost = false;
  private lostAt: number | null = null;

  constructor(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.canvas = canvas;
  }

  attach(): void {
    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
  }

  detach(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
  }

  get isContextLost(): boolean {
    return this.isLost;
  }

  private readonly onContextLost = (event: Event): void => {
    // CRITICAL: preventDefault() tells the browser you will handle recovery.
    // Without this, the browser will NOT fire webglcontextrestored.
    event.preventDefault();

    this.isLost = true;
    this.lostAt = Date.now();

    console.error('[WebGL] Context lost. Treating as OOM signal.');

    // Step 1: Save scene state immediately — before anything else.
    // The tab may crash before restoration completes.
    saveSceneStateToSessionStorage();

    // Step 2: Degrade quality one tier.
    // When context restores, we will render at lower quality to prevent
    // immediate re-exhaustion.
    qualityController.degradeQuality('webgl-context-loss-oom');

    // Step 3: Notify the UI.
    window.dispatchEvent(
      new CustomEvent('webgl-app:context-lost', {
        detail: { timestamp: this.lostAt },
      }),
    );
  };

  private readonly onContextRestored = async (): Promise<void> => {
    const recoveryDurationMs = this.lostAt ? Date.now() - this.lostAt : null;
    console.warn(
      `[WebGL] Context restored after ${recoveryDurationMs}ms. ` +
        `Rebuilding GPU resources at quality tier ${qualityController.getCurrentTier()}.`,
    );

    this.isLost = false;

    // Rebuild all GPU resources at the reduced quality level.
    await rebuildGPUResources(this.renderer, qualityController.getCurrentConfig());

    window.dispatchEvent(
      new CustomEvent('webgl-app:context-restored', {
        detail: { recoveryDurationMs },
      }),
    );
  };
}

async function rebuildGPUResources(
  renderer: THREE.WebGLRenderer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _quality: import('@/lib/quality/tiers').QualityConfig,
): Promise<void> {
  // Implementation: reload textures, recompile shaders, reallocate FBOs
  // at the new quality settings. This is scene-specific — hook into your
  // compositor's rebuild lifecycle here.
  console.log('[WebGL] Rebuilding GPU resources...');
}
```

---

## Worker Memory Isolation

### Why Workers Help with OOM

JavaScript Web Workers run in a separate OS thread with a separate heap. Heavy
computation in a Worker cannot directly cause the main thread to OOM. This is
critical for a GPU compositor because particle simulation, geometry generation, and
large data processing happen before GPU upload.

```typescript
// workers/particle-simulation.worker.ts
// This worker does NOT import Three.js. It operates on raw typed arrays only.

interface SimulationMessage {
  type: 'simulate';
  positions: Float32Array;
  velocities: Float32Array;
  deltaTime: number;
  count: number;
}

interface SimulationResult {
  type: 'result';
  positions: Float32Array;
  velocities: Float32Array;
}

self.addEventListener('message', (event: MessageEvent<SimulationMessage>) => {
  const { positions, velocities, deltaTime, count } = event.data;

  // Update positions in-place using the transferred buffers.
  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    positions[idx] += velocities[idx] * deltaTime;
    positions[idx + 1] += velocities[idx + 1] * deltaTime;
    positions[idx + 2] += velocities[idx + 2] * deltaTime;
  }

  // Transfer ownership back to the main thread.
  // Transferring (not copying) means zero additional memory allocation.
  const result: SimulationResult = { type: 'result', positions, velocities };
  self.postMessage(result, [positions.buffer, velocities.buffer]);
});
```

```typescript
// lib/workers/particle-worker-bridge.ts

export class ParticleWorkerBridge {
  private worker: Worker | null = null;
  private pendingResolve: ((result: SimulationResult) => void) | null = null;

  init(): void {
    this.worker = new Worker(
      new URL('../../workers/particle-simulation.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.onmessage = (event: MessageEvent<SimulationResult>) => {
      this.pendingResolve?.(event.data);
      this.pendingResolve = null;
    };

    this.worker.onerror = (err) => {
      console.error('[ParticleWorker] Error:', err.message);
    };
  }

  async simulate(
    positions: Float32Array,
    velocities: Float32Array,
    deltaTime: number,
    count: number,
  ): Promise<{ positions: Float32Array; velocities: Float32Array }> {
    if (!this.worker) throw new Error('Worker not initialized');

    return new Promise((resolve) => {
      this.pendingResolve = resolve as (r: SimulationResult) => void;

      // Transfer buffers to the worker — zero-copy.
      this.worker!.postMessage(
        { type: 'simulate', positions, velocities, deltaTime, count },
        [positions.buffer, velocities.buffer],
      );
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

interface SimulationResult {
  type: 'result';
  positions: Float32Array;
  velocities: Float32Array;
}
```

---

## Mobile-Specific OOM

### iOS Safari Memory Limit

iOS Safari enforces a hard ~1 GB memory limit per tab (measured as physical RAM,
including all heaps and VRAM combined since Apple Silicon uses unified memory).
Exceeding this limit causes the tab to crash without warning and without firing
any event.

```typescript
// lib/memory/ios-guard.ts

/**
 * Check if we are running on iOS Safari and apply conservative limits.
 *
 * iOS Safari behaviors:
 * - Hard 1 GB per-tab limit (unified memory = JS heap + VRAM + GPU work)
 * - No beforeunload event when the tab is killed due to OOM
 * - webglcontextlost MAY fire before the crash, but is not guaranteed
 * - navigator.deviceMemory is always undefined on iOS (privacy restriction)
 */
export function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iP(ad|od|hone)/i.test(ua) &&
    /WebKit/i.test(ua) &&
    !/CriOS|FxiOS|OPiOS|EdgiOS/i.test(ua)
  );
}

export function getIOSMemoryBudgetMB(): number {
  if (!isIOSSafari()) return Infinity;

  // iOS device heuristic based on screen resolution as proxy for device generation.
  const pixelCount = window.screen.width * window.screen.height * window.devicePixelRatio ** 2;

  // Older devices (iPhone 8, iPad mini 5): ~512 MB total
  if (pixelCount < 2_000_000) return 300;

  // Mid-range (iPhone 12, iPad Air): ~3 GB physical → ~800 MB usable per tab
  if (pixelCount < 6_000_000) return 500;

  // High-end (iPhone 15 Pro, iPad Pro M2): ~8 GB physical → ~1.2 GB usable
  return 700;
}
```

### Android Low Memory Events

```typescript
// lib/memory/android-pressure.ts
// The Page Visibility API combined with performance.memory gives a proxy
// for Android low-memory signals. Android kills background tabs first,
// then reduces resources for foreground tabs under pressure.

export function watchAndroidMemoryPressure(
  onPressure: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  // When the tab becomes hidden, proactively release optional resources.
  // On Android, hidden tabs are first candidates for being killed.
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      console.log('[Memory] Tab hidden — releasing optional GPU resources.');
      onPressure();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
```

---

## Crash Recovery

### Scene State Persistence Before OOM Kill

The goal: when the tab crashes (or is killed by the OS), the user's unsaved
scene state survives and can be restored on reload.

```typescript
// lib/crash-recovery/state-saver.ts

const SESSION_KEY = 'webgl-app:crash-recovery-state';
const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000; // 30 minutes

export interface CrashRecoverySnapshot {
  savedAt: number;
  sceneId: string;
  sceneJson: string;      // Serialized scene JSON (compressed if large)
  cameraState: string;    // JSON string of camera position/rotation
  selectedNodeId: string | null;
  qualityTier: number;
}

/**
 * Save the current scene state to sessionStorage.
 * Called:
 *   1. Every 60 seconds (periodic auto-save)
 *   2. Immediately on webglcontextlost (OOM signal)
 *   3. Immediately on visibilitychange to 'hidden' (mobile kill risk)
 */
export function saveSceneStateToSessionStorage(
  sceneId: string,
  sceneJson: object,
  cameraState: object,
  selectedNodeId: string | null,
  qualityTier: number,
): void {
  try {
    const snapshot: CrashRecoverySnapshot = {
      savedAt: Date.now(),
      sceneId,
      sceneJson: JSON.stringify(sceneJson),
      cameraState: JSON.stringify(cameraState),
      selectedNodeId,
      qualityTier,
    };

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
  } catch (err) {
    // sessionStorage can throw if storage is full.
    // This is a best-effort save — log and continue.
    console.warn('[CrashRecovery] Failed to save state to sessionStorage:', err);
  }
}

/**
 * Restore scene state after a crash/reload.
 * Returns null if there is no snapshot or the snapshot is too old.
 */
export function loadCrashRecoverySnapshot(): CrashRecoverySnapshot | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const snapshot = JSON.parse(raw) as CrashRecoverySnapshot;

    // Discard stale snapshots.
    if (Date.now() - snapshot.savedAt > MAX_SNAPSHOT_AGE_MS) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }

    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Clear the crash recovery snapshot after a successful restore.
 */
export function clearCrashRecoverySnapshot(): void {
  sessionStorage.removeItem(SESSION_KEY);
}
```

### Recovery UI Integration

```typescript
// components/editor/CrashRecoveryBanner.tsx
'use client';

import { useEffect, useState } from 'react';
import {
  loadCrashRecoverySnapshot,
  clearCrashRecoverySnapshot,
} from '@/lib/crash-recovery/state-saver';

export function CrashRecoveryBanner() {
  const [snapshot, setSnapshot] = useState<ReturnType<typeof loadCrashRecoverySnapshot>>(null);

  useEffect(() => {
    const s = loadCrashRecoverySnapshot();
    if (s) setSnapshot(s);
  }, []);

  if (!snapshot) return null;

  const ageMinutes = Math.round((Date.now() - snapshot.savedAt) / 60_000);

  const handleRestore = () => {
    // Dispatch to your editor store.
    window.dispatchEvent(
      new CustomEvent('webgl-app:restore-snapshot', { detail: snapshot }),
    );
    clearCrashRecoverySnapshot();
    setSnapshot(null);
  };

  const handleDismiss = () => {
    clearCrashRecoverySnapshot();
    setSnapshot(null);
  };

  return (
    <div role="alert" className="crash-recovery-banner">
      <p>
        Your session was interrupted {ageMinutes} minute{ageMinutes !== 1 ? 's' : ''} ago.
        Would you like to restore your unsaved changes?
      </p>
      <button onClick={handleRestore}>Restore</button>
      <button onClick={handleDismiss}>Dismiss</button>
    </div>
  );
}
```

### Periodic Auto-Save Hook

```typescript
// lib/crash-recovery/use-auto-save.ts
'use client';

import { useEffect, useRef } from 'react';
import { saveSceneStateToSessionStorage } from './state-saver';

const AUTO_SAVE_INTERVAL_MS = 60_000; // Every 60 seconds.

export function useAutoSave(
  getState: () => {
    sceneId: string;
    sceneJson: object;
    cameraState: object;
    selectedNodeId: string | null;
    qualityTier: number;
  },
): void {
  const getStateRef = useRef(getState);
  getStateRef.current = getState;

  useEffect(() => {
    const save = () => {
      const state = getStateRef.current();
      saveSceneStateToSessionStorage(
        state.sceneId,
        state.sceneJson,
        state.cameraState,
        state.selectedNodeId,
        state.qualityTier,
      );
    };

    const timerId = setInterval(save, AUTO_SAVE_INTERVAL_MS);

    // Also save on context loss and tab hide.
    const onContextLost = () => save();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') save();
    };

    window.addEventListener('webgl-app:context-lost', onContextLost);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(timerId);
      window.removeEventListener('webgl-app:context-lost', onContextLost);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}
```

---

## Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| Not calling `event.preventDefault()` in `webglcontextlost` handler | Without this call, the browser does not attempt context restoration. `webglcontextrestored` never fires. The canvas stays black permanently. | Always call `event.preventDefault()` as the first line of the context loss handler. |
| Treating context loss as a fatal error | Context loss is a normal hardware event. Users on budget laptops and mobile devices trigger it regularly under memory pressure. | Handle it as a recoverable event: degrade quality, save state, rebuild GPU resources. |
| Allocating new TypedArrays every frame | A 100k-particle system allocates 1.6 MB per frame × 60 fps = 96 MB/s of allocation. GC cannot keep up. Heap pressure spikes. | Pool and reuse TypedArrays. Allocate once at initialization. Transfer to Workers rather than copying. |
| Ignoring `navigator.deviceMemory` for budget calculation | A scene tuned for a desktop with 32 GB RAM will OOM on a phone with 2 GB RAM. There is no single budget that works for all devices. | Classify the device on first load and apply the appropriate VRAM, FBO, and texture count budgets. |
| Recovering context without reducing quality | If you restore the scene at the same quality level that caused the OOM, the context will be lost again within seconds. | Always step down at least one quality tier on recovery. Only step back up after sustained pressure-free operation. |
| Using `sessionStorage` for large scene state | `sessionStorage` has a 5–10 MB limit per origin. A complex scene JSON can exceed this, causing the save to throw silently. | Compress scene JSON before saving (e.g., use `CompressionStream`). Save only a delta or a reference (scene ID + unsaved node overrides), not the full JSON. |
| Disposing FBOs that are currently bound | Calling `fbo.dispose()` while the FBO is set as `renderer.setRenderTarget(fbo)` leaves the renderer in an invalid state. Subsequent draws produce undefined behavior. | Always call `renderer.setRenderTarget(null)` before disposing any render target. |
| Running particle simulation on the main thread | Heavy simulation (N-body, SPH, large particle counts) can block the main thread for 16+ ms, triggering GC storms and rendering stutters that look like OOM when they are actually CPU thrash. | Offload simulation to Web Workers. Transfer typed array buffers, not copies. |

---

## See Also

- [memory-management-production.md](./memory-management-production.md) — VRAM budgeting, Three.js dispose patterns, `renderer.info` leak detection, WeakRef safety nets. The `VRAMBudgetTracker` in that file complements the `TextureBudgetManager` here.
- [webgl-context-management.md](./webgl-context-management.md) — Deep coverage of context loss causes, resource re-creation protocol, testing context loss deliberately with `WEBGL_lose_context` extension, recovery time budgets, and multi-tab context management.
