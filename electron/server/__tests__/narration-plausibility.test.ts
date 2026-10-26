/**
 * Narration plausibility — the check that catches gibberish narration without hearing it.
 *
 * Owner, 2026-10-26: DM0018's Khmer narration was gibberish and nothing noticed. No speech
 * recognition is used (Khmer is script-timed by design), so the evidence is the script's own
 * length against the audio's own length, compared with the rate this voice actually reads at.
 *
 * These tests pin the four answers that must never collapse into one (AGENTS.md §6):
 *   a take inside the learned band  → pass
 *   a take far outside it           → flagged, with the numbers
 *   too few earlier takes           → insufficient_history (NOT pass)
 *   unreadable text or length       → unmeasurable (NOT pass)
 * and pin that a take never sets its own band (the DM0018 shape: every section bad).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { narrationTextStats } from '../services/audio-reconciler.js'
import { readCurrentChapterScript } from '../services/audio-quality.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let utils: typeof import('../services/utils.js')
let service: typeof import('../services/narration-plausibility.js')

/** Durations the injected probe answers with, keyed by absolute file path. */
const durations = new Map<string, number>()

const ENGLISH = (chars: number): string => 'word '.repeat(Math.ceil(chars / 5)).slice(0, chars)
const KHMER = (chars: number): string => 'ក'.repeat(chars)

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  utils = await import('../services/utils.js')
  service = await import('../services/narration-plausibility.js')
})
after(async () => { await cleanup() })

async function newProject(name: string, prefix: string): Promise<string> {
  return (await pm.createProject({ name, episode_prefix: prefix, episode_digits: 4 })).slug
}

