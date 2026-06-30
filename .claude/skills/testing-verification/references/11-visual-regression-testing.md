# Visual Regression Testing
> Skill reference for testing-verification: pixel/structural-parity testing for any visual output
> (rendered pages, canvas, generated images, charts, PDFs). Domain-neutral.
---

## Table of Contents

1. [Visual Parity — The Hardest Constraint](#section-1-visual-parity--the-hardest-constraint)
2. [Golden Reference System](#section-2-golden-reference-system)
3. [Capturing Output for Comparison](#section-3-capturing-output-for-comparison)
4. [Comparison Metrics](#section-4-comparison-metrics)
5. [CI Pipeline Integration](#section-5-ci-pipeline-integration)
6. [Quick Reference](#section-6-quick-reference)

---

## Section 1: Visual Parity — The Hardest Constraint

### Definition

Visual parity means a system's rendered output MUST produce pixel-identical (within tolerance)
output to a known-good reference of the same input. It is one of the hardest constraints to test
because the output is a 2D image, not a value you can assert with `===`:

- The same code can render slightly differently across machines, browsers, and GPU drivers.
- A tiny per-channel difference can be visible to a human or cascade through later compositing.
- "Looks right" is subjective; you need a metric and a threshold to gate a build on it.

Visual parity is the acceptance criterion for any feature whose *correctness IS its appearance*
(rendering, charting, image generation, layout). If the output does not match the reference, the
feature is broken — regardless of whether the code looks correct.

### Why This Is Hard

#### Floating-Point and Rendering Non-Determinism

Transcendental and accelerated operations (and GPU/driver math in particular) are not guaranteed to
be bitwise-reproducible across vendors. Differences live in the least-significant bits, but once they
feed into color or position calculations, the per-channel diff can reach 1–2/255 after quantization
to 8-bit output.

#### Driver / Engine Differences

Even on the same hardware vendor, engine or driver versions can change:
- Interpolation / filtering rounding,
- Blending precision,
- Optimizer instruction reordering that changes float precision,
- Default edge-case behavior.

#### Sampling Edge Cases

Sampling at exact pixel boundaries can differ due to subpixel-coordinate rounding conventions,
level-of-detail selection, and edge/border behavior.

#### Accumulated Error

Limited intermediate precision (e.g. 16-bit channels) gives only ~3 decimal digits in [0,1].
Error accumulated across many composited or transformed stages can drift visibly if operations
are reordered.

### The Two Defenses

1. **Pin determinism where you can** — disable anti-aliasing for parity runs, fix all time/seed
   inputs, render in a deterministic software renderer in CI (see Section 5).
2. **Tolerate the rest with a metric + threshold** — never assert exact equality on output produced
   by non-deterministic math; compare with a structural metric and a calibrated tolerance.

---

## Section 2: Golden Reference System

### What Golden References Are

A golden reference is a pre-rendered, human-approved capture of known-correct output. It is the
ground truth for a regression test: each run captures current output and compares it against the
golden — if they differ beyond tolerance, the test fails.

Golden references capture:
- The exact output for a specific input/configuration,
- At a specific resolution,
- In a specific (ideally deterministic) rendering environment,
- With all variable inputs pinned to known values (time, seed, mouse, locale).

### Capture Pipeline

1. Set up the scene/page/input with deterministic state (fixed time, fixed seed).
2. Render one frame / one snapshot.
3. Read the pixels.
4. Encode as PNG (with a metadata header if useful).
5. Save to the goldens directory.

### Storage

Golden references are binary PNG files, often 1–5 MB each; a full suite can reach hundreds of MB to
a few GB. Use **Git LFS** (or an object store) for them — never commit large binaries directly to
the main history.

### Updating Golden References

Golden references must be regenerated when:
1. **Intentional visual changes** — new logic, style/format changes.
2. **Rendering-stack changes** — engine/format/version upgrades that change rendering behavior.
3. **New surface added** — needs its own golden set.

**Rule: never auto-commit golden updates.** A human must visually inspect every changed golden
before accepting it. Automated golden updates silently hide regressions — the exact failure this
test exists to catch.

### Naming Convention

    {name}_{widthxheight}_{environment}.golden.png

Examples:

    home_1920x1080_software.golden.png
    home_1280x720_software.golden.png
    chart-bar_512x512_software.golden.png

The deterministic-software-renderer variant is the CI-canonical golden because software rendering is
reproducible across machines.

### Multi-Environment Handling

Different GPUs/browsers produce slightly different output due to driver differences. A workable
strategy:

1. **CI uses a deterministic software renderer only** — reproducible, no GPU required.
2. **Local dev uses the real engine** — compared against environment-specific goldens.
3. **Cross-environment validation** — periodic manual checks across real targets.

Store separate goldens per environment:

    test/goldens/
      software/   # CI canonical — always checked
      chrome/     # developer reference
      firefox/    # developer reference

Cross-environment tolerance is relaxed (e.g. SSIM > 0.97 between environments); within the same
environment, require a stricter bar (e.g. SSIM > 0.995).

---

## Section 3: Capturing Output for Comparison

### Capturing a Rendered Page or Canvas (Playwright)

A full-page `page.screenshot()` captures DOM, overlays, and chrome. For parity testing you usually
want a specific element or the raw pixels of one surface.

#### Element / canvas screenshot

```typescript
import { test, expect, Page } from "@playwright/test";

async function captureElementPixels(page: Page, selector: string): Promise<Buffer> {
  const el = page.locator(selector);
  return el.screenshot({ type: "png" });
}
```

#### Canvas via toDataURL

```typescript
async function captureCanvasPixels(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    if (!canvas) throw new Error("No canvas element found");
    return canvas.toDataURL("image/png");
  });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(base64, "base64");
}
```

> Caveat: some rendering backends discard their drawing buffer after a frame for performance, so a
> post-hoc read returns a blank image. If that applies to your stack, enable a test-only flag that
> preserves the buffer when running under test.

### Comparing Images with pixelmatch

`pixelmatch` is the standard library for pixel-level image comparison in Node.js — fast (pure JS),
and it produces a visual diff image.

```typescript
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import * as fs from "fs";

interface ComparisonResult {
  diffCount: number;
  diffPercentage: number;
  diffImage: PNG;
  passed: boolean;
}

function compareImages(
  actualPath: string,
  goldenPath: string,
  options: { threshold?: number; maxDiffPercentage?: number } = {}
): ComparisonResult {
  const { threshold = 0.1, maxDiffPercentage = 0.1 } = options;
  const actual = PNG.sync.read(fs.readFileSync(actualPath));
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));

  if (actual.width !== golden.width || actual.height !== golden.height) {
    throw new Error("Resolution mismatch");
  }

  const { width, height } = actual;
  const diff = new PNG({ width, height });
  const diffCount = pixelmatch(
    actual.data, golden.data, diff.data, width, height,
    { threshold, includeAA: false, alpha: 0.1,
      diffColor: [255, 0, 0], diffColorAlt: [0, 255, 0] }
  );

  const totalPixels = width * height;
  const diffPercentage = (diffCount / totalPixels) * 100;
  return { diffCount, diffPercentage, diffImage: diff,
           passed: diffPercentage <= maxDiffPercentage };
}
```

Pattern: navigate to the test surface, wait for a ready signal, capture, compare against the golden,
and save the diff image on failure.

### Handling Anti-Aliasing Differences

1. **Disable AA (preferred for parity tests)** — deterministic edges, no MSAA variance.
2. **Blur before comparison** — when AA can't be disabled, blur both images (e.g. `sharp`,
   sigma ≈ 1.0) before `pixelmatch` to smooth out AA differences.
3. **`includeAA: false`** — `pixelmatch` detects anti-aliased pixels and excludes them from the diff
   count; works for simple cases.

---

## Section 4: Comparison Metrics

### SSIM — Structural Similarity Index

SSIM (Wang et al., 2004) is the primary metric for visual parity because it measures *perceived*
quality rather than raw pixel difference — human vision is more sensitive to structural change than
to uniform brightness shifts. SSIM is computed over sliding windows (typically 11×11
Gaussian-weighted).

| SSIM Score | Verdict | Action |
|-----------|---------|--------|
| > 0.99 | PASS | Visually identical. Ship it. |
| 0.95 – 0.99 | WARNING | Investigate — float drift or environment difference. |
| < 0.95 | FAIL | Structural difference. Block the build. |

Calibrate these to your surface; the values above are a reasonable starting point. A 0.99 SSIM means
the images are perceptually indistinguishable at normal viewing distance.

### Pixel-Diff Metrics

**MSE** — `(1/N) · Σ(a−b)²`. Fast, but treats all pixels equally; one hot pixel dominates. Use for
quick sanity checks, not as a gate.

**PSNR** — `20 · log10(255 / sqrt(MSE))`. Target > 45 dB for parity.

| PSNR (dB) | Quality |
|-----------|---------|
| > 50 | Excellent — visually identical |
| 40 – 50 | Good — minor differences |
| 30 – 40 | Fair — noticeable differences |
| < 30 | Poor — significant degradation |

**dE2000** (CIE perceptual color difference, in CIELAB): `< 1.0` imperceptible, `1.0–2.0` perceptible
on close observation, `> 3.5` clearly different. For parity, target average dE2000 < 1.0 with no
pixel exceeding 3.5 (e.g. via the `delta-e` package).

### Which Metric When

| Scenario | Primary | Secondary | Rationale |
|----------|---------|-----------|-----------|
| Output vs reference parity | SSIM | Per-channel max diff | Overall quality + catch outliers |
| Regression after refactor | Pixel-exact diff | PSNR | Refactors should change zero pixels |
| Cross-environment compat | SSIM | dE2000 average | Tolerate driver differences |
| CI gate (block merge) | SSIM > 0.99 | Max pixel diff < 5/255 | Strict but accounts for float rounding |
| Visual review (human) | Screenshot overlay | Side-by-side diff | Let humans catch what metrics miss |

---

## Section 5: CI Pipeline Integration

### Workflow Shape

1. **Checkout with LFS** (`lfs: true`) to pull golden references.
2. **Install the browser** (e.g. `npx playwright install chromium --with-deps`).
3. **Build** the production artifact before testing.
4. **Start the server** in the background, wait for readiness.
5. **Run the visual-regression project/suite.**
6. **Upload artifacts** — diff images on failure (e.g. 14-day retention).
7. **Upload the HTML report** (always).

### Deterministic Output in CI

Prefer a deterministic **software renderer** in CI so output is reproducible across machines and no
GPU is required. Pin viewport size, screenshot-only-on-failure, `retries=0` (a flake is a real
problem), and a generous per-test timeout. The tradeoff is speed (software rendering is much slower
than GPU) — render the minimum number of frames needed.

### Artifact Storage

On failure, upload three artifacts so a reviewer can adjudicate without re-running:
1. **Actual** — what the current code produced.
2. **Diff** — highlighted pixels where actual differs from golden.
3. **Golden** — what it should look like.

---

## Section 6: Quick Reference

### Thresholds

| Metric | Pass | Warn | Fail |
|--------|------|------|------|
| SSIM | > 0.99 | 0.95–0.99 | < 0.95 |
| PSNR | > 45 dB | 38–45 dB | < 38 dB |
| Max pixel diff | ≤ 2/255 | 3–5/255 | > 5/255 |
| dE2000 average | < 1.0 | 1.0–2.0 | > 2.0 |
| Diff pixel % | < 0.05% | 0.05–0.5% | > 0.5% |

### Adding a New Visual Test

1. Pin all variable inputs (time, seed, locale) to deterministic values.
2. Capture the golden in the CI-canonical environment, then have a human inspect and approve it.
3. Add the parity test (capture → compare → fail on threshold, save diff on failure).
4. Run locally and in CI to confirm it passes deterministically.

### npm Dependencies

```json
{
  "devDependencies": {
    "@playwright/test": "^1.42.0",
    "pixelmatch": "^5.3.0",
    "pngjs": "^7.0.0",
    "sharp": "^0.33.0",
    "delta-e": "^0.1.1"
  }
}
```

```bash
npm install -D @playwright/test pixelmatch pngjs sharp delta-e
npx playwright install chromium --with-deps
```
