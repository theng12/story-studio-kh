/**
 * Merged-audio freshness (1.4.353) — Wonder in Ink: `merged_audio` went false after a finished
 * Audio Assembly. The merge had been built from loose `_partN` chapter files (audio made with
 * no_overwrite writes no chapter records, so the pre-merge join had nothing to go on); the merge then
 * published `audio_chapters.json` naming those parts, and the next reader (Subtitles, the Audio
 * Editor page) joined them into a NEWER single chapter file, which episode status rightly treats as
 * "an active chapter is newer than the merge".
 *
 *   Fix A  Audio Assembly joins the proven part sets itself, before it reads its chapter list, so the
 *          master is built from the chapter file the record will keep.
 *   Fix B  The one freshness rule (`inspectAudioMergeAtPaths`) returns a reason, episode status
 *          carries it, and Video Assembly's scan reports the same verdict from the same function.
 *
 * Chapter fixtures are synthetic tones made with FFmpeg.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
const { consolidateChapterParts, PARTS_DIRNAME } = await import('../services/chapter-parts.js')
const { inspectAudioMergeAtPaths, computeEpisodeStatus } = await import('../services/asset-status.js')
const { provenPartSets } = await import('../generators/audio-merge.js')
const { writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')

const CODE = 'EP001'
const MERGED = `${CODE}_merged_audio.mp3`
const COMPLETION = `${CODE}_merged_audio.completion.json`

async function tone(file: string, freq = 220): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await runFfmpeg(['-y', '-hide_banner', '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=24000:duration=1`,
    '-af', 'adelay=100,apad=pad_dur=0.15', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', file])
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000)
const setTime = (file: string, when: Date) => fs.utimes(file, when, when)

function layout(name: string) {
  const root = path.join(temp.dir, name)
  const episodeDir = path.join(root, `${CODE} - Test`)
  return {
    root, episodeDir,
    audioDir: path.join(episodeDir, `${CODE} - 07 Audio Assets`),
    mergedDir: path.join(episodeDir, `${CODE} - 08 Audio Merge Output`),
    paths: {
      episode_dir: episodeDir,
      audio_dir: path.join(episodeDir, `${CODE} - 07 Audio Assets`),
      merged_audio_dir: path.join(episodeDir, `${CODE} - 08 Audio Merge Output`),
    },
  }
}

/** The merged master and the completion record that describes it, as a finished merge leaves them. */
async function writeMerge(mergedDir: string, opts: { mtime: Date; bytes?: number; names?: string } = { mtime: ago(60) }) {
  await fs.mkdir(mergedDir, { recursive: true })
  const file = path.join(mergedDir, MERGED)
  await fs.writeFile(file, 'MERGED-MASTER')
  await setTime(file, opts.mtime)
  await fs.writeFile(path.join(mergedDir, COMPLETION), JSON.stringify({
    output_filename: opts.names ?? MERGED, bytes: opts.bytes ?? 'MERGED-MASTER'.length, duration_sec: 12,
  }))
  return file
}

const writeChapters = (episodeDir: string, files: string[][]) => fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
  sections: files.map((source_files, index) => ({ slug: `Chapter_0${index + 1}`, duration_s: 1, source_file: source_files[0], source_files })),
}))

// ── Fix B: one rule, with a reason ───────────────────────────────────────────

test('a current merge is present and has no reason', async () => {
  const l = layout('b-current')
  await fs.mkdir(l.audioDir, { recursive: true })
  await fs.writeFile(path.join(l.audioDir, `${CODE}_Chapter_01.mp3`), 'a')
  await setTime(path.join(l.audioDir, `${CODE}_Chapter_01.mp3`), ago(300))
  await writeMerge(l.mergedDir)
  await writeChapters(l.episodeDir, [[`${CODE}_Chapter_01.mp3`]])
  const merge = await inspectAudioMergeAtPaths(l.paths, CODE)
  assert.equal(merge.present, true)
  assert.equal(merge.reason, undefined)
  assert.equal(merge.path, path.join(l.mergedDir, MERGED))
})

