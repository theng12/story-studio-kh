/**
 * Songs with lyrics (owner 2026-10-12): the channel switch, the sung briefs, the word-match score, the
 * listen-back with retakes (a failed take to Trash, the last one kept switched off), the free-only
 * listen-back, and the LYRICS block in a music episode's description.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { STARTING_SONG_FORMULA, STARTING_LYRICS, SongFormulaSchema } from '../contracts/song-formula.js'
import { lyricsMatch, lyricWords } from '../services/lyrics-match.js'
import { checkBrief, parseWriterAnswer, sectionsFor, writeBriefs } from '../services/song-brief.js'
import { renderLyrics } from '../services/youtube-metadata-finalizer.js'

const LYRICS = '[Verse]\nSteam curls up from the cup\nRain draws lines on the glass\n[Chorus]\nStay a while, stay a while\nLet the slow hours pass'

describe('pure parts', () => {
  test('the switch is optional, off by default, and validated', () => {
    assert.equal(SongFormulaSchema.safeParse(STARTING_SONG_FORMULA).success, true, 'a formula without it is instrumental, as before')
    assert.equal(STARTING_LYRICS.enabled, false)
    assert.equal(SongFormulaSchema.safeParse({ ...STARTING_SONG_FORMULA, lyrics: { ...STARTING_LYRICS, enabled: true } }).success, true)
    assert.equal(SongFormulaSchema.safeParse({ ...STARTING_SONG_FORMULA, lyrics: { ...STARTING_LYRICS, min_match: 2 } }).success, false)
  })

  test('word match: in order, markers and punctuation ignored, nothing measurable is null not 0', () => {
    assert.deepEqual(lyricWords('[Verse]\nStay a while, stay!'), ['stay', 'a', 'while', 'stay'])
    assert.equal(lyricsMatch(LYRICS, LYRICS.replace(/\[[^\]]+\]/g, '')), 1)
    assert.equal(lyricsMatch(LYRICS, 'steam curls up from the cup rain draws lines on the glass'), 0.522, '12 of 23 words')
    assert.ok(lyricsMatch(LYRICS, 'glass the on lines draws rain')! < 0.1, 'words out of order barely count')
    assert.equal(lyricsMatch(LYRICS, ''), 0)
    assert.equal(lyricsMatch('[Verse]\n[Chorus]', 'anything'), null)
  })

  test('sung briefs: style + lyrics parsed and required, never-words checked in the lyrics too', () => {
    const [a] = parseWriterAnswer(JSON.stringify({ songs: [{ n: 1, title: 'Window Steam', line: 'l', scene_idea: 's', style: 'jazz, warm female vocal', lyrics: LYRICS }] }), 1)
    assert.equal(a!.style, 'jazz, warm female vocal')
    assert.equal(a!.lyrics, LYRICS)
    const pool = { titles: [], lineGrams: [], sceneGrams: [] }
    const ctx = { never: ['drums'], maxTitleWordShare: 1, maxSimilarity: 1, sung: true }
    assert.equal(checkBrief(a!, pool, ctx), '')
    assert.match(checkBrief({ ...a!, lyrics: 'one verse only' }, pool, ctx), /two \[Verse\]/)
    assert.match(checkBrief({ ...a!, style: '' }, pool, ctx), /style line/)
    assert.match(checkBrief({ ...a!, lyrics: `${LYRICS}\nand the drums roll` }, pool, ctx), /never allows/)
    assert.equal(sectionsFor(60), 2); assert.equal(sectionsFor(210), 7); assert.equal(sectionsFor(900), 12)
  })

  test('sung briefs ask for sections, 4 per call, and the prompt is the style line plus code facts', async () => {
    const cells = Array.from({ length: 5 }, (_, i) => ({ ensemble: 'Piano trio', mood: 'Cosy', tempo_band: 'slow', tempo_bpm: 70 + i, key: 'C major', structure: 'ABA', texture: 'Warm room', theme: '', length_s: 180, energy: 2, combo_key: `c${i}`, seed: i + 1 }))
    const users: string[] = []
    const written = await writeBriefs(cells, { titles: [], lines: [], sceneIdeas: [], never: [], maxTitleWordShare: 1, maxSimilarity: 1, lyrics: { language: 'English' } }, async (system, user) => {
      users.push(user)
      assert.match(system, /ORIGINAL: never name or imitate a real artist/)
      const n = (user.match(/^\d+\. /gm) || []).length
      return JSON.stringify({ songs: Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `Song ${users.length}${'abcd'[i]}`, line: `line ${users.length} ${i}`, scene_idea: `scene ${users.length} ${i}`, style: 'cafe jazz, soft male vocal', lyrics: LYRICS })) })
    })
    assert.equal(users.length, 2, '5 songs at 4 per call')
    assert.match(users[0]!, /Lyrics language: English/)
    assert.match(users[0]!, /6 lyric sections/)
    assert.equal(written.briefs.length, 5)
    assert.equal(written.briefs[0]!.prompt, 'cafe jazz, soft male vocal, 70 BPM, C major')
  })

  test('the LYRICS block: title then words per song; empty when none', () => {
    assert.equal(renderLyrics([]), '')
    assert.equal(renderLyrics([{ title: 'A', lyrics: '[Verse]\nla' }, { title: 'B', lyrics: 'lo' }]), 'LYRICS\n\nA\n[Verse]\nla\n\nB\nlo')
  })
})

let cleanup: () => Promise<void>
let app: any
let slug: string
let service: MockGenStudioService

function fakeJob(params: Record<string, unknown>): any {
  return {
    job_id: `test-lyrics-${Math.random().toString(36).slice(2)}`, project_slug: slug, type: 'music_generate',
    episode_id: '', title: 'songs', status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    finished_at: null, error: null, output_lines: [] as string[], params: { song_pool: true, ...params },
  }
}
let k = 0
const TITLES = ['Window Steam', 'Amber Platform', 'Copper Kettle', 'Velvet Awning', 'Linen Morning']
const sungAnswer = () => JSON.stringify({ songs: [{ n: 1, title: TITLES[k++ % TITLES.length], line: `brushed piano line ${k * 7919}`, scene_idea: `a rainy cafe window ${k * 104729}`, style: 'cafe jazz, piano trio, cosy, warm female vocal', lyrics: LYRICS }] })
const poolSongs = async (batch: string) => (await (await import('../services/song-pool.js')).readPool(slug)).songs.filter(s => s.batch_id === batch)

describe('making sung songs', () => {
  before(async () => {
    const t = await useTempDataDir()
    cleanup = t.cleanup
    await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    app = (await import('../app.js')).app
    const proj = await request(app).post('/api/projects').send({ name: 'Cafe Songs', episode_prefix: 'CS', episode_digits: 4 })
    slug = proj.body.slug
    service = await startMockGenStudioService()
    assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
    assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
    assert.equal((await request(app).put(`/api/projects/${slug}/niche`).send({ niche_id: 'music-mix' })).status, 200)
    const r = await request(app).patch(`/api/niches/music-mix/music-format?project_slug=${slug}`).send({ songFormula: {
      ...STARTING_SONG_FORMULA, never: ['drums'], length_s: { min: 60, max: 61 },
      variety: { ...STARTING_SONG_FORMULA.variety, max_similarity: 1, max_title_word_share: 1 },
      lyrics: { ...STARTING_LYRICS, enabled: true, min_match: 0.6, max_takes: 2 },
    } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })
  after(async () => { await service.close(); await cleanup() })
  beforeEach(() => { service.reset(); service.transcriptionQuoteCredits = 0 })

  test('sung songs are normal work: one per singing Mac, or the Gateway cap when one is set', async () => {
    const { musicWindowSizer } = await import('../lib/music-window.js')
    service.setFleetCapacity([{ id: 'mock-music-v1', model_id: 'mock-music-v1', eligible_macs: 22, idle_macs: 2, fleet_cap: 2, running: { normal: 0, background: 0 }, queued: { normal: 0, background: 0 } }])
    const lines: string[] = []
    const sizer = await musicWindowSizer(MOCK_GENSTUDIO_FULL_KEY, 'mock-music-v1', l => lines.push(l))
    assert.equal(sizer.priority, undefined)
    assert.equal(await sizer.size(5), 2)
    assert.match(lines.join('\n'), /at most 2 of this model at once/)
    service.setFleetCapacity([{ id: 'mock-music-v1', model_id: 'mock-music-v1', eligible_macs: 19, idle_macs: 0, running: { normal: 0, background: 0 }, queued: { normal: 0, background: 0 } }])
    const sung = await musicWindowSizer(MOCK_GENSTUDIO_FULL_KEY, 'mock-music-v1', () => {}, undefined, { normal: true })
    assert.equal(sung.priority, undefined, 'a sung song is normal work, not background')
    assert.equal(await sung.size(0), 19, 'one per Mac that can sing')
    const plain = await musicWindowSizer(MOCK_GENSTUDIO_FULL_KEY, 'mock-music-v1', () => {})
    assert.equal(plain.priority, 'background', 'instrumental top-ups are unchanged')
  })

  test('a sung channel needs the listen-back model', async () => {
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    await assert.rejects(generateSongPool(fakeJob({ mode: 'new', count: 1, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', batch_id: 'b_nocheck' })), /listen-back model/)
  })

  test('a mumbled take goes to Trash and the song is sung again; the passing take is switched on with its lyrics', async () => {
    service.queueScenario('chat', { outputText: sungAnswer() })
    service.queueScenario('transcription', { outputText: 'mm hmm the cup' })
    service.queueScenario('transcription', { outputText: 'steam curls up from the cup rain draws lines on the glass stay a while stay a while let the slow hours pass' })
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const job = fakeJob({ mode: 'new', count: 1, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', check_model: 'mock-whisper-v1', batch_id: 'b_sung' })
    await generateSongPool(job)
    assert.equal(job.result.complete, true, job.output_lines.join('\n'))
    const music = service.submissions.filter(s => s.operation === 'music').map(s => s.parsedBody!)
    assert.equal(music.length, 2, 'sung twice')
    assert.ok(music.every(b => b.instrumental === false && b.lyrics === LYRICS))
    assert.notEqual(music[0]!.seed, music[1]!.seed, 'a retake has a new seed')
    assert.match(String(music[0]!.prompt), /^cafe jazz, piano trio, cosy, warm female vocal, \d+ BPM, \S+ (major|minor)$/)
    assert.match(job.output_lines.join('\n'), /take 1 moved to Trash, singing it again \(take 2 of 2\)/)
    const [song, ...rest] = await poolSongs('b_sung')
    assert.equal(rest.length, 0, 'only the passing take is in the pool')
    assert.equal(song!.enabled, true)
    assert.equal(song!.lyrics_check, 'passed')
    assert.equal(song!.lyrics_match, 1)
    assert.equal(song!.lyrics, LYRICS)
    assert.equal(song!.style, 'cafe jazz, piano trio, cosy, warm female vocal')
    const trash = await fs.readdir(path.join(path.dirname(path.dirname((await import('../services/song-pool.js')).poolDir(slug)!)), '_trash', slug, 'music-library')).catch(() => [])
    assert.equal(trash.length, 1, 'the failed take is in Trash, not deleted')
  })

  test('every take failing keeps the last one switched off and fails loudly; a paid listen-back is never confirmed', async () => {
    service.queueScenario('chat', { outputText: sungAnswer() })
    service.queueScenario('transcription', { outputText: 'la la la' })
    service.queueScenario('transcription', { outputText: 'la la la' })
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const job = fakeJob({ mode: 'new', count: 1, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', check_model: 'mock-whisper-v1', batch_id: 'b_fail' })
    await assert.rejects(generateSongPool(job), /Song generation/)
    const songs = await poolSongs('b_fail')
    assert.equal(songs.length, 1, job.output_lines.join('\n'))
    assert.equal(songs[0]!.enabled, false, 'never drawn unheard')
    assert.equal(songs[0]!.lyrics_check, 'failed')
    assert.equal(songs[0]!.lyrics_match, 0)

    service.transcriptionQuoteCredits = 7
    const confirmed = service.providerSubmissionCount('transcription')
    service.queueScenario('chat', { outputText: sungAnswer() })
    const paid = fakeJob({ mode: 'new', count: 1, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', check_model: 'mock-whisper-v1', batch_id: 'b_paid' })
    await assert.rejects(generateSongPool(paid), /Song generation/)
    assert.equal(service.providerSubmissionCount('transcription'), confirmed, 'the quote was refused before confirming')
    const [unchecked] = await poolSongs('b_paid')
    assert.equal(unchecked!.lyrics_check, 'unchecked')
    assert.equal('lyrics_match' in unchecked!, false, 'not checked is not a score of 0')
    assert.equal(unchecked!.enabled, false)
  })
})
