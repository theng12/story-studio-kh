/**
 * Character Sheet presets: what a preset may and may not re-decide.
 *
 * ── THIS FILE WAS REVERSED ON 2026-08-18, DELIBERATELY ──────────────────────
 *
 * It was written on 2026-08-03 to enforce the opposite of what it now asserts.
 * The incident behind it was real: the owner set "Visual pacing" to 1–3
 * seconds, applied a preset to change the ART STYLE, and the preset's stored
 * `pacing` silently replaced that choice — 50 of 53 episodes in a live project
 * ended up on a 4–8s band nobody picked. `pacing` was excluded from Character
 * Sheet presets in response.
 *
 * On 2026-08-18 the owner reversed that decision himself, with the incident in
 * front of him. He was offered a safer alternative — a separate, explicit bulk
 * pacing action that could never fire as a side effect — and declined it:
 * *"Put pacing back in presets."* Scene rhythm is preset data again.
 *
 * So this file now asserts the NEW rule, and the reversal is recorded in
 * AGENTS.md → Preset Boundaries. It was rewritten rather than deleted because
 * the reversal has a sharp edge that still needs guarding, and because the
 * history is the only thing that explains why the code looks like this:
 *
 *  1. A preset that STORES a rhythm applies it. That is the new behaviour.
 *  2. A preset that stores NO rhythm leaves the episode's live rhythm exactly
 *     as it is. `usePresets` strips excluded keys on SAVE as well as on load,
 *     so every preset saved between 2026-08-03 and 2026-08-18 contains no
 *     `pacing` whatsoever. Un-excluding the key without this rule would let
 *     `normalizeContinuityConfig` fall back to DEFAULT_SCENE_PACING and reset
 *     those episodes to 1–3s — the original incident, mirrored.
 *
 * ── STILL BINDING, NOT REVERSED ─────────────────────────────────────────────
 *
 * The EPISODE ANCHOR half of the 2026-08-03 fix stands unchanged and is
 * asserted below. Every one of the owner's stored presets carries
 * `references.sheet: true`, which `normalizeContinuityConfig` ORs into
 * `use_episode_sheet` — so applying any of them switched "Use episode anchor"
 * ON, pointing an episode at a sheet it may never have uploaded. The owner
 * asked about rhythm only; the reversal was not widened past that.
 *
 * Both halves are exercised through the real code: the real `usePresets` strip
 * driven by the real `CONTINUITY_PRESET_EXCLUDE_KEYS`, and the real
 * `applyContinuityPagePreset` the page hands to it.
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
  storedPresetPacing,
} = await import('../composables/useContinuityConfig.js')
// Imported from the same shared module continuityDefaults() itself imports
// (electron/server/contracts/pacing.ts, via the @shared/pacing alias) so
// this test asserts against the single source of truth rather than
// restating the expected value as a second literal that could drift from it.
const { DEFAULT_SCENE_PACING } = await import('../../electron/server/contracts/pacing.js')
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
  // Mirrors the page's own notice bookkeeping: it must be able to tell an
  // applied rhythm from a preserved one, and it reads that BEFORE the fold.
  const notices: { applied: boolean }[] = []
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
    apply: (data) => {
      notices.push({ applied: storedPresetPacing(data) !== null })
      config.value = applyContinuityPagePreset(config.value, data)
    },
  })
  return { presets, config, notices }
}

/**
 * Presets saved BEFORE 2026-08-03, shapes taken verbatim from
 * a real project's config.json. These still carry a stored `pacing` — under the
 * reversed rule, that rhythm is now theirs to apply.
 */
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

/**
 * A preset saved between 2026-08-03 and 2026-08-18, i.e. while `pacing` was an
 * excluded key. `usePresets` stripped the key on the way to disk, so there is
 * no `pacing` in the record at all. This is the SHAPE THAT DOMINATES for
 * anybody who kept working through August.
 */
function pacinglessOwnerPreset() {
  return {
    id: 'preset-august-sepia',
    name: 'BL - Sepia Ink',
    type: 'continuity-page',
    data: {
      schema_version: 1,
      anchor_character_ids: [],
      references: { prev_render: true, characters: false, style: true },
      denoise_strength: 0.35,
      style_bible: 'sepia ink look',
      negative_prompt: 'no colour',
    },
  }
}

