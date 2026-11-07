/**
 * Scene prompts are structured, long-form outputs. The input context may be
 * very large, but the safe number of scenes in one response is determined by
 * the model's published output allowance, not its context window.
 *
 * EVERYTHING HERE DERIVES FROM THE SELECTED MODEL.
 * ----------------------------------------------------------------------
 * This module used to carry a fixed option set — 4,096 … 32,768 — and clamp
 * every request with `Math.min(32_768, …)`. That silently capped Scene Plan at
 * 32,768 output tokens even when the chosen GenStudio product published
 * 128,000, so the largest models could not be used at their published size and
 * batches were smaller than they needed to be.
 *
 * The option ladder is now GENERATED from the product's live
 * `max_output_tokens`, and the product's own number is always offered as the
 * top choice. A product that publishes no ceiling has no ladder; its request
 * omits the output limit. No allowance, context window, or model name is hardcoded.
 *
 * The SAME MISTAKE was made a second time, in the batch sizer below, and lived
 * until 2026-08-28 — see the note above `SCENE_PROMPT_PACK_MIN`. That one hurt
 * more, because the clamp sat directly on top of a correct derivation and the
 * Scene Plan panel advertised the derivation as the thing it was doing.
 */
import { boundOutputTokensToContext } from './output-token-budget.js'

export type ScenePromptPackSize = number
export type ScenePromptPackSetting = 'auto' | ScenePromptPackSize
/** 'auto' = the selected product's published maximum when one exists; a number
 * is an explicit allowance, clamped only when that product publishes a maximum. */
export type ScenePromptTokenSetting = 'auto' | number

export const SCENE_PROMPT_PACK_MIN = 1

/**
 * Story Studio's own output budget for a MODEL-FREE deterministic timeline run.
 *
 * THIS IS NOT A MODEL ALLOWANCE, and nothing may present it as one.
 *
 * A timeline-only Scene Plan run deliberately has no selected model (`needsModel`
 * is false, the engine is `deterministic-timeline`) and makes no GenStudio
 * request, so there is no published figure to read. This value sizes local work
 * only, and the line that prints a model's token arithmetic is guarded by
 * `!timelineOnly`, so it can never be read as the model's own.
 *
 * It exists because the resolvers below still need a local-only value when
 * there is no selected model. Before 2026-09-18 they silently substituted
 * 8,192 for both that case and a selected product with no published allowance,
 * conflating two different facts into one value. A model-free run may use this
 * local budget; a selected no-ceiling product must instead omit the request
 * field. Sharing a number between them is the defect, not the fix.
 */
export const SCENE_TIMELINE_ONLY_OUTPUT_BUDGET = 8_192

/**
 * WHY THERE IS NO `SCENE_PROMPT_PACK_MAX` ANY MORE.
 * ----------------------------------------------------------------------
 * There used to be one, fixed at 50, and `maxSafeScenePromptPackSize` ended
 * with `Math.min(SCENE_PROMPT_PACK_MAX, …)`. That clamp bound for every model
 * publishing 20,000 output tokens or more — i.e. every serious model — so the
 * derivation below computed a correct number and then threw it away, and the
 * panel's "Model-aware" badge was false. Measured against 85,411 real scene
 * prompts (447 episodes, 8 channels), one emitted scene object costs a median
 * 149 tokens, p90 229, p95 260, p99 330, worst-ever 561. Fifty scenes is 3% of
 * a 384,000-token allowance. The cap was never protecting anything.
 *
 * What replaces it is the owner's own two-field pattern: an ALLOWANCE he edits
 * (`ScenePromptPackTuning`, persisted in project config) and a dial with no
 * code maximum. Nothing in this module may reintroduce a hardcoded ceiling.
 */

/**
 * The three numbers behind batch sizing, all owner-editable per project.
 *
 * `tokensPerScene` is NOT a measured average — it is deliberately pessimistic.
 * 300 sits between the measured p95 (260) and p99 (330), and combined with a
 * 0.75 safety fraction it reserves ~400 tokens per scene, above the p99 and
 * within 30% of the worst single scene ever written.
 */
