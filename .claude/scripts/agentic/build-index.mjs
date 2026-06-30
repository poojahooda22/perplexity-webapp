#!/usr/bin/env node
/**
 * build-index.mjs — vector index builder for the project's catalog of reusable units.
 *
 * Walks the catalog definitions directory (excluding retired/archived entries and
 * generated barrel/index files), extracts a corpus document per catalog entry,
 * builds a BM25 index, optionally calls an embedding API, and writes:
 *   .agents/vector-index/index.jsonl   — one JSON entry per catalog entry per line
 *   .agents/vector-index/corpus.json   — corpus-level statistics + build metadata
 *
 * "Catalog entry" stands for whatever indexable reusable unit the host project
 * tracks (a component, module, template, dataset record, knowledge entry, etc.).
 * Each source file is expected to expose a string `id:` field plus optional
 * `name:`, `category:`, grouping `section:` labels, field/option `label:` values,
 * and a free-text `description:`. Bind the directory + barrel paths below to the
 * project's actual registry; the BM25 + embedding mechanism is project-agnostic.
 *
 * Hard contracts:
 *   - Zero npm dependencies (built-in Node modules + https for the embed call).
 *   - Atomic writes via .tmp + rename.
 *   - Drift detection against the generated barrel: every imported id must surface
 *     a definition file the regex extractor can read.
 *   - Cost gate: prints estimated API cost; refuses to call without
 *     CONFIRM_EMBED=1 in env (no interactive stdin).
 *   - All progress / warnings / errors go to stderr; stdout reserved.
 *
 * Subcommands:
 *   build [--no-embed]   full build; --no-embed skips the API call (vector: null)
 *   stats                print corpus stats + estimated embedding cost
 *   verify               check parity between definition files and existing index
 *   embed-only           populate vectors on an index built earlier with --no-embed
 *
 * Exit codes:
 *   0   — success
 *   1   — guard blocked the operation (drift, missing CONFIRM_EMBED, malformed file)
 *   2   — file or directory not found
 *   3   — embedding API failed twice
 *   99  — unknown error
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
} from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// ─── Constants ──────────────────────────────────────────────────────────────
// Paths are derived project-relative to the repo root. This script lives at
// `<repo>/.claude/scripts/agentic/build-index.mjs`, so the repo root is three
// directories up. Override any path via the env vars below to point the builder
// at a sandbox or a non-default catalog layout.
//
//   CATALOG_DEFINITIONS_DIR — directory of catalog-entry source files to index
//                             (default: <repo>/lib/catalog/definitions — adjust
//                             per project to wherever the registry's entries live)
//   CATALOG_INDEX_DIR       — output directory for index.jsonl + corpus.json
//                             (default: <repo>/.agents/vector-index)
//   CATALOG_BARREL          — generated barrel file listing every imported id,
//                             used for drift detection (optional)

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
// .claude/scripts/agentic → repo root is three levels up.
const REPO_ROOT = path.win32.resolve(SCRIPT_DIR, '..', '..', '..').replace(/\\/g, '/')

const DEFINITIONS_DIR = (
  process.env.CATALOG_DEFINITIONS_DIR ||
  path.win32.join(REPO_ROOT, 'lib/catalog/definitions')
).replace(/\\/g, '/')
const OUTPUT_DIR = (
  process.env.CATALOG_INDEX_DIR ||
  path.win32.join(REPO_ROOT, '.agents/vector-index')
).replace(/\\/g, '/')
const INDEX_PATH = path.win32.join(OUTPUT_DIR, 'index.jsonl').replace(/\\/g, '/')
const CORPUS_PATH = path.win32.join(OUTPUT_DIR, 'corpus.json').replace(/\\/g, '/')
const ALL_BARREL_PATH = (
  process.env.CATALOG_BARREL ||
  path.win32.join(DEFINITIONS_DIR, '_all.generated.ts')
).replace(/\\/g, '/')

// Files / directories ignored by the walker. Underscore-prefixed dirs are
// reserved for retired/internal cohorts; generated barrels and index files are
// excluded because they aggregate rather than define entries.
const SKIP_DIRS = new Set(['_retired', '_archived'])
const SKIP_FILES = new Set([
  '_all.generated.ts',
  '_catalog.generated.ts',
  'index.ts',
])

// BM25 hyper-parameters. k1 controls term-frequency saturation; b controls
// length normalization. Standard Robertson/Sparck-Jones defaults.
const BM25_K1 = 1.2
const BM25_B = 0.75

// Tokenizer stopword list — minimal, dropping only the highest-frequency
// English fillers that carry no semantic signal in the catalog corpus.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to'])

// Embedding API configuration. Provider chosen by env var presence.
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/embeddings'
const OPENAI_MODEL = 'text-embedding-3-small'
const OPENAI_DIMS = 1536
// OpenAI pricing for text-embedding-3-small at the time of writing
// (per 1M input tokens).
const OPENAI_USD_PER_1M_TOKENS = 0.02

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-4-lite'
const VOYAGE_DIMS = 1024
const VOYAGE_USD_PER_1M_TOKENS = 0.02

const EMBED_BATCH_SIZE = 100
const HTTP_TIMEOUT_MS = 30_000

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[build-index] ${msg}\n`)
}

function warn(msg) {
  process.stderr.write(`[build-index] WARN: ${msg}\n`)
}

function fail(code, msg) {
  process.stderr.write(`[build-index] ERROR: ${msg}\n`)
  process.exit(code)
}

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          out[a.slice(2)] = next
          i++
        } else {
          out[a.slice(2)] = true
        }
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

// ─── File walk ──────────────────────────────────────────────────────────────

/**
 * Recursive walk of DEFINITIONS_DIR, returning absolute paths to every
 * catalog-entry .ts file the index should cover. Skips retired/archived dirs,
 * generated barrels, and underscore-prefixed siblings.
 */
