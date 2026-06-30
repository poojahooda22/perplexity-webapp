# WebGL Context Management

> Production-tested patterns for handling WebGL context lifecycle, loss, restoration, and resource management in Three.js and R3F applications.

## Table of Contents

1. [Context Loss: Causes and Mechanics](#context-loss-causes-and-mechanics)
2. [Context Loss Event Handling](#context-loss-event-handling)
3. [Resource Re-creation Protocol](#resource-re-creation-protocol)
4. [Three.js Context Management](#threejs-context-management)
5. [R3F Context Integration](#r3f-context-integration)
6. [Prevention Strategies](#prevention-strategies)
7. [Testing Context Loss](#testing-context-loss)
8. [Recovery Time Budget](#recovery-time-budget)
9. [Multi-Tab Context Management](#multi-tab-context-management)
10. [Production Monitoring](#production-monitoring)

---

## Context Loss: Causes and Mechanics

### What Happens During Context Loss

When a WebGL context is lost, ALL GPU resources are destroyed instantly:
- All textures become invalid
- All framebuffer objects are destroyed
- All shader programs are deleted
- All buffer objects (VBOs, IBOs) are gone
- All renderbuffer objects are destroyed
- All uniform locations become invalid

The browser does this because the GPU itself has been reset. There is no way to
"save" GPU resources across a context loss event. Everything must be re-created
from scratch.

### Causes of Context Loss

#### 1. GPU Driver Crash or Reset

The most common cause in production. The GPU driver encounters an error and resets.
Windows has a Timeout Detection and Recovery (TDR) mechanism that resets the GPU
if a shader takes too long (default: 2 seconds).

```
Frequency: ~0.1-0.5% of sessions on desktop, higher on older hardware
Detection: webglcontextlost fires
Recovery:  Usually automatic (webglcontextrestored fires after 100-500ms)
```

#### 2. Too Many Active Contexts

Browsers limit the number of simultaneous WebGL contexts. When the limit is reached,
the oldest context is killed to make room.

```
Chrome:  ~16 contexts per browser process
Firefox: ~16 contexts
Safari:  ~8 contexts
Edge:    ~16 contexts (Chromium)

Note: Each <canvas> with a WebGL context counts as one.
      Iframes with canvases also count.
      Hidden/background canvases still count.
```

#### 3. System Sleep / Resume

When a laptop sleeps or a phone screen locks, the GPU is powered down.
On resume, all contexts are lost.

```
Frequency: Nearly 100% on mobile, ~80% on laptop
Detection: webglcontextlost fires on resume
Recovery:  Usually automatic after 500-2000ms
Platform:  macOS is more reliable than Windows for recovery
```

#### 4. Background Tab Throttling

Modern browsers aggressively throttle and may kill GPU resources in background tabs.

```
Chrome:  Freezes requestAnimationFrame, may lose context after ~5 minutes
Firefox: Similar behavior
Safari:  Very aggressive, context loss within ~30 seconds of backgrounding
```

#### 5. GPU Memory Pressure

When combined VRAM usage across all processes exceeds available GPU memory,
the browser may lose contexts to free resources.

```
Cause:    Multiple tabs with WebGL, gaming, video playback, large textures
Detection: webglcontextlost fires, sometimes preceded by gl.OUT_OF_MEMORY
Recovery:  May not auto-restore if memory pressure persists
```

#### 6. User-Initiated (DevTools)

Chrome DevTools > Application > WebGL context loss simulation.
Useful for testing but not a production concern.

#### 7. Browser Updates

Some browser updates reset the GPU process, causing context loss in all tabs.

---

## Context Loss Event Handling

### The Two Critical Events

```typescript
// lib/webgl/contextManager.ts

export interface ContextManagerOptions {
  canvas: HTMLCanvasElement;
  onLost: () => void;
  onRestored: () => void;
  onPermanentLoss: () => void;
  maxRestoreWaitMs?: number;
}

export function createContextManager(options: ContextManagerOptions) {
  const {
    canvas,
    onLost,
    onRestored,
    onPermanentLoss,
    maxRestoreWaitMs = 5000,
  } = options;

  let isContextLost = false;
  let restoreTimeoutId: ReturnType<typeof setTimeout> | null = null;

  function handleContextLost(event: Event): void {
    // CRITICAL: Must call preventDefault to allow context restoration.
    // Without this, the browser will NOT attempt to restore the context.
    event.preventDefault();

    isContextLost = true;
    console.warn('[ContextManager] WebGL context lost');

    // Stop the render loop immediately
    onLost();

    // Set a timeout for permanent loss (context may never restore)
    restoreTimeoutId = setTimeout(() => {
      console.error(
        `[ContextManager] Context not restored after ${maxRestoreWaitMs}ms`
      );
      onPermanentLoss();
    }, maxRestoreWaitMs);
  }

  function handleContextRestored(): void {
    isContextLost = false;

    if (restoreTimeoutId !== null) {
      clearTimeout(restoreTimeoutId);
      restoreTimeoutId = null;
    }

    console.info('[ContextManager] WebGL context restored');
    onRestored();
  }

  // Attach listeners
  canvas.addEventListener('webglcontextlost', handleContextLost, false);
  canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

  // Return cleanup function
  return {
    isContextLost: () => isContextLost,
    dispose: () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      if (restoreTimeoutId !== null) {
        clearTimeout(restoreTimeoutId);
      }
    },
  };
}
```

### React Hook for Context Loss

```tsx
// lib/webgl/useContextLoss.ts

import { useCallback, useEffect, useRef, useState } from 'react';

interface ContextLossState {
  isLost: boolean;
  lossCount: number;
  lastLostAt: number | null;
  lastRestoredAt: number | null;
}

export function useContextLoss(
  canvasRef: React.RefObject<HTMLCanvasElement | null>
) {
  const [state, setState] = useState<ContextLossState>({
    isLost: false,
    lossCount: 0,
    lastLostAt: null,
    lastRestoredAt: null,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleLost = (e: Event) => {
      e.preventDefault();
      const now = Date.now();
      setState((prev) => ({
        isLost: true,
        lossCount: prev.lossCount + 1,
        lastLostAt: now,
        lastRestoredAt: prev.lastRestoredAt,
      }));
    };

    const handleRestored = () => {
      setState((prev) => ({
        ...prev,
        isLost: false,
        lastRestoredAt: Date.now(),
      }));
    };

    canvas.addEventListener('webglcontextlost', handleLost, false);
    canvas.addEventListener('webglcontextrestored', handleRestored, false);

    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost);
      canvas.removeEventListener('webglcontextrestored', handleRestored);
    };
  }, [canvasRef]);

  return state;
}
```

### The preventDefault() Rule

This is the single most important thing about context loss handling:

```typescript
// WRONG: Context will NEVER be restored
canvas.addEventListener('webglcontextlost', (e) => {
  console.log('Lost!');
  // Not calling e.preventDefault() means the browser gives up
});

// RIGHT: Context will be restored when possible
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); // Tell browser: "We want it back"
  console.log('Lost, waiting for restore...');
});
```

The spec says: "If the event's canceled flag is not set, the context will NOT
be restored." This is one of the rare cases in the DOM where `preventDefault()`
enables behavior rather than preventing it.

---

## Resource Re-creation Protocol

### What Must Be Re-created

After context restoration, ALL GPU resources must be re-created. The WebGL state
machine is reset to its initial state. Here is the complete list:

```
1. WebGLTexture        - All textures (2D, cube, array, 3D)
2. WebGLFramebuffer    - All FBOs / render targets
3. WebGLRenderbuffer   - All renderbuffers (depth, stencil)
4. WebGLProgram        - All shader programs
5. WebGLShader         - All vertex and fragment shaders
6. WebGLBuffer         - All vertex buffers and index buffers
7. WebGLVertexArray    - All VAOs (WebGL2)
8. WebGLSampler        - All sampler objects (WebGL2)
9. WebGLTransformFeedback - All transform feedback objects (WebGL2)
10. WebGLQuery         - All query objects (WebGL2)
11. WebGLSync          - All sync objects (WebGL2)

State that resets:
- Viewport
- Scissor rect
- Blend state
- Depth state
- Stencil state
- All uniform values
- All texture bindings
- Active texture unit
- Current program
- Bound buffers
```

### Re-creation Order

Resources have dependencies. Re-create in this order:

```
1. Shaders         (no dependencies)
2. Programs        (depends on shaders)
3. Buffers         (no dependencies)
4. VAOs            (depends on buffers and programs)
5. Textures        (no dependencies)
6. Renderbuffers   (no dependencies)
7. Framebuffers    (depends on textures and renderbuffers)
8. Samplers        (no dependencies)
9. Set state       (viewport, blend, depth, etc.)
```

### Three.js Re-creation

Three.js handles most resource re-creation automatically when you re-render,
but there are gotchas.

```typescript
// lib/webgl/threeContextRestore.ts

import * as THREE from 'three';

/**
 * Force Three.js to re-upload all GPU resources after context restoration.
 * Three.js tracks uploaded state per object. After context loss, the tracking
 * data is stale (references destroyed GPU objects). We must invalidate it.
 */
export function invalidateThreeResources(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene
): void {
  // 1. Invalidate all textures
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const material = object.material;
      if (Array.isArray(material)) {
        material.forEach(invalidateMaterial);
      } else {
        invalidateMaterial(material);
      }
    }
  });

  // 2. Invalidate render targets
  // Three.js WebGLRenderTarget stores a reference to the GL framebuffer.
  // After context loss, that reference is invalid.
  // The renderer's internal WebGLTextures/WebGLRenderStates need reset.

  // 3. Force renderer internal state reset
  // renderer.state is internal but critical
  const info = renderer.info;
  info.reset();

  // 4. Force all programs to recompile
  // This happens automatically on next render when Three.js detects
  // the program reference is invalid.
}

function invalidateMaterial(material: THREE.Material): void {
  // Mark material as needing update
  material.needsUpdate = true;

  // Invalidate all texture properties
  const mat = material as any;
  const textureProps = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap',
    'aoMap', 'emissiveMap', 'envMap', 'lightMap',
    'displacementMap', 'alphaMap', 'bumpMap',
  ];

  for (const prop of textureProps) {
    if (mat[prop] instanceof THREE.Texture) {
      mat[prop].needsUpdate = true;
    }
  }
}
```

### Custom ShaderMaterial Re-creation

ShaderMaterials with custom uniforms need special handling:

```typescript
// lib/webgl/shaderMaterialRestore.ts

import * as THREE from 'three';

/**
 * After context loss, ShaderMaterial uniform values are preserved in JS
 * but the GL uniform locations are invalid. Setting needsUpdate = true
 * forces Three.js to re-link the program and re-upload uniforms.
 */
export function restoreShaderMaterial(material: THREE.ShaderMaterial): void {
  // Force program re-compilation
  material.needsUpdate = true;

  // Re-mark all texture uniforms for upload
  if (material.uniforms) {
    for (const key of Object.keys(material.uniforms)) {
      const uniform = material.uniforms[key];
      if (uniform.value instanceof THREE.Texture) {
        uniform.value.needsUpdate = true;
      }
      if (uniform.value instanceof THREE.WebGLRenderTarget) {
        uniform.value.texture.needsUpdate = true;
        if (uniform.value.depthTexture) {
          uniform.value.depthTexture.needsUpdate = true;
        }
      }
    }
  }
}

/**
 * Restore all shader materials in a scene after context loss.
 */
export function restoreAllShaderMaterials(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];

      for (const mat of materials) {
        if (mat instanceof THREE.ShaderMaterial) {
          restoreShaderMaterial(mat);
        } else {
          mat.needsUpdate = true;
        }
      }
    }
  });
}
```

### FBO / Render Target Re-creation

```typescript
// lib/webgl/renderTargetRestore.ts

import * as THREE from 'three';

/**
 * WebGLRenderTarget stores GL framebuffer/texture references internally.
 * After context loss, these are invalid. Three.js will re-create them
 * on next use, but we need to ensure the texture data is re-uploaded.
 *
 * For render targets that are rendered-to (FBOs), this is automatic:
 * the next render pass writes new data.
 *
 * For render targets initialized with data (e.g., lookup tables),
 * we must re-upload the source data.
 */
export function restoreRenderTarget(target: THREE.WebGLRenderTarget): void {
  // Mark texture for re-upload
  target.texture.needsUpdate = true;

  // If there is a depth texture, mark it too
  if (target.depthTexture) {
    target.depthTexture.needsUpdate = true;
  }
}

/**
 * For compositor-style apps with multiple FBOs (ping-pong buffers, etc.),
 * restore all of them.
 */
export function restoreRenderTargetPool(
  targets: THREE.WebGLRenderTarget[]
): void {
  for (const target of targets) {
    restoreRenderTarget(target);
  }
}
```

---

## Three.js Context Management

### Renderer Lifecycle

```typescript
// lib/webgl/rendererLifecycle.ts

import * as THREE from 'three';

interface RendererConfig {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pixelRatio: number;
  powerPreference: 'high-performance' | 'low-power' | 'default';
}

/**
 * Create a Three.js renderer with production-safe defaults.
 */
export function createRenderer(config: RendererConfig): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: config.canvas,
    antialias: false,        // Post-process AA instead (FXAA/SMAA)
    alpha: false,            // Opaque background, better performance
    stencil: false,          // Disable if not using stencil ops
    depth: true,             // Usually needed
    powerPreference: config.powerPreference,
    preserveDrawingBuffer: false, // Better perf, disable for screenshots
    failIfMajorPerformanceCaveat: false, // Do not fail, degrade instead
  });

  renderer.setSize(config.width, config.height, false);
  renderer.setPixelRatio(config.pixelRatio);

  // Output encoding
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Tone mapping
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  return renderer;
}

/**
 * Properly dispose a Three.js renderer.
 * MUST be called before removing the canvas from the DOM.
 */
export function disposeRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.dispose();
  // renderer.forceContextLoss() is NOT needed during normal cleanup.
  // dispose() handles it. forceContextLoss() is for testing only.
}
```

### ForceContextLoss and ForceContextRestore (Testing Only)

```typescript
// lib/webgl/contextTesting.ts

import * as THREE from 'three';

/**
 * Simulate context loss for testing recovery.
 * DO NOT use in production code.
 */
export function simulateContextLoss(renderer: THREE.WebGLRenderer): void {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext) {
    ext.loseContext();
  } else {
    console.warn('WEBGL_lose_context extension not available');
  }
}

/**
 * Simulate context restoration for testing recovery.
 * Must be called after simulateContextLoss().
 */
export function simulateContextRestore(renderer: THREE.WebGLRenderer): void {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext) {
    ext.restoreContext();
  }
}

/**
 * Full context loss/restore cycle for testing.
 * Returns a promise that resolves when restoration is complete.
 */
export function testContextLossCycle(
  renderer: THREE.WebGLRenderer,
  restoreDelayMs: number = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const canvas = renderer.domElement;
    const timeout = setTimeout(() => {
      reject(new Error('Context restore timed out'));
    }, 5000);

    canvas.addEventListener(
      'webglcontextrestored',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );

    simulateContextLoss(renderer);

    setTimeout(() => {
      simulateContextRestore(renderer);
    }, restoreDelayMs);
  });
}
```

### Renderer.info for Context Health

```typescript
// lib/webgl/contextHealth.ts

import * as THREE from 'three';

interface ContextHealthSnapshot {
  timestamp: number;
  programs: number;
  geometries: number;
  textures: number;
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  frame: number;
}

/**
 * Capture a snapshot of renderer resource usage.
 * Compare snapshots over time to detect leaks or context issues.
 */
export function captureHealthSnapshot(
  renderer: THREE.WebGLRenderer
): ContextHealthSnapshot {
  const info = renderer.info;
  return {
    timestamp: Date.now(),
    programs: info.programs?.length ?? 0,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    calls: info.render.calls,
    triangles: info.render.triangles,
    points: info.render.points,
    lines: info.render.lines,
    frame: info.render.frame,
  };
}

/**
 * Compare two snapshots to detect anomalies.
 */
export function compareSnapshots(
  before: ContextHealthSnapshot,
  after: ContextHealthSnapshot
): { leaks: string[]; warnings: string[] } {
  const leaks: string[] = [];
  const warnings: string[] = [];

  const textureDelta = after.textures - before.textures;
  const geometryDelta = after.geometries - before.geometries;
  const programDelta = after.programs - before.programs;

  if (textureDelta > 10) {
    leaks.push(`Texture count grew by ${textureDelta} (${before.textures} -> ${after.textures})`);
  }
  if (geometryDelta > 10) {
    leaks.push(`Geometry count grew by ${geometryDelta}`);
  }
  if (programDelta > 5) {
    warnings.push(`Program count grew by ${programDelta} -- possible shader recompilation storm`);
  }
  if (after.calls > 1000) {
    warnings.push(`Draw calls per frame: ${after.calls} -- consider instancing or batching`);
  }

  return { leaks, warnings };
}
```

---

## R3F Context Integration

### Canvas onCreated Hook

```tsx
// R3F provides access to the renderer via onCreated callback

import { Canvas } from '@react-three/fiber';
import { createContextManager } from '@/lib/webgl/contextManager';

function WebGLApp() {
  const [canvasKey, setCanvasKey] = useState(0);
  const contextManagerRef = useRef<ReturnType<typeof createContextManager>>();

  const handleCreated = useCallback((state: any) => {
    const canvas = state.gl.domElement;

    // Dispose previous context manager if re-mounting
    contextManagerRef.current?.dispose();

    contextManagerRef.current = createContextManager({
      canvas,
      onLost: () => {
        console.warn('Context lost -- stopping render loop');
        // R3F continues to call useFrame hooks. We need to guard them.
        state.set({ frameloop: 'never' });
      },
      onRestored: () => {
        console.info('Context restored -- re-mounting canvas');
        setCanvasKey((k) => k + 1);
      },
      onPermanentLoss: () => {
        console.error('Context permanently lost');
        // Show fallback UI
      },
      maxRestoreWaitMs: 5000,
    });
  }, []);

  useEffect(() => {
    return () => {
      contextManagerRef.current?.dispose();
    };
  }, []);

  return (
    <Canvas
      key={canvasKey}
      onCreated={handleCreated}
      frameloop="always"
      gl={{
        powerPreference: 'high-performance',
        antialias: false,
        alpha: false,
        stencil: false,
      }}
    >
      <Scene />
    </Canvas>
  );
}
```

### Guard useFrame During Context Loss

```tsx
// lib/webgl/useGuardedFrame.ts

import { useFrame, useThree } from '@react-three/fiber';

/**
 * A useFrame wrapper that skips execution during context loss.
 * Prevents "WebGL object already deleted" errors in frame callbacks.
 */
export function useGuardedFrame(
  callback: (state: any, delta: number) => void,
  priority?: number
): void {
  const gl = useThree((s) => s.gl);

  useFrame((state, delta) => {
    // Check if context is still valid
    const context = gl.getContext();
    if (context.isContextLost()) {
      return; // Skip this frame
    }
    callback(state, delta);
  }, priority);
}
```

### Dispose Pattern for R3F Components

```tsx
// lib/webgl/useDisposable.ts

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * Hook that ensures GPU resources are disposed when the component unmounts.
 * Critical for preventing context count exhaustion.
 */
export function useDisposable<T extends { dispose: () => void }>(
  factory: () => T,
  deps: unknown[]
): T {
  const ref = useRef<T | null>(null);

  // Dispose previous on dependency change
  useEffect(() => {
    return () => {
      ref.current?.dispose();
      ref.current = null;
    };
  }, deps);

  if (ref.current === null) {
    ref.current = factory();
  }

  return ref.current;
}

/**
 * Deep dispose helper for Three.js objects.
 * Disposes geometry, material, textures, and children recursively.
 */
export function deepDispose(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (child.geometry) {
        child.geometry.dispose();
      }

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      for (const material of materials) {
        disposeMaterial(material);
      }
    }
  });

  // Remove from parent
  if (object.parent) {
    object.parent.remove(object);
  }
}

function disposeMaterial(material: THREE.Material): void {
  // Dispose all texture properties
  const mat = material as any;
  const textureKeys = Object.keys(mat).filter(
    (key) => mat[key] instanceof THREE.Texture
  );
  for (const key of textureKeys) {
    mat[key].dispose();
  }
  material.dispose();
}
```

---

## Prevention Strategies

### Limit Context Count

```typescript
// lib/webgl/contextLimiter.ts

/**
 * Track active WebGL contexts to prevent exceeding browser limits.
 * Browser limit is typically 8-16 contexts.
 * We set a safe limit of 4 to leave room for other tabs/iframes.
 */
const SAFE_CONTEXT_LIMIT = 4;
const activeContexts = new Set<HTMLCanvasElement>();

export function canCreateContext(): boolean {
  return activeContexts.size < SAFE_CONTEXT_LIMIT;
}

export function registerContext(canvas: HTMLCanvasElement): void {
  activeContexts.add(canvas);
  if (activeContexts.size > SAFE_CONTEXT_LIMIT) {
    console.warn(
      `[ContextLimiter] ${activeContexts.size} active contexts exceeds safe limit of ${SAFE_CONTEXT_LIMIT}`
    );
  }
}

export function unregisterContext(canvas: HTMLCanvasElement): void {
  activeContexts.delete(canvas);
}

export function getActiveContextCount(): number {
  return activeContexts.size;
}
```

### Dispose Unused Resources Proactively

```typescript
// lib/webgl/resourceBudget.ts

import * as THREE from 'three';

/**
 * Enforce a texture budget. When adding a new texture that exceeds the budget,
 * dispose the least recently used textures first.
 */
export class TextureBudget {
  private readonly maxTextures: number;
  private readonly textures: Map<string, { texture: THREE.Texture; lastUsed: number }>;

  constructor(maxTextures: number = 64) {
    this.maxTextures = maxTextures;
    this.textures = new Map();
  }

  add(key: string, texture: THREE.Texture): void {
    // Evict if over budget
    while (this.textures.size >= this.maxTextures) {
      this.evictOldest();
    }

    this.textures.set(key, { texture, lastUsed: Date.now() });
  }

  get(key: string): THREE.Texture | null {
    const entry = this.textures.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.texture;
    }
    return null;
  }

  remove(key: string): void {
    const entry = this.textures.get(key);
    if (entry) {
      entry.texture.dispose();
      this.textures.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.textures) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.remove(oldestKey);
    }
  }

  dispose(): void {
    for (const [, entry] of this.textures) {
      entry.texture.dispose();
    }
    this.textures.clear();
  }
}
```

### Visibility API Integration

Stop rendering when the tab is not visible. This reduces GPU pressure and
prevents context loss from background throttling.

```typescript
// lib/webgl/visibilityManager.ts

export function createVisibilityManager(
  onVisible: () => void,
  onHidden: () => void
): { dispose: () => void } {
  function handleVisibilityChange(): void {
    if (document.hidden) {
      onHidden();
    } else {
      onVisible();
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    dispose: () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
  };
}

// Usage with R3F
function useVisibilityFrameloop() {
  const set = useThree((s) => s.set);

  useEffect(() => {
    const manager = createVisibilityManager(
      () => set({ frameloop: 'always' }),
      () => set({ frameloop: 'never' })
    );
    return () => manager.dispose();
  }, [set]);
}
```

### Reduce VRAM Pressure

```typescript
// lib/webgl/vramBudget.ts

/**
 * Estimate VRAM usage for common resource types.
 * These are approximations -- actual VRAM usage depends on driver and format.
 */
export function estimateTextureVRAM(
  width: number,
  height: number,
  format: 'RGBA8' | 'RGBA16F' | 'RGBA32F' | 'R8' | 'RG16F',
  mipmaps: boolean = false
): number {
  const bytesPerPixel: Record<string, number> = {
    RGBA8: 4,
    RGBA16F: 8,
    RGBA32F: 16,
    R8: 1,
    RG16F: 4,
  };

  const baseSize = width * height * (bytesPerPixel[format] || 4);
  // Mipmaps add ~33% overhead
  return mipmaps ? Math.ceil(baseSize * 1.33) : baseSize;
}

export function estimateRenderTargetVRAM(
  width: number,
  height: number,
  hasDepth: boolean = true,
  colorFormat: 'RGBA8' | 'RGBA16F' = 'RGBA16F'
): number {
  let total = estimateTextureVRAM(width, height, colorFormat, false);
  if (hasDepth) {
    // Depth buffer: 4 bytes per pixel (DEPTH24_STENCIL8 or DEPTH32F)
    total += width * height * 4;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

---

## Testing Context Loss

### Manual Testing Checklist

```
1. Open Chrome DevTools > Application tab
2. Scroll to "WebGL" section (may need to enable in settings)
3. Click "Lose context"
4. Verify:
   - [ ] No JS errors in console
   - [ ] Fallback UI or recovery message shown
   - [ ] App does not hang
5. Click "Restore context"
6. Verify:
   - [ ] Canvas re-renders correctly
   - [ ] All textures are present
   - [ ] All effects are working
   - [ ] No visual artifacts
   - [ ] Performance returns to normal
```

### Automated Testing

```typescript
// __tests__/webgl/contextLoss.test.ts

describe('Context Loss Recovery', () => {
  let canvas: HTMLCanvasElement;
  let gl: WebGL2RenderingContext;
  let loseContextExt: WEBGL_lose_context;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2')!;
    loseContextExt = gl.getExtension('WEBGL_lose_context')!;
  });

  it('fires contextlost event with preventDefault', (done) => {
    canvas.addEventListener('webglcontextlost', (e) => {
      expect(e.type).toBe('webglcontextlost');
      e.preventDefault();
      done();
    });
    loseContextExt.loseContext();
  });

  it('fires contextrestored after loss + restore', (done) => {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      // Schedule restore
      setTimeout(() => loseContextExt.restoreContext(), 50);
    });

    canvas.addEventListener('webglcontextrestored', () => {
      expect(gl.isContextLost()).toBe(false);
      done();
    });

    loseContextExt.loseContext();
  });

  it('reports isContextLost() correctly', () => {
    expect(gl.isContextLost()).toBe(false);

    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    loseContextExt.loseContext();

    expect(gl.isContextLost()).toBe(true);
  });
});
```

### Playwright Integration Test

```typescript
// e2e/context-loss.spec.ts

import { test, expect } from '@playwright/test';

test('recovers from WebGL context loss', async ({ page }) => {
  await page.goto('/editor');
  await page.waitForSelector('canvas');

  // Inject context loss simulation
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext) {
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 500);
    }
  });

  // Wait for recovery
  await page.waitForTimeout(2000);

  // Verify canvas is rendering again
  const isRendering = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2');
    return gl ? !gl.isContextLost() : false;
  });

  expect(isRendering).toBe(true);
});
```

---

## Recovery Time Budget

### How Long Should Recovery Take?

```
Event                          Target Time    Notes
---                            ---            ---
Context loss detected          < 1ms          Event handler fires synchronously
Render loop stopped            < 1ms          Check isContextLost() in frame
Fallback UI shown              < 16ms         One frame to show loading state
Context restored (automatic)   100-2000ms     Depends on OS, GPU, driver
Resources re-created           50-500ms       Depends on texture count/size
First frame after recovery     < 100ms        Should be immediate after resources
Full interactivity restored    < 3000ms       Total end-to-end target
```

### Measuring Recovery Time

```typescript
// lib/webgl/recoveryTimer.ts

