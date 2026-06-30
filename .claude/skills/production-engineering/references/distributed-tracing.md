# Distributed Tracing for WebGL Applications

> OpenTelemetry setup, W3C TraceContext propagation, client-side spans for shader compilation and scene loading, server-side API tracing, sampling strategy, exporter configuration for Honeycomb/Jaeger/Datadog, and trace-based performance budget alerting for Three.js/R3F production apps on Vercel.

## Table of Contents

1. [Why Tracing for WebGL Apps](#why-tracing-for-webgl-apps)
2. [OpenTelemetry Setup](#opentelemetry-setup)
3. [Trace Context Propagation](#trace-context-propagation)
4. [Client-Side Spans](#client-side-spans)
5. [Server-Side Spans](#server-side-spans)
6. [Scene Load Waterfall](#scene-load-waterfall)
7. [Sampling Strategy](#sampling-strategy)
8. [Exporter Configuration](#exporter-configuration)
9. [Performance Budget Monitoring](#performance-budget-monitoring)
10. [Anti-Patterns](#anti-patterns)

---

## Why Tracing for WebGL Apps

### The Visibility Problem

Traditional APM tools instrument HTTP requests and database queries well. WebGL
applications have an entirely different latency profile that these tools miss:

```
User clicks "Load Scene"
  │
  ├─ [Network] Fetch scene JSON from CDN              ~40-200ms
  │
  ├─ [JS] Parse scene JSON, build node graph          ~5-50ms
  │
  ├─ [Network] Fetch textures (parallel)              ~100-2000ms
  │
  ├─ [GPU] Upload textures to VRAM                    ~10-300ms
  │
  ├─ [GPU] Compile GLSL shaders                       ~50-800ms  ← invisible to APM
  │
  ├─ [GPU] Allocate FBOs, set up compositor           ~5-50ms    ← invisible to APM
  │
  └─ [GPU] First rendered frame                       ~8-33ms    ← invisible to APM
```

Without tracing the full chain, you cannot answer:
- Why does the editor feel slow on some machines? (Shader compilation. Invisible without spans.)
- Why does the embed take 4s to load in Germany? (CDN miss on textures, not API latency.)
- Which scenes have regressions after a shader refactor? (No baseline without traces.)
- Is slow time-to-first-render caused by network or GPU work? (You cannot tell from RUM alone.)

### What Distributed Tracing Adds

A single trace covers the full causal chain: user interaction on the client,
through the network, through the Next.js API route on Vercel, through any CDN
or external service, back to the client, and into the WebGL pipeline.

Every span carries the same `trace-id`, so a timeline in your trace backend
shows the waterfall across all systems for a single user operation.

---

## OpenTelemetry Setup

### Package Installation

```bash
# Core API — isomorphic, safe to import everywhere
npm install @opentelemetry/api

# Node.js SDK — server-side only (API routes, instrumentation.ts)
npm install @opentelemetry/sdk-node

# Vercel's official OTEL integration for Next.js
npm install @vercel/otel

# Propagators and exporters
npm install @opentelemetry/propagator-b3
npm install @opentelemetry/exporter-trace-otlp-http
npm install @opentelemetry/sdk-trace-web
npm install @opentelemetry/instrumentation-fetch
npm install @opentelemetry/instrumentation-xml-http-request
```

### Server-Side Instrumentation — `instrumentation.ts`

Next.js 15 calls `instrumentation.ts` once per server process. Place it at the
project root (next to `package.json`).

```typescript
// instrumentation.ts

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerOTel } = await import('@vercel/otel');

    registerOTel({
      serviceName: 'webgl-app-nodes',

      // Attributes attached to every span from this service
      resourceAttributes: {
        'service.version': process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
        'deployment.environment': process.env.VERCEL_ENV ?? 'development',
        'deployment.region': process.env.VERCEL_REGION ?? 'unknown',
      },
    });
  }
}
```

`@vercel/otel` handles the OTLP exporter configuration automatically in the
Vercel runtime when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in environment
variables. No manual exporter setup is required for Vercel deployments.

### Client-Side Tracer Initialization

The browser SDK must be initialized once, before any spans are created. Do this
in a module that is imported early in the app lifecycle.

```typescript
// lib/tracing/client-tracer.ts

import {
  WebTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { Resource } from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { context, propagation, trace } from '@opentelemetry/api';

let _provider: WebTracerProvider | null = null;

export function initClientTracing(): void {
  if (_provider !== null) return; // Already initialized.
  if (typeof window === 'undefined') return; // Guard against SSR.

  const exporter = new OTLPTraceExporter({
    url: '/api/tracing/ingest', // Proxy through our own API route (avoids CORS).
    headers: {
      'Content-Type': 'application/json',
    },
  });

  _provider = new WebTracerProvider({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'webgl-app-browser',
      [SEMRESATTRS_SERVICE_VERSION]:
        process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
      'browser.user_agent': navigator.userAgent,
      'device.memory_gb': (navigator as any).deviceMemory ?? 'unknown',
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 512,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 5_000,
      }),
      // Only enable console exporter in local dev.
      ...(process.env.NODE_ENV === 'development'
        ? [new BatchSpanProcessor(new ConsoleSpanExporter())]
        : []),
    ],
  });

  // W3C TraceContext is the standard. Use it for client↔server correlation.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  _provider.register();

  // Auto-instrument all fetch() calls to inject traceparent headers.
  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: [
          // Allow trace header injection for our own origin only.
          new RegExp(`^${window.location.origin}`),
        ],
        clearTimingResources: true,
      }),
    ],
  });
}

export function getTracer(name: string) {
  return trace.getTracer(name, process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0');
}

// Call in _app.tsx or the root layout.
// initClientTracing();
```

---

## Trace Context Propagation

### W3C TraceContext Standard

The W3C TraceContext specification (RFC) defines two HTTP headers:

```
traceparent: 00-{trace-id}-{parent-span-id}-{flags}
             00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │               └─ sampled=1
             │  │                                └─ parent span ID (16 hex chars)
             │  └─ trace ID (32 hex chars, globally unique)
             └─ version (always 00)

tracestate:  vendor-specific state (optional, ignore unless using multiple vendors)
```

When `FetchInstrumentation` is active, it injects `traceparent` automatically
into every `fetch()` call. The Next.js API route then reads this header to
continue the same trace on the server side.

### Client-to-Server Correlation

```typescript
// lib/tracing/propagation.ts

import { context, propagation, trace } from '@opentelemetry/api';

/**
 * Extract trace context from incoming request headers (server-side).
 * Use in API route handlers to continue a client-initiated trace.
 */
export function extractTraceContext(headers: Headers): ReturnType<typeof context.active> {
  const carrier: Record<string, string> = {};
  headers.forEach((value, key) => {
    carrier[key] = value;
  });
  return propagation.extract(context.active(), carrier);
}

/**
 * Inject trace context into outgoing fetch headers (client-side).
 * Use when constructing headers manually, bypassing FetchInstrumentation.
 */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  const carrier = { ...headers };
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Get the current trace ID as a string.
 * Useful for adding to Sentry breadcrumbs or log statements.
 */
export function getCurrentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  return ctx.isValid ? ctx.traceId : undefined;
}
```

### Linking Client Traces to Sentry Errors

```typescript
// In your Sentry beforeSend, attach the trace ID so you can correlate:

import * as Sentry from '@sentry/nextjs';
import { getCurrentTraceId } from '@/lib/tracing/propagation';

Sentry.init({
  beforeSend(event) {
    const traceId = getCurrentTraceId();
    if (traceId) {
      event.tags = { ...event.tags, trace_id: traceId };
    }
    return event;
  },
});
```

---

## Client-Side Spans

### Shader Compilation Span

GLSL compilation is synchronous and can block for 50–800ms on first compile.
Always wrap it in a span so you can see which shaders are slow.

```typescript
// lib/tracing/spans/shaderCompilation.ts

import { SpanStatusCode } from '@opentelemetry/api';
import { getTracer } from '@/lib/tracing/client-tracer';
import type { WebGLRenderer } from 'three';

const tracer = getTracer('webgl-app.shader');

/**
 * Wrap a shader compilation operation with a trace span.
 *
 * @param shaderName  Human-readable name, e.g. "StarsShader", "GradientMesh"
 * @param compile     The compilation function — must be synchronous or return a promise.
 */
export async function traceShaderCompilation<T>(
  shaderName: string,
  compile: () => T | Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    'shader.compile',
    {
      attributes: {
        'shader.name': shaderName,
        'webgl.operation': 'compile',
      },
    },
    async (span) => {
      try {
        const result = await compile();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Record shader program link status after compilation.
 * Call after renderer.compile() or manually triggering a program link.
 */
export function recordShaderLinkStatus(
  span: import('@opentelemetry/api').Span,
  renderer: WebGLRenderer,
  programCount: number,
): void {
  const info = renderer.info;
  span.setAttributes({
    'shader.programs_total': info.programs?.length ?? 0,
    'shader.programs_compiled': programCount,
    'webgl.memory.textures': info.memory.textures,
    'webgl.memory.geometries': info.memory.geometries,
    'webgl.render.calls': info.render.calls,
    'webgl.render.triangles': info.render.triangles,
  });
}
```

### Scene Loading Span

```typescript
// lib/tracing/spans/sceneLoad.ts

import { SpanStatusCode, trace, context } from '@opentelemetry/api';
import { getTracer } from '@/lib/tracing/client-tracer';

const tracer = getTracer('webgl-app.scene');

export interface SceneLoadMetrics {
  nodeCount: number;
  textureCount: number;
  shaderCount: number;
  sceneId: string;
}

/**
 * Root span for the entire scene load sequence.
 * All child spans (JSON fetch, texture upload, shader compile) should be
 * created while this span is active.
 */
export async function traceSceneLoad<T>(
  sceneId: string,
  load: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    'scene.load',
    {
      attributes: {
        'scene.id': sceneId,
        'scene.load_triggered_at': Date.now(),
      },
    },
    async (rootSpan) => {
      try {
        const result = await load();
        rootSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        rootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        rootSpan.recordException(err as Error);
        throw err;
      } finally {
        rootSpan.end();
      }
    },
  );
}

/**
 * Span for the first rendered frame after scene load.
 * Measures GPU time from scene-ready to pixels on screen.
 */
export function recordFirstRender(
  sceneId: string,
  durationMs: number,
  frameNumber: number,
): void {
  const span = tracer.startSpan('scene.first_render', {
    attributes: {
      'scene.id': sceneId,
      'render.duration_ms': durationMs,
      'render.frame_number': frameNumber,
      'render.timestamp': Date.now(),
    },
  });
  span.end();
}
```

### FBO Allocation Span

```typescript
// lib/tracing/spans/fboAllocation.ts

import { getTracer } from '@/lib/tracing/client-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

const tracer = getTracer('webgl-app.fbo');

export interface FBOAllocationParams {
  name: string;
  width: number;
  height: number;
  format: string; // e.g. 'RGBA16F', 'RGBA8'
  isDoubleBuffer: boolean;
}

export async function traceFBOAllocation<T>(
  params: FBOAllocationParams,
  allocate: () => T | Promise<T>,
): Promise<T> {
  const bytesEstimate =
    params.width *
    params.height *
    (params.format.includes('32F') ? 16 : params.format.includes('16F') ? 8 : 4) *
    (params.isDoubleBuffer ? 2 : 1);

  return tracer.startActiveSpan(
    'fbo.allocate',
    {
      attributes: {
        'fbo.name': params.name,
        'fbo.width': params.width,
        'fbo.height': params.height,
        'fbo.format': params.format,
        'fbo.double_buffer': params.isDoubleBuffer,
        'fbo.estimated_bytes': bytesEstimate,
        'fbo.estimated_mb': parseFloat((bytesEstimate / (1024 * 1024)).toFixed(2)),
      },
    },
    async (span) => {
      try {
        const result = await allocate();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
```

---

## Server-Side Spans

### API Route Tracing

```typescript
// app/api/scenes/[sceneId]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { extractTraceContext } from '@/lib/tracing/propagation';

const tracer = trace.getTracer('webgl-app.api');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sceneId: string }> },
): Promise<NextResponse> {
  const { sceneId } = await params;

  // Continue the trace from the client by extracting traceparent header.
  const parentCtx = extractTraceContext(request.headers);

  return tracer.startActiveSpan(
    'api.scenes.get',
    {
      attributes: {
        'http.method': 'GET',
        'http.route': '/api/scenes/[sceneId]',
        'scene.id': sceneId,
        'http.user_agent': request.headers.get('user-agent') ?? 'unknown',
      },
    },
    parentCtx,
    async (span) => {
      try {
        // Child span for database query.
        const scene = await tracer.startActiveSpan(
          'db.scenes.findUnique',
          {
            attributes: {
              'db.operation': 'SELECT',
              'db.table': 'scenes',
              'db.scene_id': sceneId,
            },
          },
          async (dbSpan) => {
            try {
              // Actual Prisma query here.
              const result = await prisma.scene.findUnique({
                where: { id: sceneId },
              });
              dbSpan.setStatus({ code: SpanStatusCode.OK });
              return result;
            } finally {
              dbSpan.end();
            }
          },
        );

        if (!scene) {
          span.setAttributes({ 'http.status_code': 404 });
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Scene not found' });
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }

        span.setAttributes({ 'http.status_code': 200 });
        span.setStatus({ code: SpanStatusCode.OK });
        return NextResponse.json(scene);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
      } finally {
        span.end();
      }
    },
  );
}
```

### CDN Upload Span

```typescript
// lib/tracing/spans/cdnUpload.ts

import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('webgl-app.cdn');

export async function traceObjectStoreUpload(
  key: string,
  bytes: number,
  upload: () => Promise<void>,
): Promise<void> {
  return tracer.startActiveSpan(
    'cdn.object-store.upload',
    {
      attributes: {
        'cdn.provider': 'object-store',
        'cdn.key': key,
        'cdn.bytes': bytes,
        'cdn.mb': parseFloat((bytes / (1024 * 1024)).toFixed(2)),
      },
    },
    async (span) => {
      try {
        await upload();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
```

### Tracing Proxy API Route

Client spans are exported to `/api/tracing/ingest` to avoid CORS issues with
direct OTLP exporter calls to third-party backends.

```typescript
// app/api/tracing/ingest/route.ts
// Receives OTLP/JSON from the browser and forwards to the real backend.

import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // Silently drop in environments where tracing is not configured.
    return NextResponse.json({ status: 'dropped' });
  }

  const body = await request.text();

  const response = await fetch(`${endpoint}/v1/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-honeycomb-team': process.env.HONEYCOMB_API_KEY ?? '',
    },
    body,
  });

  return NextResponse.json(
    { status: response.ok ? 'ok' : 'error' },
    { status: response.status },
  );
}
```

---

## Scene Load Waterfall

### Full Embed Loading Sequence

The following shows how to instrument the complete loading sequence for an
embeddable WebGL runtime, from initial HTML parse to first rendered frame.

```typescript
// lib/embed/loader.ts

import { getTracer } from '@/lib/tracing/client-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

const tracer = getTracer('webgl-app.embed');

export async function loadEmbeddedScene(sceneId: string): Promise<void> {
  // Root span: covers everything from "user triggered load" to "first frame".
  return tracer.startActiveSpan(
    'embed.load',
    { attributes: { 'scene.id': sceneId } },
    async (rootSpan) => {
      const t0 = performance.now();

      try {
        // Step 1: Fetch scene JSON from CDN.
        const sceneJson = await tracer.startActiveSpan(
          'embed.fetch_scene_json',
          async (span) => {
            const url = `/api/scenes/${sceneId}`;
            const res = await fetch(url); // FetchInstrumentation injects traceparent.
            span.setAttributes({
              'http.url': url,
              'http.status_code': res.status,
            });
            if (!res.ok) {
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw new Error(`Scene fetch failed: ${res.status}`);
            }
            const json = await res.json();
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return json;
          },
        );

        // Step 2: Parse node graph.
        const parsedScene = await tracer.startActiveSpan(
          'embed.parse_node_graph',
          async (span) => {
            const nodeCount = sceneJson.nodes?.length ?? 0;
            span.setAttributes({ 'scene.node_count': nodeCount });
            const result = parseSceneJSON(sceneJson); // Your parser here.
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
          },
        );

        // Step 3: Fetch textures in parallel.
        const textureUrls: string[] = collectTextureUrls(parsedScene);
        await tracer.startActiveSpan(
          'embed.fetch_textures',
          { attributes: { 'texture.count': textureUrls.length } },
          async (span) => {
            await Promise.all(textureUrls.map(fetchAndUploadTexture));
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          },
        );

        // Step 4: Compile shaders.
        await tracer.startActiveSpan(
          'embed.compile_shaders',
          async (span) => {
            const shaderCount = countShaders(parsedScene);
            span.setAttributes({ 'shader.count': shaderCount });
            await compileAllShaders(parsedScene);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          },
        );

        // Step 5: Allocate FBOs and compositor.
        await tracer.startActiveSpan(
          'embed.setup_compositor',
          async (span) => {
            await setupCompositor(parsedScene);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          },
        );

        // Step 6: First render.
        const firstRenderStart = performance.now();
        await tracer.startActiveSpan(
          'embed.first_render',
          async (span) => {
            await renderFrame();
            const duration = performance.now() - firstRenderStart;
            span.setAttributes({
              'render.first_frame_ms': parseFloat(duration.toFixed(2)),
            });
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          },
        );

        const totalDuration = performance.now() - t0;
        rootSpan.setAttributes({
          'embed.total_load_ms': parseFloat(totalDuration.toFixed(2)),
          'embed.success': true,
        });
        rootSpan.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        rootSpan.recordException(err as Error);
        rootSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        rootSpan.end();
      }
    },
  );
}
```

---

## Sampling Strategy

### Head-Based vs Tail-Based

```
Head-based sampling:
  Decision made at the START of the trace (before any spans are created).
  Pros:  Low overhead, simple to implement, no buffering.
  Cons:  Cannot guarantee sampling interesting traces (errors might not be sampled).
  Use:   Normal traffic at low rates (1-10%).

Tail-based sampling:
  Decision made AFTER the trace completes (you can see the outcome).
  Pros:  Always sample errors and slow traces. Discard boring fast successes.
  Cons:  Requires a collector/agent to buffer traces before export. Higher cost.
  Use:   When you want 100% error coverage + cost efficiency.
```

A WebGL app should use a combination: low-rate head sampling for normal traffic,
plus 100% sampling for errors and slow traces via the collector.

### Sampling Configuration

```typescript
// lib/tracing/sampler.ts

import {
  Sampler,
  SamplingDecision,
  SamplingResult,
  SpanKind,
  Attributes,
  Link,
  Context,
  TraceFlags,
} from '@opentelemetry/api';

/**
 * Custom sampler:
 * - Always sample spans with error status (set before span start via parent).
 * - Always sample spans on the /api/tracing/ingest route (no recursion).
 * - Sample embed.load root spans at 100% (first load is the most valuable trace).
 * - Sample everything else at 10%.
 */
export class WebGLAppSampler implements Sampler {
  private readonly baseRate: number;

  constructor(baseRate = 0.1) {
    this.baseRate = baseRate;
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    // Always sample the full scene load waterfall.
    if (spanName === 'embed.load') {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    // Always sample shader compilation errors.
    if (
      spanName === 'shader.compile' &&
      attributes['webgl.compile_error'] === true
    ) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    // Probabilistic for everything else.
    const random = this.deterministicRandom(traceId);
    if (random < this.baseRate) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    return { decision: SamplingDecision.NOT_RECORD };
  }

  toString(): string {
    return `WebGLAppSampler(baseRate=${this.baseRate})`;
  }

  /**
   * Deterministic sampling: same trace ID always makes the same decision.
   * This ensures all spans in a trace share the same sampling outcome,
   * even when created at different times or in different processes.
   */
  private deterministicRandom(traceId: string): number {
    // Use the last 8 hex characters of the trace ID as a uint32.
    const hex = traceId.slice(-8);
    const value = parseInt(hex, 16);
    return value / 0xffffffff;
  }
}
```

---

## Exporter Configuration

### Honeycomb

```typescript
// lib/tracing/exporters/honeycomb.ts

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export function createHoneycombExporter(): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: 'https://api.honeycomb.io/v1/traces',
    headers: {
      'x-honeycomb-team': process.env.HONEYCOMB_API_KEY!,
      'x-honeycomb-dataset': process.env.HONEYCOMB_DATASET ?? 'webgl-app-production',
    },
  });
}
```

```bash
# .env.local (never commit)
HONEYCOMB_API_KEY=hcaik_...
HONEYCOMB_DATASET=webgl-app-production

# Vercel environment variables (set via dashboard or CLI):
# vercel env add HONEYCOMB_API_KEY production
```

### Jaeger (Self-hosted)

```typescript
// lib/tracing/exporters/jaeger.ts

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export function createJaegerExporter(): OTLPTraceExporter {
  // Jaeger accepts OTLP/HTTP on port 4318 by default.
  return new OTLPTraceExporter({
    url: `${process.env.JAEGER_ENDPOINT ?? 'http://localhost:4318'}/v1/traces`,
  });
}
```

```yaml
# docker-compose.yml — local Jaeger for development
services:
  jaeger:
    image: jaegertracing/all-in-one:1.55
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "16686:16686"   # Jaeger UI
      - "4317:4317"     # OTLP gRPC
      - "4318:4318"     # OTLP HTTP
```

### Datadog

```typescript
// lib/tracing/exporters/datadog.ts

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export function createDatadogExporter(): OTLPTraceExporter {
  // Datadog agent must be running and accepting OTLP.
  // Set DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT in the agent config.
  return new OTLPTraceExporter({
    url: `${process.env.DD_AGENT_HOST ?? 'http://localhost'}:${
      process.env.DD_OTLP_HTTP_PORT ?? '4318'
    }/v1/traces`,
    headers: {
      'DD-API-KEY': process.env.DD_API_KEY!,
    },
  });
}
```

### Vercel OTEL (Zero-config for Vercel deployments)

When `@vercel/otel` is used in `instrumentation.ts`, set only these environment
variables in the Vercel dashboard and no exporter code is needed:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=hcaik_...,x-honeycomb-dataset=webgl-app
```

Vercel automatically routes traces through its built-in OTLP pipeline when
these are set.

---

## Performance Budget Monitoring

### Threshold Definitions

```typescript
// lib/tracing/budgets.ts

export const PERFORMANCE_BUDGETS = {
  // Scene load: time from user action to first rendered frame.
  'embed.load': {
    p50Ms: 800,
    p95Ms: 2_500,
    p99Ms: 5_000,
  },

  // Individual shader compilation.
  'shader.compile': {
    p50Ms: 50,
    p95Ms: 300,
    p99Ms: 600,
  },

  // Scene JSON fetch from CDN.
  'embed.fetch_scene_json': {
    p50Ms: 100,
    p95Ms: 400,
    p99Ms: 1_000,
  },

  // Texture upload to GPU.
  'embed.fetch_textures': {
    p50Ms: 200,
    p95Ms: 1_200,
    p99Ms: 3_000,
  },

  // FBO allocation and compositor setup.
  'embed.setup_compositor': {
    p50Ms: 20,
    p95Ms: 80,
    p99Ms: 200,
  },

  // First frame render time.
  'embed.first_render': {
    p50Ms: 16,
    p95Ms: 50,
    p99Ms: 100,
  },
} as const;
```

### Honeycomb SLO Alert Query

```
# Honeycomb: Create this derived column and trigger alert when threshold exceeded.

# Derived column: embed_load_p95
PERCENTILE(duration_ms, 95)
WHERE span_name = 'embed.load'
GROUP BY deployment.environment

# Alert rule:
# Condition: embed_load_p95 > 2500
# Window:    1 hour rolling
# Notify:    PagerDuty / Slack #incidents
```

### Client-Side Budget Enforcement

```typescript
// lib/tracing/budget-enforcer.ts

import { PERFORMANCE_BUDGETS } from './budgets';

type SpanName = keyof typeof PERFORMANCE_BUDGETS;

/**
 * After a span completes, check its duration against the budget.
 * Log a warning (captured by Sentry) if it exceeds p95.
 */
export function checkSpanBudget(spanName: SpanName, durationMs: number): void {
  const budget = PERFORMANCE_BUDGETS[spanName];
  if (!budget) return;

  if (durationMs > budget.p99Ms) {
    console.error(
      `[PerformanceBudget] ${spanName} exceeded p99 budget: ` +
        `${durationMs.toFixed(0)}ms > ${budget.p99Ms}ms`,
    );
  } else if (durationMs > budget.p95Ms) {
    console.warn(
      `[PerformanceBudget] ${spanName} exceeded p95 budget: ` +
        `${durationMs.toFixed(0)}ms > ${budget.p95Ms}ms`,
    );
  }
}
```

---

## Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| Creating spans inside the render loop | `requestAnimationFrame` fires 60 times/second. Span overhead accumulates, exporters flood, trace backends receive millions of useless spans. | Only create spans for discrete operations: load, compile, allocate. Never per-frame. |
| Exporting directly from the browser to Honeycomb/Datadog | Third-party OTLP endpoints block cross-origin requests. Also leaks your API key to the browser. | Proxy through `/api/tracing/ingest`. Keep API keys server-side only. |
| Using non-deterministic sampling | If each span makes an independent random sampling decision, a single trace gets partially sampled. The trace backend receives orphaned spans with no root. | Use deterministic sampling based on the trace ID so all spans in a trace share the same decision. |
| 100% sampling in production | WebGL apps generate many spans per session. At scale this can cost hundreds of dollars per month in trace storage. | Use 10% head-based sampling for normal traffic. 100% only for error and slow-path traces. |
| Ignoring `tracestate` header | If multiple vendors are in the pipeline, dropping `tracestate` loses vendor-specific correlation data. | Preserve and propagate `tracestate` unchanged even if you do not use it. |
| Creating a new `WebTracerProvider` per component mount | Multiple providers conflict with each other. The global propagator gets replaced. | Initialize the provider once at app startup. Use a singleton guard (`if (_provider !== null) return`). |
| Naming spans with dynamic IDs | `scene.load.a1b2c3d4` means every scene creates a new span name. Trace backends index on span names — this creates unbounded cardinality and breaks aggregation. | Use `scene.load` as the span name. Put the scene ID in an attribute (`scene.id`). |
| Swallowing exceptions in span catch blocks | `span.recordException(err)` is called but the error is not rethrown. The caller never sees the error. Loading silently fails. | Always rethrow after recording. Never suppress. |

---

## See Also

- [error-tracking-observability.md](./error-tracking-observability.md) — Sentry integration, structured logging, breadcrumbs. Attach `trace_id` to Sentry errors for cross-tool correlation.
- [performance-monitoring-production.md](./performance-monitoring-production.md) — RUM metrics, Core Web Vitals, Vercel Analytics. Traces complement RUM: RUM shows aggregated percentiles, traces show individual request waterfalls.