function walkDefinitionFiles(dir, results = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    fail(2, `cannot read ${dir}: ${err.message}`)
  }
  for (const entry of entries) {
    const full = path.win32.join(dir, entry.name).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      // Underscore-prefixed dirs are reserved for retired/internal cohorts.
      if (entry.name.startsWith('_')) continue
      walkDefinitionFiles(full, results)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts')) continue
    if (SKIP_FILES.has(entry.name)) continue
    if (entry.name.startsWith('_')) continue
    results.push(full)
  }
  return results
}

// ─── Corpus extraction ──────────────────────────────────────────────────────

/**
 * Extract a single field value via simple regex. Returns null when the field
 * is absent. The patterns mirror whatever generator emits the project's catalog
 * registry, to stay in lockstep with how entries are declared.
 */
function extractScalarString(source, field) {
  const re = new RegExp(`\\b${field}:\\s*['"]([^'"]+)['"]`)
  const m = source.match(re)
  return m ? m[1] : null
}

function extractScalarBoolean(source, field) {
  const re = new RegExp(`\\b${field}:\\s*(true|false)`)
  const m = source.match(re)
  if (!m) return null
  return m[1] === 'true'
}

/**
 * Extract every `label: '...'` occurrence inside the file. Both
 * property labels and select-option labels use the same `label:` key, so a
 * single sweep gathers them. Empty labels (`label: ''`) are dropped — those
 * conventionally mark hidden/internal inputs that carry no search vocabulary.
 */
function extractAllLabels(source) {
  const re = /\blabel:\s*['"]([^'"]*)['"]/g
  const labels = []
  let m
  while ((m = re.exec(source)) !== null) {
    const v = m[1].trim()
    if (v.length > 0) labels.push(v)
  }
  return labels
}

/**
 * Extract every `section: '...'` occurrence and dedupe in source order.
 */
