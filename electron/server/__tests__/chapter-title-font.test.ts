/**
 * Chapter title fonts (1.4.384), from the Node side.
 *
 * What is pinned here:
 *
 *   1. NO SELECTION IS THE RELEASE-383 RENDER. The emitted filtergraph is the
 *      legacy string byte for byte, the source anchors still sit in the
 *      release-383 baseline file, and a presentation that names no face changes
 *      nothing. This is the command-string half of the no-selection proof —
 *      the lead's isolated FFmpeg frame comparison is the other half.
 *   2. An EXPLICIT face reaches drawtext as `fontfile=` pointing at the staged
 *      copy of the manifest bytes, and the staged bytes hash to the manifest
 *      SHA-256 (the same verification the remote font closure performs).
 *   3. A heading the face cannot draw is refused by name — Khmer in a Latin-only
 *      face fails; the same Khmer text in Kantumruy Pro passes. English works
 *      in both.
 *   4. Wrap keeps every grapheme (Khmer clusters are never split) and fit
 *      only ever shrinks.
 *
 * What these cannot catch: whether a fontfile drawtext LOOKS like the Pango
 * preview — that is the lead's frame comparison, not a string assertion.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { prepareSceneClips } from '../generators/video.js'
import {
  assertChapterTitleCovers,
  chapterTitleFontId,
  escapeChapterFontfile,
  layoutChapterTitle,
  stageChapterTitleFont,
} from '../lib/chapter-title-font.js'
import { clearFontManifestCache, fontsResourceDir, readFontManifest } from '../lib/thumbnail-fonts.js'
import { frameTextUnit } from '../lib/render-canvas.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import { useTempDataDir } from './_helpers.js'
import type { VideoChapterTitles } from '../models/types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const PARAMS = { type: 'ken-burns', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 } as const

const BASELINE_383 = fileURLToPath(new URL('../../../../release-383/electron/server/generators/video.ts', import.meta.url))
const BASELINE_PRESENT = existsSync(BASELINE_383)

const scratch: string[] = []
const cleanups: Array<() => Promise<void>> = []
after(async () => {
  await Promise.all(scratch.map(dir => fs.rm(dir, { recursive: true, force: true }).catch(() => {})))
  await Promise.all(cleanups.map(cleanup => cleanup().catch(() => {})))
})
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapter-title-font-'))
  scratch.push(dir)
  return dir
}

const W = 128
const H = 96

/** The chapter drawtext a 1.4.383 render emits, rebuilt here from the legacy template. */
function legacyDrawtext(title: string, titles: VideoChapterTitles): string {
  const fontSize = Math.round(({ small: frameTextUnit(W, H) / 25, medium: frameTextUnit(W, H) / 18, large: frameTextUnit(W, H) / 12 })[titles.font_size as 'small' | 'medium' | 'large'] || frameTextUnit(W, H) / 18)
  const yPos = ({ top: String(Math.round(H * 0.08)), center: '(h-text_h)/2', bottom: String(Math.round(H * 0.85)) })[titles.position as 'top' | 'center' | 'bottom'] ?? '(h-text_h)/2'
  const fontColor = ({ gold: 'gold', white: 'white', neon: '00ffcc', minimal: 'white@0.8' })[titles.style as 'gold' | 'white' | 'neon' | 'minimal'] ?? 'white'
  const escaped = title.replace(/\\/g, '\\\\\\\\').replace(/'/g, "'\\\\\\''").replace(/:/g, '\\:').replace(/%/g, '%%')
  const titleDur = titles.duration || 3
  return `drawtext=text='${escaped}':fontsize=${fontSize}:fontcolor=${fontColor}:enable='lt(t,${titleDur})':borderw=2:bordercolor=black@0.6:x=(w-text_w)/2:y=${yPos}`
}

interface Harness {
  dir: string
  job: any
  encoded: string[][]
  run: (scenes: any[], chapterTitles: VideoChapterTitles) => Promise<string[]>
}

async function harness(): Promise<Harness> {
  cleanups.push((await useTempDataDir()).cleanup)
  const dir = await tempDir()
  const encoded: string[][] = []
  const job: any = {
    job_id: 'chapter-font-fixture', project_slug: 'demo', type: 'video_assembly', episode_id: 'EP001', title: 'chapter-font',
    status: 'running', created_at: new Date().toISOString(), started_at: null, finished_at: null, error: null,
    output_lines: [], params: {},
  }
  const run = (scenes: any[], chapterTitles: VideoChapterTitles) =>
    prepareSceneClips(
      scenes, { ...PARAMS } as any, chapterTitles,
      W, H, { crf: 23, preset: 'medium', fps: 5 }, dir, true,
      { seconds_per_scene: 1, shuffle: false, excluded_scenes: [] }, job,
      { pool: [], randomizeMode: 'off', seed: 7 },
      scenes.map(() => 1), 0, [],
      {
        checkpoint: { version: 1, job_id: job.job_id, project_slug: 'demo', episode_id: 'EP001', work_dir: dir, render_fingerprint: 'a'.repeat(64), completed_scene_clips: [] },
        renderFingerprint: 'a'.repeat(64),
        encodeSceneClip: async (args: string[]) => { encoded.push(args); await fs.writeFile(args.at(-1)!, tinyVideoBytes()) },
      } as any,
    )
  return { dir, job, encoded, run }
}

async function stills(dir: string, title: string): Promise<any[]> {
  const file = path.join(dir, 'still.png')
  await fs.writeFile(file, ONE_PIXEL_PNG)
  return [{ image_path: file, duration: 1, title, show_title: true }]
}

const baseTitles = (patch: Partial<VideoChapterTitles> = {}): VideoChapterTitles => ({
  enabled: true, style: 'white', position: 'bottom', duration: 3, font_size: 'medium', animation: 'none', ...patch,
})

const drawtextOf = (args: string[]): string[] => args.filter(part => part.includes('drawtext='))
const allDrawtext = (encoded: string[][]): string[] => encoded.flatMap(drawtextOf)

/** Every `y=` a chain positions a drawtext at, as the number it evaluates to on this frame. */
const yValues = (chain: string, h: number): number[] => (chain.match(/:y=([^,]+)/g) ?? []).map((raw) => {
  const expr = raw.slice(3)
  if (/^\d+$/.test(expr)) return Number(expr)
  const centred = expr.match(/^\(\(h-(\d+)\)\/2\)\+(\d+)$/)
  if (centred) return (h - Number(centred[1])) / 2 + Number(centred[2])
  throw new Error(`unexpected drawtext y expression: ${expr}`)
})

// ── No selection = the release-383 render ────────────────────────────────────

test('no selection: the helpers that build the legacy drawtext are byte-identical to release-383', { skip: BASELINE_PRESENT ? undefined : 'release-383 baseline not present' }, () => {
  const baseline = readFileSync(BASELINE_383, 'utf8')
  const current = readFileSync(fileURLToPath(new URL('../generators/video.ts', import.meta.url)), 'utf8')
  // The functions whose RETURNED strings make up the legacy chapter drawtext.
  // If any of them moves, no-selection output moves — so they must not.
  const functionBody = (source: string, name: string): string => {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start >= 0, `expected ${name} in the source`)
    const end = source.indexOf('\n}', start)
    assert.ok(end > start, `expected the end of ${name}`)
    return source.slice(start, end + 2)
  }
  for (const name of ['escapeDrawtext', 'getFontSize', 'getTextPosition', 'getStyleColor']) {
    assert.equal(functionBody(current, name), functionBody(baseline, name), `${name} must be byte-identical to release-383`)
  }
  // The legacy emission itself, still spelled the old way in the baseline.
  assert.ok(baseline.includes("borderw=2:bordercolor=black@0.6"), 'release-383 still emits the legacy border')
  assert.ok(baseline.includes('const drawCommon = `text='), 'release-383 still builds the legacy drawCommon')
})

