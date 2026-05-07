/**
 * Chunked narration + image-prompt generation.
 *
 * Single-call LLM generation tops out at the model's `max_tokens` cap
 * (~16k for streaming Anthropic, ~8k non-streaming, similar for
 * OpenAI). At ≥25 chapters × 500 words the model truncates mid-output
 * or shrinks per-chapter wordcount to fit. This module handles the
 * "big request" case by splitting into outline + per-batch expansion
 * and writing chapters incrementally so cancel / crash / restart
 * never lose work that's already on disk.
 *
 * Two modes share the same orchestration:
 *
 *   - NARRATIVE  (sleep-story, adventure, true-crime, kids):
 *       chapters depend on each other.
 *       outline call → SEQUENTIAL batches of 3 chapters each, with the
 *       previous batch's last 200 words threaded as transition glue.
 *
 *   - LISTICLE   (listicle / explainer):
 *       chapters are independent.
 *       outline call → PARALLEL batches of 8 chapters each, semaphore
 *       caps in-flight at 4. No transition window needed.
 *
 * Per-chapter persistence is the design's load-bearing piece: every
 * chapter is written to its own `{code}_Chapter_NN.docx` AS SOON as
 * the LLM call returns. A small JSON sidecar records progress so the
 * caller can mid-cancel without losing what's been generated, and a
 * resume call (re-running the job) skips chapters whose docx is on
 * disk AND in the sidecar.
 *
 * Threshold dispatch (in callers): use chunked mode when
 *   `chapters * words_per_chapter > CHUNK_THRESHOLD_WORDS`.
 * Below the threshold, the existing single-call path is more efficient
 * and produces tighter cohesion.
 *
 * Scaling: at chapter counts > COMPACT_OUTLINE_THRESHOLD, outline
 * entries shrink to title + 1-line hook (no synopsis / beats). Above
 * that, expansion calls also drop the full outline from their context
 * and ship a "table of contents" (titles only) so the input window
 * doesn't blow up at ~1000+ chapters.
 */

