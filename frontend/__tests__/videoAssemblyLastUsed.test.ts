import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  coveredSectionsFromActivePresets,
  pickLastUsedSettings,
  recordLastUsedSettings,
  resolveEpisodeRestoreSettings,
  scopeLastUsedSettings,
  withoutEpisodeFiles,
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
  assert.match(page, /resolveEpisodeRestoreSettings\(\{/, 'restoreLastUsedSettings delegates to resolveEpisodeRestoreSettings')
})

test('episodeA -> ownB -> episodeA restores active presets and channel fallback on A, never retaining B own values', () => {
  // Confirmed RUNNING BROWSER bug:
  // selected timeline preset hold 17, stale channel hold 29, EP0002 own hold 11.
  // Open EP0001 => 17 correct; switch EP0002 => 11 correct; switch back EP0001 => 11 WRONG, must be 17.
  const channel = {
    episode_id: 'EP0001',
    saved_at: '2026-11-01T00:00:00.000Z',
    settings: {
      timeline: { post_audio: { tail_seconds: 29 } },
      export: { quality: 'compact' },
    },
  }
  const ep2Own = {
    timeline: { post_audio: { tail_seconds: 11 } },
    export: { quality: 'high' },
  }
  const store = {
    channel,
    episodes: {
      EP0002: { episode_id: 'EP0002', saved_at: '2026-11-05T00:00:00.000Z', settings: ep2Own },
    },
  }

  // Active state: timeline slot preset holds 17; export has no preset
  const slots = {
    timeline: { activeId: 'preset-hold-17', activeData: { post_audio: { tail_seconds: 17 } } },
    export: { activeId: '', activeData: null },
  }

  // Track simulated form state across the episode sequence
  const form: { timeline?: any; export?: any } = {}
  function applyResolved(resolved: ReturnType<typeof resolveEpisodeRestoreSettings>) {
    if (resolved.settings.timeline) form.timeline = resolved.settings.timeline
    if (resolved.settings.export) form.export = resolved.settings.export
  }

  // Step 1: Open EP0001 (channel-backed) -> timeline uses active preset (17), export uses channel fallback (compact)
  const step1 = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0001', slots })
  assert.equal(step1.scope, 'channel')
  applyResolved(step1)
  assert.equal(form.timeline.post_audio.tail_seconds, 17, 'EP0001 timeline uses active preset (17), not stale channel (29)')
  assert.equal(form.export.quality, 'compact', 'EP0001 export uses channel fallback (compact)')

  // Step 2: Switch to EP0002 (own render) -> own episode wins whole (hold 11, quality high)
  const step2 = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0002', slots })
  assert.equal(step2.scope, 'episode')
  applyResolved(step2)
  assert.equal(form.timeline.post_audio.tail_seconds, 11, 'EP0002 timeline restores its own render (11)')
  assert.equal(form.export.quality, 'high', 'EP0002 export restores its own render (high)')

  // Step 3: Switch BACK to EP0001 -> must restore active preset (17) and channel export (compact), NOT retain EP0002 values
  const step3 = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0001', slots })
  assert.equal(step3.scope, 'channel')
  applyResolved(step3)
  assert.equal(form.timeline.post_audio.tail_seconds, 17, 'switching back to EP0001 must restore active preset (17), not retain EP0002 own (11)')
  assert.equal(form.export.quality, 'compact', 'switching back to EP0001 must restore channel fallback (compact), not retain EP0002 own (high)')
})

test('episodeA -> ownB -> episodeA with bundle fallback respects bundle fallback and strips episode files', () => {
  const store = {
    channel: {
      episode_id: 'EP0001',
      saved_at: '2026-11-01T00:00:00.000Z',
      settings: {
        timeline: { post_audio: { tail_seconds: 29 } },
      },
    },
    episodes: {
      EP0002: {
        episode_id: 'EP0002',
        saved_at: '2026-11-05T00:00:00.000Z',
        settings: { timeline: { post_audio: { tail_seconds: 11 } } },
      },
    },
  }

  // Selected bundle provides fallback for timeline with tail_seconds 17 and an episode title_image
  const bundleFallback = {
    timeline: {
      post_audio: { tail_seconds: 17 },
      title_image: { image_path: '/stale/ep1.png', enabled: true },
    },
  }

  const form: { timeline?: any } = {}
  function applyResolved(resolved: ReturnType<typeof resolveEpisodeRestoreSettings>) {
    if (resolved.settings.timeline) form.timeline = resolved.settings.timeline
  }

  // Step 1: Open EP0001 -> bundle fallback applies 17, with image_path stripped
  const step1 = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0001', bundleFallback })
  applyResolved(step1)
  assert.equal(form.timeline.post_audio.tail_seconds, 17)
  assert.equal(form.timeline.title_image.image_path, undefined, 'title_image.image_path stripped by withoutEpisodeFiles')

  // Step 2: Switch to EP0002 -> own 11
  const step2 = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0002', bundleFallback })
  applyResolved(step2)
  assert.equal(form.timeline.post_audio.tail_seconds, 11)

  // Step 3: Switch back to EP0001 -> restores bundle fallback 17, image_path stripped
  const step3 = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0001', bundleFallback })
  applyResolved(step3)
  assert.equal(form.timeline.post_audio.tail_seconds, 17, 'switch back to EP0001 restores bundle fallback (17)')
  assert.equal(form.timeline.title_image.image_path, undefined)
})

test('pointed slot preset takes precedence over bundle fallback when both are present', () => {
  const store = {
    channel: {
      episode_id: 'EP0001',
      saved_at: '2026-11-01T00:00:00.000Z',
      settings: { timeline: { post_audio: { tail_seconds: 29 } } },
    },
  }
  const slots = {
    timeline: { activeId: 'preset-pointed', activeData: { post_audio: { tail_seconds: 17 } } },
  }
  const bundleFallback = {
    timeline: { post_audio: { tail_seconds: 25 } },
  }
  const resolved = resolveEpisodeRestoreSettings({ store, episodeId: 'EP0009', slots, bundleFallback })
  assert.equal((resolved.settings.timeline as any).post_audio.tail_seconds, 17, 'pointed slot preset beats bundle fallback')
})

test('withoutEpisodeFiles strips episode files at both whole-bundle and section-level shapes', () => {
  const whole = {
    timeline: { title_image: { image_path: '/path/ep.png', enabled: true } },
    subtitles: { srt_path: '/path/ep.srt', enabled: true },
  }
  const strippedWhole = withoutEpisodeFiles(whole)
  assert.equal(strippedWhole?.timeline.title_image.image_path, undefined)
  assert.equal(strippedWhole?.timeline.title_image.enabled, true)
  assert.equal(strippedWhole?.subtitles.srt_path, undefined)

  const sectionTimeline = { title_image: { image_path: '/path/ep.png', enabled: true } }
  const strippedTimeline = withoutEpisodeFiles(sectionTimeline)
  assert.equal(strippedTimeline?.title_image.image_path, undefined)
  assert.equal(strippedTimeline?.title_image.enabled, true)

  const sectionSubtitles = { srt_path: '/path/ep.srt', enabled: true }
  const strippedSubtitles = withoutEpisodeFiles(sectionSubtitles)
  assert.equal(strippedSubtitles?.srt_path, undefined)
  assert.equal(strippedSubtitles?.enabled, true)
})

