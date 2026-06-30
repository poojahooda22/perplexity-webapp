# Graceful Degradation for WebGL Applications

> GPU tier detection, quality presets, mobile auto-downgrade, WebGL2 fallbacks, feature detection, progressive enhancement, and adaptive quality for production WebGL/Three.js apps.

## Table of Contents

1. [GPU Tier Detection](#gpu-tier-detection)
2. [Quality Presets](#quality-presets)
3. [Mobile Detection and Auto-Downgrade](#mobile-detection-and-auto-downgrade)
4. [WebGL2 Feature Detection and Fallback](#webgl2-feature-detection-and-fallback)
5. [Extension Detection](#extension-detection)
6. [Progressive Enhancement](#progressive-enhancement)
7. [Adaptive Quality (Runtime)](#adaptive-quality-runtime)
8. [Resolution Scaling](#resolution-scaling)
9. [Effect Complexity Scaling](#effect-complexity-scaling)
10. [User-Facing Quality Controls](#user-facing-quality-controls)

---

## GPU Tier Detection

### Renderer String Parsing

The GPU renderer string (from WEBGL_debug_renderer_info) is the primary signal
for capability detection. It tells you exactly which GPU the user has.

```typescript
// lib/degradation/gpuTier.ts

export type GPUTier = 'high' | 'mid' | 'low' | 'software' | 'unknown';

export interface GPUCapabilities {
  tier: GPUTier;
  renderer: string;
  vendor: string;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: [number, number];
  supportsFloat: boolean;
  supportsHalfFloat: boolean;
  supportsLinearFloatFiltering: boolean;
  supportsAnisotropic: boolean;
  maxAnisotropy: number;
  supportsTimerQuery: boolean;
  maxDrawBuffers: number;
  isWebGL2: boolean;
  isMobile: boolean;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number;
}

/**
 * Detect GPU capabilities by probing WebGL.
 * Returns a capability object used to select quality presets.
 */
export function detectGPUCapabilities(): GPUCapabilities {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');

  if (!gl) {
    // WebGL2 not available -- worst case
    return createFallbackCapabilities();
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const vendor = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR);

  // Check float texture support
  const floatExt = gl.getExtension('EXT_color_buffer_float');
  const supportsFloat = floatExt !== null;

  // Check float linear filtering
  const floatLinear = gl.getExtension('OES_texture_float_linear');
  const supportsLinearFloatFiltering = floatLinear !== null;

  // Check anisotropic filtering
  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  const maxAnisotropy = anisoExt
    ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
    : 0;

  // Timer query (rarely available due to Spectre)
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  const capabilities: GPUCapabilities = {
    tier: 'unknown',
    renderer,
    vendor,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxViewportDims: gl.getParameter(gl.MAX_VIEWPORT_DIMS) as [number, number],
    supportsFloat,
    supportsHalfFloat: true, // Always true in WebGL2
    supportsLinearFloatFiltering,
    supportsAnisotropic: anisoExt !== null,
    maxAnisotropy,
    supportsTimerQuery: timerExt !== null,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    isWebGL2: true,
    isMobile: detectMobile(),
    deviceMemoryGB: (navigator as any).deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
  };

  // Classify tier based on renderer string
  capabilities.tier = classifyGPUTier(renderer, capabilities);

  // Clean up probe context
  const loseCtx = gl.getExtension('WEBGL_lose_context');
  if (loseCtx) loseCtx.loseContext();

  return capabilities;
}

function classifyGPUTier(
  renderer: string,
  caps: Partial<GPUCapabilities>
): GPUTier {
  const r = renderer.toLowerCase();

  // Software renderers
  if (
    r.includes('swiftshader') ||
    r.includes('llvmpipe') ||
    r.includes('software') ||
    r.includes('microsoft basic')
  ) {
    return 'software';
  }

  // HIGH tier: Discrete desktop GPUs from the last 3 generations
  const highPatterns = [
    /rtx\s*[3-5]\d{3}/i,           // NVIDIA RTX 3000/4000/5000
    /rx\s*(6[89]|7[0-9])\d{2}/i,   // AMD RX 6800+, RX 7000
    /radeon\s*pro\s*w[67]/i,        // AMD Radeon Pro
    /apple\s*m[2-9]\s*(pro|max|ultra)/i, // Apple M2+ Pro/Max/Ultra
    /geforce\s*rtx/i,              // Any RTX card
    /quadro\s*rtx/i,               // NVIDIA Quadro RTX
  ];

  for (const pattern of highPatterns) {
    if (pattern.test(r)) return 'high';
  }

  // MID tier: Older discrete GPUs, high-end integrated
  const midPatterns = [
    /gtx\s*1[0-9]{3}/i,            // NVIDIA GTX 1000 series
    /rtx\s*2\d{3}/i,               // NVIDIA RTX 2000 series
    /rx\s*(5[5-9]|6[0-7])\d{2}/i,  // AMD RX 5500-6700
    /apple\s*m[1-9]/i,             // Apple M1+ (base, not Pro/Max)
    /intel.*iris.*xe/i,             // Intel Xe graphics
    /intel.*arc/i,                  // Intel Arc discrete
    /adreno\s*(6[3-9]|7\d)/i,      // Qualcomm Adreno 630+ (high-end mobile)
    /mali-g[7-9]\d/i,              // ARM Mali G7x+ (high-end mobile)
  ];

  for (const pattern of midPatterns) {
    if (pattern.test(r)) return 'mid';
  }

  // LOW tier: Old integrated GPUs, mobile GPUs
  const lowPatterns = [
    /intel.*hd\s*(4|5|6)\d{3}/i,    // Intel HD 4000-6000
    /intel.*uhd\s*(6[0-2]|7\d{2})/i, // Intel UHD 620, 730, etc.
    /intel.*iris.*plus/i,            // Intel Iris Plus (older)
    /adreno\s*[3-5]\d{2}/i,         // Qualcomm Adreno 300-500
    /adreno\s*6[0-2]\d/i,           // Qualcomm Adreno 600-620
    /mali-g[5-6]\d/i,               // ARM Mali G5x, G6x
    /mali-t/i,                       // ARM Mali T-series (very old)
    /powervr/i,                      // PowerVR (old iOS/Android)
    /tegra/i,                        // NVIDIA Tegra (old Android)
    /videocore/i,                    // Raspberry Pi
  ];

  for (const pattern of lowPatterns) {
    if (pattern.test(r)) return 'low';
  }

  // If mobile and not matched above, assume low
  if (caps.isMobile) return 'low';

  // Fallback: use maxTextureSize as a heuristic
  if ((caps.maxTextureSize ?? 0) >= 16384) return 'mid';
  if ((caps.maxTextureSize ?? 0) >= 8192) return 'low';

  return 'unknown';
}

function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    ('ontouchstart' in window && navigator.maxTouchPoints > 1);
}

function createFallbackCapabilities(): GPUCapabilities {
  return {
    tier: 'software',
    renderer: 'no-webgl2',
    vendor: 'unknown',
    maxTextureSize: 0,
    maxRenderbufferSize: 0,
    maxViewportDims: [0, 0],
    supportsFloat: false,
    supportsHalfFloat: false,
    supportsLinearFloatFiltering: false,
    supportsAnisotropic: false,
    maxAnisotropy: 0,
    supportsTimerQuery: false,
    maxDrawBuffers: 0,
    isWebGL2: false,
    isMobile: detectMobile(),
    deviceMemoryGB: (navigator as any).deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
  };
}
```

### First-Load Benchmark

For borderline GPUs (renderer string is ambiguous), run a quick benchmark
on first visit to determine actual performance.

```typescript
// lib/degradation/benchmark.ts

/**
 * Run a quick GPU benchmark (< 500ms) to measure actual fill rate.
 * Use this when the GPU tier is 'unknown' based on renderer string alone.
 *
 * Renders a fullscreen quad with increasing fragment complexity
 * and measures how many frames it can sustain at 60fps.
 */
export async function quickBenchmark(): Promise<{
  fillRateScore: number; // 0-100, higher is better
  estimatedTier: GPUTier;
}> {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  // Canvas is not added to DOM -- it is offscreen

  const gl = canvas.getContext('webgl2');
  if (!gl) return { fillRateScore: 0, estimatedTier: 'software' };

  // Simple fragment shader with varying complexity
  const vertSrc = `#version 300 es
    in vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

  const fragSrc = `#version 300 es
    precision highp float;
    out vec4 fragColor;
    uniform float uComplexity;
    void main() {
      vec2 uv = gl_FragCoord.xy / 512.0;
      float v = 0.0;
      for (float i = 0.0; i < 64.0; i += 1.0) {
        if (i >= uComplexity) break;
        v += sin(uv.x * i * 3.14159) * cos(uv.y * i * 2.71828);
      }
      fragColor = vec4(vec3(v * 0.01 + 0.5), 1.0);
    }`;

  // Compile shaders
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return { fillRateScore: 0, estimatedTier: 'low' };

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return { fillRateScore: 0, estimatedTier: 'low' };
  }

  // Fullscreen quad
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  const posLoc = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.useProgram(program);
  const complexityLoc = gl.getUniformLocation(program, 'uComplexity');

  // Benchmark: render at increasing complexity, measure frame time
  const complexities = [4, 8, 16, 32, 64];
  let score = 0;

  for (const complexity of complexities) {
    gl.uniform1f(complexityLoc, complexity);

    const start = performance.now();
    for (let frame = 0; frame < 10; frame++) {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.finish(); // Wait for GPU to complete
    const elapsed = performance.now() - start;

    const avgFrameMs = elapsed / 10;
    if (avgFrameMs < 16.67) {
      score += 20; // This complexity level runs at 60fps
    } else if (avgFrameMs < 33.33) {
      score += 10; // 30fps
    }
  }

  // Cleanup
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.deleteProgram(program);
  gl.deleteBuffer(buffer);
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();

  let estimatedTier: GPUTier;
  if (score >= 80) estimatedTier = 'high';
  else if (score >= 50) estimatedTier = 'mid';
  else if (score >= 20) estimatedTier = 'low';
  else estimatedTier = 'software';

  return { fillRateScore: score, estimatedTier };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
```

### Caching GPU Detection Results

```typescript
// lib/degradation/gpuCache.ts

const CACHE_KEY = 'webgl-app-gpu-capabilities';
const CACHE_VERSION = 2; // Increment when detection logic changes

export function getCachedCapabilities(): GPUCapabilities | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed.version !== CACHE_VERSION) return null;

    // Expire after 24 hours (GPU can change if user connects external display)
    if (Date.now() - parsed.timestamp > 24 * 60 * 60 * 1000) return null;

    return parsed.capabilities;
  } catch {
    return null;
  }
}

export function cacheCapabilities(caps: GPUCapabilities): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: CACHE_VERSION,
        timestamp: Date.now(),
        capabilities: caps,
      })
    );
  } catch {
    // Storage full or unavailable -- not critical
  }
}
```

---

## Quality Presets

### Preset Definitions

```typescript
// lib/degradation/qualityPresets.ts

export interface QualityPreset {
  name: string;
  dpr: number;                   // Device pixel ratio multiplier (1.0 = native)
  maxDPR: number;                // Cap DPR to this value
  noiseOctaves: number;          // Noise function iterations (4-8)
  blurPasses: number;            // Number of blur passes (1-5)
  bloomMipLevels: number;        // Bloom downsample levels (3-6)
  simulationEnabled: boolean;    // Enable physics/particle simulation
  simulationSteps: number;       // Simulation substeps per frame
  maxLayers: number;             // Maximum concurrent effect layers
  fboHalfRes: boolean;           // Render FBOs at half resolution
  msaa: number;                  // MSAA samples (0, 2, 4, 8)
  shadowQuality: 'none' | 'low' | 'high';
  textureQuality: 'low' | 'medium' | 'high';
  animationQuality: 'reduced' | 'full';
}

export const QUALITY_PRESETS: Record<string, QualityPreset> = {
  low: {
    name: 'Low',
    dpr: 1.0,
    maxDPR: 1.0,
    noiseOctaves: 4,
    blurPasses: 1,
    bloomMipLevels: 3,
    simulationEnabled: false,
    simulationSteps: 0,
    maxLayers: 8,
    fboHalfRes: true,
    msaa: 0,
    shadowQuality: 'none',
    textureQuality: 'low',
    animationQuality: 'reduced',
  },

  medium: {
    name: 'Medium',
    dpr: 1.0,
    maxDPR: 1.5,
    noiseOctaves: 6,
    blurPasses: 3,
    bloomMipLevels: 4,
    simulationEnabled: true,
    simulationSteps: 1,
    maxLayers: 15,
    fboHalfRes: false,
    msaa: 0,
    shadowQuality: 'low',
    textureQuality: 'medium',
    animationQuality: 'full',
  },

  high: {
    name: 'High',
    dpr: 1.0,
    maxDPR: 2.0,
    noiseOctaves: 8,
    blurPasses: 5,
    bloomMipLevels: 6,
    simulationEnabled: true,
    simulationSteps: 2,
    maxLayers: 30,
    fboHalfRes: false,
    msaa: 4,
    shadowQuality: 'high',
    textureQuality: 'high',
    animationQuality: 'full',
  },
};

/**
 * Select the appropriate quality preset based on GPU capabilities.
 */
export function selectPreset(caps: GPUCapabilities): QualityPreset {
  switch (caps.tier) {
    case 'high':
      return QUALITY_PRESETS.high;
    case 'mid':
      return QUALITY_PRESETS.medium;
    case 'low':
    case 'software':
      return QUALITY_PRESETS.low;
    case 'unknown':
      // Default to medium for unknown GPUs, then adjust at runtime
      return QUALITY_PRESETS.medium;
  }
}
```

### Applying Presets to the Compositor

```typescript
// lib/degradation/applyPreset.ts

import { QualityPreset } from './qualityPresets';

/**
 * Apply a quality preset to the compositor configuration.
 * This updates all per-effect parameters to match the target quality.
 */
export function applyPresetToCompositor(
  preset: QualityPreset,
  compositor: CompositorConfig
): CompositorConfig {
  return {
    ...compositor,
    dpr: Math.min(window.devicePixelRatio * preset.dpr, preset.maxDPR),
    maxLayers: preset.maxLayers,
    fboScale: preset.fboHalfRes ? 0.5 : 1.0,

    // Per-effect overrides
    effectOverrides: {
      bloom: {
        mipLevels: preset.bloomMipLevels,
        intensity: preset.textureQuality === 'low' ? 0.8 : 1.0,
      },
      blur: {
        passes: preset.blurPasses,
        kernelSize: preset.textureQuality === 'low' ? 9 : 13,
      },
      fog: {
        octaves: preset.noiseOctaves,
        steps: preset.textureQuality === 'low' ? 16 : 32,
      },
      grain: {
        animated: preset.animationQuality === 'full',
      },
      blobTracking: {
        enabled: preset.simulationEnabled,
        substeps: preset.simulationSteps,
      },
    },
  };
}
```

---

## Mobile Detection and Auto-Downgrade

### Comprehensive Mobile Detection

```typescript
// lib/degradation/mobileDetect.ts

export interface MobileInfo {
  isMobile: boolean;
  isTablet: boolean;
  isPhone: boolean;
  platform: 'ios' | 'android' | 'other';
  screenDiagonalInch: number | null;
  hasTouchscreen: boolean;
  orientation: 'portrait' | 'landscape';
}

export function detectMobile(): MobileInfo {
  const ua = navigator.userAgent;

  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const hasTouchscreen = 'ontouchstart' in window || navigator.maxTouchPoints > 1;

  // Screen diagonal estimate
  const w = window.screen.width;
  const h = window.screen.height;
  const dpr = window.devicePixelRatio || 1;
  // Assume 96 DPI base, adjusted by DPR
  const diagonalPx = Math.sqrt(w * w + h * h);
  const diagonalInch = diagonalPx / (96 * dpr);

  const isPhone =
    (isIOS && !/iPad/i.test(ua)) ||
    (isAndroid && diagonalInch < 7);
  const isTablet =
    /iPad/i.test(ua) ||
    (isAndroid && diagonalInch >= 7 && diagonalInch < 13);
  const isMobile = isPhone || isTablet;

  return {
    isMobile,
    isTablet,
    isPhone,
    platform: isIOS ? 'ios' : isAndroid ? 'android' : 'other',
    screenDiagonalInch: Math.round(diagonalInch * 10) / 10,
    hasTouchscreen,
    orientation: w > h ? 'landscape' : 'portrait',
  };
}
```

### Auto-Downgrade for Mobile

```typescript
// lib/degradation/mobilePreset.ts

import { QualityPreset, QUALITY_PRESETS } from './qualityPresets';
import { MobileInfo } from './mobileDetect';
import { GPUCapabilities } from './gpuTier';

/**
 * Override quality preset for mobile devices.
 * Mobile GPUs are thermal-throttled and battery-constrained.
 * Even a "mid-tier" mobile GPU (Adreno 660) should run at low/medium preset.
 */
export function adjustForMobile(
  preset: QualityPreset,
  mobile: MobileInfo,
  gpu: GPUCapabilities
): QualityPreset {
  if (!mobile.isMobile) return preset;

  if (mobile.isPhone) {
    // Phones: always use low preset, cap DPR
    return {
      ...QUALITY_PRESETS.low,
      maxDPR: Math.min(2.0, window.devicePixelRatio),
      // Reduce further for low-end phones
      maxLayers: gpu.tier === 'low' ? 4 : 8,
      noiseOctaves: gpu.tier === 'low' ? 2 : 4,
    };
  }

  if (mobile.isTablet) {
    // Tablets: use low-medium depending on GPU
    if (gpu.tier === 'high' || gpu.tier === 'mid') {
      return {
        ...QUALITY_PRESETS.medium,
        maxDPR: 1.5,
        maxLayers: 10,
      };
    }
    return {
      ...QUALITY_PRESETS.low,
      maxDPR: 1.5,
      maxLayers: 6,
    };
  }

  return preset;
}
```

---

## WebGL2 Feature Detection and Fallback

### WebGL2 Availability Check

```typescript
// lib/degradation/webglDetect.ts

export interface WebGLSupport {
  webgl2: boolean;
  webgl1: boolean;
  reason: string | null;
}

export function detectWebGLSupport(): WebGLSupport {
  // Try WebGL2 first
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    if (gl2) {
      // Clean up
      const ext = gl2.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      return { webgl2: true, webgl1: true, reason: null };
    }
  } catch {
    // Fall through
  }

  // Try WebGL1
  try {
    const canvas = document.createElement('canvas');
    const gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl1) {
      const ext = (gl1 as WebGLRenderingContext).getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      return {
        webgl2: false,
        webgl1: true,
        reason: 'Your browser supports WebGL 1 but not WebGL 2. Some effects may not be available.',
      };
    }
  } catch {
    // Fall through
  }

  // No WebGL
  return {
    webgl2: false,
    webgl1: false,
    reason: detectNoWebGLReason(),
  };
}

