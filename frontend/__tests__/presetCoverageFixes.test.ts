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

import { usePresets } from '../composables/usePresets.js'

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
