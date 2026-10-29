/**
 * Delivery / emotion for narration (owner, 2026-10-29).
 *
 * "Add the emotion setting" for cloned voices. Instructions differ by model, so
 * there is no app-wide list of emotions and no dropdown anywhere: the Gateway
 * publishes ONE control per model (`delivery_instruction`), only for models that
 * take one, carrying that model's own guidance inside it. Story Studio reads
 * that control, shows it with the guidance beside it, and sends the text as the
 * Gateway's top-level request field — only when the model publishes it and the
 * box is not empty.
 *
 * This file pins the reading side and the request side:
 *   - the control is read off the model's own `controls[]`, and only as text;
 *   - the published length is the only length applied (no constant here);
 *   - a model that publishes none yields nothing shown and nothing sent;
 *   - guidance is carried exactly as published, in several plausible shapes,
 *     and nothing is invented when it is absent;
 *   - the generator resolves it against the live row, refuses a non-empty
 *     instruction on a model that does not take one, records it on the take's
 *     provenance, and folds it into the part's input hash.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DELIVERY_INSTRUCTION_CONTROL,
  parseDeliveryInstructionControl,
  parseDeliveryInstructionGuidance,
  parseTtsControls,
  resolveDeliveryInstruction,
  resolveTtsControlValues,
} from '../lib/tts-controls.js'
import { buildGenStudioSubmission } from '../lib/genstudio-client.js'
import { GenerateAudioSchema } from '../contracts/index.js'

/** A row shaped exactly like the Gateway publishes this control. */
function publishedControl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: DELIVERY_INSTRUCTION_CONTROL,
    label: 'Delivery / emotion',
    type: 'text',
    max_length: 500,
    ...overrides,
  }
}

const REQUEST = {
  text: 'Every evening the river remembered a different name.',
  voiceId: 'voice-kh-1',
  modelId: 'model-fish-s2-1-pro',
  speed: 1,
  maxInputCharacters: 20_000,
}

describe('reading the published control', () => {
  test('a model that publishes it is read with its own label and limit', () => {
    const control = parseDeliveryInstructionControl([publishedControl()])
    assert.ok(control)
    assert.equal(control.label, 'Delivery / emotion')
    assert.equal(control.max_length, 500)
    // No guidance published: the box shows alone, and nothing is invented.
    assert.equal(control.guidance, null)
  })

  test('a model that publishes none yields nothing at all', () => {
    assert.equal(parseDeliveryInstructionControl([]), null)
    assert.equal(parseDeliveryInstructionControl(undefined), null)
    assert.equal(parseDeliveryInstructionControl([{ name: 'temperature', type: 'number', default: 0.7 }]), null)
  })

  test('a different published type under this name is not this control', () => {
    assert.equal(parseDeliveryInstructionControl([publishedControl({ type: 'number' })]), null)
  })

  test('an unpublished limit is no limit, never a limit of Story Studio’s', () => {
    const control = parseDeliveryInstructionControl([publishedControl({ max_length: undefined })])
    assert.ok(control)
    assert.equal(control.max_length, null)
  })

  test('the generic control map never carries it, so nothing is sent twice', () => {
    const rows = [publishedControl({ default: 'read warmly' })]
    const generic = parseTtsControls(rows)
    assert.deepEqual(generic, [])
    assert.deepEqual(resolveTtsControlValues(generic, { delivery_instruction: 'read warmly' }), {})
  })
})

