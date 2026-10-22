/**
 * The prompt-character ceiling control.
 *
 * An LLM writes image prompts; a separately chosen image model renders them.
 * Everything this control offers comes from GenStudio's published
 * `max_prompt_characters` on the live image catalogue — the distinct caps that
 * usable models actually publish, never a static 2000/4000/8000 ladder — and a
 * model publishing nothing produces NO limit and NO warning rather than an
 * invented number.
 *
 * Over the ceiling is amber and non-blocking: the prompt is saved in full,
 * generation succeeded, and the user may still render it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  normalizePromptCharCapSetting,
  promptCharCapAboveModel,
  promptCharCapOptions,
  promptCharacterCount,
  promptLengthLabel,
  promptLengthState,
  promptLengthTone,
  publishedPromptCharCap,
  resolvePromptCharCap,
} from '../utils/prompt-char-cap.js'
import {
  readRememberedImageModelId,
  rememberedImageModelStorageKey,
} from '../utils/project-image-model.js'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')
const imagePrompts = source('../pages/projects/[slug]/image-prompts.vue')
const reviewRow = source('../components/PromptReviewPanelRow.vue')
const reviewPanel = source('../components/PromptReviewPanel.vue')

const CATALOGUE = [
  { id: 'fast', display_name: 'Fast', available: true, qualification_only: false, max_prompt_characters: 4_800 },
  { id: 'rich', display_name: 'Rich', available: true, qualification_only: false, max_prompt_characters: 8_000 },
  { id: 'twin', display_name: 'Twin', available: true, qualification_only: false, max_prompt_characters: 4_800 },
  { id: 'silent', display_name: 'Silent', available: true, qualification_only: false },
  { id: 'retired', display_name: 'Retired', available: false, max_prompt_characters: 120_000 },
  { id: 'qual', display_name: 'Qualification', available: true, qualification_only: true, max_prompt_characters: 99_000 },
]

describe('published ceilings drive the options', () => {
  test('options are the distinct caps usable models publish — never a fixed ladder', () => {
    assert.deepEqual(promptCharCapOptions(CATALOGUE), [4_800, 8_000])
  })

  test('a model that publishes nothing contributes no option', () => {
    assert.deepEqual(promptCharCapOptions([CATALOGUE[3]!]), [])
    assert.equal(publishedPromptCharCap(CATALOGUE[3]!), 0)
    assert.equal(publishedPromptCharCap(null), 0)
  })

  test('an empty or unread catalogue offers nothing rather than a default', () => {
    assert.deepEqual(promptCharCapOptions([]), [])
    assert.deepEqual(promptCharCapOptions(null), [])
    assert.deepEqual(promptCharCapOptions(undefined), [])
  })

  test('a model nobody can submit to is not a ceiling to write against', () => {
    const caps = promptCharCapOptions(CATALOGUE)
    assert.equal(caps.includes(120_000), false)
    assert.equal(caps.includes(99_000), false)
  })
})

describe('resolving the selection', () => {
  test('Auto follows the intended model’s published figure', () => {
    assert.equal(resolvePromptCharCap('auto', 4_800), 4_800)
  })

  test('Auto with nothing published means NO limit — never an invented one', () => {
    assert.equal(resolvePromptCharCap('auto', 0), 0)
    // No model selected at all resolves the same way.
    assert.equal(resolvePromptCharCap('auto', publishedPromptCharCap(undefined)), 0)
  })

  test('No limit is honoured even when the model publishes a cap', () => {
    assert.equal(resolvePromptCharCap('none', 4_800), 0)
  })

  test('a Custom ceiling is never clamped up to the model’s cap', () => {
    // Deliberate cost control: shorter prompts are fewer completion tokens.
    assert.equal(resolvePromptCharCap(1_200, 8_000), 1_200)
  })

  test('a Custom ceiling above the model’s cap stands, but is flagged', () => {
    assert.equal(resolvePromptCharCap(12_000, 4_800), 12_000)
    assert.equal(promptCharCapAboveModel(12_000, 4_800), true)
    assert.equal(promptCharCapAboveModel(4_800, 4_800), false)
    assert.equal(promptCharCapAboveModel(1_000, 4_800), false)
    // An unknown model can never produce that warning.
    assert.equal(promptCharCapAboveModel(12_000, 0), false)
    assert.equal(promptCharCapAboveModel(0, 4_800), false)
  })

  test('only the selection round-trips — auto, none, or a whole number', () => {
    assert.equal(normalizePromptCharCapSetting('auto'), 'auto')
    assert.equal(normalizePromptCharCapSetting('none'), 'none')
    assert.equal(normalizePromptCharCapSetting(4_800), 4_800)
    assert.equal(normalizePromptCharCapSetting('4800'), 4_800)
    assert.equal(normalizePromptCharCapSetting(undefined), 'auto')
    assert.equal(normalizePromptCharCapSetting(''), 'auto')
    assert.equal(normalizePromptCharCapSetting(0), 'auto')
    assert.equal(normalizePromptCharCapSetting(-5), 'auto')
    assert.equal(normalizePromptCharCapSetting('nonsense'), 'auto')
  })
})

describe('counting and warning', () => {
  test('every prompt gets a character count, capped or not', () => {
    assert.equal(promptLengthState('  hello  ', 0).characters, 5)
    assert.equal(promptLengthLabel(promptLengthState('x'.repeat(1_204), 4_800)), '1,204 / 4,800')
    assert.equal(promptLengthLabel(promptLengthState('x'.repeat(1_204), 0)), '1,204')
    // Matches the submit-time guard, which trims before measuring.
    assert.equal(promptCharacterCount('  abc '), 3)
  })

  test('over the ceiling is amber — a nudge, never red and never a block', () => {
    const over = promptLengthState('x'.repeat(5_000), 4_800)
    assert.equal(over.overCap, true)
    assert.equal(over.overage, 200)
    assert.equal(promptLengthTone(over), 'warn')
    assert.equal(promptLengthTone(promptLengthState('x'.repeat(100), 4_800)), 'ok')
  })

  test('no ceiling means no warning anywhere', () => {
    const uncapped = promptLengthState('x'.repeat(50_000), 0)
    assert.equal(uncapped.overCap, false)
    assert.equal(uncapped.cap, 0)
    assert.equal(promptLengthTone(uncapped), 'neutral')
  })

  test('exactly on the ceiling is inside it', () => {
    assert.equal(promptLengthState('x'.repeat(4_800), 4_800).overCap, false)
  })

  test('nothing in this module returns a shortened prompt', () => {
    const capModule = source('../utils/prompt-char-cap.ts')
    assert.doesNotMatch(capModule, /\.slice\(0, *(cap|limit)/)
    assert.doesNotMatch(capModule, /substring\(0, *(cap|limit)/)
    assert.doesNotMatch(capModule, /truncat/i)
    // And no token→character ratio is reintroduced.
    assert.doesNotMatch(capModule, /prompt_token_allowance *[*/]/)
    assert.match(capModule, /never\n \* converted into characters/)
  })
})