function detectNoWebGLReason(): string {
  const ua = navigator.userAgent.toLowerCase();

  if (ua.includes('firefox')) {
    return 'WebGL is disabled in Firefox. Go to about:config and set webgl.disabled to false.';
  }

  if (ua.includes('chrome')) {
    return 'WebGL is disabled in Chrome. Go to chrome://flags and enable "Override software rendering list".';
  }

  if (ua.includes('safari')) {
    return 'WebGL may be disabled in Safari. Go to Develop menu > Experimental Features > WebGL 2.0.';
  }

  return 'Your browser does not support WebGL. Please use a modern browser (Chrome, Firefox, Safari, or Edge).';
}
```

### No-WebGL Fallback UI

```tsx
// components/WebGLGuard.tsx
'use client';

import { useEffect, useState, ReactNode } from 'react';
import { detectWebGLSupport, WebGLSupport } from '@/lib/degradation/webglDetect';

interface WebGLGuardProps {
  children: ReactNode;
  requireWebGL2?: boolean;
}

export function WebGLGuard({ children, requireWebGL2 = true }: WebGLGuardProps) {
  const [support, setSupport] = useState<WebGLSupport | null>(null);

  useEffect(() => {
    setSupport(detectWebGLSupport());
  }, []);

  // Still detecting
  if (support === null) {
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#111',
        color: '#666',
      }}>
        Checking graphics support...
      </div>
    );
  }

  // WebGL2 required but not available
  if (requireWebGL2 && !support.webgl2) {
    return <NoWebGLFallback reason={support.reason} hasWebGL1={support.webgl1} />;
  }

  // WebGL1 fallback (if you support it)
  if (!requireWebGL2 && !support.webgl1) {
    return <NoWebGLFallback reason={support.reason} hasWebGL1={false} />;
  }

  return <>{children}</>;
}

