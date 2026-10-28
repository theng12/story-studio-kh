/**
 * A v1 file still reads and still renders (v1.4.365).
 *
 * The merge is an ADDITION to what is on disk, never a rewrite. Every episode
 * in the owner's library has a `contextual_cues.json` and a `sound_design.json`
 * written before this shipped, and the absolute promise is that opening any of
 * them shows the same labels and the same sounds in the same places, with no
 * migration step and no file touched.
 *
 * The trap this file exists for (AGENTS.md §5, trap 2): "never rewrite stored
 * presets or project data to compensate". A fix here that silently bumped a v1
 * file to v2 with a scene start would pass a shallow test and move every label
 * in every delivered episode to the top of its scene.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import {
  contextualCuePath,
  readContextualCueTimeline,
  resolveRenderableContextualCues,
  writeContextualCueTimeline,
} from '../services/contextual-cues.js'
import {
  readSoundDesignTimeline,
  resolveRenderableSoundCues,
  soundDesignPath,
  writeSoundDesignTimeline,
} from '../services/sound-design.js'
import { reanchorLabels, reanchorSounds } from '../services/sound-cue-anchors.js'
import type { ScenePlan } from '../models/types.js'

const plan = {
  generated_at: '2026-09-01T00:00:00.000Z', total_duration_sec: 40,
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 20, transcript_segment: '', visual_prompt: '' },
    { id: 'scene-2', scene_index: 2, start_sec: 20, end_sec: 40, transcript_segment: '', visual_prompt: '' },
  ],
} as unknown as ScenePlan

/**
 * The exact v1 shapes, written with keys in the order v1 wrote them and with
 * nothing v2 added. No `anchor_word`, no `scene_id` on the sound, no `source`,
 * no `credit`, no `density` removed from settings.
 */
const V1_LABELS = {
  schema_version: 1,
  generated_at: '2026-08-01T10:00:00.000Z',
  source_scene_plan_generated_at: plan.generated_at,
  cues: [{
    id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 4.15, end_sec: 7.65,
    title: 'Angkor Wat', subtitle: '1113 CE', kind: 'location_date', placement: 'bottom-left',
    template: 'map-pin', entrance: 'fade', exit: 'dissolve', status: 'approved',
    created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-01T10:00:00.000Z',
  }],
}

const V1_SOUNDS = {
  schema_version: 1,
  generated_at: '2026-08-01T10:00:00.000Z',
  source_scene_plan_generated_at: plan.generated_at,
  // v1 stored `density`. It is gone from the settings shape and must be IGNORED,
  // not carried forward as if it still did something.
  settings: { density: 'rich', max_spots_per_minute: 4, default_bed_gain_db: -22, default_spot_gain_db: -14, ducking_profile: 'standard' },
  cues: [{
    id: 'sound-1', kind: 'spot', label: 'temple bells', start_sec: 12.5,
    pool_id: 'sfx', clip: 'bells.wav', gain_db: -12, status: 'approved',
    created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-01T10:00:00.000Z',
  }],
}

