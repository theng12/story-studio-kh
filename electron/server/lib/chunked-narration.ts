/**
 * Chunked narration + image-prompt generation.
 *
 * Single-call LLM generation tops out at the SELECTED PRODUCT's published
 * `max_output_tokens`, read live from the GenStudio catalogue — never a
 * constant, and never inferred from a model name. Past that point the model
 * truncates mid-output or shrinks per-chapter wordcount to fit. This module
 * handles the "big request" case by splitting into outline + per-batch
 * expansion and writing chapters incrementally so cancel / crash / restart
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
 * Threshold dispatch: a run needs splitting when
 *   `chapters * words_per_chapter > chunkThresholdWords(product.max_output_tokens)`.
 * That number tracks the product that will actually execute the run — a
 * 128,000-token product does not split at the same size a 16,000-token one
 * does. Below the threshold a run fits one call, which is both cheaper and
 * tighter in cohesion; the script generator still writes per chapter so a
 * crash resumes from disk either way.
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
import { isLocalTextModel } from '../services/job-retry-policy.js'
import { createHash } from 'crypto'
import { callAi, callAiWithRetry, parseStructuredJson } from './ai-client.js'
import { GenStudioChatIncompleteError, GenStudioChatProductUnavailableError } from './genstudio-client.js'
import { stripGenStudioModelPrefix } from '../services/genstudio-model-migration.js'
import { outlineOutputContract } from './story-output-contracts.js'
import type { TextOutputContract } from './json-output-contract.js'
import { writeJsonAtomic } from './atomic-store.js'
import { resolveResearchPaths } from './research-paths.js'
import {
  splitNarrationIntoChapters,
  writeChapterFiles,
  chapterFilePath,
  type NarrationParts,
} from './narration-assembly.js'
import { matchChapterFile, resolveReadPath } from './episode-artifacts.js'
import * as jq from '../services/job-queue.js'
import type { Job, Format, Character } from '../models/types.js'

// ── Tunables ───────────────────────────────────────────────────────────────

/**
 * LEGACY word target above which chunked mode used to be the only safe
 * choice. It is now the FALLBACK ONLY — the value used when the selected
 * product's published output limit could not be read. Prefer
 * `chunkThresholdWords(product.max_output_tokens)`.
 *
 * WHY IT IS NO LONGER A CONSTANT: 9000 words ≈ 11.7k output tokens; with a
 * typical 2k-token system+user prompt that left ~2.3k margin under the 16k
 * STREAMING ANTHROPIC cap this app no longer uses. Every language call now
 * goes through a published GenStudio product, and those products publish
 * their own `max_output_tokens` — 128,000 on the current default. Chunking a
 * run at 9,000 words against a 128,000-token product splits work the model
 * could have written in a fraction of the calls, and every extra call is
 * another chance to hit GenStudio backpressure mid-run. It is also the exact
 * "no static output ceiling anywhere in Story Studio" rule that removed the
 * Scene Plan 32,768 cap.
 */
export const CHUNK_THRESHOLD_WORDS = 9000

// v1.0.786 — the 16,000-token FALLBACK_OUTPUT_TOKEN_CAP that used to live here
// is gone. It was an invented ceiling: when the catalogue could not be read it
// put a number the customer would mistake for the model's own into the job log
// ("using the 16,000-token fallback"), and a wrong OUTPUT budget is the one
// wrong number that truncates a chapter mid-sentence and bills for the stump.
// There is no published value to stand in for, so the code now says nothing —
// `null` all the way through — and the run either uses the mode's own batch
// size or fails at the first call with GenStudio's real cause.

/**
 * Headroom buffer: tokenizer-vs-word drift, JSON nesting in the prompt, and
 * provider-side stop-token handling all eat real tokens. That reasoning is
 * unchanged — what changed is that a fixed 1,500 tokens is ~9% of a 16k
 * budget and ~1% of a 128k one, so the same absolute number stops being
 * headroom on a large product.
 *
 * Proportional, with the original 1,500 as a FLOOR: drift scales with the
 * size of the thing being estimated, and the floor keeps small products
 * exactly as protected as they were. At the legacy 16,000 cap this returns
 * 1,500 — byte-for-byte the old behaviour.
 */
const SAFETY_MARGIN_FRACTION = 0.09
const SAFETY_MARGIN_FLOOR_TOKENS = 1500

/** Output tokens per English word, measured. An ESTIMATE used to decide how
 *  to SPLIT work — never a ceiling imposed on output, and never converted
 *  into a character or word limit (Khmer and mixed-script text break any
 *  fixed ratio, which is why the 500,000-character cap was removed). */
const OUTPUT_TOKENS_PER_WORD = 1.3

/** Nominal system+user prompt allowance for the fast word-count threshold,
 *  which by design does not have the assembled prompts in hand. The dynamic
 *  check below uses the REAL prompt sizes instead. */
const TYPICAL_PROMPT_TOKENS = 2000

// ── Batch output-token estimate (reservation sizing) ───────────────────────
//
// WHY: an expansion batch used to declare `outputBudget: 'maximum'`, which
// takes the selected product's ENTIRE published ceiling — 128,000 tokens on
// the current default — to generate roughly 8,000. GenStudio settles a
// language job on tokens actually generated, so that never changed the final
// charge. What it did change is the up-front RESERVATION: GenStudio holds
// credits for the requested ceiling while the job runs, so an account near
// empty could be refused for a request that would have been cheap.
//
// So the batch sizes its own request from the work in hand:
//
//     ceil(sum(words per chapter in this batch) × tokens-per-word) + overhead
//
// clamped by the product's published `max_output_tokens` (done downstream in
// output-token-budget.ts, so a small product still cannot be over-asked).
//
// This is an ESTIMATE used to SIZE A REQUEST. It is never a hard limit on
// output, and it is never converted back into a character or word ceiling —
// Khmer and mixed-script narration break any fixed ratio, which is exactly why
// the 500,000-character cap was removed.
//
// GENEROUS BY DESIGN. Under-requesting truncates a chapter mid-sentence and
// costs another request to repair; over-requesting only holds more of the
// balance for the minute or two the job runs. Every constant below leans that
// way: the tokens-per-word figure is nearly double the measured 1.3, the
// overhead is a flat extra 2,048 for JSON scaffolding and chapter titles, and
// a floor stops a tiny batch from asking for a uselessly small number.

/** Tokens per output word for RESERVATION sizing. Deliberately ~1.9× the
 *  measured `OUTPUT_TOKENS_PER_WORD` of 1.3: the measurement is an average,
 *  and a batch that runs long must still fit. */
const BUDGET_TOKENS_PER_WORD = 2.5

/** Flat allowance for the JSON envelope, chapter keys, titles and whatever
 *  formatting the model wraps around the prose. */
const BUDGET_OVERHEAD_TOKENS = 2_048

/** Never request less than this, however small the batch. Matches the
 *  long-form floor in output-token-budget.ts. */
const BUDGET_FLOOR_TOKENS = 8_192

/** Rounded UP to this step — up, never down, so rounding can only add
 *  headroom. */
const BUDGET_ROUNDING_STEP = 256

/**
 * Output tokens to request for one expansion batch.
 *
 * `wordTargets` is the per-chapter word target for every chapter in the batch,
 * so a batch carrying a longer chapter (the `words_per_chapter` override set
 * in outline review) is sized for the chapter it actually holds rather than
 * for an average.
 */
export function batchOutputTokenEstimate(wordTargets: number[]): number {
  const words = wordTargets.reduce((sum, w) => sum + Math.max(0, Number.isFinite(w) ? w : 0), 0)
  const wanted = Math.ceil(words * BUDGET_TOKENS_PER_WORD) + BUDGET_OVERHEAD_TOKENS
  const floored = Math.max(BUDGET_FLOOR_TOKENS, wanted)
  return Math.ceil(floored / BUDGET_ROUNDING_STEP) * BUDGET_ROUNDING_STEP
}