test('every way a merge is not present names its reason', async () => {
  // No merged file at all.
  const none = layout('b-missing')
  await fs.mkdir(none.mergedDir, { recursive: true })
  assert.deepEqual(await inspectAudioMergeAtPaths(none.paths, CODE), { present: false, dir: none.mergedDir, reason: 'missing' })

  // A pin that names a file that is not here is refused, not swapped.
  const pinned = layout('b-pin')
  await writeMerge(pinned.mergedDir)
  await writeSelectedMergedAudio(pinned.mergedDir, `${CODE}_merged_audio_v9.mp3`)
  assert.equal((await inspectAudioMergeAtPaths(pinned.paths, CODE)).reason, 'missing')

  // The completion record does not describe this file.
  const wrongBytes = layout('b-bytes')
  await writeMerge(wrongBytes.mergedDir, { mtime: ago(60), bytes: 999 })
  assert.deepEqual(await inspectAudioMergeAtPaths(wrongBytes.paths, CODE),
    { present: false, file: MERGED, dir: wrongBytes.mergedDir, reason: 'completion-mismatch' })
  const wrongName = layout('b-name')
  await writeMerge(wrongName.mergedDir, { mtime: ago(60), names: `${CODE}_merged_audio_v2.mp3` })
  assert.equal((await inspectAudioMergeAtPaths(wrongName.paths, CODE)).reason, 'completion-mismatch')

  // An active chapter is newer than the merge, or gone.
  const newer = layout('b-newer')
  await fs.mkdir(newer.audioDir, { recursive: true })
  await fs.writeFile(path.join(newer.audioDir, `${CODE}_Chapter_01.mp3`), 'a')
  await fs.writeFile(path.join(newer.audioDir, `${CODE}_Chapter_02.mp3`), 'b')
  await setTime(path.join(newer.audioDir, `${CODE}_Chapter_01.mp3`), ago(300))
  await writeMerge(newer.mergedDir, { mtime: ago(120) })
  await writeChapters(newer.episodeDir, [[`${CODE}_Chapter_01.mp3`], [`${CODE}_Chapter_02.mp3`]])
  const changed = await inspectAudioMergeAtPaths(newer.paths, CODE)
  assert.equal(changed.present, false)
  assert.equal(changed.reason, `chapter-changed:${CODE}_Chapter_02.mp3`, 'names the chapter that moved, not just "stale"')
  await fs.rm(path.join(newer.audioDir, `${CODE}_Chapter_02.mp3`))
  assert.equal((await inspectAudioMergeAtPaths(newer.paths, CODE)).reason, `chapter-changed:${CODE}_Chapter_02.mp3`, 'a vanished chapter is the same verdict')

  // The chapter record cannot say which chapters the merge used.
  for (const [name, body] of [['b-bad-json', '{ not json'], ['b-no-sections', '{}'], ['b-no-names', JSON.stringify({ sections: [{ slug: 'Chapter_01' }] })]] as const) {
    const bad = layout(name)
    await writeMerge(bad.mergedDir)
    await fs.mkdir(bad.episodeDir, { recursive: true })
    await fs.writeFile(path.join(bad.episodeDir, 'audio_chapters.json'), body)
    const verdict = await inspectAudioMergeAtPaths(bad.paths, CODE)
    assert.equal(verdict.present, false, name)
    assert.equal(verdict.reason, 'chapter-record-unreadable', name)
  }
  // A merge from before chapter records existed is still accepted.
  const legacy = layout('b-legacy')
  await writeMerge(legacy.mergedDir)
  assert.equal((await inspectAudioMergeAtPaths(legacy.paths, CODE)).present, true)
})