describe('A v1 file reads exactly as it was written', () => {
  test('labels: schema, times and every field survive the read', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await fs.writeFile(contextualCuePath(planPath), JSON.stringify(V1_LABELS))
      const read = await readContextualCueTimeline(planPath)
      assert.equal(read?.schema_version, 1)
      assert.equal(read?.cues.length, 1)
      const cue = read!.cues[0]!
      assert.equal(cue.start_sec, 4.15, 'a stored v1 time is never re-derived on read')
      assert.equal(cue.anchor_word, undefined, 'no anchor is invented for a v1 cue')
      assert.equal(cue.placement, 'bottom-left')
    } finally { await isolated.cleanup() }
  })

  test('a v1 label renders where it always did, even after a Scene Plan re-run', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await fs.writeFile(contextualCuePath(planPath), JSON.stringify(V1_LABELS))
      const read = (await readContextualCueTimeline(planPath))!
      // A new plan: every scene moved, and `source_scene_plan_generated_at` no
      // longer matches. An unanchored cue keeps the seconds it was saved with.
      const moved = { ...plan, generated_at: '2026-10-01T00:00:00.000Z', scenes: [
        { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 25, transcript_segment: '', visual_prompt: '' },
        { id: 'scene-2', scene_index: 2, start_sec: 25, end_sec: 50, transcript_segment: '', visual_prompt: '' },
      ] } as unknown as ScenePlan
      const reanchored = reanchorLabels(read, moved, [])
      assert.equal(reanchored.timeline!.cues[0]!.start_sec, 4.15)
      assert.equal(reanchored.moves.length, 0)
      const renderable = resolveRenderableContextualCues({ enabled: true }, reanchored.timeline, moved)
      assert.equal(renderable.cues.length, 1)
      assert.equal(renderable.cues[0]!.start_sec, 4.15, 'the delivered episode still draws it at 4.15')
    } finally { await isolated.cleanup() }
  })

  test('sounds: a v1 cue reads as a pool cue with no scene and no credit', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await fs.writeFile(soundDesignPath(planPath), JSON.stringify(V1_SOUNDS))
      const read = (await readSoundDesignTimeline(planPath))!
      assert.equal(read?.schema_version, 1)
      const cue = read!.cues[0]!
      assert.equal(cue.start_sec, 12.5)
      assert.equal(cue.scene_id, undefined)
      assert.equal(cue.source, undefined, 'the reader does not stamp a default onto disk')
      assert.equal(cue.credit, undefined)
      // `density` is dropped rather than carried: nothing reads it.
      assert.equal((read!.settings as any).density, undefined)
      assert.equal(read!.settings.max_spots_per_minute, 4, 'the settings that DO something still read')
    } finally { await isolated.cleanup() }
  })

  test('a v1 sound mixes where it always did, with a note about the older plan', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await fs.writeFile(soundDesignPath(planPath), JSON.stringify(V1_SOUNDS))
      const read = (await readSoundDesignTimeline(planPath))!
      const reanchored = reanchorSounds(read, plan, [])
      assert.equal(reanchored.timeline!.cues[0]!.start_sec, 12.5)
      const renderable = resolveRenderableSoundCues({ enabled: true }, reanchored.timeline, plan)
      assert.deepEqual(renderable.cues.map(row => row.id), ['sound-1'])
    } finally { await isolated.cleanup() }
  })

  test('nothing rewrites a v1 file just because it was read', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      const labelFile = contextualCuePath(planPath)
      const soundFile = soundDesignPath(planPath)
      await fs.writeFile(labelFile, JSON.stringify(V1_LABELS))
      await fs.writeFile(soundFile, JSON.stringify(V1_SOUNDS))
      const beforeLabels = await fs.readFile(labelFile, 'utf8')
      const beforeSounds = await fs.readFile(soundFile, 'utf8')
      await readContextualCueTimeline(planPath)
      await readSoundDesignTimeline(planPath)
      assert.equal(await fs.readFile(labelFile, 'utf8'), beforeLabels)
      assert.equal(await fs.readFile(soundFile, 'utf8'), beforeSounds)
    } finally { await isolated.cleanup() }
  })
})

describe('A v2 save is the only thing that writes v2', () => {
  test('an explicit save stamps schema 2 and keeps the edits', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      const timeline = {
        ...V1_LABELS, schema_version: 2 as const,
        cues: [{ ...V1_LABELS.cues[0]!, anchor_word: 'carved faces' }],
      } as any
      await writeContextualCueTimeline(planPath, timeline)
      const read = (await readContextualCueTimeline(planPath))!
      assert.equal(read.schema_version, 2)
      assert.equal(read.cues[0]!.anchor_word, 'carved faces')
    } finally { await isolated.cleanup() }
  })

  test('an unreadable file is null, never a timeline with no cues', async () => {
    // AGENTS.md §6 — "there are no cues" and "the file is broken" must not be
    // the same answer, or a corrupt file renders silently label-free.
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await fs.writeFile(contextualCuePath(planPath), '{ not json')
      assert.equal(await readContextualCueTimeline(planPath), null)
    } finally { await isolated.cleanup() }
  })

  test('a v3 file is refused rather than guessed at', async () => {
    const isolated = await useTempDataDir()
    try {
      const planPath = path.join(isolated.dir, 'scene_prompts', 'scene_plan.json')
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      await fs.writeFile(contextualCuePath(planPath), JSON.stringify({ ...V1_LABELS, schema_version: 3 }))
      assert.equal(await readContextualCueTimeline(planPath), null, 'an unknown schema is not read as v1')
    } finally { await isolated.cleanup() }
  })
})
