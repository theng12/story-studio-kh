import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')

describe('Scene Plan workspace', () => {
  test('uses Character Sheet as the single continuity style source', () => {
    assert.doesNotMatch(scenePlan, /<StylePicker/)
    assert.doesNotMatch(scenePlan, /v-model="form\.style_prompt"/)
    assert.doesNotMatch(scenePlan, /style_prompt: form\.value\.style_prompt/)
    assert.match(scenePlan, /Style from Character Sheet/)
    assert.match(scenePlan, /Edit Character Sheet/)
    assert.match(scenePlan, /delete activeData\.style_prompt/)
  })

  test('keeps GenStudio-aware prompt batching and delegates episode timing and motion controls', () => {
    assert.match(scenePlan, /class="scene-workflow-grid/)
    assert.match(scenePlan, /Advanced batch controls/)
    assert.match(scenePlan, /selectedModelContextLabel/)
    assert.doesNotMatch(scenePlan, /Scenes per cloud pack/)
    assert.doesNotMatch(scenePlan, /Local and free-cloud models cap/)
    assert.match(scenePlan, /PROMPT_PACK_PRESETS = \[1, 5, 10, 25, 50, 100, 250, 500\]/)
    assert.match(scenePlan, /value="custom"/)
    assert.match(scenePlan, /customPromptPackSize/)
    assert.match(scenePlan, /prompt_pack_size: form\.value\.prompt_pack_size/)
    assert.match(scenePlan, /runPromptStage\('motion', effectivePromptPackSize\)/)
    assert.match(scenePlan, /Uses the same \{\{ effectivePromptPackSize \}\}-scene request size saved for visual prompts/)
    assert.doesNotMatch(scenePlan, /effectiveMotionPromptPackSize/)
    assert.match(scenePlan, /class="scene-advanced-batches"/)
    assert.match(scenePlan, /<VisualTimingMotion/)
    assert.match(scenePlan, /id="visual-timing"/)
    assert.match(scenePlan, /@saved="applyVisualSettings"/)
    assert.match(scenePlan, /class="intensity-options"/)
    assert.doesNotMatch(scenePlan, /v-if="form\.generate_motion_prompts" class="mt-2"/)
  })

  /**
   * The panel carried its own `PROMPT_PACK_MAX = 50` — a duplicate of a backend
   * constant, applied with the same formula — so BOTH ends independently threw
   * away a correct model-aware derivation, and the Custom box's `:max` stopped
   * anyone typing past it. Measured against 85,411 real scene prompts, 50
   * scenes is 3% of a large model's published allowance; the cap protected
   * nothing and made the card's own copy false.
   */
  test('no hardcoded batch ceiling survives on the page', () => {
    // The DECLARATION, not the word — the comment explaining its removal
    // deliberately names it, and that comment is the point.
    assert.doesNotMatch(scenePlan, /const PROMPT_PACK_MAX/)
    assert.doesNotMatch(scenePlan, /:max="maximumPromptPackSize"/)
    // The card's ceiling is derived from the selected model, and the tuning
    // behind it is the channel's own saved data.
    assert.match(scenePlan, /const maximumPromptPackSize = computed/)
    assert.match(scenePlan, /promptTokensPerScene/)
    assert.match(scenePlan, /promptSafetyFraction/)
    assert.match(scenePlan, /promptBatchSizeDefault/)
    assert.match(scenePlan, /scene_prompt_tokens_per_scene/)
    assert.match(scenePlan, /scene_prompt_output_safety_fraction/)
    assert.match(scenePlan, /scene_prompt_batch_size/)
    assert.match(scenePlan, /const DEFAULT_PROMPT_BATCH_SIZE = 250/)
    // A choice the model cannot honour is stated, not silently rewritten.
    assert.match(scenePlan, /promptPackReductionNotice/)
  })

  /** The old line claimed Automatic used "the selected GenStudio model's
   *  published output limit". A 50-scene cap made that false for every serious
   *  model, so the copy has to describe what actually happens. */
  test('the batch card no longer claims a limit it did not honour', () => {
    assert.doesNotMatch(scenePlan, /Automatic keeps each full-detail JSON response complete/)
    assert.match(scenePlan, /Automatic sends this channel’s default of \{\{ promptBatchSizeDefault \}\} scenes per request/)
    assert.match(scenePlan, /reduced only if/)
  })

  test('repairs missing prompts in the saved GenStudio pack size', () => {
    assert.match(scenePlan, /packs of up to \$\{effectivePromptPackSize\.value\} scenes per GenStudio request/)
    assert.match(scenePlan, /prompt_pack_size: form\.value\.prompt_pack_size/)
    assert.match(scenePlan, /prompt_max_tokens: form\.value\.prompt_max_tokens/)
    assert.match(scenePlan, /Prompt repair queued in durable GenStudio packs/)
    assert.doesNotMatch(scenePlan, /one scene per endpoint|Chat Studio pool|model pool/)
  })

  test('disables and handler-guards every paid prompt action for Image Pool episodes', () => {
    assert.match(scenePlan, /const scenePlanGenerationUnavailable = computed\(\(\) => episodeVisualSource\.value !== 'scene_plan'\)/)
    assert.match(scenePlan, /:disabled="scenePlanGenerationUnavailable \|\| !subtitleTimelineComplete/g)
    assert.match(scenePlan, /async function regenerateScenePrompt[\s\S]*if \(scenePlanGenerationUnavailable\.value\) return/)
    assert.match(scenePlan, /async function regenMotionPrompt[\s\S]*if \(scenePlanGenerationUnavailable\.value\) return/)
    assert.match(scenePlan, /async function regenAllEmptyPrompts[\s\S]*if \(scenePlanGenerationUnavailable\.value\) return/)
  })

  test('separates saved-plan pacing from the next build and explains an unpublished output limit', () => {
    assert.match(scenePlan, /Saved plan: \{\{ pacingSummary\(plan\.pacing\) \}\}/)
    assert.match(scenePlan, /Next build: \{\{ pacingSummary\(continuityPacing\) \}\}/)
    assert.match(scenePlan, /href="#visual-timing"/)
    assert.doesNotMatch(scenePlan, /Pacing:[\s\S]{0,160}character-sheet/)
    assert.match(scenePlan, /Choose a prompt model to see its published output allowance and batch size/)
    assert.match(scenePlan, /publishes no output ceiling/)
    assert.match(scenePlan, /Not published · omitted/)
    assert.match(scenePlan, /User-chosen · \{\{ effectivePromptTokenBudget\.toLocaleString\(\) \}\} tokens/)
    assert.match(scenePlan, /up to \{\{ effectivePromptTokenBudget\.toLocaleString\(\) \}\} output tokens · user-chosen allowance/)
    assert.match(scenePlan, /<button v-if="hasSelectedPromptModel"[^>]*>Next \{\{ effectivePromptPackSize \}\}<\/button>/)
    assert.doesNotMatch(scenePlan, /FALLBACK_OUTPUT_TOKENS|8192/)
    assert.match(scenePlan, /if \(!status\.value\?\.audio_merged\) return 'Generate and assemble audio first'/)
    assert.match(scenePlan, /'Repair and re-stitch the subtitle timeline first'/)
  })

  test('condenses configuration responsively without hiding controls', () => {
    assert.match(scenePlan, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
    assert.match(scenePlan, /@media \(max-width: 900px\)/)
    assert.match(scenePlan, /\.scene-workflow-grid \{ grid-template-columns: 1fr; \}/)
  })

  test('adds one-pass creative direction without restoring a second scene planner', () => {
    assert.match(scenePlan, />Visual interpretation</)
    assert.match(scenePlan, /one strategy is assigned to each scene before existing prompt packs run/)
    assert.match(scenePlan, /creative_direction: creativeDirectionPayload\.value/)
    assert.match(scenePlan, /snapshot: \(\) => \(\{[\s\S]*creative_direction: creativeDirectionPayload\.value/)
    assert.match(scenePlan, /delete activeData\.creative_direction/)
    assert.match(scenePlan, /class="scene-strategy-badge"/)
    assert.match(scenePlan, /CREATIVE_PROFILES/)
  })
})
