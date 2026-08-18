/**
 * v1.4.1 — an overlay's look is reusable; its window belongs to one episode.
 *
 * The owner's ruling, 2026-08-18: *"overlays should belong to episodes and can
 * be in the presets because i might want to randomize the overlays effects."*
 *
 * Two things that sound contradictory and are not. Which overlay file, its
 * opacity, scale, position and chroma key are taste, and he wants to shuffle
 * between them. `time_range` — when that overlay appears in THIS episode — is a
 * fact about one episode's runtime: a flourish over the closing line of a
 * 16-minute episode lands mid-sentence in a 9-minute one.
 *
 * This is the SIXTH instance of one documented shape (AGENTS.md, "Preset
 * Boundaries"): episode-specific state surviving an episode change. Overlay
 * windows had both routes in — a preset carried them, and an episode change
 * never revisited them.
 *
 * Three properties are pinned here, and the third is the one that makes his
 * randomising request safe:
 *
 *   1. A preset carries the look and never the window.
 *   2. An episode change REPLACES windows; it never fills a gap.
 *   3. Because the window is not in the preset, no shuffle over presets can
 *      reach it. The guarantee is structural, not a rule a future randomiser
 *      has to remember.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applyOverlayTimings,
  collectOverlayTimings,
  isUsableRange,
  migrateLegacyOverlayTimings,
  overlayLayersForPreset,
  timingsForEpisode,
  withEpisodeTimings,
} from '../utils/overlay-timing.js'

const layer = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  source_path: '${PROJECT}/overlays/dust.mov',
  opacity: 0.6,
  scale: 'cover' as const,
  chroma_key: null,
  loop: true,
  ...extra,
})

test('a preset carries every look property and no window', () => {
  const layers = [
    layer('a', { time_range: { start_s: 12, end_s: 40 } }),
    layer('b', { time_range: null, position_anchor: 'lower-right' }),
  ]
  const preset = overlayLayersForPreset(layers) as Array<Record<string, unknown>>

  for (const l of preset) {
    assert.ok(!('time_range' in l), 'a preset must not carry an overlay window')
  }
  // Everything that makes it a look survives — he explicitly wants these reused.
  assert.equal(preset[0]!.opacity, 0.6)
  assert.equal(preset[0]!.scale, 'cover')
  assert.equal(preset[0]!.source_path, '${PROJECT}/overlays/dust.mov')
  assert.equal(preset[0]!.loop, true)
  assert.equal(preset[1]!.position_anchor, 'lower-right')
  // And the id, so an episode's stored window can be matched back to its layer.
  assert.equal(preset[0]!.id, 'a')
})

test('a new look property is carried without anyone remembering to list it', () => {
  // The strip is a delete on a copy, not an allow-list. An allow-list would
  // silently drop the next look property someone adds — the same quiet loss
  // this split exists to prevent, pointed the other way.
  const [only] = overlayLayersForPreset([layer('a', { rotation_deg: 12, time_range: { start_s: 1, end_s: 2 } })])
  assert.equal((only as any).rotation_deg, 12)
  assert.ok(!('time_range' in (only as any)))
})

test('the source layers are not mutated by taking a preset snapshot', () => {
  const layers = [layer('a', { time_range: { start_s: 12, end_s: 40 } })]
  overlayLayersForPreset(layers)
  assert.deepEqual(layers[0]!.time_range, { start_s: 12, end_s: 40 }, 'snapshotting must not strip the live window')
})

test('an episode change REPLACES windows rather than filling gaps', () => {
  // The defect, spelled out: EP0047 has a window, EP0048 does not, and the
  // layer must not keep EP0047's. `if (newValue) field = newValue` with no else
  // is this bug written optimistically.
  const layers = [layer('a', { time_range: { start_s: 12, end_s: 40 } }), layer('b')]
  const next = applyOverlayTimings(layers, { b: { start_s: 5, end_s: null } })
  assert.equal(next[0]!.time_range, null, "the previous episode's window survived")
  assert.deepEqual(next[1]!.time_range, { start_s: 5, end_s: null })
})

test('switching to an episode with no windows at all clears every one', () => {
  const layers = [layer('a', { time_range: { start_s: 12, end_s: 40 } })]
  for (const empty of [{}, null, undefined]) {
    const next = applyOverlayTimings(layers, empty as never)
    assert.equal(next[0]!.time_range, null)
  }
})

test('a malformed window is dropped rather than repaired', () => {
  // Guessing what someone meant is how a 0 that means "start" becomes a 0 that
  // means "unknown" — the defect class this codebase already paid for.
  assert.equal(isUsableRange({ start_s: 5, end_s: 3 }), false, 'end before start')
  assert.equal(isUsableRange({ start_s: -1, end_s: 10 }), false, 'negative start')
  assert.equal(isUsableRange({ start_s: 'x', end_s: 10 }), false, 'non-numeric')
  assert.equal(isUsableRange({ end_s: 10 }), false, 'no start')
  assert.equal(isUsableRange(null), false)
  // But an open-ended window is legitimate: null end means "to the end".
  assert.equal(isUsableRange({ start_s: 0, end_s: null }), true)
})

test('collecting windows keeps only the usable ones', () => {
  const collected = collectOverlayTimings([
    layer('a', { time_range: { start_s: 12, end_s: 40 } }),
    layer('b', { time_range: null }),
    layer('c', { time_range: { start_s: 9, end_s: 2 } }),
  ])
  assert.deepEqual(collected, { a: { start_s: 12, end_s: 40 } })
})

test('a legacy preset’s windows are rescued, never dropped', () => {
  // People have overlays timed right now and that timing lives nowhere else.
  // Ignoring it would be data loss dressed up as a fix.
  const presetLayers = [
    layer('a', { time_range: { start_s: 12, end_s: 40 } }),
    layer('b', { time_range: { start_s: 100, end_s: 130 } }),
  ]
  const { timings, migrated } = migrateLegacyOverlayTimings(presetLayers, {})
  assert.deepEqual(migrated, ['a', 'b'])
  assert.deepEqual(timings.a, { start_s: 12, end_s: 40 })
})

test('a rescue never overwrites a window the episode already has', () => {
  // The episode is the authority on its own runtime; the preset is not.
  const presetLayers = [layer('a', { time_range: { start_s: 12, end_s: 40 } })]
  const { timings, migrated } = migrateLegacyOverlayTimings(presetLayers, { a: { start_s: 300, end_s: 360 } })
  assert.deepEqual(timings.a, { start_s: 300, end_s: 360 }, "the episode's own window was overwritten")
  assert.deepEqual(migrated, [], 'nothing moved, so nothing may be announced')
})

test('a modern preset triggers no migration and no announcement', () => {
  // The happy path must stay silent. A notice that fires when nothing happened
  // is its own defect.
  const { migrated } = migrateLegacyOverlayTimings(overlayLayersForPreset([
    layer('a', { time_range: { start_s: 12, end_s: 40 } }),
  ]) as never, {})
  assert.deepEqual(migrated, [])
})

test('windows are stored per episode CODE and cannot cross', () => {
  let store = withEpisodeTimings({}, 'EP0047', { a: { start_s: 12, end_s: 40 } })
  store = withEpisodeTimings(store, 'EP0048', { a: { start_s: 300, end_s: 360 } })
  assert.deepEqual(timingsForEpisode(store, 'EP0047').a, { start_s: 12, end_s: 40 })
  assert.deepEqual(timingsForEpisode(store, 'EP0048').a, { start_s: 300, end_s: 360 })
  assert.deepEqual(timingsForEpisode(store, 'EP0049'), {})
  // Case-insensitive on the code, because the page and the folder disagree.
  assert.deepEqual(timingsForEpisode(store, 'ep0047').a, { start_s: 12, end_s: 40 })
})

test('an episode with no windows leaves no entry behind', () => {
  // Otherwise the store grows a key per episode ever opened, and "no timing"
  // becomes indistinguishable from "opened once".
  const store = withEpisodeTimings({ EP0047: { a: { start_s: 1, end_s: 2 } } }, 'EP0047', {})
  assert.deepEqual(store, {})
})

/**
 * The wiring, asserted against the source.
 *
 * The defect being prevented is the mere PRESENCE of a window in a preset
 * payload — a unit test over a helper cannot see `overlays.layers.map(l => ({
 * ...l }))` reappearing in a snapshot 600 lines away, and that expression is
 * exactly what carried one episode's timing onto another.
 */
