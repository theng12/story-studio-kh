/**
 * Escaping contract for values interpolated into an FFmpeg filter graph.
 *
 * Regression origin (v1.0.798): every contextual cue on a real 333-scene
 * assembly carried a subtitle, and two of the ten approved cues read
 * "Constantinople's main avenue" / "Constantinople's grain port". The cue
 * renderer wrapped each value in single quotes and escaped `'` as `\\'` —
 * but a backslash is NOT an escape inside an FFmpeg quoted run, so the
 * apostrophe closed the quote early and the ENTIRE filter graph was
 * rejected. Not one bad cue: the whole encode fell through to the minimal
 * recovery tier, which dropped the cues and the burned-in subtitles.
 *
 * Two things are proven here:
 *
 *  1. `escapeFilterArgValue` survives BOTH of FFmpeg's unescaping passes,
 *     verified against a faithful port of `av_get_token()` rather than by
 *     regex-matching the shape of our own output. This runs everywhere.
 *
 *  2. The real FFmpeg binary accepts the graphs we generate. This is the
 *     check that actually matters — a model of a parser can be wrong in the
 *     same direction as the code it validates. It runs whenever a
 *     drawtext-capable binary is present (`npm run fetch:ffmpeg` provides
 *     one); `bundled/ffmpeg/` is gitignored, so it skips loudly rather than
 *     failing on a checkout that has not fetched it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { escapeFilterArgValue, escapeFilterPath } from '../lib/ffmpeg-utils.js'
import { buildContextualCueDrawtextFilters } from '../lib/contextual-cue-filters.js'
import type { ContextualCue } from '../models/types.js'

const run = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Faithful port of libavutil's `av_get_token()`: `\` escapes the next
 * character; `'` opens a literal run that ends at the next `'` (backslashes
 * inside it are literal); an unescaped terminator ends the token.
 */
function avGetToken(input: string, terminators: string): { token: string; rest: string } {
  let out = ''
  let i = 0
  while (i < input.length) {
    const c = input[i]!
    if (terminators.includes(c)) break
    i++
    if (c === '\\' && i < input.length) {
      out += input[i]!
      i++
    } else if (c === "'") {
      while (i < input.length && input[i] !== "'") { out += input[i]!; i++ }
      if (i < input.length) i++
    } else {
      out += c
    }
  }
  return { token: out, rest: input.slice(i) }
}

/** Both passes FFmpeg applies: filtergraph args, then filter option value. */
function unescapeBothLevels(emitted: string): string {
  const level1 = avGetToken(emitted, '[],;').token
  return avGetToken(level1, ':').token
}

/**
 * Adversarial but realistic. Every character here is one an approved cue can
 * legitimately contain — `validateContextualCueTimeline` caps length but
 * deliberately does not restrict the character set, so the renderer must
 * handle whatever the validator allows.
 */
const HOSTILE_TEXT: Record<string, string> = {
  'apostrophe (real EP0067 copy)': "The Mese\nConstantinople's main avenue",
  'apostrophe, colon, comma, percent, newline': "Justinian's Plague: 541, 40% dead\nA quarantine, of sorts",
  'backslash': 'Ratio 1\\2\nsub',
  'filtergraph metacharacters': 'Chapter [1]; part 2, cont.\nsub: detail',
  'double quotes and equals': 'He said "stop" = order\nsub',
  'trailing backslash': 'Edge case\\\nsub',
  'consecutive quotes': "''double''\nsub",
  'percent template lookalike': '%{pts} is literal, 50%\nsub',
}

describe('escapeFilterArgValue — FFmpeg filter-argument escaping', () => {
  test('survives both of FFmpeg\'s unescaping passes byte-for-byte', () => {
    for (const [name, text] of Object.entries(HOSTILE_TEXT)) {
      const roundTripped = unescapeBothLevels(`${escapeFilterArgValue(text)}:next=1`)
      assert.equal(roundTripped, text, `two-level round trip changed the value for: ${name}`)
    }
  })

  test('an apostrophe cannot terminate the value early', () => {
    // The exact defect: the old escaper emitted `'...Constantinople\\'s...'`,
    // whose apostrophe closed the quote and spilled into filter syntax.
    const emitted = escapeFilterArgValue("Constantinople's main avenue")
    const { rest } = avGetToken(`text=${emitted}:fontcolor=white`, '[],;')
    assert.equal(rest, '', 'the value leaked a filtergraph terminator')
    assert.equal(unescapeBothLevels(emitted), "Constantinople's main avenue")
  })

  test('keeps a literal newline, which quoting could never express', () => {
    const emitted = escapeFilterArgValue('Title\nSubtitle')
    assert.ok(emitted.includes('\n'), 'newline must stay literal, not become a \\n escape')
    assert.equal(unescapeBothLevels(emitted), 'Title\nSubtitle')
  })

  test('leaves ordinary text untouched', () => {
    assert.equal(escapeFilterArgValue('Constantinople 542'), 'Constantinople 542')
  })
})