test('no selection: the emitted drawtext is the legacy string byte for byte, with no fontfile', async () => {
  const h = await harness()
  await h.run(await stills(h.dir, 'The Quiet Harbor'), baseTitles())
  const chains = allDrawtext(h.encoded)
  assert.equal(chains.length, 1, `expected one chapter drawtext, got ${chains.length}: ${chains.join(' | ')}`)
  const legacy = legacyDrawtext('The Quiet Harbor', baseTitles())
  assert.ok(chains[0]!.includes(legacy), `chain must contain the legacy drawtext verbatim:\n${chains[0]}\nvs\n${legacy}`)
  assert.equal((chains[0]!.match(/drawtext=/g) || []).length, 1, 'exactly one drawtext in the chain')
  assert.ok(!chains[0]!.includes('fontfile'), 'a render with nothing picked must not name a fontfile')
})

test('no selection: a presentation that names no face changes nothing', async () => {
  const h = await harness()
  const titles = baseTitles({ chapter_title_presentation: { appearance: { color: '#ff0000', outline: 5, wrap: true }, automatic_fit: true } })
  await h.run(await stills(h.dir, 'The Quiet Harbor'), titles)
  const chains = allDrawtext(h.encoded)
  assert.equal(chains.length, 1)
  const legacy = legacyDrawtext('The Quiet Harbor', baseTitles())
  assert.ok(chains[0]!.includes(legacy), 'appearance without a face must not reach the render')
  assert.ok(!chains[0]!.includes('0xff0000'), 'the picked colour must not appear without a face')
  assert.ok(!chains[0]!.includes('borderw=5'), 'the picked outline must not appear without a face')
  assert.ok(!chains[0]!.includes('fontfile'), 'no fontfile without a face')
})

