import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  defaultOutputOption,
  describeOutputOption,
  findOutputOption,
  outputOptionsForRatio,
  publishedOutputOptions,
  publishedOutputRatios,
  reconcileOutputOption,
} from '../utils/genstudio-output-options.js'
import {
  describeChatRate,
  describeImageBatchEstimate,
  describeImageUnitCost,
  describeQuotedCost,
  describeActualCost,
} from '../utils/genstudio-credit-cost.js'

const ONE_K_16_9 = { resolution: '1K', aspect_ratio: '16:9', width: 1920, height: 1080, is_default: true, credits_per_image: 4 }
const ONE_K_1_1 = { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: false, credits_per_image: 4 }
const TWO_K_16_9 = { resolution: '2K', aspect_ratio: '16:9', width: 2560, height: 1440, is_default: false, credits_per_image: 9 }

const model = {
  display_name: 'GenStudio Image Fast',
  default_resolution: '1K',
  default_aspect_ratio: '16:9',
  output_options: [ONE_K_16_9, ONE_K_1_1, TWO_K_16_9],
}

test('a model publishing no output options gets no resolution control at all', () => {
  const bare = { display_name: 'Bare', default_aspect_ratio: '16:9' }
  assert.deepEqual(publishedOutputOptions(bare), [])
  assert.equal(defaultOutputOption(bare), null)
  // Degrades to today's behaviour: nothing to keep, nothing to announce.
  const result = reconcileOutputOption({ resolution: '2K', aspect_ratio: '16:9' }, bare)
  assert.deepEqual(result, { option: null, needsChoice: false, notice: '' })
})

test('rows are never recombined into a ratio list crossed with a resolution list', () => {
  // 2K exists only at 16:9. Asking for 1:1 must not manufacture a 2K 1:1 row.
  assert.deepEqual(outputOptionsForRatio(model, '1:1').map(row => row.resolution), ['1K'])
  assert.deepEqual(publishedOutputRatios(model), ['16:9', '1:1'])
  assert.equal(findOutputOption(model, { resolution: '2K', aspect_ratio: '1:1' }), null)
})

test('the default row is the flagged one, then the published default pair — never the first row', () => {
  assert.equal(defaultOutputOption(model), ONE_K_16_9)

  const unflagged = {
    display_name: 'Unflagged',
    default_resolution: '2K',
    default_aspect_ratio: '16:9',
    output_options: [{ ...ONE_K_1_1 }, { ...TWO_K_16_9 }],
  }
  assert.equal(defaultOutputOption(unflagged)?.resolution, '2K')

  // Nothing flagged and no matching published pair: no row is chosen by
  // position, because "first row wins" silently bills an unchosen size.
  const undecidable = { display_name: 'Undecidable', output_options: [{ ...ONE_K_1_1 }, { ...TWO_K_16_9 }] }
  assert.equal(defaultOutputOption(undecidable), null)
  const result = reconcileOutputOption(null, undecidable)
  assert.equal(result.option, null)
  assert.equal(result.needsChoice, true)
  assert.match(result.notice, /publishes no default output size/)
})

test('a model switch keeps a pair the new model publishes, silently', () => {
  const result = reconcileOutputOption({ resolution: '2K', aspect_ratio: '16:9' }, model)
  assert.equal(result.option, TWO_K_16_9)
  assert.equal(result.notice, '')
  assert.equal(result.needsChoice, false)
})

test('a model switch that drops the pair falls back to the default AND says so', () => {
  const narrower = {
    display_name: 'GenStudio Image Wide',
    default_resolution: '1K',
    default_aspect_ratio: '16:9',
    output_options: [ONE_K_16_9],
  }
  const result = reconcileOutputOption({ resolution: '2K', aspect_ratio: '16:9' }, narrower)
  assert.equal(result.option, ONE_K_16_9)
  assert.match(result.notice, /does not publish 2K at 16:9/)
  assert.match(result.notice, /Switched to its default/)
  // The sentence names the real output, not just the label.
  assert.match(result.notice, /1,920×1,080/)
})

test('describeOutputOption shows the real output, not a marketing label', () => {
  assert.equal(describeOutputOption(TWO_K_16_9), '2K · 16:9 · 2,560×1,440')
})

test('image cost comes from the OPTION price, with the model figure only as fallback', () => {
  const priced = { display_name: 'Fast', chargeable: true, credits_per_image: 4 }
  const perRow = describeImageUnitCost(priced, TWO_K_16_9)
  assert.equal(perRow.basis, 'rate')
  assert.match(perRow.text, /9 credits \/ image/)
  // No option: the model-level figure stands in, and only then.
  assert.match(describeImageUnitCost(priced, null).text, /4 credits \/ image/)
})

test('an unpublished price is reported as unpublished, never filled in', () => {
  const unpriced = { display_name: 'Mystery', chargeable: true, credits_per_image: null }
  const display = describeImageUnitCost(unpriced, null)
  assert.equal(display.basis, 'unpublished')
  assert.match(display.text, /not reported/i)
  assert.doesNotMatch(display.text, /\d/)
})