function NoWebGLFallback({
  reason,
  hasWebGL1,
}: {
  reason: string | null;
  hasWebGL1: boolean;
}) {
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
        {hasWebGL1 ? 'WebGL 2.0 Required' : 'WebGL Not Available'}
      </div>

      <p style={{ maxWidth: '500px', lineHeight: 1.6, color: '#a0a0a0' }}>
        {hasWebGL1
          ? 'This application requires WebGL 2.0 for full functionality. Your browser supports WebGL 1.0 but some features will not work correctly.'
          : 'This application requires WebGL to render visual effects. Your browser does not appear to support WebGL.'}
      </p>

      {reason && (
        <p
          style={{
            maxWidth: '500px',
            lineHeight: 1.6,
            color: '#888',
            marginTop: '1rem',
            fontSize: '0.9rem',
          }}
        >
          {reason}
        </p>
      )}

      <div style={{ marginTop: '2rem' }}>
        <h3 style={{ color: '#888', fontSize: '1rem' }}>Recommended Browsers</h3>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            color: '#aaa',
            lineHeight: 2,
          }}
        >
          <li>Chrome 56+ (recommended)</li>
          <li>Firefox 51+</li>
          <li>Safari 15+</li>
          <li>Edge 79+</li>
        </ul>
      </div>
    </div>
  );
}
```

---

## Extension Detection

### Check for Required Extensions

```typescript
// lib/degradation/extensionCheck.ts