async function addEpisode(slug: string, title: string) {
  const [idea] = await ideas.addIdeas(slug, [{
    title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test')
  const code = (await ideas.acceptIdea(slug, idea!.id, false)).episode_code
  const paths = await utils.resolveEpisodePathsByCode(slug, code)
  await Promise.all([paths.script_dir, paths.audio_dir, paths.episode_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  return { code, paths }
}

/** Write one take per section: the script text, an audio file, and the rate it reads at. */
async function writeTakes(episode: Awaited<ReturnType<typeof addEpisode>>,
  sections: Array<{ slug: string, text: string, cps: number }>, model = 'voice-x'): Promise<void> {
  const rows: Array<{ slug: string, source_file: string, source_files: string[] }> = []
  for (const section of sections) {
    await fs.writeFile(path.join(episode.paths.script_dir, `${episode.code}_${section.slug}.md`),
      `## ${section.slug}\n\n${section.text}\n`)
    const file = `${episode.code}_${section.slug}.mp3`
    const filePath = path.join(episode.paths.audio_dir, file)
    await fs.writeFile(filePath, 'audio')
    // Duration from the characters the app will actually count, so each fixture
    // take reads at exactly the rate it claims (the parser may keep a heading).
    const parsed = await readCurrentChapterScript(episode.paths.script_dir, episode.code, section.slug)
    durations.set(filePath, narrationTextStats(parsed || section.text).characterCount / section.cps)
    rows.push({ slug: section.slug, source_file: file, source_files: [file] })
  }
  await fs.writeFile(path.join(episode.paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: rows }))
  await fs.writeFile(path.join(episode.paths.episode_dir, 'audio_tts_model.json'), JSON.stringify({
    schema_version: 1, episode_code: episode.code, model_id: model,
    published_maximum_input_characters: 5000, request_budget: 4500, safety_margin: 0.1,
    recorded_at: new Date().toISOString(),
  }))
}

const probe = async (filePath: string): Promise<number | undefined> => durations.get(filePath)

function inspect(slug: string, episode: Awaited<ReturnType<typeof addEpisode>>) {
  return service.inspectNarrationPlausibility({
    projectSlug: slug,
    projectDir: pm.getProjectDir(slug)!,
    episodeCode: episode.code,
    episodeDir: episode.paths.episode_dir,
    audioDir: episode.paths.audio_dir,
    scriptDir: episode.paths.script_dir,
    probe,
  })
}

/** The history every scenario below starts from: accepted takes at the voice's own rate. */
async function history(slug: string, cps: number, take: (chars: number) => string): Promise<void> {
  for (let index = 0; index < 3; index++) {
    const episode = await addEpisode(slug, `History ${index + 1}`)
    await writeTakes(episode, [1, 2, 3, 4].map(number => ({
      slug: `Chapter_0${number}`, text: take(1200), cps,
    })))
  }
}

test('a take inside the voice\'s own rate passes; one at half that rate is flagged with the numbers', async () => {
  service._clearNarrationPlausibilityPool()
  const slug = await newProject('Rate band', 'RB')
  await history(slug, 10, ENGLISH)
  const episode = await addEpisode(slug, 'Current')
  await writeTakes(episode, [
    { slug: 'Chapter_01', text: ENGLISH(1200), cps: 10 },
    { slug: 'Chapter_02', text: ENGLISH(1200), cps: 9.5 },
    { slug: 'Chapter_03', text: ENGLISH(1200), cps: 10.5 },
    { slug: 'Chapter_04', text: ENGLISH(1200), cps: 5 },
  ])

  const evidence = await inspect(slug, episode)
  assert.equal(evidence.Chapter_01!.state, 'pass')
  assert.equal(evidence.Chapter_02!.state, 'pass')
  assert.equal(evidence.Chapter_03!.state, 'pass')

  const flagged = evidence.Chapter_04!
  assert.equal(flagged.state, 'flagged')
  assert.equal(flagged.band.state, 'measured')
  assert.equal(flagged.band.basis, 'voice_history')
  assert.equal(flagged.band.samples, 12)
  assert.equal(flagged.band.median_chars_per_second, 10)
  assert.equal(flagged.band.tolerance_percent, 25, 'a tight history still gets the ±25% floor')
  assert.equal(flagged.chars_per_second, 5)
  assert.match(flagged.detail, /2× slower/)
  assert.match(flagged.detail, /characters in /)
  assert.match(flagged.detail, /usual 7\.5–12\.5/)
  // The page's numbers agree with each other: characters per second is chars ÷ seconds.
  assert.ok(flagged.chars! > 0 && flagged.duration_sec! > 0)
  assert.equal(flagged.chars_per_second, Math.round((flagged.chars! / flagged.duration_sec!) * 100) / 100)
})

test('an episode whose every section is bad is still flagged — a take never sets its own band', async () => {
  service._clearNarrationPlausibilityPool()
  const slug = await newProject('All bad', 'AB')
  await history(slug, 10, ENGLISH)
  const episode = await addEpisode(slug, 'DM0018 shape')
  await writeTakes(episode, [1, 2, 3, 4, 5, 6].map(number => ({
    slug: `Chapter_0${number}`, text: ENGLISH(1200), cps: 5,
  })))

  const evidence = await inspect(slug, episode)
  assert.equal(Object.keys(evidence).length, 6)
  for (const row of Object.values(evidence)) {
    assert.equal(row.state, 'flagged')
    assert.equal(row.band.samples, 12, 'the band came from the earlier episodes, not from this one')
  }
})

test('with no earlier takes the answer is "not enough history", never "pass"', async () => {
  service._clearNarrationPlausibilityPool()
  const slug = await newProject('Fresh channel', 'FC')
  const episode = await addEpisode(slug, 'Only episode')
  await writeTakes(episode, [{ slug: 'Chapter_01', text: ENGLISH(1200), cps: 10 }])

  const [row] = Object.values(await inspect(slug, episode))
  assert.equal(row!.state, 'insufficient_history')
  assert.notEqual(row!.state, 'pass')
  assert.equal(row!.band.state, 'insufficient_history')
  assert.equal(row!.band.samples, 0)
  assert.match(row!.detail, /Not enough earlier accepted takes/)
})

test('Khmer and English takes are judged against their own language\'s history', async () => {
  service._clearNarrationPlausibilityPool()
  const slug = await newProject('Mixed languages', 'MX')
  // Khmer reads 6 characters/s here, English 10 — pooled, both would look normal.
  for (let index = 0; index < 3; index++) {
    const episode = await addEpisode(slug, `Khmer ${index + 1}`)
    await writeTakes(episode, [1, 2, 3, 4].map(number => ({
      slug: `Chapter_0${number}`, text: KHMER(1200), cps: 6,
    })))
  }
  for (let index = 0; index < 3; index++) {
    const episode = await addEpisode(slug, `English ${index + 1}`)
    await writeTakes(episode, [1, 2, 3, 4].map(number => ({
      slug: `Chapter_0${number}`, text: ENGLISH(1200), cps: 10,
    })))
  }
  const episode = await addEpisode(slug, 'Judged')
  await writeTakes(episode, [
    // Normal for English, far too fast for Khmer: only a language-split band flags it.
    { slug: 'Khmer_01', text: KHMER(1200), cps: 10 },
    { slug: 'Khmer_02', text: KHMER(1200), cps: 6 },
    { slug: 'English_01', text: ENGLISH(1200), cps: 10 },
    // Normal for Khmer, far too slow for English.
    { slug: 'English_02', text: ENGLISH(1200), cps: 6 },
  ])

  const evidence = await inspect(slug, episode)
  assert.equal(evidence.Khmer_01!.band.median_chars_per_second, 6)
  assert.equal(evidence.Khmer_01!.state, 'flagged')
  assert.equal(evidence.Khmer_02!.state, 'pass')
  assert.equal(evidence.English_01!.band.median_chars_per_second, 10)
  assert.equal(evidence.English_01!.state, 'pass')
  assert.equal(evidence.English_02!.state, 'flagged')
})

test('a voice with too few of its own takes falls back to the channel\'s and says which it used', async () => {
  service._clearNarrationPlausibilityPool()
  const slug = await newProject('Voice fallback', 'VF')
  await history(slug, 10, ENGLISH) // 3 episodes × 4 sections on the channel's voice ('voice-x')
  const episode = await addEpisode(slug, 'New voice')
  // Two sections on a NEW voice: fewer than the 6 samples a voice band needs.
  await writeTakes(episode, [
    { slug: 'Chapter_01', text: ENGLISH(1200), cps: 10 },
    { slug: 'Chapter_02', text: ENGLISH(1200), cps: 5 },
  ], 'voice-y')

  const evidence = await inspect(slug, episode)
  assert.equal(evidence.Chapter_01!.band.basis, 'channel_history')
  assert.equal(evidence.Chapter_01!.band.samples, 12)
  assert.equal(evidence.Chapter_01!.state, 'pass')
  assert.equal(evidence.Chapter_02!.state, 'flagged')
  assert.match(evidence.Chapter_02!.detail, /this channel's narration/)
})

test('the band is learned from the median and cannot be widened past ±50%', () => {
  const tight = service.rateBand([10, 10, 10, 10, 10, 10])
  assert.deepEqual(tight, {
    state: 'measured', samples: 6, median_chars_per_second: 10,
    tolerance_percent: 25, low_chars_per_second: 7.5, high_chars_per_second: 12.5,
  })
  const wild = service.rateBand([5, 5, 10, 10, 20, 20, 40])
  assert.equal(wild.state, 'measured')
  assert.equal(wild.tolerance_percent, 50, 'a noisy history widens the band only to ±50%')
  assert.equal(wild.samples, 7)
  assert.deepEqual(service.rateBand([10, 11, 12]), { state: 'insufficient_history', samples: 3 })
  assert.deepEqual(service.rateBand([]), { state: 'insufficient_history', samples: 0 })
})

test('unmeasurable is a state, not a pass: no text, too little text, unknown length', () => {
  const band = service.rateBand([10, 10, 10, 10, 10, 10])
  assert.equal(service.judgeNarrationRate({ chars: null, durationSec: 100, band }).state, 'unmeasurable')
  assert.match(service.judgeNarrationRate({ chars: null, durationSec: 100, band }).detail, /no script text/)
  assert.equal(service.judgeNarrationRate({ chars: 200, durationSec: 20, band }).state, 'unmeasurable')
  assert.match(service.judgeNarrationRate({ chars: 200, durationSec: 20, band }).detail, /too little text/)
  assert.equal(service.judgeNarrationRate({ chars: 1200, durationSec: null, band }).state, 'unmeasurable')
  assert.match(service.judgeNarrationRate({ chars: 1200, durationSec: null, band }).detail, /could not be measured/)
  // And the flagged sentence never claims the words were heard back.
  const flagged = service.judgeNarrationRate({ chars: 1200, durationSec: 240, band })
  assert.equal(flagged.state, 'flagged')
  assert.doesNotMatch(flagged.detail, /transcri|heard|speech/i)
})
