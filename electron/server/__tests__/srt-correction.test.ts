/**
 * Corrected-SRT pass (v1.0.797+) — ASR timings, script words.
 *
 * Guards the EP0067 defect: Whisper re-spelled proper nouns out of narration
 * we wrote ourselves (`Neorion` → `Mirion` reached four real image prompts and
 * an on-screen contextual cue) and hallucinated 221 words into a 260ms gap.
 *
 * The MOST IMPORTANT test here is the refusal one. Rewriting cues from the
 * script is only safe while the audio still says the script; if it does not,
 * this pass would write confidently WRONG words onto the screen — worse than
 * the ASR errors it replaces. `refuses` covers wholesale divergence, a small
 * contiguous edit, and speech the script no longer contains.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

let mod: typeof import('../services/subtitle-correction.js')
let core: typeof import('../lib/srt-correction.js')
let selection: typeof import('../lib/subtitle-selection.js')
let tmp: string
let caseId = 0

before(async () => {
  mod = await import('../services/subtitle-correction.js')
  core = await import('../lib/srt-correction.js')
  selection = await import('../lib/subtitle-selection.js')
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'srt-correct-'))
})
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

const CODE = 'EP0001'

/** ~180 words of chapter-shaped narration, so mismatch RATES land in the same
 *  range a real chapter produces (EP0067's chapters run 16–30 cues each). */
const BODY_A = [
  'In the spring of five hundred and forty two the plague reached Constantinople.',
  'It arrived by sea carried in the holds of grain ships from Egypt and it moved',
  'through the city faster than rumor. The emperor Justinian himself fell ill.',
  'He recovered but he did not forget what he had seen from his palace windows.',
  'By the following year with the city still reeling he issued a law that is known',
  'to historians as one of the earliest state ordered quarantines on record.',
  'The law mandated that anyone showing signs of plague be isolated from the healthy.',
  'Their homes were to be sealed and their property was to be confiscated by the state.',
  'The sick did not simply lose their freedom. They lost everything they owned.',
  'The physical scene in the city that year was one of closing and of emptying.',
  'Harbor gates were shut and ships arriving from infected ports were turned away,',
  'sometimes before they could dock at all. Along the main avenue of the capital',
  'the long colonnades stood empty and the great public baths closed their doors.',
  'The churches kept their doors open but the congregations shrank to a handful.',
  'The order was harsh and it was unevenly applied but it was still a beginning.',
  'For the first time an emperor had tried to fight a pandemic with law alone.',
].join(' ')

interface Cue { start: number; end: number; text: string }

function srtOf(cues: Cue[]): string {
  const stamp = (s: number) => {
    const ms = Math.round(s * 1000)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`
  }
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n')
}

/** Build an episode fixture: one stitched SRT + sidecar + per-chapter scripts. */
async function makeEpisode(chapters: Array<{ cues: Cue[]; script: string }>) {
  const dir = path.join(tmp, `case-${++caseId}`)
  const subs = path.join(dir, 'subs')
  const script = path.join(dir, 'script')
  await fs.mkdir(subs, { recursive: true })
  await fs.mkdir(script, { recursive: true })

  const all: Cue[] = []
  const sections = chapters.map((ch, i) => {
    all.push(...ch.cues)
    return {
      slug: `Chapter_${String(i + 1).padStart(2, '0')}`,
      source_srt: `${CODE}_Chapter_${String(i + 1).padStart(2, '0')}.srt`,
      offset_sec: 0,
      duration_sec: 600,
      cues_added: ch.cues.length,
    }
  })
  const stitched = path.join(subs, `${CODE}_stitched.srt`)
  await fs.writeFile(stitched, srtOf(all), 'utf-8')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    srt: `${CODE}_stitched.srt`, schema_version: 1, complete: true, missing_sections: [], sections,
  }), 'utf-8')

  for (let i = 0; i < chapters.length; i++) {
    const n = String(i + 1).padStart(2, '0')
    await fs.writeFile(
      path.join(script, `${CODE}_Chapter_${n}.md`),
      `## Chapter ${n}: Fixture\n\n${chapters[i]!.script}\n`,
      'utf-8',
    )
  }
  return { subtitles_dir: subs, script_dir: script, episode_code: CODE, stitched }
}