const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url))

test('no preset payload on the page carries an overlay window', () => {
  const page = readFileSync(pagePath, 'utf8')
  // Both the reusable slot preset AND the bundle fallback — the bundle is a
  // preset too, and carrying a window there would reintroduce the defect by
  // the other door.
  const snapshots = page.match(/overlays: \{ enabled: overlays\.enabled, layers: [^}]+\}/g) || []
  assert.equal(snapshots.length, 2, 'expected exactly two overlay preset payloads')
  for (const snap of snapshots) {
    assert.ok(
      snap.includes('overlayLayersForPreset(overlays.layers)'),
      `an overlay preset payload does not strip the window: ${snap}`,
    )
  }
  assert.ok(
    !/overlays\.layers\.map\(l => \(\{ \.\.\.l \}\)\)/.test(page),
    'a raw overlay layer copy is back in a preset payload',
  )
})

test('an episode change re-seats the overlay windows', () => {
  const page = readFileSync(pagePath, 'utf8')
  assert.ok(page.includes('applyEpisodeOverlayTimings()'), 'episode change must re-seat overlay windows')
  assert.ok(
    /onEpisodeSelected[\s\S]{0,600}applyEpisodeOverlayTimings\(\)/.test(page),
    'applyEpisodeOverlayTimings must be called when the episode changes',
  )
})

test('randomising overlay effects cannot reach the timing', () => {
  const page = readFileSync(pagePath, 'utf8')
  // He asked to randomise the EFFECTS. There is no overlay randomiser today,
  // and when one is built it will shuffle preset payloads — which no longer
  // contain a window. This asserts the property that makes that safe, so the
  // guarantee cannot be lost before the feature arrives.
  const util = readFileSync(fileURLToPath(new URL('../utils/overlay-timing.ts', import.meta.url)), 'utf8')
  assert.ok(util.includes('delete copy.time_range'), 'the preset strip is the single guarantee')
  // And nothing on the page may write a window from a preset directly.
  assert.ok(
    !/time_range:\s*(?:l|layer)\.time_range/.test(page),
    'a preset layer is assigning its window straight onto live state',
  )
})