test('chargeable:false is shown as included, not as a price about to be charged', () => {
  const free = { display_name: 'Free tier', chargeable: false, credits_per_image: 4 }
  const display = describeImageUnitCost(free, ONE_K_16_9)
  assert.equal(display.basis, 'free')
  assert.match(display.text, /No credit charge/)
})

test('promotions show the discounted price alongside the undiscounted one', () => {
  const promo = {
    display_name: 'Fast',
    chargeable: true,
    credits_per_image: 4,
    base_credits_per_image: 6,
    promotion_name: 'Launch week',
    promotion_discount_percent: 33.3,
  }
  const display = describeImageUnitCost(promo, null)
  assert.match(display.text, /was 6 credits/)
  assert.match(display.title, /Launch week/)
})

test('a reference-guided run adds the published surcharge, and only when published', () => {
  const withSurcharge = { display_name: 'Fast', chargeable: true, credits_per_image: 4, reference_generation_credits: 2 }
  assert.match(describeImageUnitCost(withSurcharge, null, { referenceGuided: true }).text, /\+ 2 credits reference/)
  assert.doesNotMatch(describeImageUnitCost(withSurcharge, null).text, /reference/)
  const without = { display_name: 'Fast', chargeable: true, credits_per_image: 4 }
  assert.doesNotMatch(describeImageUnitCost(without, null, { referenceGuided: true }).text, /reference/)
})

test('a batch total is labelled an estimate and keeps the unit rate visible', () => {
  const priced = { display_name: 'Fast', chargeable: true, credits_per_image: 4 }
  const display = describeImageBatchEstimate(priced, null, 25)
  assert.equal(display.basis, 'estimate')
  assert.match(display.text, /Estimate 100 credits/)
  assert.match(display.text, /4 credits \/ image × 25/)
  assert.match(display.title, /estimate, not a charge GenStudio has quoted/)
  // No published price means no estimate to derive from it either.
  assert.equal(describeImageBatchEstimate({ chargeable: true, credits_per_image: null }, null, 25).basis, 'unpublished')
})

test('chat shows a rate and refuses to invent a total', () => {
  const chat = {
    display_name: 'GenStudio Writer',
    chargeable: true,
    input_credits_per_million_tokens: 30,
    output_credits_per_million_tokens: 150,
  }
  const display = describeChatRate(chat)
  assert.equal(display.basis, 'rate')
  assert.match(display.text, /1M input tokens/)
  assert.match(display.text, /1M output tokens/)
  assert.match(display.title, /no up-front total/)
  // A rate is never presented as an amount that will be charged.
  assert.doesNotMatch(display.text, /Estimate|Total/i)
})

test('quotes and actuals are labelled as such, and a missing actual is not reconstructed', () => {
  assert.equal(describeQuotedCost(12).basis, 'quote')
  assert.match(describeQuotedCost(12).text, /Quoted 12 credits/)
  assert.equal(describeActualCost(7).basis, 'actual')
  assert.match(describeActualCost(7).text, /Charged 7 credits/)
  assert.equal(describeActualCost(null).basis, 'unpublished')
  assert.match(describeActualCost(null).text, /not reported/i)
})

// ── Source guards ─────────────────────────────────────────────────────────

test('no image surface invents a resolution ladder or a fallback ratio', () => {
  for (const file of [
    '../utils/genstudio-output-options.ts',
    '../components/ImageOutputOptionPicker.vue',
    '../components/ProjectStyleLibrary.vue',
    '../components/BuiltInStyleLibraryModal.vue',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\['1K'|'2K',\s*'4K'/, file)
    assert.doesNotMatch(source, /: \['16:9'\]/, file)
  }
})

test('the script page prices from the live catalogue, not a hardcoded model rate', () => {
  const source = readFileSync(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /PRICE_INPUT_PER_MTOK|PRICE_OUTPUT_PER_MTOK/)
  assert.doesNotMatch(source, /Sonnet pricing/)
  assert.match(source, /useGenStudioChatModels/)
  assert.match(source, /describeChatRate/)
})

test('the image submit paths send a chosen resolution and stop inventing a size beside it', () => {
  const images = readFileSync(new URL('../pages/projects/[slug]/images.vue', import.meta.url), 'utf8')
  assert.match(images, /params\.resolution = outputOption\.value\.resolution/)
  assert.match(images, /ImageOutputOptionPicker/)
  const pool = readFileSync(new URL('../pages/projects/[slug]/image-pool.vue', import.meta.url), 'utf8')
  assert.match(pool, /resolution: genOutputOption\.value\?\.resolution \|\| undefined/)
})

test('the model picker shows the reference and seed limits it already enforces', () => {
  const source = readFileSync(new URL('../components/ImageModelPicker.vue', import.meta.url), 'utf8')
  assert.match(source, /accepts up to \$\{max\}/)
  assert.match(source, /needs at least \$\{min\}/)
  assert.match(source, /publishes no seed support/)
  assert.match(source, /publishes no support for reference images/)
  // A published "no" is the model's, not a Story Studio restriction.
  assert.match(source, /not a Story Studio restriction/)
})