export function measureRecoveryTime(
  canvas: HTMLCanvasElement
): Promise<number> {
  return new Promise((resolve) => {
    const lostAt = Date.now();

    canvas.addEventListener(
      'webglcontextrestored',
      () => {
        const recoveryMs = Date.now() - lostAt;
        resolve(recoveryMs);
      },
      { once: true }
    );
  });
}
```

---

## Multi-Tab Context Management

### Problem: Other Tabs Steal Contexts

When a user opens your app in multiple tabs, each tab creates a WebGL context.
Combined with other WebGL sites, the browser limit can be reached.

### Solution: Single Active Tab

```typescript
// lib/webgl/singleActiveTab.ts

const CHANNEL_NAME = 'webgl-app-webgl-context';

export function createTabCoordinator(
  onBecomeActive: () => void,
  onBecomeInactive: () => void
): { dispose: () => void } {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const tabId = Math.random().toString(36).slice(2);
  let isActive = true;

  // Announce this tab
  channel.postMessage({ type: 'TAB_OPENED', tabId });

  channel.onmessage = (event) => {
    if (event.data.type === 'TAB_OPENED' && event.data.tabId !== tabId) {
      // Another tab opened, check if we should yield
      if (!document.hasFocus()) {
        isActive = false;
        onBecomeInactive();
      }
    }
    if (event.data.type === 'TAB_FOCUSED' && event.data.tabId !== tabId) {
      // Another tab got focus, yield our context
      isActive = false;
      onBecomeInactive();
    }
  };

  function handleFocus(): void {
    if (!isActive) {
      isActive = true;
      channel.postMessage({ type: 'TAB_FOCUSED', tabId });
      onBecomeActive();
    }
  }

  window.addEventListener('focus', handleFocus);

  return {
    dispose: () => {
      channel.postMessage({ type: 'TAB_CLOSED', tabId });
      channel.close();
      window.removeEventListener('focus', handleFocus);
    },
  };
}
```

---

## Production Monitoring

### Context Loss Telemetry

```typescript
// lib/webgl/contextTelemetry.ts