function extractSections(source) {
  const re = /\bsection:\s*['"]([^'"]+)['"]/g
  const seen = new Set()
  const out = []
  let m
  while ((m = re.exec(source)) !== null) {
    const v = m[1].trim()
    if (v.length === 0) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Crude split between property labels and option labels. A property's `label:`
 * sits next to a `key:`/`uniform:`/`control:` field; an option's `label:` sits
 * next to a `value:` field. We split on a window heuristic — read 80 chars
 * after the label match and check for `value:` vs `control:` / `key:`.
 */
function splitPropertyAndOptionLabels(source) {
  const re = /\blabel:\s*['"]([^'"]*)['"]/g
  const propertyLabels = []
  const optionLabels = []
  let m
  while ((m = re.exec(source)) !== null) {
    const v = m[1].trim()
    if (v.length === 0) continue
    const window = source.slice(m.index, Math.min(m.index + 200, source.length))
    // Option entries are short objects: { label: 'X', value: N }.
    // Property entries are larger and carry control/key/uniform markers.
    const isOption = /\bvalue:/.test(window) && !/\bcontrol:/.test(window) && !/\bkey:/.test(window)
    if (isOption) {
      optionLabels.push(v)
    } else {
      propertyLabels.push(v)
    }
  }
  return { propertyLabels, optionLabels }
}

// The frontmatter key whose block holds an entry's referenced type/class names,
// plus the suffix those names share. Some catalogs declare a `deps:`/`uses:`
// block of typed identifiers that carry strong semantic vocabulary (e.g. a
// `CheckoutFormModule` → checkout + form). Override per project; leave the key
// absent in a source file and the extractor simply returns nothing for it.
const REFERENCE_BLOCK_KEY = process.env.CATALOG_REFERENCE_BLOCK_KEY || 'refs'

/**
 * Extract referenced type/class identifiers (PascalCase) that appear inside the
 * entry's reference block (REFERENCE_BLOCK_KEY). The audit identifies these as a
 * strong semantic hint. Scoping to the block (rather than sweeping the whole
 * file) avoids over-collecting unrelated type references elsewhere in the file.
 */
function extractReferenceClassNames(source) {
  // Find the reference block start, e.g. `refs: {`.
  const start = source.search(new RegExp(`\\b${REFERENCE_BLOCK_KEY}\\s*:\\s*\\{`))
  if (start === -1) return []
  // Walk braces from the opening `{` to find the matching close.
  let depth = 0
  let openIdx = -1
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (c === '{') {
      if (openIdx === -1) openIdx = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        const block = source.slice(openIdx, i + 1)
        const re = /\b([A-Z][A-Za-z0-9]+)\b/g
        const seen = new Set()
        const out = []
        let m
        while ((m = re.exec(block)) !== null) {
          if (!seen.has(m[1])) {
            seen.add(m[1])
            out.push(m[1])
          }
        }
        return out
      }
    }
  }
  return []
}

// Boolean facet fields read off each entry, if present. These are exact-match
// filter facets, NOT folded into the embedding text. Override per project to the
// boolean flags the catalog records actually expose.
const BOOLEAN_FACETS = (process.env.CATALOG_BOOLEAN_FACETS
  ? process.env.CATALOG_BOOLEAN_FACETS.split(',').map(s => s.trim()).filter(Boolean)
  : ['animated', 'interactive', 'isNew'])

// The scalar "cost"/"tier" facet, if the project records one (e.g. a
// performance/cost budget). Stored as metadata, not embedded.
const COST_FACET_KEY = process.env.CATALOG_COST_FACET_KEY || 'cost'

/**
 * Extract a catalog entry's metadata + composite corpus document from a single
 * .ts source file. Returns null on missing id (file is not a catalog entry).
 */
function extractEntry(filePath) {
  let source
  try {
    source = readFileSync(filePath, 'utf-8')
  } catch (err) {
    fail(2, `cannot read ${filePath}: ${err.message}`)
  }

  const id = extractScalarString(source, 'id')
  if (!id) return null

  const name = extractScalarString(source, 'name') || id
  const category = extractScalarString(source, 'category') || 'general'
  const cost = extractScalarString(source, COST_FACET_KEY) || 'medium'

  // Generic boolean facets — exact-match filters, not embedding text.
  const facets = {}
  for (const f of BOOLEAN_FACETS) {
    facets[f] = extractScalarBoolean(source, f) ?? false
  }

  const sections = extractSections(source)
  const { propertyLabels, optionLabels } = splitPropertyAndOptionLabels(source)
  const refNames = extractReferenceClassNames(source)

  // Entries may carry a free-text `description:` field. When present, fold it in.
  const description = extractScalarString(source, 'description')

  // Document text: pipe-delimited segments in a fixed ordering. BM25
  // tokenization treats the segments uniformly; the segment markers are
  // dropped as non-alphanumerics during tokenization.
  const segments = [
    name,
    category,
    propertyLabels.join(', '),
    sections.join(', '),
    optionLabels.join(', '),
    refNames.join(', '),
  ]
  if (description) segments.push(description)
  const corpus = segments
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .join(' | ')

  // Path is stored repo-relative for portability across machines.
  const repoRel = filePath
    .replace(REPO_ROOT.replace(/\\/g, '/'), '')
    .replace(/^\/+/, '')

  return {
    id,
    name,
    category,
    cost,
    facets,
    refNames,
    path: repoRel,
    corpus,
  }
}

// ─── BM25 index ─────────────────────────────────────────────────────────────