export interface ScenePromptPackTuning {
  /** Tokens reserved per emitted scene object. Project key: `scene_prompt_tokens_per_scene`. */
  tokensPerScene: number
  /** Fraction of the model's published output allowance the sizer will use.
   *  Project key: `scene_prompt_output_safety_fraction`. */
  safetyFraction: number
  /**
   * The default effective batch when "Automatic" is chosen. Project key:
   * `scene_prompt_batch_size`.
   *
   * 250 IS A THROUGHPUT JUDGEMENT, NOT A TOKEN LIMIT. The token arithmetic
   * alone permits ~960 scenes on a 384,000-token model (15% of the allowance
   * is used at 250, so there is 6.6x headroom at p90 and the worst scene ever
   * recorded would still fit inside 21%). What actually binds is wall-clock:
   * how long one request may run, and how fast the chosen provider writes.
   * The real sustained throughput of the large models is UNVERIFIED, so 250
   * is the largest batch that is comfortable at an unknown speed. It cuts
   * requests across the owner's library from 1,951 to 591.
   *
   * NEITHER HALF OF THAT WALL-CLOCK SUM IS FIXED ANY MORE (2026-08-29). The
   * request timeout is `genstudio_language_timeout_minutes` in app settings,
   * default 30 minutes, and the owner may dial it. The speed floor is
   * `LANGUAGE_MIN_ACCEPTABLE_TOKENS_PER_SECOND`, 50. This comment deliberately
   * quotes neither number: it stated "20 minutes" for four weeks after nothing
   * guaranteed that, and a second copy of a figure is how it goes stale. The
   * Scene Plan panel does the arithmetic live from both and warns when the
   * chosen batch does not fit.
   *
   * RAISE THIS once throughput is measured — `completionTokens` is now logged
   * with each successful pack precisely so that question is answerable from
   * data instead of estimated again.
   */
  batchSize: number
}

export const SCENE_PROMPT_PACK_TUNING_DEFAULTS: Readonly<ScenePromptPackTuning> = Object.freeze({
  tokensPerScene: 300,
  safetyFraction: 0.75,
  batchSize: 250,
})

/** The two ladder seeds. Doubling each of them and merging reproduces the
 *  historical 4,096 / 6,144 / 8,192 / 12,288 / 16,384 / 24,576 / 32,768 steps
 *  and keeps going for as long as the selected product allows. */
const TOKEN_LADDER_SEEDS = [4096, 6144] as const

/**
 * Read the owner's tuning out of a project config object. Every field is
 * independent: an absent or unusable one falls back to its own default and
 * leaves the others alone. There is deliberately no upper bound on any of
 * them — see the note above `SCENE_PROMPT_PACK_MIN`.
 */
export function parseScenePromptPackTuning(config: unknown): ScenePromptPackTuning {
  const source = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>
  const tokensPerScene = Number(source.scene_prompt_tokens_per_scene)
  const safetyFraction = Number(source.scene_prompt_output_safety_fraction)
  const batchSize = Number(source.scene_prompt_batch_size)
  return {
    tokensPerScene: Number.isFinite(tokensPerScene) && tokensPerScene >= 1
      ? tokensPerScene : SCENE_PROMPT_PACK_TUNING_DEFAULTS.tokensPerScene,
    // A fraction above 1 would ask for more than the model publishes, which
    // `resolveScenePromptTokenBudget` would clip anyway; 0 would make every
    // batch a single scene. Anything inside (0, 1] is the owner's business.
    safetyFraction: Number.isFinite(safetyFraction) && safetyFraction > 0 && safetyFraction <= 1
      ? safetyFraction : SCENE_PROMPT_PACK_TUNING_DEFAULTS.safetyFraction,
    batchSize: Number.isInteger(batchSize) && batchSize >= SCENE_PROMPT_PACK_MIN
      ? batchSize : SCENE_PROMPT_PACK_TUNING_DEFAULTS.batchSize,
  }
}