/**
 * The output budget one expansion batch declares.
 *
 * `workload` rather than `maximum`: the number below is what this batch can
 * plausibly generate, and `resolveOutputTokenBudget` still clamps it to the
 * product's published ceiling.
 */
export function batchOutputBudget(
  batch: OutlineEntry[],
  wordsPerChapter: number,
): { tier: 'workload'; minimumTokens: number } {
  return {
    tier: 'workload',
    minimumTokens: batchOutputTokenEstimate(
      batch.map(entry => entry.words_per_chapter || wordsPerChapter),
    ),
  }
}

export function chunkingSafetyMarginTokens(outputTokenCap: number): number {
  return Math.max(SAFETY_MARGIN_FLOOR_TOKENS, Math.ceil(outputTokenCap * SAFETY_MARGIN_FRACTION))
}

/**
 * The product ceiling to budget against, or `null` when GenStudio published
 * none.
 *
 * `null`, never a stand-in number. AGENTS.md: no published value → fail
 * loudly or show nothing. An output ceiling is the worst possible field to
 * guess at, because guessing LOW truncates a chapter mid-sentence and the
 * truncation is discovered after the customer has paid for it.
 *
 * Note the state this function guards is now vanishingly rare by design: the
 * catalogue parser publishes `0` for an unpublished `max_output_tokens` and
 * `prepareChatSubmission` refuses such a product before any request is made,
 * so a run reaching here with nothing has already lost its product entirely.
 */
export function chunkingOutputBudget(productMaxOutputTokens?: number | null): number | null {
  return Number.isInteger(productMaxOutputTokens) && (productMaxOutputTokens as number) >= 1
    ? productMaxOutputTokens as number
    : null
}

/**
 * The word target above which a run cannot fit one call on THIS product.
 *
 * Tracks the selected product instead of a constant: a 16,000-token product
 * still trips at ~9,600 words (essentially the old 9,000), while a
 * 128,000-token product does not trip until ~88,000 — so an 18-chapter,
 * 700-word episode is no longer treated as too big for the model that will
 * actually write it.
 *
 * Floored at the legacy value so a product SMALLER than the old streaming cap
 * can lower the threshold but a bug can never raise it above what the product
 * supports.
 *
 * `null` when the product published no ceiling: there is no threshold to
 * state, and stating one anyway is the invented-number bug.
 */
export function chunkThresholdWords(productMaxOutputTokens?: number | null): number | null {
  const cap = chunkingOutputBudget(productMaxOutputTokens)
  if (cap === null) return null
  const usable = cap - TYPICAL_PROMPT_TOKENS - chunkingSafetyMarginTokens(cap)
  if (usable <= 0) return 1
  return Math.max(1, Math.floor(usable / OUTPUT_TOKENS_PER_WORD))
}

/**
 * Dynamic chunking decision. Returns true when the assembled prompt +
 * projected output would crowd the SELECTED PRODUCT's published output
 * budget. Use ALONGSIDE the word-count threshold above — either signal
 * triggers chunked mode.
 *
 * Estimation:
 *   - Input tokens ≈ chars / 4 (English; safe for prose, slightly
 *     pessimistic for JSON-dense prompts which is what we want here)
 *   - Output tokens ≈ words × 1.3 (English narration, measured)
 *
 * If `(input + output + safety) > budget`, one call can truncate or shrink
 * per-chapter wordcount. Chunked mode is safer.
 *
 * `outputTokenCap` is the product's published `max_output_tokens`, read live
 * from the catalogue. With nothing published there is no budget to measure
 * against, so the answer is an unconditional YES: chunked mode is the safe
 * side of an unknown (it keeps per-chapter resume), and it commits to no
 * number the customer could mistake for the product's own.
 */
export function shouldChunkByBudget(opts: {
  systemPromptChars: number
  userPromptChars: number
  targetWords: number
  outputTokenCap?: number | null
}): boolean {
  const cap = chunkingOutputBudget(opts.outputTokenCap)
  if (cap === null) return true
  const inputTokens = Math.ceil((opts.systemPromptChars + opts.userPromptChars) / 4)
  const outputTokens = Math.ceil(opts.targetWords * OUTPUT_TOKENS_PER_WORD)
  return (inputTokens + outputTokens + chunkingSafetyMarginTokens(cap)) > cap
}

/** Sequential batch size for narrative-mode expansion. Larger batches lose
 *  transition coherence; smaller burns more LLM round-trips for the same
 *  content. 3 is the sweet spot — enough context to write a smooth
 *  transition into chapter K+1, small enough to comfortably fit ~2k tokens
 *  output per call. This is a COHERENCE choice, not a token-cap choice, so a
 *  bigger product does not raise it — see `batchSizeForBudget`. */
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
 *  stays inside the selected product's published output budget. */
const COMPACT_OUTLINE_THRESHOLD = 500

/** Above this chapter count, expansion calls receive a "table of contents"
 *  (titles only) instead of the full outline so the INPUT window stays
 *  manageable. Below this, expansion calls see the whole outline. */
const TOC_MODE_THRESHOLD = 300

/**
 * The selected product's live output budget, and what it implies for chunking.
 *
 * Read from the GenStudio catalogue at run time — never a constant. Resolution
 * is NON-FATAL by design: a catalogue hiccup must not fail a script run here,
 * because the very next call to the product is where the REAL cause surfaces
 * ("the selected GenStudio language product … is not available"), and a
 * duplicate error raised early would only bury it. What resolution must never
 * do is fill the gap with a number: unresolved means `null`, and every
 * consumer below is written to say so rather than to guess.
 */
export interface ChunkingBudget {
  /** The product's published `max_output_tokens`. `null` = nothing published
   *  (or the product could not be read at all). Never a stand-in figure. */
  outputTokenCap: number | null
  /** Words this product can produce in one call, per the same estimate.
   *  `null` whenever `outputTokenCap` is. */
  thresholdWords: number | null
  /** The product the budget came from, or null when it could not be read. */
  productId: string | null
  productName: string | null
}

/** No product in hand — so no cap, no threshold, and no invented substitute
 *  for either. */
function unresolvedChunkingBudget(): ChunkingBudget {
  return {
    outputTokenCap: null,
    thresholdWords: null,
    productId: null,
    productName: null,
  }
}

export async function resolveChunkingBudget(model: string): Promise<ChunkingBudget> {
  try {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) return unresolvedChunkingBudget()
    const [{ listChatModels }, { resolveGenStudioModelId }] = await Promise.all([
      import('./genstudio-client.js'),
      import('../services/genstudio-model-migration.js'),
    ])
    const modelId = resolveGenStudioModelId('chat', model)
    const product = modelId
      ? (await listChatModels(apiKey)).find(candidate => candidate.id === modelId)
      : null
    if (!product) return unresolvedChunkingBudget()
    return {
      outputTokenCap: chunkingOutputBudget(product.max_output_tokens),
      thresholdWords: chunkThresholdWords(product.max_output_tokens),
      productId: product.id,
      productName: product.display_name || product.id,
    }
  } catch {
    return unresolvedChunkingBudget()
  }
}

/**
 * Chapters per expansion call, bounded by what THIS product can actually
 * write in one response.
 *
 * Only ever SHRINKS the mode's batch size. Growing it is a separate,
 * quality-affecting decision: narrative's 3 is a transition-coherence choice
 * (see the constant), not a token-budget one, so a 128,000-token product does
 * not earn bigger narrative batches by arithmetic alone. What a small product
 * DOES earn is protection — asking a 4,096-token product for three 700-word
 * chapters in one call is how a batch comes back truncated.
 *
 * With NO published cap there is no arithmetic to do, so the mode's own batch
 * size stands. That is not a guess about the product: it is the value the mode
 * chose for coherence reasons, applied because nothing published a reason to
 * shrink it.
 */