/**
 * Tokenize a corpus document. Lowercase, split on non-alphanumerics, drop
 * length-1 tokens and stopwords. The same tokenizer must run at query time —
 * any drift between build and query produces silent retrieval misses.
 */
function tokenize(text) {
  const lower = text.toLowerCase()
  const raw = lower.split(/[^a-z0-9]+/)
  const out = []
  for (const t of raw) {
    if (t.length < 2) continue
    if (STOPWORDS.has(t)) continue
    out.push(t)
  }
  return out
}

/**
 * Per-document BM25 statistics. The corpus-wide doc-frequency table is
 * computed in a second pass; this function only counts term frequencies
 * within a single document.
 */
function buildPerDocStats(tokens) {
  const tf = Object.create(null)
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1
  }
  return {
    docFreq: tf,
    docLength: tokens.length,
  }
}

/**
 * Build the corpus-level inverted document frequency table. Returns a flat
 * map from term to the number of documents that contain it.
 */
function buildCorpusDocFrequencies(perDocStats) {
  const df = Object.create(null)
  for (const stats of perDocStats) {
    for (const term of Object.keys(stats.docFreq)) {
      df[term] = (df[term] || 0) + 1
    }
  }
  return df
}

// ─── Embedding API ──────────────────────────────────────────────────────────

/**
 * POST a JSON body to a remote endpoint with bearer-token auth. Returns the
 * parsed JSON response. Throws on non-2xx status. The HTTP timeout fires when
 * the socket sees no traffic for HTTP_TIMEOUT_MS — we reset the timer on
 * every chunk so a slow-but-progressing response does not abort.
 */
function postJson(endpoint, body, bearer) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint)
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          buf += chunk
          req.setTimeout(HTTP_TIMEOUT_MS)
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 500)}`))
          }
          try {
            resolve(JSON.parse(buf))
          } catch (err) {
            reject(new Error(`JSON parse failed: ${err.message}`))
          }
        })
      },
    )
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP timeout after ${HTTP_TIMEOUT_MS}ms`))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/**
 * Resolve which embedding provider to use based on env vars. Returns
 * { provider: 'openai' | 'voyage' | 'none', apiKey, endpoint, model, dims, usdPer1M }.
 */
function resolveEmbeddingProvider() {
  const openaiKey = process.env.OPENAI_API_KEY
  const voyageKey = process.env.VOYAGE_API_KEY
  if (openaiKey) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      endpoint: OPENAI_ENDPOINT,
      model: OPENAI_MODEL,
      dims: OPENAI_DIMS,
      usdPer1M: OPENAI_USD_PER_1M_TOKENS,
    }
  }
  if (voyageKey) {
    return {
      provider: 'voyage',
      apiKey: voyageKey,
      endpoint: VOYAGE_ENDPOINT,
      model: VOYAGE_MODEL,
      dims: VOYAGE_DIMS,
      usdPer1M: VOYAGE_USD_PER_1M_TOKENS,
    }
  }
  return { provider: 'none' }
}

/**
 * Cheap token estimate — both providers tokenize at roughly 4 characters per
 * token for English text, so a chars/4 heuristic is close enough to estimate
 * cost at a 10-15% confidence interval. The build step prints the estimate
 * before calling the API; the actual usage is reported back from the API
 * response and replaces the estimate in the corpus.json record.
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

/**
 * Embed a batch of documents through the resolved provider. Retries once on
 * network or transient HTTP error; halts on the second failure.
 */
async function embedBatch(provider, inputs) {
  const body = provider.provider === 'openai'
    ? { model: provider.model, input: inputs, encoding_format: 'float' }
    : { model: provider.model, input: inputs, input_type: 'document' }

  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await postJson(provider.endpoint, body, provider.apiKey)
      const vectors = res.data.map((d) => d.embedding)
      const usedTokens = res.usage?.total_tokens ?? 0
      return { vectors, usedTokens }
    } catch (err) {
      lastErr = err
      warn(`embed attempt ${attempt + 1} failed: ${err.message}`)
      // Brief backoff. A second immediate retry rarely succeeds when the
      // first failed on a quota/auth class. The 1.5s pause yields to any
      // transient network fault without blocking the build for long.
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500))
    }
  }
  fail(3, `embedding API failed twice: ${lastErr?.message}`)
}

// ─── Atomic file writes ─────────────────────────────────────────────────────

