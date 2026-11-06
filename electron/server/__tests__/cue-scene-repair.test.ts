/**
 * A label whose SAVED window sits outside its scene (2026-11-02, EP0006).
 *
 * The Curious Why EP0006: the Sound & Labels retry completed and still said
 * "Cue must remain inside its scene timing" for two APPROVED labels — "Erie
 * Canal opens" and "Lock tender" — which then sat in needs-attention with
 * nothing anyone could do about them. The renderer drew both correctly, the
 * Sound & Labels page showed both inside their scenes, and the Production
 * Board said the episode was not ready. One reader disagreed with all the
 * others, and the message it produced named no scene, no distance and no way
 * out.
 *
 * These tests carry the REAL shape of those two cues — their stored seconds,
 * their anchors, the scene windows and the caption lines that were on disk —
 * so a regression has to break the thing that actually broke, not a toy.
 *
 * Four promises, one per line:
 *  - the cause is a reader that trusts the seconds on disk instead of
 *    re-anchoring, and the two cues' seconds prove they were written under an
 *    earlier Scene Plan;
 *  - a re-plan that shifts scenes re-checks the cues and SAYS so, and saying
 *    never moves anything;
 *  - Repair snaps a label inside its scene with nothing lost;
 *  - leaving it off carries the reason in plain words and stops it blocking.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONTEXTUAL_CUE_CONFIG,
  readContextualCueTimeline,
  resolveRenderableContextualCues,
  validateContextualCueTimeline,
  writeContextualCueTimeline,
} from '../services/contextual-cues.js'
import {
  findSceneEscapes,
  flagCueOutsideScene,
  reanchorLabels,
  recheckCuesAfterReplan,
  snapCueIntoScene,
} from '../services/sound-cue-anchors.js'
import type { ContextualCue, ContextualCueTimeline, ScenePlan } from '../models/types.js'

/** The EP0006 scene windows these two cues are named against, to the millisecond. */
const plan = {
  generated_at: '2026-10-31T18:44:16.938Z',
  total_duration_sec: 917.97,
  scenes: [
    { id: 'ep0006-scene-0002', scene_index: 2, start_sec: 21.359, end_sec: 37.228, transcript_segment: 'If you enjoy careful history like this…' },
    { id: 'ep0006-scene-0004', scene_index: 4, start_sec: 48.551, end_sec: 61.111, transcript_segment: 'This is the Erie Canal at Lockport…' },
    { id: 'ep0006-scene-0007', scene_index: 7, start_sec: 87.491, end_sec: 98.951, transcript_segment: 'Some were toll reports and inspection notes.' },
    { id: 'ep0006-scene-0008', scene_index: 8, start_sec: 98.951, end_sec: 113.468, transcript_segment: 'This episode focuses on the eighteen twenties…' },
    { id: 'ep0006-scene-0016', scene_index: 16, start_sec: 212.853, end_sec: 226.087, transcript_segment: 'Canal records use several words…' },
  ],
} as unknown as ScenePlan

/**
 * The caption lines around the two cues, exactly as EP0006's stitched SRT has
 * them. Note where the anchored words ACTUALLY are: both are spoken in a
 * DIFFERENT scene from the one their cue names, which is the re-plan in one
 * picture.
 */
const subtitles = [
  { start_sec: 26.379, end_sec: 29.459, text: "Let's step into the story and see what the records can tell us." },
  { start_sec: 49.131, end_sec: 52.251, text: 'This is the Erie Canal at Lockport in western New York.' },
  { start_sec: 86.051, end_sec: 87.491, text: 'Some were letters from engineers.' },
  { start_sec: 87.891, end_sec: 90.111, text: 'Some were toll reports and inspection notes.' },
  { start_sec: 96.351, end_sec: 98.951, text: 'The Erie Canal opened in 1825.' },
  { start_sec: 99.491, end_sec: 105.871, text: 'This episode focuses on the 1820s and 1830s, when lockwork was done by hand.' },
  { start_sec: 213.393, end_sec: 216.913, text: 'Canal records use several words for the people who worked these gates.' },
  { start_sec: 217.173, end_sec: 218.813, text: 'The most common is lock tender.' },
]

