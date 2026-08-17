/**
 * Subtitle text-quality detection — v1.2.2
 *
 * Whisper hallucinates foreign-script text into English narration. Measured
 * across the owner's own 4,032 real subtitle files: 18.7% contain letters from
 * a script the narration was never spoken in, 4.4% contain U+FFFD.
 *
 * The strings marked "real corpus" below are verbatim cues from that library.
 * The false-positive block is the more important half of this file: a rule that
 * flags a normal episode is worse than no rule, because it teaches people to
 * ignore the warning. Every case there is legitimate English-language subtitle
 * text that MUST stay clean, and each one was chosen because it is the kind of
 * thing a naive "flag non-ASCII" rule would wrongly condemn.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBTITLE_QUALITY_RULES,
  MAX_FINDINGS,
  inspectSubtitleText,
  longestRepeatedWordRun,
} from '../lib/subtitle-quality.js'

/** Wrap cue bodies into a minimal valid SRT. */
function srt(...bodies: string[]): string {
  return bodies
    .map((body, i) => {
      const s = String(i).padStart(2, '0')
      const e = String(i + 1).padStart(2, '0')
      return `${i + 1}\n00:00:${s},000 --> 00:00:${e},000\n${body}\n`
    })
    .join('\n')
}

describe('subtitle quality — real corruption from the owner\'s library', () => {
  const corrupted: Array<[string, string, string]> = [
    ['Chinese in English narration', '马 West outside The gust,', 'non_latin_script'],
    ['Hebrew + Cyrillic mixed in', 'ראing the mouth on the ground to the гол spout her', 'non_latin_script'],
    ['Hangul spliced into a word', 'keep 컨ener well, he rebel, but he', 'non_latin_script'],
    ['Japanese kana', 'theでも Double', 'non_latin_script'],
    ['Greek letters', 'That meansεις.', 'non_latin_script'],
    ['Thai', 'I am standing inข King of the Pacific Ocean.', 'non_latin_script'],
    ['Arabic', 'This is the final one, so if I amny, I will be kend politician to عليه', 'non_latin_script'],
    ['undecodable bytes', 'and��GRientos', 'replacement_character'],
    ['undecodable mid-word', 'of the school� or even luck', 'replacement_character'],
  ]

  for (const [name, body, rule] of corrupted) {
    test(`flags ${name}`, () => {
      const report = inspectSubtitleText(srt(body))
      assert.equal(report.clean, false, `expected "${body}" to be flagged`)
      assert.ok(report.rules.includes(rule as never), `expected rule ${rule}, got ${report.rules.join(',')}`)
    })
  }

  test('reports WHERE, not just how many', () => {
    // A count cannot be judged. "#2 · 马 West outside The gust," settles it.
    const report = inspectSubtitleText(srt(
      'The crew hauled the boat across the ice.',
      '马 West outside The gust,',
    ))
    assert.equal(report.affected_cues, 1)
    const finding = report.findings[0]!
    assert.equal(finding.cue, 2, 'the SRT cue number must point at the offending cue')
    assert.equal(finding.text, '马 West outside The gust,', 'the offending text must be shown verbatim')
    assert.equal(typeof finding.start_sec, 'number')
    assert.ok(finding.label.length > 0, 'a finding must carry a human-readable label')
  })

  test('a repetition loop is caught, and short deliberate repetition is not', () => {
    // Real corpus: one file repeats "intell" 218 times. Real corpus also
    // contains "No, no, no, no, no!" and "Tap, tap, tap." as normal narration.
    const loop = inspectSubtitleText(srt(`So we left ${'intell '.repeat(12).trim()}`))
    assert.ok(loop.rules.includes('repeated_word_run'))

    const narration = inspectSubtitleText(srt('No, no, no, no, no!', 'Tap, tap, tap.', 'Click. Click. Click.'))
    assert.equal(narration.clean, true, 'deliberate short repetition is normal speech')
  })
})