/** Parse an SRT back into {stamp,text} pairs for assertions. */
async function readCues(file: string): Promise<Array<{ stamp: string; text: string }>> {
  const raw = await fs.readFile(file, 'utf-8')
  const out: Array<{ stamp: string; text: string }> = []
  for (const block of raw.split(/\n\n+/).map(b => b.trim()).filter(Boolean)) {
    const lines = block.split('\n')
    const i = /^\d+$/.test(lines[0]!.trim()) ? 1 : 0
    out.push({ stamp: lines[i]!.trim(), text: lines.slice(i + 1).join(' ').trim() })
  }
  return out
}

// ── The happy path ─────────────────────────────────────────────────────────

describe('corrected SRT — ASR timings, script words', () => {
  test('a known ASR error is corrected to the script word, with the timestamp untouched', async () => {
    const ep = await makeEpisode([{
      cues: [
        { start: 0, end: 4, text: 'The great wharves at Mirion, normally thick with sailors,' },
        { start: 4, end: 8.25, text: 'fell silent. Bocopius records that the streets became quiet.' },
      ],
      script: 'The great wharves at Neorion, normally thick with sailors, fell silent. '
        + 'Procopius records that the streets became quiet.',
    }])

    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.written, true)
    assert.equal(report.chapters_corrected, 1)
    assert.equal(report.chapters_refused, 0)

    const cues = await readCues(report.path!)
    assert.match(cues[0]!.text, /Neorion/)
    assert.doesNotMatch(cues[0]!.text, /Mirion/)
    assert.match(cues[1]!.text, /Procopius/)
    assert.doesNotMatch(cues[1]!.text, /Bocopius/)

    // Timings are the contract — they must survive byte-for-byte.
    assert.equal(cues[0]!.stamp, '00:00:00,000 --> 00:00:04,000')
    assert.equal(cues[1]!.stamp, '00:00:04,000 --> 00:00:08,250')
  })

  test('the original stitched file is left on disk, unmodified, as evidence', async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
      script: 'The wharves at Neorion fell silent.',
    }])
    const beforeBytes = await fs.readFile(ep.stitched, 'utf-8')
    await mod.buildCorrectedTranscript(ep)
    assert.equal(await fs.readFile(ep.stitched, 'utf-8'), beforeBytes)
    assert.match(beforeBytes, /Mirion/)
  })

  test('a hallucinated cue is dropped — no separate heuristic, it simply has no script counterpart', async () => {
    // 221 words in 260ms: EP0067's real final cue, at 850 words/second.
    const hallucination = `So we left ${'intell '.repeat(218)}in`.trim()
    const ep = await makeEpisode([{
      cues: [
        { start: 0, end: 4, text: 'The law could hold a person in place,' },
        { start: 4, end: 8, text: 'but it could not hold a germ.' },
        { start: 8, end: 8.26, text: hallucination },
      ],
      script: 'The law could hold a person in place, but it could not hold a germ.',
    }])

    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.written, true)
    assert.equal(report.cues_in, 3)
    assert.equal(report.cues_out, 2)
    assert.equal(report.cues_dropped, 1)

    const text = await fs.readFile(report.path!, 'utf-8')
    assert.doesNotMatch(text, /intell/)
    // A fabrication must not be allowed to make the chapter look untrustworthy.
    assert.equal(report.chapters[0]!.accepted, true)
    assert.equal(report.chapters[0]!.trust.fabricated_insertions > 200, true)
    assert.equal(report.chapters[0]!.trust.plausible_insertions, 0)
  })

  test('a few words the ASR dropped are restored from the script', async () => {
    // Realistic proportions: a chapter-sized body with one short dropped
    // phrase. Restoring it is safe precisely because it is a small, isolated
    // gap — a LARGE dropped span is script/audio divergence and is refused by
    // the gate instead (see the refusal suite).
    const body = BODY_A
    const ep = await makeEpisode([{
      cues: [
        { start: 0, end: 30, text: body },
        { start: 30, end: 35, text: 'The baths closed. The churches kept their doors open.' },
      ],
      script: `${body} The baths closed. The churches kept their doors open, but the congregations shrank.`,
    }])
    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.written, true, report.skipped_reason || '')
    const cues = await readCues(report.path!)
    assert.match(cues[1]!.text, /congregations shrank/)
    assert.equal(cues[1]!.stamp, '00:00:30,000 --> 00:00:35,000')
  })

  test("numbers take the script's spoken form", async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 5, text: 'The toll reached 70,000 within 40 days.' }],
      script: 'The toll reached seventy thousand within forty days.',
    }])
    const report = await mod.buildCorrectedTranscript(ep)
    const cues = await readCues(report.path!)
    assert.equal(cues[0]!.text, 'The toll reached seventy thousand within forty days.')
  })
})

