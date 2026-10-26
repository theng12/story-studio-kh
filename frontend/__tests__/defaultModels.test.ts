/**
 * Default models (owner, 2026-10-27) — the frontend half of the one precedence chain.
 *
 *   the preset's saved model → the page's remembered last choice → the app-wide default
 *
 * Two rules are pinned here:
 *
 *  1. the default is READ and never written. `resolveEffectiveModel` returns an id for a page to
 *     submit, and nothing in it can reach a preset, a channel config or a remembered form.
 *  2. the honest-unknown rule (AGENTS §6): "the catalogue has not loaded" and "your default is gone"
 *     must never produce the same answer, so a gone default is only ever claimed against a catalogue
 *     that actually loaded.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  DEFAULT_MODEL_FAMILIES,
  emptyDefaultModels,
  goneDefaultMessage,
  normalizeDefaultModels,
  resolveEffectiveModel,
} from '../utils/live-genstudio-model-selection.ts'

type Family = Parameters<typeof resolveEffectiveModel>[0]

/**
 * The decision is a pure function, so these tests call it directly — no composable, no fetch. That
 * is also why the pickers can call it: a page's SFC test harness inlines this util but not a
 * composable.
 */
function effective(family: Family, selected: string, liveIds: string[], models: Partial<Record<string, string | null>>) {
  return resolveEffectiveModel(family, selected, liveIds, normalizeDefaultModels(models))
}

describe('default models — precedence', () => {
  test('the page\'s own model wins over the app default', () => {
    const resolved = effective('writing', 'page-choice', ['page-choice', 'app-default'], { writing: 'app-default' })
    assert.equal(resolved.defaultModel, 'app-default')
    assert.equal(resolved.model, 'page-choice')
  })

  test('an empty page selection takes the app default', () => {
    assert.equal(effective('writing', '', ['app-default'], { writing: 'app-default' }).model, 'app-default')
  })

  test('no default set leaves the field empty — the page asks, it is never given a model', () => {
    const resolved = effective('writing', '', ['some-model'], {})
    assert.equal(resolved.defaultModel, '')
    assert.equal(resolved.model, '')
    assert.equal(resolved.goneNotice, '')
  })

  test('each family reads only its own value', () => {
    const models = { writing: 'writing-one', image: 'image-one', audio: 'voice-one' }
    assert.equal(effective('writing', '', [], models).defaultModel, 'writing-one')
    assert.equal(effective('image', '', [], models).defaultModel, 'image-one')
    assert.equal(effective('audio', '', [], models).defaultModel, 'voice-one')
    assert.equal(effective('video', '', [], models).defaultModel, '')
  })
})

describe('default models — a default that is gone', () => {
  test('says so plainly, names the family, and leaves the field empty', () => {
    const resolved = effective('writing', '', ['other-model'], { writing: 'retired-model' })
    assert.equal(resolved.model, '', 'a gone default must never be submitted')
    assert.match(resolved.goneNotice, /Your default writing model "retired-model" is no longer available — choose another/)
    assert.match(resolved.goneNotice, /did not switch to a different model/)
    assert.doesNotMatch(resolved.goneNotice, /other-model/, 'no substitute model is ever named')
  })

  test('the voice family is called a voice model, not an audio model', () => {
    assert.match(goneDefaultMessage('audio', 'tts-gone'), /Your default voice model "tts-gone"/)
  })

  test('an unloaded catalogue claims NOTHING about the default (AGENTS §6)', () => {
    const resolved = effective('writing', '', [], { writing: 'maybe-live' })
    assert.equal(resolved.goneNotice, '', 'an empty catalogue is "not loaded", not "gone"')
    // Nothing is claimed, and the id is still offered — the server checks it before a job runs.
    assert.equal(resolved.model, 'maybe-live')
  })
})

describe('default models — never written into a saved selection', () => {
  const composablePath = fileURLToPath(new URL('../composables/useDefaultModels.ts', import.meta.url))
  const utilPath = fileURLToPath(new URL('../utils/live-genstudio-model-selection.ts', import.meta.url))

  test('the read path only ever GETs the setting', () => {
    const source = `${readFileSync(composablePath, 'utf8')}\n${readFileSync(utilPath, 'utf8')}`
    assert.doesNotMatch(source, /\bput\s*\(|\bpost\s*\(|\bdel\s*\(/, 'the read path must not write')
    assert.doesNotMatch(source, /localStorage/, 'a default is not a remembered form value')
  })

  test('a page that remembers its form does not persist the default into it', () => {
    // The default fills the live form field the page submits; `useRememberedForm` persists the
    // page's own form object, and the setting itself is never one of the keys it is told to keep.
    const source = readFileSync(
      fileURLToPath(new URL('../pages/projects/[slug]/audio.vue', import.meta.url)),
      'utf8',
    )
    const rememberCall = source.match(/useRememberedForm\([\s\S]*?\n\}\)\n/)
    assert.ok(rememberCall, 'Audio still uses useRememberedForm')
    assert.doesNotMatch(rememberCall![0], /default/i, 'the remembered form must not carry a default')
    assert.match(source, /resolveEffectiveModel\(\s*'audio'/)
  })
})

describe('default models — the settings index', () => {
  test('every family is one of the six GenStudio publishes', () => {
    assert.deepEqual([...DEFAULT_MODEL_FAMILIES], [
      'writing', 'image', 'video', 'audio', 'transcription', 'music',
    ])
  })

  test('a response missing families normalises to every family unset', () => {
    assert.deepEqual(normalizeDefaultModels(null), emptyDefaultModels())
    assert.deepEqual(normalizeDefaultModels({ writing: '  ' }), emptyDefaultModels())
    assert.deepEqual(normalizeDefaultModels({ writing: 'chat-a', bogus: 'x' }), { ...emptyDefaultModels(), writing: 'chat-a' })
  })
})

describe('default models — not persisted as a remembered choice', () => {
  test('a defaulted model is dropped from what a page remembers, so a later default change reaches it', async () => {
    const { applyDefaults, peekDefaultModels } = await import('../composables/useDefaultModels.ts')
    const { useRememberedForm } = await import('../composables/useRememberedForm.ts')
    const { reactive } = await import('vue')

    applyDefaults({ writing: 'app-default-writing', image: 'app-default-image' })
    assert.equal(peekDefaultModels().value.writing, 'app-default-writing')

    ;(globalThis as any).window.localStorage.clear()
    const form = reactive({
      model: 'app-default-writing',
      style: 'calm',
      thumbnail: { model: 'app-default-image', ratio: '16:9' },
    })
    const remembered = useRememberedForm('default-models-test', 'demo', form)
    remembered.persist()

    const stored = JSON.parse((globalThis as any).window.localStorage.getItem('ssk:form:demo:default-models-test:v1')!)
    assert.equal(stored.model, undefined, 'the default is not the page\'s remembered choice')
    assert.equal(stored.thumbnail?.model, undefined, 'and neither is a nested one')
    assert.equal(stored.style, 'calm', 'every real setting is still remembered')
    assert.equal(stored.thumbnail?.ratio, '16:9')

    // A model the owner actually picked is remembered as usual.
    form.model = 'owner-picked-model'
    remembered.persist()
    const after = JSON.parse((globalThis as any).window.localStorage.getItem('ssk:form:demo:default-models-test:v1')!)
    assert.equal(after.model, 'owner-picked-model')
  })
})