/**
 * Write a file via .tmp + rename. If the rename fails, the original is left
 * intact and the .tmp is removed best-effort. Callers must construct the
 * full text payload ahead of time — this helper does not stream.
 */
function atomicWrite(filePath, contents) {
  const dir = path.win32.dirname(filePath).replace(/\\/g, '/')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, contents, 'utf-8')
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      // Best-effort cleanup. Failure here is non-fatal — leaving a .tmp
      // file in the output directory is preferable to crashing the build.
      writeFileSync(tmp + '.failed', '')
    } catch {
      /* ignore */
    }
    fail(99, `atomic rename failed: ${err.message}`)
  }
}

// ─── Drift detection ────────────────────────────────────────────────────────

/**
 * Read the generated barrel and extract the set of entry ids it imports.
 * Each import line looks like `import './checkout'` or `import './forms/dateRange'`.
 * The id corresponds to the basename of the import path — exactly what the
 * project's catalog generator emits.
 */
function readBarrelIds() {
  if (!existsSync(ALL_BARREL_PATH)) return null
  const source = readFileSync(ALL_BARREL_PATH, 'utf-8')
  const re = /import\s+['"]\.\/(?:[^'"]*\/)?([^'"\/]+)['"]/g
  const ids = new Set()
  let m
  while ((m = re.exec(source)) !== null) {
    ids.add(m[1])
  }
  return ids
}

/**
 * Cross-check the extracted entries against the barrel. The barrel's imports are
 * basenames (e.g. 'checkout'), while entry ids are id-fields (e.g. 'checkout' or
 * 'checkoutForm'). They match for most root entries but can diverge for a handful
 * of files. We compare on the basename of the path field, which is what the
 * barrel uses. Drift detection is skipped entirely when no barrel exists.
 */
function detectDrift(extracted) {
  const barrelIds = readBarrelIds()
  if (!barrelIds) {
    warn(`barrel not found at ${ALL_BARREL_PATH} — drift check skipped`)
    return
  }
  const extractedBasenames = new Set(
    extracted.map((p) => {
      const base = path.win32.basename(p.path).replace(/\.ts$/, '')
      return base
    }),
  )
  const missing = []
  for (const id of barrelIds) {
    if (!extractedBasenames.has(id)) missing.push(id)
  }
  if (missing.length > 0) {
    fail(
      1,
      `drift: ${missing.length} barrel imports not extracted as entries. ` +
        `First 10: ${missing.slice(0, 10).join(', ')}`,
    )
  }
}

// ─── Subcommand: build ──────────────────────────────────────────────────────