describe('the model’s own guidance', () => {
  test('free text, examples, the language rule, inline events and the source are read as published', () => {
    const guidance = parseDeliveryInstructionGuidance({
      kind: 'free text',
      text: 'Describe the voice, not the words.',
      examples: ['Warm and unhurried, a little amused.', 'Cold, clipped, almost a whisper.'],
      language_rule: 'Write the instruction in English; the script may be in any language.',
      inline_events: [
        { syntax: '[laugh]', meaning: 'a short, light laugh' },
        { syntax: '[sigh]' },
      ],
      source_url: 'https://example.invalid/model-card#delivery',
    })
    assert.ok(guidance)
    assert.equal(guidance.kind, 'free text')
    assert.equal(guidance.text, 'Describe the voice, not the words.')
    assert.deepEqual(guidance.examples, [
      'Warm and unhurried, a little amused.',
      'Cold, clipped, almost a whisper.',
    ])
    assert.equal(guidance.languageRule, 'Write the instruction in English; the script may be in any language.')
    assert.deepEqual(guidance.inlineEvents, [
      { syntax: '[laugh]', meaning: 'a short, light laugh', where: '' },
      { syntax: '[sigh]', meaning: '', where: '' },
    ])
    assert.equal(guidance.sourceUrl, 'https://example.invalid/model-card#delivery')
  })

  test('a plain string, an events map and alternative key spellings all read', () => {
    assert.equal(parseDeliveryInstructionGuidance('Say it like a bedtime story.')?.text, 'Say it like a bedtime story.')
    const mapped = parseDeliveryInstructionGuidance({
      instructions: 'Keep it slow.',
      inline_vocal_events: { '[breath]': 'an audible breath', '[pause]': 'a pause' },
      url: 'https://example.invalid/card',
    })
    assert.ok(mapped)
    assert.equal(mapped.text, 'Keep it slow.')
    assert.deepEqual(mapped.inlineEvents, [
      { syntax: '[breath]', meaning: 'an audible breath', where: '' },
      { syntax: '[pause]', meaning: 'a pause', where: '' },
    ])
    assert.equal(mapped.sourceUrl, 'https://example.invalid/card')
  })

  test('the Hub’s final published shape reads as published (VoxCPM2: no language rule, no inline events)', () => {
    // The exact shape the Hub publishes inside the Gateway's `delivery_instruction`
    // control, forwarded unchanged (coordinator, 2026-10-29). VoxCPM2 states no
    // language rule and accepts no inline events, so both read as absent — never
    // as a guess, an empty bullet or a fallback rule.
    const guidance = parseDeliveryInstructionGuidance({
      kind: 'free_text',
      engine_form: 'instruct',
      max_characters: 500,
      examples: ['Warm and unhurried, a little amused.', 'Cold and clipped, almost a whisper.'],
      language_rule: null,
      inline_events: [],
      directed_cfg_scale: 1.5,
      directed_cfg_parameter: 'cfg_scale',
      source_url: 'https://example.invalid/voxcpm2',
      note: 'The instruction is used only with a reference clip.',
    })
    assert.ok(guidance)
    assert.equal(guidance.kind, 'free_text')
    assert.equal(guidance.engineForm, 'instruct')
    assert.equal(guidance.languageRule, '')
    assert.deepEqual(guidance.inlineEvents, [])
    assert.deepEqual(guidance.examples, [
      'Warm and unhurried, a little amused.',
      'Cold and clipped, almost a whisper.',
    ])
    assert.equal(guidance.sourceUrl, 'https://example.invalid/voxcpm2')
    assert.equal(guidance.note, 'The instruction is used only with a reference clip.')
  })

  test('an inline event carries its syntax, what it does and where it may go', () => {
    const guidance = parseDeliveryInstructionGuidance({
      kind: 'free_text',
      engine_form: 'text_prefix',
      examples: [],
      language_rule: 'Write the instruction in English.',
      inline_events: [
        { syntax: '[laugh]', event: 'a short, light laugh', where: 'after a sentence' },
        { syntax: '[sigh]', event: 'a slow exhale', where: null },
      ],
      source_url: null,
      note: null,
    })
    assert.ok(guidance)
    assert.equal(guidance.engineForm, 'text_prefix')
    assert.deepEqual(guidance.inlineEvents, [
      { syntax: '[laugh]', meaning: 'a short, light laugh', where: 'after a sentence' },
      { syntax: '[sigh]', meaning: 'a slow exhale', where: '' },
    ])
    assert.equal(guidance.sourceUrl, '')
    assert.equal(guidance.note, '')
  })

  test('nothing published means null — never an empty guidance shell', () => {
    assert.equal(parseDeliveryInstructionGuidance(undefined), null)
    assert.equal(parseDeliveryInstructionGuidance(''), null)
    assert.equal(parseDeliveryInstructionGuidance({}), null)
    assert.equal(parseDeliveryInstructionGuidance([]), null)
  })

  test('the control carries that guidance unchanged', () => {
    const control = parseDeliveryInstructionControl([publishedControl({
      guidance: { examples: ['Warm and unhurried.'], language: 'en' },
    })])
    assert.ok(control?.guidance)
    assert.deepEqual(control.guidance.examples, ['Warm and unhurried.'])
    assert.equal(control.guidance.languageRule, 'en')
  })
})