interface ContextLossEvent {
  timestamp: number;
  tabAge: number;           // How long the tab has been open
  layerCount: number;       // How many effect layers were active
  textureCount: number;     // From renderer.info.memory.textures
  estimatedVRAM: number;    // In bytes
  wasBackgrounded: boolean; // Was the tab hidden when loss occurred
  recoveredAt: number | null;
  recoveryDurationMs: number | null;
  gpu: string;              // Renderer string
  browser: string;          // User agent
}

export function reportContextLoss(event: ContextLossEvent): void {
  // Send to your analytics endpoint
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(
      '/api/telemetry/context-loss',
      JSON.stringify(event)
    );
  }
}
```

### Dashboard Metrics

Track these metrics in production:

```
Metric                              Alert Threshold
---                                 ---
Context losses per 1000 sessions    > 5
Context loss recovery rate          < 95%
Average recovery time               > 3000ms
Context losses while backgrounded   (informational only)
Context losses while foregrounded   > 2 per 1000 sessions (GPU issue)
Permanent context losses            > 0.1% of sessions
Sessions with 3+ context losses     > 0.5% (recurring issue)
```

### Correlating Context Loss with GPU

```typescript
// Track which GPUs have the highest context loss rates.
// Use WEBGL_debug_renderer_info to segment.
//
// Common problematic configurations:
// - Intel HD 4000 on Windows 10 (old driver)
// - Apple M1 with macOS 12.0 (fixed in 12.1)
// - AMD Radeon RX 580 on Linux (Mesa driver versions)
// - Any GPU with "SwiftShader" (software renderer, not a real GPU)
//
// If a specific GPU accounts for >50% of context losses,
// consider auto-downgrading quality for that GPU tier.
```
