#!/usr/bin/env node
/**
 * recall-similar.mjs — Hybrid BM25 + dense-embedding retrieval over the project's
 * catalog of reusable units. Reads a prebuilt index produced by build-index.mjs
 * and answers semantic search queries from agents and any picker UI.
 *
 * The index lives at `.agents/vector-index/index.jsonl` (one JSON entry per
 * catalog entry, BM25 stats and optional dense vector inline) plus a sidecar
 * `corpus.json` with corpus-wide stats and embedding-model metadata. This
 * script never builds the index; it only queries.
 *
 * Modes:
 *   hybrid (default) — BM25 + dense, merged via Reciprocal Rank Fusion (k=60).
 *                      Falls back to BM25 alone when no embedding is available
 *                      (no API key, no vectors in the index, or network error).
 *   bm25            — score by BM25 only.
 *   dense           — score by cosine similarity only. Errors out if vectors
 *                     are missing from the index.
 *
 * Subcommands:
 *   query (default)  — run a search; default human-readable, --json for machine
 *   index-info       — print the corpus.json summary
 *   validate         — load the index and report malformed entries
 *   clear-cache      — drop the persistent query-embedding cache
 *
 * Exit codes:
 *   0  results printed
 *   1  index file missing or unreadable
 *   2  query string missing or empty
 *   3  embedding API failed AND BM25 fallback unavailable (corrupted index)
 *   99 unknown error
 *
 * Zero npm dependencies. Built-in Node only. Cache reads/writes go through
 * `.agents/vector-index/query-cache.json` so repeat queries within 24h skip the
 * embedding API call entirely.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// --- Constants --------------------------------------------------------------
// Paths are derived project-relative to the repo root. This script lives at
// `<repo>/.claude/scripts/agentic/recall-similar.mjs`, so the repo root is three
// directories up. Set CATALOG_INDEX_DIR to override the index location (must
// match whatever build-index.mjs wrote).

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const REPO_ROOT = path.win32.resolve(SCRIPT_DIR, '..', '..', '..').replace(/\\/g, '/')
const INDEX_DIR = (
  process.env.CATALOG_INDEX_DIR ||
  path.win32.join(REPO_ROOT, '.agents/vector-index')
).replace(/\\/g, '/')
const INDEX_PATH = path.win32.join(INDEX_DIR, 'index.jsonl')
const CORPUS_PATH = path.win32.join(INDEX_DIR, 'corpus.json')
const CACHE_PATH = path.win32.join(INDEX_DIR, 'query-cache.json')

const RRF_K = 60
const CACHE_MAX_ENTRIES = 100
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SCORE_DECIMALS = 4

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to',
])

// --- Logging ----------------------------------------------------------------

function log(msg) { process.stderr.write(`[recall-similar] ${msg}\n`) }
function warn(msg) { process.stderr.write(`[recall-similar] WARN: ${msg}\n`) }
function fail(code, msg) {
  process.stderr.write(`[recall-similar] ERROR: ${msg}\n`)
  process.exit(code)
}

// --- Argument parsing -------------------------------------------------------
// Accepts --key=value, --key value, and bare --flag forms.
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

// --- Tokenizer (must match build-index.mjs) ---------------------------------
// Lowercase, split on non-alphanumeric, drop tokens shorter than 2 characters,
// drop English stopwords. Keeping this in lockstep with the build script is
// load-bearing — divergence silently destroys recall.
function tokenize(text) {
  if (!text) return []
  const lowered = String(text).toLowerCase()
  const raw = lowered.split(/[^a-z0-9]+/)
  const out = []
  for (const t of raw) {
    if (t.length < 2) continue
    if (STOPWORDS.has(t)) continue
    out.push(t)
  }
  return out
}

// --- Index loading ----------------------------------------------------------

function loadCorpus() {
  if (!existsSync(CORPUS_PATH)) {
    fail(1, `corpus sidecar not found at ${CORPUS_PATH} — run build-index first`)
  }
  let raw
  try { raw = readFileSync(CORPUS_PATH, 'utf8') }
  catch (e) { fail(1, `cannot read ${CORPUS_PATH}: ${e.message}`) }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch (e) { fail(1, `corpus.json is malformed JSON: ${e.message}`) }
  return parsed
}

function loadIndex() {
  if (!existsSync(INDEX_PATH)) {
    fail(1, `index file not found at ${INDEX_PATH} — run build-index first`)
  }
  let raw
  try { raw = readFileSync(INDEX_PATH, 'utf8') }
  catch (e) { fail(1, `cannot read ${INDEX_PATH}: ${e.message}`) }
  const lines = raw.split(/\r?\n/).filter(l => l.length > 0)
  const entries = []
  const malformed = []
  for (let i = 0; i < lines.length; i++) {
    let entry
    try { entry = JSON.parse(lines[i]) }
    catch (e) {
      malformed.push({ line: i + 1, error: e.message })
      continue
    }
    if (!entry || typeof entry !== 'object') {
      malformed.push({ line: i + 1, error: 'not an object' })
      continue
    }
    if (!entry.id || !entry.bm25) {
      malformed.push({ line: i + 1, id: entry.id || '<missing>', error: 'missing id or bm25 block' })
      continue
    }
    entries.push(entry)
  }
  return { entries, malformed }
}

// --- BM25 -------------------------------------------------------------------
// Document frequency (df) for a term = number of documents that contain it.
// Build a single map across all entries on first use, then reuse for every
// query in this process.
function buildDfMap(entries) {
  const df = new Map()
  for (const entry of entries) {
    const docFreq = entry.bm25?.docFreq || {}
    for (const term of Object.keys(docFreq)) {
      df.set(term, (df.get(term) || 0) + 1)
    }
  }
  return df
}

function bm25Idf(df, termCount) {
  // ln((N - df + 0.5) / (df + 0.5) + 1) — same form Lucene uses; bounded
  // positive even when df > N/2.
  return Math.log((termCount - df + 0.5) / (df + 0.5) + 1)
}

function bm25Score(entry, queryTerms, dfMap, corpusStats) {
  const k1 = corpusStats.k1 ?? 1.2
  const b = corpusStats.b ?? 0.75
  const avgdl = corpusStats.avgDocLength || 1
  const N = corpusStats.count || 1
  const docFreq = entry.bm25.docFreq || {}
  const docLength = entry.bm25.docLength || 0
  let score = 0
  for (const term of queryTerms) {
    const f = docFreq[term] || 0
    if (f === 0) continue
    const df = dfMap.get(term) || 0
    if (df === 0) continue
    const idf = bm25Idf(df, N)
    const lengthNorm = 1 - b + b * (docLength / avgdl)
    const denom = f + k1 * lengthNorm
    score += idf * (f * (k1 + 1)) / denom
  }
  return score
}

// --- Cosine similarity ------------------------------------------------------

function cosine(a, b) {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// --- Query embedding cache --------------------------------------------------
// Persistent JSON cache so repeat queries within TTL skip the embedding API.
function loadCache() {
  if (!existsSync(CACHE_PATH)) return {}
  try {
    const raw = readFileSync(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistCache(cache) {
  try {
    if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true })
    const tmp = CACHE_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8')
    // Atomic-ish replace; on Windows writeFileSync to the final path would also
    // work but the tmp+rename pattern matches the consolidate-memory script.
    try {
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8')
      try { unlinkSync(tmp) } catch {}
    } catch (e) {
      try { unlinkSync(tmp) } catch {}
      warn(`failed to persist query cache: ${e.message}`)
    }
  } catch (e) {
    warn(`query cache write failed: ${e.message}`)
  }
}

function pruneCache(cache) {
  const now = Date.now()
  const fresh = {}
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry || !entry.vector || !entry.ts) continue
    const ts = Date.parse(entry.ts)
    if (Number.isNaN(ts)) continue
    if (now - ts > CACHE_TTL_MS) continue
    fresh[key] = entry
  }
  // Cap entries at CACHE_MAX_ENTRIES — keep the most recent.
  const sorted = Object.entries(fresh)
    .sort((a, b) => Date.parse(b[1].ts) - Date.parse(a[1].ts))
    .slice(0, CACHE_MAX_ENTRIES)
  const capped = {}
  for (const [k, v] of sorted) capped[k] = v
  return capped
}

function normalizeQueryKey(query, provider, model) {
  return `${provider}::${model}::${query.trim().toLowerCase()}`
}

// --- Embedding providers ----------------------------------------------------
// Both providers POST a JSON body to a single endpoint and return a single
// vector under data[0].embedding. Network or auth errors return null and the
// caller falls back to BM25.

async function embedQuery(query, corpus) {
  const provider = corpus.embeddingProvider
  const model = corpus.embeddingModel
  if (!provider || provider === 'none') return null
  if (!model) {
    warn(`corpus.json declares provider "${provider}" but no model — skipping dense path`)
    return null
  }

  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY
    if (!key) {
      warn('OPENAI_API_KEY not set — falling back to BM25')
      return null
    }
    return openaiEmbed(query, model, key)
  }
  if (provider === 'voyage') {
    const key = process.env.VOYAGE_API_KEY
    if (!key) {
      warn('VOYAGE_API_KEY not set — falling back to BM25')
      return null
    }
    return voyageEmbed(query, model, key)
  }
  warn(`unknown embedding provider "${provider}" — falling back to BM25`)
  return null
}

async function openaiEmbed(query, model, key) {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: query, model }),
    })
    if (!res.ok) {
      warn(`openai embed failed: HTTP ${res.status} — falling back to BM25`)
      return null
    }
    const data = await res.json()
    const vec = data?.data?.[0]?.embedding
    if (!Array.isArray(vec)) {
      warn('openai response missing data[0].embedding — falling back to BM25')
      return null
    }
    return vec
  } catch (e) {
    warn(`openai embed exception: ${e.message} — falling back to BM25`)
    return null
  }
}

async function voyageEmbed(query, model, key) {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: query, model }),
    })
    if (!res.ok) {
      warn(`voyage embed failed: HTTP ${res.status} — falling back to BM25`)
      return null
    }
    const data = await res.json()
    const vec = data?.data?.[0]?.embedding
    if (!Array.isArray(vec)) {
      warn('voyage response missing data[0].embedding — falling back to BM25')
      return null
    }
    return vec
  } catch (e) {
    warn(`voyage embed exception: ${e.message} — falling back to BM25`)
    return null
  }
}

// --- Scoring orchestration --------------------------------------------------

function rankBm25(entries, queryTerms, dfMap, corpusStats, categoryFilter) {
  const scored = []
  for (const entry of entries) {
    if (categoryFilter && entry.category !== categoryFilter) continue
    const score = bm25Score(entry, queryTerms, dfMap, corpusStats)
    if (score <= 0) continue
    scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

function rankDense(entries, queryVector, categoryFilter) {
  const scored = []
  for (const entry of entries) {
    if (categoryFilter && entry.category !== categoryFilter) continue
    if (!Array.isArray(entry.vector)) continue
    const score = cosine(queryVector, entry.vector)
    if (!Number.isFinite(score)) continue
    scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

function mergeRrf(bm25Ranked, denseRanked) {
  // Reciprocal Rank Fusion: for each document, sum 1/(K + rank) across the
  // rankers it appears in. Documents missing from a ranker contribute 0 from
  // that ranker.
  const bm25Rank = new Map()
  bm25Ranked.forEach((row, i) => bm25Rank.set(row.entry.id, i + 1))
  const denseRank = new Map()
  denseRanked.forEach((row, i) => denseRank.set(row.entry.id, i + 1))
  const allIds = new Set([...bm25Rank.keys(), ...denseRank.keys()])
  const byId = new Map()
  for (const row of bm25Ranked) byId.set(row.entry.id, row.entry)
  for (const row of denseRanked) byId.set(row.entry.id, row.entry)
  const merged = []
  for (const id of allIds) {
    const rb = bm25Rank.get(id)
    const rd = denseRank.get(id)
    let score = 0
    if (rb !== undefined) score += 1 / (RRF_K + rb)
    if (rd !== undefined) score += 1 / (RRF_K + rd)
    merged.push({
      entry: byId.get(id),
      score,
      rankBm25: rb ?? null,
      rankDense: rd ?? null,
    })
  }
  merged.sort((a, b) => b.score - a.score)
  return merged
}

// --- Result formatting ------------------------------------------------------

function snippetFor(entry) {
  const corpus = entry.corpus || ''
  return corpus.replace(/\s+/g, ' ').slice(0, 160)
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function formatHumanResults(results, options) {
  const lines = []
  lines.push(`Query: "${options.query}"`)
  lines.push(`Mode: ${options.mode}${options.fellBack ? ' (BM25 fallback)' : ''}`)
  if (options.categoryFilter) lines.push(`Category filter: ${options.categoryFilter}`)
  lines.push(`Top ${results.length} result${results.length === 1 ? '' : 's'}:`)
  lines.push('')
  if (results.length === 0) {
    lines.push('  (no matches)')
    lines.push('')
  } else {
    const nameWidth = Math.min(28, Math.max(8, ...results.map(r => (r.entry.name || r.entry.id || '').length)))
    const catWidth = Math.min(14, Math.max(8, ...results.map(r => `[${r.entry.category || '?'}]`.length)))
    let n = 1
    for (const r of results) {
      const name = pad(r.entry.name || r.entry.id || '?', nameWidth)
      const cat = pad(`[${r.entry.category || '?'}]`, catWidth)
      const score = r.score.toFixed(SCORE_DECIMALS)
      const idx = pad(`${n}.`, 3)
      const snippet = snippetFor(r.entry)
      lines.push(`  ${idx} ${name} ${cat} score=${score}  ${snippet}`)
      n++
    }
    lines.push('')
  }
  lines.push(`Index: ${options.indexCount} entries${options.embeddingModel ? `, embedded with ${options.embeddingModel}` : ', no dense vectors'}`)
  if (options.queryCacheHit) lines.push('Query cache: HIT')
  return lines.join('\n') + '\n'
}

function buildJsonResults(results, options) {
  const out = {
    ok: true,
    query: options.query,
    mode: options.mode,
    fellBackToBm25: options.fellBack,
    k: options.k,
    categoryFilter: options.categoryFilter || null,
    results: results.map(r => ({
      id: r.entry.id,
      name: r.entry.name || r.entry.id,
      category: r.entry.category || null,
      score: Number(r.score.toFixed(SCORE_DECIMALS)),
      rankBm25: r.rankBm25 ?? null,
      rankDense: r.rankDense ?? null,
      snippet: snippetFor(r.entry),
      metadata: r.entry.metadata || null,
    })),
    indexCount: options.indexCount,
    indexBuiltAt: options.indexBuiltAt || null,
    embeddingProvider: options.embeddingProvider || null,
    embeddingModel: options.embeddingModel || null,
    queryCacheHit: options.queryCacheHit,
  }
  return JSON.stringify(out, null, 2) + '\n'
}

// --- Subcommands ------------------------------------------------------------

async function cmdQuery(args) {
  const query = (args.query || '').trim()
  if (!query) fail(2, 'query is required and must be non-empty (--query "<text>")')
  const k = args.k != null ? parseInt(args.k, 10) : 5
  if (!Number.isInteger(k) || k < 1) fail(99, '--k must be a positive integer')
  const mode = args.mode || 'hybrid'
  if (!['hybrid', 'bm25', 'dense'].includes(mode)) {
    fail(99, `--mode must be one of: hybrid, bm25, dense (got "${mode}")`)
  }
  const categoryFilter = args.category || null
  const wantJson = args.json === true || args.json === 'true'

  const corpus = loadCorpus()
  const { entries, malformed } = loadIndex()
  if (malformed.length > 0) {
    warn(`${malformed.length} malformed entries skipped (run validate for details)`)
  }
  if (entries.length === 0) {
    fail(3, 'no usable entries in index — run build-index first')
  }
  // Catch the corpus.json / index.jsonl count-mismatch class early so callers
  // see it instead of silently scoring against a partially-loaded index.
  if (typeof corpus.count === 'number' && corpus.count !== entries.length) {
    warn(`corpus.json declares count=${corpus.count} but index.jsonl yielded ${entries.length} usable entries`)
  }

  const queryTerms = tokenize(query)
  const dfMap = buildDfMap(entries)
  const corpusStats = {
    count: entries.length,
    avgDocLength: corpus.avgDocLength,
    k1: corpus.bm25?.k1,
    b: corpus.bm25?.b,
  }

  const indexHasVectors = entries.some(e => Array.isArray(e.vector) && e.vector.length > 0)
  if (mode === 'dense' && !indexHasVectors) {
    fail(3, 'dense mode requested but the index contains no vectors — rebuild with embeddings or use --mode bm25')
  }

  // Embedding step (cached). Skipped entirely for bm25-only mode or when the
  // index has no vectors.
  let queryVector = null
  let queryCacheHit = false
  let fellBack = false
  if (mode !== 'bm25' && indexHasVectors) {
    const cache = pruneCache(loadCache())
    const cacheKey = normalizeQueryKey(query, corpus.embeddingProvider || 'none', corpus.embeddingModel || '')
    if (cache[cacheKey] && Array.isArray(cache[cacheKey].vector)) {
      queryVector = cache[cacheKey].vector
      queryCacheHit = true
    } else {
      queryVector = await embedQuery(query, corpus)
      if (queryVector) {
        cache[cacheKey] = { vector: queryVector, ts: new Date().toISOString() }
        persistCache(pruneCache(cache))
      }
    }
    if (!queryVector) {
      // Network or auth error already warned. Hybrid mode degrades to BM25;
      // explicit dense mode aborts because the caller asked for dense only.
      if (mode === 'dense') {
        fail(3, 'dense embedding unavailable and --mode dense was requested')
      }
      fellBack = true
    }
  }

  // Score.
  let merged
  if (mode === 'bm25' || (!queryVector && mode === 'hybrid')) {
    const ranked = rankBm25(entries, queryTerms, dfMap, corpusStats, categoryFilter)
    merged = ranked.map((row, i) => ({
      entry: row.entry,
      score: row.score,
      rankBm25: i + 1,
      rankDense: null,
    }))
  } else if (mode === 'dense') {
    const ranked = rankDense(entries, queryVector, categoryFilter)
    merged = ranked.map((row, i) => ({
      entry: row.entry,
      score: row.score,
      rankBm25: null,
      rankDense: i + 1,
    }))
  } else {
    // hybrid path — both available
    const bm25Ranked = rankBm25(entries, queryTerms, dfMap, corpusStats, categoryFilter)
    const denseRanked = rankDense(entries, queryVector, categoryFilter)
    merged = mergeRrf(bm25Ranked, denseRanked)
  }

  const top = merged.slice(0, k)
  const options = {
    query,
    mode,
    fellBack,
    k,
    categoryFilter,
    indexCount: entries.length,
    indexBuiltAt: corpus.builtAt || null,
    embeddingProvider: corpus.embeddingProvider || null,
    embeddingModel: corpus.embeddingModel || null,
    queryCacheHit,
  }

  if (wantJson) {
    process.stdout.write(buildJsonResults(top, options))
  } else {
    process.stdout.write(formatHumanResults(top, options))
  }
}

function cmdIndexInfo() {
  const corpus = loadCorpus()
  const out = {
    ok: true,
    indexPath: INDEX_PATH,
    corpusPath: CORPUS_PATH,
    builtAt: corpus.builtAt || null,
    count: corpus.count ?? null,
    embeddingProvider: corpus.embeddingProvider || null,
    embeddingModel: corpus.embeddingModel || null,
    embeddingDims: corpus.embeddingDims ?? null,
    avgDocLength: corpus.avgDocLength ?? null,
    categoryCounts: corpus.categoryCounts || {},
    bm25: corpus.bm25 || null,
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

function cmdValidate() {
  const corpus = loadCorpus()
  const { entries, malformed } = loadIndex()
  const issues = []
  let withVectors = 0
  let totalDimSum = 0
  let dimMismatches = 0
  const expectedDims = corpus.embeddingDims ?? null
  for (const entry of entries) {
    if (!entry.id) issues.push({ id: entry.id || '<unknown>', error: 'missing id' })
    if (!entry.bm25 || typeof entry.bm25.docLength !== 'number') {
      issues.push({ id: entry.id, error: 'missing or invalid bm25.docLength' })
    }
    if (!entry.bm25?.docFreq || typeof entry.bm25.docFreq !== 'object') {
      issues.push({ id: entry.id, error: 'missing or invalid bm25.docFreq' })
    }
    if (Array.isArray(entry.vector) && entry.vector.length > 0) {
      withVectors++
      totalDimSum += entry.vector.length
      if (expectedDims != null && entry.vector.length !== expectedDims) {
        dimMismatches++
        issues.push({
          id: entry.id,
          error: `vector length ${entry.vector.length} does not match corpus.embeddingDims ${expectedDims}`,
        })
      }
    }
  }
  const out = {
    ok: malformed.length === 0 && issues.length === 0,
    indexPath: INDEX_PATH,
    corpusPath: CORPUS_PATH,
    declaredCount: corpus.count ?? null,
    loadedCount: entries.length,
    countMismatch: typeof corpus.count === 'number' ? corpus.count !== entries.length : null,
    malformedLines: malformed,
    entryIssues: issues,
    entriesWithVectors: withVectors,
    averageVectorDim: withVectors > 0 ? Math.round(totalDimSum / withVectors) : null,
    expectedDims,
    dimensionMismatches: dimMismatches,
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (!out.ok) process.exit(3)
}

function cmdClearCache() {
  if (existsSync(CACHE_PATH)) {
    try { unlinkSync(CACHE_PATH) }
    catch (e) { fail(99, `failed to delete cache at ${CACHE_PATH}: ${e.message}`) }
    log(`cleared query cache at ${CACHE_PATH}`)
    process.stdout.write(JSON.stringify({ ok: true, cleared: CACHE_PATH }) + '\n')
  } else {
    log('no cache file to clear')
    process.stdout.write(JSON.stringify({ ok: true, cleared: null }) + '\n')
  }
}

// --- Help -------------------------------------------------------------------

const HELP = `recall-similar.mjs — hybrid BM25 + dense retrieval over the project's catalog index

Usage:
  node recall-similar.mjs [query] --query "<text>" [--k 5] [--category <c>] [--mode <m>] [--json]
  node recall-similar.mjs index-info
  node recall-similar.mjs validate
  node recall-similar.mjs clear-cache

Subcommands:
  query (default)   Run a search. The "query" keyword is optional — bare flags work.
  index-info        Print corpus.json metadata (build time, count, model, dims).
  validate          Load the index and report malformed entries / dimension drift.
  clear-cache       Delete the persistent query-embedding cache.

Query flags:
  --query <text>    The search string. Required. Empty strings rejected.
  --k <n>           Number of results to return (default 5). Positive integer.
  --category <c>    Optional exact-match facet filter on the entry's category field
  --mode <m>        Scoring mode: hybrid (default) | bm25 | dense
  --json            Emit machine-readable JSON instead of the human-readable table.

Modes:
  hybrid  Run BM25 and dense in parallel, merge with Reciprocal Rank Fusion (k=60).
          Falls back to BM25 alone when the index has no vectors, no API key is
          set, or the embedding API call fails.
  bm25    BM25 only. Always available.
  dense   Cosine similarity only. Errors out if the index has no vectors.

Environment:
  OPENAI_API_KEY   Required for dense / hybrid when corpus.embeddingProvider = openai
  VOYAGE_API_KEY   Required for dense / hybrid when corpus.embeddingProvider = voyage

Files:
  ${INDEX_PATH}
  ${CORPUS_PATH}
  ${CACHE_PATH}

Exit codes:
  0   results printed
  1   index file missing or unreadable
  2   query missing or empty
  3   embedding required but unavailable, or index validation failed
  99  unknown error
`

// --- Main -------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP)
    process.exit(0)
  }
  // Allow a leading bare subcommand OR fall through to "query" when the first
  // arg is a flag.
  const known = new Set(['query', 'index-info', 'validate', 'clear-cache'])
  let sub = 'query'
  let rest = argv
  if (!argv[0].startsWith('--') && known.has(argv[0])) {
    sub = argv[0]
    rest = argv.slice(1)
  }
  const args = parseArgs(rest)
  if (args.help === true || args.help === 'true') {
    process.stdout.write(HELP)
    process.exit(0)
  }
  try {
    switch (sub) {
      case 'query': return await cmdQuery(args)
      case 'index-info': return cmdIndexInfo()
      case 'validate': return cmdValidate()
      case 'clear-cache': return cmdClearCache()
      default:
        fail(99, `unknown subcommand: ${sub}\n\n${HELP}`)
    }
  } catch (e) {
    fail(99, `${sub} failed: ${e.message}\n${e.stack}`)
  }
}

main()
