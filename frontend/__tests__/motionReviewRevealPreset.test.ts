/**
 * The Sketch Draw reveal look in a Motion Review preset (owner correction, 2026-10-27).
 *
 * The reveal style is the EPISODE's own setting now, so a preset has to restore it the way the pen
 * and hold are handled — without ever carrying one episode's per-scene pins onto another. This
 * exercises the real `usePresets` strip and the real apply helper the page hands it (AGENTS.md §5's
 * two traps: `excludeKeys` strips on READ as well as write, so the live pins must be carried across
 * the apply explicitly, and the value's real presence must be checked after it).
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

const { usePresets, DEFAULT_EXCLUDE_KEYS } = await import('../composables/usePresets.js')
const { applyRevealPreset, revealForPreset } = await import('../utils/sketch-reveal.js')

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url)),
  'utf8',
)

beforeEach(() => {
  for (const key of Object.keys(configStore)) delete configStore[key]
})

/** The page's preset controller, wired exactly as the page wires it. */
function makeMotionPresets(slug: string, live: { value: any }) {
  return usePresets<any>({
    slug,
    configKey: 'motion_review',
    presetType: 'motion-review',
    autoApplyOnLoad: false,
    excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'overrides'],
    snapshot: () => ({
      model: 'live-model',
      duration_mode: 'manual',
      ...(revealForPreset(live.value) ? { reveal: revealForPreset(live.value) } : {}),
    }),
    apply: (data: any) => {
      const next = applyRevealPreset(data?.reveal, live.value)
      if (JSON.stringify(next) !== JSON.stringify(live.value)) live.value = next
    },
  })
}

describe('Motion Review presets carry the reveal look', () => {
  test('a saved preset stores the style and mix, and never the per-scene pins', async () => {
    const live = { value: { style: 'mix', mix: ['line', 'bloom'], overrides: { 'scene-2': 'swipes' } } }
    const presets = makeMotionPresets('presets', live)
    await presets.load()
    const saved = await presets.saveAs('Look')
    assert.deepEqual(saved.data.reveal, { style: 'mix', mix: ['line', 'bloom'] })
    assert.equal(saved.data.reveal.overrides, undefined, 'a pin names one episode\'s scene ids')
    // The stored record on disk carries the same, and nothing deeper hides a pin.
    assert.doesNotMatch(JSON.stringify(configStore.presets.motion_review_presets), /overrides|scene-2/)
  })

  test('applying a preset restores the look and KEEPS this episode\'s own pins', async () => {
    const live = { value: { style: 'line', mix: [], overrides: { 'scene-4': 'patches' } } as any }
    const presets = makeMotionPresets('apply', live)
    await presets.load()
    await presets.saveAs('Line look')
    live.value = { style: 'bloom', mix: [], overrides: { 'scene-4': 'patches' } }
    presets.applyActive()
    assert.deepEqual(live.value, { style: 'line', mix: [], overrides: { 'scene-4': 'patches' } })
  })

  test('the applied value is really present — checked as the value, not as "something happened"', async () => {
    const live = { value: null as any }
    const presets = makeMotionPresets('presence', live)
    await presets.load()
    await presets.saveAs('Bloom look')
    // saveAs stored whatever the live value was; a null live value stores no reveal at all.
    assert.equal(configStore.presence.motion_review_presets[0].data.reveal, undefined)
    live.value = { style: 'swipes', mix: [] }
    // A preset with no stored reveal leaves the live look alone rather than blanking it.
    presets.applyActive()
    assert.deepEqual(live.value, { style: 'swipes', mix: [] })
  })

  test('a preset that stored a Mix restores the set; the stored order is not the resolver\'s input', async () => {
    const live = { value: { style: 'mix', mix: ['bloom', 'line', 'patches'] } as any }
    const presets = makeMotionPresets('mix', live)
    await presets.load()
    await presets.saveAs('Mix look')
    live.value = { style: 'line', mix: [] }
    presets.applyActive()
    // The same canonical order the page's own Mix checkboxes produce, so an applied preset and a
    // hand-picked Mix are one value.
    assert.deepEqual(live.value, { style: 'mix', mix: ['line', 'patches', 'bloom'] })
  })

  test('the page wires that look in and carries the live pins across the apply', () => {
    assert.match(page, /excludeKeys: \[\.\.\.DEFAULT_EXCLUDE_KEYS, 'overrides'\]/)
    // A preset must never apply itself on arrival: it would replace this episode's own look.
    assert.match(page, /autoApplyOnLoad: false/)
    assert.match(page, /void motionPresets\.load\(\)/)
    const start = page.indexOf('const motionPresets = usePresets(')
    const snapshot = page.slice(start, page.indexOf('\n  apply:', start))
    assert.ok(snapshot.includes('revealForPreset(episodeReveal.value)'), 'the look is captured')
    const apply = page.slice(page.indexOf('\n  apply:', start))
    assert.match(apply, /if \(revealLoaded\.value\) \{[\s\S]*applyRevealPreset\(data\?\.reveal, episodeReveal\.value\)/)
    assert.match(apply, /void saveReveal\(nextReveal\)/, 'an applied look is saved to THIS episode')
  })
})

describe('the reveal preset helpers', () => {
  test('a preset with no stored style, or one that cannot parse, leaves the live reveal alone', () => {
    const live = { style: 'bloom', mix: [], overrides: { 'scene-1': 'line' } }
    assert.equal(applyRevealPreset(undefined, live), live)
    assert.equal(applyRevealPreset(null, live), live)
    assert.equal(applyRevealPreset({}, live), live)
    assert.equal(applyRevealPreset({ style: 'sparkle', mix: [] }, live), live)
    assert.equal(applyRevealPreset({ style: 'mix', mix: ['line'] }, live), live, 'one type is not a Mix')
  })

  test('the stored look drops the pins and copies the mix, so neither aliases the live value', () => {
    const live = { style: 'mix', mix: ['line', 'bloom'], overrides: { 'scene-1': 'patches' } } as any
    const stored = revealForPreset(live)!
    assert.deepEqual(stored, { style: 'mix', mix: ['line', 'bloom'] })
    assert.notEqual(stored.mix, live.mix)
    assert.equal(revealForPreset(null), null)
  })
})
