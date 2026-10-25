import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import JSZip from 'jszip'
import { useTempDataDir } from './_helpers.js'
import { writeChapterFiles, assembleUnifiedNarration } from '../lib/narration-assembly.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import { parseSrt } from '../lib/subtitle-builder.js'

const CODE = 'EP0001'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
// The staleness answer is a typed object (state/basis/reason/detail), not a
// boolean — AGENTS.md §6. These fixtures are legacy audio (no narration-text
// record), so a stale row must also say it was the mtime fallback that noticed.
const staleSections = (sections: any[]) => sections.filter(row => row.audio_staleness?.state === 'stale').map(row => row.slug)
const staleChapters = (chapters: any[]) => chapters.filter(row => row.audio_staleness?.state === 'stale').map(row => row.number)
const old = new Date('2026-01-01T00:00:00Z')
const audioTime = new Date('2026-01-02T00:00:00Z')
const derivedTime = new Date('2026-01-03T00:00:00Z')
let tmp: Awaited<ReturnType<typeof useTempDataDir>>
let app: express.Express
let serial = 0
let jq: typeof import('../services/job-queue.js')

before(async () => {
  tmp = await useTempDataDir()
  jq = await import('../services/job-queue.js')
  await jq.setQueuePaused(true)
  app = express().use(express.json())
  app.use('/api', (await import('../routes/scripts.js')).router)
  app.use('/api', (await import('../routes/audio.js')).router)
})
after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await jq.setQueuePaused(false)
  await jq._waitForJobPersistenceForTesting()
  await tmp.cleanup()
})

async function fixture() {
  const slug = `chapter-editor-${++serial}`
  const projectDir = path.join(tmp.dir, 'projects', slug)
  const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Test`)
  const scriptDir = path.join(episodeDir, `${CODE} - 01 Script`)
  const audioDir = path.join(episodeDir, `${CODE} - 07 Audio Assets`)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ slug, name: slug, episode_prefix: 'EP',
    season_size: 20, season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/' }))
  await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify({ audio_quality: { mode: 'off' } }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({ ideas: [
    { id: 'one', episode_code: CODE, title: 'Test', status: 'accepted' },
  ], next_episode_number: 2, recycled_numbers: [] }))
  await writeChapterFiles(scriptDir, CODE, 'Test', { intro: { text: 'An introduction remains.' }, chapters: [
    { number: 1, title: 'One', text: 'The first chapter remains unchanged.' },
    { number: 2, title: 'Two', text: 'The second chapter needs a correction.' },
    { number: 3, title: 'Three', text: 'The third chapter remains unchanged.' },
  ] })
  await assembleUnifiedNarration(scriptDir, CODE, 'Test')
  await Promise.all([audioDir, subtitlesDir, mergedDir].map(dir => fs.mkdir(dir, { recursive: true })))
  const sections = ['Introduction', 'Chapter_01', 'Chapter_02', 'Chapter_03'].map(slug => ({
    slug, source_file: `${CODE}_${slug}.mp3`, duration_s: 1,
  }))
  for (const section of sections) {
    const source = path.join(scriptDir, `${CODE}_${section.slug}.md`)
    await fs.utimes(source, old, old)
    const audio = path.join(audioDir, section.source_file)
    await fs.writeFile(audio, `retained audio ${section.slug}`)
    await fs.utimes(audio, audioTime, audioTime)
    const srt = path.join(subtitlesDir, `${CODE}_${section.slug}.srt`)
    await fs.writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nRetained words.\n')
    await fs.utimes(srt, derivedTime, derivedTime)
  }
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({ sections, gap_duration_s: 0 }))
  await fs.writeFile(path.join(episodeDir, 'research.json'), JSON.stringify({ summary: 'Upstream research stays.', claims: [] }))
  const merged = path.join(mergedDir, `${CODE}_merged_audio.mp3`)
  await fs.writeFile(merged, 'retained combined audio')
  await fs.utimes(merged, derivedTime, derivedTime)
  const stitched = path.join(subtitlesDir, `${CODE}_stitched.srt`)
  const srt = sections.map((_, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\nRetained words.\n`).join('\n')
  await fs.writeFile(stitched, srt)
  await fs.utimes(stitched, derivedTime, derivedTime)
  const stamp = stampFromCues(parseSrt(srt))
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, total_cues: 4, timeline: stamp,
    sections: sections.map((section, i) => ({ ...section, source_srt: `${CODE}_${section.slug}.srt`, cues_added: 1, offset_sec: i, duration_sec: 1 })) }))
  const url = `/api/projects/${slug}/episodes/${CODE}/chapters/2/content`
  return { slug, projectDir, episodeDir, scriptDir, audioDir, subtitlesDir, mergedDir, url,
    source: path.join(scriptDir, `${CODE}_Chapter_02.md`),
    async get() { return request(app).get(url) },
    async save(text: unknown, expected?: string) {
      return request(app).put(url).send({ text, expected_sha256: expected ?? (await this.get()).body.sha256 })
    },
  }
}

