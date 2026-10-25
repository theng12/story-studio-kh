/**
 * The owner incident this pins (MANU0002, 2026-10-25): a worker re-imported the
 * episode script with IDENTICAL text, which rewrote all 12 chapter files. Every
 * chapter then counted as `audio_stale` — because staleness compared the chapter
 * file's mtime with its audio chunks' mtimes — and all 12 were narrated again
 * although no word had changed.
 *
 * Staleness is now a comparison of CONTENT: the fingerprint of the text the
 * narration was made from is recorded when that narration is activated, and the
 * chapter is stale only when the text on disk differs from it. Audio narrated
 * before the record existed keeps the old mtime rule and says so
 * (`basis: 'legacy_mtime'`), because "I cannot tell" must not be reported as
 * "the script changed" (AGENTS.md §6).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const CODE = 'EP0101'
const OLD = new Date('2026-01-01T00:00:00Z')
const NEWER = new Date('2026-01-01T01:00:00Z')
const NEWEST = new Date('2026-01-01T02:00:00Z')
const RECORD_FILE = 'audio_narration_source.json'

let tmp: Awaited<ReturnType<typeof useTempDataDir>>
let serial = 0

before(async () => { tmp = await useTempDataDir() })
after(async () => { await tmp.cleanup() })

interface Fixture {
  scriptDir: string
  episodeDir: string
  audioDir: string
  recordPath: string
}

function chapterStem(number: number): string {
  return `Chapter_${String(number).padStart(2, '0')}`
}

function chapterMarkdown(number: number, title: string, text: string): string {
  return `## Chapter ${String(number).padStart(2, '0')}: ${title}\n\n${text}\n`
}

/**
 * One episode folder with two chapter sources and one audio file each. Nothing
 * here involves the generator: these drive the shared rule directly.
 */
async function fixture(chapters: Array<{ number: number, title: string, text: string }>): Promise<Fixture> {
  const dir = path.join(tmp.dir, `narration-source-${++serial}`)
  const scriptDir = path.join(dir, 'Script')
  const episodeDir = path.join(dir, 'Episode')
  const audioDir = path.join(episodeDir, 'Audio')
  await Promise.all([scriptDir, audioDir].map(d => fs.mkdir(d, { recursive: true })))
  for (const chapter of chapters) {
    const stem = chapterStem(chapter.number)
    await fs.writeFile(
      path.join(scriptDir, `${CODE}_${stem}.md`),
      chapterMarkdown(chapter.number, chapter.title, chapter.text),
      'utf8',
    )
    await fs.writeFile(path.join(audioDir, `${CODE}_${stem}.mp3`), `audio for ${stem}`)
  }
  return { scriptDir, episodeDir, audioDir, recordPath: path.join(episodeDir, RECORD_FILE) }
}

const TWO_CHAPTERS = [
  { number: 1, title: 'One', text: 'The first chapter stayed exactly as it was.' },
  { number: 2, title: 'Two', text: 'The second chapter stayed exactly as it was.' },
]

function chunkPaths(f: Fixture, number: number): string[] {
  return [path.join(f.audioDir, `${CODE}_${chapterStem(number)}.mp3`)]
}

function sourcePath(f: Fixture, number: number): string {
  return path.join(f.scriptDir, `${CODE}_${chapterStem(number)}.md`)
}

/** Record the text the audio was narrated from, exactly as the generator does. */
async function recordCurrentText(f: Fixture, numbers: number[]): Promise<void> {
  const { recordNarrationSource, currentNarrationSourceHash } = await import('../services/narration-staleness.js')
  const entries = await Promise.all(numbers.map(async number => ({
    slug: chapterStem(number),
    sha256: (await currentNarrationSourceHash(f.scriptDir, CODE, chapterStem(number)))!,
  })))
  await recordNarrationSource(f.episodeDir, entries)
}

async function staleness(f: Fixture, number: number) {
  const { narrationStaleness } = await import('../services/narration-staleness.js')
  return narrationStaleness({
    episodeCode: CODE,
    slug: chapterStem(number),
    scriptDir: f.scriptDir,
    episodeDir: f.episodeDir,
    audioFilePaths: chunkPaths(f, number),
  })
}

async function setMtime(file: string, time: Date): Promise<void> {
  await fs.utimes(file, time, time)
}

test('rewriting a chapter with the SAME text keeps its narration fresh — the MANU0002 incident', async () => {
  const f = await fixture(TWO_CHAPTERS)
  await recordCurrentText(f, [1])
  await setMtime(sourcePath(f, 1), OLD)
  await setMtime(chunkPaths(f, 1)[0]!, OLD)
  assert.equal((await staleness(f, 1)).state, 'fresh')

  // The re-import: identical words, a brand-new mtime, no other change.
  const before = await fs.readFile(sourcePath(f, 1), 'utf8')
  await fs.writeFile(sourcePath(f, 1), before, 'utf8')
  await setMtime(sourcePath(f, 1), NEWEST)
  const reused = await staleness(f, 1)
  assert.equal(reused.state, 'fresh', 'identical text must never be reported as out of date')
  assert.equal(reused.basis, 'content')
  assert.equal(reused.reason, 'text_unchanged')
})