async function cmdBuild(args) {
  const skipEmbed = args['no-embed'] === true
  log(`scanning ${DEFINITIONS_DIR}`)
  const files = walkDefinitionFiles(DEFINITIONS_DIR)
  log(`found ${files.length} catalog source files`)

  const catalogEntries = []
  let skipped = 0
  for (const file of files) {
    const p = extractEntry(file)
    if (!p) {
      skipped++
      continue
    }
    catalogEntries.push(p)
  }
  log(`extracted ${catalogEntries.length} entries (${skipped} skipped — no id field)`)

  detectDrift(catalogEntries)

  // BM25 stage 1: per-document term frequencies.
  const perDocStats = catalogEntries.map((p) => buildPerDocStats(tokenize(p.corpus)))
  // BM25 stage 2: corpus-wide document frequencies + averages.
  const docFrequencies = buildCorpusDocFrequencies(perDocStats)
  const totalLength = perDocStats.reduce((acc, s) => acc + s.docLength, 0)
  const avgDocLength = totalLength / Math.max(1, perDocStats.length)
  const totalTermCount = totalLength
  const uniqueTerms = Object.keys(docFrequencies).length
  log(`BM25: ${uniqueTerms} unique terms, ${totalTermCount} total tokens, avg ${avgDocLength.toFixed(1)} per doc`)

  // Embedding stage. Skip if --no-embed or no API key.
  const provider = skipEmbed ? { provider: 'none' } : resolveEmbeddingProvider()
  if (provider.provider === 'none' && !skipEmbed) {
    warn('no OPENAI_API_KEY or VOYAGE_API_KEY found — skipping embeddings (vectors=null)')
  }

  let totalTokensEmbedded = 0
  let estimatedCostUSD = 0
  const vectors = new Array(catalogEntries.length).fill(null)

  if (provider.provider !== 'none') {
    const estimatedTokens = catalogEntries.reduce((acc, p) => acc + estimateTokens(p.corpus), 0)
    estimatedCostUSD = (estimatedTokens / 1_000_000) * provider.usdPer1M
    log(
      `provider=${provider.provider} model=${provider.model} ` +
        `≈${estimatedTokens} tokens estimated ($${estimatedCostUSD.toFixed(6)} USD)`,
    )
    if (!process.env.CONFIRM_EMBED) {
      fail(
        1,
        `set CONFIRM_EMBED=1 to authorize the embedding API call ` +
          `(estimated $${estimatedCostUSD.toFixed(6)}). Or pass --no-embed to skip.`,
      )
    }

    const totalBatches = Math.ceil(catalogEntries.length / EMBED_BATCH_SIZE)
    for (let i = 0; i < catalogEntries.length; i += EMBED_BATCH_SIZE) {
      const batch = catalogEntries.slice(i, i + EMBED_BATCH_SIZE)
      const inputs = batch.map((p) => p.corpus)
      const tokensInBatch = inputs.reduce((acc, s) => acc + estimateTokens(s), 0)
      const batchIdx = Math.floor(i / EMBED_BATCH_SIZE) + 1
      log(`embedding batch ${batchIdx}/${totalBatches} (~${tokensInBatch} tokens)`)
      const { vectors: batchVecs, usedTokens } = await embedBatch(provider, inputs)
      if (batchVecs.length !== batch.length) {
        fail(3, `provider returned ${batchVecs.length} vectors for ${batch.length} inputs`)
      }
      for (let j = 0; j < batch.length; j++) {
        vectors[i + j] = batchVecs[j]
      }
      totalTokensEmbedded += usedTokens
    }
    // Replace estimate with actual usage when the API reports it.
    if (totalTokensEmbedded > 0) {
      estimatedCostUSD = (totalTokensEmbedded / 1_000_000) * provider.usdPer1M
    }
    log(`embedded ${catalogEntries.length} documents, ${totalTokensEmbedded} tokens, $${estimatedCostUSD.toFixed(6)} actual`)
  }

  // ─── Serialize index.jsonl ───────────────────────────────────────────────
  const lines = []
  for (let i = 0; i < catalogEntries.length; i++) {
    const p = catalogEntries[i]
    const stats = perDocStats[i]
    const entry = {
      id: p.id,
      name: p.name,
      category: p.category,
      corpus: p.corpus,
      metadata: {
        id: p.id,
        name: p.name,
        category: p.category,
        cost: p.cost,
        // Project-defined boolean filter facets, spread inline so each one is a
        // top-level metadata field the query layer can filter on.
        ...p.facets,
        refs: p.refNames,
        path: p.path,
      },
      bm25: {
        docFreq: stats.docFreq,
        docLength: stats.docLength,
      },
      vector: vectors[i],
    }
    lines.push(JSON.stringify(entry))
  }
  atomicWrite(INDEX_PATH, lines.join('\n') + '\n')
  log(`wrote ${INDEX_PATH} (${lines.length} entries)`)

  // ─── Serialize corpus.json ───────────────────────────────────────────────
  const categoryCounts = Object.create(null)
  for (const p of catalogEntries) {
    categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1
  }
  const corpusMeta = {
    builtAt: new Date().toISOString(),
    count: catalogEntries.length,
    embeddingProvider: provider.provider,
    embeddingModel: provider.provider === 'none' ? null : provider.model,
    embeddingDims: provider.provider === 'none' ? null : provider.dims,
    avgDocLength: Number(avgDocLength.toFixed(2)),
    totalTokensEmbedded,
    estimatedCostUSD: Number(estimatedCostUSD.toFixed(6)),
    categoryCounts,
    bm25: {
      k1: BM25_K1,
      b: BM25_B,
      totalTermCount,
      uniqueTerms,
      docFrequencies,
    },
  }
  atomicWrite(CORPUS_PATH, JSON.stringify(corpusMeta, null, 2) + '\n')
  log(`wrote ${CORPUS_PATH}`)
}

// ─── Subcommand: stats ──────────────────────────────────────────────────────

