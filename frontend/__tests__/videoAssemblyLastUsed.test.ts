import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  coveredSectionsFromActivePresets,
  pickLastUsedSettings,
  recordLastUsedSettings,
  scopeLastUsedSettings,
} from '../utils/video-assembly-last-used.js'

function sortedKeys(value: object | undefined): string[] {
  return Object.keys(value ?? {}).sort()
}

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

test('a stale channel snapshot never outranks the named episode\'s own entry', () => {
  // Release 386 item 19 §2/§4: a channel last-used snapshot can name an
  // episode_id (recordLastUsedSettings always writes the channel side). That
  // pointer is NOT ownership — the own entry for the same episode still wins,
  // and it is never replaced by the channel copy when a preset is selected.
  const own = { export: { quality: 'fast' } }
  const store = {
    channel: { episode_id: 'EP0002', saved_at: '2026-11-01T00:00:00.000Z', settings: { export: { quality: 'high' } } },
    episodes: { EP0002: { episode_id: 'EP0002', saved_at: '2026-11-05T00:00:00.000Z', settings: own } },
  }
  assert.equal(pickLastUsedSettings(store, 'EP0002')?.scope, 'episode', 'the own entry wins even when the channel names the same episode')
  assert.deepEqual(pickLastUsedSettings(store, 'EP0002')?.settings.export, { quality: 'fast' })
  // Recording a render for another episode must not rewrite EP0002's own entry.
  const after = recordLastUsedSettings(store, 'EP0003', { export: { quality: 'medium' } })
  assert.deepEqual(after.episodes?.EP0002.settings.export, { quality: 'fast' }, 'an unrelated render leaves another episode\'s own entry intact')
})

test('for a NEW episode a selected preset beats the stale channel snapshot, section by section', () => {
  // Production 2026-11-07: choosing a bundle/subpreset then opening a new
  // episode reverted the choice, because the channel last-used ran over it.
  const channel = {
    episode_id: 'EP0001', saved_at: '2026-11-01T00:00:00.000Z',
    settings: { timeline: { transition: { type: 'stale' } }, export: { quality: 'low' }, effects: { title_card: { enabled: false } } },
  }
  const store = { channel }
  const pick = pickLastUsedSettings(store, 'EP0009')
  assert.equal(pick?.scope, 'channel')

  // The customer selected a bundle whose timeline + export presets applied.
  const scoped = scopeLastUsedSettings(pick, ['timeline', 'export'])
  assert.deepEqual(sortedKeys(scoped?.settings), ['effects'], 'covered sections are dropped; the unconfigured one keeps the channel start')
  assert.deepEqual(scoped?.settings.effects, { title_card: { enabled: false } })
  assert.equal('timeline' in (scoped?.settings || {}), false, 'the selected timeline preset wins; the stale channel timeline never applies')
  assert.equal('export' in (scoped?.settings || {}), false, 'the selected export preset wins')

  // No selected preset anywhere → the channel start still seeds every section.
  const whole = scopeLastUsedSettings(pick, [])
  assert.deepEqual(sortedKeys(whole?.settings), ['effects', 'export', 'timeline'])

  // Every section covered → nothing to apply, so the caller keeps the presets.
  assert.equal(scopeLastUsedSettings(pick, ['intro', 'timeline', 'effects', 'subtitles', 'export']), null)
})