describe('resolving what leaves Story Studio', () => {
  const control = parseDeliveryInstructionControl([publishedControl({ max_length: 12 })])

  test('a model that publishes no control sends nothing, whatever was typed', () => {
    assert.equal(resolveDeliveryInstruction(null, 'read it warmly'), '')
    assert.equal(resolveDeliveryInstruction(undefined, 'read it warmly'), '')
  })

  test('an empty or whitespace box sends nothing', () => {
    assert.equal(resolveDeliveryInstruction(control, ''), '')
    assert.equal(resolveDeliveryInstruction(control, '   \n '), '')
    assert.equal(resolveDeliveryInstruction(control, undefined), '')
  })

  test('the published length is the only length applied, cut by code point', () => {
    assert.equal(resolveDeliveryInstruction(control, 'warm and slow'), 'warm and slo')
    assert.equal(resolveDeliveryInstruction(control, '  warm and slow  '), 'warm and slo')
    // A surrogate pair at the cut boundary is never split.
    const wide = parseDeliveryInstructionControl([publishedControl({ max_length: 2 })])
    assert.equal(resolveDeliveryInstruction(wide, '🙂🙂🙂'), '🙂🙂')
  })

  test('a model publishing no limit sends the text whole', () => {
    const unlimited = parseDeliveryInstructionControl([publishedControl({ max_length: undefined })])
    const long = 'slow. '.repeat(200).trim()
    assert.equal(resolveDeliveryInstruction(unlimited, long), long)
  })
})

describe('the request the Gateway receives', () => {
  test('the instruction rides at the top level, never inside controls', () => {
    const submission = buildGenStudioSubmission({ ...REQUEST, deliveryInstruction: 'Warm and unhurried.' })
    assert.equal(submission.body.delivery_instruction, 'Warm and unhurried.')
    assert.equal((submission.body as Record<string, unknown>).controls, undefined)
  })

  test('no instruction produces exactly the body this client sent before the field existed', () => {
    const plain = buildGenStudioSubmission({ ...REQUEST })
    assert.equal(Object.prototype.hasOwnProperty.call(plain.body, 'delivery_instruction'), false)
    // An empty string is "no instruction" too, never a blank parameter.
    const blank = buildGenStudioSubmission({ ...REQUEST, deliveryInstruction: '   ' })
    assert.deepEqual(blank.body, plain.body)
    assert.equal(blank.idempotencyKey, plain.idempotencyKey)
  })

  test('a different instruction is different work, so its idempotency key moves', () => {
    const warm = buildGenStudioSubmission({ ...REQUEST, deliveryInstruction: 'Warm.' })
    const cold = buildGenStudioSubmission({ ...REQUEST, deliveryInstruction: 'Cold.' })
    assert.notEqual(warm.idempotencyKey, cold.idempotencyKey)
    const plain = buildGenStudioSubmission({ ...REQUEST })
    assert.notEqual(warm.idempotencyKey, plain.idempotencyKey)
  })
})

describe('the job request and the preset path', () => {
  test('the audio schema accepts it and keeps it', () => {
    const parsed = GenerateAudioSchema.parse({
      episode_id: 'AWBU0001',
      model: 'model-fish-s2-1-pro',
      voice: 'voice-kh-1',
      sections: 'all',
      delivery_instruction: 'Warm and unhurried.',
    }) as Record<string, unknown>
    assert.equal(parsed.delivery_instruction, 'Warm and unhurried.')
  })

  test('the generator resolves it off the live model row and refuses a foreign instruction', () => {
    const generator = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
    // Resolved against the SELECTED model's own published control, at use time.
    assert.match(generator, /resolveDeliveryInstruction\(ttsModel\.delivery_instruction, req\.delivery_instruction\)/)
    // A non-empty instruction on a model that publishes none is refused loudly,
    // never dropped: the Gateway refuses it too, and a silent drop would deliver
    // the plain reading under a label claiming otherwise.
    assert.match(generator, /if \(askedForDeliveryInstruction && !deliveryInstruction\)/)
    assert.match(generator, /does not take a delivery\/emotion instruction/)
    // Every request literal carries it — the prepared submission, the
    // submitted/recovery object, the action-owned rebuild, and the input hash.
    assert.equal((generator.match(/\.\.\.deliveryRequest/g) || []).length, 4)
    // Recorded on the take, beside the engine and voice.
    assert.match(generator, /delivery_instruction: deliveryInstruction/)
  })

  test('Pipeline and batch read it from the saved preset', () => {
    const pipeline = readFileSync(new URL('../routes/pipeline.ts', import.meta.url), 'utf8')
    // The audio step forwards the preset's whole saved form, minus the fields
    // that are per-episode; a reusable direction travels with it and nothing
    // names the field here, so a future preset field needs no pipeline change.
    const audioBranch = pipeline.slice(pipeline.indexOf("if (step === 'audio')"))
    assert.match(audioBranch, /const form = \{ \.\.\.\(data\.form \|\| \{\}\) \}/)
    assert.match(audioBranch, /\.\.\.rest,/)
    assert.doesNotMatch(audioBranch.slice(0, 600), /delete form\.delivery_instruction/)
  })
})
