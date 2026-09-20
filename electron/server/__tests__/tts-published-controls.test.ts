/**
 * The property this feature is FOR: a control Story Studio has never seen
 * renders and submits correctly, with no code change.
 *
 * GenStudio publishes `TTSModelResponse.controls[]` per model — name, label,
 * type, bounds, step, default, description. Story Studio reads that list and
 * sends back exactly the names on it. So every fixture here is FABRICATED: the
 * names, ranges and defaults below exist nowhere in the catalogue and nowhere
 * in the application. If any of them ever needed a corresponding line of
 * application code to make this file pass, the feature would be built wrong.
 *
 * These tests also pin the idempotency decision, because GenStudio hashes
 * `controls` into its own identity: our key must move when a control value
 * moves, and must NOT move for a model that publishes none.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildGenStudioSubmission } from '../lib/genstudio-client.js'
import {
  coerceTtsControlValue,
  defaultTtsControlValue,
  hasTtsControlValues,
  isRenderableTtsControl,
  orderedTtsControlValues,
  parseTtsControlValues,
  parseTtsControls,
  resolveTtsControlValues,
} from '../lib/tts-controls.js'

/**
 * A catalogue row for a model that does not exist, publishing controls that do
 * not exist, with bounds nothing in this repo has any reason to know.
 */
function fabricatedControlsPayload() {
  return [
    {
      name: 'zephyr_bias',
      label: 'Zephyr bias',
      type: 'number',
      minimum: -4,
      maximum: 7.5,
      default: 1.25,
      step: 0.25,
      max_length: null,
      description: 'How far the reading leans windward.',
    },
    {
      name: 'lantern_mode',
      label: 'Lantern mode',
      type: 'boolean',
      minimum: null,
      maximum: null,
      default: true,
      step: null,
      max_length: null,
      description: 'Whether the narrator carries a lantern.',
    },
    {
      name: 'quay_directive',
      label: 'Quay directive',
      type: 'text',
      minimum: null,
      maximum: null,
      default: 'Read as if from a harbour wall.',
      step: null,
      max_length: 40,
      description: 'Plain-language delivery note.',
    },
  ]
}

const baseRequest = {
  modelId: 'model-fabricated',
  voiceId: 'voice-fabricated',
  text: 'A short line to submit.',
  speed: 1,
  supportsSpeed: true,
  minimumSpeed: 0.5,
  maximumSpeed: 2,
  maxInputCharacters: 5_000,
}

// ── Parsing ─────────────────────────────────────────────────────────────────

test('a fabricated control set is parsed verbatim, field for field', () => {
  const controls = parseTtsControls(fabricatedControlsPayload())
  assert.equal(controls.length, 3)
  assert.deepEqual(controls.map(control => control.name), ['zephyr_bias', 'lantern_mode', 'quay_directive'])
  assert.deepEqual(controls.map(control => control.type), ['number', 'boolean', 'text'])
  // The bounds are the catalogue's, unmodified — no rounding, no clamping to
  // some house range, no substituted default.
  assert.deepEqual(controls[0], {
    name: 'zephyr_bias',
    label: 'Zephyr bias',
    type: 'number',
    minimum: -4,
    maximum: 7.5,
    default: 1.25,
    step: 0.25,
    max_length: null,
    description: 'How far the reading leans windward.',
  })
  assert.equal(controls[1]!.default, true)
  assert.equal(controls[2]!.max_length, 40)
})

test('a model that publishes no controls yields none — never an invented set', () => {
  assert.deepEqual(parseTtsControls([]), [])
  assert.deepEqual(parseTtsControls(undefined), [])
  assert.deepEqual(parseTtsControls(null), [])
  assert.deepEqual(parseTtsControls({ stability: 0.5 }), [])
  assert.deepEqual(resolveTtsControlValues([], { anything: 1 }), {})
})

test('a published type this build does not know degrades safely — skipped, not fatal', () => {
  const controls = parseTtsControls([
    ...fabricatedControlsPayload(),
    {
      // GenStudio is free to add types. An older build must not crash, must not
      // guess a widget, and must not send a value it cannot bound.
      name: 'tide_curve',
      label: 'Tide curve',
      type: 'polyline',
      minimum: null,
      maximum: null,
      default: '0,0 1,1',
      step: null,
      max_length: null,
      description: 'A shape this build cannot draw.',
    },
  ])
  // It survives parsing, because it IS published…
  assert.equal(controls.length, 4)
  assert.equal(isRenderableTtsControl(controls[3]!), false)
  // …but it never reaches a request, because Story Studio cannot honour it.
  const resolved = resolveTtsControlValues(controls, { tide_curve: '2,2' })
  assert.deepEqual(Object.keys(resolved).sort(), ['lantern_mode', 'quay_directive', 'zephyr_bias'])
  assert.equal(coerceTtsControlValue(controls[3]!, '2,2'), undefined)
  assert.equal(defaultTtsControlValue(controls[3]!), undefined)
})