describe('the intended image model', () => {
  test('Auto follows whatever the project already renders with', () => {
    assert.equal(rememberedImageModelStorageKey('my-channel'), 'ssk:form:my-channel:scene-review-genstudio:v1')
    const storage = {
      getItem: (key: string) => key === 'ssk:form:my-channel:scene-review-genstudio:v1'
        ? JSON.stringify({ model: 'rich', aspect_ratio: '16:9' })
        : null,
    }
    assert.equal(readRememberedImageModelId('my-channel', storage), 'rich')
  })

  test('nothing selected stays nothing — no model is chosen on the user’s behalf', () => {
    assert.equal(readRememberedImageModelId('my-channel', { getItem: () => null }), '')
    assert.equal(readRememberedImageModelId('my-channel', { getItem: () => 'not json' }), '')
    assert.equal(readRememberedImageModelId('my-channel', { getItem: () => JSON.stringify({}) }), '')
    assert.equal(readRememberedImageModelId('', { getItem: () => JSON.stringify({ model: 'rich' }) }), '')
    assert.equal(readRememberedImageModelId('my-channel', null), '')
  })
})

describe('Scene Plan workspace control', () => {
  test('offers Auto, the published values, No limit, and Custom', () => {
    assert.match(scenePlan, /<option value="auto">Auto · \{\{ autoPromptCharCapLabel \}\}<\/option>/)
    assert.match(scenePlan, /<option value="none">No limit<\/option>/)
    assert.match(scenePlan, /v-for="cap in publishedPromptCharCaps"/)
    assert.match(scenePlan, /<option value="custom">Custom…<\/option>/)
    // The options come from the catalogue, not from a list in the page.
    assert.match(scenePlan, /promptCharCapOptions\(usableImageModels\.value\)/)
    assert.doesNotMatch(scenePlan, /PROMPT_CHAR_CAP_PRESETS|\[2000, *4000, *8000\]/)
  })

  test('the intended image model shows its published limit at the point of choosing', () => {
    assert.match(scenePlan, /v-for="model in usableImageModels"/)
    assert.match(scenePlan, /\{\{ model\.display_name \}\} · \{\{ imageModelCapLabel\(model\) \}\}/)
    assert.match(scenePlan, /:title="imageModelCapHint\(model\)"/)
    assert.match(scenePlan, /return cap \? `up to \$\{cap\.toLocaleString\(\)\} characters` : 'prompt limit not published'/)
  })

  test('the intended model is a writing hint, not a render decision', () => {
    assert.match(scenePlan, /does not change what Scene Review is set to/)
    // Seeded from the project's existing selection, never written back.
    assert.match(scenePlan, /readRememberedImageModelId\(slug\.value, window\.localStorage\)/)
    assert.doesNotMatch(scenePlan, /scene-review-genstudio[^\n]*setItem/)
  })

  test('every generated prompt is counted and an overrun is amber, not blocking', () => {
    assert.match(scenePlan, /class="prompt-char-badge"/)
    assert.match(scenePlan, /:class="`is-\$\{scenePromptLengthTone\(scene\)\}`"/)
    assert.match(scenePlan, /\{\{ scenePromptLengthLabel\(scene\) \}\} chars/)
    assert.match(scenePlan, /v-if="scenePromptLength\(scene\)\.overCap" class="prompt-cap-notice"/)
    assert.match(scenePlan, /Saved in full — you can shorten it, raise the\s+limit, or render it as-is\./)
    // The warning never disables generation or rendering.
    assert.doesNotMatch(scenePlan, /:disabled="[^"]*overCap/)
    assert.doesNotMatch(scenePlan, /:disabled="[^"]*promptCharCap/)
  })

  test('the resolved ceiling travels with every prompt request', () => {
    const promptStage = scenePlan.slice(scenePlan.indexOf('async function runPromptStage'), scenePlan.indexOf('/** Returns the tracked job'))
    assert.match(promptStage, /preset_id: presetId/,
      'the visual stage sends the exact applied preset that owns its character-cap selection')
    assert.doesNotMatch(promptStage, /prompt_char_cap:/,
      'the stage must not overlay mutable page state on that accepted preset')
    assert.match(scenePlan, /prompt_char_cap: effectivePromptCharCap\.value \|\| undefined,/)
  })

  test('the choice round-trips through the plan preset as a SELECTION', () => {
    assert.match(scenePlan, /intended_image_model: form\.value\.intended_image_model,/)
    assert.match(scenePlan, /prompt_char_cap: form\.value\.prompt_char_cap,/)
    assert.match(scenePlan, /setPromptCharCapSetting\(form\.value\.prompt_char_cap\)/)
    // A resolved catalogue number is never persisted.
    assert.doesNotMatch(scenePlan, /prompt_char_cap: effectivePromptCharCap\.value,\n/)
  })

  test('it is framed as a ceiling, not a length to fill', () => {
    assert.match(scenePlan, /A ceiling, not a length to reach/)
    assert.match(scenePlan, /Nothing is ever shortened for you/)
  })
})

