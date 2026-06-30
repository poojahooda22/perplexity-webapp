# Memory Management for WebGL Applications in Production

> GPU memory budgeting, Three.js dispose patterns, leak detection, automated leak tests, WeakRef/FinalizationRegistry safety nets, and garbage collection interaction with GPU resources.

## Table of Contents

1. [GPU Memory Budgeting](#gpu-memory-budgeting)
2. [Three.js Dispose Patterns](#threejs-dispose-patterns)
3. [Detecting Leaks via renderer.info](#detecting-leaks-via-rendererinfo)
4. [Automated Leak Tests](#automated-leak-tests)
5. [WeakRef and FinalizationRegistry Safety Nets](#weakref-and-finalizationregistry-safety-nets)
6. [Garbage Collection and GPU Resources](#garbage-collection-and-gpu-resources)
7. [FBO Pool Management](#fbo-pool-management)
8. [Texture Memory Optimization](#texture-memory-optimization)
9. [Shader Program Caching](#shader-program-caching)
10. [Production Memory Monitoring](#production-memory-monitoring)

---

## GPU Memory Budgeting

### VRAM Cost Reference Table

Every GPU resource consumes VRAM. Here is a reference for budgeting:

```
Resource Type              Formula                                 Example (1920x1080)
---                        ---                                     ---
RGBA8 Texture              W x H x 4 bytes                         8.29 MB
RGBA16F Texture            W x H x 8 bytes                         16.59 MB
RGBA32F Texture            W x H x 16 bytes                        33.18 MB
R8 Texture (single chan)   W x H x 1 byte                          2.07 MB
RG16F Texture              W x H x 4 bytes                         8.29 MB
Depth24                    W x H x 3 bytes                         6.22 MB
Depth32F                   W x H x 4 bytes                         8.29 MB
Depth24Stencil8            W x H x 4 bytes                         8.29 MB
Mipmapped texture          Base x 1.33                             11.03 MB (RGBA8 mipped)
Cube map (6 faces)         W x H x 4 x 6 bytes (RGBA8)            49.77 MB
Render target (color+depth) W x H x (colorBPP + depthBPP)         16.59 MB (RGBA8 + D24)
Render target (HalfFloat)  W x H x (8 + 4) bytes                  24.88 MB (RGBA16F + D32F)
```

### Budget Calculator

```typescript
// lib/memory/vramBudget.ts

interface VRAMBudget {
  totalBudgetMB: number;
  allocatedMB: number;
  remainingMB: number;
  allocations: VRAMAllocation[];
  overBudget: boolean;
}

interface VRAMAllocation {
  name: string;
  type: 'texture' | 'renderTarget' | 'geometry' | 'shader';
  bytes: number;
  width?: number;
  height?: number;
  format?: string;
}

export class VRAMBudgetTracker {
  private readonly budgetBytes: number;
  private readonly allocations: Map<string, VRAMAllocation> = new Map();

  /**
   * @param budgetMB Target VRAM budget in megabytes.
   *   Mobile: 128-256 MB
   *   Desktop low-end: 256-512 MB
   *   Desktop mid-range: 512-1024 MB
   *   Desktop high-end: 1024-2048 MB
   *
   *   For a compositor app, target 256 MB to be safe across devices.
   */
  constructor(budgetMB: number = 256) {
    this.budgetBytes = budgetMB * 1024 * 1024;
  }

  allocate(name: string, allocation: VRAMAllocation): boolean {
    const currentTotal = this.getTotalAllocated();
    if (currentTotal + allocation.bytes > this.budgetBytes) {
      console.warn(
        `[VRAMBudget] Allocation "${name}" (${formatBytes(allocation.bytes)}) ` +
        `would exceed budget. Current: ${formatBytes(currentTotal)}, ` +
        `Budget: ${formatBytes(this.budgetBytes)}`
      );
      return false; // Over budget
    }

    this.allocations.set(name, allocation);
    return true;
  }

  deallocate(name: string): void {
    this.allocations.delete(name);
  }

  getTotalAllocated(): number {
    let total = 0;
    for (const alloc of this.allocations.values()) {
      total += alloc.bytes;
    }
    return total;
  }

  getReport(): VRAMBudget {
    const allocated = this.getTotalAllocated();
    return {
      totalBudgetMB: this.budgetBytes / (1024 * 1024),
      allocatedMB: allocated / (1024 * 1024),
      remainingMB: (this.budgetBytes - allocated) / (1024 * 1024),
      allocations: Array.from(this.allocations.values()),
      overBudget: allocated > this.budgetBytes,
    };
  }

  // Convenience methods for common allocation types

  trackTexture(
    name: string,
    width: number,
    height: number,
    format: 'RGBA8' | 'RGBA16F' | 'RGBA32F' | 'R8' | 'RG16F',
    mipmaps: boolean = false
  ): boolean {
    const bpp: Record<string, number> = {
      RGBA8: 4,
      RGBA16F: 8,
      RGBA32F: 16,
      R8: 1,
      RG16F: 4,
    };
    let bytes = width * height * (bpp[format] || 4);
    if (mipmaps) bytes = Math.ceil(bytes * 1.33);

    return this.allocate(name, {
      name,
      type: 'texture',
      bytes,
      width,
      height,
      format,
    });
  }

  trackRenderTarget(
    name: string,
    width: number,
    height: number,
    colorFormat: 'RGBA8' | 'RGBA16F' = 'RGBA16F',
    hasDepth: boolean = true
  ): boolean {
    const colorBpp: Record<string, number> = { RGBA8: 4, RGBA16F: 8 };
    let bytes = width * height * (colorBpp[colorFormat] || 8);
    if (hasDepth) bytes += width * height * 4; // Depth32F or Depth24Stencil8

    return this.allocate(name, {
      name,
      type: 'renderTarget',
      bytes,
      width,
      height,
      format: `${colorFormat}${hasDepth ? '+depth' : ''}`,
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

### Per-Layer VRAM Estimation

```typescript
// lib/memory/layerVRAM.ts

/**
 * Estimate VRAM usage for a single compositor layer.
 * Each layer typically requires:
 * - 1-2 render targets (ping-pong for multi-pass effects)
 * - 0-2 additional textures (noise, LUT, etc.)
 * - 1 shader program (~negligible VRAM)
 */
export function estimateLayerVRAM(
  effectType: string,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number
): { bytes: number; breakdown: Record<string, number> } {
  const w = Math.ceil(canvasWidth * dpr);
  const h = Math.ceil(canvasHeight * dpr);
  const rtBytes = w * h * 8; // RGBA16F = 8 bytes/pixel
  const depthBytes = w * h * 4; // Depth32F

  const breakdown: Record<string, number> = {};

  // All effects need at least one render target
  breakdown.colorTarget = rtBytes;

  // Per-effect additional resources
  switch (effectType) {
    case 'bloom':
    case 'fastBloom':
      // Bloom uses downsampled mip chain (1/2, 1/4, 1/8, 1/16, 1/32)
      let mipTotal = 0;
      let mipW = Math.ceil(w / 2);
      let mipH = Math.ceil(h / 2);
      for (let i = 0; i < 5; i++) {
        mipTotal += mipW * mipH * 8 * 2; // Two targets per mip (ping-pong)
        mipW = Math.ceil(mipW / 2);
        mipH = Math.ceil(mipH / 2);
      }
      breakdown.bloomMipChain = mipTotal;
      break;

    case 'blur':
    case 'gaussianBlur':
      // Two-pass blur needs a second render target
      breakdown.blurPingPong = rtBytes;
      break;

    case 'progressiveBlur':
      // Progressive blur uses multiple downsample steps
      breakdown.progressivePingPong = rtBytes;
      breakdown.progressiveDownsample = Math.ceil(rtBytes * 0.33);
      break;

    case 'fog':
    case 'volumetricFog':
      // Fog may need depth buffer access
      breakdown.depthBuffer = depthBytes;
      break;

    case 'blobTracking':
      // Blob tracking uses small compute-like passes
      breakdown.blobPingPong = rtBytes;
      breakdown.blobAccumulator = Math.ceil(w / 4) * Math.ceil(h / 4) * 8;
      break;

    default:
      // Simple effects: just the output target
      break;
  }

  const totalBytes = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { bytes: totalBytes, breakdown };
}

/**
 * Estimate total VRAM for a compositor with N layers.
 */
export function estimateCompositorVRAM(
  layers: Array<{ effectType: string; active: boolean }>,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number
): { totalBytes: number; perLayer: Array<{ type: string; bytes: number }> } {
  const activeLayers = layers.filter((l) => l.active);
  const perLayer = activeLayers.map((layer) => {
    const est = estimateLayerVRAM(layer.effectType, canvasWidth, canvasHeight, dpr);
    return { type: layer.effectType, bytes: est.bytes };
  });

  // Add shared resources (scene render target, final composite)
  const w = Math.ceil(canvasWidth * dpr);
  const h = Math.ceil(canvasHeight * dpr);
  const sharedBytes = w * h * 8 * 2; // Scene RT + final composite RT

  const totalBytes =
    sharedBytes + perLayer.reduce((sum, l) => sum + l.bytes, 0);

  return { totalBytes, perLayer };
}
```

---

## Three.js Dispose Patterns

### The Dispose Problem

Three.js objects that reference GPU resources (textures, geometries, materials,
render targets) must be explicitly disposed. JavaScript garbage collection does
NOT free GPU memory. If you remove a Mesh from the scene without disposing its
geometry and material, the GPU memory stays allocated until the context is destroyed.

### Deep Dispose Helper

```typescript
// lib/memory/dispose.ts

import * as THREE from 'three';

/**
 * Recursively dispose all GPU resources in a Three.js object tree.
 *
 * IMPORTANT: After calling this, the object and all its children are unusable.
 * Do NOT access geometry, material, or texture properties after disposal.
 */
export function deepDispose(object: THREE.Object3D): void {
  // Traverse bottom-up to dispose children before parents
  const toDispose: THREE.Object3D[] = [];
  object.traverse((child) => toDispose.push(child));

  // Reverse so children are disposed before parents
  for (let i = toDispose.length - 1; i >= 0; i--) {
    const child = toDispose[i];
    disposeObject(child);
  }

  // Remove from parent
  if (object.parent) {
    object.parent.remove(object);
  }
}

function disposeObject(object: THREE.Object3D): void {
  // Dispose geometry
  if ('geometry' in object && object.geometry instanceof THREE.BufferGeometry) {
    object.geometry.dispose();
  }

  // Dispose material(s)
  if ('material' in object) {
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    for (const material of materials) {
      if (material instanceof THREE.Material) {
        disposeMaterial(material);
      }
    }
  }

  // Dispose render targets attached as userData
  if (object.userData?.renderTarget instanceof THREE.WebGLRenderTarget) {
    disposeRenderTarget(object.userData.renderTarget);
  }
}

/**
 * Dispose a material and all its textures.
 */
export function disposeMaterial(material: THREE.Material): void {
  // Collect all texture properties
  const mat = material as Record<string, unknown>;
  const texturePropertyNames = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'envMap',
    'lightMap',
    'displacementMap',
    'alphaMap',
    'bumpMap',
    'specularMap',
    'gradientMap',
    'matcap',
    'clearcoatMap',
    'clearcoatNormalMap',
    'clearcoatRoughnessMap',
    'sheenColorMap',
    'sheenRoughnessMap',
    'transmissionMap',
    'thicknessMap',
    'iridescenceMap',
    'iridescenceThicknessMap',
    'anisotropyMap',
  ];

  for (const propName of texturePropertyNames) {
    const texture = mat[propName];
    if (texture instanceof THREE.Texture) {
      texture.dispose();
    }
  }

  // For ShaderMaterial, dispose uniform textures
  if (material instanceof THREE.ShaderMaterial && material.uniforms) {
    for (const key of Object.keys(material.uniforms)) {
      const value = material.uniforms[key].value;
      if (value instanceof THREE.Texture) {
        value.dispose();
      }
      if (value instanceof THREE.WebGLRenderTarget) {
        disposeRenderTarget(value);
      }
    }
  }

  material.dispose();
}

/**
 * Dispose a render target and its textures.
 */
export function disposeRenderTarget(target: THREE.WebGLRenderTarget): void {
  target.texture.dispose();
  if (target.depthTexture) {
    target.depthTexture.dispose();
  }
  target.dispose();
}

/**
 * Dispose an array of render targets (e.g., ping-pong buffers).
 */
export function disposeRenderTargets(targets: THREE.WebGLRenderTarget[]): void {
  for (const target of targets) {
    disposeRenderTarget(target);
  }
}
```

### Compositor-Specific Dispose

```typescript
// lib/memory/compositorDispose.ts

import * as THREE from 'three';
import { disposeMaterial, disposeRenderTarget } from './dispose';

/**
 * When removing a layer from the compositor, dispose all its GPU resources.
 */
export function disposeCompositorLayer(layer: {
  material?: THREE.ShaderMaterial;
  renderTargets?: THREE.WebGLRenderTarget[];
  textures?: THREE.Texture[];
  mesh?: THREE.Mesh;
}): void {
  // 1. Dispose render targets first (they reference textures)
  if (layer.renderTargets) {
    for (const rt of layer.renderTargets) {
      disposeRenderTarget(rt);
    }
  }

  // 2. Dispose standalone textures (noise maps, LUTs, etc.)
  if (layer.textures) {
    for (const tex of layer.textures) {
      tex.dispose();
    }
  }

  // 3. Dispose material (also disposes its uniform textures)
  if (layer.material) {
    disposeMaterial(layer.material);
  }

  // 4. Dispose mesh geometry (usually a shared fullscreen quad, be careful)
  // Do NOT dispose shared geometry. Only dispose if this layer owns it.
  if (layer.mesh && layer.mesh.geometry) {
    // Check if it is a dedicated geometry (not shared)
    if (layer.mesh.userData?.ownsGeometry) {
      layer.mesh.geometry.dispose();
    }
  }
}

/**
 * When the entire compositor is destroyed, dispose everything.
 */
export function disposeCompositor(compositor: {
  layers: Array<{
    material?: THREE.ShaderMaterial;
    renderTargets?: THREE.WebGLRenderTarget[];
    textures?: THREE.Texture[];
    mesh?: THREE.Mesh;
  }>;
  sharedGeometry?: THREE.BufferGeometry;
  sharedRenderTargets?: THREE.WebGLRenderTarget[];
}): void {
  // Dispose all layers
  for (const layer of compositor.layers) {
    disposeCompositorLayer(layer);
  }

  // Dispose shared resources
  if (compositor.sharedGeometry) {
    compositor.sharedGeometry.dispose();
  }

  if (compositor.sharedRenderTargets) {
    for (const rt of compositor.sharedRenderTargets) {
      disposeRenderTarget(rt);
    }
  }
}
```

---

## Detecting Leaks via renderer.info

### renderer.info Memory Counters

Three.js tracks GPU resource counts via `renderer.info.memory`:

```typescript
renderer.info.memory.geometries  // Number of uploaded geometries
renderer.info.memory.textures    // Number of uploaded textures
renderer.info.programs           // Array of compiled shader programs (length = count)
```

These counters increment when resources are uploaded and decrement when disposed.
If they only go up, you have a leak.

### Leak Detector

```typescript
// lib/memory/leakDetector.ts

import * as THREE from 'three';

interface MemorySnapshot {
  timestamp: number;
  textures: number;
  geometries: number;
  programs: number;
}

export class LeakDetector {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly history: MemorySnapshot[] = [];
  private readonly maxHistory: number;
  private readonly checkIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly onLeakDetected: (report: LeakReport) => void;

  constructor(
    renderer: THREE.WebGLRenderer,
    options: {
      maxHistory?: number;
      checkIntervalMs?: number;
      onLeakDetected: (report: LeakReport) => void;
    }
  ) {
    this.renderer = renderer;
    this.maxHistory = options.maxHistory ?? 60; // ~1 minute at 1s intervals
    this.checkIntervalMs = options.checkIntervalMs ?? 1000;
    this.onLeakDetected = options.onLeakDetected;
  }

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.takeSnapshot();
      this.analyze();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private takeSnapshot(): void {
    const info = this.renderer.info;
    this.history.push({
      timestamp: Date.now(),
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
    });

    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  private analyze(): void {
    if (this.history.length < 10) return; // Need enough data

    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const durationSec = (last.timestamp - first.timestamp) / 1000;

    // Calculate growth rates
    const textureGrowth = last.textures - first.textures;
    const geometryGrowth = last.geometries - first.geometries;
    const programGrowth = last.programs - first.programs;

    // Detect monotonically increasing counters (strong leak signal)
    const textureMonotonic = this.isMonotonicallyIncreasing('textures');
    const geometryMonotonic = this.isMonotonicallyIncreasing('geometries');

    const leaks: string[] = [];

    if (textureGrowth > 5 && textureMonotonic) {
      leaks.push(
        `Texture leak: ${first.textures} -> ${last.textures} (+${textureGrowth}) over ${durationSec.toFixed(0)}s`
      );
    }

    if (geometryGrowth > 5 && geometryMonotonic) {
      leaks.push(
        `Geometry leak: ${first.geometries} -> ${last.geometries} (+${geometryGrowth}) over ${durationSec.toFixed(0)}s`
      );
    }

    if (programGrowth > 3) {
      leaks.push(
        `Shader program growth: ${first.programs} -> ${last.programs} (+${programGrowth}) -- possible recompilation storm`
      );
    }

    if (leaks.length > 0) {
      this.onLeakDetected({
        leaks,
        currentState: last,
        growthRate: {
          texturesPerMinute: (textureGrowth / durationSec) * 60,
          geometriesPerMinute: (geometryGrowth / durationSec) * 60,
        },
      });
    }
  }

  private isMonotonicallyIncreasing(
    field: 'textures' | 'geometries' | 'programs'
  ): boolean {
    // Check if the last N snapshots are non-decreasing
    const recent = this.history.slice(-10);
    for (let i = 1; i < recent.length; i++) {
      if (recent[i][field] < recent[i - 1][field]) {
        return false;
      }
    }
    return true;
  }

  getHistory(): MemorySnapshot[] {
    return [...this.history];
  }
}

interface LeakReport {
  leaks: string[];
  currentState: MemorySnapshot;
  growthRate: {
    texturesPerMinute: number;
    geometriesPerMinute: number;
  };
}
```

### React Integration

```tsx
// lib/memory/useLeakDetector.ts

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { LeakDetector } from './leakDetector';

export function useLeakDetector(enabled: boolean = true): void {
  const gl = useThree((s) => s.gl);
  const detectorRef = useRef<LeakDetector | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const detector = new LeakDetector(gl, {
      checkIntervalMs: 2000,
      maxHistory: 30,
      onLeakDetected: (report) => {
        console.warn('[LeakDetector] Potential memory leak detected:', report);

        // In production, report to Sentry
        if (process.env.NODE_ENV === 'production') {
          import('@sentry/nextjs').then((Sentry) => {
            Sentry.captureMessage('GPU memory leak detected', {
              level: 'warning',
              extra: {
                leaks: report.leaks,
                textures: report.currentState.textures,
                geometries: report.currentState.geometries,
                textureGrowthRate: report.growthRate.texturesPerMinute,
              },
            });
          });
        }
      },
    });

    detectorRef.current = detector;
    detector.start();

    return () => {
      detector.stop();
    };
  }, [gl, enabled]);
}
```

---

## Automated Leak Tests

### Add/Remove Layer Leak Test

```typescript
// __tests__/memory/layerLeak.test.ts

import * as THREE from 'three';

/**
 * Test that adding and removing layers does not leak GPU resources.
 *
 * Test procedure:
 * 1. Record baseline memory (textures, geometries, programs)
 * 2. Add N layers
 * 3. Remove all layers
 * 4. Verify memory returns to baseline
 * 5. Repeat M times to catch slow leaks
 */
describe('Layer Memory Leak Test', () => {
  let renderer: THREE.WebGLRenderer;

  beforeAll(() => {
    // Create an offscreen renderer for testing
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    renderer = new THREE.WebGLRenderer({ canvas });
  });

  afterAll(() => {
    renderer.dispose();
  });

  it('does not leak textures when adding and removing layers', () => {
    const cycles = 5;
    const layersPerCycle = 10;

    // Baseline
    const baseline = {
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
    };

    for (let cycle = 0; cycle < cycles; cycle++) {
      const materials: THREE.ShaderMaterial[] = [];
      const renderTargets: THREE.WebGLRenderTarget[] = [];

      // Add layers
      for (let i = 0; i < layersPerCycle; i++) {
        const rt = new THREE.WebGLRenderTarget(256, 256, {
          type: THREE.HalfFloatType,
        });
        const material = new THREE.ShaderMaterial({
          uniforms: {
            tInput: { value: rt.texture },
          },
          vertexShader: 'void main() { gl_Position = vec4(0); }',
          fragmentShader: 'void main() { gl_FragColor = vec4(1); }',
        });

        renderTargets.push(rt);
        materials.push(material);

        // Force GPU upload by rendering
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          material
        );
        scene.add(mesh);
        renderer.setRenderTarget(rt);
        renderer.render(scene, new THREE.OrthographicCamera());
        renderer.setRenderTarget(null);

        // Clean up scene objects (but keep material and RT)
        mesh.geometry.dispose();
        scene.remove(mesh);
      }

      // Remove all layers (dispose everything)
      for (const rt of renderTargets) {
        rt.texture.dispose();
        rt.dispose();
      }
      for (const mat of materials) {
        mat.dispose();
      }

      // Force cleanup
      renderer.info.reset();
    }

    // Check: memory should be back to baseline (or very close)
    const current = {
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
    };

    // Allow a small tolerance (some internal Three.js caching)
    expect(current.textures).toBeLessThanOrEqual(baseline.textures + 2);
    expect(current.geometries).toBeLessThanOrEqual(baseline.geometries + 2);
  });
});
```

### Playwright Memory Leak Test

```typescript
// e2e/memory-leak.spec.ts

import { test, expect } from '@playwright/test';

test('no memory leak after 20 add/remove cycles', async ({ page }) => {
  await page.goto('/editor');
  await page.waitForSelector('canvas');

  // Get baseline texture count
  const baseline = await page.evaluate(() => {
    // Access Three.js renderer via R3F internals
    const canvas = document.querySelector('canvas');
    // @ts-ignore -- accessing internal for testing
    const renderer = canvas?.__r3f?.store?.getState()?.gl;
    return renderer?.info.memory.textures ?? -1;
  });

  // Perform add/remove cycles
  for (let i = 0; i < 20; i++) {
    // Add a layer (click the "Add Effect" button)
    await page.click('[data-testid="add-effect-btn"]');
    await page.waitForTimeout(100);

    // Select "Bloom"
    await page.click('[data-testid="effect-bloom"]');
    await page.waitForTimeout(200);

    // Remove the layer
    await page.click('[data-testid="remove-layer-btn"]');
    await page.waitForTimeout(100);
  }

  // Wait for GC and disposal
  await page.waitForTimeout(1000);

  // Check texture count
  const afterCycles = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    // @ts-ignore
    const renderer = canvas?.__r3f?.store?.getState()?.gl;
    return renderer?.info.memory.textures ?? -1;
  });

  // Texture count should not have grown significantly
  expect(afterCycles).toBeLessThanOrEqual(baseline + 5);
});
```

---

## WeakRef and FinalizationRegistry Safety Nets

### The Problem

Even with careful dispose() calls, resources can leak if:
- An exception interrupts the cleanup flow
- A component unmounts before cleanup runs
- A reference is held in a closure or event listener

### WeakRef for Texture References

```typescript
// lib/memory/weakTexture.ts

/**
 * Hold a weak reference to a texture so that if the owner component
 * is garbage collected without calling dispose(), we can detect it
 * and warn (or clean up).
 */

// Registry of textures that should be disposed
const textureRegistry = new FinalizationRegistry<{
  name: string;
  dispose: () => void;
}>((heldValue) => {
  console.warn(
    `[MemoryGuard] Texture "${heldValue.name}" was garbage collected ` +
    `WITHOUT being disposed. GPU memory was leaked. ` +
    `The texture has been disposed via FinalizationRegistry.`
  );

  // Attempt late disposal
  try {
    heldValue.dispose();
  } catch {
    // Already disposed or context lost -- safe to ignore
  }
});

/**
 * Register a texture for leak detection.
 * If the owner object is GC'd without calling texture.dispose(),
 * the FinalizationRegistry will log a warning and attempt cleanup.
 *
 * @param owner - The owning object (component instance, layer, etc.)
 * @param texture - The Three.js texture to monitor
 * @param name - A descriptive name for debugging
 */
export function registerTextureForLeakDetection(
  owner: object,
  texture: THREE.Texture,
  name: string
): void {
  const disposeRef = new WeakRef(texture);

  textureRegistry.register(owner, {
    name,
    dispose: () => {
      const tex = disposeRef.deref();
      if (tex) {
        tex.dispose();
      }
    },
  });
}

/**
 * Unregister when the texture is properly disposed.
 * This prevents the FinalizationRegistry from warning about
 * textures that were correctly cleaned up.
 */
export function unregisterTexture(owner: object): void {
  textureRegistry.unregister(owner);
}
```

### WeakRef for Render Target Pool

```typescript
// lib/memory/weakRTPool.ts

import * as THREE from 'three';

/**
 * A pool of render targets that uses WeakRef to allow GC
 * if the consumer forgets to return the target to the pool.
 */
export class WeakRenderTargetPool {
  private readonly available: THREE.WebGLRenderTarget[] = [];
  private readonly inUse: Map<string, WeakRef<THREE.WebGLRenderTarget>> = new Map();
  private readonly width: number;
  private readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  acquire(label: string): THREE.WebGLRenderTarget {
    let rt = this.available.pop();
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
    }
    this.inUse.set(label, new WeakRef(rt));
    return rt;
  }

  release(label: string, rt: THREE.WebGLRenderTarget): void {
    this.inUse.delete(label);
    this.available.push(rt);
  }

  /**
   * Check for leaked render targets (WeakRef deref returns undefined
   * when the target has been GC'd without being returned to the pool).
   */
  checkForLeaks(): string[] {
    const leaks: string[] = [];
    for (const [label, ref] of this.inUse) {
      if (ref.deref() === undefined) {
        leaks.push(label);
        this.inUse.delete(label);
      }
    }
    return leaks;
  }

  dispose(): void {
    for (const rt of this.available) {
      rt.texture.dispose();
      rt.dispose();
    }
    this.available.length = 0;
    this.inUse.clear();
  }
}
```

---

## Garbage Collection and GPU Resources

### The Fundamental Disconnect

JavaScript GC and GPU resources operate independently:
- JS GC frees heap memory when objects have no references
- GPU resources (textures, buffers, programs) live in VRAM
- A JS object referencing a GPU resource can be GC'd, but the VRAM is NOT freed
- Only explicit `.dispose()` frees VRAM

### GC Pressure from Frame Allocation

```typescript
// BAD: Creates garbage every frame
function renderFrame() {
  const tempVec = new THREE.Vector3(1, 2, 3); // Allocates on heap
  const tempColor = new THREE.Color(0xff0000);  // Allocates on heap
  // ... use them ...
  // They become garbage after this function returns
}
// 60 FPS x 2 allocations = 120 objects/second for GC to collect

// GOOD: Pre-allocate and reuse
const _tempVec = new THREE.Vector3();
const _tempColor = new THREE.Color();

function renderFrame() {
  _tempVec.set(1, 2, 3);   // Mutates existing object, no allocation
  _tempColor.set(0xff0000); // Mutates existing object, no allocation
}
```

### Reducing GC Pauses in the Render Loop

```typescript
// lib/memory/gcFriendly.ts

/**
 * Pre-allocated objects for use in hot paths (render loop, useFrame).
 * NEVER allocate inside useFrame. Use these shared instances instead.
 *
 * These are module-level singletons. They are safe for single-threaded
 * browser JS but NOT safe across Web Workers.
 */
export const shared = {
  vec2: new THREE.Vector2(),
  vec3: new THREE.Vector3(),
  vec4: new THREE.Vector4(),
  color: new THREE.Color(),
  matrix4: new THREE.Matrix4(),
  quaternion: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  plane: new THREE.Plane(),
  ray: new THREE.Ray(),
  box3: new THREE.Box3(),
  sphere: new THREE.Sphere(),
} as const;

/**
 * Object pool for frequently created/destroyed objects.
 * Use for things like particle data, temporary mesh instances, etc.
 */
export class ObjectPool<T> {
  private readonly pool: T[] = [];
  private readonly factory: () => T;
  private readonly reset: (obj: T) => void;

  constructor(factory: () => T, reset: (obj: T) => void, preAllocate: number = 0) {
    this.factory = factory;
    this.reset = reset;

    for (let i = 0; i < preAllocate; i++) {
      this.pool.push(factory());
    }
  }

  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.factory();
  }

  release(obj: T): void {
    this.reset(obj);
    this.pool.push(obj);
  }

  get size(): number {
    return this.pool.length;
  }
}
```

---

## FBO Pool Management

### Render Target Pool

```typescript
// lib/memory/renderTargetPool.ts

import * as THREE from 'three';

interface PoolKey {
  width: number;
  height: number;
  type: number; // THREE.HalfFloatType, etc.
  depthBuffer: boolean;
}

function poolKeyToString(key: PoolKey): string {
  return `${key.width}x${key.height}_t${key.type}_d${key.depthBuffer ? 1 : 0}`;
}

/**
 * Pool of WebGLRenderTargets to avoid repeated creation/destruction.
 * Each layer acquires a target at the start of its pass and releases
 * it at the end. Targets are reused across frames.
 */
export class RenderTargetPool {
  private readonly pools: Map<string, THREE.WebGLRenderTarget[]> = new Map();
  private readonly inUse: Set<THREE.WebGLRenderTarget> = new Set();
  private totalCreated: number = 0;
  private totalReused: number = 0;

  acquire(
    width: number,
    height: number,
    type: number = THREE.HalfFloatType,
    depthBuffer: boolean = false
  ): THREE.WebGLRenderTarget {
    const key = poolKeyToString({ width, height, type, depthBuffer });
    const pool = this.pools.get(key);

    if (pool && pool.length > 0) {
      const rt = pool.pop()!;
      this.inUse.add(rt);
      this.totalReused += 1;
      return rt;
    }

    // Create new
    const rt = new THREE.WebGLRenderTarget(width, height, {
      type,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer,
      stencilBuffer: false,
    });

    this.inUse.add(rt);
    this.totalCreated += 1;
    return rt;
  }

  release(rt: THREE.WebGLRenderTarget): void {
    if (!this.inUse.has(rt)) {
      console.warn('[RenderTargetPool] Releasing a target not tracked as in-use');
      return;
    }

    this.inUse.delete(rt);

    const key = poolKeyToString({
      width: rt.width,
      height: rt.height,
      type: (rt.texture as any).type,
      depthBuffer: rt.depthBuffer,
    });

    if (!this.pools.has(key)) {
      this.pools.set(key, []);
    }
    this.pools.get(key)!.push(rt);
  }

  /**
   * Resize all pooled targets. Called when canvas size changes.
   * Disposes all pooled targets and lets them be re-created at new size.
   */
  resize(): void {
    for (const pool of this.pools.values()) {
      for (const rt of pool) {
        rt.texture.dispose();
        rt.dispose();
      }
    }
    this.pools.clear();
    // Do NOT dispose in-use targets. They will be released and discarded
    // on the next frame when the compositor realizes the size changed.
  }

  /**
   * Trim the pool to free unused targets.
   * Call periodically (e.g., every 30 seconds) to prevent pool bloat.
   */
  trim(maxPerSize: number = 2): void {
    for (const [key, pool] of this.pools) {
      while (pool.length > maxPerSize) {
        const rt = pool.pop()!;
        rt.texture.dispose();
        rt.dispose();
      }
      if (pool.length === 0) {
        this.pools.delete(key);
      }
    }
  }

  getStats(): {
    pooled: number;
    inUse: number;
    totalCreated: number;
    totalReused: number;
    reuseRate: number;
  } {
    let pooled = 0;
    for (const pool of this.pools.values()) {
      pooled += pool.length;
    }

    const totalAcquisitions = this.totalCreated + this.totalReused;
    return {
      pooled,
      inUse: this.inUse.size,
      totalCreated: this.totalCreated,
      totalReused: this.totalReused,
      reuseRate: totalAcquisitions > 0 ? this.totalReused / totalAcquisitions : 0,
    };
  }

  dispose(): void {
    // Dispose pooled targets
    for (const pool of this.pools.values()) {
      for (const rt of pool) {
        rt.texture.dispose();
        rt.dispose();
      }
    }
    this.pools.clear();

    // Dispose in-use targets (force cleanup)
    for (const rt of this.inUse) {
      rt.texture.dispose();
      rt.dispose();
    }
    this.inUse.clear();
  }
}
```

---

## Texture Memory Optimization

### Texture Format Selection

```typescript
// lib/memory/textureOptimization.ts

/**
 * Choose the smallest texture format that satisfies the use case.
 * RGBA16F is the default for render targets but is overkill for many uses.
 */
export function recommendTextureFormat(
  usage: 'colorBuffer' | 'depthBuffer' | 'noiseLUT' | 'dataTexture' | 'normalMap'
): {
  type: number;
  format: number;
  internalFormat: string;
  bytesPerPixel: number;
} {
  switch (usage) {
    case 'colorBuffer':
      // RGBA16F for HDR compositing
      return {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        internalFormat: 'RGBA16F',
        bytesPerPixel: 8,
      };

    case 'depthBuffer':
      // DEPTH_COMPONENT32F
      return {
        type: THREE.FloatType,
        format: THREE.DepthFormat,
        internalFormat: 'DEPTH_COMPONENT32F',
        bytesPerPixel: 4,
      };

    case 'noiseLUT':
      // R8 is enough for single-channel noise
      return {
        type: THREE.UnsignedByteType,
        format: THREE.RedFormat,
        internalFormat: 'R8',
        bytesPerPixel: 1,
      };

    case 'dataTexture':
      // RG16F for 2-channel data (e.g., velocity field)
      return {
        type: THREE.HalfFloatType,
        format: THREE.RGFormat,
        internalFormat: 'RG16F',
        bytesPerPixel: 4,
      };

    case 'normalMap':
      // RG8 is enough for normal maps (reconstruct Z)
      return {
        type: THREE.UnsignedByteType,
        format: THREE.RGFormat,
        internalFormat: 'RG8',
        bytesPerPixel: 2,
      };
  }
}
```

### Mipmap Strategy

```
Use Case                Mipmaps?    Why
---                     ---         ---
Render target (FBO)     NO          Never sampled at reduced size
Fullscreen pass input   NO          Always sampled at 1:1 ratio
Noise texture           YES         May be sampled at varying scales
Scene texture           YES         Standard 3D rendering needs them
UI texture              NO          Fixed-size display
LUT (lookup table)      NO          Indexed access, not filtered
```

---

## Production Memory Monitoring

### Periodic Memory Reporting

```typescript
// lib/memory/memoryReporter.ts

import * as THREE from 'three';

interface MemoryReport {
  timestamp: number;
  gpu: {
    textures: number;
    geometries: number;
    programs: number;
  };
  js: {
    usedJSHeapSize: number | null;
    totalJSHeapSize: number | null;
    jsHeapSizeLimit: number | null;
  };
  estimated: {
    vramMB: number;
  };
  layers: number;
}

export function collectMemoryReport(
  renderer: THREE.WebGLRenderer,
  layerCount: number,
  estimatedVRAMBytes: number
): MemoryReport {
  const memory = (performance as any).memory;

  return {
    timestamp: Date.now(),
    gpu: {
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
      programs: renderer.info.programs?.length ?? 0,
    },
    js: {
      usedJSHeapSize: memory?.usedJSHeapSize ?? null,
      totalJSHeapSize: memory?.totalJSHeapSize ?? null,
      jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
    },
    estimated: {
      vramMB: estimatedVRAMBytes / (1024 * 1024),
    },
    layers: layerCount,
  };
}

/**
 * Send memory reports periodically in production.
 * Sample 1% of sessions to avoid overwhelming the backend.
 */
export function startMemoryReporting(
  renderer: THREE.WebGLRenderer,
  getLayerCount: () => number,
  getEstimatedVRAM: () => number,
  intervalMs: number = 30000
): () => void {
  // Sample 1% of sessions
  if (Math.random() > 0.01) {
    return () => {};
  }

  const id = setInterval(() => {
    const report = collectMemoryReport(
      renderer,
      getLayerCount(),
      getEstimatedVRAM()
    );

    if (typeof navigator?.sendBeacon === 'function') {
      navigator.sendBeacon(
        '/api/telemetry/memory',
        JSON.stringify(report)
      );
    }
  }, intervalMs);

  return () => clearInterval(id);
}
```