test('a row missing what identifies it is dropped rather than repaired', () => {
  const controls = parseTtsControls([
    { name: '', label: 'Nameless', type: 'number', default: 1 },
    { name: 'no_type', label: 'No type', type: '', default: 1 },
    // No published default: Story Studio would have to invent one, so it does
    // not render the control at all.
    { name: 'no_default', label: 'No default', type: 'number', minimum: 0, maximum: 1 },
    { name: 'kept', label: 'Kept', type: 'boolean', default: false },
  ])
  assert.deepEqual(controls.map(control => control.name), ['kept'])
})

// ── Values ──────────────────────────────────────────────────────────────────

test('defaults come from the model, and every value stays inside its published range', () => {
  const controls = parseTtsControls(fabricatedControlsPayload())

  // Nothing chosen → the model's own published defaults.
  assert.deepEqual(resolveTtsControlValues(controls), {
    zephyr_bias: 1.25,
    lantern_mode: true,
    quay_directive: 'Read as if from a harbour wall.',
  })

  // Chosen values are kept as chosen when they are inside the published range.
  assert.deepEqual(resolveTtsControlValues(controls, {
    zephyr_bias: -2.5,
    lantern_mode: false,
    quay_directive: 'Softer.',
  }), { zephyr_bias: -2.5, lantern_mode: false, quay_directive: 'Softer.' })

  // Outside it, they are clamped to the model's own bounds — never sent as-is.
  assert.equal(resolveTtsControlValues(controls, { zephyr_bias: 99 }).zephyr_bias, 7.5)
  assert.equal(resolveTtsControlValues(controls, { zephyr_bias: -99 }).zephyr_bias, -4)
  // Text is cut to the published ceiling, whatever that ceiling is.
  const long = resolveTtsControlValues(controls, { quay_directive: 'x'.repeat(500) }).quay_directive
  assert.equal(String(long).length, 40)

  // A value of the wrong shape falls back to the published default.
  assert.equal(resolveTtsControlValues(controls, { lantern_mode: 'yes' }).lantern_mode, true)
  assert.equal(resolveTtsControlValues(controls, { zephyr_bias: 'not a number' }).zephyr_bias, 1.25)
})

test('a name the selected model does not publish cannot ride along', () => {
  const controls = parseTtsControls(fabricatedControlsPayload())
  const resolved = resolveTtsControlValues(controls, {
    zephyr_bias: 2,
    // Left behind by another model, a saved project, or a preset.
    harbour_glow: 0.9,
    some_other_models_knob: 'carry me',
  })
  assert.deepEqual(Object.keys(resolved).sort(), ['lantern_mode', 'quay_directive', 'zephyr_bias'])
})

test('switching models drops the old set entirely and adopts the new defaults', () => {
  const first = parseTtsControls(fabricatedControlsPayload())
  const second = parseTtsControls([
    {
      name: 'gantry_pitch',
      label: 'Gantry pitch',
      type: 'number',
      minimum: 10,
      maximum: 20,
      default: 12,
      step: 1,
      max_length: null,
      description: 'Something else entirely.',
    },
  ])
  // Values tuned on the first model resolve to nothing but the second model's
  // own default — no overlap, no leftovers, no clamping of a foreign value.
  const chosen = resolveTtsControlValues(first, { zephyr_bias: 7, lantern_mode: false })
  assert.deepEqual(resolveTtsControlValues(second, chosen), { gantry_pitch: 12 })
  // And a model publishing none takes none of it.
  assert.deepEqual(resolveTtsControlValues([], chosen), {})
})

test('a controls map echoed back by GenStudio is read structurally, by no known name', () => {
  assert.deepEqual(
    parseTtsControlValues({ zephyr_bias: 1.25, lantern_mode: true, quay_directive: 'hi', bad: { nested: 1 } }),
    { zephyr_bias: 1.25, lantern_mode: true, quay_directive: 'hi' },
  )
  assert.deepEqual(parseTtsControlValues(null), {})
  assert.deepEqual(parseTtsControlValues([1, 2]), {})
})

// ── Submission and idempotency ──────────────────────────────────────────────

test('the fabricated controls are submitted, in a stable order', () => {
  const controls = parseTtsControls(fabricatedControlsPayload())
  const values = resolveTtsControlValues(controls, { zephyr_bias: 3.5 })
  const { body } = buildGenStudioSubmission({ ...baseRequest, controls: values })
  assert.deepEqual(body.controls, {
    lantern_mode: true,
    quay_directive: 'Read as if from a harbour wall.',
    zephyr_bias: 3.5,
  })
  // Order is by name, so the digest does not depend on catalogue ordering.
  assert.deepEqual(Object.keys(body.controls!), ['lantern_mode', 'quay_directive', 'zephyr_bias'])
  assert.deepEqual(
    orderedTtsControlValues({ b: 1, a: 2 }),
    orderedTtsControlValues({ a: 2, b: 1 }),
  )
  assert.deepEqual(Object.keys(orderedTtsControlValues({ b: 1, a: 2 })), ['a', 'b'])
})

