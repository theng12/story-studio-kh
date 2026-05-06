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
}

export type ChunkedMode = 'narrative' | 'listicle'

export interface ChunkedSidecar {
  schema_version: 1
  episode_id: string
  mode: ChunkedMode
  total_chapters: number
  outline: OutlineEntry[]
  outline_completed_at: string
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

async function runChunked(
  job: Job, params: ChunkedNarrationParams, mode: ChunkedMode,
): Promise<ChunkedNarrationResult> {
  await fs.mkdir(params.scriptDir, { recursive: true })
  const paramsHash = computeParamsHash(params)

  // Resume check. If a sidecar exists and the params still match, we
  // pick up where we left off; otherwise (force OR mismatched hash) we
  // wipe progress and start fresh.
  let sidecar: ChunkedSidecar | null = null
  if (!params.force) {
    const existing = await readSidecar(params.scriptDir, params.episode_id)
    if (existing && existing.params_hash === paramsHash && existing.mode === mode) {
      sidecar = existing
      job.output_lines.push(
        `[chunked] Resuming: ${sidecar.chapters_done.length}/${sidecar.total_chapters} chapters already on disk, outline cached.`,
      )
    }
  }

  let outline: OutlineEntry[]
  let outlineCompletedThisRun = false
  if (sidecar) {
    outline = sidecar.outline
  } else {
    job.output_lines.push(
      `[chunked] Target: ${params.totalChapters} chapters × ~${params.wordsPerChapter} words = ${(params.totalChapters * params.wordsPerChapter).toLocaleString()} words. Building outline…`,
    )
    outline = await buildOutline(job, params, mode)
    outlineCompletedThisRun = true
    sidecar = {
      schema_version: 1,
      episode_id: params.episode_id,
      mode,
      total_chapters: params.totalChapters,
      outline,
      outline_completed_at: new Date().toISOString(),
      chapters_done: [],
      params_hash: paramsHash,
      last_updated: new Date().toISOString(),
    }
    await writeSidecar(params.scriptDir, sidecar)
    job.output_lines.push(`[chunked] Outline ready: ${outline.length} chapter slots.`)
  }

  // Cross-check the sidecar's chapters_done against actual files on disk.
  // Files can disappear (manual cleanup, drive sync) between runs; the
  // sidecar is the intent, the disk is the truth. We trust the disk —
  // and we require the file to be non-zero. A 0-byte docx left by a
  // crash mid-write would otherwise be revived as "done" and ship an
  // empty chapter to the assembler.
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

  // Pending = every outline slot whose docx isn't on disk.
  const pending = outline.filter(e => !verifiedDone.has(e.n))
  if (pending.length === 0) {
    job.output_lines.push(`[chunked] All ${params.totalChapters} chapters already on disk. Nothing to do.`)
    return {
      chaptersWritten: verifiedDone.size,
      totalBatches: 0,
      fromResume: !outlineCompletedThisRun,
      outlineCompletedThisRun,
    }
  }

  // Dispatch to mode-specific expansion.
  if (mode === 'listicle') {
    await expandListicleParallel(job, params, outline, pending, sidecar)
  } else {
    await expandNarrativeSequential(job, params, outline, pending, sidecar)
  }

  // Final sidecar sweep — chapter files written by the expansion loop;
  // sidecar.chapters_done already updated incrementally below.
  const finalSidecar = await readSidecar(params.scriptDir, params.episode_id)
  const written = finalSidecar?.chapters_done.length ?? verifiedDone.size

  return {
    chaptersWritten: written,
    totalBatches: estimateBatchCount(pending.length, mode),
    fromResume: !outlineCompletedThisRun,
    outlineCompletedThisRun,
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

  const slots = batch.map(e => {
    const beats = e.key_beats?.length ? `\n   Key beats: ${e.key_beats.map(b => `"${b}"`).join('; ')}` : ''
    const synopsis = e.synopsis ? `\n   Synopsis: ${e.synopsis}` : ''
    return `  Chapter ${e.n}: ${e.title}${synopsis}${beats}`
  }).join('\n\n')

  const transitionBlock = transitionWindow
    ? `\nPREVIOUS CHAPTER TAIL (your tone + scene must flow on from this — DO NOT recap, just continue):\n${transitionWindow}\n`
    : ''

  return `Write ${batch.length} chapter(s) of an in-progress episode. You're expanding ONLY the slots listed below — the full arc is shown for context.

Episode title: ${p.title}
Format: ${p.format.name}
Per-chapter target: ${p.wordsPerChapter} words

${outlineBlock}
${transitionBlock}
SLOTS TO WRITE NOW:

${slots}

Output the chapters in this exact format (and ONLY these chapters, in numeric order):

## Chapter ${batch[0]!.n.toString().padStart(2, '0')}: ${batch[0]!.title}

[~${p.wordsPerChapter} words of body text]

## Chapter ${batch[1]?.n.toString().padStart(2, '0') ?? batch[0]!.n.toString().padStart(2, '0')}: ${batch[1]?.title ?? '...'}

[~${p.wordsPerChapter} words of body text]

${batch.length > 2 ? `## Chapter ${batch[2]!.n.toString().padStart(2, '0')}: ${batch[2]!.title}\n\n[~${p.wordsPerChapter} words of body text]` : ''}

Rules:
- Write ALL ${batch.length} chapters in this single response. Do not stop early.
- Use the chapter numbers and titles EXACTLY as shown.
- Each chapter is ~${p.wordsPerChapter} words of body. No meta-commentary, no preamble.
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

function listicleBatchPrompt(p: ChunkedNarrationParams, batch: OutlineEntry[]): string {
  const slots = batch.map(e => {
    const facts = e.key_facts?.length ? `\n   Key facts: ${e.key_facts.map(f => `"${f}"`).join('; ')}` : ''
    const hook = e.hook_line ? `\n   Hook: ${e.hook_line}` : ''
    return `  Chapter ${e.n}: ${e.title}${hook}${facts}`
  }).join('\n\n')

  // Word-budget allocation. The previous prompt said "~N words" with a
  // bracketed [~N words] sentinel + structural rules ("hook 1-2 sentences,
  // 2-4 beats, payoff 1-2 sentences"). LLMs read those as soft hints and
  // consistently undershot — a 500-word target shipped as 200-250 words
  // because hook + 2-4 short beats + payoff naturally lands around there.
  // The fix: state a HARD minimum, allocate the budget across sections,
  // and scale the body-beat count to the target so the structural rules
  // can actually accommodate the requested length.
  const target = Math.max(120, p.wordsPerChapter | 0)
  const minFloor = Math.floor(target * 0.9)             // 90% floor
  const maxCeiling = Math.ceil(target * 1.15)            // 15% headroom
  const hookWords = Math.max(40, Math.round(target * 0.12))   // ~12% hook
  const payoffWords = Math.max(40, Math.round(target * 0.12)) // ~12% close
  const bodyWords = target - hookWords - payoffWords          // ~76% body
  // Beat count scales with body: ~100 words per beat is the LLM's natural
  // rhythm. Clamp 3..6 so we don't ask for 1 monolith or 10 fragments.
  const beatCount = Math.max(3, Math.min(6, Math.round(bodyWords / 100)))
  const wordsPerBeat = Math.round(bodyWords / beatCount)

  return `Write ${batch.length} listicle chapter(s) of an in-progress episode. Each chapter is INDEPENDENT — no transitions, no references to other chapters.

Episode title: ${p.title}
Format: ${p.format.name}

PER-CHAPTER LENGTH (binding, not a hint):
- Target: ${target} words.
- Minimum: ${minFloor} words. Drafts shorter than this are unusable — DO NOT ship a stub.
- Maximum: ${maxCeiling} words.

WORD BUDGET (how to spend the ${target} words inside one chapter):
- Hook (open):  ~${hookWords} words — one provocative claim, counter-intuitive question, or sharp image.
- Body (${beatCount} supporting beats): ~${bodyWords} words total, ~${wordsPerBeat} words each — cite mechanism, evidence, history, or concrete specifics. Each beat earns its own paragraph.
- Micro-payoff (close): ~${payoffWords} words — memorable line, open question, or wry beat.

SLOTS TO WRITE:

${slots}

Output the chapters in this exact format (and ONLY these chapters, in numeric order):

## Chapter ${batch[0]!.n.toString().padStart(2, '0')}: ${batch[0]!.title}

<full body of ${minFloor}-${maxCeiling} words, structured as hook → ${beatCount} beats → payoff>

## Chapter ${batch[1]?.n.toString().padStart(2, '0') ?? ''}: ${batch[1]?.title ?? ''}

<full body of ${minFloor}-${maxCeiling} words, structured as hook → ${beatCount} beats → payoff>

(continue for all ${batch.length} chapters)

Rules:
- Write ALL ${batch.length} chapters in this single response.
- Use the chapter numbers and titles EXACTLY as shown.
- Each chapter MUST be at least ${minFloor} words. If the topic feels thin, add one more beat — never compress under the floor.
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

async function readSidecar(scriptDir: string, episode_id: string): Promise<ChunkedSidecar | null> {
  try {
    const raw = await fs.readFile(sidecarPath(scriptDir, episode_id), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.schema_version !== 1) return null
    return parsed as ChunkedSidecar
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
