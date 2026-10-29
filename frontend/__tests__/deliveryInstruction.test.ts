/**
 * Delivery / emotion on the Audio Generator (owner, 2026-10-29).
 *
 * "Add the emotion setting" for cloned voices. There is no app-wide list of
 * emotions and no dropdown: each model's own catalogue row says whether it
 * takes a free-text delivery instruction, and carries that model's own guidance.
 *
 * The page reaches it (source assertions, this repo's established style for page
 * wiring) and the two pure helpers it uses are exercised for real:
 *   - shown and sent when the model publishes the control;
 *   - hidden, with one line of reason, and never sent when it does not;
 *   - re-checked on every model change, and cleared when the new model has none;
 *   - the published length is the only limit shown or applied;
 *   - the model's guidance is displayed exactly as published (and nothing when
 *     none was published);
 *   - the setting is in the preset, and the take's provenance shows it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  resolveDeliveryInstructionText,
  type GenStudioDeliveryInstructionControl,
} from '../utils/tts-controls'

const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/audio.vue', import.meta.url)), 'utf8')
const panel = readFileSync(fileURLToPath(new URL('../components/DeliveryInstructionPanel.vue', import.meta.url)), 'utf8')
const selector = readFileSync(fileURLToPath(new URL('../components/AudioChapterSelector.vue', import.meta.url)), 'utf8')

function control(overrides: Partial<GenStudioDeliveryInstructionControl> = {}): GenStudioDeliveryInstructionControl {
  return { label: 'Delivery / emotion', max_length: 500, guidance: null, ...overrides }
}

test('nothing is sent when the model publishes no control, whatever is in the form', () => {
  assert.equal(resolveDeliveryInstructionText(null, 'read it warmly'), '')
  assert.equal(resolveDeliveryInstructionText(undefined, 'read it warmly'), '')
})

test('an empty box sends nothing, so the model keeps its own reading', () => {
  assert.equal(resolveDeliveryInstructionText(control(), ''), '')
  assert.equal(resolveDeliveryInstructionText(control(), '  \n '), '')
})

test('the published limit is the only limit applied, and trimming is not a limit', () => {
  // Cut to 9 code points, then the trailing space at the cut is trimmed: 8 visible characters.
  assert.equal(resolveDeliveryInstructionText(control({ max_length: 9 }), ' warm and slow '), 'warm and')
  const unlimited = control({ max_length: null })
  assert.equal(resolveDeliveryInstructionText(unlimited, 'a much longer direction than any limit'), 'a much longer direction than any limit')
  // Code points, not UTF-16 units: a surrogate pair is never split in half.
  assert.equal(resolveDeliveryInstructionText(control({ max_length: 2 }), '🙂🙂🙂'), '🙂🙂')
})

test('the box is drawn only when the selected model publishes the control', () => {
  assert.match(page, /<DeliveryInstructionPanel[\s\S]{0,200}v-if="deliveryControl"/)
  assert.match(page, /v-model="form\.delivery_instruction"/)
  assert.match(page, /:control="deliveryControl"/)
  // Read from the SELECTED model's own row, so it follows every catalogue read.
  assert.match(page, /const deliveryControl = computed\(\(\) => selectedTtsModel\.value\?\.delivery_instruction \?\? null\)/)
})

test('a model that publishes none hides the setting and says why, in one line', () => {
  assert.match(page, /v-else-if="deliveryUnsupported"/)
  assert.match(page, /is not available on \{\{ selectedTtsModel\?\.display_name \}\}/)
  assert.match(page, /so none is shown and none is sent/)
  assert.match(page, /const deliveryUnsupported = computed\(\(\) => !!selectedTtsModel\.value && !deliveryControl\.value\)/)
})

test('a model change re-checks the setting, then clears or re-clamps it and says so', () => {
  assert.match(page, /watch\(\[\(\) => selectedTtsModel\.value\?\.id, deliveryControl\], \(\[modelId, control\]\)/)
  assert.match(page, /if \(!control\) \{[\s\S]{0,400}form\.delivery_instruction = ''/)
  assert.match(page, /does not take a delivery\/emotion instruction, so it was cleared/)
  assert.match(page, /const kept = resolveDeliveryInstructionText\(control, form\.delivery_instruction\)/)
  assert.match(page, /takes at most \$\{[^}]*max_length/)
})

test('the request carries the resolved text only, never the raw box', () => {
  const payload = page.slice(page.indexOf('function audioRequestPayload'))
  const body = payload.slice(0, payload.indexOf('\n}\n'))
  // Removed from the spread form, then added back resolved. An instruction the
  // selected model does not publish cannot leave on the spread.
  assert.match(body, /const \{ controls: _controls, delivery_instruction: _delivery, \.\.\.rest \} = form/)
  assert.match(body, /if \(resolvedDeliveryInstruction\.value\) payload\.delivery_instruction = resolvedDeliveryInstruction\.value/)
  assert.match(page, /const resolvedDeliveryInstruction = computed\(\(\) =>\s*resolveDeliveryInstructionText\(deliveryControl\.value, form\.delivery_instruction\)\)/)
})

test('the model publishes the limit shown at the point of choosing', () => {
  assert.match(panel, /:maxlength="control\.max_length \?\? undefined"/)
  assert.match(panel, /control\.max_length\.toLocaleString\(\) \}\} characters/)
})

test('the model’s own guidance is shown beside the box — text, examples, language and inline events', () => {
  assert.match(panel, /v-if="guidance" class="delivery-guidance"/)
  assert.match(panel, /guidance\.kind/)
  assert.match(panel, /guidance\.text/)
  assert.match(panel, /Example instructions/)
  assert.match(panel, /v-for="\(example, index\) in guidance\.examples"/)
  assert.match(panel, /<span class="delivery-guidance-label">Language<\/span> \{\{ guidance\.languageRule \}\}/)
  assert.match(panel, /Inline vocal events/)
  assert.match(panel, /v-for="\(event, index\) in guidance\.inlineEvents"/)
  // The Hub's own event fields: the syntax, what it does, and where it may go.
  assert.match(panel, /\{\{ event\.meaning \}\}/)
  assert.match(panel, /v-if="event\.where"/)
  assert.match(panel, /guidance\.engineForm/)
  assert.match(panel, /guidance\.note/)
  assert.match(panel, /guidance\.sourceUrl/)
  // Guidance comes from the control only: no fallback text, no placeholder, no
  // example of Story Studio's own anywhere in this component.
  assert.match(panel, /const guidance = computed\(\(\) => props\.control\?\.guidance \?\? null\)/)
  assert.doesNotMatch(panel, /placeholder=/)
})

test('inline vocal events are never inserted into a script', () => {
  assert.match(panel, /Story Studio never inserts them into a script/)
  // The generator never writes the instruction into narrated text.
  const generator = readFileSync(fileURLToPath(new URL('../../electron/server/generators/audio.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(generator, /chunkText\s*\+\s*deliveryInstruction|deliveryInstruction\s*\+\s*chunkText/)
})

test('the preset carries it — the whole form is the snapshot, and it is not excluded', () => {
  const presetStart = page.indexOf('const audioPresets = usePresets')
  const presets = page.slice(presetStart, page.indexOf('/**', page.indexOf('excludeKeys', presetStart)))
  assert.match(presets, /snapshot: \(\) => \(\{ form: \{ \.\.\.form \} \}\)/)
  assert.match(presets, /excludeKeys: \['episode_id', 'episodeId', 'episode', 'title', 'sections', 'max_chunk_chars'\]/)
  assert.doesNotMatch(presets, /delivery_instruction/)
})

test('a remembered form restores it, and the field starts empty', () => {
  assert.match(page, /include: \['model', 'voice', 'speed', 'controls', 'delivery_instruction'\]/)
  assert.match(page, /delivery_instruction: '',/)
})

test('the take says how it was directed, beside the engine and voice', () => {
  assert.match(selector, /provenance\.delivery_instruction \? `Delivery: \$\{provenance\.delivery_instruction\}` : ''/)
  assert.match(selector, /delivery_instruction\?: string/)
})