/**
 * Read a published output allowance.
 *
 * THIS USED TO SUBSTITUTE 8,192 (removed 2026-09-18). That was the third
 * instance of the same mistake this module's header already records twice: a
 * number invented where the catalogue published none. It was worse than the
 * earlier two because it did not merely cap a correct derivation — it FED one,
 * so `describeScenePromptPackSize` printed
 *
 *   8,192 output tokens × 0.75 ÷ 300 per scene = 20 max
 *
 * for a product that had published nothing at all. A figure the customer would
 * reasonably read as the model's own, produced from no data.
 *
 * The sibling `productCeiling` in `output-token-budget.ts` already threw for
 * the identical condition — "Story Studio does not substitute a ceiling of its
 * own" — so this module was the odd one out, not the rule.
 *
 * `null` means the selected product published no ceiling. That is an honest
 * usable state: callers omit the request field and use an explicit/configured
 * batch choice instead. A malformed published value still throws.
 */
function normalizeMaxOutputTokens(value: unknown): number | null {
  if (value == null || value === 0) return null
  const parsed = Number(value)
  if (typeof value !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      'Cannot resolve a scene-prompt output budget: the selected Gateway product published '
      + `no usable max_output_tokens (got ${JSON.stringify(value)}). `
      + 'Story Studio does not substitute a ceiling of its own.',
    )
  }
  return parsed
}

/**
 * The selectable output allowances for one product, derived from what it
 * publishes. Always ends with the product's exact maximum, so "everything this
 * model allows" is a one-click choice and never rounds down to a stale step.
 */
export function scenePromptTokenOptions(modelMaxOutputTokens: unknown): number[] {
  const maximum = normalizeMaxOutputTokens(modelMaxOutputTokens)
  if (maximum === null) return []
  const options = new Set<number>()
  for (const seed of TOKEN_LADDER_SEEDS) {
    for (let step = seed; step <= maximum; step *= 2) options.add(step)
  }
  options.add(maximum)
  return [...options].sort((a, b) => a - b)
}

/**
 * A chosen batch size, or 'auto'. THROWS on a value that is present but not
 * usable, and never substitutes a different number.
 *
 * It used to do the opposite: reject anything above 50 and quietly return
 * 'auto', which resolved straight back to 50. Someone who typed 200 got 50 and
 * was told nothing. A value this function cannot honour is now reported to
 * whoever sent it — see the 400s in `routes/scene-plan.ts` and the visible skip
 * in `routes/pipeline.ts`.
 */
export function parseScenePromptPackSetting(value: unknown): ScenePromptPackSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  // Booleans, arrays and objects all coerce to a number in JS (`true` → 1,
  // `[]` → 0), so the type is checked before the value. A caller sending one of
  // those has a bug, and 1 is not a helpful guess at what it meant.
  const size = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(size) || size < SCENE_PROMPT_PACK_MIN) {
    throw new Error(
      `Scenes per request must be "auto" or a whole number of ${SCENE_PROMPT_PACK_MIN} or more. `
      + `Received ${JSON.stringify(value)}. Nothing was substituted.`,
    )
  }
  return size
}

/**
 * Accept any positive whole allowance. There is deliberately no membership
 * test against a fixed list: the legal values belong to the SELECTED product,
 * which this function has not been told about, so the clamp happens in
 * `resolveScenePromptTokenBudget` where the live maximum is known.
 */
export function parseScenePromptTokenSetting(value: unknown): ScenePromptTokenSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const budget = Number(value)
  return Number.isInteger(budget) && budget >= 1 ? budget : 'auto'
}

/**
 * The largest structured pack the SELECTED MODEL's published output allowance
 * can return complete, at the owner's tuning. This is the only ceiling in the
 * module, and it is derived, not declared: exceeding it truncates the JSON.
 */