function label(overrides: Partial<ContextualCue>): ContextualCue {
  return {
    id: '', scene_id: '', start_sec: 0, end_sec: 0, title: '', kind: 'historical_context',
    placement: 'top-right', template: 'documentary-label', entrance: 'fade', exit: 'dissolve',
    status: 'approved', created_at: '2026-11-01T18:51:56.667Z', updated_at: '2026-11-01T18:51:56.667Z',
    ...overrides,
  } as ContextualCue
}

/** "Erie Canal opens" as it sits on disk: scene 4, seconds that are not scene 4's. */
const erieCanalOpens = label({
  id: 'cue-ep0006-scene-0004',
  scene_id: 'ep0006-scene-0004',
  title: 'Erie Canal opens',
  subtitle: '1825',
  anchor_word: 'opened in eighteen twenty-five',
  anchor_offset_sec: 0.2,
  start_sec: 87.691,
  end_sec: 91.191,
})

/** "Lock tender" as it sits on disk: scene 8, seconds that are not scene 8's. */
const lockTender = label({
  id: 'cue-ep0006-scene-0008',
  scene_id: 'ep0006-scene-0008',
  title: 'Lock tender',
  anchor_word: 'most common is lock tender',
  anchor_offset_sec: 0.3,
  start_sec: 215.313,
  end_sec: 218.813,
})

/** The third label that moved with the re-plan but never left its scene. */
const lockport = label({
  id: 'cue-ep0006-scene-0002',
  scene_id: 'ep0006-scene-0002',
  title: 'Lockport, western New York',
  anchor_word: 'Lockport, in western New York',
  anchor_offset_sec: 0.2,
  start_sec: 29.659,
  end_sec: 33.159,
})

function timeline(cues: ContextualCue[], overrides: Partial<ContextualCueTimeline> = {}): ContextualCueTimeline {
  return {
    schema_version: 2,
    generated_at: '2026-11-01T18:51:56.667Z',
    source_scene_plan_generated_at: '2026-10-31T18:44:16.938Z',
    cues,
    ...overrides,
  }
}

const enabled = { ...DEFAULT_CONTEXTUAL_CUE_CONFIG, enabled: true }

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