test('the report scenario: a merge of loose parts is stale once the parts are joined, and fresh if it is newer', async () => {
  const l = layout('b-report')
  const parts = [`${CODE}_Chapter_01_part1.mp3`, `${CODE}_Chapter_01_part2.mp3`]
  for (const [i, part] of parts.entries()) {
    await tone(path.join(l.audioDir, part), 220 + i * 110)
    await setTime(path.join(l.audioDir, part), ago(600))
  }
  // The merge as 1.4.352 made it: built from the parts, naming the parts in its chapter record.
  const merged = await writeMerge(l.mergedDir, { mtime: ago(300) })
  await writeChapters(l.episodeDir, [parts])
  assert.equal((await inspectAudioMergeAtPaths(l.paths, CODE)).present, true, 'built from the parts, so far current')

  // The next reader joins them (the record names the parts, so it can).
  const joined = await consolidateChapterParts({ projectDir: l.root, episodeDir: l.episodeDir, audioDir: l.audioDir, code: CODE })
  assert.deepEqual(joined, ['Chapter_01'])
  const afterJoin = await inspectAudioMergeAtPaths(l.paths, CODE)
  assert.equal(afterJoin.present, false)
  assert.equal(afterJoin.reason, `chapter-changed:${CODE}_Chapter_01.mp3`, 'the joined chapter is newer than the merge')

  // A merge made after the join is current.
  await setTime(merged, new Date(Date.now() + 60_000))
  assert.equal((await inspectAudioMergeAtPaths(l.paths, CODE)).present, true)
})

// ── Fix A: join the proven parts before the merge reads its chapter list ─────

test('provenPartSets names only split chapters whose every expected part is on disk', () => {
  const expected = [`${CODE}_Introduction.mp3`, `${CODE}_Chapter_01_part1.mp3`, `${CODE}_Chapter_01_part2.mp3`,
    `${CODE}_Chapter_02_part1.mp3`, `${CODE}_Chapter_02_part2.mp3`, `${CODE}_Chapter_03_part1.mp3`, `${CODE}_Chapter_04.mp3`]
  const present = [expected[0]!, expected[1]!, expected[2]!, expected[3]!, expected[5]!, expected[6]!]
  assert.deepEqual(provenPartSets({ expected_files: expected, present_files: present }, CODE),
    { Chapter_01: [`${CODE}_Chapter_01_part1.mp3`, `${CODE}_Chapter_01_part2.mp3`] },
    'Chapter_02 is missing part2, Chapter_03 has one part, Introduction and Chapter_04 are whole files')
  assert.deepEqual(provenPartSets({ expected_files: [], present_files: [] }, CODE), {})
})

async function firstAssemblyFixture(name: string) {
  const l = layout(name)
  const parts = [`${CODE}_Chapter_01_part1.mp3`, `${CODE}_Chapter_01_part2.mp3`]
  for (const [i, part] of parts.entries()) await tone(path.join(l.audioDir, part), 220 + i * 110)
  await tone(path.join(l.audioDir, `${CODE}_Chapter_02.mp3`), 440)
  return { ...l, parts, base: path.join(l.audioDir, `${CODE}_Chapter_01.mp3`) }
}