export function maxSafeScenePromptPackSize(
  maxOutputTokens?: unknown,
  tuning: ScenePromptPackTuning = SCENE_PROMPT_PACK_TUNING_DEFAULTS,
): ScenePromptPackSize | null {
  const maxOutput = normalizeMaxOutputTokens(maxOutputTokens)
  if (maxOutput === null) return null
  const scenes = Math.floor((maxOutput * tuning.safetyFraction) / tuning.tokensPerScene)
  return Math.max(SCENE_PROMPT_PACK_MIN, scenes)
}

/**
 * What "Automatic" means: the owner's default batch, or the model's derived
 * safe maximum when that model cannot return even that much.
 *
 * The `Math.min` here is NOT the old cap wearing a new hat. `batchSize` is a
 * value the owner sets and can raise without touching code; `maxSafe` is what
 * the chosen model publishes. Neither is a constant this module invented.
 */
export function automaticScenePromptPackSize(
  maxOutputTokens?: unknown,
  tuning: ScenePromptPackTuning = SCENE_PROMPT_PACK_TUNING_DEFAULTS,
): ScenePromptPackSize {
  const safeMaximum = maxSafeScenePromptPackSize(maxOutputTokens, tuning)
  return safeMaximum === null ? tuning.batchSize : Math.min(tuning.batchSize, safeMaximum)
}

export function resolveScenePromptTokenBudget(
  modelMaxOutputTokens: unknown,
  setting: ScenePromptTokenSetting,
): number | null {
  const modelMaximum = normalizeMaxOutputTokens(modelMaxOutputTokens)
  const requested = setting === 'auto' ? modelMaximum : setting
  return requested === null ? null : modelMaximum === null ? requested : Math.min(requested, modelMaximum)
}

/**
 * Explicit choices remain available, and are limited only by what the selected
 * GenStudio model can actually return as one complete, durable JSON response.
 * A choice that IS reduced is reported by `describeScenePromptPackSize`, which
 * the scene-plan generator writes into the job log — an explicit number never
 * changes quietly.
 */
export function resolveScenePromptPackSize(
  outputBudget: unknown,
  setting: ScenePromptPackSetting,
  tuning: ScenePromptPackTuning = SCENE_PROMPT_PACK_TUNING_DEFAULTS,
): ScenePromptPackSize {
  const safeMaximum = maxSafeScenePromptPackSize(outputBudget, tuning)
  const requested = setting === 'auto'
    ? automaticScenePromptPackSize(outputBudget, tuning)
    : setting
  return safeMaximum === null
    ? Math.max(SCENE_PROMPT_PACK_MIN, requested)
    : Math.min(safeMaximum, Math.max(SCENE_PROMPT_PACK_MIN, requested))
}

/**
 * A one-line, honest account of how the batch size was arrived at, including
 * whether an explicitly requested size had to be reduced and why.
 */
export function describeScenePromptPackSize(
  outputBudget: unknown,
  setting: ScenePromptPackSetting,
  tuning: ScenePromptPackTuning = SCENE_PROMPT_PACK_TUNING_DEFAULTS,
): string {
  const safeMaximum = maxSafeScenePromptPackSize(outputBudget, tuning)
  const resolved = resolveScenePromptPackSize(outputBudget, setting, tuning)
  const budget = normalizeMaxOutputTokens(outputBudget)
  if (budget === null) {
    const basis = 'the selected Gateway product publishes no output ceiling; Story Studio sends no output-token limit'
    return setting === 'auto'
      ? `Batch: ${resolved} scenes per request (project default; ${basis}).`
      : `Batch: ${resolved} scenes per request (requested; ${basis}).`
  }
  const basis = `${budget.toLocaleString()} output tokens × ${tuning.safetyFraction} ÷ `
    + `${tuning.tokensPerScene} per scene = ${safeMaximum!.toLocaleString()} max`
  if (setting === 'auto') {
    return resolved < tuning.batchSize
      ? `Batch: ${resolved} scenes per request — the selected output allowance caps this batch at ${resolved} complete instead of the ${tuning.batchSize}-scene default (${basis}).`
      : `Batch: ${resolved} scenes per request (project default; ${basis}).`
  }
  return resolved < setting
    ? `Batch: ${resolved} scenes per request — ${setting} was requested, but the selected output allowance caps this batch at ${resolved} complete (${basis}).`
    : `Batch: ${resolved} scenes per request (requested; ${basis}).`
}