export function batchSizeForBudget(
  mode: ChunkedMode,
  budget: ChunkingBudget,
  wordsPerChapter: number,
): number {
  const modeSize = mode === 'listicle' ? LISTICLE_BATCH_SIZE : NARRATIVE_BATCH_SIZE
  if (budget.outputTokenCap === null) return modeSize
  const perChapterTokens = Math.max(1, Math.ceil(Math.max(1, wordsPerChapter) * OUTPUT_TOKENS_PER_WORD))
  const usable = budget.outputTokenCap
    - TYPICAL_PROMPT_TOKENS
    - chunkingSafetyMarginTokens(budget.outputTokenCap)
  const fits = Math.floor(usable / perChapterTokens)
  return Math.max(1, Math.min(modeSize, fits))
}

/**
 * One line saying WHY this run chunked, in numbers the owner can check
 * without reading code: the computed total, the product-derived budget it was
 * measured against, and which product published that budget.
 */
export function chunkingTriggerLine(
  params: { totalChapters: number; wordsPerChapter: number; model: string },
  budget: ChunkingBudget,
): string {
  const totalWords = params.totalChapters * params.wordsPerChapter
  const cap = budget.outputTokenCap
  const threshold = budget.thresholdWords
  // Nothing published → the line reports the ABSENCE. It used to name a
  // 16,000-token "fallback" here, which read exactly like a figure GenStudio
  // had published for the model. That is the invented number AGENTS.md bans.
  const source = cap === null
    ? `no published output limit for "${params.model}" — Story Studio states no budget of its own`
    : budget.productId
      ? `${budget.productName} (${cap.toLocaleString()} output tokens)`
      : `an output limit of ${cap.toLocaleString()} tokens`
  const verdict = threshold === null
    ? 'measured against no single-call budget (chunked for per-chapter resume)'
    : totalWords > threshold
      ? `over the ~${threshold.toLocaleString()}-word single-call budget`
      : `within the ~${threshold.toLocaleString()}-word single-call budget (chunked anyway for per-chapter resume)`
  return `[chunked] Trigger: ${params.totalChapters} × ~${params.wordsPerChapter} words ≈ `
    + `${totalWords.toLocaleString()} words, ${verdict}. Budget from ${source}.`
}

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

export interface ChunkedScriptCompletion {
  complete: boolean
  approved: boolean
  has_unified: boolean
  expected: number
  present: number
  missing: number[]
  resumable: boolean
  outline_valid: boolean
}

/**
 * Inspect the durable chapter sources behind a chunked script. A unified
 * narration file alone is not proof of completion: an interrupted expansion
 * can assemble 12 chapters from a 15-chapter outline and still leave a valid
 * looking document on disk.
 *
 * Legacy scripts without a progress sidecar retain the old presence-based
 * contract because there is no trustworthy expected chapter count for them.
 */
