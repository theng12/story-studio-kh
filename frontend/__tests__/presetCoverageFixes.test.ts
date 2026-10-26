/**
 * The three preset gaps fixed on 2026-10-27, proved through the REAL composable.
 *
 * `presetFieldCoverage.test.ts` is the inventory: it proves every field on a
 * preset page is classified, not that the classification is honest at runtime.
 * These four drive the real `usePresets` with an in-memory config, so what lands
 * on disk and what reaches the live form are both asserted.
 *
 * The defects, all the same shape — a reusable setting that no preset carried:
 *   1. B-Roll's transcription model had NO durable home at all.
 *   2. Thumbnail Generator / Scene Review / Episode Builder's published output
 *      SIZE was stored by nobody; each row is priced differently.
 *   3. Video Assembly's Timeline slot stored `scene_reveal` and never restored it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'

import { DEFAULT_EXCLUDE_KEYS, usePresets } from '../composables/usePresets.js'

const configStore: Record<string, any> = {}

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const match = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (!match) throw new Error(`unexpected fetch: ${url}`)
  const slug = match[1]
  if (!configStore[slug]) configStore[slug] = {}
  if (!options.method || options.method === 'GET') return { ...configStore[slug] }
  if (options.method === 'PUT') {
    Object.assign(configStore[slug], JSON.parse(JSON.stringify(options.body)))
    return { ok: true }
  }
  throw new Error(`unexpected method: ${options.method}`)
}

beforeEach(() => {
  for (const key of Object.keys(configStore)) delete configStore[key]
})

const source = (name: string) => readFileSync(
  fileURLToPath(new URL(`../pages/projects/[slug]/${name}`, import.meta.url)),
  'utf8',
)

// ── 1. B-Roll: the transcription model ──────────────────────────────────────
//
// The page remembered it nowhere: no preset key, no remembered form, no config
// write. Subtitles has always saved the same field in its own preset, and
// Pipeline reads that pool for exactly this reason.

describe('the B-Roll preset carries the transcription model', () => {
  interface Live { form: Record<string, any>; model: string }

  function controller(slug: string, live: Live) {
    return usePresets<any>({
      slug,
      configKey: 'broll',
      presetType: 'broll',
      snapshot: () => ({ form: { ...live.form }, transcription_model: live.model }),
      apply: (data) => {
        if (data?.form) Object.assign(live.form, data.form)
        if (typeof data?.transcription_model === 'string' && data.transcription_model) {
          live.model = data.transcription_model
        }
      },
    })
  }

  test('a saved preset stores the model and a reload restores it', async () => {
    const live: Live = { form: { selection_mode: 'tagged', episode_id: 'TN0042' }, model: 'whisper-live' }
    const presets = controller('broll-model-save', live)
    await presets.saveAs('Channel transcription')

    const stored = configStore['broll-model-save'].broll_presets[0].data
    assert.equal(stored.transcription_model, 'whisper-live', 'the model must be in the preset')
    assert.equal('episode_id' in stored.form, false, 'the §4 identity leak must not return')

    const reopened: Live = { form: { selection_mode: 'random', episode_id: 'TN0043' }, model: '' }
    await controller('broll-model-save', reopened).load()
    assert.equal(reopened.model, 'whisper-live', 'reopening the page restores the channel’s model')
    assert.equal(reopened.form.selection_mode, 'tagged', 'the rest of the tuning still travels')
    assert.equal(reopened.form.episode_id, 'TN0043', 'the preset must not move the episode')
  })

  test('a preset saved before this key existed leaves the live pick alone', async () => {
    configStore['broll-model-legacy'] = {
      broll_presets: [{
        id: 'legacy',
        name: 'Old tuning',
        type: 'broll',
        data: { form: { selection_mode: 'tagged' } },
      }],
      broll_last_preset_broll: 'legacy',
    }
    const live: Live = { form: { selection_mode: 'random' }, model: 'catalogue-pick' }
    await controller('broll-model-legacy', live).load()
    assert.equal(live.model, 'catalogue-pick', 'an absent key must not blank the catalogue’s pick')
    assert.equal(live.form.selection_mode, 'tagged')
  })

  test('the page itself wires both halves', () => {
    const page = source('broll.vue')
    assert.match(page, /transcription_model: brollGenstudioModel\.value/, 'the snapshot must capture it')
    assert.match(page, /brollGenstudioModel\.value = data\.transcription_model/, 'the apply must restore it')
  })
})

// ── 2. The published output size ────────────────────────────────────────────
//
// Three pages share `scene_review_genstudio` / `thumbnail_generator`. Each row
// GenStudio publishes is priced differently (1K 4 credits, 2K 9 credits in the
// contract fixtures), so losing the pick is losing a price the customer chose.

describe('the published output size travels with the preset', () => {
  interface Live { form: Record<string, any>; output: { resolution: string; aspect_ratio: string } | null }

  function controller(slug: string, configKey: string, live: Live, presetType?: 'scene-review') {
    return usePresets<any>({
      slug,
      configKey,
      ...(presetType ? { presetType } : {}),
      snapshot: () => ({
        form: { ...live.form },
        ...(live.output ? { output_option: { ...live.output } } : {}),
      }),
      apply: (data) => {
        if (data?.form) Object.assign(live.form, data.form)
        const stored = data?.output_option
        if (stored && typeof stored.resolution === 'string' && typeof stored.aspect_ratio === 'string') {
          live.output = { resolution: stored.resolution, aspect_ratio: stored.aspect_ratio }
        }
      },
    })
  }

  for (const [page, configKey] of [
    ['scene-review.vue', 'scene_review_genstudio'],
    ['images.vue', 'thumbnail_generator'],
    ['episode-builder.vue', 'scene_review_genstudio'],
  ] as const) {
    test(`${page} stores and restores the row`, async () => {
      const slug = `output-${configKey}-${page}`
      const live: Live = { form: { model: 'image-model' }, output: { resolution: '2K', aspect_ratio: '16:9' } }
      await controller(slug, configKey, live).saveAs('2K look')
      const stored = configStore[slug][`${configKey}_presets`][0].data
      assert.deepEqual(stored.output_option, { resolution: '2K', aspect_ratio: '16:9' })

      const reopened: Live = { form: { model: '' }, output: null }
      await controller(slug, configKey, reopened).load()
      assert.deepEqual(reopened.output, { resolution: '2K', aspect_ratio: '16:9' })
    })

    test(`${page} wires both halves`, () => {
      const pageSource = source(page)
      assert.match(pageSource, /output_option: \{ \.\.\.outputOption\.value \}/, 'the snapshot must capture the row')
      assert.match(pageSource, /outputOption\.value = \{ resolution: stored\.resolution/, 'the apply must restore it')
    })
  }

  test('a preset saved before the row was stored leaves the picker to reconcile', async () => {
    const slug = 'output-legacy'
    configStore[slug] = {
      scene_review_genstudio_presets: [{
        id: 'legacy',
        name: 'Ratio only',
        type: 'scene-review',
        data: { form: { model: 'image-model', aspect_ratio: '9:16' } },
      }],
      'scene_review_genstudio_last_preset_scene-review': 'legacy',
    }
    const live: Live = { form: { model: '' }, output: null }
    await controller(slug, 'scene_review_genstudio', live, 'scene-review').load()
    assert.equal(live.output, null, 'no stored row must not invent one — the picker reconciles live')
    assert.equal(live.form.aspect_ratio, '9:16', 'the ratio it did store still travels')
  })
})

// ── 3. Video Assembly: the reveal look the Timeline slot stored but dropped ──

describe('the Video Assembly Timeline slot restores the reveal look', () => {
  test('the slot preset applies `scene_reveal`, not only stores it', () => {
    const page = source('video-assembly.vue')
    // The Timeline controller's own apply branch. Before 2026-10-27 it called
    // `applyTitleImagePreset` first and never reached the reveal block, so the
    // page showed one look while the saved preset — and the batch flattener —
    // held another.
    const controller = page.match(/const timelinePresets = usePresets\(\{[\s\S]*?\n\}\)/)
    assert.ok(controller, 'expected the Timeline preset controller')
    assert.match(controller[0], /apply: \(data: any\) => \{[\s\S]{0,600}?applyRevealBundle\(data\)/,
      'the apply must restore the reveal block the snapshot stores')
    assert.match(controller[0], /scene_reveal: revealBundleSnapshot\(\)/,
      'and it must still store it — the batch flattener reads it from here')
  })
})

// ── 4. Audio Assembly: settings travel, files never do ──────────────────────
//
// Owner, 2026-10-27: *"it was an outdated approach … let's just modernize it
// right now."* A preset keeps the music SETTINGS; every path is the episode's.
// Driven through the REAL composable, because the strip has to happen at the
// read boundary — before `apply` ever sees a preset written while file paths
// were still allowed.

describe('the Audio Assembly preset carries settings and never a file', () => {
  const PATH_KEYS = ['files', 'file', 'custom_file', 'source_path']

  interface MergeLive {
    music: Record<string, any>
    intro: Record<string, any>
    backgroundNoise: Record<string, any>
    ambient: Array<Record<string, any>>
  }

  function controller(slug: string, live: MergeLive) {
    // Mirrors the page's controller, including its explicit carry of the
    // episode's own selection across the apply (AGENTS.md §5, trap 1).
    return usePresets<any>({
      slug,
      configKey: 'audio_merge',
      excludeKeys: [...DEFAULT_EXCLUDE_KEYS, ...PATH_KEYS],
      snapshot: () => ({
        intro: JSON.parse(JSON.stringify(live.intro)),
        music: JSON.parse(JSON.stringify(live.music)),
        background_noise: JSON.parse(JSON.stringify(live.backgroundNoise)),
        ambient_tracks: live.ambient.map(t => ({ ...t })),
      }),
      apply: (data) => {
        if (!data) return
        const liveFiles = [...live.music.files]
        const liveIntroFile = live.intro.file
        const liveNoiseFile = live.backgroundNoise.custom_file
        const liveAmbientPaths = live.ambient.map(t => t.source_path)

        if (data.intro) Object.assign(live.intro, data.intro)
        if (data.music) {
          Object.assign(live.music, data.music, {
            source: data.music.source === 'pool' || data.music.source === 'manual'
              ? data.music.source
              : liveFiles.length ? 'manual' : 'pool',
          })
        }
        if (data.background_noise) Object.assign(live.backgroundNoise, data.background_noise)
        if (Array.isArray(data.ambient_tracks)) {
          live.ambient.splice(0, live.ambient.length, ...data.ambient_tracks.map((t: any) => ({ ...t })))
          live.ambient.forEach((track, index) => {
            const path = liveAmbientPaths[index]
            if (path) track.source_path = path
          })
        }
        live.music.files = liveFiles
        live.intro.file = liveIntroFile
        live.backgroundNoise.custom_file = liveNoiseFile
        live.ambient.forEach((track, index) => {
          const path = liveAmbientPaths[index]
          if (path) track.source_path = path
        })
      },
    })
  }

  const liveState = (files: string[] = []): MergeLive => ({
    music: { enabled: true, source: 'manual', files: [...files], volume: 6, post_narration_volume: 40, fade_in: 3, fade_out: 5, lead_in_enabled: false, lead_in_seconds: 8 },
    intro: { enabled: true, file: '/episode/intro.mp3', volume: 100, gap_after: 2 },
    backgroundNoise: { enabled: false, mode: 'preset', preset: 'brown-noise', custom_file: '/episode/rain.mp3', volume: 15, fade_in: 3, fade_out: 5 },
    ambient: [{ id: 'amb_1', enabled: true, source_path: '/episode/wind.mp3', source_filename: 'wind.mp3', volume: 20, fade_in: 2, fade_out: 3, loop: true }],
  })

  test('saving writes every setting and no path at any depth', async () => {
    const presets = controller('audio-merge-save', liveState(['/episode/bed-a.mp3']))
    await presets.saveAs('Quiet bed')

    const stored = configStore['audio-merge-save'].audio_merge_presets[0].data
    assert.equal(stored.music.volume, 6, 'the level is a setting and travels')
    assert.equal(stored.music.post_narration_volume, 40)
    assert.equal(stored.music.fade_in, 3)
    assert.equal(stored.intro.volume, 100, 'the intro level travels')
    assert.equal(stored.intro.gap_after, 2)
    assert.equal(stored.background_noise.volume, 15)
    assert.equal(stored.ambient_tracks[0].volume, 20, 'the layer settings travel')

    const json = JSON.stringify(stored)
    assert.equal(json.includes('/episode/'), false, `no episode path may ride along: ${json}`)
    assert.equal('files' in stored.music, false)
    assert.equal('file' in stored.intro, false)
    assert.equal('custom_file' in stored.background_noise, false)
    assert.equal('source_path' in stored.ambient_tracks[0], false)
  })

  test('a preset written while paths were allowed stops restoring them on read', async () => {
    // Exactly what is on disk in projects saved before 2026-10-27.
    configStore['audio-merge-legacy'] = {
      audio_merge_presets: [{
        id: 'legacy-paths',
        name: 'Old bed',
        data: {
          music: { enabled: true, source: 'manual', files: ['/other-episode/bed.mp3'], volume: 12 },
          intro: { enabled: true, file: '/other-episode/intro.mp3', volume: 80, gap_after: 1 },
          background_noise: { enabled: true, custom_file: '/other-episode/rain.mp3', volume: 9 },
          ambient_tracks: [{ id: 'amb_x', enabled: true, source_path: '/other-episode/wind.mp3', volume: 30 }],
        },
      }],
      audio_merge_last_preset: 'legacy-paths',
    }

    const live = liveState(['/this-episode/bed.mp3'])
    live.intro.file = '/this-episode/intro.mp3'
    live.backgroundNoise.custom_file = '/this-episode/rain.mp3'
    live.ambient = [{ id: 'amb_1', enabled: false, source_path: '/this-episode/wind.mp3', volume: 10, fade_in: 1, fade_out: 1 }]

    await controller('audio-merge-legacy', live).load()

    // Settings still restore.
    assert.equal(live.music.volume, 12)
    assert.equal(live.intro.volume, 80)
    assert.equal(live.backgroundNoise.volume, 9)
    // The other episode's files are gone; this episode's own are intact.
    assert.deepEqual(live.music.files, ['/this-episode/bed.mp3'], 'the live playlist is neither replaced nor blanked')
    assert.equal(live.intro.file, '/this-episode/intro.mp3')
    assert.equal(live.backgroundNoise.custom_file, '/this-episode/rain.mp3')
    assert.equal(live.ambient[0]!.source_path, '/this-episode/wind.mp3')
    assert.equal(JSON.stringify(live).includes('/other-episode/'), false, 'no foreign path survives the apply')
  })

  test('the stored preset on disk is never rewritten by the strip', async () => {
    const original = {
      id: 'legacy-untouched',
      name: 'Old bed',
      data: { music: { enabled: true, source: 'manual', files: ['/other-episode/bed.mp3'], volume: 12 } },
    }
    configStore['audio-merge-untouched'] = {
      audio_merge_presets: [JSON.parse(JSON.stringify(original))],
      audio_merge_last_preset: 'legacy-untouched',
    }

    await controller('audio-merge-untouched', liveState()).load()

    assert.deepEqual(
      configStore['audio-merge-untouched'].audio_merge_presets[0], original,
      'AGENTS.md §5 trap 2: the exclusion is a read-boundary rule, not a migration',
    )
  })

  test('an episode switch never carries the previous episode’s files', () => {
    // The page clears its per-episode state on every episode change. This pins
    // the rule the preset work depends on: files live with the episode.
    const page = source('audio-merge.vue')
    const watcher = page.slice(page.indexOf('watch([slug, episodeId]'), page.indexOf('// A completed merge may advance'))
    assert.match(watcher, /poolPickedPath\.value = ''/, 'the previous episode’s pool pick is cleared')
    assert.match(watcher, /scannedAssets\.value = null/, 'the previous episode’s asset scan is cleared')
    assert.match(page, /const liveFiles = \[\.\.\.music\.files\]/, 'apply reads the live selection before writing')
    assert.match(page, /music\.files = liveFiles/, 'and puts it back after')
  })
})

// ── 5. Video Assembly: the bundle cannot carry one episode's files ──────────
//
// Found in the real production presets (read-only, 2026-10-27): 45 path-valued
// keys across the stored bundles, including another episode's
// `title_image.image_path` and one episode's `subtitles.srt_path`. The bundle
// carries a full copy of every slot, so it inherits every slot's episode paths —
// and its own controller had no exclusion list at all.

describe('the Video Assembly bundle carries the channel’s assets, not an episode’s', () => {

  interface BundleLive {
    fallback: Record<string, any>
  }

  /** The page's own rule: episode files removed BY POSITION, not by key name. */
  function withoutEpisodeFiles<T extends Record<string, any>>(fallback: T | null | undefined): T | undefined {
    if (!fallback || typeof fallback !== 'object') return fallback ?? undefined
    const copy = JSON.parse(JSON.stringify(fallback))
    if (copy.timeline?.title_image) delete copy.timeline.title_image.image_path
    if (copy.subtitles) delete copy.subtitles.srt_path
    return copy
  }

  function controller(slug: string, live: BundleLive) {
    return usePresets<any>({
      slug,
      configKey: 'video_bundle',
      excludeKeys: [...DEFAULT_EXCLUDE_KEYS],
      snapshot: () => ({ fallback: withoutEpisodeFiles(live.fallback) }),
      apply: (data) => {
        if (data?.fallback) live.fallback = JSON.parse(JSON.stringify(withoutEpisodeFiles(data.fallback)))
      },
    })
  }

  /** One bundle shaped exactly like the stored ones. */
  const storedBundle = () => ({
    intro: { enabled: true, video_path: '${CHANNEL}/assets/intro.mp4' },
    timeline: {
      title_image: { enabled: true, image_path: '${PROJECT}/Season 001/EP0019 - title.png', duration: 5 },
      scene_recycling: { seconds_per_scene: 10 },
    },
    effects: { logo: { enabled: true, image_path: '${CHANNEL}/assets/logo.png' }, overlays: { enabled: false, layers: [] } },
    subtitles: { enabled: true, srt_path: '${PROJECT}/Season 002/EP0021 - captions.srt', style: { schema_version: 2 } },
    export: { resolution: '1080p' },
  })

  test('an episode’s title image and caption file are stripped at any depth', async () => {
    const live: BundleLive = { fallback: storedBundle() }
    await controller('bundle-save', live).saveAs('Channel bundle')

    const stored = configStore['bundle-save'].video_bundle_presets[0].data
    const json = JSON.stringify(stored)
    assert.equal(json.includes('EP0019'), false, 'another episode’s title image must not ride along')
    assert.equal(json.includes('EP0021'), false, 'one episode’s caption file must not ride along')

    // The channel's own assets DO travel: a batch cannot render without them.
    assert.equal(stored.fallback.intro.video_path, '${CHANNEL}/assets/intro.mp4')
    assert.equal(stored.fallback.effects.logo.image_path, '${CHANNEL}/assets/logo.png')
    assert.equal(stored.fallback.timeline.title_image.duration, 5, 'the reusable timing still travels')
    assert.equal(stored.fallback.export.resolution, '1080p')
  })

  test('a bundle already on disk stops restoring them, and is not rewritten', async () => {
    const original = {
      id: 'legacy-bundle',
      name: 'BW - No Intro',
      data: { fallback: storedBundle() },
    }
    configStore['bundle-legacy'] = {
      video_bundle_presets: [JSON.parse(JSON.stringify(original))],
      video_bundle_last_preset: 'legacy-bundle',
    }

    const live: BundleLive = { fallback: {} }
    await controller('bundle-legacy', live).load()

    assert.equal(JSON.stringify(live.fallback).includes('EP0019'), false,
      'the previous episode’s title image is gone')
    assert.equal(JSON.stringify(live.fallback).includes('EP0021'), false,
      'the previous episode’s caption file is gone')
    assert.equal(live.fallback.effects.logo.image_path, '${CHANNEL}/assets/logo.png',
      'the channel’s logo still applies')
    assert.deepEqual(
      configStore['bundle-legacy'].video_bundle_presets[0], original,
      'AGENTS.md §5 trap 2: the exclusion is a read-boundary rule, not a migration',
    )
  })

  test('the page strips them by position, on write AND on read', () => {
    const page = source('video-assembly.vue')
    assert.ok(page.includes('function withoutEpisodeFiles'), 'the strip helper must exist')
    assert.ok(page.includes('fallback: withoutEpisodeFiles({'), 'the snapshot must strip on write')
    assert.ok(page.includes('const fb = withoutEpisodeFiles(data.fallback?.[s.fallbackKey])'),
      'a bundle stored before this must be cleaned on read too')
    // The logo's own image_path is a CHANNEL asset and must survive — which is
    // why this cannot be an `excludeKeys` entry.
    const bundleController = page.slice(page.indexOf("configKey: 'video_bundle'"), page.indexOf("configKey: 'video_bundle'") + 400)
    assert.equal(bundleController.includes("'image_path'"), false,
      'listing image_path in the bundle excludeKeys would strip the logo too')
  })
})
