/**
 * Subtitle stitcher (v1.0.218+) — matching robustness + loud-empty failure.
 *
 * Guards the "blank stitched SRT" bug: a slug/filename mismatch between
 * audio_chapters.json sections and the per-chapter SRT files used to write
 * an empty file, which the Scene Plan LLM step then choked on. Now the
 * matcher tolerates format drift, and a genuinely-empty stitch THROWS.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

let stitch: typeof import('../services/subtitle-stitcher.js')
let subtitles: typeof import('../generators/subtitles.js')
let tmp: string

before(async () => {
  stitch = await import('../services/subtitle-stitcher.js')
  subtitles = await import('../generators/subtitles.js')
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-stitch-'))
})
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

async function makeCase(name: string, chapters: any, files: Record<string, string>) {
  const dir = path.join(tmp, name)
  const subs = path.join(dir, 'subs')
  await fs.mkdir(subs, { recursive: true })
  await fs.writeFile(path.join(dir, 'audio_chapters.json'), JSON.stringify(chapters), 'utf-8')
  for (const [fn, body] of Object.entries(files)) await fs.writeFile(path.join(subs, fn), body, 'utf-8')
  return { episode_dir: dir, subtitles_dir: subs, episode_code: 'EP0001' }
}

const SRT = '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond line\n'

describe('subtitle stitcher', () => {
  test('rejects a skipped auto-stitch so a complete section batch cannot become a done subtitle job', () => {
    assert.throws(
      () => subtitles.requireWrittenSubtitleStitch({ status: 'not-applicable', reason: 'no matching section files' }),
      /subtitle stitch did not complete.*no matching section files/i,
    )
  })

  test('matches per-chapter SRT despite slug-format drift (chapter_1 ↔ EP0001_Chapter1.srt)', async () => {
    const inputs = await makeCase('drift', {
      gap_duration_s: 1.5,
      sections: [{ slug: 'chapter_1', duration_s: 120 }],
    }, { 'EP0001_Chapter1.srt': SRT })
    const r = await stitch.stitchSubtitles(inputs)
    assert.equal(r.total_cues, 2)
    assert.equal(r.sections[0].source_srt, 'EP0001_Chapter1.srt')
    // The stitched file must be non-empty on disk.
    const out = await fs.readFile(r.output_path, 'utf-8')
    assert.ok(out.includes('Hello world'))
  })

  test('matches exact "{code}_{slug}.srt" convention', async () => {
    const inputs = await makeCase('exact', {
      gap_duration_s: 1, sections: [{ slug: 'introduction', duration_s: 60 }],
    }, { 'EP0001_introduction.srt': SRT })
    const r = await stitch.stitchSubtitles(inputs)
    assert.equal(r.total_cues, 2)
  })

  test('throws a diagnostic error (not a blank file) when nothing matches', async () => {
    const inputs = await makeCase('empty', {
      gap_duration_s: 1, sections: [{ slug: 'chapter_1', duration_s: 60 }],
    }, { 'EP0001_whisper.srt': SRT })  // merged-mode file, no per-chapter SRT
    await assert.rejects(
      () => stitch.stitchSubtitles(inputs),
      /incomplete|produced 0 cues|no per-chapter subtitle file matched/i,
    )
    // And it must NOT have written a stitched file.
    const exists = await fs.access(path.join(inputs.subtitles_dir, 'EP0001_stitched.srt')).then(() => true).catch(() => false)
    assert.equal(exists, false)
  })

  test('rejects a partial stitch and identifies every missing audio section', async () => {
    const inputs = await makeCase('partial', {
      gap_duration_s: 1,
      sections: [
        { slug: 'Chapter_01', duration_s: 60 },
        { slug: 'Chapter_02', duration_s: 70 },
        { slug: 'Chapter_03', duration_s: 80 },
      ],
    }, { 'EP0001_Chapter_01.srt': SRT })
    await assert.rejects(
      () => stitch.stitchSubtitles(inputs),
      error => {
        assert.match(String(error), /subtitle timeline is incomplete/i)
        assert.match(String(error), /Chapter_02/)
        assert.match(String(error), /Chapter_03/)
        return true
      },
    )
    const exists = await fs.access(path.join(inputs.subtitles_dir, 'EP0001_stitched.srt')).then(() => true).catch(() => false)
    assert.equal(exists, false)
  })

  test('marks a fully stitched timeline complete in its metadata', async () => {
    const inputs = await makeCase('complete-meta', {
      gap_duration_s: 1,
      sections: [
        { slug: 'Chapter_01', duration_s: 60 },
        { slug: 'Chapter_02', duration_s: 70 },
      ],
    }, {
      'EP0001_Chapter_01.srt': SRT,
      'EP0001_Chapter_02.srt': SRT,
    })
    const result = await stitch.stitchSubtitles(inputs)
    const meta = JSON.parse(await fs.readFile(`${result.output_path}.json`, 'utf-8'))
    assert.equal(result.complete, true)
    assert.deepEqual(result.missing_sections, [])
    assert.equal(meta.complete, true)
    assert.deepEqual(meta.missing_sections, [])
  })
})