test('a bundle with fallback sections only covers those sections and preserves uncovered channel fallback', () => {
  // Item 19 / 2026-11-07: When a bundle preset applies its fallback snapshot,
  // it clears slot.activeId. The covered set must inspect the bundle's fallback
  // so the selected bundle fallback is not overwritten by a stale channel snapshot.
  const emptySlots = { intro: '', timeline: '', effects: '', subtitles: '', export: '' }
  const bundleFallback = {
    timeline: { scene_animation: { type: 'pan-left' } },
    export: { quality: 'compact' },
  }

  // Only timeline and export are covered by the bundle fallback; intro/effects/subtitles are not.
  const covered = coveredSectionsFromActivePresets(emptySlots, bundleFallback)
  assert.deepEqual(covered.sort(), ['export', 'timeline'])

  const channel = {
    episode_id: 'EP0001', saved_at: '2026-11-01T00:00:00.000Z',
    settings: {
      intro: { enabled: true, video_path: 'stale-intro.mp4' },
      timeline: { scene_animation: { type: 'stale-pan' } },
      export: { quality: 'stale-low' },
      subtitles: { enabled: true },
    },
  }
  const pick = pickLastUsedSettings({ channel }, 'EP0009')
  const scoped = scopeLastUsedSettings(pick, covered)

  // Timeline and export were dropped from channel pick (bundle fallback wins).
  // Intro and subtitles remain (uncovered channel fallback preserved).
  assert.equal('timeline' in (scoped?.settings || {}), false, 'bundle fallback timeline wins; stale channel timeline dropped')
  assert.equal('export' in (scoped?.settings || {}), false, 'bundle fallback export wins; stale channel export dropped')
  assert.deepEqual(scoped?.settings.intro, { enabled: true, video_path: 'stale-intro.mp4' }, 'uncovered intro keeps channel fallback')
  assert.deepEqual(scoped?.settings.subtitles, { enabled: true }, 'uncovered subtitles keeps channel fallback')

  // Own episode ignores covered and returns whole.
  const own = { timeline: { scene_animation: { type: 'own' } }, export: { quality: 'own' } }
  const ownPick = { scope: 'episode' as const, from_episode: 'EP0009', settings: own as any }
  assert.deepEqual(scopeLastUsedSettings(ownPick, covered)?.settings, own, 'own episode returns whole')
})

test('a NEW episode\'s own snapshot ignores the covered-set and wins whole', () => {
  const own = { timeline: { transition: { type: 'mine' } } }
  const pick = {
    scope: 'episode' as const, from_episode: 'EP0009',
    settings: own as any,
  }
  // Even with the section marked covered, the own snapshot is returned intact.
  assert.deepEqual(scopeLastUsedSettings(pick, ['timeline'])?.settings, own)
})

test('Video Assembly records on a queued render and restores after presets load and on episode change', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
  assert.match(page, /if \(await runGenerateVideo\(\{ post, videoAssemblyGenerating \}\)\) void rememberLastUsedSettings\(\)/)
  const bundleLoad = page.indexOf('await videoBundlePresets.load()')
  const restore = page.indexOf('await restoreLastUsedSettings()', bundleLoad)
  assert.ok(bundleLoad > 0 && restore > bundleLoad, 'restore must run after the bundle preset auto-applies')
  assert.match(page, /watch\(episodeId, \(\) => \{ if \(lastUsedReady\) void restoreLastUsedSettings\(\) \}\)/)
  // The restore must scope the channel pick by the selected per-section presets and bundle fallback.
  assert.match(page, /scopeLastUsedSettings\(pickLastUsedSettings\(/, 'the mount/episode-switch restore scopes the channel pick by selected presets')
  assert.match(page, /coveredSectionsFromActivePresets\(\{/, 'covered is derived from active presets and bundle fallback')
  assert.match(page, /bundleFallback/, 'bundle fallback is included in covered derivation')
  for (const ref of ['introPresets', 'timelinePresets', 'effectsPresets', 'subtitlesPresets', 'exportPresets']) {
    assert.match(page, new RegExp(`${ref}\\.activeId\\.value`), `${ref} contributes its activeId`)
  }
  // Regression 2026-11-07: applyTimelineData called applyRevealBundle(data)
  // before if(!data)return, so a covered timeline slot passing undefined
  // invoked applyRevealBundle(undefined) which reset sceneReveal.enabled=false.
  // The guard must come before applyRevealBundle.
  assert.match(
    page,
    /function applyTimelineData\(data: any\) \{\s*if \(!data\) return\s*applyRevealBundle\(data\)/,
    'applyTimelineData must guard undefined data before applyRevealBundle so a covered timeline cannot touch reveal',
  )
})
