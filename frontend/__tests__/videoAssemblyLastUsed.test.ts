import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pickLastUsedSettings, recordLastUsedSettings } from '../utils/video-assembly-last-used.js'

// Dreamlands E2E 2026-10-03: every Video Assembly choice (Pan Right, Gentle Fade
// subtitles, YouTube — Fast) was forgotten between renders unless saved as a preset.

const rendered = {
  timeline: { scene_animation: { type: 'pan-right' }, title_image: { enabled: false, duration: 5 } },
  subtitles: { enabled: true, style: { preset_id: 'gentle-fade' } },
  export: { quality: 'fast', encoding_effort: 'hardware' },
  effects: { title_card: { enabled: true, text: 'Bioluminescent Glasshouse', subtitle: 'EP2', duration: 5 } },
}

test('a render remembers its settings for that episode and restores them exactly', () => {
  const store = recordLastUsedSettings(null, 'ep0002', rendered)
  const pick = pickLastUsedSettings(store, 'EP0002')
  assert.equal(pick?.scope, 'episode')
  assert.deepEqual(pick?.settings, rendered)
})

test('another episode starts from the channel\'s last render, without the other episode\'s title text', () => {
  const store = recordLastUsedSettings(null, 'EP0002', rendered)
  const pick = pickLastUsedSettings(store, 'EP0003')
  assert.equal(pick?.scope, 'channel')
  assert.equal(pick?.from_episode, 'EP0002')
  assert.deepEqual((pick?.settings.timeline as any).scene_animation, { type: 'pan-right' })
  assert.equal((pick?.settings.subtitles as any).enabled, true)
  assert.equal(pick?.settings.effects?.title_card.text, undefined)
  assert.equal(pick?.settings.effects?.title_card.subtitle, undefined)
  assert.equal(pick?.settings.effects?.title_card.duration, 5)
})

test('an episode keeps its own last render after another episode renders', () => {
  let store = recordLastUsedSettings(null, 'EP0002', rendered)
  store = recordLastUsedSettings(store, 'EP0003', { ...rendered, export: { quality: 'high' } })
  assert.deepEqual(pickLastUsedSettings(store, 'EP0002')?.settings.export, { quality: 'fast', encoding_effort: 'hardware' })
  assert.deepEqual(pickLastUsedSettings(store, 'EP0009')?.settings.export, { quality: 'high' })
  assert.equal(pickLastUsedSettings(null, 'EP0001'), null)
})

test('Video Assembly records on a queued render and restores after presets load and on episode change', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
  assert.match(page, /if \(await runGenerateVideo\(\{ post, videoAssemblyGenerating \}\)\) void rememberLastUsedSettings\(\)/)
  const bundleLoad = page.indexOf('await videoBundlePresets.load()')
  const restore = page.indexOf('await restoreLastUsedSettings()', bundleLoad)
  assert.ok(bundleLoad > 0 && restore > bundleLoad, 'restore must run after the bundle preset auto-applies')
  assert.match(page, /watch\(episodeId, \(\) => \{ if \(lastUsedReady\) void restoreLastUsedSettings\(\) \}\)/)
})
