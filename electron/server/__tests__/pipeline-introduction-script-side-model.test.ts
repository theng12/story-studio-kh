/**
 * A batched channel opening must be written with the model the operator
 * chose for the script — never with a catalogue default.
 *
 * The bug this pins: the typed `introduction` preset stores only the
 * opening's own settings (host name, word target, opening line, beats). It
 * has never held a model, because the opening has no model picker of its
 * own — on the Script Generator it is written with `form.model`, the same
 * selection as the chapters. `resolveStepParams('introduction-only', …)`
 * therefore always produced `model: ''`, and run-batch filled the gap from
 * GenStudio's live catalogue default (the first Economy-tier product).
 *
 * The operator saw every other step in the same batch run on the model he
 * picked and the Introduction alone run on something else, with nothing on
 * screen explaining where that came from. A model he cannot distinguish
 * from one he chose is exactly the substitution this app refuses to make
 * for prices; it refuses it here too. If the script-side model cannot be
 * resolved, the step is skipped with a reason instead.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveScriptSideChatModel } from '../routes/pipeline.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PIPELINE_SOURCE = path.join(HERE, '..', 'routes', 'pipeline.ts')

const scriptPreset = (data: Record<string, unknown>) => ({
  id: 'script-1', name: 'Script preset', type: 'script', data,
})

describe('resolveScriptSideChatModel — the opening inherits the script’s model', () => {
  test('reads the typed script preset’s form.model', () => {
    const config = {
      script_presets: [
        { id: 'intro-1', name: 'Intro', type: 'introduction', data: { intro: {}, introBeats: [] } },
        scriptPreset({ form: { model: 'deepseek-v4-flash-1m' } }),
      ],
      script_last_preset_script: 'script-1',
      script_last_preset_introduction: 'intro-1',
    }
    assert.equal(resolveScriptSideChatModel(config), 'deepseek-v4-flash-1m')
  })

  test('a legacy flat (untyped) script preset still resolves', () => {
    const config = {
      script_presets: [{ id: 'legacy', name: 'Legacy', data: { model: 'genstudio-chat-legacy' } }],
      script_last_preset: 'legacy',
    }
    assert.equal(resolveScriptSideChatModel(config), 'genstudio-chat-legacy')
  })

  test('whitespace is trimmed', () => {
    const config = {
      script_presets: [scriptPreset({ form: { model: '  spaced-model-id  ' } })],
      script_last_preset_script: 'script-1',
    }
    assert.equal(resolveScriptSideChatModel(config), 'spaced-model-id')
  })

  test('no script preset at all resolves to null, not to a guess', () => {
    assert.equal(resolveScriptSideChatModel({}), null)
  })

  test('a script preset with a blank model resolves to null, not to a guess', () => {
    const config = {
      script_presets: [scriptPreset({ form: { model: '   ' } })],
      script_last_preset_script: 'script-1',
    }
    assert.equal(resolveScriptSideChatModel(config), null)
  })

  test('an introduction preset is never mistaken for the script preset', () => {
    // The two share the `script_presets` pool. Only the script-side pointer
    // may supply the model; the introduction preset has none to give.
    const config = {
      script_presets: [{ id: 'intro-1', name: 'Intro', type: 'introduction', data: { intro: {}, introBeats: [] } }],
      script_last_preset_introduction: 'intro-1',
    }
    assert.equal(resolveScriptSideChatModel(config), null)
  })
})

describe('run-batch wires introduction-only to the script-side model, not the catalogue default', () => {
  test('the introduction branch uses preflight.scriptSideChatModel and skips when it is absent', async () => {
    const source = await fs.readFile(PIPELINE_SOURCE, 'utf8')
    const start = source.indexOf("if (step === 'introduction-only' && !params.model)")
    assert.notEqual(start, -1, 'introduction-only model branch not found in run-batch')
    // Stop at the next branch so the metadata fallback below is not read as
    // part of the opening's.
    const end = source.indexOf("if (step === 'metadata' && !params.model)", start)
    assert.ok(end > start, "the metadata branch must follow the introduction branch")
    const branch = source.slice(start, end)
    assert.match(branch, /preflight\.scriptSideChatModel/)
    assert.doesNotMatch(branch, /batchDefaultChatModel/,
      'the opening must not fall back to the live-catalogue default — that is a silent substitution')
    assert.match(branch, /No model was substituted/)
  })

  test('the live-catalogue default is resolved for metadata only', async () => {
    const source = await fs.readFile(PIPELINE_SOURCE, 'utf8')
    const code = source
      .split('\n')
      .filter(line => {
        const t = line.trim()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      })
      .join('\n')
    assert.match(code, /if \(steps\.includes\('metadata'\)\) \{/)
    assert.doesNotMatch(code, /steps\.includes\('introduction-only'\) \|\| steps\.includes\('metadata'\)/)
  })
})