// ── The safety gate — the part that matters most ───────────────────────────

describe('corrected SRT — refuses rather than corrupts', () => {
  test('a deliberately mismatched script/audio pair is REFUSED, not corrected', async () => {
    // The audio is EP0067's plague narration; the "script" is a different
    // episode entirely. Alignment would happily emit the wrong text.
    const ep = await makeEpisode([{
      cues: [
        { start: 0, end: 4, text: 'In the spring of 542, the plague reached Constantinople.' },
        { start: 4, end: 8, text: 'It arrived by sea, carried in the holds of grain ships from Egypt.' },
      ],
      script: 'The economics of running a direct-to-consumer clothing brand begin with unit margin. '
        + 'Every shirt carries a landed cost long before anyone clicks buy.',
    }])

    const report = await mod.buildCorrectedTranscript(ep)

    // Nothing may be written: no chapter could be corrected.
    assert.equal(report.written, false)
    assert.equal(report.path, null)
    assert.equal(report.chapters_refused, 1)
    assert.equal(report.chapters_corrected, 0)
    assert.match(report.skipped_reason || '', /agreement check/i)
    assert.equal(await fileExists(mod.correctedSrtPath(ep.subtitles_dir, CODE)), false)

    // And the resolver must hand planning the ORIGINAL, not a corrupted file.
    const resolved = await mod.resolveTranscriptSrt(ep)
    assert.equal(resolved.corrected, false)
    assert.equal(resolved.path, ep.stitched)
  })

  test('a small contiguous script edit is caught by the run gate, which a rate gate alone would miss', async () => {
    // One rewritten clause in an otherwise identical chapter. The mismatch
    // RATE stays low — this is exactly the case a percentage threshold waves
    // through — but the disagreement is contiguous, which ASR noise never is.
    const shared = BODY_A
    const ep = await makeEpisode([{
      cues: [
        { start: 0, end: 40, text: shared },
        { start: 40, end: 46, text: 'The dead were carried out through the gates before the sun rose.' },
      ],
      script: `${shared} Every corpse departed beyond those walls whenever darkness still covered the harbour.`,
    }])

    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.chapters_corrected, 0)
    assert.equal(report.written, false)
    const trust = report.chapters[0]!.trust
    assert.equal(trust.accepted, false)
    assert.match(trust.reason, /consecutive words disagree/)
    assert.equal(
      trust.longest_mismatch_run > core.DEFAULT_CORRECTION_THRESHOLDS.max_mismatch_run,
      true,
      'the edited clause must present as one long contiguous run',
    )
    // The rate alone would NOT have caught this — that is why the run gate exists.
    assert.equal(
      trust.mismatch_rate <= core.DEFAULT_CORRECTION_THRESHOLDS.max_mismatch_rate,
      true,
      'this fixture is only meaningful while its mismatch rate stays under the rate gate',
    )
  })

  test('speech the script no longer contains counts against trust instead of being silently dropped', async () => {
    // The dangerous asymmetry: if a paragraph is deleted from the script after
    // TTS, the audio still speaks it. Those words align to nothing — but they
    // are spoken at a NORMAL rate, so they must not be excused as hallucination
    // and quietly removed from the screen.
    const ep = await makeEpisode([{
      cues: [
        { start: 0, end: 4, text: 'The emperor Justinian himself fell ill.' },
        { start: 4, end: 20, text: 'By five hundred and forty three with the city still reeling he issued a law '
          + 'known to historians as Novel one hundred and twenty two and it is one of the earliest '
          + 'state ordered quarantines anywhere on record at all.' },
      ],
      script: 'The emperor Justinian himself fell ill.',
    }])

    const report = await mod.buildCorrectedTranscript(ep)
    const trust = report.chapters[0]!.trust
    assert.equal(trust.accepted, false, 'unexplained real speech must refuse, not drop')
    assert.equal(trust.plausible_insertions > 20, true)
    assert.equal(trust.fabricated_insertions, 0)
    assert.equal(report.written, false)
  })

  test('a refused chapter keeps its original cues and cannot corrupt its neighbours', async () => {
    const ep = await makeEpisode([
      {
        cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
        script: 'The wharves at Neorion fell silent.',
      },
      {
        cues: [{ start: 10, end: 14, text: 'Along the Mies the colonnades stood empty.' }],
        script: 'Quarterly revenue grew while blended acquisition cost fell across every paid channel.',
      },
      {
        cues: [{ start: 20, end: 24, text: 'At Sicke the dead were lowered from boats.' }],
        script: 'At Sycae the dead were lowered from boats.',
      },
    ])

    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.written, true)
    assert.equal(report.chapters_corrected, 2)
    assert.equal(report.chapters_refused, 1)

    const cues = await readCues(report.path!)
    assert.equal(cues.length, 3)
    // Chapters 1 and 3 corrected…
    assert.match(cues[0]!.text, /Neorion/)
    assert.match(cues[2]!.text, /Sycae/)
    // …chapter 2 passed through verbatim, ASR spelling and all.
    assert.equal(cues[1]!.text, 'Along the Mies the colonnades stood empty.')
    assert.equal(cues[1]!.stamp, '00:00:10,000 --> 00:00:14,000')
    assert.match(report.warnings.join(' '), /Chapter_02/)
  })

  test('a missing script chapter is passed through, never guessed at', async () => {
    const ep = await makeEpisode([
      {
        cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
        script: 'The wharves at Neorion fell silent.',
      },
      {
        cues: [{ start: 10, end: 14, text: 'Along the Mies the colonnades stood empty.' }],
        script: 'unused',
      },
    ])
    await fs.rm(path.join(ep.script_dir, `${CODE}_Chapter_02.md`))

    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.chapters_refused, 1)
    const cues = await readCues(report.path!)
    assert.equal(cues[1]!.text, 'Along the Mies the colonnades stood empty.')
    assert.match(report.warnings.join(' '), /missing/i)
  })

  test('an unreliable chapter sidecar refuses outright rather than guessing boundaries', async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
      script: 'The wharves at Neorion fell silent.',
    }])
    // Claim more cues than the stitched file actually holds.
    const meta = JSON.parse(await fs.readFile(`${ep.stitched}.json`, 'utf-8'))
    meta.sections[0].cues_added = 9
    await fs.writeFile(`${ep.stitched}.json`, JSON.stringify(meta), 'utf-8')

    const report = await mod.buildCorrectedTranscript(ep)
    assert.equal(report.written, false)
    assert.match(report.skipped_reason || '', /chapter boundaries are unreliable/)
  })
})