/**
 * Pinned digests, recomputed once when `model_id` joined the submission body.
 *
 * GenStudio folds `controls` into its own idempotency identity, so ours has to
 * move with a control value — otherwise two runs at different settings collide
 * on our key and the first result replays for the second. `controls` joins the
 * digest only when it is non-empty (the `output_budget` / `resolution`
 * precedent), so a model that publishes none still hashes the shape it always
 * did, and a retry across THAT upgrade replays instead of paying twice.
 *
 * `model_id` is the opposite case and joins unconditionally: GenStudio sells
 * speech BY model, so the same script in the same voice at another model is
 * different work at a different rate and must never replay the other one's
 * result. That moved every key exactly once, here. It is safe to move because
 * work GenStudio already accepted is replayed from the key PERSISTED beside the
 * asset (`recoveryEntry.idempotency_key`, generators/audio.ts), never from a
 * recomputed one — only never-submitted work mints a key here.
 */
const SUBMISSION_KEYS = {
  withIdentity: 'story-tts-1dd8bd7b2ebf8ab54db14d5f3a04f6c24e282a9b2c566eac',
  withoutIdentity: 'story-tts-ce08c1ded4947a4bda94553195a828bc34f4b630b22e7cae',
}

test('no controls ⇒ a body carrying only the model, voice, text and speed', () => {
  const request = {
    modelId: 'model-alpha',
    voiceId: 'voice-alpha',
    text: 'Once upon a midnight dreary.',
    speed: 0.93,
    supportsSpeed: true,
    minimumSpeed: 0.5,
    maximumSpeed: 2,
    maxInputCharacters: 5_000,
    requestIdentity: 'demo:EP001:audio:intro_part1.mp3',
  }
  const withIdentity = buildGenStudioSubmission(request)
  assert.equal(withIdentity.idempotencyKey, SUBMISSION_KEYS.withIdentity)
  // `model_id` leads, because it is the product GenStudio prices. No `controls`
  // key at all when the model publishes none.
  assert.equal(
    JSON.stringify(withIdentity.body),
    JSON.stringify({
      model_id: 'model-alpha',
      voice_id: 'voice-alpha',
      text: 'Once upon a midnight dreary.',
      speed: 0.93,
    }),
  )
  assert.equal(Object.hasOwn(withIdentity.body, 'controls'), false)

  const bare = buildGenStudioSubmission({ ...request, speed: 1, requestIdentity: undefined })
  assert.equal(bare.idempotencyKey, SUBMISSION_KEYS.withoutIdentity)

  // An empty map is "publishes none", not "publishes an empty object".
  assert.equal(
    buildGenStudioSubmission({ ...request, controls: {} }).idempotencyKey,
    SUBMISSION_KEYS.withIdentity,
  )
  assert.equal(hasTtsControlValues({}), false)
  assert.equal(hasTtsControlValues({ zephyr_bias: 1 }), true)
})

test('the same script at another model is another request, never a replay', () => {
  const request = {
    modelId: 'model-alpha',
    voiceId: 'voice-alpha',
    text: 'Once upon a midnight dreary.',
    speed: 0.93,
    supportsSpeed: true,
    minimumSpeed: 0.5,
    maximumSpeed: 2,
    maxInputCharacters: 5_000,
    requestIdentity: 'demo:EP001:audio:intro_part1.mp3',
  }
  assert.notEqual(
    buildGenStudioSubmission(request).idempotencyKey,
    buildGenStudioSubmission({ ...request, modelId: 'model-beta' }).idempotencyKey,
  )
})

test('a submission without the selected model refuses here, in Story Studio\'s name', () => {
  assert.throws(
    () => buildGenStudioSubmission({ ...baseRequest, modelId: '' }),
    (error: Error) => {
      // GenStudio publishes the model id the generator already selected, so an
      // absent one at submission time is ours. Saying otherwise is what sent
      // three EP0067 diagnoses at the wrong repository.
      assert.match(error.message, /Story Studio did not carry the selected voice model/)
      assert.match(error.message, /Story Studio defect, not a GenStudio KH publication gap/)
      return true
    },
  )
})

