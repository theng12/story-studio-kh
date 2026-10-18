/**
 * v1.4.73 — the Introduction becomes a first-class optional stage.
 *
 * ── The defect these tests exist for ──
 *
 * "Does this channel open with an Introduction?" had no home. The Script page
 * kept the answer in a page-local `reactive` that initialised to `false`, and a
 * watcher forced it back to `false` every time the niche context reloaded. So
 * the answer was re-invented on every page load and thrown away again, and an
 * opening happened only if a checkbox was ticked in that particular session.
 * Four episodes reached paid audio with no opening because of it.
 *
 * The tests below are about the fix's ONE claim: intent lives in exactly one
 * place, and everything that writes an episode reads it there.
 *
 * ── Why a positioned segment ──
 *
 * The opening is modelled as a segment sitting at a position relative to the
 * chapter body, not as "the Introduction". That is not decoration: it replaces
 * a real hardcode — the merge decided what played first by testing whether a
 * filename contained the letters "intro" — so ordering is exercised here too.
 * Only the Introduction is registered; nothing else should be added until it
 * is actually wanted.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

import {
  BEAT_LIBRARY,
  DEFAULT_INTRODUCTION_BEATS,
  INTRODUCTION_SEGMENT_ID,
  SEGMENT_KINDS,
  WORD_TARGET_MAX,
  WORD_TARGET_MIN,
  beatLinesForPrompt,
  defaultSegmentRecipe,
  normalizeChannelSegments,
  segmentPositionForFilename,
} from '../lib/episode-segments.js'
import { compareChapterFilenames } from '../generators/audio-merge.js'

let pm: typeof import('../services/project-manager.js')
let segments: typeof import('../services/channel-segments.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  segments = await import('../services/channel-segments.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

async function seedProject(slug: string, meta: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(pm.projectsRoot(), slug)
  await fs.mkdir(path.join(dir, 'episodes'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({ slug, name: slug, episode_prefix: 'EP', ...meta }),
  )
  // A real project always has one — `createProject` writes it — and
  // `updateConfig` refuses to write settings for a project that has not got
  // one. A fixture without it tests a state that cannot occur.
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({}))
  return dir
}

/** Put a real introduction artifact on disk for one episode. */
async function seedEpisodeWithOpening(dir: string, code: string): Promise<void> {
  const scriptDir = path.join(dir, 'episodes', `${code} - A Title`, `${code} - 03 Script`)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.docx`), 'chapters')
  await fs.writeFile(
    path.join(scriptDir, `${code}_Script_Narration.intro.json`),
    JSON.stringify({ generated_at: new Date().toISOString() }),
  )
}

async function seedEpisodeWithoutOpening(dir: string, code: string): Promise<void> {
  const scriptDir = path.join(dir, 'episodes', `${code} - A Title`, `${code} - 03 Script`)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.docx`), 'chapters')
}

// ── The recipe is data, and it is well-formed whatever is on disk ─────────

