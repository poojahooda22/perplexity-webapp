# Error Tracking and Observability for WebGL Applications

> Sentry integration, source maps, custom breadcrumbs, GPU context in errors, structured logging, error categorization, OpenTelemetry spans, and Vercel Analytics for Three.js/R3F production apps.

## Table of Contents

1. [Sentry Integration for Three.js/WebGL](#sentry-integration-for-threejswebgl)
2. [Source Maps for Minified Three.js](#source-maps-for-minified-threejs)
3. [Custom Breadcrumbs](#custom-breadcrumbs)
4. [GPU Info in Error Context](#gpu-info-in-error-context)
5. [Structured Logging](#structured-logging)
6. [Error Categorization](#error-categorization)
7. [OpenTelemetry for Render Pipeline](#opentelemetry-for-render-pipeline)
8. [Vercel Analytics Integration](#vercel-analytics-integration)
9. [Alert Routing and Escalation](#alert-routing-and-escalation)
10. [Debugging Production Issues](#debugging-production-issues)

---

## Sentry Integration for Three.js/WebGL

### Setup

```bash
npm install @sentry/nextjs
npx @sentry/wizard@latest -i nextjs
```

### Sentry Configuration for WebGL

```typescript
// sentry.client.config.ts

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Performance monitoring
  tracesSampleRate: 0.1, // 10% of transactions
  // For WebGL apps, you want higher sampling during development
  // and lower in production due to volume

  // Session replay for reproducing visual bugs
  replaysSessionSampleRate: 0.01,  // 1% of sessions
  replaysOnErrorSampleRate: 1.0,   // 100% of sessions with errors

  integrations: [
    // Capture console.error and console.warn from Three.js
    Sentry.captureConsoleIntegration({
      levels: ['error', 'warn'],
    }),
    // Browser profiling for performance issues
    Sentry.browserProfilingIntegration(),
    // Session replay
    Sentry.replayIntegration({
      // Mask sensitive UI elements
      maskAllText: false,
      maskAllInputs: true,
      blockAllMedia: false,
      // Capture canvas content in replays
      // Note: This has performance impact. Enable only for error replays.
    }),
  ],

  // Filter out noise
  beforeSend(event, hint) {
    const error = hint.originalException;

    // Skip ResizeObserver loop errors (cosmetic, not real errors)
    if (
      error instanceof Error &&
      error.message.includes('ResizeObserver loop')
    ) {
      return null;
    }

    // Skip benign WebGL warnings that Three.js logs as errors
    if (
      error instanceof Error &&
      error.message.includes('WebGL warning') &&
      error.message.includes('INVALID_ENUM')
    ) {
      return null;
    }

    // Enrich with GPU info
    enrichWithGPUInfo(event);

    return event;
  },

  // Fingerprinting for WebGL errors
  beforeSendTransaction(event) {
    return event;
  },

  // Custom error grouping
  beforeBreadcrumb(breadcrumb) {
    // Filter noisy breadcrumbs
    if (
      breadcrumb.category === 'console' &&
      breadcrumb.message?.includes('THREE.WebGLRenderer')
    ) {
      // Keep Three.js renderer messages but mark them
      breadcrumb.data = {
        ...breadcrumb.data,
        source: 'threejs',
      };
    }
    return breadcrumb;
  },
});

function enrichWithGPUInfo(event: Sentry.Event): void {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      event.contexts = {
        ...event.contexts,
        gpu: { renderer: 'no-webgl', vendor: 'no-webgl' },
      };
      return;
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    event.contexts = {
      ...event.contexts,
      gpu: {
        renderer: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        vendor: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
        webgl_version: gl instanceof WebGL2RenderingContext ? '2.0' : '1.0',
        max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        max_renderbuffer_size: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      },
    };

    // Clean up probe context
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  } catch {
    // GPU info collection should never crash error reporting
  }
}
```

### Custom Sentry Integrations for WebGL

```typescript
// lib/observability/sentryWebGL.ts

import * as Sentry from '@sentry/nextjs';

/**
 * Install WebGL-specific Sentry hooks.
 * Call this after the Canvas is created and the renderer is available.
 */
export function installSentryWebGLHooks(
  renderer: THREE.WebGLRenderer,
  canvas: HTMLCanvasElement
): () => void {
  const cleanups: Array<() => void> = [];

  // 1. Track context loss/restoration
  const handleContextLost = () => {
    Sentry.addBreadcrumb({
      category: 'webgl',
      message: 'WebGL context lost',
      level: 'warning',
      data: {
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
        programs: renderer.info.programs?.length ?? 0,
      },
    });

    Sentry.captureMessage('WebGL context lost', {
      level: 'warning',
      tags: { webgl_event: 'context-lost' },
      extra: {
        textureCount: renderer.info.memory.textures,
        geometryCount: renderer.info.memory.geometries,
        programCount: renderer.info.programs?.length ?? 0,
      },
    });
  };

  const handleContextRestored = () => {
    Sentry.addBreadcrumb({
      category: 'webgl',
      message: 'WebGL context restored',
      level: 'info',
    });
  };

  canvas.addEventListener('webglcontextlost', handleContextLost);
  canvas.addEventListener('webglcontextrestored', handleContextRestored);
  cleanups.push(() => {
    canvas.removeEventListener('webglcontextlost', handleContextLost);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored);
  });

  // 2. Track shader compilation errors
  const originalOnShaderError = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    vertexShader: WebGLShader,
    fragmentShader: WebGLShader
  ) => {
    const vertexLog = gl.getShaderInfoLog(vertexShader) || '';
    const fragmentLog = gl.getShaderInfoLog(fragmentShader) || '';
    const programLog = gl.getProgramInfoLog(program) || '';

    Sentry.captureException(
      new Error(`Shader compilation error: ${vertexLog || fragmentLog}`),
      {
        tags: {
          error_type: 'shader',
          shader_stage: vertexLog ? 'vertex' : 'fragment',
        },
        extra: {
          vertexShaderLog: vertexLog,
          fragmentShaderLog: fragmentLog,
          programLog: programLog,
        },
        fingerprint: ['shader-compilation', vertexLog.slice(0, 100)],
      }
    );

    if (originalOnShaderError) {
      originalOnShaderError(gl, program, vertexShader, fragmentShader);
    }
  };
  cleanups.push(() => {
    renderer.debug.onShaderError = originalOnShaderError;
  });

  // 3. Track WebGL errors via getError() polling
  // Only enable in development or for a sample of production users
  if (process.env.NODE_ENV === 'development') {
    const checkInterval = setInterval(() => {
      const gl = renderer.getContext();
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        const errorName = {
          [gl.INVALID_ENUM]: 'INVALID_ENUM',
          [gl.INVALID_VALUE]: 'INVALID_VALUE',
          [gl.INVALID_OPERATION]: 'INVALID_OPERATION',
          [gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
          [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
          [gl.CONTEXT_LOST_WEBGL]: 'CONTEXT_LOST_WEBGL',
        }[error] || `UNKNOWN(${error})`;

        Sentry.addBreadcrumb({
          category: 'webgl',
          message: `WebGL error: ${errorName}`,
          level: 'error',
        });
      }
    }, 5000);

    cleanups.push(() => clearInterval(checkInterval));
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
```

---

## Source Maps for Minified Three.js

### The Problem

Three.js is a large library (~1MB minified). When errors occur inside Three.js code,
stack traces point to minified line/column numbers that are unreadable:

```
Error: WebGL: INVALID_OPERATION
    at Object.texImage2D (three.min.js:1:123456)
    at t.upload (three.min.js:1:789012)
```

### Solution: Source Maps with Sentry

```javascript
// next.config.mjs

import { withSentryConfig } from '@sentry/nextjs';

const nextConfig = {
  // Enable source maps in production for Sentry
  productionBrowserSourceMaps: true,

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Generate source maps for Three.js
      // The 'source-map' devtool gives the most accurate mapping
      // but increases build time. 'hidden-source-map' is a good compromise:
      // it generates source maps but does not add the //# sourceMappingURL
      // comment, so browsers do not download them. Only Sentry uses them.
      config.devtool = 'hidden-source-map';
    }
    return config;
  },
};

export default withSentryConfig(nextConfig, {
  // Upload source maps to Sentry during build
  org: 'your-org',
  project: 'your-project',

  // Suppress source map upload log noise
  silent: true,

  // Delete source maps from Vercel deployment after upload to Sentry
  // This prevents users from accessing source maps via browser
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },

  // Include Three.js and R3F source maps
  // These are the node_modules that matter for WebGL stack traces
  includes: ['./node_modules/three', './node_modules/@react-three'],

  // Widen the source map upload to include vendor chunks
  widenClientFileUpload: true,
});
```

### Sentry Config for Source Map Upload

```ini
# .sentryclirc (or use environment variables)

[auth]
token=sntrys_YOUR_AUTH_TOKEN

[defaults]
org=your-org
project=your-project
```

```bash
# Verify source maps are being uploaded
npx sentry-cli sourcemaps list --org your-org --project your-project
```

### Reading Three.js Stack Traces

Even with source maps, Three.js errors can be cryptic. Map common patterns:

```
Three.js Internal          What It Means
---                        ---
WebGLTextures.upload       Texture format mismatch or size exceeds MAX_TEXTURE_SIZE
WebGLProgram.compile       Shader syntax error or unsupported GLSL feature
WebGLState.enable          Invalid GL enum passed (wrong constant)
WebGLRenderTarget.init     FBO incomplete (attachment dimensions mismatch)
WebGLBufferRenderer.render Draw call with invalid geometry/material combo
WebGLUniforms.upload       Uniform type mismatch (e.g., float uniform with vec3 value)
```

---

## Custom Breadcrumbs

### Breadcrumb Strategy for WebGL Editors

Breadcrumbs tell the story of what happened BEFORE the error.
For a visual effects editor, the critical breadcrumbs are user actions
that change GPU state.

```typescript
// lib/observability/breadcrumbs.ts

import * as Sentry from '@sentry/nextjs';

/**
 * Structured breadcrumb helpers for the effects editor.
 * Each function adds a breadcrumb that will appear in Sentry error reports.
 */
export const Breadcrumbs = {
  // Layer operations
  layerAdded(layerName: string, layerId: string, totalLayers: number): void {
    Sentry.addBreadcrumb({
      category: 'editor.layer',
      message: `Added layer: ${layerName}`,
      level: 'info',
      data: { layerId, layerName, totalLayers },
    });
  },

  layerRemoved(layerName: string, layerId: string, totalLayers: number): void {
    Sentry.addBreadcrumb({
      category: 'editor.layer',
      message: `Removed layer: ${layerName}`,
      level: 'info',
      data: { layerId, layerName, totalLayers },
    });
  },

  layerReordered(layerId: string, fromIndex: number, toIndex: number): void {
    Sentry.addBreadcrumb({
      category: 'editor.layer',
      message: `Reordered layer from ${fromIndex} to ${toIndex}`,
      level: 'info',
      data: { layerId, fromIndex, toIndex },
    });
  },

  layerToggled(layerId: string, active: boolean): void {
    Sentry.addBreadcrumb({
      category: 'editor.layer',
      message: `Layer ${active ? 'enabled' : 'disabled'}`,
      level: 'info',
      data: { layerId, active },
    });
  },

  // Property changes
  propertyChanged(
    layerId: string,
    propertyName: string,
    oldValue: unknown,
    newValue: unknown
  ): void {
    Sentry.addBreadcrumb({
      category: 'editor.property',
      message: `Changed ${propertyName}`,
      level: 'info',
      data: {
        layerId,
        property: propertyName,
        from: String(oldValue),
        to: String(newValue),
      },
    });
  },

  sliderDragStart(layerId: string, propertyName: string): void {
    Sentry.addBreadcrumb({
      category: 'editor.interaction',
      message: `Slider drag start: ${propertyName}`,
      level: 'info',
      data: { layerId, property: propertyName },
    });
  },

  sliderDragEnd(
    layerId: string,
    propertyName: string,
    finalValue: number
  ): void {
    Sentry.addBreadcrumb({
      category: 'editor.interaction',
      message: `Slider drag end: ${propertyName} = ${finalValue}`,
      level: 'info',
      data: { layerId, property: propertyName, value: finalValue },
    });
  },

  // Undo/redo
  undo(actionDescription: string): void {
    Sentry.addBreadcrumb({
      category: 'editor.history',
      message: `Undo: ${actionDescription}`,
      level: 'info',
    });
  },

  redo(actionDescription: string): void {
    Sentry.addBreadcrumb({
      category: 'editor.history',
      message: `Redo: ${actionDescription}`,
      level: 'info',
    });
  },

  // GPU events
  shaderCompiled(materialName: string, durationMs: number): void {
    Sentry.addBreadcrumb({
      category: 'gpu.shader',
      message: `Compiled shader: ${materialName} (${durationMs}ms)`,
      level: 'info',
      data: { material: materialName, duration: durationMs },
    });
  },

  textureUploaded(name: string, width: number, height: number): void {
    Sentry.addBreadcrumb({
      category: 'gpu.texture',
      message: `Uploaded texture: ${name} (${width}x${height})`,
      level: 'info',
      data: { name, width, height },
    });
  },

  renderTargetCreated(
    name: string,
    width: number,
    height: number,
    format: string
  ): void {
    Sentry.addBreadcrumb({
      category: 'gpu.fbo',
      message: `Created render target: ${name} (${width}x${height} ${format})`,
      level: 'info',
      data: { name, width, height, format },
    });
  },

  // Performance events
  fpsDropped(fps: number, previousFps: number): void {
    Sentry.addBreadcrumb({
      category: 'performance',
      message: `FPS dropped: ${previousFps} -> ${fps}`,
      level: 'warning',
      data: { fps, previousFps, drop: previousFps - fps },
    });
  },

  memoryGrowing(textures: number, geometries: number): void {
    Sentry.addBreadcrumb({
      category: 'performance.memory',
      message: `Memory: ${textures} textures, ${geometries} geometries`,
      level: 'warning',
      data: { textures, geometries },
    });
  },

  // Compositor events
  compositorPassStart(passName: string, layerIndex: number): void {
    Sentry.addBreadcrumb({
      category: 'compositor',
      message: `Pass ${layerIndex}: ${passName}`,
      level: 'info',
    });
  },

  compositorError(passName: string, error: string): void {
    Sentry.addBreadcrumb({
      category: 'compositor',
      message: `Pass error: ${passName} - ${error}`,
      level: 'error',
      data: { pass: passName, error },
    });
  },
};
```

### Integrating Breadcrumbs with Zustand Store

```typescript
// lib/observability/storeMiddleware.ts

import { Breadcrumbs } from './breadcrumbs';

/**
 * Zustand middleware that automatically adds breadcrumbs for state changes.
 * Wraps the store's set function to intercept mutations.
 */
export function breadcrumbMiddleware<T extends object>(
  config: (set: any, get: any, api: any) => T
) {
  return (set: any, get: any, api: any) => {
    const wrappedSet = (partial: any, replace?: boolean) => {
      const prevState = get();
      set(partial, replace);
      const nextState = get();

      // Detect layer changes
      if (prevState.layers !== nextState.layers) {
        const prevCount = prevState.layers?.length ?? 0;
        const nextCount = nextState.layers?.length ?? 0;

        if (nextCount > prevCount) {
          const newLayer = nextState.layers[nextCount - 1];
          Breadcrumbs.layerAdded(
            newLayer?.name || 'unknown',
            newLayer?.id || 'unknown',
            nextCount
          );
        } else if (nextCount < prevCount) {
          Breadcrumbs.layerRemoved('unknown', 'unknown', nextCount);
        }
      }
    };

    return config(wrappedSet, get, api);
  };
}
```

---

## GPU Info in Error Context

### Sentry Context Setup

```typescript
// lib/observability/gpuContext.ts

import * as Sentry from '@sentry/nextjs';

/**
 * Set GPU context on Sentry scope.
 * Call once after Canvas is created.
 * This info appears in every error report from this session.
 */
export function setGPUContext(renderer: THREE.WebGLRenderer): void {
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

  const gpuContext: Record<string, string | number | boolean> = {
    renderer: debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    vendor: debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR),
    webgl_version: gl instanceof WebGL2RenderingContext ? '2.0' : '1.0',
    glsl_version: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    max_renderbuffer_size: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    max_vertex_attribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    max_varying_vectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
    max_fragment_uniform_vectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    max_vertex_uniform_vectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
    max_texture_image_units: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    antialiasing: gl.getParameter(gl.SAMPLES) > 0,
    depth_bits: gl.getParameter(gl.DEPTH_BITS),
    stencil_bits: gl.getParameter(gl.STENCIL_BITS),
  };

  // WebGL2-specific caps
  if (gl instanceof WebGL2RenderingContext) {
    gpuContext.max_draw_buffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    gpuContext.max_color_attachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
    gpuContext.max_samples = gl.getParameter(gl.MAX_SAMPLES);
    gpuContext.max_3d_texture_size = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    gpuContext.max_array_texture_layers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
  }

  // Available extensions
  const extensions = gl.getSupportedExtensions() || [];
  gpuContext.extension_count = extensions.length;
  gpuContext.has_float_textures = extensions.includes('EXT_color_buffer_float');
  gpuContext.has_timer_query = extensions.includes(
    'EXT_disjoint_timer_query_webgl2'
  );
  gpuContext.has_anisotropic = extensions.includes(
    'EXT_texture_filter_anisotropic'
  );

  // Set on Sentry scope
  Sentry.setContext('gpu', gpuContext);

  // Also set GPU tier as a tag for easy filtering
  const tier = classifyGPUTier(gpuContext.renderer as string);
  Sentry.setTag('gpu_tier', tier);
  Sentry.setTag('gpu_renderer', (gpuContext.renderer as string).slice(0, 100));
  Sentry.setTag('webgl_version', gpuContext.webgl_version as string);
}

function classifyGPUTier(renderer: string): string {
  const r = renderer.toLowerCase();
  if (r.includes('swiftshader') || r.includes('llvmpipe')) return 'software';
  if (/rtx\s*[3-5]/i.test(r) || /rx\s*[6-7]\d{3}/i.test(r) || /apple\s*m[2-9]/i.test(r))
    return 'high';
  if (/gtx|rtx\s*2|rx\s*5\d{3}|apple\s*m1|iris/i.test(r))
    return 'mid';
  if (/intel.*hd|mali|adreno\s*[3-5]/i.test(r))
    return 'low';
  return 'unknown';
}

/**
 * Update Sentry context with current renderer state.
 * Call periodically (every 30s) or before reporting errors.
 */
export function updateRendererContext(renderer: THREE.WebGLRenderer): void {
  const info = renderer.info;
  Sentry.setContext('renderer_state', {
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    programs: info.programs?.length ?? 0,
    draw_calls: info.render.calls,
    triangles: info.render.triangles,
    frame: info.render.frame,
  });
}
```

---

## Structured Logging

### Log Format

```typescript
// lib/observability/logger.ts

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Structured logger for client-side WebGL operations.
 * In development: logs to console with formatting.
 * In production: batches and sends to logging endpoint.
 */
class StructuredLogger {
  private readonly component: string;
  private readonly buffer: LogEntry[] = [];
  private readonly maxBufferSize: number = 100;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(component: string) {
    this.component = component;

    if (typeof window !== 'undefined' && process.env.NODE_ENV === 'production') {
      // Flush logs every 30 seconds in production
      this.flushTimer = setInterval(() => this.flush(), 30000);

      // Flush on page unload
      window.addEventListener('beforeunload', () => this.flush());
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.log('error', message, data, error);
  }

  private log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: Error
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      data,
      error: error
        ? { name: error.name, message: error.message, stack: error.stack }
        : undefined,
    };

    // Console output in development
    if (process.env.NODE_ENV === 'development') {
      const prefix = `[${this.component}]`;
      switch (level) {
        case 'debug':
          console.debug(prefix, message, data || '');
          break;
        case 'info':
          console.info(prefix, message, data || '');
          break;
        case 'warn':
          console.warn(prefix, message, data || '');
          break;
        case 'error':
          console.error(prefix, message, error || '', data || '');
          break;
      }
    }

    // Buffer for production
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer.length = 0;

    // Send to logging endpoint
    if (typeof navigator?.sendBeacon === 'function') {
      navigator.sendBeacon(
        '/api/logs',
        JSON.stringify({ entries })
      );
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.flush();
  }
}

// Pre-configured loggers for different subsystems
export const logCompositor = new StructuredLogger('compositor');
export const logShader = new StructuredLogger('shader');
export const logTexture = new StructuredLogger('texture');
export const logEditor = new StructuredLogger('editor');
export const logPerf = new StructuredLogger('perf');
export const logContext = new StructuredLogger('webgl-context');
```

### Logging API Endpoint

```typescript
// app/api/logs/route.ts

import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { entries } = body;

    if (!Array.isArray(entries)) {
      return NextResponse.json({ error: 'Invalid format' }, { status: 400 });
    }

    // In production, forward to your logging service
    // (Datadog, Logtail, Axiom, etc.)
    //
    // For development, just log to console
    for (const entry of entries) {
      if (entry.level === 'error' || entry.level === 'warn') {
        console.log(JSON.stringify(entry));
      }
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to process logs' }, { status: 500 });
  }
}
```

---

## Error Categorization

### Error Taxonomy for WebGL Apps

```typescript
// lib/observability/errorCategories.ts

export type ErrorCategory =
  | 'gpu.shader_compilation'
  | 'gpu.context_lost'
  | 'gpu.out_of_memory'
  | 'gpu.texture_error'
  | 'gpu.framebuffer_error'
  | 'gpu.draw_error'
  | 'js.type_error'
  | 'js.reference_error'
  | 'js.range_error'
  | 'js.null_reference'
  | 'network.texture_load'
  | 'network.shader_load'
  | 'network.api_error'
  | 'editor.state_error'
  | 'editor.undo_redo'
  | 'editor.layer_error'
  | 'unknown';

export function categorizeError(error: Error): ErrorCategory {
  const msg = (error.message || '').toLowerCase();
  const name = (error.name || '').toLowerCase();
  const stack = (error.stack || '').toLowerCase();

  // GPU errors
  if (msg.includes('shader') || msg.includes('glsl') || msg.includes('compile'))
    return 'gpu.shader_compilation';
  if (msg.includes('context lost') || msg.includes('context_lost'))
    return 'gpu.context_lost';
  if (msg.includes('out of memory') || msg.includes('oom'))
    return 'gpu.out_of_memory';
  if (msg.includes('texture') && (msg.includes('invalid') || msg.includes('error')))
    return 'gpu.texture_error';
  if (msg.includes('framebuffer') || msg.includes('fbo'))
    return 'gpu.framebuffer_error';
  if (msg.includes('draw') && msg.includes('invalid'))
    return 'gpu.draw_error';

  // Network errors
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('load'))
    return 'network.api_error';

  // JS errors
  if (name === 'typeerror') return 'js.type_error';
  if (name === 'referenceerror') return 'js.reference_error';
  if (name === 'rangeerror') return 'js.range_error';
  if (msg.includes('null') || msg.includes('undefined'))
    return 'js.null_reference';

  // Editor errors (check stack for editor code paths)
  if (stack.includes('undo') || stack.includes('redo'))
    return 'editor.undo_redo';
  if (stack.includes('layer'))
    return 'editor.layer_error';
  if (stack.includes('editor') || stack.includes('store'))
    return 'editor.state_error';

  return 'unknown';
}

/**
 * Assign severity based on error category.
 */
export function getErrorSeverity(
  category: ErrorCategory
): 'critical' | 'error' | 'warning' | 'info' {
  const severityMap: Record<ErrorCategory, 'critical' | 'error' | 'warning' | 'info'> = {
    'gpu.shader_compilation': 'critical',
    'gpu.context_lost': 'warning',
    'gpu.out_of_memory': 'critical',
    'gpu.texture_error': 'error',
    'gpu.framebuffer_error': 'error',
    'gpu.draw_error': 'error',
    'js.type_error': 'error',
    'js.reference_error': 'error',
    'js.range_error': 'warning',
    'js.null_reference': 'error',
    'network.texture_load': 'warning',
    'network.shader_load': 'error',
    'network.api_error': 'warning',
    'editor.state_error': 'error',
    'editor.undo_redo': 'warning',
    'editor.layer_error': 'error',
    'unknown': 'error',
  };

  return severityMap[category];
}
```

### Custom Sentry Fingerprinting

```typescript
// lib/observability/sentryFingerprint.ts

import * as Sentry from '@sentry/nextjs';
import { categorizeError, ErrorCategory } from './errorCategories';

/**
 * Generate a Sentry fingerprint that groups related errors.
 * Without custom fingerprinting, Sentry groups by stack trace,
 * which produces too many groups for GPU errors (same root cause,
 * different stack due to async/animation frame).
 */
export function generateFingerprint(
  error: Error,
  category: ErrorCategory
): string[] {
  switch (category) {
    case 'gpu.shader_compilation':
      // Group by the first line of the GLSL error
      const glslError = error.message.match(/ERROR:\s*\d+:\d+:\s*(.+)/);
      return ['shader-compilation', glslError?.[1] || error.message.slice(0, 80)];

    case 'gpu.context_lost':
      return ['context-lost']; // All context losses are the same issue

    case 'gpu.out_of_memory':
      return ['gpu-oom'];

    case 'gpu.texture_error':
      return ['texture-error', error.message.slice(0, 60)];

    case 'gpu.framebuffer_error':
      return ['fbo-error', error.message.slice(0, 60)];

    case 'editor.undo_redo':
      return ['undo-redo-error', error.message.slice(0, 60)];

    default:
      // Default: let Sentry group by stack trace
      return ['{{ default }}'];
  }
}
```

---

## OpenTelemetry for Render Pipeline

### Tracing Compositor Passes

```typescript
// lib/observability/tracing.ts

/**
 * Lightweight tracing for the render pipeline.
 * Uses Performance API marks/measures rather than full OpenTelemetry SDK
 * to avoid adding weight to the client bundle.
 *
 * For server-side tracing (API routes), use the full OpenTelemetry SDK.
 */

interface Span {
  name: string;
  startTime: number;
  attributes: Record<string, string | number | boolean>;
  end: () => number; // Returns duration in ms
}

export function startSpan(
  name: string,
  attributes: Record<string, string | number | boolean> = {}
): Span {
  const startTime = performance.now();
  const markName = `span:${name}:start`;

  performance.mark(markName);

  return {
    name,
    startTime,
    attributes,
    end: () => {
      const endTime = performance.now();
      const duration = endTime - startTime;

      const endMarkName = `span:${name}:end`;
      performance.mark(endMarkName);

      try {
        performance.measure(`span:${name}`, markName, endMarkName);
      } catch {
        // Measure can fail if marks were cleared
      }

      return duration;
    },
  };
}

/**
 * Trace a full compositor frame, including each pass.
 */
export function traceCompositorFrame(
  frameNumber: number,
  passes: Array<{ name: string; execute: () => void }>
): void {
  const frameSpan = startSpan('compositor.frame', {
    frame: frameNumber,
    passCount: passes.length,
  });

  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const passSpan = startSpan(`compositor.pass.${pass.name}`, {
      index: i,
      name: pass.name,
    });

    pass.execute();

    const duration = passSpan.end();

    // Flag slow passes (> 2ms is concerning for a single pass)
    if (duration > 2) {
      Sentry.addBreadcrumb({
        category: 'compositor.slow-pass',
        message: `Slow pass: ${pass.name} took ${duration.toFixed(1)}ms`,
        level: 'warning',
        data: { pass: pass.name, duration, frame: frameNumber },
      });
    }
  }

  const totalDuration = frameSpan.end();

  // Flag slow frames (> 16ms means we dropped below 60fps)
  if (totalDuration > 16) {
    Sentry.addBreadcrumb({
      category: 'compositor.slow-frame',
      message: `Slow frame: ${totalDuration.toFixed(1)}ms (${passes.length} passes)`,
      level: 'warning',
      data: { duration: totalDuration, passCount: passes.length },
    });
  }
}
```

### Server-Side OpenTelemetry (For API Routes)

```typescript
// lib/observability/otel.ts

// For Next.js API routes that serve primitives, presets, etc.
// This is standard OpenTelemetry, not WebGL-specific.

// instrumentation.ts (Next.js instrumentation file)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Dynamic import to avoid loading on the client
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import(
      '@opentelemetry/exporter-trace-otlp-http'
    );
    const { Resource } = await import('@opentelemetry/resources');

    const sdk = new NodeSDK({
      resource: new Resource({
        'service.name': 'webgl-app',
        'service.version': process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
        'deployment.environment': process.env.VERCEL_ENV || 'development',
      }),
      traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      }),
    });

    sdk.start();
  }
}
```

---

## Vercel Analytics Integration

### Setup

```bash
npm install @vercel/analytics
```

```tsx
// app/layout.tsx

import { Analytics } from '@vercel/analytics/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

### Custom Events for WebGL Actions

```typescript
// lib/observability/analytics.ts

import { track } from '@vercel/analytics';

/**
 * Track WebGL-specific events in Vercel Analytics.
 * These appear in the Vercel dashboard under Custom Events.
 */
export const Analytics = {
  // Track when a user creates their first effect
  effectCreated(effectName: string, totalEffects: number): void {
    track('effect_created', {
      effect: effectName,
      total: totalEffects,
    });
  },

  // Track export/save actions
  projectExported(format: string, layerCount: number): void {
    track('project_exported', {
      format,
      layers: layerCount,
    });
  },

  // Track GPU compatibility issues
  gpuFallback(reason: string, gpuTier: string): void {
    track('gpu_fallback', {
      reason,
      tier: gpuTier,
    });
  },

  // Track performance issues
  performanceIssue(type: string, value: number): void {
    track('perf_issue', {
      type,
      value,
    });
  },

  // Track feature usage for product decisions
  featureUsed(feature: string): void {
    track('feature_used', {
      feature,
    });
  },
};
```

---

## Alert Routing and Escalation

### Alert Priority Matrix

```
Category                    Severity    Route To           Action
---                         ---         ---                ---
gpu.shader_compilation      CRITICAL    #eng-gpu           Fix immediately, hotfix deploy
gpu.out_of_memory           CRITICAL    #eng-gpu           Identify leak, hotfix
gpu.context_lost (>1%)      WARNING     #eng-gpu           Investigate GPU-specific cause
js.type_error (new)         ERROR       #eng-general       Fix in next release
network.api_error (>5%)     ERROR       #eng-infra         Check Vercel status, CDN
editor.state_error          ERROR       #eng-editor        Fix state management bug
performance (FPS <30 p50)   WARNING     #eng-perf          Profile and optimize
```

### Sentry Alert Rules

```yaml
# sentry-alerts.yml (conceptual, configure in Sentry UI)

alerts:
  - name: "Shader Compilation Failure"
    conditions:
      - event_count > 5 in 1 hour
      - tag: error_type = shader
    actions:
      - notify: slack:#eng-gpu
      - create: jira ticket (priority: high)

  - name: "Context Loss Spike"
    conditions:
      - event_count > 50 in 1 hour
      - tag: webgl_event = context-lost
    actions:
      - notify: slack:#eng-gpu
      - notify: pagerduty (if > 200)

  - name: "GPU OOM"
    conditions:
      - event_count > 1 in 5 minutes
      - tag: error_type = gpu.out_of_memory
    actions:
      - notify: slack:#eng-gpu (urgent)
      - create: jira ticket (priority: critical)

  - name: "New Error in Production"
    conditions:
      - first_seen_in: production
      - event_count > 3 in 10 minutes
    actions:
      - notify: slack:#eng-general
```

---

## Debugging Production Issues

### Triage Checklist

```
When a WebGL error is reported in production:

1. CHECK SENTRY
   - Read the error message and stack trace
   - Check the GPU context (which GPU, which browser)
   - Read the breadcrumbs (what did the user do before the error?)
   - Check the session replay (if available)
   - Look at the error's first_seen date (is this new?)

2. CHECK SEGMENTATION
   - Is this error specific to one GPU vendor? (Sentry: gpu_tier tag)
   - Is this error specific to one browser? (Sentry: browser tag)
   - Is this error specific to one OS? (Sentry: os tag)
   - Did this start after a deployment? (Sentry: release tag)

3. REPRODUCE LOCALLY
   - Match the GPU (use WebGL report extension for Chrome)
   - Match the browser version
   - Follow the breadcrumb trail to reproduce the user's actions
   - If GPU-specific: use ANGLE backend switching to test different GPU emulation

4. FIX AND VERIFY
   - Write a test that reproduces the error
   - Fix the code
   - Deploy to preview environment
   - Verify fix in Sentry (error rate drops to zero)
   - Monitor for 24 hours after deploy
```

### Common Investigation Patterns

```typescript
// Quick diagnostic functions for production debugging

/**
 * Dump full WebGL state for a support ticket.
 * Users can run this in the browser console.
 */
(window as any).__dumpWebGLDiagnostics = function () {
  const canvas = document.querySelector('canvas');
  if (!canvas) return 'No canvas found';

  const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
  if (!gl) return 'No WebGL2 context';

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

  return {
    renderer: debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : 'unknown',
    vendor: debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : 'unknown',
    version: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxViewportDims: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
    contextLost: gl.isContextLost(),
    extensions: gl.getSupportedExtensions()?.length,
    screen: `${window.screen.width}x${window.screen.height}`,
    dpr: window.devicePixelRatio,
    userAgent: navigator.userAgent,
  };
};
```