// ── Resolution + freshness ─────────────────────────────────────────────────

describe('transcript resolution', () => {
  test('planning reads the corrected file when one exists, and the original when it does not', async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
      script: 'The wharves at Neorion fell silent.',
    }])

    const resolved = await mod.resolveTranscriptSrt(ep)
    assert.equal(resolved.corrected, true)
    assert.equal(resolved.path, mod.correctedSrtPath(ep.subtitles_dir, CODE))
    assert.match(await fs.readFile(resolved.path, 'utf-8'), /Neorion/)

    // Remove the script; the next resolution must degrade to the original
    // rather than keep serving a file it can no longer justify.
    await fs.rm(path.join(ep.script_dir, `${CODE}_Chapter_01.md`))
    await fs.writeFile(ep.stitched, await fs.readFile(ep.stitched, 'utf-8'), 'utf-8')
    const again = await mod.resolveTranscriptSrt(ep)
    assert.equal(again.corrected, false)
    assert.equal(again.path, ep.stitched)
  })

  test('re-stitching invalidates the corrected file instead of serving a stale one', async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
      script: 'The wharves at Neorion fell silent.',
    }])
    const first = await mod.resolveTranscriptSrt(ep)
    assert.equal(first.corrected, true)

    // A fresh stitch with different cues.
    await fs.writeFile(ep.stitched, srtOf([
      { start: 0, end: 4, text: 'The wharves at Mirion fell silent.' },
      { start: 4, end: 8, text: 'Bocopius records the quiet.' },
    ]), 'utf-8')
    const meta = JSON.parse(await fs.readFile(`${ep.stitched}.json`, 'utf-8'))
    meta.sections[0].cues_added = 2
    await fs.writeFile(`${ep.stitched}.json`, JSON.stringify(meta), 'utf-8')
    await fs.writeFile(
      path.join(ep.script_dir, `${CODE}_Chapter_01.md`),
      '## Chapter 01: Fixture\n\nThe wharves at Neorion fell silent. Procopius records the quiet.\n',
      'utf-8',
    )

    const second = await mod.resolveTranscriptSrt(ep)
    assert.equal(second.corrected, true)
    const cues = await readCues(second.path)
    assert.equal(cues.length, 2)
    assert.match(cues[1]!.text, /Procopius/)
  })

  test('read-only status selects only a fresh correction and never rebuilds a stale one', async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
      script: 'The wharves at Neorion fell silent.',
    }])
    await mod.resolveTranscriptSrt(ep)
    const fresh = await mod.inspectExistingTranscriptSource(ep.subtitles_dir, CODE)
    assert.equal(fresh.source, 'corrected')
    assert.equal(fresh.planning_source_revalidation_required, false)

    await fs.appendFile(ep.stitched, '\n')
    const correctedBefore = await fs.stat(mod.correctedSrtPath(ep.subtitles_dir, CODE))
    const stale = await mod.inspectExistingTranscriptSource(ep.subtitles_dir, CODE)
    const correctedAfter = await fs.stat(mod.correctedSrtPath(ep.subtitles_dir, CODE))
    assert.equal(stale.source, 'raw')
    assert.equal(stale.planning_source_revalidation_required, true)
    assert.equal(correctedAfter.mtimeMs, correctedBefore.mtimeMs, 'status inspection must not rewrite the correction')
  })

  test('a legacy correction report does not relabel an unmapped chapter as an audio mismatch', () => {
    const lines = mod.describeTranscriptCorrection({
      path: '/tmp/EP0001_stitched.corrected.srt',
      corrected: true,
      report: {
        written: true,
        path: '/tmp/EP0001_stitched.corrected.srt',
        cues_in: 1,
        cues_out: 1,
        cues_dropped: 0,
        cues_rewritten: 0,
        chapters_total: 1,
        chapters_corrected: 0,
        chapters_refused: 1,
        warnings: ['Introduction: no chapter number could be read — its original transcription was kept.'],
        chapters: [{
          slug: 'Introduction',
          script_file: '',
          accepted: false,
          reason: 'no chapter number could be read',
          cues_in: 1,
          cues_out: 1,
          cues_dropped: 0,
          cues_rewritten: 0,
          trust: {
            accepted: false,
            reason: 'no chapter number could be read',
            script_words: 0,
            asr_words: 0,
            substitutions: 0,
            deletions: 0,
            plausible_insertions: 0,
            fabricated_insertions: 0,
            mismatch_words: 0,
            mismatch_rate: 1,
            longest_mismatch_run: 0,
          },
        }],
        samples: [],
      },
    })
    assert.ok(lines.some(line => line.includes('could not be corrected safely')))
    assert.ok(lines.some(line => line.includes('no chapter number could be read')))
    assert.equal(lines.some(line => line.includes('script and the audio did not agree')), false)
  })

  /**
   * v1.4.0 — REVERSED, by the owner's decision on 2026-08-18.
   *
   * This test previously asserted the opposite: that adding the corrected file
   * could not change what gets burned. That was true, and it was the v1.0.797
   * scoping choice — but it meant an episode drew its scene images from the
   * corrected words ("Neorion") while burning Whisper's ("Mirion") across them,
   * because the correction already reaches Scene Plan and the cue generator.
   * One episode, two spellings, and the wrong one on screen.
   *
   * Rewritten rather than deleted so the reversal is visible as a decision. See
   * `services/subtitle-correction.ts` for the full reasoning, including why it
   * was safe to reverse only once the caption preflight existed to show the
   * burned words before the render.
   */
  test('the corrected transcript is what gets burned in', async () => {
    const ep = await makeEpisode([{
      cues: [{ start: 0, end: 4, text: 'The wharves at Mirion fell silent.' }],
      script: 'The wharves at Neorion fell silent.',
    }])
    const before = await selection.resolveBurnSubtitle(ep.subtitles_dir)
    assert.equal(before, ep.stitched, 'with no corrected file, the raw stitch burns')

    await mod.buildCorrectedTranscript(ep)
    const after = await selection.resolveBurnSubtitle(ep.subtitles_dir)
    assert.equal(
      after,
      path.join(ep.subtitles_dir, `${CODE}_stitched.corrected.srt`),
      'the corrected transcript must win over the raw stitch',
    )
    // The words actually change — the point of the reversal.
    assert.match(await fs.readFile(after!, 'utf-8'), /Neorion/)

    // The hand-built burn-in file is NOT swept in. The owner ruled on the
    // corrected transcript; widening that to a file he never mentioned is not
    // licensed by his decision.
    await fs.writeFile(path.join(ep.subtitles_dir, `${CODE}_stitched.burnin.srt`), 'x', 'utf-8')
    assert.equal(await selection.resolveBurnSubtitle(ep.subtitles_dir), after)
  })
})