describe('a channel’s saved segments', () => {
  test('a channel that has never been asked is not treated as having said yes', () => {
    const result = normalizeChannelSegments({})
    assert.equal(result[INTRODUCTION_SEGMENT_ID].enabled, false,
      'silence is not consent to spend — evidence decides, not a blanket default')
  })

  test('a well-formed recipe comes back even from nothing at all', () => {
    for (const raw of [undefined, null, {}, [], 'nonsense', { introduction: 'not an object' }]) {
      const recipe = normalizeChannelSegments(raw)[INTRODUCTION_SEGMENT_ID].recipe
      assert.equal(typeof recipe.host_name, 'string')
      assert.ok(recipe.word_target >= WORD_TARGET_MIN && recipe.word_target <= WORD_TARGET_MAX)
      assert.ok(recipe.beats.length > 0, 'an opening with no beats has nothing to say')
    }
  })

  test('the default beats are the seven the Script page has always shown', () => {
    // The backend had drifted to six, having lost the membership beat, so an
    // opening written by an unattended batch covered different ground from one
    // written on the page. Both read this list now.
    const labels = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID).beats.map(b => b.label)
    assert.deepEqual(labels, DEFAULT_INTRODUCTION_BEATS.map(b => b.label))
    assert.ok(labels.some(l => /Patreon/i.test(l)), 'the membership beat must not go missing again')
  })

  test('a format that ships its own opening shape supplies the defaults', () => {
    // v1.4.73 — 50 is now the floor rather than below it. `introDefaults` has
    // documented "listicle ~50" since v1.0.71 and the old floor of 100 quietly
    // doubled it, so the app refused a shape it advertised. A beat the
    // catalogue has no name for is still taken verbatim as its label.
    const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, { wordTarget: 50, beats: ['Hello', 'Get on with it'] })
    assert.equal(recipe.word_target, 50, 'a short opening is a real want, not a mistake to correct')
    assert.deepEqual(recipe.beats.map(b => b.label), ['Hello', 'Get on with it'])
    const tooShort = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, { wordTarget: 4, beats: ['Hello'] })
    assert.equal(tooShort.word_target, WORD_TARGET_MIN, 'below the floor is still clamped, never taken literally')
  })

  test('a Formula may name a catalogue beat, and its explanation comes with it', () => {
    // The other half of the line above: a string the catalogue KNOWS resolves
    // to the catalogue's beat, so a Formula-supplied opening is as
    // self-describing on the page as a hand-built one.
    const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, {
      beats: ['hook', { id: 'not_advice_note', custom_text: 'one plain line, then move on' }],
    })
    assert.deepEqual(recipe.beats.map(b => b.id), ['hook', 'not_advice_note'])
    assert.equal(recipe.beats[0].label, BEAT_LIBRARY.hook.label)
    assert.equal(recipe.beats[1].custom_text, 'one plain line, then move on')
    assert.equal(recipe.beats[0].custom_text, undefined, 'a bare id carries no wording of its own')
  })

  test('an absurd word target is clamped rather than obeyed', () => {
    const tooBig = normalizeChannelSegments({ introduction: { recipe: { word_target: 999_999 } } })
    assert.equal(tooBig[INTRODUCTION_SEGMENT_ID].recipe.word_target, WORD_TARGET_MAX)
    const notANumber = normalizeChannelSegments({ introduction: { recipe: { word_target: 'lots' } } })
    assert.equal(notANumber[INTRODUCTION_SEGMENT_ID].recipe.word_target, 350)
  })

  test('a saved answer is echoed back unchanged', () => {
    const saved = {
      introduction: {
        enabled: true,
        recipe: {
          host_name: 'Luna',
          word_target: 420,
          custom_opening_line: 'Hello, and welcome back.',
          beats: [{ id: 'mine', label: 'Weekly riddle', enabled: true, custom_text: 'greet warmly' }],
        },
      },
    }
    const result = normalizeChannelSegments(saved)[INTRODUCTION_SEGMENT_ID]
    assert.equal(result.enabled, true)
    assert.equal(result.recipe.host_name, 'Luna')
    assert.equal(result.recipe.word_target, 420)
    assert.equal(result.recipe.custom_opening_line, 'Hello, and welcome back.')
    assert.deepEqual(result.recipe.beats, saved.introduction.recipe.beats)
  })

  test('a beat from the catalogue is renamed to the catalogue\u2019s spelling', () => {
    // A beat now carries an explanation, and the explanation is looked up by
    // id. Two names for `welcome` is how the page and the generator drifted
    // apart before; the label is not a place a stale spelling may live.
    // See introduction-recipe.test.ts for the rule itself.
    const result = normalizeChannelSegments({
      introduction: {
        enabled: true,
        recipe: { beats: [{ id: 'welcome', label: 'Welcome', enabled: true }] },
      },
    })[INTRODUCTION_SEGMENT_ID]
    assert.equal(result.recipe.beats[0].label, 'Welcome & host intro')
  })
})