function cmdStats() {
  log(`scanning ${DEFINITIONS_DIR}`)
  const files = walkDefinitionFiles(DEFINITIONS_DIR)
  const catalogEntries = []
  for (const file of files) {
    const p = extractEntry(file)
    if (p) catalogEntries.push(p)
  }
  log(`extracted ${catalogEntries.length} entries`)

  const tokenCounts = catalogEntries.map((p) => tokenize(p.corpus).length)
  const totalTokens = tokenCounts.reduce((a, b) => a + b, 0)
  const avgTokens = totalTokens / Math.max(1, catalogEntries.length)
  const minTokens = tokenCounts.reduce((a, b) => Math.min(a, b), Infinity)
  const maxTokens = tokenCounts.reduce((a, b) => Math.max(a, b), 0)

  const categoryCounts = Object.create(null)
  for (const p of catalogEntries) {
    categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1
  }

  const estimatedApiTokens = catalogEntries.reduce((acc, p) => acc + estimateTokens(p.corpus), 0)
  const openaiCost = (estimatedApiTokens / 1_000_000) * OPENAI_USD_PER_1M_TOKENS
  const voyageCost = (estimatedApiTokens / 1_000_000) * VOYAGE_USD_PER_1M_TOKENS

  process.stderr.write(
    [
      '',
      '── Corpus stats ─────────────────────────────────────',
      `  entries:             ${catalogEntries.length}`,
      `  total tokens:        ${totalTokens}`,
      `  avg tokens / doc:    ${avgTokens.toFixed(2)}`,
      `  min tokens / doc:    ${minTokens}`,
      `  max tokens / doc:    ${maxTokens}`,
      '  category counts:',
      ...Object.entries(categoryCounts).map(
        ([k, v]) => `    ${k.padEnd(14)} ${v}`,
      ),
      '',
      '── Embedding cost estimate ──────────────────────────',
      `  approx API tokens:   ${estimatedApiTokens}`,
      `  OpenAI (3-small):    $${openaiCost.toFixed(6)}`,
      `  Voyage (4-lite):     $${voyageCost.toFixed(6)}`,
      '─────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  )
}

// ─── Subcommand: verify ─────────────────────────────────────────────────────

function cmdVerify() {
  if (!existsSync(INDEX_PATH)) fail(2, `index not found at ${INDEX_PATH} — run \`build\` first`)
  const indexText = readFileSync(INDEX_PATH, 'utf-8')
  const indexLines = indexText.split('\n').filter((l) => l.length > 0)
  const indexIds = new Set()
  for (const line of indexLines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch (err) {
      fail(1, `malformed JSONL at line ${indexIds.size + 1}: ${err.message}`)
    }
    if (!entry.id) fail(1, `index entry missing id field`)
    if (indexIds.has(entry.id)) fail(1, `duplicate id in index: ${entry.id}`)
    indexIds.add(entry.id)
  }

  const files = walkDefinitionFiles(DEFINITIONS_DIR)
  const sourceIds = new Set()
  for (const file of files) {
    const p = extractEntry(file)
    if (p) sourceIds.add(p.id)
  }

  const inSourceNotIndex = []
  for (const id of sourceIds) {
    if (!indexIds.has(id)) inSourceNotIndex.push(id)
  }
  const inIndexNotSource = []
  for (const id of indexIds) {
    if (!sourceIds.has(id)) inIndexNotSource.push(id)
  }

  if (inSourceNotIndex.length === 0 && inIndexNotSource.length === 0) {
    log(`verify: index in sync with ${sourceIds.size} catalog sources`)
    return
  }
  if (inSourceNotIndex.length > 0) {
    warn(`${inSourceNotIndex.length} entries in source but not in index:`)
    for (const id of inSourceNotIndex.slice(0, 20)) warn(`  - ${id}`)
  }
  if (inIndexNotSource.length > 0) {
    warn(`${inIndexNotSource.length} entries in index but not in source:`)
    for (const id of inIndexNotSource.slice(0, 20)) warn(`  - ${id}`)
  }
  fail(1, `index drift detected — re-run \`build\` to refresh`)
}

// ─── Subcommand: embed-only ─────────────────────────────────────────────────

async function cmdEmbedOnly() {
  if (!existsSync(INDEX_PATH)) fail(2, `index not found at ${INDEX_PATH} — run \`build\` first`)
  if (!existsSync(CORPUS_PATH)) fail(2, `corpus.json not found at ${CORPUS_PATH}`)
  const provider = resolveEmbeddingProvider()
  if (provider.provider === 'none') {
    fail(1, 'no OPENAI_API_KEY or VOYAGE_API_KEY in env — cannot embed')
  }

  const indexText = readFileSync(INDEX_PATH, 'utf-8')
  const lines = indexText.split('\n').filter((l) => l.length > 0)
  const entries = lines.map((l) => JSON.parse(l))

  const targets = entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter((t) => t.entry.vector === null || t.entry.vector === undefined)

  if (targets.length === 0) {
    log('every index entry already carries a vector — nothing to do')
    return
  }
  log(`${targets.length} entries lack a vector — embedding now`)

  const estimatedTokens = targets.reduce((acc, t) => acc + estimateTokens(t.entry.corpus), 0)
  const estimatedCostUSD = (estimatedTokens / 1_000_000) * provider.usdPer1M
  log(
    `provider=${provider.provider} model=${provider.model} ` +
      `≈${estimatedTokens} tokens ($${estimatedCostUSD.toFixed(6)} USD)`,
  )
  if (!process.env.CONFIRM_EMBED) {
    fail(1, `set CONFIRM_EMBED=1 to authorize the API call`)
  }

  let totalTokensEmbedded = 0
  const totalBatches = Math.ceil(targets.length / EMBED_BATCH_SIZE)
  for (let i = 0; i < targets.length; i += EMBED_BATCH_SIZE) {
    const batch = targets.slice(i, i + EMBED_BATCH_SIZE)
    const inputs = batch.map((t) => t.entry.corpus)
    const batchIdx = Math.floor(i / EMBED_BATCH_SIZE) + 1
    log(`embedding batch ${batchIdx}/${totalBatches}`)
    const { vectors, usedTokens } = await embedBatch(provider, inputs)
    for (let j = 0; j < batch.length; j++) {
      entries[batch[j].index].vector = vectors[j]
    }
    totalTokensEmbedded += usedTokens
  }
  const actualCost = (totalTokensEmbedded / 1_000_000) * provider.usdPer1M
  log(`embedded ${targets.length} entries, ${totalTokensEmbedded} tokens, $${actualCost.toFixed(6)} actual`)

  // Re-serialize the index in place.
  const newLines = entries.map((e) => JSON.stringify(e))
  atomicWrite(INDEX_PATH, newLines.join('\n') + '\n')
  log(`wrote ${INDEX_PATH}`)

  // Update the corpus metadata header so downstream readers see fresh provider info.
  const corpusMeta = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'))
  corpusMeta.builtAt = new Date().toISOString()
  corpusMeta.embeddingProvider = provider.provider
  corpusMeta.embeddingModel = provider.model
  corpusMeta.embeddingDims = provider.dims
  corpusMeta.totalTokensEmbedded = (corpusMeta.totalTokensEmbedded || 0) + totalTokensEmbedded
  corpusMeta.estimatedCostUSD = Number(
    ((corpusMeta.estimatedCostUSD || 0) + actualCost).toFixed(6),
  )
  atomicWrite(CORPUS_PATH, JSON.stringify(corpusMeta, null, 2) + '\n')
  log(`updated ${CORPUS_PATH}`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]

  if (!existsSync(DEFINITIONS_DIR)) {
    fail(2, `definitions directory not found: ${DEFINITIONS_DIR}`)
  }
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    log(`created ${OUTPUT_DIR}`)
  }

  switch (cmd) {
    case 'build':
      await cmdBuild(args)
      break
    case 'stats':
      cmdStats()
      break
    case 'verify':
      cmdVerify()
      break
    case 'embed-only':
      await cmdEmbedOnly()
      break
    default:
      process.stderr.write(
        [
          'usage: build-index.mjs <command> [options]',
          '',
          'commands:',
          '  build [--no-embed]   walk definitions, extract corpus, build BM25, optionally embed',
          '  stats                print corpus statistics + estimated embedding cost',
          '  verify               check parity between definition files and existing index',
          '  embed-only           populate vectors on a previously-built index',
          '',
          'env:',
          '  OPENAI_API_KEY       use OpenAI text-embedding-3-small (1536-dim)',
          '  VOYAGE_API_KEY       use Voyage voyage-4-lite (1024-dim)',
          '  CONFIRM_EMBED=1      authorize the embedding API call (build / embed-only)',
          '',
          'output:',
          `  ${INDEX_PATH}`,
          `  ${CORPUS_PATH}`,
          '',
        ].join('\n'),
      )
      process.exit(cmd === undefined ? 0 : 1)
  }
}

main().catch((err) => {
  fail(99, err.stack || err.message || String(err))
})