// ── Real-binary verification ────────────────────────────────────────────

function findDrawtextFfmpeg(): string | null {
  const candidates = [
    path.join(REPO_ROOT, 'bundled', 'ffmpeg', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]
  for (const bin of candidates) {
    if (!existsSync(bin)) continue
    try {
      const out = execFileSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 20000 })
      if (/^\s*\S+\s+drawtext\s/m.test(out)) return bin
    } catch { /* try the next candidate */ }
  }
  return null
}

const FFMPEG = findDrawtextFfmpeg()

function cue(overrides: Partial<ContextualCue>): ContextualCue {
  return {
    id: 'cue-1', scene_id: 'scene-1', start_sec: 10, end_sec: 13.5,
    title: 'Constantinople', subtitle: '541 AD', kind: 'location_date',
    placement: 'top-right', template: 'documentary-label',
    entrance: 'fade', exit: 'dissolve', status: 'approved',
    created_at: '', updated_at: '',
    ...overrides,
  } as ContextualCue
}

/** Parse-and-render one chained graph exactly the way video.ts assembles it. */
async function renderGraph(filters: string[]): Promise<void> {
  let label = '[0:v]'
  const parts = filters.map((f, i) => {
    const next = `[c${i}]`
    const chain = `${label}${f}${next}`
    label = next
    return chain
  })
  await run(FFMPEG!, [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=0.1',
    '-filter_complex', `${parts.join(';')};${label}null[vout]`,
    '-map', '[vout]', '-frames:v', '1', '-f', 'null', '-',
  ])
}

describe('contextual cue filters accepted by the real FFmpeg parser', { skip: FFMPEG ? false : 'no drawtext-capable ffmpeg found (run `npm run fetch:ffmpeg`)' }, () => {
  for (const [name, text] of Object.entries(HOSTILE_TEXT)) {
    const [title, subtitle] = text.split('\n')
    for (const template of ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'] as const) {
      test(`${template} · ${name}`, async () => {
        await renderGraph(buildContextualCueDrawtextFilters(
          cue({ template, title: title!, subtitle: subtitle ?? '' }),
        ))
      })
    }
  }

  test('slide transitions keep valid x/alpha expressions', async () => {
    await renderGraph(buildContextualCueDrawtextFilters(
      cue({ template: 'map-pin', entrance: 'slide', exit: 'slide', placement: 'bottom-left', title: "Rome's edge", subtitle: 'AD 410' }),
    ))
  })

  test('the ten approved EP0067 cues render as one chained graph', async () => {
    // The exact shape that failed in production: many cues, each with a
    // subtitle, two of them carrying apostrophes, all chained into one graph.
    const approved = [
      ['Constantinople, 542', 'The Plague arrives', 'map-pin'],
      ['Procopius', 'Imperial secretary and historian', 'archival-caption'],
      ['Emperor Justinian', 'Ruled 527–565', 'archival-caption'],
      ['Novel 122', 'Early state-ordered quarantine', 'documentary-label'],
      ['Harbor gates shut', 'Constantinople, 542', 'documentary-label'],
      ['The Mese', "Constantinople's main avenue", 'map-pin'],
      ['Constantinople, 541', 'Before the plague', 'map-pin'],
      ['Theodosian Walls', 'Built 5th century', 'documentary-label'],
      ['Port of Neorion', "Constantinople's grain port", 'map-pin'],
      ['Constantinople, 541 AD', 'Daily life along the Mese', 'map-pin'],
    ] as const
    const filters = approved.flatMap(([title, subtitle, template], i) =>
      buildContextualCueDrawtextFilters(cue({
        id: `cue-${i}`, title, subtitle,
        template: template as ContextualCue['template'],
        start_sec: i * 10, end_sec: i * 10 + 4,
      })),
    )
    assert.equal(filters.length, 15, 'map-pin contributes a pin plus a label')
    await renderGraph(filters)
  })
})