test('a first assembly with loose parts and no chapter records joins them, and nothing re-joins afterwards', async () => {
  const f = await firstAssemblyFixture('a-first')
  const input = { projectDir: f.root, episodeDir: f.episodeDir, audioDir: f.audioDir, code: CODE }
  const proven = provenPartSets({
    expected_files: [...f.parts, `${CODE}_Chapter_02.mp3`], present_files: [...f.parts, `${CODE}_Chapter_02.mp3`],
  }, CODE)

  // Today's pre-merge join has nothing to go on: no records, so the parts stay loose.
  assert.deepEqual(await consolidateChapterParts(input), [])
  assert.ok(f.parts.every(part => existsSync(path.join(f.audioDir, part))))
  assert.equal(existsSync(f.base), false)

  // With the proven set the chapter is joined into its one file and the parts are kept in .parts.
  assert.deepEqual(await consolidateChapterParts({ ...input, provenParts: proven }), ['Chapter_01'])
  assert.ok(existsSync(f.base) && (await fs.stat(f.base)).size > 0)
  assert.ok(f.parts.every(part => !existsSync(path.join(f.audioDir, part))), 'the loose parts moved aside')
  assert.ok(existsSync(path.join(f.audioDir, PARTS_DIRNAME, `${CODE}_Chapter_01`, 'manifest.json')))
  assert.ok(existsSync(path.join(f.audioDir, PARTS_DIRNAME, `${CODE}_Chapter_01`, 'part1.mp3')))
  assert.ok(existsSync(path.join(f.audioDir, `${CODE}_Chapter_02.mp3`)), 'a whole chapter is untouched')

  // The merge now reads one file per chapter and publishes a record naming exactly those.
  const merged = await writeMerge(f.mergedDir, { mtime: new Date(Date.now() + 30_000) })
  await writeChapters(f.episodeDir, [[`${CODE}_Chapter_01.mp3`], [`${CODE}_Chapter_02.mp3`]])
  assert.equal((await inspectAudioMergeAtPaths(f.paths, CODE)).present, true, 'status is true afterwards')

  // The next callers (Subtitles, the Audio Editor page) join nothing and change no file.
  const before = (await fs.stat(f.base)).mtimeMs
  const mergedBefore = (await fs.stat(merged)).mtimeMs
  assert.deepEqual(await consolidateChapterParts(input), [])
  assert.deepEqual(await consolidateChapterParts({ ...input, provenParts: proven }), [])
  assert.equal((await fs.stat(f.base)).mtimeMs, before, 'the chapter file is not rewritten')
  assert.equal((await fs.stat(merged)).mtimeMs, mergedBefore)
  assert.equal((await inspectAudioMergeAtPaths(f.paths, CODE)).present, true, 'and the merge is still current')
})

test('a proven set never replaces a chapter file that already exists', async () => {
  const f = await firstAssemblyFixture('a-existing-base')
  await tone(f.base, 330)
  const bytes = await fs.readFile(f.base)
  const input = { projectDir: f.root, episodeDir: f.episodeDir, audioDir: f.audioDir, code: CODE }
  assert.deepEqual(await consolidateChapterParts({ ...input, provenParts: { Chapter_01: f.parts } }), [])
  assert.deepEqual(await fs.readFile(f.base), bytes, 'the existing chapter file is untouched')
  assert.ok(f.parts.every(part => existsSync(path.join(f.audioDir, part))))
  assert.equal(existsSync(path.join(f.audioDir, PARTS_DIRNAME)), false, 'nothing was moved or trashed')
})

test('a proven set that is not a complete 1..n part run is not joined', async () => {
  const f = await firstAssemblyFixture('a-gap')
  await fs.rename(path.join(f.audioDir, f.parts[1]!), path.join(f.audioDir, `${CODE}_Chapter_01_part3.mp3`))
  const input = { projectDir: f.root, episodeDir: f.episodeDir, audioDir: f.audioDir, code: CODE }
  assert.deepEqual(await consolidateChapterParts({ ...input, provenParts: { Chapter_01: [f.parts[0]!, `${CODE}_Chapter_01_part3.mp3`] } }), [])
  assert.equal(existsSync(f.base), false)
})

test('a proven set is not joined when the disk holds more parts than it names', async () => {
  const f = await firstAssemblyFixture('a-extra-part')
  const extra = path.join(f.audioDir, `${CODE}_Chapter_${String(1).padStart(2, '0')}_part${f.parts.length + 1}.mp3`)
  await tone(extra, 550)
  const input = { projectDir: f.root, episodeDir: f.episodeDir, audioDir: f.audioDir, code: CODE }
  assert.deepEqual(await consolidateChapterParts({ ...input, provenParts: { Chapter_01: f.parts } }), [])
  assert.equal(existsSync(f.base), false, 'no partial join')
  assert.ok([...f.parts, path.basename(extra)].every(part => existsSync(path.join(f.audioDir, part))), 'every part left in place')
})

