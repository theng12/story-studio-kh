/**
 * Regression: a Character Sheet preset is a LOOK. Applying one must not
 * change per-episode decisions the customer made deliberately.
 *
 * Two reported instances of the same defect class — the one AGENTS.md
 * already documents for Video Assembly presets and `title_image.image_path`:
 *
 *  1. PACING. The owner set "Visual pacing" to 1–3 seconds, then applied a
 *     preset to change the ART STYLE. The preset's saved `pacing` silently
 *     replaced that choice, and every episode in the channel ended up on the
 *     preset's 4–8s band (~6s midpoint) — exactly the 5.6–8s scenes Scene
 *     Plan then produced from `continuity.json`.
 *
 *  2. EPISODE ANCHOR. Every one of the owner's stored presets carries
 *     `references.sheet: true`, which `normalizeContinuityConfig` ORs into
 *     `use_episode_sheet` — so applying any of them switched "Use episode
 *     anchor" ON, pointing an episode at a sheet it may never have uploaded.
 *
 * The property under test is behavioural: applying a preset whose STORED data
 * contains these keys must leave the live values untouched. That has to hold
 * for the presets the owner has ALREADY saved, so the exclusion must work on
 * read, not only on future writes — stored files are never rewritten.
 *
 * Both halves of each fix are exercised through the real code: the real
 * `usePresets` strip driven by the real `CONTINUITY_PRESET_EXCLUDE_KEYS`,
 * and the real `applyContinuityPagePreset` the page hands to it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

// ── In-memory config store driving the stubbed $fetch ───────────────────────
const configStore: Record<string, any> = {}

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const match = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (!match) throw new Error(`unexpected fetch: ${url}`)
  const slug = match[1]
  if (!configStore[slug]) configStore[slug] = {}
  if (!options.method || options.method === 'GET') return JSON.parse(JSON.stringify(configStore[slug]))
  if (options.method === 'PUT') {
    Object.assign(configStore[slug], JSON.parse(JSON.stringify(options.body)))
    return { ok: true }
  }
  throw new Error(`unexpected method: ${options.method}`)
}

const { usePresets } = await import('../composables/usePresets.js')
const {
  CONTINUITY_PRESET_EXCLUDE_KEYS,
  applyContinuityPagePreset,
  continuityDefaults,
  normalizeContinuityConfig,
} = await import('../composables/useContinuityConfig.js')
type AnyConfig = ReturnType<typeof continuityDefaults>

const characterSheet = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/character-sheet.vue', import.meta.url)),
  'utf8',
)

beforeEach(() => {
  for (const key of Object.keys(configStore)) delete configStore[key]
})

/**
 * The Character Sheet page's preset controller, wired exactly as the page
 * wires it — same excludeKeys, same apply, same snapshot.
 */
function makeCharacterSheetPresets(slug: string) {
  const config = { value: continuityDefaults() as AnyConfig }
  const presets = usePresets<any>({
    slug,
    configKey: 'continuity_page',
    presetType: 'continuity-page',
    autoApplyOnLoad: false,
    excludeKeys: CONTINUITY_PRESET_EXCLUDE_KEYS,
    snapshot: () => {
      const { updated_at: _drop, ...rest } = config.value
      return JSON.parse(JSON.stringify(rest))
    },
    apply: (data) => { config.value = applyContinuityPagePreset(config.value, data) },
  })
  return { presets, config }
}

// The owner's real presets, shapes taken verbatim from boundful/config.json.
function storedOwnerPresets() {
  return [
    {
      id: 'preset-prehistoric',
      name: 'BL - Prehistoric Character',
      type: 'continuity-page',
      data: {
        schema_version: 1,
        anchor_character_ids: [],
        use_episode_sheet: false,
        pacing: { min_sec: 4, max_sec: 8 },
        references: { prev_render: true, sheet: true, characters: true, style: false, composition: false },
        denoise_strength: 0.5,
        style_bible: 'prehistoric cave-art look',
        negative_prompt: 'no modern objects',
      },
    },
    {
      id: 'preset-ms-paint',
      name: 'BL - MS Paint',
      type: 'continuity-page',
      data: {
        schema_version: 1,
        anchor_character_ids: [],
        use_episode_sheet: false,
        pacing: { min_sec: 5, max_sec: 10 },
        references: { prev_render: true, sheet: true, characters: true, style: false },
        denoise_strength: 0.4,
        style_bible: 'MS Paint look',
        negative_prompt: '',
      },
    },
  ]
}