export interface ExtensionReport {
  required: Array<{ name: string; available: boolean }>;
  optional: Array<{ name: string; available: boolean }>;
  allRequiredAvailable: boolean;
}

/**
 * Check for WebGL extensions needed by the compositor.
 */
export function checkExtensions(gl: WebGL2RenderingContext): ExtensionReport {
  const requiredExtensions = [
    // EXT_color_buffer_float: Needed for float render targets (HDR compositing)
    'EXT_color_buffer_float',
  ];

  const optionalExtensions = [
    // OES_texture_float_linear: Linear filtering on float textures
    'OES_texture_float_linear',
    // EXT_texture_filter_anisotropic: Anisotropic filtering
    'EXT_texture_filter_anisotropic',
    // EXT_disjoint_timer_query_webgl2: GPU profiling
    'EXT_disjoint_timer_query_webgl2',
    // WEBGL_compressed_texture_s3tc: DXT compression
    'WEBGL_compressed_texture_s3tc',
    // WEBGL_compressed_texture_astc: ASTC compression (mobile)
    'WEBGL_compressed_texture_astc',
    // WEBGL_compressed_texture_etc: ETC compression (mobile)
    'WEBGL_compressed_texture_etc',
  ];

  const required = requiredExtensions.map((name) => ({
    name,
    available: gl.getExtension(name) !== null,
  }));

  const optional = optionalExtensions.map((name) => ({
    name,
    available: gl.getExtension(name) !== null,
  }));

  return {
    required,
    optional,
    allRequiredAvailable: required.every((ext) => ext.available),
  };
}