test('Audio Assembly joins the proven parts before it reads its chapter list', () => {
  const source = readFileSync(new URL('../generators/audio-merge.ts', import.meta.url), 'utf8')
  const join = source.indexOf('provenPartSets(readiness, code)')
  const read = source.indexOf('selectedSources = await resolveSidecarSelection(')
  const scan = source.indexOf('await scanEpisodeAudioAssets(project_slug, code)')
  assert.ok(join > 0 && read > join && scan > join, 'join, then read the selection, then scan')
  assert.match(source.slice(join - 200, join + 600), /consolidateEpisodeParts\(project_slug, code, line => job\.output_lines\.push\(line\), proven\)/)
  assert.match(source.slice(join - 300, join), /!req\.audio_quality_refresh/, 'a quality refresh keeps the exact files its repair selected')
  assert.match(source.slice(join, join + 700), /readiness = await inspectChapterAudioReadiness\(project_slug, code\)/, 'the preflight is re-checked after the join')
})

// ── Scan parity: Video Assembly and episode status agree ─────────────────────

async function seedEpisode(name: string) {
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Merged freshness', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  // The same minimal plan the other scan fixtures carry, so the scan reads a normal Scene Plan episode.
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1, generated_at: '2026-10-24T09:00:00.000Z', total_duration_sec: 10,
    scenes: [{ id: 'scene-0001', scene_index: 1, start_sec: 0, end_sec: 10, visual_prompt: 'A quiet archive.' }],
  }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  return { slug: project.slug, code: accepted.episode_code, paths }
}

test("Video Assembly's scan reports the same verdict, and reason, as the inspection and episode status", async () => {
  const { scanEpisodeAssets } = await import('../generators/video.js')
  const { slug, code, paths } = await seedEpisode('Scan parity')
  const chapter = path.join(paths.audio_dir, `${code}_Chapter_01.mp3`)
  await fs.mkdir(paths.audio_dir, { recursive: true })
  await fs.mkdir(paths.merged_audio_dir, { recursive: true })
  await fs.writeFile(chapter, 'chapter')
  await setTime(chapter, ago(300))
  const merged = path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`)
  await fs.writeFile(merged, 'MERGED-MASTER')
  await setTime(merged, ago(120))
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${code}_merged_audio.mp3`, bytes: 'MERGED-MASTER'.length, duration_sec: 12,
  }))
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: 'Chapter_01', duration_s: 1, source_files: [`${code}_Chapter_01.mp3`] }],
  }))

  const agree = async () => {
    const inspected = await inspectAudioMergeAtPaths(paths, code)
    const scanned = (await scanEpisodeAssets(slug, code)).merged_audio_current
    const status = await computeEpisodeStatus(slug, code)
    assert.equal(scanned?.current, inspected.present)
    assert.equal(status.merged_audio, inspected.present)
    assert.equal(scanned?.reason, inspected.reason)
    assert.equal(status.merged_audio_reason, inspected.reason)
    assert.equal(scanned?.file, inspected.file ?? null)
    return inspected
  }

  const fresh = await agree()
  assert.equal(fresh.present, true)
  assert.equal(fresh.reason, undefined)

  // The chapter is replaced after the merge: the scan no longer certifies the old master.
  await setTime(chapter, new Date())
  const stale = await agree()
  assert.equal(stale.present, false)
  assert.equal(stale.reason, `chapter-changed:${code}_Chapter_01.mp3`)
  assert.deepEqual((await scanEpisodeAssets(slug, code)).merged_audio_current,
    { current: false, file: `${code}_merged_audio.mp3`, reason: `chapter-changed:${code}_Chapter_01.mp3` })
})