describe('A label whose saved seconds sit outside its scene', () => {
  test('the two EP0006 cues: their seconds were written under an earlier Scene Plan', () => {
    // Every proposal stamps `scene.start_sec + anchor_offset_sec`, so a saved
    // start MINUS the cue's own offset recovers the scene start it was written
    // against. Both recovered starts are real caption boundaries in this
    // episode — and neither is the scene the cue names in TODAY's plan.
    assert.equal(Number((erieCanalOpens.start_sec - erieCanalOpens.anchor_offset_sec!).toFixed(3)), 87.491)
    assert.equal(Number((lockTender.start_sec - lockTender.anchor_offset_sec!).toFixed(3)), 215.013)

    const scene4 = plan.scenes.find(scene => scene.id === 'ep0006-scene-0004')!
    const scene8 = plan.scenes.find(scene => scene.id === 'ep0006-scene-0008')!
    assert.notEqual(87.491, scene4.start_sec, 'the plan re-cut scene 4')
    assert.notEqual(215.013, scene8.start_sec, 'the plan re-cut scene 8')
    // 87.491 is scene 7's start in today's plan — the same audio, re-cut.
    assert.equal(87.491, plan.scenes.find(scene => scene.id === 'ep0006-scene-0007')!.start_sec)

    // The anchored WORD for each cue is now spoken in a different scene, which
    // is why re-anchoring falls back to the stored offset and lands them at
    // the TOP of the scene they name — the same numbers the page showed.
    const placed = reanchorLabels(timeline([erieCanalOpens, lockTender, lockport]), plan, subtitles).timeline!
    const erie = placed.cues.find(cue => cue.id === erieCanalOpens.id)!
    const tender = placed.cues.find(cue => cue.id === lockTender.id)!
    assert.equal(erie.start_sec, 48.751, 'scene 4 start + 0.2')
    assert.equal(tender.start_sec, 99.251, 'scene 8 start + 0.3')
  })

  test('findSceneEscapes names the scene and the distance, and leaves the one that only moved alone', () => {
    const escapes = findSceneEscapes(timeline([erieCanalOpens, lockTender, lockport]), plan, subtitles)
    assert.deepEqual(escapes.map(item => item.cue_id).sort(), [erieCanalOpens.id, lockTender.id].sort())

    // Both sit PAST the end of the scene they name — the re-plan shortened
    // the scene, not the label.
    const erie = escapes.find(item => item.cue_id === erieCanalOpens.id)!
    assert.equal(erie.side, 'after')
    assert.equal(erie.scene_index, 4)
    assert.equal(erie.outside_by_sec, 30.08, '30.1s past the end of scene 4')
    assert.match(erie.detail, /"Erie Canal opens"/)
    assert.match(erie.detail, /Scene 4/)
    assert.match(erie.detail, /30\.1s past the end/)
    assert.equal(erie.rescues, true, 'its own offset still places it inside scene 4')

    const tender = escapes.find(item => item.cue_id === lockTender.id)!
    assert.equal(tender.side, 'after')
    assert.equal(tender.scene_index, 8)
    assert.equal(tender.outside_by_sec, 105.345)
    assert.match(tender.detail, /"Lock tender"/)
    assert.match(tender.detail, /Scene 8/)
    assert.match(tender.detail, /Repair moves it there and nothing is lost/)
  })

  test('the board and the page disagree only because one of them skips re-anchoring', () => {
    const stored = timeline([erieCanalOpens, lockTender])
    const anchored = reanchorLabels(stored, plan, subtitles).timeline!

    // What the renderer, the page and (after this fix) the board all see.
    const drawn = resolveRenderableContextualCues(enabled, anchored, plan)
    assert.equal(drawn.cues.length, 2, 'both approved labels draw')

    // What the board USED to see: the seconds on disk. This is the defect.
    assert.throws(
      () => resolveRenderableContextualCues(enabled, stored, plan),
      /Erie Canal opens.*Lock tender|Lock tender.*Erie Canal opens/s,
      'reading the stored seconds refuses a render the re-anchored read accepts',
    )
  })

  test('the validator says which scene and how far out instead of only refusing', () => {
    const issues = validateContextualCueTimeline(timeline([erieCanalOpens]), plan)
    const escape = issues.find(issue => issue.cue_id === erieCanalOpens.id)!
    assert.equal(escape.severity, undefined, 'a label that will be DRAWN outside its scene is still an error')
    assert.match(escape.detail, /^Cue must remain inside its scene timing\./)
    assert.match(escape.detail, /Scene 4/)
    assert.match(escape.detail, /30\.1s past the end/)
  })
})