describe('the beats handed to the language model', () => {
  test('a disabled beat is skipped entirely, not summarised', () => {
    const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID)
    recipe.beats = [
      { id: 'a', label: 'Welcome', enabled: true },
      { id: 'b', label: 'Sponsor', enabled: false },
    ]
    assert.deepEqual(beatLinesForPrompt(recipe), ['Welcome'])
  })

  test('a beat with its own wording carries it through', () => {
    const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID)
    recipe.beats = [{ id: 'a', label: 'Welcome', enabled: true, custom_text: 'greet warmly' }]
    assert.deepEqual(beatLinesForPrompt(recipe), ['Welcome — specifically cover: greet warmly'])
  })
})

// ── Placement is a position, not a name ──────────────────────────────────

describe('where a segment sits in the running order', () => {
  test('the Introduction is recognised by position, and it is before the chapters', () => {
    assert.equal(segmentPositionForFilename('TN0153_Introduction.mp3'), SEGMENT_KINDS.introduction.position)
    assert.ok(SEGMENT_KINDS.introduction.position < 1, 'chapter one is 1; an opening opens')
  })

  test('the short spelling the old rule accepted still works', () => {
    // The rule this replaced was "the filename contains the letters intro".
    // Narrowing that silently would reorder a real episode.
    assert.notEqual(segmentPositionForFilename('EP0001_Intro.mp3'), null)
  })

  test('a chapter is not mistaken for a segment', () => {
    assert.equal(segmentPositionForFilename('TN0153_Chapter_01.mp3'), null)
    assert.equal(segmentPositionForFilename('TN0153_misc.mp3'), null)
  })

  test('the merge still orders Introduction first, chapters in number order', () => {
    const sorted = [
      'TN0153_Chapter_04_part10.mp3',
      'TN0153_Chapter_02.mp3',
      'TN0153_Introduction.mp3',
      'TN0153_Chapter_04_part2.mp3',
      'TN0153_Chapter_01.mp3',
    ].sort(compareChapterFilenames)
    assert.deepEqual(sorted, [
      'TN0153_Introduction.mp3',
      'TN0153_Chapter_01.mp3',
      'TN0153_Chapter_02.mp3',
      'TN0153_Chapter_04_part2.mp3',
      'TN0153_Chapter_04_part10.mp3',
    ])
  })

  test('an unrecognised file never jumps to the front of the episode', () => {
    // The old rule sorted anything before the chapters if it happened to
    // contain "intro". Position is explicit, so an unknown file is unknown.
    const sorted = ['TN0001_random.mp3', 'TN0001_Chapter_01.mp3', 'TN0001_Introduction.mp3']
      .sort(compareChapterFilenames)
    assert.equal(sorted[0], 'TN0001_Introduction.mp3')
    assert.ok(sorted.indexOf('TN0001_random.mp3') > 0, 'only a registered segment can precede the chapters')
  })
})

// ── The original bug: intent must survive a reload ────────────────────────