/**
 * Available input budget at the current setting, per GenStudio's published
 * arithmetic: `max(0, context_window_tokens - selected_max_output_tokens)`.
 *
 * An ESTIMATE for transparency. It is never converted into a character limit:
 * characters per token vary by language, and Khmer and mixed-script narration
 * would be mis-measured by any such conversion. `0` for the context window
 * means "not published", so no budget can honestly be stated.
 */
export function availableInputTokens(
  contextWindowTokens: unknown,
  selectedMaxOutputTokens: unknown,
): number {
  const contextWindow = Number(contextWindowTokens)
  if (selectedMaxOutputTokens == null || selectedMaxOutputTokens === 0) return 0
  const output = Number(selectedMaxOutputTokens)
  if (!Number.isInteger(contextWindow) || contextWindow < 1) return 0
  if (!Number.isInteger(output) || output < 0) return contextWindow
  return Math.max(0, contextWindow - output)
}

// ── Sizing a request from the prompt it will ACTUALLY send ─────────────────
//
// The output-ceiling derivation above answers "how many scenes fit in one
// answer". It cannot see the REQUEST. Measured on 2,458 real calls
// (2026-09-23 … 2026-11-01, `_orchestra/story-lead/token-measure/measure.md`),
// 13% of English visual packs and 52% of Khmer ones already exceeded Gemma's
// 23,000-token request limit before the model was asked anything, and planner
// windows were never sized against it at all. A request that is too large is
// refused by the Gateway, so the work is split here instead: the caller
// assembles the REAL prompt for a candidate size and this shrinks the candidate
// until the prompt AND the answer it needs both fit.
//
// `max_request_tokens` is the INPUT-side admission line. It never lowers the
// answer: a published request ceiling already reserves room for the answer
// (gemma-4: 23,000 request + 8,192 answer inside a 32,768 window). The answer is
// bounded separately by the published output ceiling and by what the context
// window still holds beside this prompt. An ABSENT limit is unknown and
// enforces nothing — never a number of ours.

export interface SceneRequestLimits {
  /** Published `max_request_tokens` (input side). Absent/null = unknown. */
  maxRequestTokens?: number | null
  /** Published `context_window_tokens`. Absent/null = unknown. */
  contextWindowTokens?: number | null
  /** Published `max_output_tokens`. Absent/null = unknown. */
  maxOutputTokens?: number | null
}

export interface SceneRequestFit {
  fits: boolean
  /** The assembled prompt's estimated tokens. */
  promptTokens: number
  /** The answer allowance this prompt leaves, capped by the published output ceiling. Null when unknown. */
  answerTokens: number | null
  /** Which published limit refused, or null when the request fits. */
  refusedBy: 'request' | 'window' | 'answer' | null
}