export async function inspectChunkedScriptCompletion(
  scriptDir: string,
  episodeId: string,
): Promise<ChunkedScriptCompletion> {
  const unified = resolveReadPath(path.join(scriptDir, `${episodeId}_Script_Narration.md`))
  const hasUnified = chapterFileLooksValid(unified)
  const sidecar = await readSidecar(scriptDir, episodeId)

  if (!sidecar) {
    return {
      complete: hasUnified,
      approved: true,
      has_unified: hasUnified,
      expected: hasUnified ? 1 : 0,
      present: hasUnified ? 1 : 0,
      missing: [],
      resumable: false,
      outline_valid: true,
    }
  }

  const expectedNumbers = Array.from(new Set(
    sidecar.outline
      .map(entry => Number(entry.n))
      .filter(n => Number.isInteger(n) && n > 0),
  )).sort((a, b) => a - b)
  const outlineValid = sidecar.total_chapters > 0
    && expectedNumbers.length === sidecar.total_chapters

  const presentNumbers = new Set<number>()
  let files: string[] = []
  try { files = await fs.readdir(scriptDir) } catch { /* missing directory */ }
  for (const filename of files) {
    const n = matchChapterFile(filename, episodeId)
    if (n === null) continue
    if (chapterFileLooksValid(path.join(scriptDir, filename))) presentNumbers.add(n)
  }

  const missing = expectedNumbers.filter(n => !presentNumbers.has(n))
  const approved = !!sidecar.outline_approved_at
  return {
    // A draft outline supersedes any older narration in this folder. Until
    // the user approves it, those chapter files cannot prove that the current
    // creative plan has been expanded, even when their counts happen to match.
    complete: approved && hasUnified && outlineValid && missing.length === 0,
    approved,
    has_unified: hasUnified,
    expected: sidecar.total_chapters,
    present: expectedNumbers.filter(n => presentNumbers.has(n)).length,
    missing,
    resumable: approved,
    outline_valid: outlineValid,
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
 * Stored on `ChunkedSidecar.generation_params`. Genuine legacy v2 sidecars
 * upgrade with `null`; a v2 marker written by v1.0.817 that already contains
 * the snapshot preserves it. The executor falls back to the request body only
 * when the upgraded value is null.
 */
export interface GenerationParams {
  model: string
  length?: number
  total_words?: number
  words_per_chapter: number
  style?: string
  perspective?: string
  custom_perspective?: string
  character_ids?: string[]
  custom_style_text?: string
  /** v1.0.297 — optional free-text producer guidance (character names,
   *  setting, names to avoid, tone notes). Persisted to the sidecar so a
   *  later expand-chapters run injects the SAME guidance the outline was
   *  built with — keeps ad-hoc names/settings consistent into the body. */
  manual_guidance?: string
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
   *  characters the outline was built with. Genuine legacy v2 sidecars have
   *  no snapshot and upgrade to null; v1.0.817 v2 markers preserve an existing
   *  snapshot. The executor falls back to the request body only when null. */
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
  /** Pre-built system prompt (already includes format role and standards). */
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
  /** Force regenerate from scratch (ignores existing sidecar / chapter files). */
  force?: boolean
  /** v1.0.297 — optional free-text producer guidance, injected verbatim
   *  (high priority) into both the outline and the chapter-expansion
   *  prompts. Lets the user inject ad-hoc direction — specific character
   *  names, a setting, names to AVOID (e.g. "don't use Lyra or Elara") —
   *  without creating formal Character records. Part of the params hash so
   *  editing it busts the outline cache and re-requests fresh. */
  manualGuidance?: string
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
    //
    // `model` is read from `params.model` AFTER `buildOutline` above, not
    // from the snapshot setupChunkedJobContext took before the call — a
    // saved reference `withModelFallback` had to heal is exactly the kind of
    // dead id this record must never re-persist. The sidecar is the
    // operative source a later expand-chapters run reads back (see
    // setupChunkedJobContext's `source: 'sidecar'`), so it must always name
    // the product that actually wrote the outline, never one GenStudio had
    // already retired by the time this run happened.
    generation_params: params.generationParams
      ? { ...params.generationParams, model: params.model }
      : null,
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
  // Record the approval the caller just gave, rather than only letting it past
  // this gate. `auto_approve` used to be consumed here and never written down,
  // so the sidecar stayed `outline_approved_at: null` while expansion ran to
  // completion -- and `verifyChapterExpansion` (which reads that same field)
  // then failed an episode whose ten chapters were all on disk. Two checks
  // asking the same question and disagreeing about the answer.
  //
  // The same stamp already happens in `buildOutlineOnly` for the cached-outline
  // path; this is the branch that reaches expansion without passing through it.
  if (!sidecar.outline_approved_at && opts.auto_approve) {
    sidecar = { ...sidecar, outline_approved_at: new Date().toISOString(), last_updated: new Date().toISOString() }
    await writeSidecar(params.scriptDir, sidecar)
  }

  // Disk verification: the files are authoritative, not chapters_done.
  // A crash can land a chapter file just before its sidecar update; checking
  // only chapters_done would regenerate and overwrite that valid chapter.
  const verifiedDone = new Set<number>()
  for (const entry of sidecar.outline) {
    const n = entry.n
    // resolveReadPath: a legacy episode's chapter may be .docx, not .md —
    // it must still count as done so resume doesn't re-generate it.
    if (chapterFileLooksValid(resolveReadPath(chapterFilePath(params.scriptDir, params.episode_id, n)))) {
      verifiedDone.add(n)
    }
  }
  const recordedDone = [...sidecar.chapters_done].sort((a, b) => a - b)
  const actualDone = Array.from(verifiedDone).sort((a, b) => a - b)
  if (actualDone.length !== recordedDone.length || actualDone.some((n, i) => n !== recordedDone[i])) {
    sidecar = { ...sidecar, chapters_done: actualDone }
    await writeSidecar(params.scriptDir, sidecar)
    job.output_lines.push(`[chunked] Reconciled progress sidecar from disk (${actualDone.length}/${sidecar.total_chapters} chapters).`)
  }

  // Pending = outline slots whose docx isn't on disk, optionally
  // intersected with the caller's selection.
  let pending = sidecar.outline.filter(e => !verifiedDone.has(e.n))
  const recoveryChapters = job.genstudio_chat_recovery === true
    && job.genstudio_chat_recovery_purpose === 'narrative-repair'
    ? job.genstudio_chat_recovery_chapters
    : undefined
  if (recoveryChapters?.length) {
    const wanted = new Set(recoveryChapters)
    pending = sidecar.outline.filter(entry => wanted.has(entry.n))
    if (pending.length !== wanted.size || !job.genstudio_chat_recovery_key) {
      throw new Error('Saved GenStudio repair identity no longer matches the original chapter slots. No replacement provider work was submitted.')
    }
  } else if (opts.chaptersToExpand?.length) {
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

  // Read the SELECTED product's published output limit once, live, and size
  // both the chunking verdict and the batch bound from it. Never a constant.
  const budget = await resolveChunkingBudget(params.model)
  const batchSize = batchSizeForBudget(mode, budget, params.wordsPerChapter)

  // Dispatch to mode-specific expansion.
  if (mode === 'listicle') {
    await expandListicleParallel(job, params, sidecar.outline, pending, sidecar, budget, batchSize)
  } else {
    await expandNarrativeSequential(job, params, sidecar.outline, pending, sidecar, budget, batchSize)
  }

  // Final sidecar sweep.
  const finalSidecar = await readSidecar(params.scriptDir, params.episode_id)
  const written = finalSidecar?.chapters_done.length ?? verifiedDone.size

  // `withModelFallback` may have healed `params.model` mid-run — a saved
  // reference GenStudio no longer resolves. Persist the model that ACTUALLY
  // wrote these chapters back into the sidecar so a later expand-chapters
  // run reads the same live id instead of re-discovering the same dead one.
  // This is how an outline built before a GenStudio catalogue change
  // self-repairs on its next successful run, rather than needing every
  // future expand to re-heal (and re-announce) the same substitution.
  if (finalSidecar?.generation_params && finalSidecar.generation_params.model !== params.model) {
    await writeSidecar(params.scriptDir, {
      ...finalSidecar,
      generation_params: { ...finalSidecar.generation_params, model: params.model },
    })
  }

  return {
    chaptersWritten: written,
    totalBatches: Math.ceil(pending.length / batchSize),
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

/** Batch count for a run whose product budget has not been read (callers that
 *  only need a rough figure). The real count comes from `batchSizeForBudget`. */
export function estimateBatchCount(pending: number, mode: ChunkedMode): number {
  const size = mode === 'listicle' ? LISTICLE_BATCH_SIZE : NARRATIVE_BATCH_SIZE
  return Math.ceil(pending / size)
}

// ── Model fallback ───────────────────────────────────────────────────────
//
// `params.model` traces back to either the caller's live selection or a
// value read off disk — an outline sidecar's `generation_params.model`, or a
// batch preset's saved model (see setupChunkedJobContext in
// generators/episode.ts). Either source can go stale: GenStudio retires and
// re-versions products. setupChunkedJobContext already announces it in the
// job log when the request and the outline snapshot name two DIFFERENT
// models — but when a headless caller (Pipeline's "repair chapters", a
// resumed expansion with nothing new in the request) re-supplies the SAME
// dead id the outline was built with, there is nothing to contrast it
// against, so that check stays silent and the dead id would otherwise reach
// GenStudio unexamined.
//
// This is the actual, authoritative check — GenStudio's live catalogue, read
// at the one place a submission is genuinely about to happen — so it runs
// lazily, only when there is real work to submit. Validating up front (e.g.
// inside setupChunkedJobContext) would mean an extra live-catalog round trip
// on every run even when nothing needs generating, which is both wasteful
// and — since that setup path is shared with pure resume/no-op runs — would
// turn a harmless "nothing to do" outcome into a hard failure whenever the
// catalogue happens to be unreachable.

/**
 * Run one language-product call, healing a model reference GenStudio no
 * longer resolves instead of failing the whole batch/outline on its account.
 *
 * On `GenStudioChatProductUnavailableError` (the dead-id refusal — thrown
 * strictly before any submission, so nothing was charged for the refused
 * attempt), resolves the live default via `resolveDefaultChatModel`, ANNOUNCES
 * the swap in the job log (never a silent substitution — AGENTS.md), updates
 * `params.model` so every later call in this same run uses the healed id
 * directly, and retries ONCE with it.
 *
 * When there is genuinely nothing to heal to — no GenStudio API key, or the
 * live catalogue itself has no usable product — the ORIGINAL refusal is
 * rethrown unchanged. That is the one case that must still hard-fail: Story
 * Studio does not invent a product id to keep a run alive.
 *
 * Any other error (a real network failure, `GenStudioChatIncompleteError`,
 * etc.) passes straight through — this wrapper only ever acts on the one
 * error it names.
 */
async function withModelFallback<T>(
  job: Job,
  params: ChunkedNarrationParams,
  attempt: (model: string) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(params.model)
  } catch (error) {
    if (!(error instanceof GenStudioChatProductUnavailableError)) throw error

    // Listicle batches run several workers concurrently against the same
    // `params`. If a sibling worker already healed this exact dead id (it
    // mutates `params.model` below), just retry with what's there now — no
    // duplicate catalogue lookup, no duplicate log line. `error.modelId` is
    // always the bare GenStudio id (prepareChatSubmission strips the
    // transport prefix before throwing); `params.model` may still carry the
    // `genstudio-chat:` prefix, so both sides are normalised before comparing.
    if (stripGenStudioModelPrefix('chat', params.model) !== error.modelId) {
      return await attempt(params.model)
    }

    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { resolveDefaultChatModel } = await import('../services/genstudio-default-model.js')
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) throw error

    const healed = await resolveDefaultChatModel(apiKey, error.modelId).catch(() => null)
    if (!healed) throw error

    job.output_lines.push(
      `The saved model "${error.modelId}" is no longer available on GenStudio (retired, unpublished, or ` +
      `qualification-only), so the refused attempt made no request and was not charged. Falling back to the ` +
      `currently available "${healed.modelId}" for the rest of this run. Chapters already on disk are kept ` +
      `as-is — regenerate any you want rewritten in the new voice.`,
    )
    params.model = healed.modelId
    return await attempt(params.model)
  }
}

// ── Outline phase ──────────────────────────────────────────────────────────

/**
 * v1.0.145+ — Research-context injection. If the episode has a
 * research.json sidecar (produced by v1.0.142's Research page) and any
 * of its claims have status === 'verified', return a block we append
 * to the outline prompt so the LLM sees the verified facts as binding
 * context.
 *
 * Backward-compatible: when no sidecar exists OR no claims are
 * verified, returns the empty string and the prompt is unchanged —
 * the script generator behaves exactly as it did pre-1.0.145 for
 * every other format.
 *
 * `scriptDir` is `<episode_dir>/<script_subfolder>`, so the episode
 * dir is its parent.
 */
async function loadResearchContextBlock(scriptDir: string, code: string): Promise<string> {
  try {
    const episodeDir = path.dirname(scriptDir)
    const { jsonPath } = await resolveResearchPaths(episodeDir, code)
    const raw = await fs.readFile(jsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as { claims?: Array<{ text: string; status?: string; note?: string }> }
    const verified = (parsed.claims || []).filter(c => c.status === 'verified' && c.text?.trim())
    if (verified.length === 0) return ''
    const bullets = verified.map((c, i) => `${i + 1}. ${c.text}`).join('\n')
    return [
      '',
      '── Verified research facts (use these to anchor outline + script accuracy) ──',
      bullets,
      'These facts were independently researched and confirmed. The episode should be consistent with them throughout — do not contradict, and prefer to reference these specific claims when planning chapter beats.',
      '',
    ].join('\n')
  } catch {
    // ENOENT (no research) or parse error — silent pass-through.
    return ''
  }
}

async function buildOutline(
  job: Job, params: ChunkedNarrationParams, mode: ChunkedMode,
): Promise<OutlineEntry[]> {
  const compact = params.totalChapters > COMPACT_OUTLINE_THRESHOLD
  let prompt = mode === 'listicle'
    ? listicleOutlinePrompt(params, compact)
    : narrativeOutlinePrompt(params, compact)

  // v1.0.145+ — Inject verified research claims when present. Logged
  // so the Jobs panel surfaces "used N research claims" — useful to
  // confirm the wiring is actually firing without rereading the prompt.
  const researchBlock = await loadResearchContextBlock(params.scriptDir, params.episode_id)
  if (researchBlock) {
    prompt += researchBlock
    const claimCount = (researchBlock.match(/^\d+\./gm) || []).length
    job.output_lines.push(`[chunked] Injected ${claimCount} verified research claim(s) into outline prompt.`)
  }

  // Outline is a one-shot non-streaming JSON array call. Use the same
  // system prompt the caller built so the format role is in effect. 100
  // chapters × ~80 words ≈ 11k tokens, and the compact-outline threshold
  // above keeps very large outlines inside whatever the selected product
  // publishes rather than a hardcoded cap.
  const ctx = {
    slug: job.project_slug,
    jobId: job.job_id,
    signal: params.signal,
    ...(job.genstudio_chat_recovery === true && job.genstudio_chat_recovery_purpose === 'outline'
      && job.genstudio_chat_recovery_key
      ? {
          recoverByIdempotencyKey: true,
          idempotencyKey: job.genstudio_chat_recovery_key,
          allowedRecoveryKeys: job.genstudio_chat_recovery_keys,
        }
      : {}),
    requestIdentity: job.genstudio_chat_retry_scope
      ? `${job.project_slug}:manual-retry:${job.genstudio_chat_retry_scope}`
      : undefined,
  }
  const arr = await withModelFallback(job, params, model => callForJsonArray(
    model, params.systemPrompt, prompt, params.apiKeys, ctx,
    outlineOutputContract(params.totalChapters),
  ))

  // Normalise: clamp `n` into 1..totalChapters and drop duplicates.
  // The model occasionally repeats chapter numbers or skips one; we
  // backfill any gaps with placeholder titles to keep the contract
  // (callers expect `outline.length === totalChapters`).
  //
  // THE BACKFILL IS ANNOUNCED, NOT SILENT. `outlineOutputContract` demands
  // exactly `totalChapters` entries, but JSON Schema cannot say "these `n`
  // values are distinct and cover 1..N" — so a response of the right LENGTH
  // with a repeated or out-of-range `n` passes validation and lands here. Every
  // slot it fails to cover becomes a placeholder with no synopsis, beats or
  // hook, which expansion then turns into unanchored filler narration that
  // passes every downstream completion audit (they all measure against this
  // padded array). That is the one way a partial outline can reach disk, so it
  // is named in the job log at the moment it happens, while the outline is
  // still cheap to reject and rebuild.
  const byN = new Map<number, OutlineEntry>()
  const duplicated: number[] = []
  const outOfRange: unknown[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const n = Number(item.n)
    if (!Number.isFinite(n) || n < 1 || n > params.totalChapters) {
      outOfRange.push(item.n)
      continue
    }
    if (byN.has(n)) {
      duplicated.push(n)
      continue
    }
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
  const synthesized: number[] = []
  for (let n = 1; n <= params.totalChapters; n++) {
    const e = byN.get(n)
    if (e) out.push(e)
    else {
      synthesized.push(n)
      out.push({ n, title: `Chapter ${n}` })
    }
  }
  if (synthesized.length) {
    const t = sectionTerms(params)
    job.output_lines.push(
      `[chunked] Outline covered ${byN.size}/${params.totalChapters} ${t.plural.toLowerCase()}. `
      + `Placeholder ${synthesized.length === 1 ? t.singular.toLowerCase() : t.plural.toLowerCase()} `
      + `${synthesized.join(', ')} had no plan and will expand as unanchored filler — `
      + `rebuild the outline before expanding, or edit ${synthesized.length === 1 ? 'it' : 'them'} in the outline review.`
      + (duplicated.length ? ` The model repeated ${t.singular.toLowerCase()} number(s) ${[...new Set(duplicated)].join(', ')}.` : '')
      + (outOfRange.length ? ` It also returned ${outOfRange.length} entr${outOfRange.length === 1 ? 'y' : 'ies'} numbered outside 1-${params.totalChapters}.` : ''),
    )
  }
  return out
}

function sectionTerms(p: ChunkedNarrationParams): { Singular: string; Plural: string; singular: string; plural: string } {
  const Singular = p.format.script.sectionLabel?.singular || 'Chapter'
  const Plural = p.format.script.sectionLabel?.plural || 'Chapters'
  return { Singular, Plural, singular: Singular.toLowerCase(), plural: Plural.toLowerCase() }
}

/**
 * v1.0.297 — render the optional producer-guidance block. Injected verbatim
 * into both the outline and the chapter-expansion prompts so ad-hoc direction
 * (character names, setting, names to avoid) shapes BOTH the structure and the
 * body, not just the outline titles. Returns '' when no guidance is set, so
 * existing behaviour is byte-for-byte unchanged for users who don't use it.
 *
 * Phrased as "binding, over generic defaults" because the whole point is to
 * override the model's tendency to reach for the same handful of names/settings
 * across a long-running channel.
 */
export function producerNotesBlock(manualGuidance?: string): string {
  const g = manualGuidance?.trim()
  if (!g) return ''
  return `\nPRODUCER NOTES (binding — follow these over any generic default. If they name specific characters, places, or names to AVOID, honour them exactly):\n${g}\n`
}

function narrativeOutlinePrompt(p: ChunkedNarrationParams, compact: boolean): string {
  const t = sectionTerms(p)
  const fieldHint = compact
    ? `Each entry: { "n": <int>, "title": "...", "hook_line": "1-line hook" }`
    : `Each entry: { "n": <int>, "title": "...", "synopsis": "~30 words", "key_beats": ["beat 1", "beat 2", "beat 3"] }`
  return `Plan the ${t.singular.toLowerCase()} structure for an episode I'm about to write. Output ONLY one JSON object with a "chapters" array containing exactly ${p.totalChapters} ${t.singular.toLowerCase()} entries — no preamble, no markdown, no code fences.

Episode title: ${p.title}
Format: ${p.format.name}
Target ${t.plural}: ${p.totalChapters}
Per-${t.singular.toLowerCase()} target: ~${p.wordsPerChapter} words
${producerNotesBlock(p.manualGuidance)}
PACING ARC TO COVER (apply across the ${p.totalChapters} ${t.plural}):
${p.format.script.pacingArc.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

${fieldHint}

Cover the full ${p.totalChapters}-${t.singular.toLowerCase()} arc. Distinct titles, clear progression, no repeated subjects, no filler ${t.plural}. The sequence as a whole should read as a coherent episode arc — ${t.singular} 1 hook, middle development, ${t.singular} ${p.totalChapters} resolution.

COMMIT TO SPECIFICS at outline time. When the pacing arc above asks for a SPECIFIC item (a scripture verse, a court case, a famous quote, a named person, a specific date, a particular study), NAME that specific item in the synopsis or in one of the key_beats. Don't be vague:
  - BAD: "Invoke a scriptural promise for assurance."
  - GOOD: "Cite Lamentations 3:22-23 as the anchor verse: 'His mercies are new every morning.'"
  - BAD: "Reference a relevant unsolved case."
  - GOOD: "Center on the 1971 D.B. Cooper hijacking — money never recovered."
Specific commitments at outline time let the user review and swap items before chapter expansion (which is expensive). If any avoidance list is in effect for this channel (see the additional rules above), respect it AT OUTLINE TIME — pick a fresh item now, don't defer the choice to expansion.

Output: { "chapters": [ {"n":1, ...}, {"n":2, ...}, ..., {"n":${p.totalChapters}, ...} ] }`
}

function listicleOutlinePrompt(p: ChunkedNarrationParams, compact: boolean): string {
  const t = sectionTerms(p)
  // For independent-chapters formats the "topic" wording was format-
  // hardcoded; we now route through the format's term ("Topic" for
  // listicle, "Reason" for bound-explainer, etc.) so the LLM produces
  // matching headings naturally.
  // The key is "title", not "topic_title". `outlineOutputContract` requires
  // `title` under `additionalProperties: false`, so the old `topic_title`
  // asked the model for a shape this workflow is guaranteed to reject —
  // every compact listicle outline (totalChapters > COMPACT_OUTLINE_THRESHOLD)
  // that obeyed the prompt failed local validation twice over, for a missing
  // required key and an unexpected one. The format's own term still shapes the
  // headings through `sectionTerms`; only the JSON key is fixed.
  const fieldHint = compact
    ? `Each entry: { "n": <int>, "title": "...", "hook_line": "1-line hook" }`
    : `Each entry: { "n": <int>, "title": "...", "hook_line": "1-line hook", "key_facts": ["fact 1", "fact 2", "fact 3"] }`
  return `Plan a listicle / explainer episode. Output ONLY one JSON object with a "chapters" array containing exactly ${p.totalChapters} ${t.singular.toLowerCase()} entries — no preamble, no markdown, no code fences.

Episode title: ${p.title}
Format: ${p.format.name}
Target ${t.plural}: ${p.totalChapters}
Per-${t.singular.toLowerCase()} target: ~${p.wordsPerChapter} words
${producerNotesBlock(p.manualGuidance)}
${fieldHint}

Each ${t.singular.toLowerCase()} must be SELF-CONTAINED (a viewer dropping in mid-video must understand it without prior context). ${t.Plural} should be DISTINCT — different subjects, no overlap. Cover the breadth of the title's promise.

Output: { "chapters": [ {"n":1, ...}, {"n":2, ...}, ..., {"n":${p.totalChapters}, ...} ] }`
}

// ── Narrative expansion (sequential batches with transition glue) ──────────

async function expandNarrativeSequential(
  job: Job, params: ChunkedNarrationParams,
  outline: OutlineEntry[], pending: OutlineEntry[], sidecar: ChunkedSidecar,
  budget: ChunkingBudget = unresolvedChunkingBudget(),
  batchSize: number = NARRATIVE_BATCH_SIZE,
): Promise<void> {
  // Group pending into contiguous batches so we can pull a clean transition
  // window (last 200 words of the chapter before the batch's first slot) when
  // one exists on disk.
  const batches: OutlineEntry[][] = []
  for (let i = 0; i < pending.length; i += batchSize) {
    batches.push(pending.slice(i, i + batchSize))
  }

  job.output_lines.push(`[chunked] Mode: narrative (sequential, batches of ${batchSize}). ${batches.length} batch(es) to run.`)
  job.output_lines.push(chunkingTriggerLine(params, budget))

  let runningSidecar = sidecar
  for (let bi = 0; bi < batches.length; bi++) {
    if (params.isCancelled?.()) {
      job.output_lines.push(`[chunked] Cancelled by user before batch ${bi + 1}/${batches.length}.`)
      throw new Error('Cancelled by user')
    }
    const batch = batches[bi]!
    const firstN = batch[0]!.n
    const lastN = batch[batch.length - 1]!.n

    const useTOC = params.totalChapters > TOC_MODE_THRESHOLD
    const prompt = narrativeBatchPrompt(
      params, outline, batch, await narrativeTransitionWindow(params, firstN), useTOC,
    )

    job.output_lines.push(`[chunked] Batch ${bi + 1}/${batches.length} — chapters ${firstN}-${lastN}…`)
    // A batch is several full chapters of narration in one response, and it
    // must never be cut off — a truncated batch is a half-written chapter and
    // the repair pass below costs another request. It used to ask for the
    // product's whole ceiling to guarantee that. It now asks for what THIS
    // batch can plausibly generate (see batchOutputTokenEstimate), which is
    // still generous but no longer reserves 128,000 credits' worth of headroom
    // to write 8,000 tokens.
    const ctx = {
      slug: job.project_slug, jobId: job.job_id, signal: params.signal,
      outputBudget: batchOutputBudget(batch, params.wordsPerChapter),
      // Only queue-level manual Retry can stamp this server-owned scope after
      // a known terminal GenStudio chat job. Normal runs and paused/resumed
      // jobs leave it absent so lost-response recovery replays the same key.
      requestIdentity: job.genstudio_chat_retry_scope
        ? `${job.project_slug}:manual-retry:${job.genstudio_chat_retry_scope}`
        : undefined,
      recoverByIdempotencyKey: job.genstudio_chat_recovery === true
        && job.genstudio_chat_recovery_purpose !== 'narrative-repair',
      allowedRecoveryKeys: job.genstudio_chat_recovery_keys,
    }
    const recoveryChapters = job.genstudio_chat_recovery === true
      && job.genstudio_chat_recovery_purpose === 'narrative-repair'
      ? job.genstudio_chat_recovery_chapters
      : undefined
    if (recoveryChapters?.length) {
      const repairBatch = batch.filter(entry => recoveryChapters.includes(entry.n))
      if (repairBatch.length !== recoveryChapters.length || !job.genstudio_chat_recovery_key) {
        throw new Error('Saved GenStudio repair identity no longer matches the pending chapter slots. No replacement provider work was submitted.')
      }
      const repairPrompt = narrativeRepairPrompt(
        params, outline, repairBatch, await narrativeTransitionWindow(params, repairBatch[0]!.n), useTOC,
      )
      const recoveredRepairText = await withModelFallback(job, params, model => callAiWithRetry(
        model, params.systemPrompt, repairPrompt, params.apiKeys, true, {
          ...ctx,
          recoverByIdempotencyKey: true,
          idempotencyKey: job.genstudio_chat_recovery_key,
          allowedRecoveryKeys: job.genstudio_chat_recovery_keys,
        },
      ))
      const repaired = await parseAndWriteBatch(params, repairBatch, recoveredRepairText)
      runningSidecar = markDone(runningSidecar, repaired)
      await writeSidecar(params.scriptDir, runningSidecar)
      const stillMissing = repairBatch.filter(entry => !repaired.includes(entry.n)).map(entry => entry.n)
      if (stillMissing.length) {
        throw new Error(`Recovered GenStudio repair did not contain chapters ${stillMissing.join(', ')}. No replacement provider work was submitted.`)
      }
      job.output_lines.push(`[chunked]   → recovered repair wrote ${repaired.length} chapter(s) (${repaired.join(', ')})`)
      continue
    }
    let wrote: number[] = []
    let incomplete: GenStudioChatIncompleteError | null = null
    try {
      const text = await withModelFallback(job, params, model =>
        callAiWithRetry(model, params.systemPrompt, prompt, params.apiKeys, true, ctx))
      wrote = await parseAndWriteBatch(params, batch, text)
    } catch (error) {
      if (!(error instanceof GenStudioChatIncompleteError)) throw error
      incomplete = error
      if (error.partialText.trim()) {
        wrote = await parseAndWriteBatch(params, batch, error.partialText)
      }
      job.output_lines.push(
        `[chunked]   → GenStudio reported incomplete output${error.finishReason ? ` (${error.finishReason})` : ''}; ` +
        `preserved ${wrote.length} parsed chapter(s) and released the original reservation.`,
      )
    }

    runningSidecar = markDone(runningSidecar, wrote)
    await writeSidecar(params.scriptDir, runningSidecar)
    job.output_lines.push(`[chunked]   → wrote ${wrote.length} chapter(s) (${wrote.join(', ')})`)

    // A normal provider finish can still omit a requested block. For a
    // provider-declared incomplete finish, replace the entire affected batch:
    // its uncharged partial output is preserved for audit, but is never proof
    // that a customer-facing batch completed. This is one deliberate, bounded
    // repair submission—not the queue's generic auto-retry policy.
    const repairBatch = incomplete
      ? batch
      : batch.filter(entry => !wrote.includes(entry.n))
    if (!repairBatch.length) continue

    job.output_lines.push(
      `[chunked]   → repairing chapters ${repairBatch.map(entry => entry.n).join(', ')} ` +
      `(one bounded ${incomplete ? 'replacement' : 'missing-chapter'} pass)…`,
    )
    const effectiveRepairBatch = repairBatch
    const repairPrompt = narrativeRepairPrompt(
      params,
      outline,
      effectiveRepairBatch,
      await narrativeTransitionWindow(params, effectiveRepairBatch[0]!.n),
      useTOC,
    )
    const repairText = await withModelFallback(job, params, model => callAiWithRetry(
      model, params.systemPrompt, repairPrompt, params.apiKeys, true, ctx,
    ))
    const repaired = await parseAndWriteBatch(params, effectiveRepairBatch, repairText)
    const allWrote = [...new Set([...wrote, ...repaired])].sort((a, b) => a - b)
    runningSidecar = markDone(runningSidecar, repaired)
    await writeSidecar(params.scriptDir, runningSidecar)
    job.output_lines.push(`[chunked]   → repair wrote ${repaired.length} chapter(s) (${repaired.join(', ')})`)

    const stillMissing = batch.filter(entry => !allWrote.includes(entry.n)).map(entry => entry.n)
    if (stillMissing.length) {
      throw new Error(
        `Narrative batch did not pass its one-repair completion check; missing ${stillMissing.join(', ')}. ` +
        'Resume expansion to repair it.',
      )
    }
  }
}

async function narrativeTransitionWindow(
  params: ChunkedNarrationParams, firstChapterN: number,
): Promise<string> {
  const priorChapterN = firstChapterN - 1
  if (priorChapterN < 1) return ''
  const priorPath = resolveReadPath(chapterFilePath(params.scriptDir, params.episode_id, priorChapterN))
  if (!existsSync(priorPath)) return ''
  try {
    const { narrationDocxToMarkdown } = await import('./docx-parser.js')
    const md = await narrationDocxToMarkdown(priorPath)
    const body = md.replace(/^##[^\n]*\n+/, '').trim()
    const words = body.split(/\s+/)
    return words.slice(Math.max(0, words.length - 200)).join(' ')
  } catch {
    return ''
  }
}

function narrativeRepairPrompt(
  p: ChunkedNarrationParams, outline: OutlineEntry[], batch: OutlineEntry[],
  transitionWindow: string, useTOC: boolean,
): string {
  return `${narrativeBatchPrompt(p, outline, batch, transitionWindow, useTOC)}

RECOVERY INSTRUCTION: This is one bounded repair pass. Write every requested chapter in this response, and write no chapters outside the requested slots.`
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
  const t = sectionTerms(p)

  const slots = batch.map((e, i) => {
    const beats = e.key_beats?.length ? `\n   Key beats: ${e.key_beats.map(b => `"${b}"`).join('; ')}` : ''
    const synopsis = e.synopsis ? `\n   Synopsis: ${e.synopsis}` : ''
    const lengthHint = uniform ? '' : `\n   Length: ~${targets[i]} words.`
    return `  ${t.Singular} ${e.n}: ${e.title}${synopsis}${beats}${lengthHint}`
  }).join('\n\n')

  const transitionBlock = transitionWindow
    ? `\nPREVIOUS ${t.Singular.toUpperCase()} TAIL (your tone + scene must flow on from this — DO NOT recap, just continue):\n${transitionWindow}\n`
    : ''

  // Top-line target. For uniform batches: explicit number. For mixed:
  // describe the default + point at per-slot Length: lines.
  const targetLine = uniform
    ? `Per-${t.singular} target: ${targets[0]} words`
    : `Per-${t.singular} target: see Length: line on each slot below (default ${p.wordsPerChapter} words)`

  // Output template lengths follow the same pattern.
  const tmplLen = (i: number) => uniform ? `~${targets[0]} words` : `~${targets[i] ?? p.wordsPerChapter} words`

  return `Write ${batch.length} ${t.singular}(s) of an in-progress episode. You're expanding ONLY the slots listed below — the full arc is shown for context.

Episode title: ${p.title}
Format: ${p.format.name}
${targetLine}
${producerNotesBlock(p.manualGuidance)}
${outlineBlock}
${transitionBlock}
SLOTS TO WRITE NOW:

${slots}

Output the ${t.plural} in this exact format (and ONLY these ${t.plural}, in numeric order):

## ${t.Singular} ${batch[0]!.n.toString().padStart(2, '0')}: ${batch[0]!.title}

[${tmplLen(0)} of body text]

## ${t.Singular} ${batch[1]?.n.toString().padStart(2, '0') ?? batch[0]!.n.toString().padStart(2, '0')}: ${batch[1]?.title ?? '...'}

[${tmplLen(1)} of body text]

${batch.length > 2 ? `## ${t.Singular} ${batch[2]!.n.toString().padStart(2, '0')}: ${batch[2]!.title}\n\n[${tmplLen(2)} of body text]` : ''}

Rules:
- Write ALL ${batch.length} ${t.plural} in this single response. Do not stop early.
- Use the ${t.singular} numbers and titles EXACTLY as shown.
- ${uniform
  ? `Each ${t.singular} is ~${targets[0]} words of body. No meta-commentary, no preamble.`
  : `Each ${t.singular} hits its OWN word target (see slot Length: lines). No meta-commentary, no preamble.`}
- Maintain the format's tone consistently with the rest of the episode.

Output ONLY the ${t.singular} blocks above.`
}

// ── Listicle expansion (parallel batches) ──────────────────────────────────

async function expandListicleParallel(
  job: Job, params: ChunkedNarrationParams,
  outline: OutlineEntry[], pending: OutlineEntry[], sidecar: ChunkedSidecar,
  budget: ChunkingBudget = unresolvedChunkingBudget(),
  batchSize: number = LISTICLE_BATCH_SIZE,
): Promise<void> {
  const batches: OutlineEntry[][] = []
  for (let i = 0; i < pending.length; i += batchSize) {
    batches.push(pending.slice(i, i + batchSize))
  }
  job.output_lines.push(
    `[chunked] Mode: listicle (parallel, batches of ${batchSize}, concurrency ${LISTICLE_CONCURRENCY}). ${batches.length} batch(es) to run.`,
  )
  job.output_lines.push(chunkingTriggerLine(params, budget))

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
        // Same as the narrative batch: several complete items per response,
        // sized from the batch's own word targets rather than from the
        // product's whole published ceiling.
        const ctx = {
          slug: job.project_slug, jobId: job.job_id, signal: params.signal,
          outputBudget: batchOutputBudget(batch, params.wordsPerChapter),
          // See narrative expansion above: this exists only for a deliberate
          // replacement after terminal GenStudio evidence, never for resume.
          requestIdentity: job.genstudio_chat_retry_scope
            ? `${job.project_slug}:manual-retry:${job.genstudio_chat_retry_scope}`
            : undefined,
          recoverByIdempotencyKey: job.genstudio_chat_recovery === true,
          allowedRecoveryKeys: job.genstudio_chat_recovery_keys,
        }
        const text = await withModelFallback(job, params, model =>
          callAiWithRetry(model, params.systemPrompt, prompt, params.apiKeys, true, ctx))
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
  const t = sectionTerms(p)

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
    return `  ${t.Singular} ${e.n}: ${e.title}${hook}${facts}${perSlotBudget}`
  }).join('\n\n')

  // Length / budget block. When uniform, one block covers all slots. When
  // mixed, this block describes the DEFAULT and the per-slot lines
  // override on a case-by-case basis.
  const { target, minFloor, maxCeiling, hookWords, payoffWords, bodyWords, beatCount, wordsPerBeat } = globalBudget
  const upperSingular = t.Singular.toUpperCase()
  const lengthHeader = uniform
    ? `PER-${upperSingular} LENGTH (binding, not a hint):
- Target: ${target} words.
- Minimum: ${minFloor} words. Drafts shorter than this are unusable — DO NOT ship a stub.
- Maximum: ${maxCeiling} words.

WORD BUDGET (how to spend the ${target} words inside one ${t.singular}):
- Hook (open):  ~${hookWords} words — one provocative claim, counter-intuitive question, or sharp image.
- Body (${beatCount} supporting beats): ~${bodyWords} words total, ~${wordsPerBeat} words each — cite mechanism, evidence, history, or concrete specifics. Each beat earns its own paragraph.
- Micro-payoff (close): ~${payoffWords} words — memorable line, open question, or wry beat.`
    : `PER-${upperSingular} LENGTH (binding, not a hint):
- Each ${t.singular} has its OWN word target — see the Length: line on each slot below. Treat that target as the binding minimum + maximum (90%–115% range).
- Default for slots without an explicit Length: ${target} words.

WORD BUDGET (how to spend each slot's target inside one ${t.singular}):
- Hook (open):  ~12% of the slot's target — one provocative claim, counter-intuitive question, or sharp image.
- Body (3–6 supporting beats, scaled to length): ~76% of the slot's target — cite mechanism, evidence, history, or concrete specifics. Each beat earns its own paragraph.
- Micro-payoff (close): ~12% of the slot's target — memorable line, open question, or wry beat.`

  return `Write ${batch.length} ${t.singular}(s) of an in-progress listicle / explainer episode. Each ${t.singular} is INDEPENDENT — no transitions, no references to other ${t.plural}.

Episode title: ${p.title}
Format: ${p.format.name}
${producerNotesBlock(p.manualGuidance)}
${lengthHeader}

SLOTS TO WRITE:

${slots}

Output the ${t.plural} in this exact format (and ONLY these ${t.plural}, in numeric order):

## ${t.Singular} ${batch[0]!.n.toString().padStart(2, '0')}: ${batch[0]!.title}

<full body ${uniform ? `of ${minFloor}-${maxCeiling} words` : `at the slot's target`}, structured as hook → ${uniform ? `${beatCount} beats` : `3-6 beats (scale to length)`} → payoff>

## ${t.Singular} ${batch[1]?.n.toString().padStart(2, '0') ?? ''}: ${batch[1]?.title ?? ''}

<full body ${uniform ? `of ${minFloor}-${maxCeiling} words` : `at the slot's target`}, structured as hook → ${uniform ? `${beatCount} beats` : `3-6 beats (scale to length)`} → payoff>

(continue for all ${batch.length} ${t.plural})

Rules:
- Write ALL ${batch.length} ${t.plural} in this single response.
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

/**
 * Read + auto-upgrade a sidecar from disk. Exported so routes can validate
 * sidecar contents (mode, total_chapters, approval state) without
 * reaching for a chapter-specific lookup as a proxy. Returns null when
 * the file is missing, unreadable, or carries an unknown schema_version.
 */
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
        episode_id,
        schema_version: 3,
        outline_approved_at: parsed.outline_completed_at || null,
        outline_edited_at: null,
        generation_params: null,
      } as ChunkedSidecar
    }
    if (parsed?.schema_version === 2) {
      return {
        ...parsed,
        episode_id,
        schema_version: 3,
        generation_params: parsed.generation_params ?? null,
      } as ChunkedSidecar
    }
    if (parsed?.schema_version === 3) {
      // Episode renumbering changes the filename but older releases left the
      // embedded id untouched. Normalize it on read so the next progress
      // write cannot recreate the old-code sidecar beside the renamed one.
      return { ...parsed, episode_id } as ChunkedSidecar
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

/**
 * v1.0.269 — bring-your-own outline. Write an APPROVED v3 sidecar from a
 * user-supplied chapter list (no LLM, no prior sidecar required), so the user
 * can paste an outline and run Expand Chapters straight away. `generation_params`
 * is left null on purpose — the expand-chapters executor then uses the model /
 * words from its own request body.
 */
export async function writeImportedOutline(
  scriptDir: string,
  episode_id: string,
  outline: Array<{ title: string; synopsis?: string }>,
  opts: { mode?: ChunkedMode } = {},
): Promise<ChunkedSidecar> {
  const now = new Date().toISOString()
  const entries: OutlineEntry[] = outline.map((o, i) => ({
    n: i + 1,
    title: (o.title || `Chapter ${i + 1}`).trim(),
    ...(o.synopsis?.trim() ? { synopsis: o.synopsis.trim() } : {}),
  }))
  const sidecar: ChunkedSidecar = {
    schema_version: 3,
    episode_id,
    mode: opts.mode || 'narrative',
    total_chapters: entries.length,
    outline: entries,
    outline_completed_at: now,
    outline_approved_at: now,   // imported outlines are pre-approved
    outline_edited_at: now,
    generation_params: null,
    chapters_done: [],
    params_hash: '',
    last_updated: now,
  }
  await writeSidecar(scriptDir, sidecar)
  return sidecar
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
    chars: (p.characters || []).map(c => c.id).sort(),
    // v1.0.297 — editing the producer guidance must bust the cached outline
    // so "re-request with different names" actually regenerates. Added
    // CONDITIONALLY (only when guidance is set) so episodes with no guidance
    // hash byte-for-byte identically to pre-v1.0.297 — existing approved
    // outlines stay cached and are NOT needlessly rebuilt on upgrade.
    ...(p.manualGuidance?.trim() ? { g: p.manualGuidance.trim() } : {}),
  })
  return createHash('sha256').update(blob).digest('hex').slice(0, 16)
}

// ── JSON-array call helper with retry ──────────────────────────────────────

async function callForJsonArray(
  model: string, system: string, user: string,
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string },
  ctx: {
    signal?: AbortSignal
    slug?: string
    jobId?: string
    recoverByIdempotencyKey?: boolean
    idempotencyKey?: string
    allowedRecoveryKeys?: string[]
  },
  outputContract: TextOutputContract,
  retries = 2,
): Promise<any[]> {
  let lastErr = ''
  const effectiveRetries = isLocalTextModel(model) ? retries : 0
  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled by user')
    const raw = await callAiWithRetry(model, system, user, apiKeys, false, {
      ...ctx,
      outputContract,
      // Long: one structured entry per chapter for the whole episode. Shorter
      // than the narration itself, but far past the short-form default.
      outputBudget: 'long',
      disableReasoning: true,
      temperature: 0.25,
    })
    try {
      const parsed = parseStructuredJson(raw)
      const chapters = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as any)?.chapters)
          ? (parsed as any).chapters
          : null
      if (chapters) return chapters
      // Name the shape that came back. A contract mismatch already arrives
      // with a path and a reason from `explainJsonSchemaMismatch` (it is
      // thrown by `callAiWithRetry`, outside this try); this branch is the one
      // remaining local rejection on the outline path, so it says as much.
      lastErr = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? `the JSON object has no "chapters" array (present: ${JSON.stringify(Object.keys(parsed as object))})`
        : `expected a JSON object with a "chapters" array, got ${parsed === null ? 'null' : typeof parsed}`
    } catch (e: any) {
      lastErr = e?.message || String(e)
    }
  }
  throw new Error(`Outline JSON parse failed after ${effectiveRetries + 1} attempt(s): ${lastErr}`)
}