describe('intent survives a context reload', () => {
  test('a saved yes is still a yes after the settings are read again', async () => {
    await seedProject('channel-with-opening')
    await segments.saveChannelSegment('channel-with-opening', INTRODUCTION_SEGMENT_ID, { enabled: true })

    // The defect: a watcher on the niche context set this back to false every
    // time the page reloaded that context. Reading repeatedly is the closest
    // backend equivalent, and the answer must not move.
    for (let reload = 0; reload < 3; reload += 1) {
      const current = await segments.getChannelSegments('channel-with-opening')
      assert.equal(current[INTRODUCTION_SEGMENT_ID].enabled, true,
        `reload ${reload + 1} lost the channel's answer — this is the bug`)
    }
    assert.equal(await segments.channelWantsIntroduction('channel-with-opening'), true)
  })

  test('a saved no stays no, and is never re-inferred from old episodes', async () => {
    // A channel that used openings and has deliberately stopped must not have
    // the setting quietly turned back on by the evidence scan.
    const dir = await seedProject('channel-that-stopped')
    await seedEpisodeWithOpening(dir, 'EP0001')
    await segments.saveChannelSegment('channel-that-stopped', INTRODUCTION_SEGMENT_ID, { enabled: false })
    assert.equal(await segments.channelWantsIntroduction('channel-that-stopped'), false)
  })

  test('a save that could not be written says so instead of reporting success', async () => {
    // `updateConfig` answers false for a project it cannot write. Ignoring
    // that would tell somebody their setting was saved and then quietly show
    // them the old value again — the shape of most defects found in this app.
    const dir = path.join(pm.projectsRoot(), 'no-config-file')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ slug: 'no-config-file', name: 'x' }))
    await assert.rejects(
      () => segments.saveChannelSegment('no-config-file', INTRODUCTION_SEGMENT_ID, { enabled: true }),
      /could not be written/i,
    )
  })

  test('saving clears the "this was only inferred" mark, whichever way it is left', async () => {
    const dir = await seedProject('channel-inferred')
    await seedEpisodeWithOpening(dir, 'EP0001')
    const inferred = await segments.getChannelSegments('channel-inferred')
    assert.ok(inferred[INTRODUCTION_SEGMENT_ID].inferred_at, 'it was inferred, so it says so')

    const saved = await segments.saveChannelSegment('channel-inferred', INTRODUCTION_SEGMENT_ID, { enabled: true })
    assert.equal(saved[INTRODUCTION_SEGMENT_ID].inferred_at, undefined,
      'a value the owner looked at and saved is a decision, not a guess')
  })
})

describe('deciding for a channel that predates the setting', () => {
  test('a channel that has produced openings keeps producing them', async () => {
    // The failure this prevents: every channel that was using openings goes
    // silently quiet the day this ships.
    const dir = await seedProject('has-openings')
    await seedEpisodeWithOpening(dir, 'EP0001')
    const result = await segments.getChannelSegments('has-openings')
    assert.equal(result[INTRODUCTION_SEGMENT_ID].enabled, true)
    assert.ok(result[INTRODUCTION_SEGMENT_ID].inferred_at,
      'it was worked out from evidence, and the page has to be able to say so')
  })

  test('a channel that never made one is not switched on behind the owner’s back', async () => {
    const dir = await seedProject('never-had-one')
    await seedEpisodeWithoutOpening(dir, 'EP0001')
    const result = await segments.getChannelSegments('never-had-one')
    assert.equal(result[INTRODUCTION_SEGMENT_ID].enabled, false)
    assert.equal(result[INTRODUCTION_SEGMENT_ID].inferred_at, undefined)
  })

  test('the decision is made once and then read like any other setting', async () => {
    const dir = await seedProject('decided-once')
    await seedEpisodeWithOpening(dir, 'EP0001')
    await segments.getChannelSegments('decided-once')

    // Remove the evidence. The saved answer must not change: it is a setting
    // now, not a scan that re-runs and can flip.
    await fs.rm(path.join(dir, 'episodes'), { recursive: true, force: true })
    const again = await segments.getChannelSegments('decided-once')
    assert.equal(again[INTRODUCTION_SEGMENT_ID].enabled, true)
  })

  test('the legacy separate introduction file counts as evidence too', async () => {
    const dir = await seedProject('legacy-shape')
    const scriptDir = path.join(dir, 'episodes', 'EP0001 - A Title', 'EP0001 - 03 Script')
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(path.join(scriptDir, 'EP0001_Script_Narration_Introduction.docx'), 'opening')
    assert.equal(await segments.hasEverProducedSegment('legacy-shape', INTRODUCTION_SEGMENT_ID), true)
  })
})

