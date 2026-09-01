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
  CREDIT_BASIS_LABEL,
  describeChatRate,
  describeImageBatchEstimate,
  describeImageModelRate,
  describeImageUnitCost,
  describeMusicUnitCost,
  describeQuotedCost,
  describeQuotedTotal,
  describeActualCost,
  describeVideoModelRate,
  describeWebResearchRate,
} from '../utils/genstudio-credit-cost.js'
import { variantsForVideoOperation, videoVariantKey } from '../utils/genstudio-video-variants.js'

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

test('image model selection summarizes the complete published output-size rate range', () => {
  const variable = {
    display_name: 'GPT Image 2',
    chargeable: true,
    credits_per_image: 20,
    output_options: [
      { ...ONE_K_16_9, credits_per_image: 20 },
      { ...TWO_K_16_9, credits_per_image: 29 },
    ],
  }
  const display = describeImageModelRate(variable)
  assert.equal(display.basis, 'rate')
  assert.equal(display.text, '20–29 credits / image by output size')
  assert.match(display.title, /exact published rate for the output size/)

  const fixed = describeImageModelRate({
    display_name: 'FLUX.2 Klein',
    chargeable: true,
    credits_per_image: 9,
    output_options: [{ ...ONE_K_16_9, credits_per_image: 9 }],
  })
  assert.equal(fixed.text, '9 credits / image')

  const unknownReferencePrice = describeImageModelRate(variable, { referenceGuided: true })
  assert.equal(unknownReferencePrice.basis, 'unpublished')
  assert.match(unknownReferencePrice.text, /not reported/i)
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

test('an image model whose chargeability is not published is not shown as free', () => {
  const unknown = describeImageUnitCost({ display_name: 'Unknown', credits_per_image: null }, null)
  assert.equal(unknown.basis, 'unpublished')
  assert.match(unknown.text, /Price not reported/)
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

/**
 * Music sale pricing — the owner's ruling, verbatim: "use the full price so
 * the customer see the full price with a discount tag on it."
 *
 * Music publishes the same idea images publish, under different field names.
 * The backend has parsed all four of them correctly the whole time; nothing
 * displayed any of it, so a sale was invisible in both directions. These
 * assertions are deliberately the same shape as the image promotion test
 * above, because the two are meant to render the same way.
 */
test('a music sale shows the full price with the discount tag, not the sale price alone', () => {
  const onSale = {
    display_name: 'Suno v5',
    credits_per_request: 50,
    standard_credits: 60,
    sale_credits: 50,
    sale_ends_at: '2026-09-01T00:00:00Z',
    sale_disclaimer: 'Launch sale',
  }
  const display = describeMusicUnitCost(onSale)
  assert.equal(display.basis, 'rate')
  assert.match(display.text, /50 credits \/ song request/)
  assert.match(display.text, /was 60 credits/, 'the full price has to be on screen, not only the sale price')
  assert.match(display.title, /Launch sale/)
  assert.match(display.title, /undiscounted price is 60 credits/)
})

test('no sale means no discount tag, and a list price equal to the charge is not a sale', () => {
  const listOnly = { display_name: 'Suno v5', credits_per_request: 50, standard_credits: 50, sale_credits: null }
  const display = describeMusicUnitCost(listOnly)
  assert.equal(display.text, '50 credits / song request')
  assert.doesNotMatch(display.text, /was/, 'a discount tag on no discount is a lie about the price')
})

test('an unpriced music model says so rather than showing a locally derived figure', () => {
  const unpriced = describeMusicUnitCost({ display_name: 'Suno v5', credits_per_request: null })
  assert.equal(unpriced.basis, 'unpublished')
  assert.match(unpriced.text, /Price not reported/)
  assert.equal(describeMusicUnitCost(null).basis, 'unpublished')
})

test('a reference-guided run uses its published effective I2I rate, not a surcharge', () => {
  const withReferenceRate = { display_name: 'Fast', chargeable: true, credits_per_image: 4, reference_generation_credits: 9 }
  const guided = describeImageUnitCost(withReferenceRate, null, { referenceGuided: true })
  assert.equal(guided.text, '9 credits / image')
  assert.doesNotMatch(guided.text, /\+|surcharge/i)
  assert.match(guided.title, /reference-guided image/)
  assert.doesNotMatch(describeImageUnitCost(withReferenceRate, null).text, /reference/)
  const without = { display_name: 'Fast', chargeable: true, credits_per_image: 4 }
  assert.equal(describeImageUnitCost(without, null, { referenceGuided: true }).basis, 'unpublished')
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

test('a chat model with no published token rates says Price not reported, while a published zero stays zero', () => {
  assert.equal(describeChatRate({ display_name: 'Unknown' }).basis, 'unpublished')
  const zero = describeChatRate({
    display_name: 'Free input',
    input_credits_per_million_tokens: 0,
    output_credits_per_million_tokens: 3,
  })
  assert.equal(zero.basis, 'rate')
  assert.match(zero.text, /0 credits \/ 1M input tokens/)
})

test('video model selection summarizes the complete published variant rate range', () => {
  const display = describeVideoModelRate({
    display_name: 'Motion Lite',
    variants: [
      { duration_seconds: 5, resolution: '720p', credits_per_video: 4, minimum_credits: 1 },
      { duration_seconds: 10, resolution: '1080p', credits_per_video: 12, minimum_credits: 2 },
    ],
  })
  assert.equal(display.basis, 'rate')
  assert.equal(display.text, '4–12 credits / clip by duration and resolution')
  assert.match(display.title, /exact published rate for the duration and resolution you choose/)

  const missing = describeVideoModelRate({
    display_name: 'Unpriced Motion',
    variants: [{ duration_seconds: 5, resolution: '720p' }],
  })
  assert.equal(missing.basis, 'unpublished')
  assert.match(missing.text, /not reported/i)
})

test('Motion Review only uses image-to-video variants and keeps their operation in the selection key', () => {
  const variants = [
    { operation: 'text-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 1, minimum_credits: 1, price_version: 't2v-v1' },
    { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 9, minimum_credits: 3, price_version: 'i2v-v1' },
  ]
  const i2v = variantsForVideoOperation(variants, 'image-to-video')
  assert.deepEqual(i2v, [variants[1]])
  assert.equal(describeVideoModelRate({ display_name: 'Mixed Motion', variants: i2v }).text, '9 credits / clip')
  assert.equal(videoVariantKey(i2v[0]!), 'image-to-video:5:720p')
})

test('web research selection states published request and search rates without deriving a total', () => {
  const display = describeWebResearchRate({
    display_name: 'Researcher',
    credits_per_request: 2,
    credits_per_search: 0.5,
  })
  assert.equal(display.basis, 'rate')
  assert.equal(display.text, '2 credits / request · 0.5 credits / search')
  assert.match(display.title, /no up-front total/)
  assert.equal(describeWebResearchRate({ display_name: 'Unknown' }).basis, 'unpublished')
})

test('quotes and actuals are labelled as such, and a missing actual is not reconstructed', () => {
  assert.equal(describeQuotedCost(12).basis, 'quote')
  assert.match(describeQuotedCost(12).text, /Quoted 12 credits/)
  assert.equal(describeActualCost(7).basis, 'actual')
  assert.match(describeActualCost(7).text, /Charged 7 credits/)
  assert.equal(describeActualCost(null).basis, 'unpublished')
  assert.match(describeActualCost(null).text, /not reported/i)
})

test('a narration submitted as several jobs is a SUM OF QUOTES, never an estimate', () => {
  // Three requests that will actually be sent, each priced by GenStudio.
  const parts = [{ credits: 40 }, { credits: 40 }, { credits: 12.5 }]
  const display = describeQuotedTotal(parts, 'this narration')

  assert.equal(display.basis, 'quoted-total')
  assert.equal(CREDIT_BASIS_LABEL['quoted-total'], 'Quoted total')
  // The figure is the plain sum of GenStudio's answers — nothing derived.
  assert.match(display.text, /Quoted 92\.5 credits/)
  // The reader is told it is several jobs, and how many.
  assert.match(display.text, /sum of 3 GenStudio quotes/)
  assert.match(display.title, /3 separate GenStudio jobs/)
  assert.match(display.title, /per-job/)
  assert.match(display.title, /not an estimate/)
  // The vocabulary must not blur into the estimate wording used for batches.
  assert.doesNotMatch(display.text, /Estimate/i)
  assert.notEqual(display.basis, 'estimate')

  // One job is one quote — no "sum of 1" theatre.
  assert.equal(describeQuotedTotal([{ credits: 12 }]).basis, 'quote')
  // Nothing to add up is not a total of zero.
  assert.equal(describeQuotedTotal([]).basis, 'unpublished')
})

test('a job GenStudio did not price makes the TOTAL unavailable — it never counts as free', () => {
  // The S1 defect class in its display form. A part whose `credits` GenStudio
  // did not publish used to contribute 0 to a figure labelled "sum of N
  // GenStudio quotes": a total that was quietly too low while still claiming
  // every job had been priced. One unpriced part means there is no total.
  for (const missing of [null, undefined]) {
    const display = describeQuotedTotal([{ credits: 40 }, { credits: missing }], 'this narration')
    assert.equal(display.basis, 'unpublished')
    assert.match(display.text, /not reported/i)
    assert.doesNotMatch(display.text, /\b40\b/)
    assert.doesNotMatch(display.text, /sum of/i)
  }
})

test('an unpublished reference effective rate does not price reference guidance as plain generation', () => {
  const priced = { chargeable: true, credits_per_image: 4 }
  // No `reference_generation_credits` anywhere: the full reference-guided
  // rate is unknown, so plain-generation pricing must not leak into this UI.
  const guided = describeImageBatchEstimate(priced as any, null, 10, { referenceGuided: true })
  assert.equal(guided.basis, 'unpublished')
  assert.doesNotMatch(guided.text, /Estimate/i)
  // Published reference rate → the estimate is stated at that rate, exactly.
  const withReferenceRate = describeImageBatchEstimate(
    { ...priced, reference_generation_credits: 9 } as any, null, 10, { referenceGuided: true },
  )
  assert.equal(withReferenceRate.basis, 'estimate')
  assert.match(withReferenceRate.text, /Estimate 90 credits/)
  assert.match(withReferenceRate.text, /9 credits \/ image × 10/)
})

// ── Source guards ─────────────────────────────────────────────────────────

test('no image surface invents a resolution ladder or a fallback ratio', () => {
  for (const file of [
    '../utils/genstudio-output-options.ts',
    '../components/ImageOutputOptionPicker.vue',
    '../components/ProjectStyleLibrary.vue',
    '../components/ContentPackStyleLibraryModal.vue',
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