async function inventory(root: string): Promise<Record<string, { hash: string; mtime: number }>> {
  const result: Record<string, { hash: string; mtime: number }> = {}
  async function visit(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else result[path.relative(root, file)] = { hash: hash(await fs.readFile(file, 'utf8')), mtime: (await fs.stat(file)).mtimeMs }
    }
  }
  await visit(root)
  return result
}

async function docx(heading: string, text: string) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('GET hashes exactly the returned body; a scoped save preserves other bytes/mtimes and archives both old formats', async () => {
  const f = await fixture()
  const legacy = f.source.replace(/\.md$/, '.docx')
  const oldDocx = await docx('Chapter 02: Two', 'Older Word copy.')
  await fs.writeFile(legacy, oldDocx)
  const before = await inventory(f.episodeDir)
  const oldSource = await fs.readFile(f.source)
  const read = await f.get()
  assert.equal(read.status, 200)
  assert.equal(read.body.sha256, hash(read.body.content))
  const saved = await f.save('There were 12 lamps in the corrected room.', read.body.sha256)
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.chapter.sha256, hash(saved.body.chapter.content))
  assert.match(saved.body.chapter.content, /twelve lamps/)
  const after = await inventory(f.episodeDir)
  for (const name of Object.keys(before)) {
    if (name === path.relative(f.episodeDir, f.source) || name.endsWith('_Script_Narration.md')) continue
    assert.deepEqual(after[name], before[name], `${name} bytes and mtime must stay unchanged`)
  }
  const combined = await parseNarrationDocx(path.join(f.scriptDir, `${CODE}_Script_Narration.md`))
  assert.equal(combined.length, 4)
  assert.equal(combined.find(s => s.slug === 'Chapter_02')?.text, saved.body.chapter.content)
  assert.match(await fs.readFile(f.source, 'utf8'), /^## Chapter 02: Two\n/)
  const trash = path.join(tmp.dir, 'projects', '_trash', f.slug, 'script-versions')
  const archives = await inventory(trash)
  const md = Object.keys(archives).find(name => name.endsWith(`${CODE}_Chapter_02.md`))!
  const word = Object.keys(archives).find(name => name.endsWith(`${CODE}_Chapter_02.docx`))!
  assert.deepEqual(await fs.readFile(path.join(trash, md)), oldSource)
  assert.deepEqual(await fs.readFile(path.join(trash, word)), oldDocx)
})