describe('Repair: snap into the scene', () => {
  test('moves it inside, keeps the words, and keeps it there', () => {
    const snapped = snapCueIntoScene(lockTender, plan, subtitles)!
    assert.ok(snapped)
    const scene8 = plan.scenes.find(scene => scene.id === 'ep0006-scene-0008')!
    assert.ok(snapped.start_sec >= scene8.start_sec)
    assert.ok(snapped.end_sec <= scene8.end_sec)
    // Nothing lost: the words, the text and the review state all survive.
    assert.equal(snapped.title, lockTender.title)
    assert.equal(snapped.subtitle, lockTender.subtitle)
    assert.equal(snapped.anchor_word, lockTender.anchor_word)
    assert.equal(snapped.status, 'approved', 'an approved label stays approved — Repair is not a re-review')
    assert.equal(snapped.end_sec - snapped.start_sec, lockTender.end_sec - lockTender.start_sec, 'the reviewed length is kept')
    // And it stays inside on the NEXT read: the snapped offset is written down.
    assert.equal(snapped.anchor_offset_sec, 0.3, 'the offset it was placed with, now measured against scene 8')
    const reread = reanchorLabels(timeline([snapped], { source_scene_plan_generated_at: plan.generated_at }), plan, subtitles).timeline!
    assert.equal(findSceneEscapes(reread, plan, subtitles).length, 0)
    assert.deepEqual(reread.cues[0]!.start_sec, snapped.start_sec, 'the next read does not move it again')
  })

  test('a label with no anchor at all is clamped in, and its reason is cleared', () => {
    const stranded = label({
      id: 'cue-stranded', scene_id: 'ep0006-scene-0007', title: 'Stranded',
      start_sec: 400, end_sec: 403.5, status: 'disabled', disabled_reason: 'left off by an earlier repair',
    })
    assert.equal(findSceneEscapes(timeline([stranded]), plan, subtitles)[0]!.rescues, false)
    const snapped = snapCueIntoScene(stranded, plan, subtitles)!
    const scene7 = plan.scenes.find(scene => scene.id === 'ep0006-scene-0007')!
    assert.ok(snapped.start_sec >= scene7.start_sec && snapped.end_sec <= scene7.end_sec)
    assert.equal(snapped.disabled_reason, undefined, 'the reason belonged to the problem that is now gone')
    assert.equal(typeof snapped.anchor_offset_sec, 'number', 'so the next plan re-derives the snapped place')
  })

  test('a label whose scene no longer exists is refused, not guessed at', () => {
    const orphan = label({ id: 'cue-orphan', scene_id: 'ep0006-scene-0099', title: 'Gone', start_sec: 10, end_sec: 14 })
    assert.equal(snapCueIntoScene(orphan, plan, subtitles), null)
  })
})

describe('Flag: leave it off, with the reason', () => {
  test('turns it off carrying the plain reason, and stops it blocking', () => {
    const escape = findSceneEscapes(timeline([erieCanalOpens]), plan, subtitles)[0]!
    const flagged = flagCueOutsideScene(erieCanalOpens, escape)
    assert.equal(flagged.status, 'disabled')
    assert.equal(flagged.disabled_reason, escape.detail)
    // Turning something off must never move it.
    assert.equal(flagged.start_sec, erieCanalOpens.start_sec)
    assert.equal(flagged.end_sec, erieCanalOpens.end_sec)

    const flaggedTimeline = timeline([flagged])
    // Still SAID — the reason is not lost just because it no longer blocks.
    const issues = validateContextualCueTimeline(flaggedTimeline, plan)
    const note = issues.find(issue => issue.cue_id === flagged.id)!
    assert.equal(note.severity, 'warning', 'a label that is not drawn cannot be wrong in the output')
    assert.match(note.detail, /Scene 4/)

    // And it no longer refuses anything.
    const drawn = resolveRenderableContextualCues(enabled, flaggedTimeline, plan)
    assert.deepEqual(drawn.cues, [])
    assert.equal(drawn.skipped.length, 1)
    assert.match(drawn.skipped[0]!.detail, /turned off/)
    assert.match(drawn.skipped[0]!.detail, /Scene 4/, 'the reason travels with the row')
  })
})

