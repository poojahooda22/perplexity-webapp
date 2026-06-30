# Error Boundaries for WebGL/R3F Applications

> Production-tested patterns for catching and recovering from GPU errors in React + Three.js + React Three Fiber applications.

## Table of Contents

1. [Error Boundary Fundamentals for GPU Apps](#error-boundary-fundamentals-for-gpu-apps)
2. [R3F-Specific Error Handling](#r3f-specific-error-handling)
3. [Error Boundary Hierarchy](#error-boundary-hierarchy)
4. [Fallback UI Patterns](#fallback-ui-patterns)
5. [Recovery Strategies](#recovery-strategies)
6. [Three.js Error Events](#threejs-error-events)
7. [Production Error Boundary Implementation](#production-error-boundary-implementation)
8. [Testing Error Boundaries](#testing-error-boundaries)
9. [Common GPU Error Signatures](#common-gpu-error-signatures)
10. [Anti-Patterns and Pitfalls](#anti-patterns-and-pitfalls)

---

## Error Boundary Fundamentals for GPU Apps

### Why Standard Error Boundaries Are Not Enough

React error boundaries catch errors during rendering, lifecycle methods, and constructors.
GPU errors are different:
- They happen asynchronously (shader compilation, texture upload, draw calls).
- They do NOT propagate through React's error boundary mechanism.
- WebGL context loss is an EVENT, not a thrown error.
- Some GPU errors silently produce black screens with no exception.

You need a DUAL strategy:
1. React ErrorBoundary for JS-level errors in the render tree.
2. Event listeners for WebGL context events and Three.js errors.

### Base Error Boundary for Canvas

```tsx
// lib/error-boundaries/CanvasErrorBoundary.tsx

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface CanvasErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  resetKeys?: unknown[];
}

interface CanvasErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorType: 'js' | 'gpu' | 'context-loss' | null;
  retryCount: number;
}

const MAX_AUTO_RETRIES = 2;

export class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  state: CanvasErrorBoundaryState = {
    hasError: false,
    error: null,
    errorType: null,
    retryCount: 0,
  };

  static getDerivedStateFromError(error: Error): Partial<CanvasErrorBoundaryState> {
    const errorType = classifyError(error);
    return {
      hasError: true,
      error,
      errorType,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { onError } = this.props;

    // Log with GPU context
    const gpuInfo = getGPUInfo();
    console.error('[CanvasErrorBoundary] Caught error:', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      gpu: gpuInfo,
      retryCount: this.state.retryCount,
    });

    // Report to error tracking (Sentry, etc.)
    if (onError) {
      onError(error, errorInfo);
    }
  }

  componentDidUpdate(prevProps: CanvasErrorBoundaryProps): void {
    // Reset when resetKeys change (e.g., user navigated away and back)
    if (this.state.hasError && this.props.resetKeys) {
      const changed = this.props.resetKeys.some(
        (key, i) => key !== prevProps.resetKeys?.[i]
      );
      if (changed) {
        this.handleReset();
      }
    }
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorType: null,
      retryCount: 0,
    });
    this.props.onReset?.();
  };

  handleRetry = (): void => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      errorType: null,
      retryCount: prev.retryCount + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <GPUErrorFallback
          error={this.state.error}
          errorType={this.state.errorType}
          retryCount={this.state.retryCount}
          maxRetries={MAX_AUTO_RETRIES}
          onRetry={this.handleRetry}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}
```

### Error Classification

```tsx
// lib/error-boundaries/classifyError.ts

type ErrorType = 'js' | 'gpu' | 'context-loss';

const GPU_ERROR_PATTERNS = [
  /WebGL/i,
  /GL_/,
  /shader/i,
  /GLSL/i,
  /framebuffer/i,
  /texture/i,
  /render target/i,
  /context lost/i,
  /GPU/i,
  /out of memory/i,
  /OOM/i,
  /too many/i,
  /maximum.*exceeded/i,
];

const CONTEXT_LOSS_PATTERNS = [
  /context.*lost/i,
  /context.*restored/i,
  /CONTEXT_LOST_WEBGL/i,
];

export function classifyError(error: Error): ErrorType {
  const message = error.message || '';
  const name = error.name || '';
  const combined = `${name} ${message}`;

  for (const pattern of CONTEXT_LOSS_PATTERNS) {
    if (pattern.test(combined)) return 'context-loss';
  }

  for (const pattern of GPU_ERROR_PATTERNS) {
    if (pattern.test(combined)) return 'gpu';
  }

  return 'js';
}

export function getGPUInfo(): Record<string, string> {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { renderer: 'unknown', vendor: 'unknown' };

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const result: Record<string, string> = {
      renderer: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : 'unknown',
      vendor: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : 'unknown',
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: String(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      maxRenderbufferSize: String(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
    };

    // Clean up
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();

    return result;
  } catch {
    return { renderer: 'unavailable', vendor: 'unavailable' };
  }
}
```

---

## R3F-Specific Error Handling

### Canvas-Level Error Boundary

R3F's `<Canvas>` component creates its own React reconciler. Errors inside the R3F
scene tree do NOT bubble up to React DOM error boundaries by default in older versions.
Modern R3F (v8+) improved this, but you should still handle both layers.

```tsx
// lib/error-boundaries/R3FCanvasWrapper.tsx

import React, { Suspense, useCallback, useRef, useState } from 'react';
import { Canvas, CanvasProps } from '@react-three/fiber';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';

interface R3FCanvasWrapperProps extends CanvasProps {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
  errorFallback?: React.ReactNode;
  onCreated?: (state: any) => void;
}

export function R3FCanvasWrapper({
  children,
  loadingFallback,
  errorFallback,
  onCreated,
  ...canvasProps
}: R3FCanvasWrapperProps) {
  const [canvasKey, setCanvasKey] = useState(0);
  const glRef = useRef<WebGL2RenderingContext | null>(null);

  const handleCreated = useCallback(
    (state: any) => {
      const gl = state.gl;
      glRef.current = gl.getContext();

      // Attach context loss listeners to the actual canvas element
      const domElement = gl.domElement;
      domElement.addEventListener('webglcontextlost', handleContextLost);
      domElement.addEventListener('webglcontextrestored', handleContextRestored);

      onCreated?.(state);
    },
    [onCreated]
  );

  const handleContextLost = useCallback((event: Event) => {
    event.preventDefault(); // CRITICAL: prevents default behavior of not restoring
    console.warn('[R3FCanvasWrapper] WebGL context lost');
    // Context will be restored automatically if we preventDefault
  }, []);

  const handleContextRestored = useCallback(() => {
    console.info('[R3FCanvasWrapper] WebGL context restored, re-mounting canvas');
    // Force re-mount of the entire Canvas to re-create all GPU resources
    setCanvasKey((prev) => prev + 1);
  }, []);

  const handleBoundaryReset = useCallback(() => {
    // Force re-mount of Canvas
    setCanvasKey((prev) => prev + 1);
  }, []);

  return (
    <CanvasErrorBoundary
      fallback={errorFallback}
      onReset={handleBoundaryReset}
      resetKeys={[canvasKey]}
    >
      <Suspense fallback={loadingFallback || <CanvasLoadingFallback />}>
        <Canvas key={canvasKey} onCreated={handleCreated} {...canvasProps}>
          <SceneErrorBoundary>{children}</SceneErrorBoundary>
        </Canvas>
      </Suspense>
    </CanvasErrorBoundary>
  );
}
```

### Scene-Level Error Boundary (Inside R3F)

Errors inside the R3F reconciler (e.g., a bad material uniform, geometry error)
need a boundary inside the scene tree.

```tsx
// lib/error-boundaries/SceneErrorBoundary.tsx

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { useThree } from '@react-three/fiber';

interface SceneErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class SceneErrorBoundaryInner extends Component<
  { children: ReactNode },
  SceneErrorBoundaryState
> {
  state: SceneErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[SceneErrorBoundary] Error in R3F scene tree:', {
      message: error.message,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      // Render nothing in the 3D scene -- the DOM-level boundary handles UI
      return null;
    }
    return this.props.children;
  }
}

// Wrapper that provides R3F context awareness
export function SceneErrorBoundary({ children }: { children: ReactNode }) {
  return <SceneErrorBoundaryInner>{children}</SceneErrorBoundaryInner>;
}
```

### R3F onError Handler

R3F v8.15+ supports an `onError` prop on `<Canvas>`:

```tsx
<Canvas
  onError={(error) => {
    console.error('[Canvas] R3F internal error:', error);
    // Report to Sentry
    Sentry.captureException(error, {
      tags: { component: 'r3f-canvas' },
    });
  }}
>
  {children}
</Canvas>
```

---

## Error Boundary Hierarchy

### Recommended Hierarchy

```
App
  AppErrorBoundary (catches everything, full-page fallback)
    Layout
      EditorErrorBoundary (catches editor-panel JS errors)
        PropertyPanel
        LayerList
      CanvasErrorBoundary (catches Canvas mount/unmount errors)
        Canvas
          SceneErrorBoundary (catches scene-tree errors)
            CompositorRoot
              LayerErrorBoundary (per-layer, catches single effect errors)
                BloomLayer
              LayerErrorBoundary
                BlurLayer
              ...
```

### Per-Layer Error Boundary

Isolate individual effect layers so one bad shader does not kill the entire compositor.

```tsx
// lib/error-boundaries/LayerErrorBoundary.tsx

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface LayerErrorBoundaryProps {
  layerId: string;
  layerName: string;
  children: ReactNode;
  onLayerError?: (layerId: string, error: Error) => void;
}

interface LayerErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class LayerErrorBoundary extends Component<
  LayerErrorBoundaryProps,
  LayerErrorBoundaryState
> {
  state: LayerErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const { layerId, layerName, onLayerError } = this.props;

    console.error(`[LayerErrorBoundary] Layer "${layerName}" (${layerId}) failed:`, {
      message: error.message,
      componentStack: errorInfo.componentStack,
    });

    // Notify parent compositor to disable this layer
    onLayerError?.(layerId, error);
  }

  render() {
    if (this.state.hasError) {
      // In the 3D scene, render nothing for a failed layer
      // The compositor skips this layer's pass
      return null;
    }
    return this.props.children;
  }
}
```

### Using Per-Layer Boundaries in the Compositor

```tsx
// Inside the compositor root / FBO compositor component

function CompositorLayers({ layers }: { layers: Layer[] }) {
  const handleLayerError = useCallback((layerId: string, error: Error) => {
    // Mark layer as errored in state
    // Show toast: "Bloom effect encountered an error and was disabled"
    store.dispatch({
      type: 'LAYER_ERROR',
      payload: { layerId, error: error.message },
    });
  }, []);

  return (
    <>
      {layers.map((layer) => (
        <LayerErrorBoundary
          key={layer.id}
          layerId={layer.id}
          layerName={layer.name}
          onLayerError={handleLayerError}
        >
          <LayerRenderer layer={layer} />
        </LayerErrorBoundary>
      ))}
    </>
  );
}
```

---

## Fallback UI Patterns

### GPU Error Fallback Component

```tsx
// lib/error-boundaries/GPUErrorFallback.tsx

import React from 'react';

interface GPUErrorFallbackProps {
  error: Error | null;
  errorType: 'js' | 'gpu' | 'context-loss' | null;
  retryCount: number;
  maxRetries: number;
  onRetry: () => void;
  onReset: () => void;
}

export function GPUErrorFallback({
  error,
  errorType,
  retryCount,
  maxRetries,
  onRetry,
  onReset,
}: GPUErrorFallbackProps) {
  const canRetry = retryCount < maxRetries;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1a1a2e',
        color: '#e0e0e0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>
        {errorType === 'context-loss'
          ? 'GPU Connection Lost'
          : errorType === 'gpu'
          ? 'Graphics Error'
          : 'Something Went Wrong'}
      </div>

      <p style={{ maxWidth: '500px', lineHeight: 1.6, color: '#a0a0a0' }}>
        {errorType === 'context-loss'
          ? 'Your browser lost connection to the GPU. This can happen when the system sleeps, when other tabs use too much GPU memory, or after a driver update.'
          : errorType === 'gpu'
          ? 'Your browser experienced a graphics processing error. This may be caused by an unsupported GPU feature or a driver issue.'
          : 'An unexpected error occurred in the effects compositor.'}
      </p>

      {error && (
        <details
          style={{
            marginTop: '1rem',
            maxWidth: '500px',
            textAlign: 'left',
            color: '#888',
          }}
        >
          <summary style={{ cursor: 'pointer' }}>Technical Details</summary>
          <pre
            style={{
              fontSize: '0.75rem',
              overflow: 'auto',
              maxHeight: '200px',
              padding: '0.5rem',
              backgroundColor: '#0d0d1a',
              borderRadius: '4px',
              marginTop: '0.5rem',
            }}
          >
            {error.message}
          </pre>
        </details>
      )}

      <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem' }}>
        {canRetry && (
          <button
            onClick={onRetry}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#4a9eff',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1rem',
            }}
          >
            Try Again ({maxRetries - retryCount} attempts left)
          </button>
        )}
        <button
          onClick={onReset}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#333',
            color: 'white',
            border: '1px solid #555',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Reset Canvas
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#333',
            color: 'white',
            border: '1px solid #555',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Reload Page
        </button>
      </div>

      {retryCount > 0 && !canRetry && (
        <p style={{ color: '#ff6b6b', marginTop: '1rem' }}>
          Multiple recovery attempts failed. Please try reloading the page or
          updating your graphics drivers.
        </p>
      )}
    </div>
  );
}
```

### Minimal Loading Fallback

```tsx
// lib/error-boundaries/CanvasLoadingFallback.tsx

export function CanvasLoadingFallback() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#111',
        color: '#666',
      }}
    >
      <div>
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid #333',
            borderTop: '3px solid #4a9eff',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 1rem',
          }}
        />
        Initializing renderer...
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
```

---

## Recovery Strategies

### Strategy 1: Re-mount Canvas (Preferred)

Force React to destroy and re-create the entire Canvas component.
This re-creates the WebGL context, all GPU resources, and all Three.js objects.

```tsx
function useCanvasRecovery() {
  const [canvasKey, setCanvasKey] = useState(0);

  const remountCanvas = useCallback(() => {
    // Increment key forces React to unmount old Canvas and mount new one
    setCanvasKey((prev) => prev + 1);
  }, []);

  return { canvasKey, remountCanvas };
}

// Usage
function App() {
  const { canvasKey, remountCanvas } = useCanvasRecovery();

  return (
    <CanvasErrorBoundary onReset={remountCanvas}>
      <Canvas key={canvasKey}>
        <Scene />
      </Canvas>
    </CanvasErrorBoundary>
  );
}
```

### Strategy 2: Selective Layer Recovery

When a single effect layer crashes, disable just that layer instead of
re-mounting the entire canvas.

```tsx
function useLayerRecovery(layers: Layer[]) {
  const [disabledLayers, setDisabledLayers] = useState<Set<string>>(new Set());

  const disableLayer = useCallback((layerId: string) => {
    setDisabledLayers((prev) => {
      const next = new Set(prev);
      next.add(layerId);
      return next;
    });
  }, []);

  const enableLayer = useCallback((layerId: string) => {
    setDisabledLayers((prev) => {
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });
  }, []);

  const activeLayers = layers.filter((l) => !disabledLayers.has(l.id));

  return { activeLayers, disabledLayers, disableLayer, enableLayer };
}
```

### Strategy 3: Progressive Recovery

Try the least disruptive recovery first, escalate if needed.

```tsx
function useProgressiveRecovery() {
  const recoverySteps = useRef([
    // Step 1: Re-render (does nothing to GPU state, just React reconciliation)
    () => forceRerender(),
    // Step 2: Reduce quality
    () => setQualityPreset('low'),
    // Step 3: Disable all post-processing
    () => disableAllEffects(),
    // Step 4: Re-mount canvas
    () => remountCanvas(),
    // Step 5: Full page reload
    () => window.location.reload(),
  ]);

  const stepIndex = useRef(0);

  const attemptRecovery = useCallback(() => {
    const step = recoverySteps.current[stepIndex.current];
    if (step) {
      step();
      stepIndex.current += 1;
    }
  }, []);

  const resetRecovery = useCallback(() => {
    stepIndex.current = 0;
  }, []);

  return { attemptRecovery, resetRecovery };
}
```

### Strategy 4: Delayed Auto-Recovery

For context loss events, wait for restoration and then re-mount.

```tsx
function useContextLossRecovery(canvasRef: React.RefObject<HTMLCanvasElement>) {
  const [contextLost, setContextLost] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleLost = (e: Event) => {
      e.preventDefault(); // MUST call to allow restoration
      setContextLost(true);
    };

    const handleRestored = () => {
      setContextLost(false);
      // The Canvas component should re-mount via key change
    };

    canvas.addEventListener('webglcontextlost', handleLost);
    canvas.addEventListener('webglcontextrestored', handleRestored);

    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost);
      canvas.removeEventListener('webglcontextrestored', handleRestored);
    };
  }, [canvasRef]);

  return contextLost;
}
```

---

## Three.js Error Events

### Shader Compilation Errors

Three.js does not throw on shader compilation failure by default. It logs a warning.
You must intercept these.

```tsx
// lib/error-boundaries/shaderErrorInterceptor.ts

import * as THREE from 'three';

type ShaderErrorCallback = (info: {
  material: string;
  vertexLog: string;
  fragmentLog: string;
  programInfo: string;
}) => void;

export function installShaderErrorInterceptor(
  renderer: THREE.WebGLRenderer,
  onError: ShaderErrorCallback
): () => void {
  // Three.js r152+ has onShaderError
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

    onError({
      material: 'unknown', // Three.js does not pass material ref here
      vertexLog,
      fragmentLog,
      programInfo: programLog,
    });

    // Call original if it existed
    if (originalOnShaderError) {
      originalOnShaderError(gl, program, vertexShader, fragmentShader);
    }
  };

  return () => {
    renderer.debug.onShaderError = originalOnShaderError;
  };
}
```

### Renderer Warning Interception

```tsx
// Intercept Three.js console warnings for production monitoring

export function interceptThreeWarnings(
  onWarning: (message: string) => void
): () => void {
  const originalWarn = console.warn;

  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(' ');

    // Three.js warnings have recognizable patterns
    if (
      message.includes('THREE.') ||
      message.includes('WebGL') ||
      message.includes('shader') ||
      message.includes('texture')
    ) {
      onWarning(message);
    }

    originalWarn.apply(console, args);
  };

  return () => {
    console.warn = originalWarn;
  };
}
```

### Framebuffer Status Monitoring

```tsx
// lib/error-boundaries/framebufferMonitor.ts

export function checkFramebufferStatus(
  gl: WebGL2RenderingContext,
  label: string
): boolean {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    const statusName = {
      [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: 'INCOMPLETE_ATTACHMENT',
      [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: 'INCOMPLETE_MISSING_ATTACHMENT',
      [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]: 'INCOMPLETE_DIMENSIONS',
      [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED',
      [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: 'INCOMPLETE_MULTISAMPLE',
    }[status] || `UNKNOWN (0x${status.toString(16)})`;

    console.error(`[FBO Monitor] ${label}: Framebuffer status: ${statusName}`);
    return false;
  }

  return true;
}
```

---

## Production Error Boundary Implementation

### Full Production Setup

```tsx
// app/editor/page.tsx (or wherever the editor mounts)

import { CanvasErrorBoundary } from '@/lib/error-boundaries/CanvasErrorBoundary';
import { R3FCanvasWrapper } from '@/lib/error-boundaries/R3FCanvasWrapper';
import { installShaderErrorInterceptor } from '@/lib/error-boundaries/shaderErrorInterceptor';
import * as Sentry from '@sentry/nextjs';

function EditorPage() {
  const [canvasKey, setCanvasKey] = useState(0);

  const handleCanvasCreated = useCallback((state: any) => {
    const renderer = state.gl;

    // Install shader error monitoring
    installShaderErrorInterceptor(renderer, (info) => {
      Sentry.captureMessage('Shader compilation error', {
        level: 'error',
        extra: info,
        tags: { component: 'shader' },
      });
    });

    // Log GPU info for debugging
    const debugInfo = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const gl = renderer.getContext();
      Sentry.setContext('gpu', {
        renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
        vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
      });
    }
  }, []);

  const handleError = useCallback((error: Error, errorInfo: any) => {
    Sentry.captureException(error, {
      extra: {
        componentStack: errorInfo.componentStack,
        canvasKey,
      },
      tags: {
        boundary: 'canvas',
        errorType: classifyError(error),
      },
    });
  }, [canvasKey]);

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <CanvasErrorBoundary
        onError={handleError}
        onReset={() => setCanvasKey((k) => k + 1)}
      >
        <R3FCanvasWrapper
          key={canvasKey}
          gl={{
            powerPreference: 'high-performance',
            antialias: false,
            alpha: false,
            stencil: false,
            depth: true,
          }}
          onCreated={handleCanvasCreated}
        >
          <CompositorScene />
        </R3FCanvasWrapper>
      </CanvasErrorBoundary>
    </div>
  );
}
```

### Error Boundary with Toast Notifications

```tsx
// Integrate with a toast system to inform users without blocking the UI

function useErrorBoundaryToast() {
  const toast = useToast(); // Your toast system

  const handleLayerError = useCallback(
    (layerId: string, error: Error) => {
      toast.show({
        type: 'warning',
        title: 'Effect Disabled',
        message: `The "${layerId}" effect was automatically disabled due to an error. You can re-enable it from the layer panel.`,
        duration: 5000,
      });
    },
    [toast]
  );

  return { handleLayerError };
}
```

---

## Testing Error Boundaries

### Unit Tests for Error Boundaries

```tsx
// __tests__/error-boundaries/CanvasErrorBoundary.test.tsx

import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasErrorBoundary } from '@/lib/error-boundaries/CanvasErrorBoundary';

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('WebGL: shader compilation failed');
  }
  return <div>Canvas content</div>;
}

describe('CanvasErrorBoundary', () => {
  // Suppress React error boundary console output in tests
  const originalError = console.error;
  beforeEach(() => {
    console.error = jest.fn();
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('renders children when no error', () => {
    render(
      <CanvasErrorBoundary>
        <ThrowingComponent shouldThrow={false} />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText('Canvas content')).toBeInTheDocument();
  });

  it('renders fallback UI on GPU error', () => {
    render(
      <CanvasErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText('Graphics Error')).toBeInTheDocument();
  });

  it('allows retry', () => {
    const { rerender } = render(
      <CanvasErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </CanvasErrorBoundary>
    );
    fireEvent.click(screen.getByText(/Try Again/));
    // After retry, component re-renders
  });

  it('calls onError callback', () => {
    const onError = jest.fn();
    render(
      <CanvasErrorBoundary onError={onError}>
        <ThrowingComponent shouldThrow={true} />
      </CanvasErrorBoundary>
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toContain('shader');
  });
});
```

### Simulating Context Loss in Tests

```tsx
// __tests__/error-boundaries/contextLoss.test.ts

describe('WebGL Context Loss Recovery', () => {
  it('handles context loss and restoration', () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return; // Skip in environments without WebGL

    const loseContext = gl.getExtension('WEBGL_lose_context');
    if (!loseContext) return;

    let lostFired = false;
    let restoredFired = false;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      lostFired = true;
    });

    canvas.addEventListener('webglcontextrestored', () => {
      restoredFired = true;
    });

    // Simulate loss
    loseContext.loseContext();
    expect(lostFired).toBe(true);

    // Simulate restore
    loseContext.restoreContext();
    // Note: restoreContext is async, may need waitFor in real tests
  });
});
```

---

## Common GPU Error Signatures

### Error: "Too many active WebGL contexts"

```
Cause: Browser limits (typically 8-16 contexts). Each Canvas creates one.
Fix:   Ensure only ONE Canvas is mounted at a time.
       Dispose previous canvases before creating new ones.
       Never create Canvas elements in loops or rapid mount/unmount cycles.
```

### Error: "WebGL: INVALID_OPERATION"

```
Cause: Mismatched uniform types, wrong texture binding, FBO not complete.
Fix:   Check shader uniforms match material definitions.
       Verify texture dimensions are power-of-two or use correct wrapping.
       Check FBO attachments are all same dimensions.
```

### Error: "Shader compilation failed" (silent)

```
Cause: GLSL syntax error, unsupported feature on target GPU.
Fix:   Install shader error interceptor (see above).
       Test on multiple GPUs (Intel, AMD, NVIDIA, Apple Silicon).
       Avoid GLSL features not in WebGL2 spec (no compute shaders).
```

### Error: "Out of memory"

```
Cause: Too many textures, too large render targets, VRAM exhaustion.
Fix:   Dispose unused resources immediately.
       Limit render target resolution to 2x screen max.
       Cap simultaneous FBO count.
       Implement memory budget tracking.
```

### Silent Black Screen (No Error)

```
Cause: Shader compiles but outputs black (logic error in GLSL).
       Framebuffer is bound but never written to.
       Wrong blend mode (multiply against zero).
Fix:   Check shader outputs non-zero values (debug with solid color).
       Verify clear color is not masking content.
       Check blend state: gl.disable(gl.BLEND) for debugging.
```

---

## Anti-Patterns and Pitfalls

### Do NOT: Catch and Swallow GPU Errors

```tsx
// BAD: Silently catches and hides the problem
try {
  renderer.render(scene, camera);
} catch (e) {
  // silently ignore
}

// GOOD: Catch, report, and recover
try {
  renderer.render(scene, camera);
} catch (e) {
  reportError(e);
  attemptRecovery();
}
```

### Do NOT: Create Error Boundaries Inside Loops

```tsx
// BAD: Creates N error boundaries per frame
layers.map((layer) => (
  <ErrorBoundary key={layer.id}>  {/* This is fine */}
    <LayerRenderer layer={layer} />
  </ErrorBoundary>
));

// The above is actually fine. What is bad is re-creating the boundary component
// definition inside the render function:
function Bad() {
  // BAD: New component class every render, breaks error boundary state
  class InlineErrorBoundary extends Component { ... }
  return <InlineErrorBoundary><Child /></InlineErrorBoundary>;
}
```

### Do NOT: Retry Infinitely

```tsx
// BAD: Infinite retry loop
componentDidCatch(error) {
  setTimeout(() => this.setState({ hasError: false }), 1000);
}

// GOOD: Bounded retries with escalation
componentDidCatch(error) {
  if (this.state.retryCount < MAX_RETRIES) {
    setTimeout(() => this.setState({
      hasError: false,
      retryCount: this.state.retryCount + 1,
    }), 1000 * (this.state.retryCount + 1)); // Exponential backoff
  }
}
```

### Do NOT: Assume Context Restoration Is Instant

```tsx
// BAD: Immediately try to use GL after context restored event
canvas.addEventListener('webglcontextrestored', () => {
  renderer.render(scene, camera); // May fail: resources not yet re-created
});

// GOOD: Re-mount the entire Canvas to let R3F re-create everything
canvas.addEventListener('webglcontextrestored', () => {
  setCanvasKey((prev) => prev + 1); // Force React re-mount
});
```

### Do NOT: Forget to preventDefault on Context Loss

```tsx
// BAD: Context will not be restored
canvas.addEventListener('webglcontextlost', (e) => {
  console.log('Context lost');
  // Missing: e.preventDefault()
});

// GOOD: Browser will attempt to restore the context
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); // CRITICAL
  console.log('Context lost, waiting for restoration...');
});
```

---

## Quick Reference: Error Boundary Decision Tree

```
Error occurred
  |
  +-- Is it a JS error in React render tree?
  |     YES --> React ErrorBoundary catches it
  |     |
  |     +-- Is it inside R3F scene tree?
  |           YES --> SceneErrorBoundary catches it
  |           NO  --> CanvasErrorBoundary catches it
  |
  +-- Is it a WebGL context loss event?
  |     YES --> webglcontextlost listener handles it
  |             preventDefault() to allow restoration
  |             Re-mount Canvas on webglcontextrestored
  |
  +-- Is it a shader compilation error?
  |     YES --> renderer.debug.onShaderError handles it
  |             Report to error tracking
  |             Disable the offending material/layer
  |
  +-- Is it a silent black screen?
        YES --> Cannot be caught by any boundary
                Must be detected via monitoring:
                - FPS drops to 0 draw calls
                - ReadPixels returns all black
                - User reports via feedback button
```