function seedOwnerConfig(slug = 'my-channel') {
  configStore[slug] = {
    continuity_page_presets: [...storedOwnerPresets(), pacinglessOwnerPreset()],
    'continuity_page_last_preset_continuity-page': '',
  }
}

describe('Character Sheet presets carry the scene rhythm again (2026-08-18 reversal)', () => {
  test('a preset that stores a rhythm applies it', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()

    // The episode is on the dense default…
    config.value.pacing = { min_sec: 1, max_sec: 3 }

    // …and the applied preset stores 5–10s, so the episode moves to 5–10s.
    presets.activeId.value = 'preset-ms-paint'
    assert.ok(presets.applyActive(), 'the stored preset must be applicable')

    assert.deepEqual(
      config.value.pacing,
      { min_sec: 5, max_sec: 10 },
      'the preset\'s stored rhythm is what the episode now uses',
    )
    // …and the LOOK landed too, so this cannot pass on a wholesale overwrite
    // of something unrelated.
    assert.equal(config.value.style_bible, 'MS Paint look')
    assert.equal(config.value.denoise_strength, 0.4)
  })

  test('a preset saved WITHOUT a rhythm leaves the live rhythm untouched', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()

    // The customer deliberately chose 1–3s on this episode.
    config.value.pacing = { min_sec: 1, max_sec: 3 }

    presets.activeId.value = 'preset-august-sepia'
    assert.ok(presets.applyActive())

    assert.deepEqual(
      config.value.pacing,
      { min_sec: 1, max_sec: 3 },
      'a preset with no stored rhythm must not touch the episode\'s rhythm',
    )
    // …and the look it was applied for did land.
    assert.equal(config.value.style_bible, 'sepia ink look')
    assert.equal(config.value.denoise_strength, 0.35)
  })

  test('the built-in default is never what a rhythm-less preset leaves behind', async () => {
    // The dangerous case hides when the live value happens to equal the
    // default: a fallback would look like a no-op. Use a NON-default live
    // value that a fallback would visibly clobber, and assert the default is
    // not what came out.
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 12, max_sec: 20 }

    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()

    assert.deepEqual(config.value.pacing, { min_sec: 12, max_sec: 20 })
    assert.notDeepEqual(
      config.value.pacing,
      DEFAULT_SCENE_PACING,
      'the normaliser\'s default must never be what a rhythm-less preset leaves behind',
    )
  })

  test('an extended documentary pacing profile survives a rhythm-less preset intact', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    const profile = {
      min_sec: 2, max_sec: 5,
      opening_duration_sec: 180,
      settled_min_sec: 6, settled_max_sec: 12,
    }
    config.value.pacing = { ...profile }

    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()
    assert.deepEqual(config.value.pacing, profile, 'the extended formula-pacing fields survive too')
  })

  test('a preset storing a plain band replaces an extended profile wholesale', async () => {
    // Otherwise a 5–10s band would inherit the previous episode's
    // `settled_*` holds and produce a hybrid nobody configured.
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = {
      min_sec: 2, max_sec: 5,
      opening_duration_sec: 180,
      settled_min_sec: 6, settled_max_sec: 12,
    }

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()
    assert.deepEqual(config.value.pacing, { min_sec: 5, max_sec: 10 })
  })

  test('a half-written band is treated as no stored rhythm, not as a partial one', async () => {
    seedOwnerConfig()
    ;(configStore['my-channel'].continuity_page_presets[1].data as any).pacing = { max_sec: 10 }
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()

    assert.deepEqual(
      config.value.pacing,
      { min_sec: 1, max_sec: 3 },
      'half a band cannot express a range; merging it with the default invents one',
    )
  })

  test('switching between stored presets tracks each preset\'s own rhythm', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }

    const expected: Record<string, { min_sec: number; max_sec: number }> = {
      'preset-prehistoric': { min_sec: 4, max_sec: 8 },
      'preset-ms-paint': { min_sec: 5, max_sec: 10 },
    }
    for (const id of ['preset-prehistoric', 'preset-ms-paint', 'preset-prehistoric']) {
      presets.activeId.value = id
      presets.applyActive()
      assert.deepEqual(config.value.pacing, expected[id], `rhythm followed ${id}`)
    }

    // …and a rhythm-less preset applied after them holds the last rhythm.
    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()
    assert.deepEqual(config.value.pacing, { min_sec: 4, max_sec: 8 })
  })

  test('applying never rewrites the customer\'s stored preset', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }
    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()

    assert.equal(
      'pacing' in configStore['my-channel'].continuity_page_presets[2].data,
      false,
      'a rhythm-less preset is not silently back-filled on disk',
    )
    assert.deepEqual(
      configStore['my-channel'].continuity_page_presets[1].data.pacing,
      { min_sec: 5, max_sec: 10 },
      'and a stored rhythm is left exactly as saved',
    )
  })

  test('newly saved presets DO store the rhythm — that is the whole reversal', async () => {
    configStore['my-channel'] = {}
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }
    config.value.style_bible = 'sepia ink'

    assert.ok(await presets.saveAs('BL - Sepia Ink'))
    const stored = configStore['my-channel'].continuity_page_presets[0]
    assert.deepEqual(stored.data.pacing, { min_sec: 1, max_sec: 3 }, 'the rhythm is preset data now')
    assert.equal(stored.data.style_bible, 'sepia ink', 'the look is still saved')
  })

  test('re-saving a rhythm-less preset captures the current rhythm — the UI\'s advice works', async () => {
    // The Character Sheet tells the customer that saving over the preset
    // captures the rhythm. That instruction has to be true.
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()
    config.value.pacing = { min_sec: 8, max_sec: 15 }

    assert.ok(await presets.overwrite())
    const stored = configStore['my-channel'].continuity_page_presets
      .find((p: any) => p.id === 'preset-august-sepia')
    assert.deepEqual(stored.data.pacing, { min_sec: 8, max_sec: 15 })
  })

  test('the page can tell an applied rhythm from a preserved one', async () => {
    seedOwnerConfig()
    const { presets, notices } = makeCharacterSheetPresets('my-channel')
    await presets.load()

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()
    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()

    assert.deepEqual(notices, [{ applied: true }, { applied: false }])
  })

  test('the reversal is scoped: pacing is out of the exclusion list, nothing else moved', () => {
    assert.equal(
      CONTINUITY_PRESET_EXCLUDE_KEYS.includes('pacing'),
      false,
      'pacing is preset data again as of 2026-08-18',
    )
    // usePresets only falls back to DEFAULT_EXCLUDE_KEYS when excludeKeys is
    // omitted, so a page passing its own list must carry these itself.
    for (const key of ['episode_id', 'episodeId', 'episode', 'title']) {
      assert.ok(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), `must exclude ${key}`)
    }
  })

  test('storedPresetPacing reads a rhythm only when the preset really has one', () => {
    assert.deepEqual(storedPresetPacing({ pacing: { min_sec: 5, max_sec: 10 } }), { min_sec: 5, max_sec: 10 })
    assert.equal(storedPresetPacing({}), null)
    assert.equal(storedPresetPacing(null), null)
    assert.equal(storedPresetPacing(undefined), null)
    assert.equal(storedPresetPacing({ pacing: null } as any), null)
    assert.equal(storedPresetPacing({ pacing: {} } as any), null)
    assert.equal(storedPresetPacing({ pacing: { min_sec: 5 } } as any), null)
    assert.equal(storedPresetPacing({ pacing: [] } as any), null)
    assert.equal(storedPresetPacing({ pacing: { min_sec: 'a', max_sec: 10 } } as any), null)
  })

  test('the page surfaces which of the two happened', () => {
    // A rhythm that correctly does not move is indistinguishable from a
    // feature that does not work, so the page must say so in the UI.
    assert.match(characterSheet, /storedPresetPacing\(data\) !== null/)
    assert.match(characterSheet, /pacingPresetNotice\.value = \{ applied, band:/)
    assert.match(characterSheet, /<WorkspaceNotice/)
    assert.match(characterSheet, /has no saved scene rhythm/)
    assert.match(characterSheet, /save over the preset to capture it/)
  })

  test('the rhythm controls carry accessible names', () => {
    // Found in passing while verifying this release in a browser: the rhythm
    // select had no id and its <label> no `for`, so assistive technology
    // announced an unnamed combobox, and the custom min/max inputs announced
    // nothing at all. The repo's convention is label[for] + matching id.
    assert.match(characterSheet, /<label for="cs-visual-pacing">Visual pacing<\/label>/)
    assert.match(characterSheet, /<select id="cs-visual-pacing"/)
    assert.match(characterSheet, /aria-label="Shortest scene, in seconds"/)
    assert.match(characterSheet, /aria-label="Longest scene, in seconds"/)
  })
})

