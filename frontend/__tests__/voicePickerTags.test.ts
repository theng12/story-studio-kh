/**
 * Voice `tags` published by the Gateway, as the picker uses them.
 *
 * Two things must hold together or the feature reads as broken without any
 * test failing: the search box must FIND a voice by its tag, and a voice with
 * no tags must render no tag filter at all. A tag row left standing on a voice
 * that has none shows the customer a filter over an empty set.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, h, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { voiceMatchesQuery, type GenStudioVoice } from '../composables/useGenStudioVoices'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const pickerSource = source('../components/VoicePicker.vue')

/** Compile the production row SFC in-process (no component-test dependency). */
async function loadRow(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/VoicePickerRow.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const id = 'voice-picker-row'
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id, compilerOptions: { bindingMetadata: script.bindings } })
  // `computed` is a Nuxt auto-import in the SFC; the bare test process has none.
  const shim = 'import { computed } from "vue"\n'
  const code = `${shim}${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const built = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = import.meta.resolve('vue')
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const Row = await loadRow()

function mountRow(props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(Row, props) })
  app.mount(host)
  // Always unmount, even when an assertion throws: a mounted app left behind
  // keeps the process alive, so a failing test would hang instead of failing.
  return {
    host,
    unmount: () => { app.unmount(); host.remove() },
  }
}

function voice(over: Partial<GenStudioVoice> = {}): GenStudioVoice {
  return { id: 'v1', display_name: 'Aria', ...over } as GenStudioVoice
}

describe('the voice picker search filter', () => {
  test('narrows on a normal field', () => {
    assert.equal(voiceMatchesQuery(voice({ display_name: 'Aria' }), 'ari'), true)
    assert.equal(voiceMatchesQuery(voice({ display_name: 'Aria' }), 'bob'), false)
  })

  test('matches a tag the row never shows elsewhere', () => {
    const tagged = voice({ display_name: 'Aria', language: 'en', tags: ['sleep-story', 'bedtime'] })
    assert.equal(voiceMatchesQuery(tagged, 'sleep'), true, 'a published tag must be searchable')
    assert.equal(voiceMatchesQuery(tagged, 'bedtime'), true, 'every tag, not just the first')
    // Nothing else on this row contains the word, so the match IS the tag.
    assert.equal(voiceMatchesQuery(voice({ display_name: 'Aria', language: 'en' }), 'sleep'), false)
  })

  test('an empty query keeps every voice, tags or not', () => {
    assert.equal(voiceMatchesQuery(voice({ tags: ['x'] }), '   '), true)
    assert.equal(voiceMatchesQuery(voice(), ''), true)
  })

  test('a voice with no tags (undefined, not []) still filters normally', () => {
    // `undefined` is what the backend publishes when the Gateway sent none.
    const plain = voice()
    assert.equal(plain.tags, undefined)
    assert.equal(voiceMatchesQuery(plain, 'aria'), true)
    assert.equal(voiceMatchesQuery(plain, 'anything'), false)
  })

  test('the picker routes its search box through this predicate', () => {
    assert.match(pickerSource, /voiceMatchesQuery\(voice, search\.value\)/)
    assert.doesNotMatch(pickerSource, /\.toLowerCase\(\)\.includes\(q\)/,
      'the old inline matcher was moved, not duplicated')
  })
})

describe('tag chips on a row', () => {
  test('a row with tags shows one chip per tag', () => {
    const { host, unmount } = mountRow({
      name: 'Aria', selected: false, favourite: false, tags: ['sleep', 'bedtime'],
    })
    try {
      const chips = [...host.querySelectorAll('.vp-tag')].map(el => el.textContent)
      assert.deepEqual(chips, ['sleep', 'bedtime'])
    } finally {
      unmount()
    }
  })

  test('a row with no tags shows no filter at all', () => {
    const { host, unmount } = mountRow({ name: 'Aria', selected: false, favourite: false })
    try {
      // `assert.ok` on a boolean, not `assert.equal` on the element: a failing
      // `assert.equal` would inspect the DOM node to build its message, and
      // that inspection hangs instead of failing.
      assert.ok(host.querySelector('.vp-tags') === null, 'no tag container is rendered')
      assert.equal(host.querySelectorAll('.vp-tag').length, 0)
    } finally {
      unmount()
    }
  })

  test('an empty tag list shows no filter either', () => {
    const { host, unmount } = mountRow({
      name: 'Aria', selected: false, favourite: false, tags: [],
    })
    try {
      assert.ok(host.querySelector('.vp-tags') === null, 'an empty list must not render a wrapper')
    } finally {
      unmount()
    }
  })
})