describe('subtitle quality — false positives that would discredit the feature', () => {
  /**
   * The rule is non-Latin SCRIPTS, not "non-ASCII". Every string here is
   * legitimate English-language subtitle text. If any of these ever starts
   * flagging, the warning becomes noise and people stop reading it.
   */
  const legitimate: Array<[string, string]> = [
    ['proper nouns with diacritics', 'We stopped at a café and she drove a Škoda.'],
    ['names with diaeresis', 'Zoë and Chloë met Renée at the Café Zoë.'],
    ['loanwords', 'A naïve résumé, a jalapeño, and a soufflé.'],
    ['Turkish / Vietnamese / Croatian Latin', 'CIS gelmiş, Đà Nẵng, and Đorđe were all on the list.'],
    ['Spanish and Portuguese', 'Es fácil. A ação foi cancelada. ¿Dónde está?'],
    ['curly quotes and em dashes', '“It’s fine,” she said — really — and left…'],
    ['music notes', '♪ A soft melody plays ♪'],
    ['emoji', 'The moon rose 🌙 and the crew slept.'],
    ['emoji with variation selectors', 'It was sunny ☀️ and then cold ❄️ all week.'],
    ['NFD-decomposed accents', 'We stopped at a café in Zöés town.'],
    ['NFD Vietnamese double mark', 'The word ế is written with two marks.'],
    ['numbers, currency, percent', 'It was 1914 — or 1915? £40,000; 50% of the crew survived.'],
    ['plain narration', 'The crew hauled the boat across the ice for eleven days.'],
    ['hyphens and apostrophes', "Don't — the half-frozen, wind-bitten crew wouldn't move."],
  ]

  for (const [name, body] of legitimate) {
    test(`does NOT flag ${name}`, () => {
      const report = inspectSubtitleText(srt(body))
      assert.equal(
        report.clean,
        true,
        `"${body}" must not be flagged, but tripped: ${report.rules.join(', ')}`,
      )
    })
  }

  test('a clean multi-cue file produces no findings at all', () => {
    const report = inspectSubtitleText(srt(
      'The Endurance was trapped in the ice for ten months.',
      'Shackleton ordered the crew onto the floe.',
      'They hauled the boats towards open water — and waited.',
      'Every man survived.',
    ))
    assert.equal(report.clean, true)
    assert.equal(report.affected_cues, 0)
    assert.deepEqual(report.findings, [])
    assert.deepEqual(report.rules, [])
    assert.equal(report.cues, 4)
  })
})

describe('subtitle quality — rule boundaries', () => {
  test('repeated-word threshold sits above real narration and below real loops', () => {
    // Measured: 5-in-a-row still catches legitimate "No, no, no, no, no!";
    // at 6 every remaining hit across 4,032 files was genuine corruption.
    assert.equal(longestRepeatedWordRun('no no no no no'), 5)
    assert.equal(inspectSubtitleText(srt('no no no no no')).clean, true)
    assert.equal(inspectSubtitleText(srt('no no no no no no')).clean, false)
  })

  test('repetition ignores punctuation and case, as speech does', () => {
    assert.equal(longestRepeatedWordRun('Gentle, gentle, GENTLE, gentle.'), 4)
  })

  test('control and zero-width characters are caught; tabs and newlines are not', () => {
    assert.ok(inspectSubtitleText(srt('The crew​hauled the boat')).rules.includes('control_character'))
    assert.ok(inspectSubtitleText(srt('The crewhauled the boat')).rules.includes('control_character'))
    assert.equal(inspectSubtitleText('1\n00:00:00,000 --> 00:00:01,000\nThe crew\thauled\n').clean, true)
  })

  test('an orphaned combining mark is caught; a well-attached one is not', () => {
    assert.ok(inspectSubtitleText(srt('The crew hauled ́ the boat')).rules.includes('misplaced_combining_mark'))
    assert.equal(inspectSubtitleText(srt('The café was warm')).clean, true)
  })

  test('every rule declares the flag rate it measured on the real corpus', () => {
    // Shipping a rule without a measured rate is how a rule that flags a third
    // of the library gets shipped by accident.
    for (const rule of SUBTITLE_QUALITY_RULES) {
      assert.match(rule.measured_flag_rate, /^\d+(\.\d+)?%$/, `${rule.id} must declare a measured rate`)
      assert.ok(rule.label.length > 0, `${rule.id} must have a human label`)
    }
    assert.equal(new Set(SUBTITLE_QUALITY_RULES.map(r => r.id)).size, SUBTITLE_QUALITY_RULES.length)
  })
})

describe('subtitle quality — report shape', () => {
  test('findings are capped but the cap is declared', () => {
    // One real file repeats a word 218 times. A person needs enough to judge,
    // not the whole list — but must be told the list was cut.
    const many = Array.from({ length: MAX_FINDINGS + 10 }, () => '马 West outside The gust,')
    const report = inspectSubtitleText(srt(...many))
    assert.equal(report.findings.length, MAX_FINDINGS)
    assert.equal(report.truncated, true)
    assert.equal(report.affected_cues, MAX_FINDINGS + 10, 'the true count is still reported')
  })

  test('an unparseable or empty file is reported as unchecked, not as corrupt', () => {
    // Whether a file is structurally usable is inspectSubtitleCompletion's job.
    // This check is about text, and must not invent a second failure mode.
    for (const raw of ['', 'not an srt at all', '\n\n\n']) {
      const report = inspectSubtitleText(raw)
      assert.equal(report.cues, 0)
      assert.equal(report.clean, true)
    }
  })

  test('never mutates or returns rewritten text', () => {
    // A mangled word is not automatically repairable — nobody knows what was
    // said. The report echoes the original text and nothing else.
    const body = 'and��GRientos'
    const before = srt(body)
    const report = inspectSubtitleText(before)
    assert.equal(report.findings[0]!.text, body, 'the excerpt is the original text, not a cleaned one')
    assert.equal(before, srt(body), 'the input string is untouched')
  })
})