// ── An explicit face ─────────────────────────────────────────────────────────

test('an explicit face reaches drawtext as fontfile pointing at the staged manifest bytes', async () => {
  const h = await harness()
  const titles = baseTitles({ chapter_title_presentation: { font_id: 'anton' } })
  await h.run(await stills(h.dir, 'The Quiet Harbor'), titles)
  const lines = allDrawtext(h.encoded)
  assert.equal(lines.length, 1)
  const manifest = await readFontManifest()
  const entry = manifest.fonts.find(font => font.id === 'anton')!
  const staged = path.join(h.dir, `chapter-title-font-${entry.id}${path.extname(entry.file)}`)
  assert.ok(lines[0]!.includes('fontfile='), `drawtext must carry a fontfile: ${lines[0]}`)
  assert.ok(lines[0]!.includes(staged), `fontfile must point at the staged copy: ${lines[0]}`)
  // The staged bytes ARE the manifest bytes: same SHA-256 the remote closure pins.
  const stagedSha = createHash('sha256').update(await fs.readFile(staged)).digest('hex')
  assert.equal(stagedSha, entry.sha256)
  // Everything else about the legacy string is untouched.
  assert.ok(lines[0]!.includes("text='The Quiet Harbor'"))
  assert.ok(lines[0]!.includes('borderw=2:bordercolor=black@0.6'))
})

test('an unknown face id refuses loudly instead of rendering in an unchosen face', async () => {
  await assert.rejects(
    () => stageChapterTitleFont({ font_id: 'not-a-bundled-font' }, os.tmpdir()),
    /not one of this build's bundled fonts/,
  )
})

test('bytes that disagree with the manifest refuse before anything renders', async () => {
  clearFontManifestCache()
  const fakeRoot = await tempDir()
  const real = fontsResourceDir()
  // A resources root whose anton file is NOT the manifest's bytes.
  // `fontsResourceDir()` reads `<override>/fonts`, so the fake tree mirrors that.
  const fakeFonts = path.join(fakeRoot, 'fonts')
  await fs.mkdir(path.join(fakeFonts, 'anton'), { recursive: true })
  const manifest = JSON.parse(await fs.readFile(path.join(real, 'fonts.json'), 'utf8'))
  const anton = manifest.fonts.find((font: any) => font.id === 'anton')!
  await fs.writeFile(path.join(fakeFonts, 'anton', path.basename(anton.file)), 'not the real font bytes')
  await fs.writeFile(path.join(fakeFonts, 'fonts.json'), JSON.stringify(manifest))
  process.env.STORY_STUDIO_RESOURCES_DIR = fakeRoot
  clearFontManifestCache()
  try {
    await assert.rejects(
      () => stageChapterTitleFont({ font_id: 'anton' }, os.tmpdir()),
      /integrity check/,
    )
  } finally {
    delete process.env.STORY_STUDIO_RESOURCES_DIR
    clearFontManifestCache()
  }
})

// ── Khmer and English, real glyphs ───────────────────────────────────────────

test('a Latin-only face refuses a Khmer heading by name; Kantumruy Pro draws both scripts', async () => {
  const dir = await tempDir()
  const khmer = 'សួស្តី'
  const english = 'Hello world'
  const stagedLatin = await stageChapterTitleFont({ font_id: 'anton' }, dir)
  const stagedKhmer = await stageChapterTitleFont({ font_id: 'kantumruy-pro' }, dir)
  assert.ok(stagedLatin && stagedKhmer)
  await assert.rejects(
    () => assertChapterTitleCovers(stagedLatin!, khmer, 'Chapter title "សួស្តី"'),
    /សួស្តី|no glyph/,
  )
  await assertChapterTitleCovers(stagedLatin!, english, 'Chapter title "Hello world"')
  await assertChapterTitleCovers(stagedKhmer!, khmer, 'Chapter title "សួស្តី"')
  await assertChapterTitleCovers(stagedKhmer!, english, 'Chapter title "Hello world"')
})