function seedOwnerConfig(slug = 'boundful') {
  configStore[slug] = {
    continuity_page_presets: storedOwnerPresets(),
    'continuity_page_last_preset_continuity-page': '',
  }
}

describe('Character Sheet preset / episode pacing boundary', () => {
  test('applying an already-saved preset leaves the chosen pacing untouched', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()

    // The owner picks "1–3 seconds — Rapid & lively"…
    config.value.pacing = { min_sec: 1, max_sec: 3 }

    // …then applies a preset purely to change the art style.
    presets.activeId.value = 'preset-prehistoric'
    assert.ok(presets.applyActive(), 'the stored preset must be applicable')

    assert.deepEqual(
      config.value.pacing,
      { min_sec: 1, max_sec: 3 },
      'a style preset must not overwrite the pacing the customer just chose',
    )
    // …and the LOOK it was applied for did land, so the assertion above
    // cannot be satisfied by an apply that quietly did nothing.
    assert.equal(config.value.style_bible, 'prehistoric cave-art look')
    assert.equal(config.value.negative_prompt, 'no modern objects')
    assert.equal(config.value.references.prev_render, true)
  })

  test('the exclusion is on read — the stored preset file is not rewritten', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }
    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()

    assert.deepEqual(config.value.pacing, { min_sec: 1, max_sec: 3 })
    assert.deepEqual(
      configStore['boundful'].continuity_page_presets[1].data.pacing,
      { min_sec: 5, max_sec: 10 },
      'applying must not rewrite the customer\'s stored preset',
    )
  })

  test('switching between several stored presets never drifts the pacing', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }

    for (const id of ['preset-prehistoric', 'preset-ms-paint', 'preset-prehistoric']) {
      presets.activeId.value = id
      presets.applyActive()
      assert.deepEqual(config.value.pacing, { min_sec: 1, max_sec: 3 }, `pacing survived applying ${id}`)
    }
    assert.equal(config.value.style_bible, 'prehistoric cave-art look')
    assert.equal(config.value.denoise_strength, 0.5)
  })

  test('a documentary pacing profile survives an applied preset intact', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    const profile = {
      min_sec: 2, max_sec: 5,
      opening_duration_sec: 180,
      settled_min_sec: 6, settled_max_sec: 12,
    }
    config.value.pacing = { ...profile }

    presets.activeId.value = 'preset-prehistoric'
    presets.applyActive()
    assert.deepEqual(config.value.pacing, profile, 'the extended formula-pacing fields survive too')
  })

  test('newly saved presets no longer store pacing at all', async () => {
    configStore['boundful'] = {}
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }
    config.value.style_bible = 'sepia ink'

    assert.ok(await presets.saveAs('BL - Sepia Ink'))
    const stored = configStore['boundful'].continuity_page_presets[0]
    assert.equal('pacing' in stored.data, false, 'a style preset must not snapshot episode pacing')
    assert.equal(stored.data.style_bible, 'sepia ink', 'the look is still saved')
  })

  test('the exclusion list keeps usePresets\' per-episode identifiers', () => {
    // usePresets only falls back to DEFAULT_EXCLUDE_KEYS when excludeKeys is
    // omitted, so a page passing its own list must carry these itself.
    for (const key of ['pacing', 'episode_id', 'episodeId', 'episode', 'title']) {
      assert.ok(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), `must exclude ${key}`)
    }
  })
})