/** A published token limit. `0`/absent = unpublished (the catalogue's sentinel). */
function publishedSceneLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === 0) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Cannot size a scene request: the selected Gateway product published a malformed limit (got ${JSON.stringify(value)}). `
      + 'Story Studio does not substitute a figure of its own.',
    )
  }
  return parsed
}

/**
 * Does ONE assembled request fit? Prompt on the input side, the answer it
 * expects on the output side, both inside the context window.
 */
export function sceneRequestFits(opts: {
  promptCharacters: number
  promptNonAsciiCharacters?: number
  answerTokens: number
  limits: SceneRequestLimits
}): SceneRequestFit {
  const answer = Math.max(1, Math.ceil(opts.answerTokens))
  const bounded = boundOutputTokensToContext(
    answer,
    opts.limits.contextWindowTokens,
    opts.promptCharacters,
    opts.promptNonAsciiCharacters ?? 0,
    opts.limits.maxRequestTokens,
  )
  const outputCeiling = publishedSceneLimit(opts.limits.maxOutputTokens)
  const window = Number.isInteger(opts.limits.contextWindowTokens) && (opts.limits.contextWindowTokens as number) >= 1
    ? opts.limits.contextWindowTokens as number
    : null
  const refusedBy: SceneRequestFit['refusedBy'] = bounded.overflow
    ? (bounded.overflowLimit === 'request' ? 'request' : 'window')
    : outputCeiling !== null && answer > outputCeiling
      ? 'answer'
      : bounded.maxTokens !== null && bounded.maxTokens < answer
        ? 'window'
        : null
  // The allowance is what the request LEAVES, not the answer it was asked for.
  const available = window === null ? null : Math.max(0, window - bounded.promptTokens)
  const allowance = bounded.overflow
    ? 0
    : available === null
      ? outputCeiling
      : outputCeiling === null ? available : Math.min(outputCeiling, available)
  return { fits: refusedBy === null, promptTokens: bounded.promptTokens, answerTokens: allowance, refusedBy }
}

/**
 * Measured answer tokens per scene, by kind and REQUEST language (the channel
 * group), with margin. Brief G: language comes from the request, not the
 * answer — Khmer channels get English image prose back.
 *
 * These are STARTING VALUES from provider-reported (unverified) usage, not
 * limits: p95 + 25%, rounded up. They are used only by the request-sizing path
 * below; `ScenePromptPackTuning.tokensPerScene` keeps its own meaning for the
 * output-ceiling derivation. An owner who sets `scene_prompt_tokens_per_scene`
 * overrides the visual/motion rates through that existing key.
 *
 * Motion and planner windows have NO measured data — 0 stored calls — so their
 * 300 is the existing tuning value, marked unmeasured rather than presented as
 * measured. Single-scene visual English is measured separately because one
 * scene pays the pack's whole fixed overhead.
 */
export type ScenePromptUnitKind = 'visual' | 'motion' | 'planner-window' | 'thumbnail'
export type ScenePromptRequestLanguage = 'en' | 'km'

export interface SceneUnitTokenRates {
  /** Answer tokens one unit costs inside a request that carries several. */
  perUnit: number
  /** Answer tokens a request that carries exactly ONE unit costs (fixed overhead included). */
  singleUnit: number
}

export const SCENE_PROMPT_MEASURED_TOKENS_PER_UNIT: Readonly<
  Record<ScenePromptUnitKind, Readonly<Record<ScenePromptRequestLanguage, Readonly<SceneUnitTokenRates>>>>
> = Object.freeze({
  visual: Object.freeze({
    en: Object.freeze({ perUnit: 550, singleUnit: 1_550 }),
    km: Object.freeze({ perUnit: 400, singleUnit: 400 }), // single Khmer unmeasured → perUnit
  }),
  motion: Object.freeze({ // unmeasured
    en: Object.freeze({ perUnit: 300, singleUnit: 300 }),
    km: Object.freeze({ perUnit: 300, singleUnit: 300 }),
  }),
  'planner-window': Object.freeze({ // unmeasured
    en: Object.freeze({ perUnit: 300, singleUnit: 300 }),
    km: Object.freeze({ perUnit: 300, singleUnit: 300 }),
  }),
  // G0 measured (2,458 calls, 2026-09-23 … 2026-11-01): p95 + 25% per
  // thumbnail prompt. A thumbnail pack request carries the same fixed
  // instruction overhead as a single one, so singleUnit equals perUnit.
  thumbnail: Object.freeze({
    en: Object.freeze({ perUnit: 2_350, singleUnit: 2_350 }),
    km: Object.freeze({ perUnit: 1_750, singleUnit: 1_750 }),
  }),
})

export function resolveSceneUnitTokenRates(
  kind: ScenePromptUnitKind,
  language: ScenePromptRequestLanguage | string | null | undefined,
  configuredPerScene?: unknown,
): SceneUnitTokenRates {
  const owner = Number(configuredPerScene)
  if (Number.isInteger(owner) && owner >= 1) return { perUnit: owner, singleUnit: owner }
  return SCENE_PROMPT_MEASURED_TOKENS_PER_UNIT[kind][language === 'km' ? 'km' : 'en']
}

function sceneAnswerTokens(units: number, rates: SceneUnitTokenRates): number {
  return Math.max(1, Math.ceil(units === 1 ? rates.singleUnit : units * rates.perUnit))
}

export interface SceneUnitFit extends SceneRequestFit {
  /** Units that fit. 0 = not even one does. */
  units: number
}

/**
 * Shrink a candidate unit count until the assembled prompt and its expected
 * answer both fit. `buildPrompt` must assemble the REAL prompt for that count —
 * this is the point: the size comes from the request, not from a per-scene
 * guess about the input.
 */
export function fitSceneUnitsToRequest(opts: {
  maxUnits: number
  rates: SceneUnitTokenRates
  limits: SceneRequestLimits
  buildPrompt: (units: number) => { characters: number; nonAsciiCharacters?: number }
}): SceneUnitFit {
  const maxUnits = Math.max(1, Math.floor(opts.maxUnits))
  let last: SceneRequestFit | null = null
  // Descending, not binary: the single-unit answer can be larger than a
  // two-unit one, so fit is not guaranteed monotone at the bottom.
  for (let units = maxUnits; units >= 1; units--) {
    const size = opts.buildPrompt(units)
    const fit = sceneRequestFits({
      promptCharacters: size.characters,
      promptNonAsciiCharacters: size.nonAsciiCharacters,
      answerTokens: sceneAnswerTokens(units, opts.rates),
      limits: opts.limits,
    })
    if (fit.fits) return { ...fit, units }
    last = fit
  }
  return { ...(last ?? { fits: false, promptTokens: 0, answerTokens: null, refusedBy: 'window' as const }), units: 0 }
}

export interface SceneRequestGroups<T> {
  groups: T[][]
  /** The unit that could not fit, with its figures, or null when every unit was placed. */
  refused: SceneUnitFit | null
}

/**
 * Greedy, order-preserving packing: each group is the largest prefix (up to
 * `maxUnitsPerGroup`) whose assembled prompt and answer fit. A single unit that
 * cannot fit refuses the whole run before any request is made.
 */
export function packSceneRequestGroups<T>(opts: {
  items: readonly T[]
  maxUnitsPerGroup: number
  rates: SceneUnitTokenRates
  limits: SceneRequestLimits
  buildPrompt: (items: readonly T[]) => { characters: number; nonAsciiCharacters?: number }
}): SceneRequestGroups<T> {
  const groups: T[][] = []
  const maxUnits = Math.max(1, Math.floor(opts.maxUnitsPerGroup))
  let index = 0
  while (index < opts.items.length) {
    const candidate = opts.items.slice(index, index + maxUnits)
    let fit: SceneUnitFit | null = null
    for (let units = candidate.length; units >= 1; units--) {
      const size = opts.buildPrompt(candidate.slice(0, units))
      const sized = sceneRequestFits({
        promptCharacters: size.characters,
        promptNonAsciiCharacters: size.nonAsciiCharacters,
        answerTokens: sceneAnswerTokens(units, opts.rates),
        limits: opts.limits,
      })
      fit = { ...sized, units: sized.fits ? units : 0 }
      if (sized.fits) break
    }
    if (!fit || fit.units === 0) return { groups, refused: fit }
    groups.push(candidate.slice(0, fit.units))
    index += fit.units
  }
  return { groups, refused: null }
}

/** One line for the job log: every enforced limit, and "no published" when unknown. */
export function describeSceneRequestLimits(limits: SceneRequestLimits): string {
  const request = publishedSceneLimit(limits.maxRequestTokens)
  const window = publishedSceneLimit(limits.contextWindowTokens)
  const output = publishedSceneLimit(limits.maxOutputTokens)
  return [
    request === null ? 'no published request limit' : `${request.toLocaleString()}-token request limit`,
    window === null ? 'no published context window' : `${window.toLocaleString()}-token context window`,
    output === null ? 'no published answer ceiling' : `${output.toLocaleString()}-token answers`,
  ].join(', ')
}