// ── Subtitle burn-in paths ──────────────────────────────────────────────
//
// Same defect as the cues, one call site over: `subtitles=filename=` and
// `ass=filename=` quoted the path and escaped only backslash and colon. An
// episode folder carrying an apostrophe — the channel names episodes after
// their subject, so "Rome's Fall" is ordinary — closed the quoted run early
// and took the whole graph down, dropping burned-in subtitles into the
// no-effects recovery tier.

const HOSTILE_DIRS = [
  "EP0068 - Rome's Fall",
  'EP0069 - Chapter 1, Revisited',
  "EP0070 - What's [Left]; After",
]

describe('escapeFilterPath', () => {
  test('normalises Windows separators before escaping', () => {
    const win = 'C:\\Users\\kh\\subs.srt'
    assert.equal(escapeFilterPath(win), escapeFilterArgValue('C:/Users/kh/subs.srt'))
    // FFmpeg must receive forward slashes; the drive-letter colon is still
    // escaped (which is itself a backslash, so only the separators are checked).
    assert.equal(unescapeBothLevels(escapeFilterPath(win)), 'C:/Users/kh/subs.srt')
  })

  test('a path survives both unescaping passes', () => {
    for (const dir of HOSTILE_DIRS) {
      const p = `/Story Studio Projects/Boundful/${dir}/subs.srt`
      assert.equal(unescapeBothLevels(`${escapeFilterPath(p)}:original_size=1920x1080`), p, `round trip failed for: ${dir}`)
    }
  })

  test('an apostrophe in the path cannot terminate the value early', () => {
    const emitted = escapeFilterPath("/eps/EP0068 - Rome's Fall/subs.srt")
    const { rest } = avGetToken(`filename=${emitted}:original_size=1920x1080`, '[],;')
    assert.equal(rest, '', 'the path leaked a filtergraph terminator')
  })
})

describe('subtitle burn-in accepted by the real FFmpeg parser', { skip: FFMPEG ? false : 'no ffmpeg found (run `npm run fetch:ffmpeg`)' }, () => {
  const SRT = '1\n00:00:00,000 --> 00:00:01,000\nBurned in\n\n'

  for (const dir of HOSTILE_DIRS) {
    test(`subtitles=filename= under ${JSON.stringify(dir)}`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'ssk-subpath-'))
      try {
        const epDir = path.join(root, dir)
        mkdirSync(epDir, { recursive: true })
        const srt = path.join(epDir, 'subs.srt')
        writeFileSync(srt, SRT, 'utf8')
        // The exact shape video.ts emits, force_style clause included.
        const style = 'FontName=Helvetica,FontSize=21,Alignment=2'
        await run(FFMPEG!, [
          '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=0.1',
          '-filter_complex',
          `[0:v]subtitles=filename=${escapeFilterPath(srt)}:original_size=1920x1080:force_style='${style}'[vout]`,
          '-map', '[vout]', '-frames:v', '1', '-f', 'null', '-',
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test(`ass=filename= under ${JSON.stringify(dir)}`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'ssk-asspath-'))
      try {
        const epDir = path.join(root, dir)
        mkdirSync(epDir, { recursive: true })
        const assPath = path.join(epDir, 'subs.ass')
        writeFileSync(assPath, [
          '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 384', 'PlayResY: 288', '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, Alignment, MarginL, MarginR, MarginV, Encoding',
          'Style: Default,Helvetica,21,&H00FFFFFF&,2,10,10,10,1', '',
          '[Events]',
          'Format: Layer, Start, End, Style, Text',
          'Dialogue: 0,0:00:00.00,0:00:01.00,Default,Burned in',
        ].join('\n'), 'utf8')
        await run(FFMPEG!, [
          '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=0.1',
          '-filter_complex', `[0:v]ass=filename=${escapeFilterPath(assPath)}[vout]`,
          '-map', '[vout]', '-frames:v', '1', '-f', 'null', '-',
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