test('an existing episode with a newer chapter mtime but no marker keeps everything fresh', async () => {
  const f = await fixture()
  const { inspectSubtitleSourceFreshness } = await import('../services/subtitle-completion.js')
  const { inspectAudioMergeAtPaths } = await import('../services/asset-status.js')
  const { readSubtitleTimelineIntegrity } = await import('../services/scene-timeline-integrity.js')
  const paths = { episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir }
  assert.equal((await inspectAudioMergeAtPaths(paths, CODE)).present, true)
  assert.deepEqual((await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE)).stale_sections, [])
  assert.equal((await readSubtitleTimelineIntegrity(f.subtitlesDir, CODE)).complete, true)
  const sourceTime = new Date((await fs.stat(f.source)).mtimeMs + 10000)
  await fs.utimes(f.source, sourceTime, sourceTime)
  assert.equal((await inspectAudioMergeAtPaths(paths, CODE)).present, true, 'merge stays present after mtime bump without marker')
  assert.deepEqual((await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE)).stale_sections, [], 'subtitles stay fresh')
  assert.equal((await readSubtitleTimelineIntegrity(f.subtitlesDir, CODE)).complete, true, 'timeline stays complete')
})
test('a stray copy in another subfolder is ignored', async () => {
  const f = await fixture()
  const { inspectAudioMergeAtPaths } = await import('../services/asset-status.js')
  const paths = { episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir }
  const strayDir = path.join(f.episodeDir, 'stray-copy')
  await fs.mkdir(strayDir, { recursive: true })
  await fs.writeFile(path.join(strayDir, `${CODE}_Chapter_02.md`), '## Chapter 02: Two\nStray copy.\n')
  const strayTime = new Date((await fs.stat(f.source)).mtimeMs + 20000)
  await fs.utimes(path.join(strayDir, `${CODE}_Chapter_02.md`), strayTime, strayTime)
  assert.equal((await inspectAudioMergeAtPaths(paths, CODE)).present, true, 'stray copy does not stale the merge')
})

// This fixture's audio predates the narration-text record, so the shared rule
// answers on its documented legacy mtime fallback. The content-based answer for
// audio generated by this build is pinned in audio-stale-narration-text.test.ts.
test('audio-sections and chapter-list report exactly the edited chapter; dependent freshness propagates without writes', async () => {
  const f = await fixture()
  const { inspectSubtitleSourceFreshness } = await import('../services/subtitle-completion.js')
  const { inspectAudioMergeAtPaths } = await import('../services/asset-status.js')
  const { readSubtitleTimelineIntegrity } = await import('../services/scene-timeline-integrity.js')
  const { isResearchComplete } = await import('../lib/research-verification.js')
  const researchPath = path.join(f.episodeDir, 'research.json')
  assert.equal(isResearchComplete(JSON.parse(await fs.readFile(researchPath, 'utf8'))), true)
  const paths = { episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir }
  assert.equal((await inspectAudioMergeAtPaths(paths, CODE)).present, true)
  assert.deepEqual((await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE)).stale_sections, [])
  assert.equal((await readSubtitleTimelineIntegrity(f.subtitlesDir, CODE)).complete, true)
  const before = await inventory(f.episodeDir)
  assert.equal((await f.save('Corrected historical passage.')).status, 200)
  const audio = await request(app).get(`/api/projects/${f.slug}/episodes/${CODE}/audio-sections`)
  assert.equal(audio.status, 200, JSON.stringify(audio.body))
  assert.deepEqual(staleSections(audio.body.sections), ['Chapter_02'])
  const list = await request(app).get(`/api/projects/${f.slug}/episodes/${CODE}/chapter-list`)
  assert.deepEqual(staleChapters(list.body.chapters), [2])
  assert.deepEqual((await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE)).stale_sections, ['Chapter_02'])
  const merge = await inspectAudioMergeAtPaths(paths, CODE)
  assert.equal(merge.present, false)
  assert.equal(merge.reason, 'script-changed:Chapter_02')
  const timeline = await readSubtitleTimelineIntegrity(f.subtitlesDir, CODE)
  assert.equal(timeline.complete, false, 'Scene Plan consumes this same timeline integrity rule')
  assert.match(timeline.missing_sections.join(', '), /Chapter_02 narration changed/)
  const after = await inventory(f.episodeDir)
  assert.equal(isResearchComplete(JSON.parse(await fs.readFile(researchPath, 'utf8'))), true)
  for (const name of Object.keys(before).filter(name => !name.endsWith('_Chapter_02.md') && !name.endsWith('_Script_Narration.md'))) assert.deepEqual(after[name], before[name])
  // Local stand-in for the customer's targeted re-narration: only that audio changes.
  const audioFile = path.join(f.audioDir, `${CODE}_Chapter_02.mp3`)
  await fs.writeFile(audioFile, 'replacement chapter audio')
  const markerPath = path.join(f.scriptDir, `${CODE}_Chapter_02.text-edit.json`)
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
  const freshTime = new Date(new Date(marker.edited_at).getTime() + 1000)
  await fs.utimes(audioFile, freshTime, freshTime)
  const refreshed = await request(app).get(`/api/projects/${f.slug}/episodes/${CODE}/audio-sections`)
  assert.deepEqual(staleSections(refreshed.body.sections), [], 're-narration clears the edit marker staleness')
  assert.deepEqual((await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE)).stale_sections, ['Chapter_02'], 'audio-byte freshness takes over after re-narration')
  assert.equal((await inspectAudioMergeAtPaths(paths, CODE)).reason, `chapter-changed:${CODE}_Chapter_02.mp3`)
  assert.equal((await readSubtitleTimelineIntegrity(f.subtitlesDir, CODE)).complete, false, 'the stitched timeline stays stale until it is re-stitched after the edit')
})

