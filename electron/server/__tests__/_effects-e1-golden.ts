/**
 * What every effect that existed before E1 (1.4.287) compiles to — captured from 1.4.285 (26592c3d)
 * into `fixtures/effects-e1-off-golden.json` and compared by `effects-e1-off-golden.test.ts`.
 * Only the ids in the fixture are compared, so new effects never disturb it.
 *
 * Regenerate (only on purpose): `npx tsx electron/server/__tests__/_effects-e1-golden.ts > electron/server/__tests__/fixtures/effects-e1-off-golden.json`
 */
import { createHash } from 'node:crypto'

import { BUILT_IN_FOOTAGE_MOTIONS, BUILT_IN_OVERLAYS, BUILT_IN_SCENE_MOTIONS } from '../contracts/scene-effect-presets.js'
import { normalizeSceneMotion, normalizeSceneOverlay } from '../contracts/scene-effects.js'
import { compileSceneMotion, compileSceneOverlay } from '../lib/scene-effect-compiler.js'
import { planStillMotion } from '../lib/scene-motion-plan.js'
import { buildSceneClipJob } from '../lib/native-scene-clip.js'
import { TRANSITIONS } from '../models/transitions.js'
import { buildVariableXfadeFilterComplex, buildXfadeFilterComplex, planTransitions } from '../lib/transition-filters.js'
import { describeEffectStack } from '../contracts/effects-look.js'
import { resolveEpisodeEffectStack, normalizeEpisodeEffects } from '../services/episode-effects.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export function captureGolden(only?: { motions?: string[]; overlays?: string[]; transitions?: string[] }) {
  const pick = <T extends { id: string }>(list: readonly T[], ids?: string[]) => ids ? list.filter(x => ids.includes(x.id)) : list
  const motions: Record<string, unknown> = {}
  for (const m of pick(BUILT_IN_SCENE_MOTIONS, only?.motions)) {
    const plan = planStillMotion(m.document, { w: 960, h: 540, fps: 24, duration: 6 })
    motions[m.id] = {
      document: JSON.stringify(m.document),
      renormalized: JSON.stringify(normalizeSceneMotion(JSON.parse(JSON.stringify(m.document)))),
      ffmpeg_1080: compileSceneMotion(m.document, { w: 1920, h: 1080, fps: 24, duration: 16 }),
      ffmpeg_540: compileSceneMotion(m.document, { w: 960, h: 540, fps: 24, duration: 6 }),
      native_job: plan.supported ? sha(JSON.stringify(buildSceneClipJob({ imagePath: '/s.png', outPath: '/o.mp4', document: m.document, w: 960, h: 540, fps: 24, duration: 6 }, plan))) : plan.reason,
    }
  }
  const footage: Record<string, unknown> = {}
  for (const m of BUILT_IN_FOOTAGE_MOTIONS) footage[m.id] = compileSceneMotion(m.document, { w: 1920, h: 1080, fps: 30, duration: 9 })
  const overlays: Record<string, unknown> = {}
  for (const o of pick(BUILT_IN_OVERLAYS, only?.overlays)) {
    let n = 0
    const opts = { input: '[in]', output: '[out]', allocLabel: () => `[x${n++}]`, w: 1920, h: 1080, duration: 3600, fps: 24, loopInput: () => '[9:v]' }
    const gated = { ...opts, gateExpression: 'between(t,12.00,3500.00)' }
    const faded = normalizeSceneOverlay({ ...o.document, timing: { start_sec: 30, end_sec: 90, fade_in_sec: 2, fade_out_sec: 2 } })
    overlays[o.id] = {
      document: JSON.stringify(o.document),
      renormalized: JSON.stringify(normalizeSceneOverlay(JSON.parse(JSON.stringify(o.document)))),
      plain: compileSceneOverlay(o.document, opts),
      gated: (n = 0, compileSceneOverlay(o.document, gated)),
      faded: (n = 0, compileSceneOverlay(faded, opts)),
    }
  }
  const transitions: Record<string, unknown> = {}
  for (const t of pick(TRANSITIONS, only?.transitions)) {
    const plan = planTransitions({ clipCount: 4, durationSec: 1.5, primaryId: t.id, pool: [], randomizeMode: 'off' })
    transitions[t.id] = {
      plan,
      uniform: buildXfadeFilterComplex({ inputCount: 4, clipDuration: 16, transitionDuration: 1.5, xfadeKeywords: plan.xfadeKeywords }),
      variable: buildVariableXfadeFilterComplex({ inputDurations: [16.5, 12.25, 17.5, 9], transitionDuration: 1.5, xfadeKeywords: plan.xfadeKeywords }),
    }
  }
  const pool = planTransitions({ clipCount: 9, durationSec: 1.5, primaryId: 'crossfade', pool: ['crossfade', 'fade-black', 'dissolve', 'wipe-left'], randomizeMode: 'per-scene', seed: 42 })
  const file = normalizeEpisodeEffects({
    episode: [{ uid: 'a', id: 'rain' }, { uid: 'b', id: 'vignette-soft' }],
    themes: [{ theme: 'night', effects: [{ uid: 'c', id: 'twinkling-stars' }] }],
    scenes: [{ scene_id: 's2', effects: [{ uid: 'd', id: 'bloom-glow', params: { strength: 0.2 } }, { uid: 'e', id: 'candle-flicker' }] }],
  })
  const stack = resolveEpisodeEffectStack({
    file, library: BUILT_IN_OVERLAYS, duration: 120,
    windows: [{ scene_id: 's1', start_sec: 0, end_sec: 40, theme: 'night' }, { scene_id: 's2', start_sec: 40, end_sec: 80 }, { scene_id: 's3', start_sec: 80, end_sec: 120, theme: 'night' }],
    projectLook: [{ id: 'ground-mist', enabled: true }, { id: 'film-grain-fine', enabled: true }],
  })
  const look = describeEffectStack({
    color_grading: { enabled: true, preset: 'warm-night' }, vignette: { enabled: true, strength: 0.5 },
    scene_effects: { enabled: true, overlays: [{ id: 'rain', enabled: true }, { id: 'bloom-glow', enabled: true }] },
  })
  return { captured_from: '1.4.285 (26592c3d)', motions, footage, overlays, transitions, pool, stack: JSON.stringify(stack), look }
}

if (process.argv[1] && /_effects-e1-golden\.ts$/.test(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(captureGolden(), null, 1)}\n`)
}