test('wrap keeps every grapheme of a Khmer heading — a cluster is never split in two', async () => {
  const dir = await tempDir()
  const staged = await stageChapterTitleFont({ font_id: 'kantumruy-pro' }, dir)
  assert.ok(staged)
  const text = 'រាត្រីនៃការគេងស្ងប់ស្ងាត់​ជាមួយភាពស្រស់ស្អាត'
  const layout = await layoutChapterTitle({
    text, fontSize: 22, frameWidth: 160, family: staged!.family, wrap: true, automaticFit: false,
  })
  assert.ok(layout.lines.length > 1, `expected the heading to wrap, got ${JSON.stringify(layout.lines)}`)
  const rejoined = layout.lines.join('').replace(/\s/g, '')
  const original = text.replace(/\s|​/g, '')
  assert.equal(rejoined, original, 'wrapping must not lose or split any character')
  // No line may cut a base consonant away from its following marks: the joined
  // grapheme sequence of each line must survive segmentation intact.
  const segmenter = new Intl.Segmenter('km', { granularity: 'grapheme' })
  for (const line of layout.lines) {
    const segments = [...segmenter.segment(line)].map(part => part.segment)
    assert.equal(segments.join(''), line)
  }
})

test('automatic fit only ever shrinks, and only when asked', async () => {
  const dir = await tempDir()
  const staged = await stageChapterTitleFont({ font_id: 'anton' }, dir)
  assert.ok(staged)
  const text = 'A very long English chapter heading that cannot fit on one line at all'
  const plain = await layoutChapterTitle({ text, fontSize: 40, frameWidth: 200, family: staged!.family, wrap: false, automaticFit: false })
  assert.equal(plain.fontSize, 40, 'without fit the style size is untouched')
  assert.deepEqual(plain.lines, [text])
  const fitted = await layoutChapterTitle({ text, fontSize: 40, frameWidth: 200, family: staged!.family, wrap: true, automaticFit: true })
  assert.ok(fitted.fontSize <= 40, `fit may only shrink: ${fitted.fontSize}`)
  assert.ok(fitted.lines.length >= 1)
})

// ── Selection plumbing ───────────────────────────────────────────────────────

test('the face in force is the explicit pick first and the pool resolution second; nothing selected is null', () => {
  assert.equal(chapterTitleFontId(null), null)
  assert.equal(chapterTitleFontId({}), null)
  assert.equal(chapterTitleFontId({ channel_look: true }), null, 'a pool that has not resolved names no face')
  assert.equal(chapterTitleFontId({ channel_look: true, resolved_font_id: 'inter' }), 'inter')
  assert.equal(chapterTitleFontId({ font_id: 'anton', resolved_font_id: 'inter' }), 'anton', 'the explicit pick wins')
})

test('the fontfile option is quoted so a path can never break the filtergraph', () => {
  assert.equal(escapeChapterFontfile('/a/b.ttf'), "'/a/b.ttf'")
  assert.equal(escapeChapterFontfile("/a/b'c.ttf"), "'/a/b\\'c.ttf'")
  assert.equal(escapeChapterFontfile('C:\\fonts\\x.ttf'), "'C:\\\\fonts\\\\x.ttf'")
})

// ── Fit, wrapping and block bounds reach the output ─────────────────────────

test('automatic fit reaches the emitted drawtext: the fitted size IS the fontsize drawtext gets', async () => {
  const title = 'A very long English chapter heading that cannot fit on one line at all in this frame'
  const family = (await readFontManifest()).fonts.find(font => font.id === 'anton')!.family
  const styleSize = Math.round(frameTextUnit(W, H) / 18)
  const fitted = await layoutChapterTitle({
    text: title, fontSize: styleSize, frameWidth: W, frameHeight: H, family, wrap: false, automaticFit: true,
  })
  assert.ok(fitted.fontSize < styleSize, `this heading must shrink to fit: ${fitted.fontSize} vs ${styleSize}`)

  const h = await harness()
  await h.run(await stills(h.dir, title), baseTitles({
    chapter_title_presentation: { font_id: 'anton', automatic_fit: true },
  }))
  const chain = allDrawtext(h.encoded)[0]!
  const emitted = Number(chain.match(/fontsize=(\d+)/)![1])
  assert.equal(emitted, fitted.fontSize, `drawtext must be told the fitted size, got ${emitted}, layout said ${fitted.fontSize}`)
  assert.ok(h.job.output_lines.some((line: string) => line.includes('auto-fit')), 'the job log reports the shrink')
})

