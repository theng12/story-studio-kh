/**
 * LIVE per-model token budgets in the UI.
 *
 * Story Studio publishes no model limits of its own. The output selector's
 * maximum, its option list, and the available-input estimate all come from the
 * SELECTED product's catalogue entry, and only the selection (model id +
 * allowance) is ever persisted — never a copied limit, because GenStudio may
 * change it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { nextTick } from 'vue'
import { transform } from 'esbuild'
import {
  availableInputTokens,
  clampOutputAllowance,
  contextWindowTokens,
  describeUnstatedLimitSource,
  formatTokenCount,
  isModelTokenLimitError,
  maxOutputTokens,
  maxOutputTokensSource,
  outputAllowanceOptions,
} from '../utils/model-token-budget.js'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')
const modelSelector = source('../components/ModelSelector.vue')
const research = source('../pages/projects/[slug]/research.vue')

/**
 * Runs the shipped Scene Plan budget computed block and its model-switch
 * watcher. The support only supplies reactive inputs; the formulas and watcher
 * are sliced from the page, so this fails if the production derivation drifts.
 */
async function loadScenePlanBudgetDerivation() {
  const start = scenePlan.indexOf('const liveModelLimits = computed')
  const end = scenePlan.indexOf('\nfunction pacingSummary', start)
  const watcherStart = scenePlan.indexOf('watch(publishedMaxOutput,', end)
  const watcherEnd = scenePlan.indexOf('\n\nconst scenePlanGenerationUnavailable', watcherStart)
  assert.ok(start >= 0 && end > start && watcherStart >= 0 && watcherEnd > watcherStart)

  const vueUrl = await import.meta.resolve('vue')
  const budgetUrl = await import.meta.resolve('../utils/model-token-budget.js')
  const support = `
    import { computed, ref, watch } from ${JSON.stringify(vueUrl)}
    import {
      availableInputTokens, clampOutputAllowance, contextWindowTokens,
      formatTokenCount, maxOutputTokens as publishedMaxOutputTokens,
      outputAllowanceOptions,
    } from ${JSON.stringify(budgetUrl)}
    const PROMPT_PACK_MIN = 1
    const PROMPT_PACK_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500]
    const form = ref({ model: '', prompt_max_tokens: 'auto', prompt_pack_size: 'auto' })
    const selectedModelMeta = ref(null)
    const promptSafetyFraction = ref(0.75)
    const promptTokensPerScene = ref(300)
    const promptBatchSizeDefault = ref(250)
    function setModel(model) {
      selectedModelMeta.value = model
      form.value.model = model.id
    }
  `
  const compiled = await transform(`${support}\n${scenePlan.slice(start, end)}\n${scenePlan.slice(watcherStart, watcherEnd)}\nexport {
    form, setModel, effectivePromptTokenBudget, maximumPromptPackSize,
    automaticPromptPackSize, effectivePromptPackSize, hasUnpublishedExplicitPromptBudget,
  }`, { loader: 'ts', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)
}

describe('published context window', () => {
  test('context_window_tokens is preferred over the deprecated alias', () => {
    assert.equal(
      contextWindowTokens({ context_window_tokens: 1_050_000, context_limit_tokens: 200_000 }),
      1_050_000,
    )
  })

  test('the alias is read ONLY when the current field is absent', () => {
    assert.equal(contextWindowTokens({ context_limit_tokens: 200_000 }), 200_000)
  })

  test('an unpublished window is 0 — the UI says "not published", never a guess', () => {
    assert.equal(contextWindowTokens({}), 0)
    assert.equal(contextWindowTokens(null), 0)
    assert.equal(formatTokenCount(0), 'not published')
    assert.equal(formatTokenCount(1_050_000), (1_050_000).toLocaleString())
  })
})

describe('output allowance options', () => {
  test('the selector maximum equals the model\'s published max_output_tokens', () => {
    assert.equal(maxOutputTokens({ max_output_tokens: 128_000 }), 128_000)
    assert.equal(outputAllowanceOptions(128_000).at(-1), 128_000)
    assert.equal(outputAllowanceOptions(65_536).at(-1), 65_536)
  })

  test('a 128k model offers beyond 32,768 and a 32,768 model does not', () => {
    assert.ok(outputAllowanceOptions(128_000).some(option => option > 32_768))
    assert.ok(!outputAllowanceOptions(32_768).some(option => option > 32_768))
    assert.deepEqual(outputAllowanceOptions(32_768), [4096, 6144, 8192, 12288, 16384, 24576, 32768])
  })

  test('an unpublished allowance offers nothing rather than a made-up ladder', () => {
    assert.deepEqual(outputAllowanceOptions(0), [])
  })
})

describe('clamping on model switch', () => {
  test('an over-large selection clamps down to the new model\'s maximum', () => {
    assert.equal(clampOutputAllowance(128_000, 32_768), 32_768)
    assert.equal(clampOutputAllowance(65_536, 8_192), 8_192)
  })

  test('a selection that still fits is left exactly as chosen', () => {
    assert.equal(clampOutputAllowance(16_384, 128_000), 16_384)
  })

  test('auto survives every switch — it MEANS this product\'s maximum or an omitted request', () => {
    assert.equal(clampOutputAllowance('auto', 32_768), 'auto')
    assert.equal(clampOutputAllowance('auto', 128_000), 'auto')
    assert.equal(clampOutputAllowance('auto', 0), 'auto')
  })

  test('an explicit allowance survives an unpublished or malformed maximum', () => {
    assert.equal(clampOutputAllowance(8192, 0), 8192)
    assert.equal(clampOutputAllowance(8192, Number.NaN), 8192)
  })
})

describe('available input budget', () => {
  test('is max(0, context_window - selected_max_output)', () => {
    assert.equal(availableInputTokens(1_050_000, 128_000), 922_000)
    assert.equal(availableInputTokens(1_048_576, 65_536), 983_040)
  })

  test('never goes negative, however the catalogue is shaped', () => {
    assert.equal(availableInputTokens(8_192, 32_768), 0)
    assert.equal(availableInputTokens(32_768, 32_768), 0)
  })

  test('claims nothing when the context window is unpublished', () => {
    assert.equal(availableInputTokens(0, 32_768), 0)
    assert.equal(availableInputTokens(1_050_000, null as any), 0)
  })
})

describe('Gateway validation errors', () => {
  test('a context/output rejection is recognised by SHAPE, never by model name', () => {
    assert.ok(isModelTokenLimitError('This request exceeds the model context window.'))
    assert.ok(isModelTokenLimitError('requested 200000 output tokens, but the product publishes 32768'))
    assert.ok(isModelTokenLimitError('token limit exceeded'))
    assert.ok(!isModelTokenLimitError('Project not found'))
    assert.ok(!isModelTokenLimitError(''))
    assert.ok(!isModelTokenLimitError(undefined))
  })
})

describe('Scene Plan workspace wiring', () => {
  test('no static context, output, or character limit survives on the page', () => {
    assert.doesNotMatch(scenePlan, /OUTPUT_BUDGET_OPTIONS/)
    assert.doesNotMatch(scenePlan, /Math\.min\(32_768/)
    assert.doesNotMatch(scenePlan, /4096, 6144, 8192, 12288, 16384, 24576, 32768/)
    assert.doesNotMatch(scenePlan, /500_000|500000/)
  })

  test('the option list and the selector maximum derive from the selected model', () => {
    assert.match(scenePlan, /outputAllowanceOptions\(selectedModelMaxOutput\.value\)/)
    assert.match(scenePlan, /publishedMaxOutputTokens\(liveModelLimits\.value\)/)
  })

  test('an over-large allowance is clamped the moment the model changes', () => {
    assert.match(scenePlan, /watch\(publishedMaxOutput,/)
    assert.match(scenePlan, /clampOutputAllowance\(form\.value\.prompt_max_tokens, maximum\)/)
  })

  test('context window, output allowance, and available input budget are all shown', () => {
    assert.match(scenePlan, /Context window/)
    assert.match(scenePlan, /Output allowance/)
    assert.match(scenePlan, /Available input budget at this setting/)
    assert.match(scenePlan, /availableInputTokens\(selectedModelContextWindow\.value/)
  })

  test('a model without a published output ceiling stays usable and is explained', () => {
    assert.match(scenePlan, /hasSelectedPromptModel/)
    assert.match(scenePlan, /publishes no output ceiling/)
    assert.match(scenePlan, /Story Studio sends no output limit/)
  })

  test('an explicit allowance on a no-ceiling model remains selected, sent, and sizes its batch', () => {
    assert.match(scenePlan, /<option v-if="hasUnpublishedExplicitPromptBudget" :value="effectivePromptTokenBudget">[\s\S]*User-chosen · \{\{ effectivePromptTokenBudget\.toLocaleString\(\) \}\} tokens/)
    assert.match(scenePlan, /v-else-if="hasUnpublishedExplicitPromptBudget">up to \{\{ effectivePromptTokenBudget\.toLocaleString\(\) \}\} output tokens · user-chosen allowance/)
    const promptStage = scenePlan.slice(scenePlan.indexOf('async function runPromptStage'), scenePlan.indexOf('/** Returns the tracked job'))
    assert.match(promptStage, /preset_id: presetId/,
      'the stage sends the exact applied preset whose immutable snapshot owns the allowance')
    assert.doesNotMatch(promptStage, /prompt_max_tokens:/,
      'the stage must not replace the exact preset with mutable page state')
    assert.match(scenePlan, /prompt_max_tokens: form\.value\.prompt_max_tokens/)
  })

  test('runs the shipped no-ceiling allowance and batch derivation across model switches', async () => {
    const budget = await loadScenePlanBudgetDerivation()
    budget.setModel({ id: 'published-large', max_output_tokens: 32_768 })
    budget.form.value.prompt_max_tokens = 8192
    await nextTick()
    assert.equal(budget.effectivePromptTokenBudget.value, 8192)
    assert.equal(budget.automaticPromptPackSize.value, 20)

    budget.setModel({ id: 'no-ceiling', max_output_tokens: null })
    await nextTick()
    assert.equal(budget.form.value.prompt_max_tokens, 8192)
    assert.equal(budget.hasUnpublishedExplicitPromptBudget.value, true)
    assert.equal(budget.effectivePromptTokenBudget.value, 8192)
    assert.equal(budget.effectivePromptPackSize.value, 20)

    budget.form.value.prompt_max_tokens = 'auto'
    await nextTick()
    assert.equal(budget.effectivePromptTokenBudget.value, 0)
    assert.equal(budget.automaticPromptPackSize.value, 250)
    assert.equal(budget.effectivePromptPackSize.value, 250)

    budget.form.value.prompt_max_tokens = 8192
    budget.setModel({ id: 'published-smaller', max_output_tokens: 4096 })
    await nextTick()
    assert.equal(budget.form.value.prompt_max_tokens, 4096)
    assert.equal(budget.effectivePromptTokenBudget.value, 4096)
    assert.equal(budget.automaticPromptPackSize.value, 10)
  })

  test('the budget is presented as an estimate, and is never turned into characters', () => {
    assert.match(scenePlan, /Estimated from the limits the Gateway publishes/)
    assert.match(scenePlan, /[Tt]he Gateway validates every request/)
    // No token-to-character conversion anywhere: characters per token differ by
    // language, and Khmer and mixed-script narration would be mis-measured.
    assert.doesNotMatch(scenePlan, /availableInputBudget[^\n]*\*\s*\d/)
    assert.doesNotMatch(scenePlan, /(?:CHARS_PER_TOKEN|charsPerToken|TOKENS_PER_CHAR)/)
    assert.doesNotMatch(scenePlan, /maxlength=/i)
  })

  test('a Gateway limit rejection refreshes the catalogue and clamps', () => {
    assert.match(scenePlan, /isModelTokenLimitError\(message\)/)
    assert.match(scenePlan, /modelSelector\.value\?\.reloadCatalog\(\)/)
    assert.match(scenePlan, /reportGenerationError\(e,/)
  })

  test('only the SELECTION is persisted — no copied catalogue limit reaches a preset', () => {
    // The preset snapshot carries the model id and the chosen allowance and
    // nothing else about the model's published limits.
    const snapshot = scenePlan.slice(scenePlan.indexOf('snapshot: () => ({'), scenePlan.indexOf('apply: (data) =>'))
    assert.match(snapshot, /model: form\.value\.model/)
    assert.match(snapshot, /prompt_max_tokens: form\.value\.prompt_max_tokens/)
    assert.doesNotMatch(snapshot, /context_window_tokens|context_limit_tokens|max_output_tokens/)
    // And the live limits live in their own ref, outside the persisted form.
    assert.doesNotMatch(scenePlan, /form\.value\.(context_window_tokens|max_output_tokens)/)
  })
})

describe('a published limit names its author (HUB-20)', () => {
  test('the label is read verbatim, and an absent one stays null', () => {
    assert.equal(maxOutputTokensSource({ max_output_tokens_source: 'worker_default' }),
      'worker_default')
    assert.equal(maxOutputTokensSource({ max_output_tokens_source: 'provider' }), 'provider')
    for (const value of [undefined, null, '', 'stated', 42]) {
      assert.equal(maxOutputTokensSource({ max_output_tokens_source: value as never }), null)
    }
  })

  test('a number nobody attributed is not described as the model’s', () => {
    // `provider`/`model` are the model's own statement: no extra sentence.
    assert.equal(describeUnstatedLimitSource({ max_output_tokens_source: 'provider' }), null)
    assert.equal(describeUnstatedLimitSource({ max_output_tokens_source: 'model' }), null)
    // Unlabelled is also silent — but it is never rendered as "the model said so".
    assert.equal(describeUnstatedLimitSource({ max_output_tokens: 16_384 }), null)
    // Everything else says whose number it is, in Story Studio's own words.
    assert.match(describeUnstatedLimitSource({ max_output_tokens_source: 'worker_default' }) ?? '',
      /worker’s fallback/)
    assert.match(describeUnstatedLimitSource({ max_output_tokens_source: 'curated' }) ?? '',
      /curated default/)
    assert.match(describeUnstatedLimitSource({ max_output_tokens_source: 'gateway' }) ?? '',
      /gateway’s own default/)
    assert.match(describeUnstatedLimitSource({ max_output_tokens_source: 'unknown' }) ?? '',
      /unstated by the model/)
  })

  test('the scene plan renders the sentence beside the limit it describes', () => {
    assert.match(scenePlan, /promptBudgetSourceNote/)
    assert.match(scenePlan, /describeUnstatedLimitSource\(liveModelLimits\.value\)/)
    assert.match(scenePlan, /The output limit is \{\{ promptBudgetSourceNote \}\}/)
  })

  test('the field travels from the gateway through the server whitelist', () => {
    assert.match(source('../../electron/server/routes/health.ts'), /max_output_tokens_source/)
    assert.match(source('../../electron/server/lib/genstudio-client.ts'),
      /max_output_tokens_source: readPublishedLimitSource/)
  })
})

describe('ModelSelector', () => {
  test('publishes the live limits under the current field name', () => {
    assert.match(modelSelector, /context_window_tokens\?: number/)
    assert.match(modelSelector, /max_output_tokens\?: number/)
    assert.match(modelSelector, /max_output_tokens_source\?:/)
  })

  test('exposes a forced catalogue reload that reuses the shared read cache', () => {
    assert.match(modelSelector, /invalidateModelCatalogCache\(\)/)
    assert.match(modelSelector, /defineExpose\(\{ reloadCatalog \}\)/)
  })
})

describe('web-research cost disclosure', () => {
  test('surfaces both published rates without multiplying either into a total', () => {
    assert.match(research, /credits_per_request/)
    assert.match(research, /credits_per_search/)
    assert.match(research, /Web research costs \$\{perRequest\}/)
    assert.match(research, /the total varies per run/)
  })
})