test('a control value change moves the idempotency key; the same values reproduce it', () => {
  const controls = parseTtsControls(fabricatedControlsPayload())
  const key = (chosen: Record<string, unknown>) => buildGenStudioSubmission({
    ...baseRequest,
    requestIdentity: 'demo:EP001:audio:intro_part1.mp3',
    controls: resolveTtsControlValues(controls, chosen),
  }).idempotencyKey

  const atDefaults = key({})
  const nudged = key({ zephyr_bias: 3.5 })
  const toggled = key({ lantern_mode: false })
  const worded = key({ quay_directive: 'Read it flatter.' })

  const keys = [atDefaults, nudged, toggled, worded]
  assert.equal(new Set(keys).size, keys.length, 'two different control settings shared one replay key')
  // Deterministic: the same settings always produce the same key, so a lost
  // response reconnects to the paid job instead of submitting a second one.
  assert.equal(key({ zephyr_bias: 3.5 }), nudged)
  // A value clamped to the same effective setting is the SAME work, so it must
  // replay rather than mint a second key.
  assert.equal(key({ zephyr_bias: 999 }), key({ zephyr_bias: 7.5 }))
  // And once controls are in play, the key has left the no-controls one.
  assert.notEqual(atDefaults, SUBMISSION_KEYS.withIdentity)
})

// ── The rule itself ─────────────────────────────────────────────────────────

/**
 * Names retired with this change, plus ones the live catalogue happens to
 * publish today. NONE may appear in TTS application code: the day a provider
 * renames or drops one, code naming it would be lying. (`similarity` also
 * names an ffmpeg chroma-key parameter elsewhere in the repo, which is why the
 * scan below is scoped to the TTS path rather than run repo-wide.)
 */
const FORBIDDEN_CONTROL_NAMES =
  /\b(stability|similarity|speaker_boost|fish_temperature|delivery_diversity|speaker boost)\b/i

function offendingLines(source: string): { line: string; number: number }[] {
  return source.split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(entry => FORBIDDEN_CONTROL_NAMES.test(entry.line))
}

/** The brace-balanced block a header opens, so a big shared file can be scoped. */
function blockAfter(source: string, header: string): string {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `expected to find ${header}`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced block for ${header}`)
}

test('no control name, range or default is hardcoded on the TTS path', () => {
  const sources = [
    '../lib/tts-controls.ts',
    '../lib/genstudio-client.ts',
    '../generators/audio.ts',
    '../routes/audio.ts',
    '../contracts/index.ts',
    '../providers/types.ts',
    '../services/tts-request-plan.ts',
    '../services/tts-narration-quote.ts',
  ]
  for (const relative of sources) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
    assert.deepEqual(offendingLines(source), [], `${relative} names a published control`)
  }
  // models/types.ts also describes unrelated ffmpeg filters, so only its TTS
  // shapes are scanned — the two that used to carry control names.
  const types = readFileSync(new URL('../models/types.ts', import.meta.url), 'utf8')
  for (const header of ['export interface GenerateAudioRequest', 'audioDefaults?:']) {
    assert.deepEqual(offendingLines(blockAfter(types, header)), [], `${header} names a published control`)
  }
})

test('the frontend renders from the contract and names no control either', () => {
  const frontend = new URL('../../../frontend/', import.meta.url)
  for (const relative of ['utils/tts-controls.ts', 'components/TtsControlPanel.vue', 'pages/projects/[slug]/audio.vue']) {
    const source = readFileSync(new URL(relative, frontend), 'utf8')
    assert.deepEqual(offendingLines(source), [], `${relative} names a published control`)
  }
  // The panel's ONLY branch is the published `type`, narrowed to the three
  // shapes this build draws. Anything else is skipped upstream.
  const panel = readFileSync(new URL('components/TtsControlPanel.vue', frontend), 'utf8')
  assert.match(panel, /field\.kind === 'number'/)
  assert.match(panel, /field\.kind === 'boolean'/)
  assert.match(panel, /describeTtsControls\(props\.controls, props\.modelValue\)/)
  // Bounds, step and ceiling are bound from the published row, never literals.
  assert.match(panel, /:min="field\.minimum"/)
  assert.match(panel, /:max="field\.maximum"/)
  assert.match(panel, /:maxlength="field\.maxLength \?\? undefined"/)
  // The page sends the RESOLVED map, so a stale value cannot ride along.
  const page = readFileSync(new URL('pages/projects/[slug]/audio.vue', frontend), 'utf8')
  assert.match(page, /controls: resolvedControls\.value/)
  assert.match(page, /defaultTtsControlValues\(publishedControls\.value\)/)
})

test('the request path resolves against the live model before anything is sent', () => {
  const generator = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  // Both go through the one resolver, on the live catalogue row, so neither can
  // forward a raw request body's controls untouched.
  assert.match(generator, /resolveTtsControlValues\(ttsModel\.controls, req\.controls\)/)
  assert.match(route, /resolveTtsControlValues\(ttsModel\.controls, req\.body\?\.controls\)/)
  // The quote prices the same controls the job will carry.
  assert.match(route, /controls,\n\s*\}\),/)
})
