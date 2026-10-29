/**
 * A Quote Shorts channel gives every NEW episode a length drawn inside its
 * Formula's seconds range (owner, 2026-10-29: "the channels should have
 * randomize duration, 10-60s videos").
 *
 * What this file pins:
 *   - the range is a STARTING value: the channel's own setting wins, a channel
 *     with no setting reads the Formula live, and a Formula with no seconds
 *     length resolves to nothing (long-form episodes are unchanged);
 *   - the draw is uniform over the inclusive whole-second range, with the RNG
 *     injected so both bounds can be proven;
 *   - the drawn value is stored ONCE on the episode (`episode_info.json`) and
 *     on the accepted idea the pages read; acceptance again is refused and no
 *     later read redraws it;
 *   - an episode that already has a length is never rewritten;
 *   - words follow `length × wpm ÷ chapters` through lib/script-sizing.ts, so a
 *     37-second Short asks for 74 words at 120 wpm rather than 120.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { formulaWordsPerChapter } from '../lib/script-sizing.js'
import {
  drawEpisodeLengthSeconds,
  formatLengthSuggestion,
  parseLengthSuggestionSeconds,
  resolveEpisodeLengthSetting,
  scriptLengthMinutes,
} from '../lib/episode-length.js'

const QUOTE_SHORTS_SCRIPT = {
  defaultLengthMinutes: 1,
  defaultLengthSeconds: 45,
  lengthSecondsRange: [10, 60] as [number, number],
  randomizeLength: true,
}

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any
let pm: typeof import('../services/project-manager.js')
let slug: string

before(async () => {
  tmp = await useTempDataDir()
  await fs.mkdir(path.join(tmp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  const created = (await request(app).post('/api/projects').send({
    name: 'Quote Shorts Drawn Length',
    niche_id: 'quote-shorts',
    formula_choice: 'selected',
    content_language: 'en',
    episode_prefix: 'QS',
    episode_digits: 3,
  }).expect(201)).body
  slug = created.slug
})

after(async () => { await tmp.cleanup() })

async function acceptWithLength(title: string, rng: () => number, project = slug) {
  const im = await import('../services/idea-manager.js')
  const [idea] = await im.addIdeas(project, [{
    title,
    logline: '',
    themes: [],
    suggested_chapters: 1,
    suggested_length: '1 min',
    mood: 'calm',
  }], 'test')
  return im.acceptIdea(project, idea!.id, false, { rng })
}

describe('the setting resolves: channel first, Formula second, nothing invented', () => {
  test('a Formula range with a fixed value becomes the random starting setting', () => {
    assert.deepEqual(resolveEpisodeLengthSetting(undefined, QUOTE_SHORTS_SCRIPT), {
      mode: 'random', min_sec: 10, max_sec: 60, fixed_sec: 45,
    })
  })

  test('the channel’s own saved setting wins over its Formula', () => {
    assert.deepEqual(
      resolveEpisodeLengthSetting({ mode: 'fixed', min_sec: 20, max_sec: 20, fixed_sec: 20 }, QUOTE_SHORTS_SCRIPT),
      { mode: 'fixed', min_sec: 20, max_sec: 20, fixed_sec: 20 },
    )
    assert.deepEqual(
      resolveEpisodeLengthSetting({ mode: 'random', min_sec: 30, max_sec: 30, fixed_sec: 30 }, QUOTE_SHORTS_SCRIPT),
      { mode: 'random', min_sec: 30, max_sec: 30, fixed_sec: 30 },
      'a channel can change the range without changing the Formula',
    )
  })

  test('a whole-minute Formula is unchanged, and a range alone is not a decision', () => {
    assert.equal(resolveEpisodeLengthSetting(undefined, {
      defaultLengthMinutes: 30, lengthMinutesRange: [20, 40] as [number, number],
    }), null)
    assert.equal(resolveEpisodeLengthSetting(undefined, {
      lengthSecondsRange: [10, 60] as [number, number],
    }), null, 'a range with no fixed value cannot say what "off" means — report nothing, invent nothing (§6)')
    assert.equal(resolveEpisodeLengthSetting(undefined, null), null)
  })

  test('an unusable stored setting falls back to the Formula instead of becoming a length', () => {
    assert.deepEqual(
      resolveEpisodeLengthSetting({ mode: 'random', min_sec: 90, max_sec: 10, fixed_sec: 45 }, QUOTE_SHORTS_SCRIPT),
      { mode: 'random', min_sec: 10, max_sec: 60, fixed_sec: 45 },
    )
  })
})

describe('the draw is uniform, inclusive, and injectable', () => {
  const setting = { mode: 'random' as const, min_sec: 10, max_sec: 60, fixed_sec: 45 }

  test('both bounds are reachable', () => {
    assert.equal(drawEpisodeLengthSeconds(setting, () => 0), 10)
    assert.equal(drawEpisodeLengthSeconds(setting, () => 0.9999999), 60)
    assert.equal(drawEpisodeLengthSeconds(setting, () => 1), 60, 'an RNG returning exactly 1 is clamped inside the range')
  })

  test('a fixed setting ignores the RNG', () => {
    assert.equal(drawEpisodeLengthSeconds({ mode: 'fixed', min_sec: 10, max_sec: 60, fixed_sec: 45 }, () => 0), 45)
  })

  test('a single-second range cannot draw outside itself', () => {
    assert.equal(drawEpisodeLengthSeconds({ mode: 'random', min_sec: 30, max_sec: 30, fixed_sec: 30 }, () => 0.7), 30)
  })
})

describe('a stored length reads and sizes through the existing path', () => {
  test('a seconds suggestion parses back to seconds, and minutes stay minutes', () => {
    assert.equal(parseLengthSuggestionSeconds('37 s'), 37)
    assert.equal(parseLengthSuggestionSeconds('45 min'), 2700)
    assert.equal(parseLengthSuggestionSeconds('1 min 5 s'), 65)
    assert.equal(parseLengthSuggestionSeconds('standard'), null)
    assert.equal(formatLengthSuggestion(37), '37 s')
  })

  test('words follow length × wpm ÷ chapters, seconds-precision first', () => {
    assert.equal(scriptLengthMinutes({ defaultLengthSeconds: 45 }), 0.75)
    assert.equal(scriptLengthMinutes({ defaultLengthMinutes: 30 }), 30)
    assert.equal(scriptLengthMinutes({}), null)
    const words = (seconds: number) => formulaWordsPerChapter({
      minutes: scriptLengthMinutes({ defaultLengthSeconds: seconds }),
      wordsPerMinute: 120,
      chapters: 1,
    })
    assert.equal(words(10), 20)
    assert.equal(words(37), 74)
    assert.equal(words(45), 90)
    assert.equal(words(60), 120)
  })
})

describe('accepting an idea draws, stores, and never redraws', () => {
  test('a new episode stores the drawn length on the episode and on its idea', async () => {
    const accepted = await acceptWithLength('The kettle before dawn', () => 0)
    assert.equal(accepted.idea.suggested_length, '10 s',
      'the drawn value replaces the model suggestion so every page reads one length')

    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const dirs = await resolveEpisodePathsByCode(slug, accepted.episode_code)
    const info = JSON.parse(await fs.readFile(path.join(dirs.episode_dir, 'episode_info.json'), 'utf-8'))
    assert.equal(info.target_length_seconds, 10)
    assert.equal(info.suggested_length, '10 s')

    // Reading it again later (a reload, the list endpoint) does not redraw.
    const im = await import('../services/idea-manager.js')
    const stored = (await im.getIdeas(slug, 'accepted')).find(i => i.episode_code === accepted.episode_code)
    assert.equal(stored?.suggested_length, '10 s')
    const reread = JSON.parse(await fs.readFile(path.join(dirs.episode_dir, 'episode_info.json'), 'utf-8'))
    assert.equal(reread.target_length_seconds, 10)

    // Accepting again is refused and leaves the stored length alone.
    await assert.rejects(() => im.acceptIdea(slug, accepted.idea.id, false, { rng: () => 0.999 }))
    const unchanged = JSON.parse(await fs.readFile(path.join(dirs.episode_dir, 'episode_info.json'), 'utf-8'))
    assert.equal(unchanged.target_length_seconds, 10)
  })

  test('the upper bound is stored too, and the earlier episode is not rewritten', async () => {
    const first = (await import('../services/idea-manager.js')).getIdeas
    const beforeRows = await first(slug, 'accepted')
    const firstRow = beforeRows.find(row => row.suggested_length === '10 s')
    assert.ok(firstRow, 'the first episode is still on disk')

    const accepted = await acceptWithLength('The coat on the hook', () => 0.9999999)
    assert.equal(accepted.idea.suggested_length, '60 s')

    const afterRows = await first(slug, 'accepted')
    const stillFirst = afterRows.find(row => row.episode_code === firstRow.episode_code)
    assert.equal(stillFirst?.suggested_length, '10 s', 'an episode that already has a length keeps it')
  })

  test('switching the draw off makes each new episode the fixed length', async () => {
    await pm.updateConfig(slug, {
      episode_length: { mode: 'fixed', min_sec: 20, max_sec: 20, fixed_sec: 20 },
    })
    const accepted = await acceptWithLength('The second cup of tea', () => 0.5)
    assert.equal(accepted.idea.suggested_length, '20 s')

    // Restore the channel's own random range for any later test in this file.
    await pm.updateConfig(slug, {
      episode_length: { mode: 'random', min_sec: 10, max_sec: 60, fixed_sec: 45 },
    })
  })

  test('a channel created before the setting existed reads its Formula live', async () => {
    const bare = await pm.createProject({
      name: 'Quote Shorts Legacy Channel',
      niche_id: 'quote-shorts',
      formula_choice: 'selected',
      episode_prefix: 'QL',
      episode_digits: 3,
    })
    assert.equal((await pm.getConfig(bare.slug) as any).episode_length, undefined,
      'nothing was seeded — the channel is not rewritten')

    const accepted = await acceptWithLength('The light left on', () => 0.25, bare.slug)
    // 0.25 of 51 seconds is 12 whole steps above 10 → 22 s.
    assert.equal(accepted.idea.suggested_length, '22 s')
  })

  test('a long-form channel keeps the suggestion it was accepted with', async () => {
    const longForm = await pm.createProject({
      name: 'Long Form Channel',
      niche_id: 'motivation',
      formula_choice: 'selected',
      episode_prefix: 'LF',
      episode_digits: 3,
    })
    const im = await import('../services/idea-manager.js')
    const [idea] = await im.addIdeas(longForm.slug, [{
      title: 'The long road back', logline: '', themes: [], suggested_chapters: 6, suggested_length: '25 min', mood: 'resolute',
    }], 'test')
    const accepted = await im.acceptIdea(longForm.slug, idea!.id, false, { rng: () => 0 })
    assert.equal(accepted.idea.suggested_length, '25 min', 'no range means no draw')

    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const dirs = await resolveEpisodePathsByCode(longForm.slug, accepted.episode_code)
    const info = JSON.parse(await fs.readFile(path.join(dirs.episode_dir, 'episode_info.json'), 'utf-8'))
    assert.equal(info.target_length_seconds, undefined)
  })
})