describe('Character Sheet preset / episode anchor boundary', () => {
  // Every stored preset the owner owns carries `references.sheet: true`, which
  // normalizeContinuityConfig ORs into `use_episode_sheet`. Applying one to
  // change the art style therefore switched the episode anchor ON.

  test('applying a preset does not switch the episode anchor ON', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()

    // The customer has NO episode anchor for this episode.
    config.value.use_episode_sheet = false
    config.value.references.sheet = false

    presets.activeId.value = 'preset-prehistoric'
    assert.ok(presets.applyActive())

    assert.equal(config.value.use_episode_sheet, false, 'a style preset must not turn the episode anchor on')
    assert.equal(config.value.references.sheet, false, 'the legacy mirror must stay in step')
    // …and the LOOK it was applied for did land, so this cannot pass on a no-op.
    assert.equal(config.value.style_bible, 'prehistoric cave-art look')
    assert.equal(config.value.references.prev_render, true, 'reusable look references still apply')
  })

  test('applying a preset does not switch the episode anchor OFF', async () => {
    seedOwnerConfig()
    // A preset that stores the anchor as OFF — the mirror image of the bug.
    configStore['boundful'].continuity_page_presets[0].data.references.sheet = false
    configStore['boundful'].continuity_page_presets[0].data.use_episode_sheet = false

    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()

    // The customer deliberately switched the episode anchor ON.
    config.value.use_episode_sheet = true
    config.value.references.sheet = true

    presets.activeId.value = 'preset-prehistoric'
    assert.ok(presets.applyActive())

    assert.equal(config.value.use_episode_sheet, true, 'a style preset must not turn the episode anchor off')
    assert.equal(config.value.references.sheet, true, 'the legacy mirror must stay in step')
    assert.equal(config.value.style_bible, 'prehistoric cave-art look')
  })

  test('an anchor held only in the legacy references.sheet mirror survives', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()

    // Older continuity.json files carried the choice only in the mirror.
    config.value.use_episode_sheet = false
    config.value.references.sheet = true

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()

    assert.equal(config.value.use_episode_sheet, true, 'the legacy-only anchor is preserved, not dropped')
    assert.equal(config.value.references.sheet, true)
  })

  test('switching between several stored presets never drifts the anchor', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.use_episode_sheet = false
    config.value.references.sheet = false

    for (const id of ['preset-prehistoric', 'preset-ms-paint', 'preset-prehistoric']) {
      presets.activeId.value = id
      presets.applyActive()
      assert.equal(config.value.use_episode_sheet, false, `anchor survived applying ${id}`)
      assert.equal(config.value.references.sheet, false, `mirror survived applying ${id}`)
    }
  })

  test('the exclusion is on read — the stored preset still says sheet: true', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.use_episode_sheet = false
    config.value.references.sheet = false
    presets.activeId.value = 'preset-prehistoric'
    presets.applyActive()

    assert.equal(config.value.use_episode_sheet, false)
    assert.equal(
      configStore['boundful'].continuity_page_presets[0].data.references.sheet,
      true,
      'applying must not rewrite the customer\'s stored preset',
    )
  })

  test('newly saved presets store neither the anchor toggle nor its mirror', async () => {
    configStore['boundful'] = {}
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.use_episode_sheet = true
    config.value.references.sheet = true
    config.value.references.prev_render = true
    config.value.references.style = true
    config.value.style_bible = 'sepia ink'

    assert.ok(await presets.saveAs('BL - Sepia Ink'))
    const stored = configStore['boundful'].continuity_page_presets[0]
    assert.equal('use_episode_sheet' in stored.data, false, 'the anchor toggle is episode state')
    assert.equal('sheet' in stored.data.references, false, 'so is its legacy mirror')
    // The genuinely reusable look references are still saved.
    assert.equal(stored.data.references.prev_render, true)
    assert.equal(stored.data.references.style, true)
    assert.equal(stored.data.style_bible, 'sepia ink')
  })

  test('reusable look references are deliberately NOT excluded', () => {
    for (const key of ['use_episode_sheet', 'sheet']) {
      assert.ok(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), `must exclude ${key}`)
    }
    // Scope check: the exclusion is surgical. Blanket-excluding `references`
    // would have taken the reusable look data with it.
    for (const key of ['references', 'prev_render', 'style', 'style_bible', 'negative_prompt', 'denoise_strength', 'anchor_character_ids']) {
      assert.equal(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), false, `${key} is reusable look data and must stay in presets`)
    }
  })

  test('a preset still carries the reusable look references through an apply', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('boundful')
    await presets.load()
    config.value.references.prev_render = false
    config.value.references.style = false
    config.value.denoise_strength = 0.9

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()

    assert.equal(config.value.references.prev_render, true, 'the preset\'s look reference applied')
    assert.equal(config.value.denoise_strength, 0.4, 'the preset\'s denoise applied')
    assert.equal(config.value.style_bible, 'MS Paint look')
  })

  test('the page delegates to the shared boundary instead of re-implementing it', () => {
    assert.match(characterSheet, /excludeKeys: CONTINUITY_PRESET_EXCLUDE_KEYS/)
    assert.match(characterSheet, /applyContinuityPagePreset\(config\.value, data\)/)
    assert.doesNotMatch(characterSheet, /function normalizeConfig\(/, 'normalizeConfig now lives in the composable')
  })

  test('a fresh episode still gets the dense 1-4s default', () => {
    assert.deepEqual(continuityDefaults().pacing, { min_sec: 1, max_sec: 4 })
    assert.deepEqual(normalizeContinuityConfig(undefined).pacing, { min_sec: 1, max_sec: 4 })
    assert.deepEqual(normalizeContinuityConfig({}).pacing, { min_sec: 1, max_sec: 4 })
  })
})