import fs from 'fs/promises'
import { existsSync, statSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { callAi } from './ai-client.js'
import { writeJsonAtomic } from './atomic-store.js'
import {
  splitNarrationIntoChapters,
  writeChapterFiles,
  chapterFilePath,
  type NarrationParts,
} from './narration-assembly.js'
import * as jq from '../services/job-queue.js'
import type { Job, Format, Character } from '../models/types.js'

// ── Tunables ───────────────────────────────────────────────────────────────

/**
 * Word target above which `generateEpisode` dispatches to chunked mode.
 * Acts as a fast pre-check; the call site ALSO runs `shouldChunkByBudget`
 * with the actual assembled prompt sizes for projects that sit close to
 * the limit (heavy character cast, long production standards, big brand
 * persona). Either signal triggers chunking.
 *
 * 9000 words ≈ 11.7k output tokens; with a typical 2k-token system+user
 * prompt that leaves ~2.3k margin under the 16k streaming cap. Tuned
 * down from 10k after an audit found the prior 6% margin was too thin
 * for projects with a 5+ character cast or large standards block.
 * Common sleep-story shape (12 chapters × 700 words = 8400) still stays
 * on the proven single-call path.
 */
export const CHUNK_THRESHOLD_WORDS = 9000

/** Output token cap for streaming Anthropic. Sets the budget the dynamic
 *  check works against. If we ever switch to a model with a different cap,
 *  pass the actual cap to `shouldChunkByBudget` instead. */
const STREAMING_OUTPUT_TOKEN_CAP = 16_000

/** Headroom buffer: tokenizer-vs-word drift, JSON nesting in the prompt,
 *  and provider-side stop-token handling all eat real tokens. 1500 keeps
 *  us comfortably away from truncation even when the input estimate is
 *  20% off. */
const SAFETY_MARGIN_TOKENS = 1500

/**
 * Dynamic chunking decision. Returns true when the assembled prompt +
 * projected output would crowd the streaming output cap. Use ALONGSIDE
 * the word-count threshold above — either signal triggers chunked mode.
 *
 * Estimation:
 *   - Input tokens ≈ chars / 4 (English; safe for prose, slightly
 *     pessimistic for JSON-dense prompts which is what we want here)
 *   - Output tokens ≈ words × 1.3 (English narration, measured)
 *
 * If `(input + output + safety) > cap`, the single-call path can
 * truncate or shrink per-chapter wordcount. Chunked mode is safer.
 */
export function shouldChunkByBudget(opts: {
  systemPromptChars: number
  userPromptChars: number
  targetWords: number
  outputTokenCap?: number
}): boolean {
  const cap = opts.outputTokenCap ?? STREAMING_OUTPUT_TOKEN_CAP
  const inputTokens = Math.ceil((opts.systemPromptChars + opts.userPromptChars) / 4)
  const outputTokens = Math.ceil(opts.targetWords * 1.3)
  return (inputTokens + outputTokens + SAFETY_MARGIN_TOKENS) > cap
}

/** Sequential batch size for narrative-mode expansion. Larger batches lose
 *  transition coherence; smaller burns more LLM round-trips for the same
 *  content. 3 is the sweet spot — enough context to write a smooth
 *  transition into chapter K+1, small enough to comfortably fit ~2k tokens
 *  output per call. */
const NARRATIVE_BATCH_SIZE = 3

/** Parallel batch size for listicle-mode expansion. Listicle chapters are
 *  independent so we can fit more per call without continuity concerns. */
const LISTICLE_BATCH_SIZE = 8

/** Max in-flight expansion calls for listicle mode. 4 is rate-limit-safe
 *  on typical Anthropic / OpenAI tiers. Tunable via env var if needed
 *  later. */
const LISTICLE_CONCURRENCY = 4

/** Above this chapter count, outline entries lose their synopsis +
 *  key_beats fields (title + 1-line hook only) so the outline call output
 *  doesn't blow the 16k cap. */
const COMPACT_OUTLINE_THRESHOLD = 500

/** Above this chapter count, expansion calls receive a "table of contents"
 *  (titles only) instead of the full outline so the INPUT window stays
 *  manageable. Below this, expansion calls see the whole outline. */
const TOC_MODE_THRESHOLD = 300

/**
 * Resume-integrity guard: a chapter docx counts as "done" only when the
 * file exists AND is non-zero. A crash (or ENOSPC, or kill -9) mid-write
 * can leave a 0-byte placeholder behind; without this check, the sidecar
 * would revive the placeholder as a completed chapter and the assembler
 * would silently ship an empty chapter into the unified narration.
 */
function chapterFileLooksValid(filePath: string): boolean {
  try {
    const st = statSync(filePath)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

// ── Sidecar shape ──────────────────────────────────────────────────────────

export interface OutlineEntry {
  /** 1-indexed chapter number. */
  n: number
  title: string
  /** ~30-word synopsis. Omitted on compact outlines (n > COMPACT_OUTLINE_THRESHOLD). */
  synopsis?: string
  /** 2–3 narrative beats. Narrative mode only. Omitted on compact outlines. */
  key_beats?: string[]
  /** 1-line hook. Listicle / compact-outline mode. */
  hook_line?: string
  /** Optional listicle-only fact bullets (used to seed expansion). */
  key_facts?: string[]
  /** Per-chapter word-count override (v2+). Falls back to params.wordsPerChapter
   *  when absent. The dynamic word-budget math in listicle/narrative batch
   *  prompts (12% hook / 76% body / 12% close) uses this when present so a
   *  single chapter can be longer or shorter than its peers. Set via the
   *  outline-review UI; persisted on the sidecar. */
  words_per_chapter?: number
}

export type ChunkedMode = 'narrative' | 'listicle'

/**
 * v3+ persisted snapshot of the script-form fields the chunked pipeline reads
 * from `GenerateScriptRequest`. Captured at outline-build time so expansion
 * (which can run minutes-to-days later, possibly across app restarts and form
 * edits) uses the SAME inputs the outline was built against. Without this,
 * expand-chapters depends on the frontend resending the form on every retry
 * — a fragile contract that previously crashed `callAi` when a request body
 * dropped `model` (the EP0002 startsWith bug).
 *
 * Stored on `ChunkedSidecar.generation_params`. v2 sidecars upgrade with
 * `null`; the executor falls back to the request body when null (existing
 * behaviour) so in-flight outlines aren't broken by the schema bump.
 */
export interface GenerationParams {
  model: string
  length?: number
  total_words?: number
  words_per_chapter: number
  pattern_id?: string
  pattern_subject?: string
  character_ids?: string[]
  custom_style_text?: string
}

export interface ChunkedSidecar {
  /** Schema version.
   *  v1: pre-outline-review (auto-approved by definition).
   *  v2: adds outline_approved_at + outline_edited_at + per-entry words_per_chapter.
   *  v3: adds generation_params (model + form snapshot at outline-build time).
   *  v1 + v2 sidecars are auto-upgraded on read. */
  schema_version: 3
  episode_id: string
  mode: ChunkedMode
  total_chapters: number
  outline: OutlineEntry[]
  outline_completed_at: string
  /** v2+: ISO timestamp of when the user (or auto_approve caller) approved
   *  the outline for expansion. null = generated but not yet approved;
   *  expand_chapters refuses to run until this is set. v1 sidecars upgrade
   *  with this set to outline_completed_at (treat existing as approved). */
  outline_approved_at: string | null
  /** v2+: ISO timestamp of the last user edit via PUT /outline. null when
   *  the outline is still the LLM's original. UI shows an "edited" badge
   *  when this is set. */
  outline_edited_at: string | null
  /** v3+: snapshot of script-form fields used to build this outline. The
   *  expand-chapters executor reads these instead of the request body so
   *  expansion always runs against the same model / words / pattern /
   *  characters the outline was built with. null on v2 sidecars upgraded
   *  in memory — executor falls back to the request body in that case. */
  generation_params: GenerationParams | null
  chapters_done: number[]
  /** sha256(first 16 chars) of the input params — invalidates resume when
   *  user changes chapter count / format / pattern between attempts. */
  params_hash: string
  last_updated: string
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ChunkedNarrationParams {
  episode_id: string
  title: string
  totalChapters: number
  wordsPerChapter: number
  format: Format
  /** Pre-built system prompt (already includes brand persona, format role, standards). */
  systemPrompt: string
  /** Directory where per-chapter docx files live and the sidecar is written. */
  scriptDir: string
  model: string
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  /** Optional cast for character-aware prompts. */
  characters?: Character[]
  /** Caller's AbortController signal — propagated to every LLM call. */
  signal?: AbortSignal
  /** Caller's cancel-checker — polled between batches so user-cancel
   *  unwinds cleanly even if the LLM SDK doesn't abort instantly. */
  isCancelled?: () => boolean
  /** Optional pattern info — folded into the params_hash so a different
   *  pattern wipes the resume sidecar. */
  patternId?: string
  patternSubject?: string
  /** Force regenerate from scratch (ignores existing sidecar / chapter files). */
  force?: boolean
  /** v3+: snapshot of the script-form fields that produced this run. When
   *  set on an outline-only call, gets written to the sidecar so a later
   *  expand-chapters run can re-derive the same params without depending
   *  on the request body. The executor populates this from the request
   *  body for outline-only runs and from the sidecar for expand-chapters
   *  runs (see setupChunkedJobContext in generators/episode.ts). */
  generationParams?: GenerationParams
}

export interface ChunkedNarrationResult {
  chaptersWritten: number
  totalBatches: number
  fromResume: boolean
  outlineCompletedThisRun: boolean
}

/**
 * Generate a narrative-format episode (sleep-story / adventure / true-crime
 * / kids) with chapter counts that exceed the single-call output cap.
 * Sequential batched expansion with transition glue.
 */
export async function generateNarrativeChunked(
  job: Job, params: ChunkedNarrationParams,
): Promise<ChunkedNarrationResult> {
  return runChunked(job, params, 'narrative')
}

/**
 * Generate a listicle-format episode (independent chapters, parallel
 * batched expansion).
 */
export async function generateListicleChunked(
  job: Job, params: ChunkedNarrationParams,
): Promise<ChunkedNarrationResult> {
  return runChunked(job, params, 'listicle')
}

// ── Core orchestration ────────────────────────────────────────────────────

/**
 * Outline-only phase (Phase 2 of the outline-first refactor). Builds the
 * outline via a single LLM call + persists it to the chunked-progress
 * sidecar with `outline_approved_at: null` by default. The user reviews
 * via the new OutlineReviewPanel and explicitly approves before expansion;
 * `auto_approve: true` skips the gate and is reserved for the legacy
 * one-shot wrappers (generateNarrativeChunked / generateListicleChunked)
 * and pipeline-batch headless runs.
 *
 * Resume-safe: if a sidecar already exists with matching params_hash + mode,
 * the cached outline is reused without re-billing the LLM. Same semantic
 * the original runChunked had.
 */
export interface BuildOutlineResult {
  outline: OutlineEntry[]
  fromCache: boolean
  approved: boolean
}
export async function buildOutlineOnly(
  job: Job,
  params: ChunkedNarrationParams,
  mode: ChunkedMode,
  opts: { auto_approve?: boolean } = {},
): Promise<BuildOutlineResult> {
  await fs.mkdir(params.scriptDir, { recursive: true })
  const paramsHash = computeParamsHash(params)

  // Resume check — same logic the original runChunked used.
  if (!params.force) {
    const existing = await readSidecar(params.scriptDir, params.episode_id)
    if (existing && existing.params_hash === paramsHash && existing.mode === mode) {
      job.output_lines.push(
        `[chunked] Outline cached on disk (${existing.outline.length} slots, ` +
        `${existing.outline_approved_at ? 'approved' : 'awaiting approval'}).`,
      )
      // Auto-approve flips an existing draft to approved without re-running
      // the outline call. Lets pipeline batch chain outline_only → expand
      // headlessly even when a previous interactive run left it in draft.
      if (opts.auto_approve && !existing.outline_approved_at) {
        const approved = { ...existing, outline_approved_at: new Date().toISOString(), last_updated: new Date().toISOString() }
        await writeSidecar(params.scriptDir, approved)
        return { outline: approved.outline, fromCache: true, approved: true }
      }
      return { outline: existing.outline, fromCache: true, approved: !!existing.outline_approved_at }
    }
  }

  // Build fresh outline.
  job.output_lines.push(
    `[chunked] Target: ${params.totalChapters} chapters × ~${params.wordsPerChapter} words = ${(params.totalChapters * params.wordsPerChapter).toLocaleString()} words. Building outline…`,
  )
  const outline = await buildOutline(job, params, mode)
  const nowIso = new Date().toISOString()
  const sidecar: ChunkedSidecar = {
    schema_version: 3,
    episode_id: params.episode_id,
    mode,
    total_chapters: params.totalChapters,
    outline,
    outline_completed_at: nowIso,
    // Default = unapproved (user must review). One-shot wrappers pass
    // auto_approve to bypass.
    outline_approved_at: opts.auto_approve ? nowIso : null,
    outline_edited_at: null,
    // Snapshot the form fields a future expand-chapters run will need.
    // null when the caller didn't supply them (legacy / test paths) — the
    // expand-chapters executor falls back to the request body in that case.
    generation_params: params.generationParams ?? null,
    chapters_done: [],
    params_hash: paramsHash,
    last_updated: nowIso,
  }
  await writeSidecar(params.scriptDir, sidecar)
  job.output_lines.push(
    `[chunked] Outline ready: ${outline.length} chapter slots` +
    `${opts.auto_approve ? ' (auto-approved)' : ' — awaiting user review'}.`,
  )
  return { outline, fromCache: false, approved: !!opts.auto_approve }
}

/**
 * Expansion phase (Phase 2 of the outline-first refactor). Reads the
 * sidecar, runs mode-specific expansion (narrative sequential / listicle
 * parallel), persists per-chapter docx files + updates chapters_done.
 *
 * Refuses to expand when the outline isn't approved unless the caller
 * passes `auto_approve: true` — a sharp signal that some upstream is
 * trying to bypass the human review gate.
 *
 * `chaptersToExpand` filters pending to a subset, enabling "expand only
 * chapters 5+7" UX without touching the others. Per-entry word overrides
 * (OutlineEntry.words_per_chapter) flow through params via the sidecar
 * read; the batch prompts read them when rendering each slot's target.
 */
export interface ExpandChaptersOptions {
  /** When set, only these chapter numbers are expanded. Others stay pending.
   *  Filtered against the sidecar's pending set; ones already on disk are
   *  skipped silently. Empty / undefined = expand everything pending. */
  chaptersToExpand?: number[]
  /** Bypass the outline_approved_at gate. Used by legacy one-shot wrappers
   *  and pipeline-batch headless runs. */
  auto_approve?: boolean
}
export async function expandChapters(
  job: Job,
  params: ChunkedNarrationParams,
  opts: ExpandChaptersOptions = {},
): Promise<ChunkedNarrationResult> {
  await fs.mkdir(params.scriptDir, { recursive: true })
  let sidecar = await readSidecar(params.scriptDir, params.episode_id)
  if (!sidecar) {
    throw new Error(
      'No outline found for this episode. Run outline-only first (Generate Outline) before expanding chapters.',
    )
  }
  const mode = sidecar.mode

  // Approval gate — the load-bearing check that replaces the implicit
  // "outline + expand in one job" semantics.
  if (!sidecar.outline_approved_at && !opts.auto_approve) {
    throw new Error(
      'Outline is not approved yet. Review and approve the outline before expanding chapters ' +
      '(or pass auto_approve: true for headless callers).',
    )
  }

  // Disk verification: same zero-byte-resume guard as the original
  // runChunked. Don't trust chapters_done blindly — verify each file
  // exists and is non-zero.
  const verifiedDone = new Set<number>()
  for (const n of sidecar.chapters_done) {
    if (chapterFileLooksValid(chapterFilePath(params.scriptDir, params.episode_id, n))) {
      verifiedDone.add(n)
    }
  }
  if (verifiedDone.size !== sidecar.chapters_done.length) {
    sidecar = { ...sidecar, chapters_done: Array.from(verifiedDone).sort((a, b) => a - b) }
    await writeSidecar(params.scriptDir, sidecar)
  }

  // Pending = outline slots whose docx isn't on disk, optionally
  // intersected with the caller's selection.
  let pending = sidecar.outline.filter(e => !verifiedDone.has(e.n))
  if (opts.chaptersToExpand?.length) {
    const want = new Set(opts.chaptersToExpand)
    pending = pending.filter(e => want.has(e.n))
  }
  if (pending.length === 0) {
    const reason = opts.chaptersToExpand?.length
      ? `Selected chapters (${opts.chaptersToExpand.join(', ')}) are already on disk.`
      : `All ${sidecar.total_chapters} chapters already on disk.`
    job.output_lines.push(`[chunked] ${reason} Nothing to do.`)
    return {
      chaptersWritten: verifiedDone.size,
      totalBatches: 0,
      fromResume: true,
      outlineCompletedThisRun: false,
    }
  }

  // Dispatch to mode-specific expansion.
  if (mode === 'listicle') {
    await expandListicleParallel(job, params, sidecar.outline, pending, sidecar)
  } else {
    await expandNarrativeSequential(job, params, sidecar.outline, pending, sidecar)
  }

  // Final sidecar sweep.
  const finalSidecar = await readSidecar(params.scriptDir, params.episode_id)
  const written = finalSidecar?.chapters_done.length ?? verifiedDone.size

  return {
    chaptersWritten: written,
    totalBatches: estimateBatchCount(pending.length, mode),
    fromResume: false,
    outlineCompletedThisRun: false,
  }
}

/**
 * Legacy one-shot orchestrator. Composes buildOutlineOnly (auto_approve)
 * → expandChapters (auto_approve). Exists for back-compat with the
 * existing `generateNarrativeChunked` / `generateListicleChunked`
 * exported functions, which compose into `generateEpisode`'s chunked
 * branch. Phase 3 will replace those callers with the explicit two-step
 * flow; until then, this preserves today's behaviour exactly.
 */
async function runChunked(
  job: Job, params: ChunkedNarrationParams, mode: ChunkedMode,
): Promise<ChunkedNarrationResult> {
  const outlineResult = await buildOutlineOnly(job, params, mode, { auto_approve: true })
  const expandResult = await expandChapters(job, params, { auto_approve: true })
  // Compose the result shape the legacy callers expect.
  return {
    ...expandResult,
    outlineCompletedThisRun: !outlineResult.fromCache,
    fromResume: outlineResult.fromCache,
  }
}

function estimateBatchCount(pending: number, mode: ChunkedMode): number {
  const size = mode === 'listicle' ? LISTICLE_BATCH_SIZE : NARRATIVE_BATCH_SIZE
  return Math.ceil(pending / size)
}

// ── Outline phase ──────────────────────────────────────────────────────────

async function buildOutline(
  job: Job, params: ChunkedNarrationParams, mode: ChunkedMode,
): Promise<OutlineEntry[]> {
  const compact = params.totalChapters > COMPACT_OUTLINE_THRESHOLD
  const prompt = mode === 'listicle'
    ? listicleOutlinePrompt(params, compact)
    : narrativeOutlinePrompt(params, compact)

  // Outline is a one-shot non-streaming JSON array call. Use the same
  // system prompt the caller built so format role + brand persona are in
  // effect. The model returns 100 chapters × ~80 words ≈ 11k tokens —
  // safely below the 16k streaming cap and the ~32k extended cap.
  const ctx = { slug: job.project_slug, jobId: job.job_id, signal: params.signal }
  const arr = await callForJsonArray(
    params.model, params.systemPrompt, prompt, params.apiKeys, ctx,
  )

  // Normalise: clamp `n` into 1..totalChapters and drop duplicates.
  // The model occasionally repeats chapter numbers or skips one; we
  // backfill any gaps with placeholder titles to keep the contract
  // (callers expect `outline.length === totalChapters`).
  const byN = new Map<number, OutlineEntry>()
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const n = Number(item.n)
    if (!Number.isFinite(n) || n < 1 || n > params.totalChapters) continue
    if (byN.has(n)) continue
    byN.set(n, {
      n,
      title: String(item.title || `Chapter ${n}`).trim() || `Chapter ${n}`,
      synopsis: typeof item.synopsis === 'string' ? item.synopsis.trim() : undefined,
      key_beats: Array.isArray(item.key_beats) ? item.key_beats.map(String) : undefined,
      hook_line: typeof item.hook_line === 'string' ? item.hook_line.trim() : undefined,
      key_facts: Array.isArray(item.key_facts) ? item.key_facts.map(String) : undefined,
    })
  }
  const out: OutlineEntry[] = []
  for (let n = 1; n <= params.totalChapters; n++) {
    const e = byN.get(n)
    if (e) out.push(e)
    else out.push({ n, title: `Chapter ${n}` })
  }
  return out
}

function narrativeOutlinePrompt(p: ChunkedNarrationParams, compact: boolean): string {
  const fieldHint = compact
    ? `Each entry: { "n": <int>, "title": "...", "hook_line": "1-line hook" }`
    : `Each entry: { "n": <int>, "title": "...", "synopsis": "~30 words", "key_beats": ["beat 1", "beat 2", "beat 3"] }`
  return `Plan the chapter structure for an episode I'm about to write. Output ONLY a JSON array of ${p.totalChapters} chapter entries — no preamble, no markdown, no code fences.

Episode title: ${p.title}
Format: ${p.format.name}
Target chapters: ${p.totalChapters}
Per-chapter target: ~${p.wordsPerChapter} words

PACING ARC TO COVER (apply across the ${p.totalChapters} chapters):
${p.format.script.pacingArc.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

${fieldHint}

Cover the full ${p.totalChapters}-chapter arc. Distinct titles, clear progression, no repeated subjects, no filler chapters. The sequence as a whole should read as a coherent episode arc — chapter 1 hook, middle development, chapter ${p.totalChapters} resolution.

Output: [ {"n":1, ...}, {"n":2, ...}, ..., {"n":${p.totalChapters}, ...} ]`
}

function listicleOutlinePrompt(p: ChunkedNarrationParams, compact: boolean): string {
  const fieldHint = compact
    ? `Each entry: { "n": <int>, "topic_title": "...", "hook_line": "1-line hook" }`
    : `Each entry: { "n": <int>, "title": "...", "hook_line": "1-line hook", "key_facts": ["fact 1", "fact 2", "fact 3"] }`
  return `Plan a listicle / explainer episode. Output ONLY a JSON array of ${p.totalChapters} topic entries — no preamble, no markdown, no code fences.

Episode title: ${p.title}
Format: ${p.format.name}
Target topics: ${p.totalChapters}
Per-topic target: ~${p.wordsPerChapter} words

${fieldHint}

Each topic must be SELF-CONTAINED (a viewer dropping in mid-video must understand it without prior context). Topics should be DISTINCT — different subjects, no overlap. Cover the breadth of the title's promise.

Output: [ {"n":1, ...}, {"n":2, ...}, ..., {"n":${p.totalChapters}, ...} ]`
}

// ── Narrative expansion (sequential batches with transition glue) ──────────

async function expandNarrativeSequential(
  job: Job, params: ChunkedNarrationParams,
  outline: OutlineEntry[], pending: OutlineEntry[], sidecar: ChunkedSidecar,
): Promise<void> {
  // Group pending into contiguous batches of NARRATIVE_BATCH_SIZE so we
  // can pull a clean transition window (last 200 words of the chapter
  // before the batch's first slot) when one exists on disk.
  const batches: OutlineEntry[][] = []
  for (let i = 0; i < pending.length; i += NARRATIVE_BATCH_SIZE) {
    batches.push(pending.slice(i, i + NARRATIVE_BATCH_SIZE))
  }

  job.output_lines.push(`[chunked] Mode: narrative (sequential, batches of ${NARRATIVE_BATCH_SIZE}). ${batches.length} batch(es) to run.`)

  let runningSidecar = sidecar
  for (let bi = 0; bi < batches.length; bi++) {
    if (params.isCancelled?.()) {
      job.output_lines.push(`[chunked] Cancelled by user before batch ${bi + 1}/${batches.length}.`)
      throw new Error('Cancelled by user')
    }
    const batch = batches[bi]!
    const firstN = batch[0]!.n
    const lastN = batch[batch.length - 1]!.n

    // Transition window: previous chapter's last 200 words from disk,
    // when it exists. If we're starting at chapter 1 (or the prior
    // chapter wasn't generated yet), no window.
    const priorChapterN = firstN - 1
    let transitionWindow = ''
    if (priorChapterN >= 1) {
      const priorPath = chapterFilePath(params.scriptDir, params.episode_id, priorChapterN)
      if (existsSync(priorPath)) {
        try {
          const { narrationDocxToMarkdown } = await import('./docx-parser.js')
          const md = await narrationDocxToMarkdown(priorPath)
          const body = md.replace(/^##[^\n]*\n+/, '').trim()
          const words = body.split(/\s+/)
          transitionWindow = words.slice(Math.max(0, words.length - 200)).join(' ')
        } catch { /* unreadable prior chapter — proceed without window */ }
      }
    }

    const useTOC = params.totalChapters > TOC_MODE_THRESHOLD
    const prompt = narrativeBatchPrompt(params, outline, batch, transitionWindow, useTOC)

    job.output_lines.push(`[chunked] Batch ${bi + 1}/${batches.length} — chapters ${firstN}-${lastN}…`)
    const ctx = { slug: job.project_slug, jobId: job.job_id, signal: params.signal }
    const text = await callAi(params.model, params.systemPrompt, prompt, params.apiKeys, true, ctx)

    // Parse + write.
    const wrote = await parseAndWriteBatch(params, batch, text)
    runningSidecar = markDone(runningSidecar, wrote)
    await writeSidecar(params.scriptDir, runningSidecar)
    job.output_lines.push(`[chunked]   → wrote ${wrote.length} chapter(s) (${wrote.join(', ')})`)
  }
}

function narrativeBatchPrompt(
  p: ChunkedNarrationParams, outline: OutlineEntry[], batch: OutlineEntry[],
  transitionWindow: string, useTOC: boolean,
): string {
  const outlineBlock = useTOC
    // Compact mode: titles only, listed as a "table of contents". The
    // model still sees the global arc but the input cost stays linear-ish
    // even at 1000+ chapters.
    ? `TABLE OF CONTENTS (all ${outline.length} chapters):\n${outline.map(e => `  ${e.n}. ${e.title}`).join('\n')}`
    // Standard mode: full outline so the model has context for transitions
    // and tone modulation across the arc.
    : `OUTLINE (all chapters):\n${outline.map(e => {
        const synopsis = e.synopsis ? ` — ${e.synopsis}` : ''
        return `  ${e.n}. ${e.title}${synopsis}`
      }).join('\n')}`

  // Per-slot effective targets — entries may override the global via
  // words_per_chapter (v2 schema). When uniform, render today's prompt
  // shape (back-compat). When mixed, append "(target N words)" inline on
  // each slot so the LLM knows chapter 3 wants 800 while chapter 4 wants 400.
  const targets = batch.map(e => effectiveWordTarget(e, p))
  const uniform = targets.every(t => t === targets[0])

  const slots = batch.map((e, i) => {
    const beats = e.key_beats?.length ? `\n   Key beats: ${e.key_beats.map(b => `"${b}"`).join('; ')}` : ''
    const synopsis = e.synopsis ? `\n   Synopsis: ${e.synopsis}` : ''
    const lengthHint = uniform ? '' : `\n   Length: ~${targets[i]} words.`
    return `  Chapter ${e.n}: ${e.title}${synopsis}${beats}${lengthHint}`
  }).join('\n\n')

  const transitionBlock = transitionWindow
    ? `\nPREVIOUS CHAPTER TAIL (your tone + scene must flow on from this — DO NOT recap, just continue):\n${transitionWindow}\n`
    : ''

  // Top-line target. For uniform batches: explicit number. For mixed:
  // describe the default + point at per-slot Length: lines.
  const targetLine = uniform
    ? `Per-chapter target: ${targets[0]} words`
    : `Per-chapter target: see Length: line on each slot below (default ${p.wordsPerChapter} words)`

  // Output template lengths follow the same pattern.
  const tmplLen = (i: number) => uniform ? `~${targets[0]} words` : `~${targets[i] ?? p.wordsPerChapter} words`

  return `Write ${batch.length} chapter(s) of an in-progress episode. You're expanding ONLY the slots listed below — the full arc is shown for context.

Episode title: ${p.title}
Format: ${p.format.name}
${targetLine}

${outlineBlock}
${transitionBlock}
SLOTS TO WRITE NOW:

${slots}

Output the chapters in this exact format (and ONLY these chapters, in numeric order):

## Chapter ${batch[0]!.n.toString().padStart(2, '0')}: ${batch[0]!.title}

[${tmplLen(0)} of body text]

## Chapter ${batch[1]?.n.toString().padStart(2, '0') ?? batch[0]!.n.toString().padStart(2, '0')}: ${batch[1]?.title ?? '...'}

[${tmplLen(1)} of body text]

${batch.length > 2 ? `## Chapter ${batch[2]!.n.toString().padStart(2, '0')}: ${batch[2]!.title}\n\n[${tmplLen(2)} of body text]` : ''}

Rules:
- Write ALL ${batch.length} chapters in this single response. Do not stop early.
- Use the chapter numbers and titles EXACTLY as shown.
- ${uniform
  ? `Each chapter is ~${targets[0]} words of body. No meta-commentary, no preamble.`
  : `Each chapter hits its OWN word target (see slot Length: lines). No meta-commentary, no preamble.`}
- Maintain the format's tone consistently with the rest of the episode.

Output ONLY the chapter blocks above.`
}

// ── Listicle expansion (parallel batches) ──────────────────────────────────

async function expandListicleParallel(
  job: Job, params: ChunkedNarrationParams,
  outline: OutlineEntry[], pending: OutlineEntry[], sidecar: ChunkedSidecar,
): Promise<void> {
  const batches: OutlineEntry[][] = []
  for (let i = 0; i < pending.length; i += LISTICLE_BATCH_SIZE) {
    batches.push(pending.slice(i, i + LISTICLE_BATCH_SIZE))
  }
  job.output_lines.push(
    `[chunked] Mode: listicle (parallel, batches of ${LISTICLE_BATCH_SIZE}, concurrency ${LISTICLE_CONCURRENCY}). ${batches.length} batch(es) to run.`,
  )

  let runningSidecar = sidecar
  let cursor = 0
  let completed = 0
  let aborted = false

  async function worker(workerId: number): Promise<void> {
    while (cursor < batches.length && !aborted) {
      if (params.isCancelled?.()) { aborted = true; return }
      const idx = cursor++
      if (idx >= batches.length) return
      const batch = batches[idx]!
      const firstN = batch[0]!.n
      const lastN = batch[batch.length - 1]!.n

      try {
        const prompt = listicleBatchPrompt(params, batch)
        const ctx = { slug: job.project_slug, jobId: job.job_id, signal: params.signal }
        const text = await callAi(params.model, params.systemPrompt, prompt, params.apiKeys, true, ctx)
        const wrote = await parseAndWriteBatch(params, batch, text)
        // Sidecar updates need serialisation — atomic write is fine but we
        // don't want two workers reading-then-writing concurrently and
        // dropping each other's progress. Read-modify-write under a small
        // critical section.
        runningSidecar = markDone(runningSidecar, wrote)
        await writeSidecar(params.scriptDir, runningSidecar)
        completed++
        job.output_lines.push(
          `[chunked]   [w${workerId}] batch ${idx + 1}/${batches.length} — chapters ${firstN}-${lastN}: wrote ${wrote.length} (${completed}/${batches.length} batches done)`,
        )
      } catch (e: any) {
        // One batch failure shouldn't kill the others — note it and let
        // the worker continue to the next batch. The unfinished chapters
        // stay missing on disk so a later resume picks them up.
        job.output_lines.push(
          `[chunked]   [w${workerId}] batch ${idx + 1}/${batches.length} FAILED: ${e?.message || e}. ` +
          `Chapters ${firstN}-${lastN} will be retried on resume.`,
        )
        if (params.isCancelled?.() || params.signal?.aborted) {
          aborted = true; return
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(LISTICLE_CONCURRENCY, batches.length) }, (_, i) => worker(i + 1)),
  )

  if (aborted) {
    throw new Error('Cancelled by user')
  }
}

/**
 * Resolve the effective word target for a single outline entry: per-entry
 * override (v2 schema) wins over the global params target. Falls back to
 * 120 to keep the math safe for absurdly small inputs.
 */
function effectiveWordTarget(entry: OutlineEntry, p: ChunkedNarrationParams): number {
  const override = typeof entry.words_per_chapter === 'number' && entry.words_per_chapter > 0
    ? entry.words_per_chapter | 0
    : null
  return Math.max(120, override ?? (p.wordsPerChapter | 0))
}

/**
 * Compute the word-budget allocation for a target. Pulled out so listicle
 * + narrative prompts share one source of truth, and the per-entry override
 * path can call it once per slot. The percentages (12% hook / 76% body /
 * 12% close) and beat-count clamp (3..6) come from the v1.0.71 listicle
 * undershoot fix — see the Brainwise commit for the empirical reasoning.
 */
interface WordBudget {
  target: number
  minFloor: number
  maxCeiling: number
  hookWords: number
  payoffWords: number
  bodyWords: number
  beatCount: number
  wordsPerBeat: number
}
function computeWordBudget(target: number): WordBudget {
  const t = Math.max(120, target | 0)
  const minFloor = Math.floor(t * 0.9)
  const maxCeiling = Math.ceil(t * 1.15)
  const hookWords = Math.max(40, Math.round(t * 0.12))
  const payoffWords = Math.max(40, Math.round(t * 0.12))
  const bodyWords = t - hookWords - payoffWords
  const beatCount = Math.max(3, Math.min(6, Math.round(bodyWords / 100)))
  const wordsPerBeat = Math.round(bodyWords / beatCount)
  return { target: t, minFloor, maxCeiling, hookWords, payoffWords, bodyWords, beatCount, wordsPerBeat }
}

function listicleBatchPrompt(p: ChunkedNarrationParams, batch: OutlineEntry[]): string {
  // Per-slot effective target — entries may override the global via their
  // words_per_chapter field (v2 schema). When ALL entries in this batch
  // share the same target, render the prompt with one global budget block
  // (the back-compat shape — what every listicle outline produced before
  // the override feature shipped). When entries differ, render an
  // explicit per-slot budget block so the LLM knows chapter 3 wants 800
  // words while chapter 4 wants 400.
  const targets = batch.map(e => effectiveWordTarget(e, p))
  const uniform = targets.every(t => t === targets[0])
  const globalBudget = computeWordBudget(uniform ? targets[0] : (p.wordsPerChapter | 0))

  const slots = batch.map((e, i) => {
    const facts = e.key_facts?.length ? `\n   Key facts: ${e.key_facts.map(f => `"${f}"`).join('; ')}` : ''
    const hook = e.hook_line ? `\n   Hook: ${e.hook_line}` : ''
    // Per-slot budget appears inline only when the batch has mixed targets.
    // Keeps the uniform case visually identical to the pre-override prompt.
    let perSlotBudget = ''
    if (!uniform) {
      const b = computeWordBudget(targets[i])
      perSlotBudget = `\n   Length: ${b.target} words (min ${b.minFloor}, max ${b.maxCeiling}). ` +
        `Body in ${b.beatCount} beats × ~${b.wordsPerBeat} words.`
    }
    return `  Chapter ${e.n}: ${e.title}${hook}${facts}${perSlotBudget}`
  }).join('\n\n')

  // Length / budget block. When uniform, one block covers all slots. When
  // mixed, this block describes the DEFAULT and the per-slot lines
  // override on a case-by-case basis.
  const { target, minFloor, maxCeiling, hookWords, payoffWords, bodyWords, beatCount, wordsPerBeat } = globalBudget
  const lengthHeader = uniform
    ? `PER-CHAPTER LENGTH (binding, not a hint):
- Target: ${target} words.
- Minimum: ${minFloor} words. Drafts shorter than this are unusable — DO NOT ship a stub.
- Maximum: ${maxCeiling} words.

WORD BUDGET (how to spend the ${target} words inside one chapter):
- Hook (open):  ~${hookWords} words — one provocative claim, counter-intuitive question, or sharp image.
- Body (${beatCount} supporting beats): ~${bodyWords} words total, ~${wordsPerBeat} words each — cite mechanism, evidence, history, or concrete specifics. Each beat earns its own paragraph.
- Micro-payoff (close): ~${payoffWords} words — memorable line, open question, or wry beat.`
    : `PER-CHAPTER LENGTH (binding, not a hint):
- Each chapter has its OWN word target — see the Length: line on each slot below. Treat that target as the binding minimum + maximum (90%–115% range).
- Default for slots without an explicit Length: ${target} words.

WORD BUDGET (how to spend each slot's target inside one chapter):
- Hook (open):  ~12% of the slot's target — one provocative claim, counter-intuitive question, or sharp image.
- Body (3–6 supporting beats, scaled to length): ~76% of the slot's target — cite mechanism, evidence, history, or concrete specifics. Each beat earns its own paragraph.
- Micro-payoff (close): ~12% of the slot's target — memorable line, open question, or wry beat.`

  return `Write ${batch.length} listicle chapter(s) of an in-progress episode. Each chapter is INDEPENDENT — no transitions, no references to other chapters.

Episode title: ${p.title}
Format: ${p.format.name}

${lengthHeader}

SLOTS TO WRITE:

${slots}

Output the chapters in this exact format (and ONLY these chapters, in numeric order):

## Chapter ${batch[0]!.n.toString().padStart(2, '0')}: ${batch[0]!.title}

<full body ${uniform ? `of ${minFloor}-${maxCeiling} words` : `at the slot's target`}, structured as hook → ${uniform ? `${beatCount} beats` : `3-6 beats (scale to length)`} → payoff>

## Chapter ${batch[1]?.n.toString().padStart(2, '0') ?? ''}: ${batch[1]?.title ?? ''}

<full body ${uniform ? `of ${minFloor}-${maxCeiling} words` : `at the slot's target`}, structured as hook → ${uniform ? `${beatCount} beats` : `3-6 beats (scale to length)`} → payoff>

(continue for all ${batch.length} chapters)

Rules:
- Write ALL ${batch.length} chapters in this single response.
- Use the chapter numbers and titles EXACTLY as shown.
- ${uniform
  ? `Each chapter MUST be at least ${minFloor} words. If the topic feels thin, add one more beat — never compress under the floor.`
  : `Each chapter MUST hit at least 90% of its slot's word target. If the topic feels thin, add one more beat — never compress below the floor.`}
- No meta-commentary, no preamble, no "in this chapter…" recap, no word counts.
- Do not output bracketed placeholders or section headers like "Hook:" / "Beat 1:" — write flowing prose.

Output ONLY the chapter blocks above.`
}

// ── Per-batch parsing + per-chapter writing ────────────────────────────────

/**
 * Parse a batch response (markdown with `## Chapter NN: Title` blocks),
 * write each parsed chapter to its own docx via `writeChapterFiles`,
 * and return the list of chapter numbers actually written. The caller
 * passes the expected `batch` so we can warn (and skip) if the model
 * returned a chapter we didn't ask for.
 */
async function parseAndWriteBatch(
  params: ChunkedNarrationParams, batch: OutlineEntry[], text: string,
): Promise<number[]> {
  const expected = new Set(batch.map(e => e.n))
  const parts = splitNarrationIntoChapters(text)
  const filtered: NarrationParts = {
    chapters: parts.chapters.filter(c => expected.has(c.number)),
  }
  if (filtered.chapters.length === 0) return []
  await writeChapterFiles(params.scriptDir, params.episode_id, params.title, filtered)
  return filtered.chapters.map(c => c.number).sort((a, b) => a - b)
}

// ── Sidecar I/O ────────────────────────────────────────────────────────────

export function sidecarPath(scriptDir: string, episode_id: string): string {
  return path.join(scriptDir, `${episode_id}_chunked-progress.json`)
}

export async function readSidecar(scriptDir: string, episode_id: string): Promise<ChunkedSidecar | null> {
  try {
    const raw = await fs.readFile(sidecarPath(scriptDir, episode_id), 'utf-8')
    const parsed = JSON.parse(raw)
    // v1 → v3 / v2 → v3 auto-upgrade. v1 sidecars predate the outline-
    // review feature (implicit "approved on build"); v2 added review +
    // per-entry word overrides; v3 adds generation_params (model + form
    // snapshot at outline-build time). All upgrades are in-memory only —
    // the next writeSidecar call persists v3 to disk. Old generation_params
    // is null on upgrade, which the expand-chapters executor handles by
    // falling back to the request body so no in-flight outline breaks.
    if (parsed?.schema_version === 1) {
      return {
        ...parsed,
        schema_version: 3,
        outline_approved_at: parsed.outline_completed_at || null,
        outline_edited_at: null,
        generation_params: null,
      } as ChunkedSidecar
    }
    if (parsed?.schema_version === 2) {
      return {
        ...parsed,
        schema_version: 3,
        generation_params: null,
      } as ChunkedSidecar
    }
    if (parsed?.schema_version === 3) {
      return parsed as ChunkedSidecar
    }
    // Unknown schema version — fail safe, treat as no sidecar.
    return null
  } catch {
    return null
  }
}

/**
 * Public helper for the chapter-only regenerator: look up the chunked-
 * progress sidecar's outline entry for a given chapter number. Returns
 * null when the sidecar doesn't exist (single-call non-chunked project)
 * or when the chapter number isn't in the outline (off-by-one, mismatched
 * total_chapters, etc.). Also returns the mode so the caller can
 * branch its prompt between narrative and listicle.
 *
 * Why exposed: per-chapter regeneration was previously format-blind —
 * it asked the LLM to "regenerate Chapter 5" without telling the model
 * what topic Chapter 5 was originally about. For listicle in particular
 * this meant the regenerated chapter drifted to a brand-new topic. With
 * this lookup, the chapter-only generator can thread the original outline
 * (title, hook, key_facts for listicle / synopsis, key_beats for narrative)
 * back into the prompt so the regen stays on the same topic.
 */
export interface OutlineLookupResult {
  entry: OutlineEntry
  mode: ChunkedMode
  totalChapters: number
}
export async function getOutlineEntryForChapter(
  scriptDir: string,
  episode_id: string,
  chapterNumber: number,
): Promise<OutlineLookupResult | null> {
  const sidecar = await readSidecar(scriptDir, episode_id)
  if (!sidecar) return null
  const entry = sidecar.outline.find(e => e.n === chapterNumber)
  if (!entry) return null
  return { entry, mode: sidecar.mode, totalChapters: sidecar.total_chapters }
}

// Per-path serialisation queue for sidecar writes. The atomic-rename in
// writeJsonAtomic guarantees no torn writes, but it does NOT guarantee
// write ORDER when two parallel callers have overlapping in-flight
// renames — the later-started rename can complete first, letting the
// earlier-started rename's older state overwrite it on disk. The
// listicle parallel path triggered this regularly: 24 chapters / 8
// per batch / 4 workers in parallel could end up with only 8 chapters
// in the on-disk sidecar even though all 24 chapter docx files
// landed correctly.
//
// Fix: serialise all sidecar writes per-path through a Promise chain.
// One in-flight write at a time per sidecar; subsequent calls await
// the previous settled state. Cheap (sidecars are tiny JSON), and the
// queue length stays bounded by the listicle CONCURRENCY (4 in our
// configuration).
const sidecarWriteChains = new Map<string, Promise<void>>()

async function writeSidecar(scriptDir: string, sidecar: ChunkedSidecar): Promise<void> {
  const target = sidecarPath(scriptDir, sidecar.episode_id)
  const previous = sidecarWriteChains.get(target) || Promise.resolve()
  // Capture the snapshot AT QUEUE TIME so two interleaved callers can't
  // both serialise the same older state through the chain.
  const snapshot = { ...sidecar, chapters_done: [...sidecar.chapters_done] }
  const next = previous.then(
    () => writeJsonAtomic(target, snapshot),
    () => writeJsonAtomic(target, snapshot),  // proceed even if previous rejected
  )
  sidecarWriteChains.set(target, next)
  await next
  // Only clear the chain if it's still ours — another caller may have
  // appended after us and we don't want to drop their pending write.
  if (sidecarWriteChains.get(target) === next) {
    sidecarWriteChains.delete(target)
  }
}

function markDone(sidecar: ChunkedSidecar, chapters: number[]): ChunkedSidecar {
  const merged = new Set([...sidecar.chapters_done, ...chapters])
  return {
    ...sidecar,
    chapters_done: Array.from(merged).sort((a, b) => a - b),
    last_updated: new Date().toISOString(),
  }
}

function computeParamsHash(p: ChunkedNarrationParams): string {
  const blob = JSON.stringify({
    fmt: p.format.id,
    n: p.totalChapters,
    w: p.wordsPerChapter,
    pat: p.patternId || '',
    sub: p.patternSubject || '',
    chars: (p.characters || []).map(c => c.id).sort(),
  })
  return createHash('sha256').update(blob).digest('hex').slice(0, 16)
}

// ── JSON-array call helper with retry ──────────────────────────────────────

async function callForJsonArray(
  model: string, system: string, user: string,
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string },
  ctx: { signal?: AbortSignal; slug?: string; jobId?: string },
  retries = 2,
): Promise<any[]> {
  let lastErr = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled by user')
    const raw = await callAi(model, system, user, apiKeys, false, ctx)
    let text = raw.trim()
    if (text.startsWith('```')) {
      text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n').trim()
    }
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1) {
      lastErr = 'No JSON array in response'
      continue
    }
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
      lastErr = 'JSON value is not an array'
    } catch (e: any) {
      lastErr = e?.message || String(e)
    }
  }
  throw new Error(`Outline JSON parse failed after ${retries + 1} attempts: ${lastErr}`)
}