// ── Alignment core ─────────────────────────────────────────────────────────

describe('word alignment', () => {
  test('classifies a substitution and a deletion', async () => {
    const script = core.tokenizeWords('the wharves at Neorion fell silent today')
    const asr = core.tokenizeWords('the wharves at Mirion fell silent')
    const ops = core.alignWords(script, asr).map(s => s.op)
    assert.equal(ops.filter(o => o === 'substitute').length, 1)   // Neorion → Mirion
    assert.equal(ops.filter(o => o === 'delete').length, 1)       // "today"
    assert.equal(ops.filter(o => o === 'insert').length, 0)
    assert.equal(ops.filter(o => o === 'match').length, 5)
  })

  test('classifies an insertion', async () => {
    const script = core.tokenizeWords('the wharves at Neorion fell silent')
    const asr = core.tokenizeWords('the wharves at Neorion fell utterly silent')
    const ops = core.alignWords(script, asr).map(s => s.op)
    assert.equal(ops.filter(o => o === 'insert').length, 1)       // "utterly"
    assert.equal(ops.filter(o => o === 'substitute').length, 0)
    assert.equal(ops.filter(o => o === 'match').length, 6)
  })

  test('refuses to align beyond the safety cap rather than allocating without bound', async () => {
    const big = core.tokenizeWords(Array(50).fill('word').join(' '))
    assert.throws(() => core.alignWords(big, big, 10), /safety cap/)
  })

  test('an impossibly fast cue is treated as fabrication; normal speech is not', async () => {
    const th = core.DEFAULT_CORRECTION_THRESHOLDS
    // EP0067's real hallucination: 221 words in 260ms.
    assert.equal(core.isFabricatedCue({ index: 1, start_sec: 0, end_sec: 0.26, text: '' }, 221, th), true)
    // EP0067's fastest genuine cue: 7 words in 1.18s (5.9 w/s).
    assert.equal(core.isFabricatedCue({ index: 1, start_sec: 0, end_sec: 1.18, text: '' }, 7, th), false)
    // A clipped one-word cue is not waved through on rate alone.
    assert.equal(core.isFabricatedCue({ index: 1, start_sec: 0, end_sec: 0.04, text: '' }, 1, th), false)
  })
})

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}