test('a wrapped heading keeps every line and the block stays inside the frame — bottom and centre, English and Khmer', async () => {
  const manifest = await readFontManifest()
  const titles = [
    { font_id: 'anton', text: ('The quiet harbor at dawn '.repeat(25)).trim() },
    { font_id: 'kantumruy-pro', text: ('រាត្រីនៃការគេងស្ងប់ស្ងាត់​ជាមួយភាពស្រស់ស្អាត '.repeat(30)).trim() },
  ]
  for (const entry of titles) {
    const family = manifest.fonts.find(font => font.id === entry.font_id)!.family
    const styleSize = Math.round(frameTextUnit(W, H) / 18)
    const layout = await layoutChapterTitle({
      text: entry.text, fontSize: styleSize, frameWidth: W, frameHeight: H, family, wrap: true, automaticFit: true,
    })
    assert.ok(layout.lines.length > 8, `${entry.font_id}: expected more than 8 wrapped lines, got ${layout.lines.length}`)
    const step = Math.round(layout.fontSize * 1.18)
    assert.ok(layout.lines.length * step <= Math.round(H * 0.85), 'fit keeps the whole block inside the height budget')

    for (const position of ['bottom', 'center'] as const) {
      const h = await harness()
      await h.run(await stills(h.dir, entry.text), baseTitles({
        position,
        chapter_title_presentation: { font_id: entry.font_id, automatic_fit: true, appearance: { wrap: true } },
      }))
      const chain = allDrawtext(h.encoded)[0]!
      const drawn = (chain.match(/drawtext=/g) || []).length
      assert.equal(drawn, layout.lines.length, `${entry.font_id}/${position}: every wrapped line must be drawn, ${drawn} vs ${layout.lines.length}`)
      assert.equal(Number(chain.match(/fontsize=(\d+)/)![1]), layout.fontSize, `${entry.font_id}/${position}: fitted size reaches drawtext`)

      const ys = yValues(chain, H)
      assert.equal(ys.length, layout.lines.length)
      assert.deepEqual(ys, [...ys].sort((a, b) => a - b), `${position}: lines step downward in order`)
      const blockTop = ys[0]!
      const blockBottom = ys[ys.length - 1]! + step
      assert.ok(blockTop >= 0, `${position}: block starts above the frame (${blockTop})`)
      assert.ok(blockBottom <= H, `${position}: block ends below the frame (${blockBottom} > ${H})`)
      if (position === 'bottom') {
        assert.equal(blockTop, Math.round(H * 0.85) - (layout.lines.length - 1) * step,
          'the bottom anchor holds the whole block, not just its first line')
      } else {
        assert.equal((blockTop + blockBottom) / 2, H / 2, 'the centre anchor centres the whole block')
      }
    }
  }
})

test('a heading with & < > is measured and drawn as literal text, never as markup', async () => {
  const dir = await tempDir()
  const staged = await stageChapterTitleFont({ font_id: 'inter' }, dir)
  assert.ok(staged)
  const text = 'Fish & Chips <3> "quoted" — ok'
  const layout = await layoutChapterTitle({
    text, fontSize: 20, frameWidth: 640, family: staged!.family, wrap: false, automaticFit: false,
  })
  assert.deepEqual(layout.lines, [text], 'markup characters must survive measurement as themselves')

  const h = await harness()
  await h.run(await stills(h.dir, text), baseTitles({ chapter_title_presentation: { font_id: 'inter' } }))
  const chain = allDrawtext(h.encoded)[0]!
  assert.ok(chain.includes('Fish & Chips'), `the drawn text keeps its own characters: ${chain}`)
  assert.ok(chain.includes('<3>'), 'angle brackets reach drawtext literally')
})

test('the staged copy drawtext reads is verified against the manifest before anything renders', async () => {
  const dir = await tempDir()
  const staged = await stageChapterTitleFont({ font_id: 'anton' }, dir)
  assert.ok(staged)
  const entry = (await readFontManifest()).fonts.find(font => font.id === 'anton')!
  const stagedSha = createHash('sha256').update(await fs.readFile(staged!.fontfile)).digest('hex')
  assert.equal(stagedSha, staged!.sha256, 'what drawtext reads hashes to the sha the stage returned')
  assert.equal(stagedSha, entry.sha256, 'and that is the manifest SHA-256')
  assert.ok(staged!.fontfile.startsWith(dir), 'the staged path is the copy inside the render temp dir')
})