test('changed chapter text makes exactly that chapter stale', async () => {
  const f = await fixture(TWO_CHAPTERS)
  await recordCurrentText(f, [1, 2])
  await fs.writeFile(sourcePath(f, 2), chapterMarkdown(2, 'Two', 'The second chapter was corrected after narration.'), 'utf8')
  await setMtime(sourcePath(f, 2), NEWEST)
  const changed = await staleness(f, 2)
  assert.equal(changed.state, 'stale')
  assert.equal(changed.basis, 'content')
  assert.equal(changed.reason, 'text_changed')
  assert.match(changed.detail, /text changed/)
  assert.equal((await staleness(f, 1)).state, 'fresh', 'the untouched chapter stays fresh')
})

test('a changed chapter stays stale even when its audio is newer than the file — the comparison is content, not mtime', async () => {
  const f = await fixture(TWO_CHAPTERS)
  await recordCurrentText(f, [1])
  await fs.writeFile(sourcePath(f, 1), chapterMarkdown(1, 'One', 'A completely different passage.'), 'utf8')
  await setMtime(sourcePath(f, 1), OLD)
  // The mtime rule would call this fresh: the audio is at least as new as the
  // file. Content is what decides, so the stale narration is still reported.
  await setMtime(chunkPaths(f, 1)[0]!, NEWEST)
  const changed = await staleness(f, 1)
  assert.equal(changed.state, 'stale', 'reverting to mtimes must fail this test')
  assert.equal(changed.basis, 'content')
  assert.equal(changed.reason, 'text_changed')
})

test('audio narrated before the text record existed keeps the mtime rule — and is reported as legacy', async () => {
  const f = await fixture(TWO_CHAPTERS)
  // No record on disk: this episode was narrated before Story Studio wrote one.
  await setMtime(sourcePath(f, 1), NEWER)
  await setMtime(chunkPaths(f, 1)[0]!, OLD)
  await setMtime(sourcePath(f, 2), OLD)
  await setMtime(chunkPaths(f, 2)[0]!, NEWER)

  const newerScript = await staleness(f, 1)
  assert.equal(newerScript.state, 'stale')
  assert.equal(newerScript.basis, 'legacy_mtime', 'the fallback must announce itself')
  assert.equal(newerScript.reason, 'legacy_script_newer_than_audio')
  assert.match(newerScript.detail, /predates text-based checking/)
  assert.doesNotMatch(newerScript.detail, /text changed/)

  const newerAudio = await staleness(f, 2)
  assert.equal(newerAudio.state, 'fresh', 'legacy audio at least as new as its source is fresh')
  assert.equal(newerAudio.basis, 'legacy_mtime')
})

test('nothing to compare is unknown, never a quiet "fresh"', async () => {
  const f = await fixture(TWO_CHAPTERS)
  const { narrationStaleness } = await import('../services/narration-staleness.js')
  const noAudio = await narrationStaleness({
    episodeCode: CODE, slug: chapterStem(1), scriptDir: f.scriptDir, episodeDir: f.episodeDir, audioFilePaths: [],
  })
  assert.equal(noAudio.state, 'unknown', 'no audio → unknown, not fresh')
  assert.equal(noAudio.reason, 'no_audio')

  await fs.rm(sourcePath(f, 1))
  const missing = await staleness(f, 1)
  assert.equal(missing.state, 'unknown', 'a chapter with no readable text cannot be called changed')
  assert.equal(missing.reason, 'script_absent')
  assert.equal(missing.basis, 'none')
})

test('a record written under another fingerprint contract, or a corrupt one, falls back instead of guessing', async () => {
  const f = await fixture(TWO_CHAPTERS)
  await setMtime(sourcePath(f, 1), OLD)
  await setMtime(chunkPaths(f, 1)[0]!, OLD)
  await fs.writeFile(f.recordPath, JSON.stringify({ version: 1, fingerprint: 'some-future-contract', sections: {
    [chapterStem(1)]: { sha256: `sha256:${'a'.repeat(16)}`, recorded_at: '2026-01-01T00:00:00Z' },
  } }))
  const ignored = await staleness(f, 1)
  assert.equal(ignored.state, 'fresh')
  assert.equal(ignored.basis, 'legacy_mtime', 'an unreadable record is the legacy path, never "the text changed"')
  await fs.writeFile(f.recordPath, '{ not json')
  assert.equal((await staleness(f, 1)).basis, 'legacy_mtime')
})

