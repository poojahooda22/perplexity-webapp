# Load and Stress Testing for WebGL Applications

> Automated stress scenarios, pass/fail criteria, Playwright scripts, CI integration, memory leak detection, FPS regression testing, and chaos testing for production WebGL/Three.js apps.

## Table of Contents

1. [Stress Scenario Overview](#stress-scenario-overview)
2. [Scenario 1: 50 Layers Simultaneously](#scenario-1-50-layers-simultaneously)
3. [Scenario 2: Hold Ctrl+Z for 10 Seconds](#scenario-2-hold-ctrlz-for-10-seconds)
4. [Scenario 3: Drag Slider at Max Speed for 30 Seconds](#scenario-3-drag-slider-at-max-speed-for-30-seconds)
5. [Scenario 4: Resize Window Every 100ms for 10 Seconds](#scenario-4-resize-window-every-100ms-for-10-seconds)
6. [Scenario 5: Rapid Layer Add/Remove](#scenario-5-rapid-layer-addremove)
7. [Scenario 6: Multiple Tabs with Effects](#scenario-6-multiple-tabs-with-effects)
8. [Pass/Fail Criteria](#passfail-criteria)
9. [Playwright Test Framework](#playwright-test-framework)
10. [CI Integration](#ci-integration)

---

## Stress Scenario Overview

### Why Stress Test WebGL Apps

WebGL applications have failure modes that do not exist in standard web apps:
- GPU memory exhaustion causes hard crashes (not catchable errors)
- Shader recompilation storms freeze the main thread for seconds
- Texture unit exhaustion causes black screens with no error
- Rapid state changes cause gl.state desynchronization
- Context loss during heavy operations can leave orphaned GPU resources

Standard unit tests and E2E tests do not catch these because they test
"happy paths" with normal timing. Stress tests simulate adversarial user
behavior and extreme conditions.

### Test Infrastructure

```typescript
// e2e/stress/helpers.ts

import { Page, expect } from '@playwright/test';

/**
 * Wait for the WebGL canvas to be ready and rendering.
 */
export async function waitForCanvas(page: Page, timeoutMs: number = 10000): Promise<void> {
  await page.waitForSelector('canvas', { timeout: timeoutMs });

  // Wait for at least one successful render
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas) return reject(new Error('No canvas found'));

      const timeout = setTimeout(() => reject(new Error('Canvas render timeout')), 5000);

      // Check every frame until we see non-black pixels
      function check() {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 64;
        tempCanvas.height = 64;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;

        let nonBlack = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) nonBlack++;
        }

        if (nonBlack > 10) {
          clearTimeout(timeout);
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      }

      requestAnimationFrame(check);
    });
  });
}

/**
 * Measure FPS over a given duration.
 */
export async function measureFPS(page: Page, durationMs: number): Promise<{
  average: number;
  min: number;
  max: number;
  p5: number;
  p95: number;
  frameCount: number;
  jankFrames: number;
}> {
  return page.evaluate((duration) => {
    return new Promise((resolve) => {
      const frameTimes: number[] = [];
      let lastTime = performance.now();
      let running = true;

      function tick(now: number) {
        if (!running) return;

        const dt = now - lastTime;
        lastTime = now;

        if (dt > 0 && dt < 500) {
          frameTimes.push(dt);
        }

        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);

      setTimeout(() => {
        running = false;

        if (frameTimes.length === 0) {
          resolve({
            average: 0, min: 0, max: 0, p5: 0, p95: 0,
            frameCount: 0, jankFrames: 0,
          });
          return;
        }

        const sorted = [...frameTimes].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const avgFrameTime = sum / sorted.length;
        const jankFrames = sorted.filter((t) => t > 33.33).length;

        resolve({
          average: Math.round(1000 / avgFrameTime),
          min: Math.round(1000 / sorted[sorted.length - 1]),
          max: Math.round(1000 / sorted[0]),
          p5: Math.round(1000 / sorted[Math.floor(sorted.length * 0.95)]),
          p95: Math.round(1000 / sorted[Math.floor(sorted.length * 0.05)]),
          frameCount: frameTimes.length,
          jankFrames,
        });
      }, duration);
    });
  }, durationMs);
}

/**
 * Get GPU memory counters from the renderer.
 */
export async function getMemoryCounters(page: Page): Promise<{
  textures: number;
  geometries: number;
  programs: number;
}> {
  return page.evaluate(() => {
    // Access R3F store to get renderer
    const canvas = document.querySelector('canvas') as any;
    const store = canvas?.__r3f?.store;
    if (!store) return { textures: -1, geometries: -1, programs: -1 };

    const renderer = store.getState().gl;
    const info = renderer.info;

    return {
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
    };
  });
}

/**
 * Check if the WebGL context is still alive.
 */
export async function isContextAlive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    if (!canvas) return false;
    const gl = canvas.getContext('webgl2');
    return gl ? !gl.isContextLost() : false;
  });
}

/**
 * Check for JS errors on the page.
 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  return errors;
}

/**
 * Take a screenshot and save it with a descriptive name.
 */
export async function captureState(
  page: Page,
  name: string,
  outputDir: string = 'e2e/stress/screenshots'
): Promise<void> {
  await page.screenshot({
    path: `${outputDir}/${name}-${Date.now()}.png`,
    fullPage: false,
  });
}
```

---

## Scenario 1: 50 Layers Simultaneously

### Goal

Verify that the compositor can handle the maximum advertised layer count
without crashing, running out of memory, or dropping to unacceptable FPS.

### Test Script

```typescript
// e2e/stress/50-layers.spec.ts

import { test, expect } from '@playwright/test';
import {
  waitForCanvas,
  measureFPS,
  getMemoryCounters,
  isContextAlive,
  collectErrors,
} from './helpers';

test.describe('Stress: 50 Layers Simultaneously', () => {
  test.setTimeout(120_000); // 2 minute timeout

  test('handles 50 layers without crash', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/editor');
    await waitForCanvas(page);

    // Record baseline
    const baselineMemory = await getMemoryCounters(page);
    const baselineFPS = await measureFPS(page, 2000);

    console.log('Baseline:', { memory: baselineMemory, fps: baselineFPS.average });

    // Add 50 layers programmatically
    const effectTypes = [
      'bloom', 'blur', 'vignette', 'grain', 'chromaticAberration',
      'colorGrading', 'fog', 'radialBlur', 'zoomBlur', 'progressiveBlur',
    ];

    await page.evaluate((types) => {
      // Access the editor store directly for speed
      const store = (window as any).__editorStore;
      if (!store) throw new Error('Editor store not found');

      for (let i = 0; i < 50; i++) {
        const type = types[i % types.length];
        store.getState().addLayer(type);
      }
    }, effectTypes);

    // Wait for all layers to compile and render
    await page.waitForTimeout(5000);

    // Measure FPS with all layers active
    const loadedFPS = await measureFPS(page, 5000);
    const loadedMemory = await getMemoryCounters(page);

    console.log('50 layers:', { memory: loadedMemory, fps: loadedFPS.average });

    // ASSERTIONS

    // 1. No crash: context is still alive
    const alive = await isContextAlive(page);
    expect(alive).toBe(true);

    // 2. No JS errors (filter out known benign warnings)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('THREE.WebGLRenderer') // Some warnings are expected
    );
    expect(criticalErrors).toHaveLength(0);

    // 3. FPS did not drop to zero (app is still rendering)
    expect(loadedFPS.average).toBeGreaterThan(0);

    // 4. FPS is at least 10 (extremely degraded but not frozen)
    expect(loadedFPS.average).toBeGreaterThanOrEqual(10);

    // 5. Memory grew but not explosively
    // Each layer should use ~16MB max. 50 layers = ~800MB max.
    // Actual should be much less due to shared resources.
    expect(loadedMemory.textures).toBeLessThan(500);

    // 6. No shader program explosion
    expect(loadedMemory.programs).toBeLessThan(100);
  });
});
```

---

## Scenario 2: Hold Ctrl+Z for 10 Seconds

### Goal

Verify that the undo system can handle sustained rapid undo operations without:
- Stack overflow
- Memory leak (each undo should not accumulate GPU resources)
- UI freeze
- State corruption

### Test Script

```typescript
// e2e/stress/rapid-undo.spec.ts

import { test, expect } from '@playwright/test';
import {
  waitForCanvas,
  measureFPS,
  getMemoryCounters,
  isContextAlive,
  collectErrors,
} from './helpers';

test.describe('Stress: Rapid Undo (Ctrl+Z for 10 seconds)', () => {
  test.setTimeout(60_000);

  test('handles sustained Ctrl+Z without crash', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/editor');
    await waitForCanvas(page);

    // Create some undo history first
    // Add 20 layers, then modify some properties
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      if (!store) throw new Error('Editor store not found');

      for (let i = 0; i < 20; i++) {
        store.getState().addLayer('bloom');
      }
      // Modify properties to create more undo entries
      const layers = store.getState().layers;
      for (const layer of layers.slice(0, 10)) {
        store.getState().updateLayerProperty(layer.id, 'intensity', Math.random());
        store.getState().updateLayerProperty(layer.id, 'threshold', Math.random());
      }
    });

    await page.waitForTimeout(1000);

    const beforeMemory = await getMemoryCounters(page);
    console.log('Before undo storm:', beforeMemory);

    // Hold Ctrl+Z for 10 seconds
    // Simulate by pressing Ctrl+Z rapidly (every 50ms)
    const undoCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let count = 0;
        const interval = setInterval(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'z',
              code: 'KeyZ',
              ctrlKey: true,
              bubbles: true,
            })
          );
          count++;
        }, 50); // 20 undos per second

        setTimeout(() => {
          clearInterval(interval);
          resolve(count);
        }, 10000);
      });
    });

    console.log(`Performed ${undoCount} undo operations in 10 seconds`);

    // Wait for rendering to stabilize
    await page.waitForTimeout(2000);

    const afterMemory = await getMemoryCounters(page);
    const fps = await measureFPS(page, 3000);

    console.log('After undo storm:', { memory: afterMemory, fps: fps.average });

    // ASSERTIONS

    // 1. No crash
    const alive = await isContextAlive(page);
    expect(alive).toBe(true);

    // 2. No JS errors
    const criticalErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('Nothing to undo')
    );
    expect(criticalErrors).toHaveLength(0);

    // 3. FPS recovered to reasonable level
    expect(fps.average).toBeGreaterThan(20);

    // 4. Memory did not grow (undo should free resources)
    // After undoing all additions, textures should be close to baseline
    expect(afterMemory.textures).toBeLessThanOrEqual(beforeMemory.textures + 5);

    // 5. App is still interactive (can perform another action)
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      store.getState().addLayer('vignette');
    });
    await page.waitForTimeout(500);
    const postAddAlive = await isContextAlive(page);
    expect(postAddAlive).toBe(true);
  });
});
```

---

## Scenario 3: Drag Slider at Max Speed for 30 Seconds

### Goal

Verify that rapid property changes (e.g., dragging an intensity slider from 0 to 1
and back continuously) does not cause:
- Shader recompilation on every value change
- Uniform upload backlog
- UI jank
- Memory leak from intermediate state objects

### Test Script

```typescript
// e2e/stress/rapid-slider.spec.ts

import { test, expect } from '@playwright/test';
import {
  waitForCanvas,
  measureFPS,
  getMemoryCounters,
  isContextAlive,
  collectErrors,
} from './helpers';

test.describe('Stress: Rapid Slider Drag (30 seconds)', () => {
  test.setTimeout(90_000);

  test('handles rapid slider changes without performance degradation', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/editor');
    await waitForCanvas(page);

    // Add a bloom effect to have something to modify
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      store.getState().addLayer('bloom');
    });
    await page.waitForTimeout(1000);

    // Measure baseline FPS
    const baselineFPS = await measureFPS(page, 3000);
    const baselineMemory = await getMemoryCounters(page);
    console.log('Baseline:', { fps: baselineFPS.average, memory: baselineMemory });

    // Simulate rapid slider drag: change intensity value every 16ms for 30 seconds
    const changeCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const store = (window as any).__editorStore;
        const layers = store.getState().layers;
        if (layers.length === 0) {
          resolve(0);
          return;
        }

        const layerId = layers[0].id;
        let count = 0;
        let value = 0;
        let direction = 1;

        const interval = setInterval(() => {
          // Oscillate value between 0 and 1
          value += direction * 0.02;
          if (value >= 1.0) { value = 1.0; direction = -1; }
          if (value <= 0.0) { value = 0.0; direction = 1; }

          store.getState().updateLayerProperty(layerId, 'intensity', value);
          count++;
        }, 16); // ~60 changes per second

        setTimeout(() => {
          clearInterval(interval);
          resolve(count);
        }, 30000);
      });
    });

    console.log(`Performed ${changeCount} property changes in 30 seconds`);

    // Wait for stabilization
    await page.waitForTimeout(2000);

    // Measure post-stress FPS
    const afterFPS = await measureFPS(page, 3000);
    const afterMemory = await getMemoryCounters(page);

    console.log('After slider storm:', { fps: afterFPS.average, memory: afterMemory });

    // ASSERTIONS

    // 1. No crash
    expect(await isContextAlive(page)).toBe(true);

    // 2. No significant FPS degradation compared to baseline
    // Allow 20% drop due to the stress still settling
    expect(afterFPS.average).toBeGreaterThan(baselineFPS.average * 0.7);

    // 3. No memory leak from property changes
    // Slider changes should NOT create new textures or geometries
    expect(afterMemory.textures).toBeLessThanOrEqual(baselineMemory.textures + 2);
    expect(afterMemory.geometries).toBeLessThanOrEqual(baselineMemory.geometries + 2);

    // 4. No shader program recompilation
    // Changing a uniform value should NOT recompile the shader
    expect(afterMemory.programs).toBeLessThanOrEqual(baselineMemory.programs + 1);

    // 5. No critical errors
    const criticalErrors = errors.filter((e) => !e.includes('ResizeObserver'));
    expect(criticalErrors).toHaveLength(0);
  });
});
```

---

## Scenario 4: Resize Window Every 100ms for 10 Seconds

### Goal

Verify that rapid window resizing (simulating a user dragging the browser edge
aggressively) does not cause:
- Render target allocation storm
- Memory leak from un-disposed old render targets
- Crash from zero-size render targets
- Layout thrashing

### Test Script

```typescript
// e2e/stress/rapid-resize.spec.ts

import { test, expect } from '@playwright/test';
import {
  waitForCanvas,
  measureFPS,
  getMemoryCounters,
  isContextAlive,
  collectErrors,
} from './helpers';

test.describe('Stress: Rapid Window Resize (100ms interval, 10 seconds)', () => {
  test.setTimeout(60_000);

  test('handles rapid resizing without memory leak or crash', async ({ page }) => {
    const errors = collectErrors(page);

    // Start at a known size
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/editor');
    await waitForCanvas(page);

    // Add some effects to make resize expensive
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      store.getState().addLayer('bloom');
      store.getState().addLayer('blur');
      store.getState().addLayer('fog');
    });
    await page.waitForTimeout(2000);

    const beforeMemory = await getMemoryCounters(page);
    console.log('Before resize storm:', beforeMemory);

    // Resize the viewport rapidly for 10 seconds
    const sizes = [
      { width: 800, height: 600 },
      { width: 1920, height: 1080 },
      { width: 640, height: 480 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
      { width: 1600, height: 900 },
      { width: 320, height: 240 },  // Very small
      { width: 2560, height: 1440 }, // Very large
    ];

    const startTime = Date.now();
    let resizeCount = 0;

    while (Date.now() - startTime < 10000) {
      const size = sizes[resizeCount % sizes.length];
      await page.setViewportSize(size);
      resizeCount++;
      await page.waitForTimeout(100);
    }

    console.log(`Performed ${resizeCount} resizes in 10 seconds`);

    // Settle at final size
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(3000);

    const afterMemory = await getMemoryCounters(page);
    const fps = await measureFPS(page, 3000);

    console.log('After resize storm:', { memory: afterMemory, fps: fps.average });

    // ASSERTIONS

    // 1. No crash
    expect(await isContextAlive(page)).toBe(true);

    // 2. Memory returned to near-baseline
    // Resizing creates new render targets but should dispose old ones.
    // Allow a small delta for pool hysteresis.
    expect(afterMemory.textures).toBeLessThanOrEqual(beforeMemory.textures + 10);

    // 3. FPS recovered
    expect(fps.average).toBeGreaterThan(20);

    // 4. No crash errors
    const criticalErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('loop limit exceeded')
    );
    expect(criticalErrors).toHaveLength(0);

    // 5. Canvas is rendering at the correct size
    const canvasSize = await page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    });
    // Canvas should roughly match viewport (DPR adjusted)
    expect(canvasSize.width).toBeGreaterThan(0);
    expect(canvasSize.height).toBeGreaterThan(0);
  });
});
```

---

## Scenario 5: Rapid Layer Add/Remove

### Goal

Verify that rapidly adding and removing layers (the most common memory-intensive
operation) does not leak GPU resources. This is the definitive memory leak test.

### Test Script

```typescript
// e2e/stress/rapid-add-remove.spec.ts

import { test, expect } from '@playwright/test';
import {
  waitForCanvas,
  getMemoryCounters,
  isContextAlive,
  collectErrors,
} from './helpers';

test.describe('Stress: Rapid Layer Add/Remove', () => {
  test.setTimeout(120_000);

  test('no memory leak after 100 add/remove cycles', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/editor');
    await waitForCanvas(page);

    // Warm up: add and remove one layer to establish baseline
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      store.getState().addLayer('bloom');
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const layers = store.getState().layers;
      if (layers.length > 0) {
        store.getState().removeLayer(layers[0].id);
      }
    });
    await page.waitForTimeout(500);

    // Record baseline after warm-up
    const baseline = await getMemoryCounters(page);
    console.log('Baseline (after warm-up):', baseline);

    // Perform 100 add/remove cycles
    const effectTypes = [
      'bloom', 'blur', 'vignette', 'grain', 'chromaticAberration',
      'fog', 'radialBlur', 'zoomBlur', 'progressiveBlur', 'blobTracking',
    ];

    const memorySnapshots: Array<{ cycle: number; textures: number; geometries: number }> = [];

    for (let cycle = 0; cycle < 100; cycle++) {
      const effectType = effectTypes[cycle % effectTypes.length];

      // Add layer
      await page.evaluate((type) => {
        const store = (window as any).__editorStore;
        store.getState().addLayer(type);
      }, effectType);

      // Brief pause to allow shader compilation
      await page.waitForTimeout(100);

      // Remove layer
      await page.evaluate(() => {
        const store = (window as any).__editorStore;
        const layers = store.getState().layers;
        if (layers.length > 0) {
          store.getState().removeLayer(layers[layers.length - 1].id);
        }
      });

      await page.waitForTimeout(50);

      // Record memory every 10 cycles
      if (cycle % 10 === 9) {
        const mem = await getMemoryCounters(page);
        memorySnapshots.push({
          cycle: cycle + 1,
          textures: mem.textures,
          geometries: mem.geometries,
        });
        console.log(`Cycle ${cycle + 1}:`, mem);
      }
    }

    // Final measurement
    await page.waitForTimeout(2000); // Allow GC
    const final = await getMemoryCounters(page);
    console.log('Final:', final);

    // ASSERTIONS

    // 1. No crash
    expect(await isContextAlive(page)).toBe(true);

    // 2. Texture count returned to baseline (or very close)
    // Allow +5 for internal caching
    expect(final.textures).toBeLessThanOrEqual(baseline.textures + 5);

    // 3. Geometry count returned to baseline
    expect(final.geometries).toBeLessThanOrEqual(baseline.geometries + 5);

    // 4. Memory did not grow monotonically
    // Check that texture count did not increase every snapshot
    let monotonicallyIncreasing = true;
    for (let i = 1; i < memorySnapshots.length; i++) {
      if (memorySnapshots[i].textures <= memorySnapshots[i - 1].textures) {
        monotonicallyIncreasing = false;
        break;
      }
    }
    expect(monotonicallyIncreasing).toBe(false); // Should NOT be monotonically increasing

    // 5. No critical errors
    const criticalErrors = errors.filter((e) => !e.includes('ResizeObserver'));
    expect(criticalErrors).toHaveLength(0);

    // Report growth rate
    if (memorySnapshots.length > 1) {
      const first = memorySnapshots[0];
      const last = memorySnapshots[memorySnapshots.length - 1];
      const textureGrowth = last.textures - first.textures;
      const cycles = last.cycle - first.cycle;
      console.log(
        `Texture growth: ${textureGrowth} over ${cycles} cycles ` +
        `(${(textureGrowth / cycles).toFixed(3)} per cycle)`
      );
    }
  });

  test('handles rapid add without remove (max layer stress)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/editor');
    await waitForCanvas(page);

    // Add 30 layers as fast as possible without removing
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const types = ['bloom', 'blur', 'vignette', 'grain', 'fog'];
      for (let i = 0; i < 30; i++) {
        store.getState().addLayer(types[i % types.length]);
      }
    });

    await page.waitForTimeout(5000);

    // Verify no crash
    expect(await isContextAlive(page)).toBe(true);

    // Now remove all 30 layers at once
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const layers = [...store.getState().layers];
      for (const layer of layers) {
        store.getState().removeLayer(layer.id);
      }
    });

    await page.waitForTimeout(3000);

    // Verify memory recovered
    const afterRemoval = await getMemoryCounters(page);
    console.log('After bulk removal:', afterRemoval);

    // Should be close to empty (some base textures are expected)
    expect(afterRemoval.textures).toBeLessThan(20);
    expect(await isContextAlive(page)).toBe(true);
  });
});
```

---

## Scenario 6: Multiple Tabs with Effects

### Goal

Verify that opening multiple browser tabs (each with the editor and effects)
does not cause WebGL context loss due to exceeding the browser's context limit.

### Test Script

```typescript
// e2e/stress/multi-tab.spec.ts

import { test, expect, BrowserContext } from '@playwright/test';
import { waitForCanvas, isContextAlive, collectErrors } from './helpers';

test.describe('Stress: Multiple Tabs with Effects', () => {
  test.setTimeout(120_000);

  test('5 tabs with effects simultaneously', async ({ browser }) => {
    const context = await browser.newContext();
    const pages = [];
    const errorsPerTab: string[][] = [];

    // Open 5 tabs
    for (let i = 0; i < 5; i++) {
      const page = await context.newPage();
      const errors = collectErrors(page);
      errorsPerTab.push(errors);
      pages.push(page);
    }

    // Navigate each tab to the editor
    for (let i = 0; i < pages.length; i++) {
      await pages[i].goto('/editor');
    }

    // Wait for all canvases to be ready
    for (const page of pages) {
      try {
        await waitForCanvas(page);
      } catch {
        // Some tabs may fail to get a context -- that is expected
        console.warn('A tab failed to initialize canvas');
      }
    }

    // Add effects to each tab
    for (const page of pages) {
      await page.evaluate(() => {
        try {
          const store = (window as any).__editorStore;
          if (store) {
            store.getState().addLayer('bloom');
            store.getState().addLayer('blur');
          }
        } catch {
          // May fail if context was already lost
        }
      });
    }

    await pages[0].waitForTimeout(3000);

    // Check how many tabs have live contexts
    let aliveCount = 0;
    let deadCount = 0;

    for (let i = 0; i < pages.length; i++) {
      const alive = await isContextAlive(pages[i]);
      if (alive) {
        aliveCount++;
      } else {
        deadCount++;
      }
      console.log(`Tab ${i + 1}: ${alive ? 'ALIVE' : 'DEAD'}`);
    }

    console.log(`Results: ${aliveCount} alive, ${deadCount} dead out of ${pages.length} tabs`);

    // ASSERTIONS

    // At least the focused tab should be alive
    const lastTabAlive = await isContextAlive(pages[pages.length - 1]);
    expect(lastTabAlive).toBe(true);

    // At least 3 out of 5 tabs should be alive
    // (browsers may kill background contexts, but not all of them)
    expect(aliveCount).toBeGreaterThanOrEqual(3);

    // Check that dead tabs show recovery UI (not a hard crash)
    for (let i = 0; i < pages.length; i++) {
      if (!(await isContextAlive(pages[i]))) {
        // The tab should show a fallback, not a blank page
        const hasContent = await pages[i].evaluate(() => {
          return document.body.innerText.trim().length > 0;
        });
        expect(hasContent).toBe(true);
      }
    }

    // Cleanup
    for (const page of pages) {
      await page.close();
    }
    await context.close();
  });
});
```

---

## Pass/Fail Criteria

### Universal Criteria (All Scenarios)

```
PASS Criteria:
  [MUST]  No unhandled JS exceptions (page crash)
  [MUST]  WebGL context is alive after test OR recovery UI is shown
  [MUST]  No infinite loops or hangs (test completes within timeout)
  [MUST]  Page has visible content (not blank)

FAIL Criteria:
  [FAIL]  Unhandled exception in console
  [FAIL]  Page becomes blank with no error UI
  [FAIL]  Test times out (app is frozen)
  [FAIL]  Browser process crashes
```

### Per-Scenario Criteria

```
Scenario                     Additional PASS Criteria
---                          ---
50 Layers                    FPS > 10, textures < 500, programs < 100
Rapid Undo                   FPS recovers > 20 after storm, no memory growth
Slider Drag                  FPS within 70% of baseline, no shader recompilation
Rapid Resize                 Memory within +10 of baseline, renders at correct size
Add/Remove Cycles            Textures within +5 of baseline after 100 cycles
Multi-Tab                    At least 3/5 tabs alive, dead tabs show recovery UI
```

### Severity Classification

```
Severity    Description                                 Action
---         ---                                         ---
BLOCKER     App crashes, blank screen, data loss        Fix before release
CRITICAL    FPS < 5, context loss without recovery      Fix before release
MAJOR       Memory leak (growing 1+/cycle)              Fix in next sprint
MINOR       FPS drops 50%+ during stress                Optimize when possible
INFO        Temporary jank during extreme operations    Document as known
```

---

## Playwright Test Framework

### Configuration

```typescript
// playwright.config.ts

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/stress',
  timeout: 120_000, // Stress tests need longer timeouts
  retries: 0,       // Stress tests should not retry (results must be deterministic)
  workers: 1,       // Run stress tests sequentially (GPU is shared)

  reporter: [
    ['html', { outputFolder: 'e2e/stress/report' }],
    ['json', { outputFile: 'e2e/stress/results.json' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium-stress',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: [
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            // Do NOT use --disable-gpu (we need real GPU testing)
            // Do NOT use --headless (GPU context behavior differs)
          ],
        },
      },
    },
    {
      name: 'firefox-stress',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
```

### Running Tests

```bash
# Run all stress tests
npx playwright test --config=playwright.stress.config.ts

# Run a specific scenario
npx playwright test 50-layers.spec.ts

# Run with headed browser (to visually observe)
npx playwright test --headed

# Run with slow motion (for debugging)
npx playwright test --headed --slow-mo=500

# Generate HTML report
npx playwright show-report e2e/stress/report
```

---

## CI Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/stress-test.yml

name: GPU Stress Tests
on:
  # Run on PRs that modify GPU-related code
  pull_request:
    paths:
      - 'lib/r3f-compositor/**'
      - 'lib/primitives/**'
      - 'lib/shaders/**'
      - 'components/editor/**'

  # Run nightly
  schedule:
    - cron: '0 4 * * *' # 4 AM UTC daily

  # Manual trigger
  workflow_dispatch:

jobs:
  stress-test:
    runs-on: ubuntu-latest
    # Use a runner with GPU support for realistic results
    # Note: Standard GitHub runners do not have GPUs.
    # Use self-hosted runners or cloud GPU instances for real GPU testing.
    # SwiftShader (software renderer) is used as fallback.

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      # Build the app
      - run: npm run build

      # Start the app in the background
      - name: Start production server
        run: npm start &
        env:
          PORT: 3000

      # Wait for server to be ready
      - name: Wait for server
        run: |
          for i in $(seq 1 30); do
            if curl -s http://localhost:3000 > /dev/null; then
              echo "Server is ready"
              exit 0
            fi
            sleep 1
          done
          echo "Server failed to start"
          exit 1

      # Install Playwright browsers
      - name: Install Playwright
        run: npx playwright install chromium

      # Run stress tests
      - name: Run stress tests
        run: npx playwright test --config=playwright.stress.config.ts
        env:
          BASE_URL: http://localhost:3000

      # Upload results
      - name: Upload test report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: stress-test-report
          path: |
            e2e/stress/report/
            e2e/stress/results.json
            e2e/stress/screenshots/

      # Post results to PR
      - name: Post results to PR
        if: github.event_name == 'pull_request' && always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            let results;
            try {
              results = JSON.parse(fs.readFileSync('e2e/stress/results.json', 'utf-8'));
            } catch {
              results = { suites: [] };
            }

            const passed = results.suites?.flatMap(s => s.specs || [])
              .filter(s => s.ok).length || 0;
            const failed = results.suites?.flatMap(s => s.specs || [])
              .filter(s => !s.ok).length || 0;
            const total = passed + failed;

            const emoji = failed === 0 ? 'PASS' : 'FAIL';
            const body = `## GPU Stress Test Results: ${emoji}

            | Metric | Value |
            |--------|-------|
            | Total scenarios | ${total} |
            | Passed | ${passed} |
            | Failed | ${failed} |

            ${failed > 0 ? '**Failed scenarios require investigation before merge.**' : 'All scenarios passed.'}

            Full report available in the workflow artifacts.`;

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });
```

### Self-Hosted GPU Runner Setup

For accurate GPU stress testing, use a self-hosted runner with a real GPU:

```yaml
# Use a self-hosted runner for real GPU testing
jobs:
  stress-test-gpu:
    runs-on: [self-hosted, gpu]
    # Ensure the runner has:
    # - Chrome installed
    # - NVIDIA/AMD GPU with up-to-date drivers
    # - X11 or Wayland display server (for headed testing)
    # - Node.js 20+
```

### Nightly Regression Tracking

```bash
# scripts/track-stress-results.sh
# Run after nightly stress tests to track trends

#!/bin/bash
DATE=$(date +%Y-%m-%d)
RESULTS_FILE="e2e/stress/results.json"
HISTORY_FILE="e2e/stress/history.jsonl"

if [ -f "$RESULTS_FILE" ]; then
  # Append today's results to the history file (JSONL format)
  echo "{\"date\": \"$DATE\", \"results\": $(cat $RESULTS_FILE)}" >> "$HISTORY_FILE"
  echo "Recorded stress test results for $DATE"
fi
```

### Quick Smoke Test (For Every PR)

Full stress tests take 5-10 minutes. For every PR, run a quick smoke test
that completes in under 60 seconds:

```typescript
// e2e/stress/smoke.spec.ts

import { test, expect } from '@playwright/test';
import { waitForCanvas, isContextAlive, getMemoryCounters } from './helpers';

test.describe('Quick Smoke Test', () => {
  test.setTimeout(30_000);

  test('basic add/render/remove cycle works', async ({ page }) => {
    await page.goto('/editor');
    await waitForCanvas(page);

    // Add 3 layers
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      store.getState().addLayer('bloom');
      store.getState().addLayer('blur');
      store.getState().addLayer('vignette');
    });
    await page.waitForTimeout(1000);

    // Verify rendering
    expect(await isContextAlive(page)).toBe(true);

    const memory = await getMemoryCounters(page);
    expect(memory.textures).toBeGreaterThan(0);

    // Remove all layers
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const layers = [...store.getState().layers];
      for (const layer of layers) {
        store.getState().removeLayer(layer.id);
      }
    });
    await page.waitForTimeout(1000);

    // Verify no crash and memory recovered
    expect(await isContextAlive(page)).toBe(true);

    const afterMemory = await getMemoryCounters(page);
    expect(afterMemory.textures).toBeLessThanOrEqual(memory.textures);
  });
});
```

### CI Strategy Summary

```
Trigger          Tests Run                  Duration    Blocking
---              ---                        ---         ---
Every PR         Quick smoke test           30s         Yes (must pass)
PRs with GPU     Full stress suite          5-10 min    Yes (must pass)
  code changes
Nightly          Full stress suite + trends 10 min      No (report only)
Pre-release      Full stress + multi-GPU    30 min      Yes (must pass)
```