describe('A re-plan that shifts scenes re-checks the cues and says so', () => {
  async function withEpisode(cues: ContextualCue[], stamp: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-scene-repair-'))
    const planPath = path.join(dir, 'scene_plan.json')
    const cuePath = path.join(dir, 'contextual_cues.json')
    const srtPath = path.join(dir, 'stitched.srt')
    await fs.writeFile(planPath, JSON.stringify(plan))
    await fs.writeFile(cuePath, JSON.stringify(timeline(cues, { source_scene_plan_generated_at: stamp })))
    await fs.writeFile(srtPath, subtitles.map((cue, index) =>
      `${index + 1}\n${srtTime(cue.start_sec)} --> ${srtTime(cue.end_sec)}\n${cue.text}\n`
    ).join('\n'))
    return { dir, planPath, cuePath, srtPath }
  }

  test('says what moved when the plan is newer than the cues, and moves nothing', async () => {
    const { dir, cuePath, srtPath } = await withEpisode(
      [erieCanalOpens, lockTender, lockport],
      '2026-10-20T00:00:00.000Z',
    )
    try {
      const before = await fs.readFile(cuePath, 'utf8')
      const lines = await recheckCuesAfterReplan(cuePath, plan, srtPath)
      assert.ok(lines.some(line => /3 label\(s\) follow their scene/.test(line)), lines.join('\n'))
      assert.ok(lines.some(line => /"Erie Canal opens"/.test(line) && /1:27 → 0:48/.test(line)))
      assert.ok(lines.some(line => /"Lock tender"/.test(line) && /3:35 → 1:39/.test(line)))
      // The escapes are named too, with their repair.
      assert.ok(lines.some(line => /"Erie Canal opens".*Scene 4/s.test(line)))
      // AND NOTHING WAS MOVED. An approved label is only ever moved by a
      // person pressing something (AGENTS.md §4).
      assert.equal(await fs.readFile(cuePath, 'utf8'), before, 'saying it must never write it')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  test('says nothing when the cues already belong to this plan', async () => {
    const { dir, cuePath, srtPath } = await withEpisode([erieCanalOpens], plan.generated_at)
    try {
      const lines = await recheckCuesAfterReplan(cuePath, plan, srtPath)
      assert.deepEqual(lines, [], 'a prompt-only Scene Plan run must not repeat an old note')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  test('a repaired label reads back exactly as it was written', async () => {
    const { dir, planPath, srtPath } = await withEpisode([lockTender], '2026-10-20T00:00:00.000Z')
    try {
      const stored = await readContextualCueTimeline(planPath)
      const snapped = snapCueIntoScene(stored!.cues[0]!, plan, subtitles)!
      await writeContextualCueTimeline(planPath, timeline([snapped], {
        generated_at: stored!.generated_at,
        source_scene_plan_generated_at: stored!.source_scene_plan_generated_at,
      }))
      const reread = (await readContextualCueTimeline(planPath))!
      assert.deepEqual(reread.cues[0]!.start_sec, snapped.start_sec)
      assert.equal(reread.cues[0]!.status, 'approved')
      assert.equal(reread.cues[0]!.title, 'Lock tender')
      assert.equal(findSceneEscapes(reread, plan, subtitles).length, 0)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  test('a current label timeline does not silence sound drift', async () => {
    // The label file already belongs to this plan; the sound file does not.
    // The label stamp must not return early for the sounds beside it.
    const { dir, planPath, srtPath } = await withEpisode([erieCanalOpens], plan.generated_at)
    try {
      await fs.writeFile(path.join(dir, 'sound_design.json'), JSON.stringify({
        schema_version: 2,
        generated_at: '2026-10-20T00:00:00.000Z',
        source_scene_plan_generated_at: '2026-10-20T00:00:00.000Z',
        settings: {},
        cues: [{
          id: 'sound-lockport', kind: 'spot', label: 'lock gates', scene_id: 'ep0006-scene-0004',
          anchor_word: 'Erie Canal', start_sec: 1, end_sec: 3, clip: 'gate.wav', gain_db: -12,
          status: 'approved', created_at: 'now', updated_at: 'now',
        }],
      }))
      const lines = await recheckCuesAfterReplan(planPath, plan, srtPath)
      assert.ok(lines.some(line => /1 sound cue\(s\) follow their scene/.test(line)), lines.join('\n'))
      assert.ok(!lines.some(line => /label\(s\) follow their scene/.test(line)), 'a current label file stays quiet')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