test('the record never drops a section it did not narrate', async () => {
  const { readNarrationSource, recordNarrationSource } = await import('../services/narration-staleness.js')
  const f = await fixture(TWO_CHAPTERS)
  const one = `sha256:${'1'.repeat(16)}`
  const two = `sha256:${'2'.repeat(16)}`
  await recordNarrationSource(f.episodeDir, [{ slug: chapterStem(1), sha256: one }])
  await recordNarrationSource(f.episodeDir, [{ slug: chapterStem(2), sha256: two }])
  const record = await readNarrationSource(f.episodeDir)
  assert.equal(record.sections[chapterStem(1)]?.sha256, one, 'a later narration must not erase an earlier section')
  assert.equal(record.sections[chapterStem(2)]?.sha256, two)
  assert.deepEqual(await readNarrationSource(path.join(f.episodeDir, 'nowhere')), { version: 1, fingerprint: 'chapter-text-v1', sections: {} },
    'reading an episode with no record must never hand over another episode\'s sections')
})

/**
 * The real path: narration is generated, the record is written with it, and the
 * two routes that show staleness read the same rule.
 */
test('generating narration records the text it narrated, and both routes agree after a same-text rewrite', async () => {
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { writeChapterFiles, assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
    const { readNarrationSource, currentNarrationSourceHash } = await import('../services/narration-staleness.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const project = await pm.createProject({ name: 'Narration text', episode_prefix: 'NT', episode_digits: 4 })
    await pm.updateConfig(project.slug, { safety_checks: { silent_narration: 'off' } })
    const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Two chapters', logline: 'Fixture', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
    const code = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await fs.mkdir(paths.script_dir, { recursive: true })
    const parts = { chapters: TWO_CHAPTERS }
    await writeChapterFiles(paths.script_dir, code, 'Two chapters', parts)
    await assembleUnifiedNarration(paths.script_dir, code, 'Two chapters')

    const terminal = async (id: string) => waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(id)?.status || ''), { label: id, timeoutMs: 30_000 })
    const generated = await request(app).post(`/api/projects/${project.slug}/generate/audio`)
      .send({ episode_id: code, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'all', speed: 1 })
    assert.equal(generated.status, 201, JSON.stringify(generated.body))
    const jobId = String(generated.body.job_id || generated.body.job?.job_id || '')
    await terminal(jobId)
    assert.equal(jq.getJob(jobId)?.status, 'done', JSON.stringify(jq.getJob(jobId)))

    // The record names the text this narration was made from, for every section.
    const record = await readNarrationSource(paths.episode_dir)
    for (const number of [1, 2]) {
      const slug = chapterStem(number)
      const current = await currentNarrationSourceHash(paths.script_dir, code, slug)
      assert.ok(current, `${slug} must be fingerprintable`)
      assert.equal(record.sections[slug]?.sha256, current,
        `${slug} must record the fingerprint of the script the narration was made from`)
    }

    const audioSections = async () => (await request(app).get(`/api/projects/${project.slug}/episodes/${code}/audio-sections`)).body.sections
    const chapterList = async () => (await request(app).get(`/api/projects/${project.slug}/episodes/${code}/chapter-list`)).body.chapters
    const stale = (rows: any[], key: string) => rows.filter(row => row.audio_staleness?.state === 'stale').map(row => row[key])

    assert.deepEqual(stale(await audioSections(), 'slug'), [], 'freshly narrated audio is not stale')
    assert.deepEqual(stale(await chapterList(), 'number'), [])

    // The incident: the whole script is re-imported with identical text, so every
    // chapter file is rewritten with a newer mtime.
    await writeChapterFiles(paths.script_dir, code, 'Two chapters', parts)
    for (const number of [1, 2]) {
      const file = path.join(paths.script_dir, `${code}_${chapterStem(number)}.md`)
      const now = new Date((await fs.stat(file)).mtimeMs + 60_000)
      await fs.utimes(file, now, now)
    }
    assert.deepEqual(stale(await audioSections(), 'slug'), [], 'a same-text rewrite must not stale any narration')
    assert.deepEqual(stale(await chapterList(), 'number'), [], 'both routes read the same rule')

    // A real edit: only that chapter, and the reason is the true one.
    await writeChapterFiles(paths.script_dir, code, 'Two chapters', {
      chapters: [{ number: 2, title: 'Two', text: 'The second chapter was corrected after narration.' }],
    })
    const sectionsAfterEdit = await audioSections()
    assert.deepEqual(stale(sectionsAfterEdit, 'slug'), ['Chapter_02'])
    assert.equal(sectionsAfterEdit.find((row: any) => row.slug === 'Chapter_02')?.audio_staleness.reason, 'text_changed')
    assert.deepEqual(stale(await chapterList(), 'number'), [2])

    // A legacy episode (audio from before the record) plus a rewritten chapter:
    // the mtime fallback answers, and says that is what answered.
    await fs.rm(path.join(paths.episode_dir, RECORD_FILE))
    const legacy = (await chapterList()).find((row: any) => row.number === 2)
    assert.equal(legacy?.audio_staleness.state, 'stale')
    assert.equal(legacy?.audio_staleness.basis, 'legacy_mtime')
    assert.equal(legacy?.audio_staleness.reason, 'legacy_script_newer_than_audio')
  } finally {
    await service.close()
  }
})