test('copy-first preservation failure leaves the active chapter and combined narration unchanged', async () => {
  const f = await fixture()
  const trash = path.join(tmp.dir, 'projects', '_trash', f.slug)
  await fs.mkdir(path.dirname(trash), { recursive: true })
  await fs.writeFile(trash, 'A blocked Trash destination.')
  const before = await inventory(f.episodeDir)
  const result = await f.save('Must not replace without a recoverable copy.')
  assert.equal(result.status, 500)
  assert.deepEqual(await inventory(f.episodeDir), before)
})

test('hash mismatch changes nothing, including Trash', async () => {
  const f = await fixture()
  const before = await inventory(tmp.dir)
  const saved = await f.save('A stale browser draft.', '0'.repeat(64))
  assert.equal(saved.status, 409)
  assert.match(saved.body.detail, /Reload/)
  assert.deepEqual(await inventory(tmp.dir), before)
})

test('two saves against one revision admit only one editor', async () => {
  const f = await fixture()
  const revision = (await f.get()).body.sha256
  const results = await Promise.all([f.save('First corrected text.', revision), f.save('Second corrected text.', revision)])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  const winner = results.find(r => r.status === 200)!
  assert.equal((await f.get()).body.content, winner.body.chapter.content)
})

test('saving unchanged text is a no-op', async () => {
  const f = await fixture()
  const current = (await f.get()).body
  const before = await inventory(tmp.dir)
  assert.equal((await f.save(current.content, current.sha256)).status, 200)
  assert.deepEqual(await inventory(tmp.dir), before)
})

test('retry repairs a failed/missing combined artifact without rewriting any chapter', async () => {
  const f = await fixture()
  const saved = await f.save('Saved chapter awaiting assembly repair.')
  assert.equal(saved.status, 200)
  const before = await inventory(f.scriptDir)
  await fs.writeFile(path.join(f.scriptDir, `${CODE}_Script_Narration.md`), 'Unusable derived output.\n')
  const retry = await f.save(saved.body.chapter.content, saved.body.chapter.sha256)
  assert.equal(retry.status, 200)
  const after = await inventory(f.scriptDir)
  for (const name of Object.keys(before).filter(name => !name.endsWith('_Script_Narration.md'))) assert.deepEqual(after[name], before[name])
  const combined = await parseNarrationDocx(path.join(f.scriptDir, `${CODE}_Script_Narration.md`))
  assert.equal(combined.find(s => s.slug === 'Chapter_02')?.text, saved.body.chapter.content)
})