// ── Generation follows intent, not navigation ────────────────────────────

describe('an unattended batch follows the channel, not a checkbox', () => {
  let pipeline: typeof import('../routes/pipeline.js')
  before(async () => { pipeline = await import('../routes/pipeline.js') })

  test('a channel that opens with one gets the step without anyone asking', async () => {
    await seedProject('batch-wants-opening', { auto_introduction_enabled: true })
    await segments.saveChannelSegment('batch-wants-opening', INTRODUCTION_SEGMENT_ID, { enabled: true })
    const steps = await pipeline.applyChannelSegmentIntent('batch-wants-opening', ['script-only', 'audio'])
    assert.deepEqual(steps, ['script-only', 'introduction-only', 'audio'],
      'and it comes after the chapters it introduces, not at the end of the run')
  })

  test('the project activation switch defaults OFF even when the recipe is on', async () => {
    // The future-only master switch is deliberately OFF unless the owner turns
    // it on. A recipe that used to imply automation no longer does.
    await seedProject('batch-default-off')
    await segments.saveChannelSegment('batch-default-off', INTRODUCTION_SEGMENT_ID, { enabled: true })
    const steps = await pipeline.applyChannelSegmentIntent('batch-default-off', ['script-only', 'audio'])
    assert.deepEqual(steps, ['script-only', 'audio'])
  })

  test('a channel that does not use openings never grows an extra call', async () => {
    await seedProject('batch-no-opening', { auto_introduction_enabled: true })
    await segments.saveChannelSegment('batch-no-opening', INTRODUCTION_SEGMENT_ID, { enabled: false })
    const steps = await pipeline.applyChannelSegmentIntent('batch-no-opening', ['script-only', 'audio'])
    assert.deepEqual(steps, ['script-only', 'audio'])
  })

  test('a run that is not writing a script is left alone', async () => {
    // Re-rendering audio for finished episodes is not producing episodes, and
    // must not quietly spend on openings for them.
    await seedProject('audio-only-run')
    await segments.saveChannelSegment('audio-only-run', INTRODUCTION_SEGMENT_ID, { enabled: true })
    const steps = await pipeline.applyChannelSegmentIntent('audio-only-run', ['audio', 'audio_merge'])
    assert.deepEqual(steps, ['audio', 'audio_merge'])
  })

  test('the added step cannot fail the batch by demanding a preset', async () => {
    // The step is added automatically now, so if it still required a saved
    // `introduction` preset a channel that had never made one would not just
    // skip the opening — the WHOLE batch would be refused. Its recipe is a
    // channel setting, so it needs no preset and must not be able to ask.
    const { NO_PRESET_STEP_IDS } = await import('../routes/pipeline.js')
    assert.ok(NO_PRESET_STEP_IDS.includes('introduction-only'),
      'introduction-only must be exempt from the "no active preset" check')
  })

  test('asking for it explicitly does not queue it twice', async () => {
    await seedProject('explicit-request', { auto_introduction_enabled: true })
    await segments.saveChannelSegment('explicit-request', INTRODUCTION_SEGMENT_ID, { enabled: true })
    const steps = await pipeline.applyChannelSegmentIntent('explicit-request', ['script-only', 'introduction-only'])
    assert.deepEqual(steps, ['script-only', 'introduction-only'])
  })

  test('the master switch strips an opening the Pipeline selection sent', async () => {
    // The Pipeline page has no manual Introduction checkbox; it derives the
    // step from the channel. With the project switch OFF an opening already in
    // the payload must still be dropped, so default OFF cannot be bypassed.
    await seedProject('batch-payload-off')
    await segments.saveChannelSegment('batch-payload-off', INTRODUCTION_SEGMENT_ID, { enabled: true })
    const steps = await pipeline.applyChannelSegmentIntent('batch-payload-off', ['script-only', 'introduction-only'])
    assert.deepEqual(steps, ['script-only'])
  })
})