/**
 * Adjust quality preset based on available extensions.
 */
export function adjustForExtensions(
  preset: QualityPreset,
  report: ExtensionReport
): QualityPreset {
  let adjusted = { ...preset };

  // Without EXT_color_buffer_float, we cannot use float render targets
  // Fall back to RGBA8 (LDR compositing, no HDR bloom)
  const floatBuffers = report.required.find(
    (e) => e.name === 'EXT_color_buffer_float'
  );
  if (floatBuffers && !floatBuffers.available) {
    adjusted = {
      ...adjusted,
      // Disable effects that require HDR
      bloomMipLevels: 0, // Disable bloom (needs float FBOs)
    };
  }

  // Without float linear filtering, blur quality is reduced
  const floatLinear = report.optional.find(
    (e) => e.name === 'OES_texture_float_linear'
  );
  if (floatLinear && !floatLinear.available) {
    adjusted = {
      ...adjusted,
      blurPasses: Math.min(adjusted.blurPasses, 2), // Reduce blur quality
    };
  }

  return adjusted;
}
```

---

## Progressive Enhancement

### Load Effects One by One

Instead of loading all effects at once (which can cause a 200ms+ hitch
during shader compilation), load them progressively.

```typescript
// lib/degradation/progressiveLoad.ts

/**
 * Progressively compile and activate effect layers.
 * Each layer's shader is compiled in a separate animation frame
 * to avoid blocking the main thread for too long.
 */