test('preserves a format-specific heading verbatim', async () => {
  const f = await fixture()
  await fs.writeFile(f.source, '## Reason 02: Two\n\nOriginal reason.\n')
  assert.equal((await f.save('The corrected reason.')).status, 200)
  assert.match(await fs.readFile(f.source, 'utf8'), /^## Reason 02: Two\n/)
})

test('legacy Word-only chapter is copied first then promoted to Markdown', async () => {
  const f = await fixture()
  const legacy = f.source.replace(/\.md$/, '.docx')
  const bytes = await docx('Topic 02: Two', 'Original legacy body.')
  await fs.writeFile(legacy, bytes)
  const fixtureTrash = path.join(f.projectDir, '_trash', 'fixture-markdown.md')
  await fs.mkdir(path.dirname(fixtureTrash), { recursive: true })
  await fs.rename(f.source, fixtureTrash)
  assert.equal((await f.get()).body.content, 'Original legacy body.')
  const saved = await f.save('Corrected legacy body.')
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.match(await fs.readFile(f.source, 'utf8'), /^## Topic 02: Two\n/)
  assert.deepEqual(await fs.readFile(legacy), bytes)
  const archives = await inventory(path.join(tmp.dir, 'projects', '_trash', f.slug, 'script-versions'))
  assert.ok(Object.keys(archives).some(name => name.endsWith('_Chapter_02.docx')))
})

for (const text of ['', '   ', null, { prose: 'wrong type' }, '## Chapter 03: Changed\n\nText.', '# Introduction\n\nText.', 'Chapter 02: Changed title\n\nText.', '**II**\n\nText.', '**Narration**\n\nText.']) {
  test(`refuses empty/non-text or heading-changing body ${JSON.stringify(text)}`, async () => {
    const f = await fixture()
    const before = await inventory(tmp.dir)
    assert.equal((await f.save(text)).status, 400)
    assert.deepEqual(await inventory(tmp.dir), before)
  })
}

test('refuses missing/invalid hash, noninteger chapter, unknown project/episode/chapter, and malformed source heading', async () => {
  const f = await fixture()
  const before = await inventory(tmp.dir)
  for (const expected_sha256 of [undefined, '', 'not-a-hash']) assert.equal((await request(app).put(f.url).send({ text: 'Body.', expected_sha256 })).status, 400)
  for (const number of ['0', '-1', '1.5', 'NaN']) assert.equal((await request(app).put(f.url.replace('/2/content', `/${number}/content`)).send({ text: 'Body.', expected_sha256: '0'.repeat(64) })).status, 400)
  for (const url of [f.url.replace(f.slug, 'unknown'), f.url.replace(CODE, 'EP9999'), f.url.replace('/2/content', '/99/content')]) {
    assert.equal((await request(app).put(url).send({ text: 'Body.', expected_sha256: '0'.repeat(64) })).status, 404)
    assert.equal((await request(app).get(url)).status, 404)
  }
  assert.deepEqual(await inventory(tmp.dir), before)
  await fs.writeFile(f.source, '## Chapter 09: Wrong number\n\nOriginal body.\n')
  const malformed = await inventory(tmp.dir)
  assert.equal((await f.save('Replacement.')).status, 409)
  assert.deepEqual(await inventory(tmp.dir), malformed)
  await fs.writeFile(f.source, '## Chapter 02: Two\n\nFirst body.\n\n## Chapter 03: Hidden\n\nSecond body.\n')
  const multiple = await inventory(tmp.dir)
  assert.equal((await f.save('Do not silently lose the hidden section.')).status, 409)
  assert.deepEqual(await inventory(tmp.dir), multiple)
})

for (const type of ['audio', 'audio_merge', 'chapter-only', 'expand_chapters', 'introduction-only', 'outline_only'] as const) {
  test(`refuses queued/paused ownership by ${type}`, async () => {
    const f = await fixture()
    const job = jq.enqueuePreparedForTest({ project_slug: f.slug, episode_id: CODE, type, title: 'Hold', params: { sections: 'Chapter_02' } })
    await jq._waitForJobPersistenceForTesting()
    try {
      const before = await inventory(f.episodeDir)
      const result = await f.save('This edit must wait.')
      assert.equal(result.status, 409)
      assert.match(result.body.detail, /queued, running, or paused/)
      assert.deepEqual(await inventory(f.episodeDir), before)
      const paused = await jq.pauseJob(job.job_id)
      assert.equal(paused?.status, 'paused')
      assert.equal((await f.save('A paused owner still blocks this edit.')).status, 409)
      assert.deepEqual(await inventory(f.episodeDir), before)
    } finally {
      await jq.requestJobCancellation(f.slug, job.job_id)
      await jq._waitForJobPersistenceForTesting()
    }
  })
}

test('an audio job for another chapter does not block the edit', async () => {
  const f = await fixture()
  const job = jq.enqueuePreparedForTest({ project_slug: f.slug, episode_id: CODE, type: 'audio', title: 'Other chapter', params: { sections: '1,3' } })
  await jq._waitForJobPersistenceForTesting()
  try { assert.equal((await f.save('Allowed scoped correction.')).status, 200) }
  finally {
    await jq.requestJobCancellation(f.slug, job.job_id)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('P1: an episode with no stitch metadata gives the same result as before the marker change', async () => {
  const f = await fixture()
  const { readSubtitleTimelineIntegrity } = await import('../services/scene-timeline-integrity.js')
  const stitchedPath = path.join(f.subtitlesDir, `${CODE}_stitched.srt`)
  // Remove the sidecar so meta is absent/unreadable — the function must not throw.
  await fs.rm(`${stitchedPath}.json`, { force: true })
  const integrity = await readSubtitleTimelineIntegrity(f.subtitlesDir, CODE, { scriptDir: f.scriptDir })
  assert.equal(integrity.complete, false, 'missing sidecar means incomplete timeline')
  assert.ok(integrity.missing_sections.includes('subtitle timeline verification'), 'reports verification missing, never throws on absent meta')
})

test('P2: a renamed Script folder still sees its edit marker when scriptDir is passed', async () => {
  const f = await fixture()
  const { inspectSubtitleSourceFreshness } = await import('../services/subtitle-completion.js')
  const { inspectAudioMergeAtPaths } = await import('../services/asset-status.js')
  const paths = { episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir, script_dir: f.scriptDir }
  assert.deepEqual((await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE, f.scriptDir)).stale_sections, [])
  assert.equal((await inspectAudioMergeAtPaths(paths, CODE)).present, true)

  // Rename the Script folder away from the default name.
  const customScriptDir = path.join(f.episodeDir, 'My Custom Scripts')
  await fs.rename(f.scriptDir, customScriptDir)

  // Save through the route still writes the marker into the resolved script dir.
  // Simulate that by writing the marker directly into the custom folder.
  const { writeTextEditMarker } = await import('../lib/narration-source-freshness.js')
  await writeTextEditMarker(customScriptDir, CODE, 'Chapter_02', 'abc')

  // Without passing scriptDir, the default-name lookup misses the marker — fresh (wrong).
  const missed = await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE)
  assert.deepEqual(missed.stale_sections, [], 'default name lookup misses the marker in a renamed folder')

  // With the resolved scriptDir, the marker is found — stale (correct).
  const found = await inspectSubtitleSourceFreshness(f.episodeDir, f.audioDir, f.subtitlesDir, CODE, customScriptDir)
  assert.deepEqual(found.stale_sections, ['Chapter_02'], 'explicit scriptDir finds the marker even after rename')

  const mergeMissed = await inspectAudioMergeAtPaths({ episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir }, CODE)
  assert.equal(mergeMissed.present, true, 'merge stays present without scriptDir (marker not found)')
  const mergeFound = await inspectAudioMergeAtPaths({ episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir, script_dir: customScriptDir }, CODE)
  assert.equal(mergeFound.present, false, 'merge goes stale when scriptDir is threaded')
  assert.equal(mergeFound.reason, 'script-changed:Chapter_02')
})
