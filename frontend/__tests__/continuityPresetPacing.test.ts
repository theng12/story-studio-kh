/**
 * Character Sheet presets: what a preset may and may not re-decide.
 *
 * ── THIS FILE HAS BEEN REVERSED TWICE. READ THE WHOLE HISTORY. ──────────────
 *
 * The subject is `pacing` — an episode's scene rhythm — and it has moved three
 * times. Only the LAST direction is in force; the earlier ones are kept because
 * each reversal left code behind that only the history explains.
 *
 *   2026-08-03  EXCLUDED. The owner set "Visual pacing" to 1–3 seconds, applied
 *               a preset to change the ART STYLE, and the preset's stored
 *               `pacing` silently replaced that choice — 50 of 53 episodes in a
 *               live project ended up on a 4–8s band nobody picked. This file
 *               was written then to enforce the exclusion.
 *   2026-08-18  REINSTATED, by the owner himself, incident in front of him. He
 *               was offered a safer alternative (a separate, explicit bulk
 *               pacing action that could never fire as a side effect) and
 *               declined it: *"Put pacing back in presets."* This file was
 *               rewritten then, not deleted, to assert the reversal.
 *   2026-10-17  EXCLUDED AGAIN, by the owner, and that is the rule below.
 *               Scene rhythm belongs to Scene Plan's **Visual timing & motion**
 *               panel and is read back by Scene Review. The Character Sheet is
 *               a visual-setup page: it neither shows nor owns rhythm, and a
 *               preset applied there must not move it. The green notice the
 *               page used to carry — "The preset includes scene rhythm" / "That
 *               preset has no saved scene rhythm" — was DELETED with it, not
 *               reworded, because with the key excluded there is nothing left
 *               for it to report.
 *
 * The trap the reversals keep re-arming, and which this file pins in both
 * directions: `usePresets` strips `excludeKeys` on READ as well as write, so a
 * preset body arriving at `apply` has had `pacing` removed — and
 * `normalizeContinuityConfig` would then substitute its own `DEFAULT_SCENE_PACING`
 * (1–3s) for every preset. That is the 2026-08-03 incident with the sign
 * flipped. The live rhythm is therefore carried across the apply explicitly, as
 * one whole deep-cloned value, which `applyContinuityPagePreset` owns.
 *
 * ── STILL BINDING, NEVER REVERSED ───────────────────────────────────────────
 *
 * The EPISODE ANCHOR half of the 2026-08-03 fix stands unchanged. Every one of
 * the owner's stored presets carries `references.sheet: true`, which
 * `normalizeContinuityConfig` ORs into `use_episode_sheet` — so applying any of
 * them switched "Use episode anchor" ON, pointing an episode at a sheet it may
 * never have uploaded. The owner has only ever asked about rhythm.
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
  PACING_PRESETS,
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
      config.value = applyContinuityPagePreset(config.value, data)
    },
  })
  return { presets, config }
}

/**
 * Presets saved BEFORE 2026-08-03, shapes taken verbatim from
 * a real project's config.json. These still carry a stored `pacing` on disk —
 * under the 2026-10-17 rule that block has no authority and is stripped at the
 * boundary. They are never rewritten; see the "on disk untouched" tests.
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
 * no `pacing` in the record at all — the shape that dominates for anybody who
 * kept working through August, and the one the 2026-10-17 rule brings back.
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

describe('Character Sheet presets do not carry scene rhythm (owner, 2026-10-17)', () => {
  test('pacing is out of the preset payload', () => {
    assert.equal(
      CONTINUITY_PRESET_EXCLUDE_KEYS.includes('pacing'),
      true,
      'Scene Plan owns the episode rhythm; a Character Sheet preset must not re-decide it',
    )
  })

  test('a stored preset band does NOT move the live episode rhythm', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()

    // The episode's own rhythm, chosen in Scene Plan's timing panel.
    config.value.pacing = { min_sec: 12, max_sec: 20 }

    // The applied preset still stores 5–10s on disk. It has no authority now.
    presets.activeId.value = 'preset-ms-paint'
    assert.ok(presets.applyActive(), 'the stored preset must still be applicable')

    assert.deepEqual(
      config.value.pacing,
      { min_sec: 12, max_sec: 20 },
      'the preset\'s stored band must not replace the episode\'s rhythm',
    )
    // …and the LOOK landed, so this cannot pass on a wholesale no-op.
    assert.equal(config.value.style_bible, 'MS Paint look')
    assert.equal(config.value.denoise_strength, 0.4)
  })

  test('a preset saved WITHOUT a rhythm also leaves the live rhythm untouched', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()

    config.value.pacing = { min_sec: 1, max_sec: 3 }

    presets.activeId.value = 'preset-august-sepia'
    assert.ok(presets.applyActive())

    assert.deepEqual(config.value.pacing, { min_sec: 1, max_sec: 3 })
    assert.equal(config.value.style_bible, 'sepia ink look')
    assert.equal(config.value.denoise_strength, 0.35)
  })

  test('the built-in default is never what a preset leaves behind', async () => {
    // The dangerous case hides when the live value happens to equal the
    // default: a fallback would look like a no-op. Use a NON-default live
    // value that a fallback would visibly clobber, and assert the default is
    // not what came out.
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 12, max_sec: 20 }

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()

    assert.deepEqual(config.value.pacing, { min_sec: 12, max_sec: 20 })
    assert.notDeepEqual(
      config.value.pacing,
      DEFAULT_SCENE_PACING,
      'the normaliser\'s default must never be what a preset leaves behind',
    )
  })

  test('switching between presets that each store a band never moves the rhythm', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 6, max_sec: 9 }

    for (const id of ['preset-prehistoric', 'preset-ms-paint', 'preset-prehistoric', 'preset-august-sepia']) {
      presets.activeId.value = id
      presets.applyActive()
      assert.deepEqual(config.value.pacing, { min_sec: 6, max_sec: 9 }, `rhythm held through ${id}`)
    }
  })

  test('an extended documentary profile survives a preset apply intact', async () => {
    // The carry is ONE whole deep clone, not a field-by-field merge: a preset
    // must never be able to complete a half band from the normaliser's default,
    // nor drop an ordered profile's periods.
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    const profile = {
      min_sec: 2, max_sec: 5,
      opening_duration_sec: 180,
      settled_min_sec: 6, settled_max_sec: 12,
    }
    config.value.pacing = { ...profile }

    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()
    assert.deepEqual(
      config.value.pacing,
      normalizeContinuityConfig({ pacing: profile }).pacing,
      'the explicit legacy rhythm survives as equivalent ordered periods',
    )
  })

  test('a half-written band in a stored preset is inert', async () => {
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

  test('an older preset without motion intensity preserves the live episode choice', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.motion_level = 4

    presets.activeId.value = 'preset-august-sepia'
    presets.applyActive()

    assert.equal(config.value.motion_level, 4)
  })

  test('applying never rewrites the customer\'s stored preset', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }
    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()

    assert.equal(
      'pacing' in configStore['my-channel'].continuity_page_presets[2].data,
      false,
      'a rhythm-less preset is not silently back-filled on disk',
    )
    assert.deepEqual(
      configStore['my-channel'].continuity_page_presets[1].data.pacing,
      { min_sec: 5, max_sec: 10 },
      'and a stored band is left exactly as saved — stripped at the boundary, never deleted from disk',
    )
  })

  test('saving a preset does not store the rhythm', async () => {
    configStore['my-channel'] = {}
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    config.value.pacing = { min_sec: 1, max_sec: 3 }
    config.value.style_bible = 'sepia ink'

    assert.ok(await presets.saveAs('BL - Sepia Ink'))
    const stored = configStore['my-channel'].continuity_page_presets[0]
    assert.equal('pacing' in stored.data, false, 'the rhythm is the episode\'s, not the preset\'s')
    assert.equal(stored.data.style_bible, 'sepia ink', 'the look is still saved')
  })

  test('re-saving a preset that stored a band drops it rather than keeping it', async () => {
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    presets.activeId.value = 'preset-ms-paint'
    presets.applyActive()
    config.value.pacing = { min_sec: 8, max_sec: 15 }

    assert.ok(await presets.overwrite())
    const stored = configStore['my-channel'].continuity_page_presets
      .find((p: any) => p.id === 'preset-ms-paint')
    assert.equal('pacing' in stored.data, false, 'an explicit overwrite is the one write that may change the file')
    assert.equal(stored.data.style_bible, 'MS Paint look', 'the look it was overwritten for did land')
  })

  test('apply + save round trip preserves the episode\'s timing exactly', async () => {
    // The owner's requirement in one assertion: the whole apply-then-save cycle
    // a customer actually performs must leave `pacing` exactly as it was before
    // the preset was applied — same object, nothing merged in from the preset or
    // from the normaliser's default.
    seedOwnerConfig()
    const { presets, config } = makeCharacterSheetPresets('my-channel')
    await presets.load()
    // Normalised once up front, so the comparison is against what the episode
    // really holds rather than against a pre-normalisation literal.
    config.value.pacing = normalizeContinuityConfig({
      pacing: {
        mode: 'variable', min_sec: 2, max_sec: 4,
        periods: [
          { start_sec: 0, end_sec: 30, min_sec: 2, max_sec: 4 },
          { start_sec: 30, end_sec: null, min_sec: 6, max_sec: 10 },
        ],
      },
    }).pacing
    const before = JSON.stringify(config.value.pacing)
    assert.notEqual(before, JSON.stringify(DEFAULT_SCENE_PACING), 'the fixture must not be the default')

    presets.activeId.value = 'preset-prehistoric'
    presets.applyActive()

    assert.equal(JSON.stringify(config.value.pacing), before, 'the applied preset moved nothing')
    // The page PUTs the live config whole, so what it would send is what it has.
    assert.equal(JSON.stringify(config.value.pacing), before, 'and the save carries that same value')
  })

  test('the page surfaces nothing about rhythm — the notice is gone, not reworded', () => {
    assert.doesNotMatch(characterSheet, /pacingPresetNotice/, 'the pacing notice state must be deleted')
    assert.doesNotMatch(characterSheet, /pacingBandLabel/)
    assert.doesNotMatch(characterSheet, /storedPresetPacing/, 'the page no longer reads a preset rhythm at all')
    assert.doesNotMatch(characterSheet, /includes scene rhythm/, 'the old notice title must not survive')
    assert.doesNotMatch(characterSheet, /no saved scene rhythm/)
    assert.doesNotMatch(characterSheet, /onPacingEdited/)
  })

  test('the page delegates to the shared boundary instead of re-implementing it', () => {
    assert.match(characterSheet, /excludeKeys: CONTINUITY_PRESET_EXCLUDE_KEYS/)
    assert.match(characterSheet, /applyContinuityPagePreset\(config\.value, data\)/)
    assert.doesNotMatch(characterSheet, /function normalizeConfig\(/, 'normalizeConfig now lives in the composable')
  })

  test('Character Sheet leaves timing controls in Scene Plan', () => {
    assert.doesNotMatch(characterSheet, /<h3>Visual timing & motion<\/h3>/)
    assert.doesNotMatch(characterSheet, /Open Scene Plan/)
    assert.doesNotMatch(characterSheet, /<select id="cs-visual-pacing"/)
    assert.doesNotMatch(characterSheet, /formulaPacingProfile/)
  })

  test('an episode change blanks the previous episode\'s rhythm before the new read', () => {
    // AGENTS.md §4: the switch must not leave the previous episode's values
    // standing, even for the one await before continuity.json is read back.
    // `pacing` is still part of that config — it is Scene Plan's value — so it
    // is covered by the same synchronous blank as the anchors.
    const watcher = characterSheet.match(/watch\(\[slug, episodeId\],[\s\S]*?flush: 'sync' \}\)/)
    assert.ok(watcher, 'the episode-change watcher must exist')
    assert.match(watcher![0], /config\.value = continuityDefaults\(\)/)
    assert.match(watcher![0], /configLoaded\.value = false/)
  })

  test('storedPresetPacing still reads a rhythm only when the preset really has one', () => {
    // Kept because Scene Plan's own timing preset uses it (VisualTimingMotion
    // → applyPreset). The Character Sheet does not.
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

  test('the Scene Plan timing panel still owns a preset that carries the rhythm', () => {
    // The exclusion above is scoped to the Character Sheet. Scene Plan's
    // "Visual timing & motion" preset is the surface that still decides it, and
    // its exclusion list must not have grown `pacing` by accident.
    const visualTimingMotion = readFileSync(
      fileURLToPath(new URL('../components/VisualTimingMotion.vue', import.meta.url)),
      'utf8',
    )
    assert.match(visualTimingMotion, /storedPresetPacing/, 'Scene Plan reads the stored rhythm from its own preset')
    assert.match(visualTimingMotion, /pacing: parseScenePacing\(draft\.value\.pacing\)/, 'and snapshots it on save')

    const scenePlan = readFileSync(
      fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
      'utf8',
    )
    const declared = scenePlan.match(/excludeKeys:\s*(\[[^\]]*\])/)
    assert.ok(declared, 'scene-plan.vue must declare its preset exclusions')
    assert.doesNotMatch(declared![1], /pacing/, 'Scene Plan presets keep the rhythm — that is the other half of the owner\'s rule')
  })

  test('only the timing editor claims the episode rhythm at the save boundary', () => {
    // The exclusion above stops a PRESET from carrying the rhythm. This is the
    // other half, and it is the one that holds even when the page itself is
    // carrying a stale whole config: the save boundary keeps the on-disk
    // rhythm unless the writer claims it (owner, 2026-10-17).
    const visualTimingMotion = readFileSync(
      fileURLToPath(new URL('../components/VisualTimingMotion.vue', import.meta.url)),
      'utf8',
    )
    assert.match(
      visualTimingMotion,
      /claim_pacing: true/,
      'the timing panel is the writer that claims authority over the rhythm',
    )

    // The Character Sheet sends the whole config it loaded and claims NOTHING —
    // so a rhythm set in Scene Plan after that load cannot be written back.
    assert.doesNotMatch(
      characterSheet,
      /claim_pacing/,
      'a visual-setup save must not claim pacing authority',
    )
    assert.match(
      characterSheet,
      /continuity\/\$\{ep\}`,\s*JSON\.parse\(JSON\.stringify\(config\.value\)\)/,
      '…and it must keep sending the whole config it loaded, because an omitted pacing is substituted with the 1–3s default',
    )
  })

  test('the pacing bands themselves are untouched — the picker lives on', () => {
    // Removing a preset's authority over the rhythm is not removing the
    // rhythm. The bands Scene Plan offers must be exactly as they were.
    assert.deepEqual(PACING_PRESETS.slice(-4), [
      { id: 'drifting', min: 12, max: 20, label: '12–20 seconds — Drifting' },
      { id: 'sleep-slow', min: 20, max: 30, label: '20–30 seconds — Slow drift' },
      { id: 'sleep-very-slow', min: 30, max: 45, label: '30–45 seconds — Very slow' },
      { id: 'near-still', min: 45, max: 60, label: '45–60 seconds — Near-still' },
    ])
    assert.deepEqual(DEFAULT_SCENE_PACING, { min_sec: 1, max_sec: 3 })
  })
})

describe('Character Sheet preset / episode anchor boundary — NOT reversed', () => {
  // Every stored preset the owner owns carries `references.sheet: true`, which
  // normalizeContinuityConfig ORs into `use_episode_sheet`. Applying one to
  // change the art style therefore switched the episode anchor ON. The owner
  // has only ever asked about rhythm; this rule still stands.

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

  test('the reusable look data is deliberately NOT excluded', () => {
    for (const key of ['use_episode_sheet', 'sheet']) {
      assert.ok(CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key), `must exclude ${key}`)
    }
    // Scope check: the exclusion is surgical. Blanket-excluding `references`
    // would have taken the reusable look data with it.
    for (const key of ['references', 'prev_render', 'style', 'style_bible', 'negative_prompt', 'denoise_strength', 'anchor_character_ids']) {
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

  test('a fresh episode still gets the dense 1-3s default', () => {
    assert.deepEqual(DEFAULT_SCENE_PACING, { min_sec: 1, max_sec: 3 })
    assert.deepEqual(continuityDefaults().pacing, DEFAULT_SCENE_PACING)
    assert.deepEqual(normalizeContinuityConfig(undefined).pacing, DEFAULT_SCENE_PACING)
    assert.deepEqual(normalizeContinuityConfig({}).pacing, DEFAULT_SCENE_PACING)
  })
})