export async function progressiveLoadLayers(
  layers: LayerConfig[],
  compileFn: (layer: LayerConfig) => Promise<void>,
  onProgress: (loaded: number, total: number) => void
): Promise<void> {
  const total = layers.length;

  for (let i = 0; i < total; i++) {
    // Compile one layer
    await compileFn(layers[i]);

    // Report progress
    onProgress(i + 1, total);

    // Yield to the main thread between compilations
    // This keeps the UI responsive during loading
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

/**
 * Stagger effect activation over multiple frames.
 * First frame: render scene only (no effects)
 * Second frame: add first effect
 * Third frame: add second effect
 * ...
 *
 * This prevents the "everything compiles at once" hitch.
 */
export function useProgressiveEffects(
  allLayers: LayerConfig[],
  frameDelay: number = 2 // Frames between each effect activation
): LayerConfig[] {
  const [activeLayers, setActiveLayers] = useState<LayerConfig[]>([]);
  const frameCount = useRef(0);

  useFrame(() => {
    frameCount.current += 1;

    if (activeLayers.length < allLayers.length) {
      const nextIndex = activeLayers.length;
      if (frameCount.current % frameDelay === 0) {
        setActiveLayers((prev) => [...prev, allLayers[nextIndex]]);
      }
    }
  });

  return activeLayers;
}
```

### Feature Flag Based Enhancement

```typescript
// lib/degradation/featureFlags.ts

import { GPUCapabilities } from './gpuTier';
import { QualityPreset } from './qualityPresets';

/**
 * Feature flags derived from GPU capabilities.
 * Use these to conditionally enable/disable features in components.
 */
export interface FeatureFlags {
  bloom: boolean;
  blur: boolean;
  progressiveBlur: boolean;
  fog: boolean;
  blobTracking: boolean;
  radialBlur: boolean;
  zoomBlur: boolean;
  grain: boolean;
  vignette: boolean;
  chromaticAberration: boolean;
  colorGrading: boolean;
  waterRipple: boolean;
  animatedNoise: boolean;
  hdrCompositing: boolean;
  multiPassBlur: boolean;
}

export function deriveFeatureFlags(
  caps: GPUCapabilities,
  preset: QualityPreset
): FeatureFlags {
  const canDoFloat = caps.supportsFloat && caps.supportsHalfFloat;

  return {
    // Core effects -- available on all tiers
    grain: true,
    vignette: true,
    brightness: true,
    colorGrading: true,

    // Medium effects -- require mid-tier or better
    bloom: canDoFloat && preset.bloomMipLevels > 0,
    blur: true,
    chromaticAberration: caps.tier !== 'software',

    // Heavy effects -- require high tier
    fog: caps.tier === 'high' || caps.tier === 'mid',
    progressiveBlur: caps.tier === 'high' || caps.tier === 'mid',
    radialBlur: caps.tier !== 'software',
    zoomBlur: caps.tier !== 'software',
    waterRipple: caps.tier === 'high',

    // Simulation effects -- require high tier
    blobTracking: preset.simulationEnabled,

    // Quality features
    animatedNoise: preset.animationQuality === 'full',
    hdrCompositing: canDoFloat,
    multiPassBlur: preset.blurPasses > 1,
  };
}
```

---

## Adaptive Quality (Runtime)

### FPS-Based Quality Adjustment

```typescript
// lib/degradation/adaptiveQuality.ts

import { QualityPreset, QUALITY_PRESETS } from './qualityPresets';

interface AdaptiveQualityConfig {
  targetFPS: number;          // Target frame rate (default: 55)
  downgradeThreshold: number; // FPS below this triggers downgrade (default: 30)
  upgradeThreshold: number;   // FPS above this triggers upgrade (default: 58)
  cooldownMs: number;         // Minimum time between adjustments (default: 5000)
  measureWindowMs: number;    // FPS measurement window (default: 3000)
}

export class AdaptiveQualityManager {
  private readonly config: AdaptiveQualityConfig;
  private currentPresetName: string;
  private lastAdjustmentTime: number = 0;
  private fpsHistory: number[] = [];
  private readonly presetOrder = ['low', 'medium', 'high'];
  private readonly onChange: (preset: QualityPreset, reason: string) => void;

  constructor(
    initialPreset: string,
    onChange: (preset: QualityPreset, reason: string) => void,
    config?: Partial<AdaptiveQualityConfig>
  ) {
    this.currentPresetName = initialPreset;
    this.onChange = onChange;
    this.config = {
      targetFPS: 55,
      downgradeThreshold: 30,
      upgradeThreshold: 58,
      cooldownMs: 5000,
      measureWindowMs: 3000,
      ...config,
    };
  }

  /**
   * Call this every frame with the current FPS.
   */
  reportFPS(fps: number): void {
    this.fpsHistory.push(fps);

    // Keep only recent history
    const maxSamples = Math.ceil(
      (this.config.measureWindowMs / 1000) * 60
    );
    while (this.fpsHistory.length > maxSamples) {
      this.fpsHistory.shift();
    }

    // Check if we have enough data
    if (this.fpsHistory.length < 30) return; // Need at least 0.5s of data

    // Check cooldown
    const now = Date.now();
    if (now - this.lastAdjustmentTime < this.config.cooldownMs) return;

    // Calculate median FPS
    const sorted = [...this.fpsHistory].sort((a, b) => a - b);
    const medianFPS = sorted[Math.floor(sorted.length / 2)];

    // Downgrade if FPS is too low
    if (medianFPS < this.config.downgradeThreshold) {
      this.downgrade(`Median FPS ${medianFPS.toFixed(0)} below threshold ${this.config.downgradeThreshold}`);
    }
    // Upgrade if FPS is consistently high
    else if (medianFPS > this.config.upgradeThreshold) {
      this.upgrade(`Median FPS ${medianFPS.toFixed(0)} above threshold ${this.config.upgradeThreshold}`);
    }
  }

  private downgrade(reason: string): void {
    const currentIndex = this.presetOrder.indexOf(this.currentPresetName);
    if (currentIndex <= 0) return; // Already at lowest

    const newPresetName = this.presetOrder[currentIndex - 1];
    this.currentPresetName = newPresetName;
    this.lastAdjustmentTime = Date.now();
    this.fpsHistory = []; // Reset history after adjustment

    const preset = QUALITY_PRESETS[newPresetName];
    console.info(`[AdaptiveQuality] Downgraded to "${newPresetName}": ${reason}`);
    this.onChange(preset, reason);
  }

  private upgrade(reason: string): void {
    const currentIndex = this.presetOrder.indexOf(this.currentPresetName);
    if (currentIndex >= this.presetOrder.length - 1) return; // Already at highest

    const newPresetName = this.presetOrder[currentIndex + 1];
    this.currentPresetName = newPresetName;
    this.lastAdjustmentTime = Date.now();
    this.fpsHistory = [];

    const preset = QUALITY_PRESETS[newPresetName];
    console.info(`[AdaptiveQuality] Upgraded to "${newPresetName}": ${reason}`);
    this.onChange(preset, reason);
  }

  getCurrentPreset(): QualityPreset {
    return QUALITY_PRESETS[this.currentPresetName];
  }

  reset(presetName: string): void {
    this.currentPresetName = presetName;
    this.fpsHistory = [];
    this.lastAdjustmentTime = 0;
  }
}
```

### Thermal Throttling Detection

```typescript
// lib/degradation/thermalDetect.ts

/**
 * Detect GPU thermal throttling by monitoring FPS trends.
 *
 * Thermal throttling pattern:
 * - FPS starts high (60fps)
 * - Gradually decreases over 1-5 minutes
 * - Stabilizes at a lower level (30-40fps)
 * - If load is reduced, FPS recovers
 *
 * This is common on laptops and mobile devices.
 */
export class ThermalThrottleDetector {
  private fpsWindows: Array<{ timestamp: number; avgFPS: number }> = [];
  private readonly windowSizeMs: number = 10000; // 10-second windows
  private readonly onThrottleDetected: () => void;

  constructor(onThrottleDetected: () => void) {
    this.onThrottleDetected = onThrottleDetected;
  }

  addWindow(avgFPS: number): void {
    this.fpsWindows.push({ timestamp: Date.now(), avgFPS });

    // Keep last 6 windows (1 minute)
    if (this.fpsWindows.length > 6) {
      this.fpsWindows.shift();
    }

    this.analyze();
  }

  private analyze(): void {
    if (this.fpsWindows.length < 4) return; // Need at least 40 seconds of data

    // Check for consistent downward trend
    let consecutiveDrops = 0;
    for (let i = 1; i < this.fpsWindows.length; i++) {
      if (this.fpsWindows[i].avgFPS < this.fpsWindows[i - 1].avgFPS - 2) {
        consecutiveDrops++;
      } else {
        consecutiveDrops = 0;
      }
    }

    // If FPS has dropped for 3+ consecutive windows, likely thermal throttling
    if (consecutiveDrops >= 3) {
      const firstFPS = this.fpsWindows[0].avgFPS;
      const lastFPS = this.fpsWindows[this.fpsWindows.length - 1].avgFPS;
      const dropPercent = ((firstFPS - lastFPS) / firstFPS) * 100;

      if (dropPercent > 20) {
        console.warn(
          `[ThermalDetector] Possible thermal throttling: FPS dropped ${dropPercent.toFixed(0)}% ` +
          `(${firstFPS.toFixed(0)} -> ${lastFPS.toFixed(0)}) over ${this.fpsWindows.length * 10}s`
        );
        this.onThrottleDetected();
        this.fpsWindows = []; // Reset after detection
      }
    }
  }
}
```

---

## Resolution Scaling

### Dynamic DPR Adjustment

```typescript
// lib/degradation/resolutionScaling.ts

/**
 * Dynamically adjust the device pixel ratio based on performance.
 * Lower DPR = fewer pixels to shade = higher FPS.
 *
 * DPR steps: 2.0 -> 1.5 -> 1.0 -> 0.75 -> 0.5
 */
export class DynamicResolutionScaler {
  private readonly steps = [2.0, 1.5, 1.0, 0.75, 0.5];
  private currentStepIndex: number;
  private readonly maxDPR: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly onDPRChange: (dpr: number) => void;

  constructor(
    renderer: THREE.WebGLRenderer,
    maxDPR: number,
    onDPRChange: (dpr: number) => void
  ) {
    this.renderer = renderer;
    this.maxDPR = maxDPR;
    this.onDPRChange = onDPRChange;

    // Start at the highest DPR that does not exceed maxDPR
    this.currentStepIndex = this.steps.findIndex((s) => s <= maxDPR);
    if (this.currentStepIndex === -1) this.currentStepIndex = this.steps.length - 1;
  }

  get currentDPR(): number {
    return this.steps[this.currentStepIndex];
  }

  lower(): boolean {
    if (this.currentStepIndex >= this.steps.length - 1) return false;

    this.currentStepIndex++;
    const newDPR = this.steps[this.currentStepIndex];
    this.renderer.setPixelRatio(newDPR);
    this.onDPRChange(newDPR);

    console.info(`[ResolutionScaler] Lowered DPR to ${newDPR}`);
    return true;
  }

  raise(): boolean {
    if (this.currentStepIndex <= 0) return false;
    if (this.steps[this.currentStepIndex - 1] > this.maxDPR) return false;

    this.currentStepIndex--;
    const newDPR = this.steps[this.currentStepIndex];
    this.renderer.setPixelRatio(newDPR);
    this.onDPRChange(newDPR);

    console.info(`[ResolutionScaler] Raised DPR to ${newDPR}`);
    return true;
  }
}
```

---

## User-Facing Quality Controls

### Quality Settings UI

```tsx
// components/editor/QualitySettings.tsx
'use client';

import { useState, useCallback } from 'react';
import { QualityPreset, QUALITY_PRESETS } from '@/lib/degradation/qualityPresets';

interface QualitySettingsProps {
  currentPreset: QualityPreset;
  autoQualityEnabled: boolean;
  gpuTier: string;
  currentFPS: number;
  currentDPR: number;
  onPresetChange: (preset: QualityPreset) => void;
  onAutoQualityToggle: (enabled: boolean) => void;
}

export function QualitySettings({
  currentPreset,
  autoQualityEnabled,
  gpuTier,
  currentFPS,
  currentDPR,
  onPresetChange,
  onAutoQualityToggle,
}: QualitySettingsProps) {
  return (
    <div style={{
      padding: '12px',
      backgroundColor: '#1a1a2e',
      borderRadius: '8px',
      color: '#e0e0e0',
      fontFamily: 'system-ui',
      fontSize: '13px',
    }}>
      <div style={{ marginBottom: '8px', fontWeight: 600 }}>Quality Settings</div>

      {/* GPU Info */}
      <div style={{ color: '#666', marginBottom: '12px', fontSize: '11px' }}>
        GPU Tier: {gpuTier} | FPS: {currentFPS} | DPR: {currentDPR.toFixed(1)}
      </div>

      {/* Auto Quality Toggle */}
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '12px',
        cursor: 'pointer',
      }}>
        <input
          type="checkbox"
          checked={autoQualityEnabled}
          onChange={(e) => onAutoQualityToggle(e.target.checked)}
        />
        Auto-adjust quality based on FPS
      </label>

      {/* Quality Preset Buttons */}
      <div style={{ display: 'flex', gap: '4px' }}>
        {Object.entries(QUALITY_PRESETS).map(([key, preset]) => (
          <button
            key={key}
            onClick={() => onPresetChange(preset)}
            disabled={autoQualityEnabled}
            style={{
              flex: 1,
              padding: '8px',
              border: currentPreset.name === preset.name
                ? '2px solid #4a9eff'
                : '1px solid #333',
              borderRadius: '4px',
              backgroundColor: currentPreset.name === preset.name ? '#1a2a4e' : '#222',
              color: autoQualityEnabled ? '#555' : '#ddd',
              cursor: autoQualityEnabled ? 'not-allowed' : 'pointer',
              fontSize: '12px',
            }}
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* Current Settings Summary */}
      <div style={{
        marginTop: '12px',
        padding: '8px',
        backgroundColor: '#111',
        borderRadius: '4px',
        fontSize: '11px',
        color: '#888',
        lineHeight: 1.6,
      }}>
        Max DPR: {currentPreset.maxDPR} |
        Max Layers: {currentPreset.maxLayers} |
        Noise Octaves: {currentPreset.noiseOctaves} |
        Blur Passes: {currentPreset.blurPasses} |
        Bloom Mips: {currentPreset.bloomMipLevels} |
        Simulation: {currentPreset.simulationEnabled ? 'On' : 'Off'}
      </div>
    </div>
  );
}
```