describe('Character Sheet preset / episode anchor boundary — NOT reversed', () => {
  // Every stored preset the owner owns carries `references.sheet: true`, which
  // normalizeContinuityConfig ORs into `use_episode_sheet`. Applying one to
  // change the art style therefore switched the episode anchor ON. The
  // 2026-08-18 reversal covered scene rhythm only; this rule still stands.

  test('applying a preset does not switch the episode anchor ON', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
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
    configStore['my-channel'].continuity_page_presets[0].data.references.sheet = false
    configStore['my-channel'].continuity_page_presets[0].data.use_episode_sheet = false

    const { presets, config } = makeCharacterSheetPresets('my-channel')
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
    const { presets, config } = makeCharacterSheetPresets('my-channel')
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
    const { presets, config } = makeCharacterSheetPresets('my-channel')
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
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.use_episode_sheet = false
    config.value.references.sheet = false
    presets.activeId.value = 'preset-prehistoric'
    presets.applyActive()

    assert.equal(config.value.use_episode_sheet, false)
    assert.equal(
      configStore['my-channel'].continuity_page_presets[0].data.references.sheet,
      true,
      'applying must not rewrite the customer\'s stored preset',
    )
  })

  test('newly saved presets store neither the anchor toggle nor its mirror', async () => {
    configStore['my-channel'] = {}
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.use_episode_sheet = true
    config.value.references.sheet = true
    config.value.references.prev_render = true
    config.value.references.style = true
    config.value.style_bible = 'sepia ink'

    assert.ok(await presets.saveAs('BL - Sepia Ink'))
    const stored = configStore['my-channel'].continuity_page_presets[0]
    assert.equal('use_episode_sheet' in stored.data, false, 'the anchor toggle is episode state')
    assert.equal('sheet' in stored.data.references, false, 'so is its legacy mirror')
    // The genuinely reusable look references are still saved.
    assert.equal(stored.data.references.prev_render, true)
    assert.equal(stored.data.references.style, true)
    assert.equal(stored.data.style_bible, 'sepia ink')
  })

  test('reusable look and rhythm data are deliberately NOT excluded', () => {
    for (const key of ['use_episode_sheet', 'sheet']) {
      assert.ok(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), `must exclude ${key}`)
    }
    // Scope check: the exclusion is surgical. Blanket-excluding `references`
    // would have taken the reusable look data with it.
    for (const key of ['references', 'prev_render', 'style', 'style_bible', 'negative_prompt', 'denoise_strength', 'anchor_character_ids', 'pacing']) {
      assert.equal(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), false, `${key} is preset data and must stay in presets`)
    }
  })

  test('a preset still carries the reusable look references through an apply', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
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

  test('a fresh episode still gets the dense 1-3s default', () => {
    assert.deepEqual(DEFAULT_SCENE_PACING, { min_sec: 1, max_sec: 3 })
    assert.deepEqual(continuityDefaults().pacing, DEFAULT_SCENE_PACING)
    assert.deepEqual(normalizeContinuityConfig(undefined).pacing, DEFAULT_SCENE_PACING)
    assert.deepEqual(normalizeContinuityConfig({}).pacing, DEFAULT_SCENE_PACING)
  })
})
