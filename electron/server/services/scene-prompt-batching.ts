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