describe('Thumbnail prompts control', () => {
  test('the ceiling resolves silently from the remembered image model — no picker on the page', () => {
    assert.doesNotMatch(imagePrompts, /publishedPromptCharCaps|Prompt character limit|Intended image model/)
    assert.match(imagePrompts, /resolvePromptCharCap\(normalizePromptCharCapSetting\(form\.thumbnail\.prompt_char_cap\), intendedImageModelCap\.value\)/)
    assert.match(imagePrompts, /readRememberedImageModelId\(slug\.value, window\.localStorage\)/)
  })

  test('the SELECTION and the model travel — never a number resolved here', () => {
    // The bulk run carries the selection and the image model it was chosen
    // for; the backend resolves the ceiling against the LIVE catalogue, so it
    // follows the model instead of freezing at the moment the page loaded.
    assert.match(imagePrompts, /intended_image_model: form\.thumbnail\.intended_image_model,/)
    assert.match(imagePrompts, /prompt_char_cap: form\.thumbnail\.prompt_char_cap,/)
    assert.doesNotMatch(imagePrompts, /prompt_char_cap: effectivePromptCharCap\.value/,
      'a number resolved in the browser must never be what a request carries')
    // The single-row rewrite carries them too.
    assert.match(reviewPanel, /prompt_char_cap: props\.thumbnailPromptCapSetting,/)
    assert.match(reviewPanel, /intended_image_model: props\.thumbnailIntendedImageModel,/)
    assert.doesNotMatch(reviewPanel, /prompt_char_cap: props\.thumbnailPromptCap \|\|/,
      'a number resolved in the browser must never be what a request carries')
    // The RESOLVED figure is display only: the row's character counter.
    assert.match(imagePrompts, /:thumbnail-prompt-cap="effectivePromptCharCap \|\| null"/)
    assert.match(imagePrompts, /:thumbnail-prompt-cap-setting="form\.thumbnail\.prompt_char_cap"/)
    assert.match(imagePrompts, /:thumbnail-intended-image-model="form\.thumbnail\.intended_image_model"/)
  })

  test('the catalogue is read once, not fetched again for the ceiling', () => {
    assert.equal(imagePrompts.match(/useGenStudioImageModels\(\)/g)?.length, 1)
    assert.equal(scenePlan.match(/useGenStudioImageModels\(\)/g)?.length, 1)
  })

  test('an over-ceiling row is amber and still fully editable', () => {
    assert.match(reviewRow, /Over the ceiling is AMBER, never red/)
    assert.match(reviewRow, /\.prr-chars-over\s*\{[^}]*var\(--warning\)/)
    assert.doesNotMatch(reviewRow, /\.prr-chars-over\s*\{[^}]*rgba\(220,38,38/)
    assert.match(reviewRow, /Nothing was shortened/)
    // Saving and regenerating stay enabled regardless of length.
    assert.doesNotMatch(reviewRow, /:disabled="[^"]*charStatusClass/)
    assert.doesNotMatch(reviewRow, /:disabled="[^"]*draftPromptLen *>/)
  })
})
