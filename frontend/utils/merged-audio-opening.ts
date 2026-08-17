/**
 * One sentence saying what is in front of the narration in the merged audio.
 *
 * v1.3.2. The owner could see a Merged Audio row on Video Assembly Step 1 and
 * had no way to answer his own question — *"if it already have intro included
 * in the merge audio yet or not"* — without playing the file. The backend now
 * supplies the fact (`ScannedAssets.merged_audio[].opening`); this turns it
 * into the line he reads.
 *
 * The three certainties are deliberately different sentences, because they are
 * different claims:
 *
 *   `stated`   — the merge wrote down what it prepended. Names the file.
 *   `measured` — no record, so the seconds come from the file's own bytes.
 *                Honest about the number, explicit that the cause is unknown.
 *   `unknown`  — not even the seconds could be established. Says so.
 *
 * What none of them ever does is read the current Audio Assembly settings and
 * describe an old file with them. Those settings say what is configured NOW;
 * the file was merged earlier and may have been merged with something else.
 * A confident wrong answer here is worse than no answer, because he would act
 * on it and render.
 */

export interface MergedAudioIntroRecord {
  filename: string
  duration_sec: number | null
  gap_after_sec: number
}

export interface MergedAudioOpening {
  source: 'recorded' | 'measured' | 'unmeasurable'
  lead_in_sec: number | null
  intro: MergedAudioIntroRecord | null
  music_lead_in_sec: number | null
  reason: string | null
}

export interface MergedAudioOpeningLine {
  text: string
  certainty: 'stated' | 'measured' | 'unknown'
  /** True when an intro is definitely present — lets the UI mark the row. */
  hasIntro: boolean
}

function secs(n: number | null | undefined): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '?'
  return `${v.toFixed(1)}s`
}

export function describeMergedAudioOpening(
  opening: MergedAudioOpening | null | undefined,
): MergedAudioOpeningLine | null {
  if (!opening) return null

  if (opening.source === 'unmeasurable') {
    return {
      text: `Can't say what plays before the narration in this file — ${opening.reason || 'the opening could not be measured.'} Re-merging records it.`,
      certainty: 'unknown',
      hasIntro: false,
    }
  }

  const lead = Number(opening.lead_in_sec) || 0

  if (opening.source === 'measured') {
    // A zero-length opening is a complete answer on its own: nothing was
    // prepended, whatever the settings happen to say today.
    if (lead <= 0) {
      return {
        text: 'No intro — the narration starts immediately.',
        certainty: 'measured',
        hasIntro: false,
      }
    }
    return {
      text: `${secs(lead)} plays before the narration starts. This file was merged before Story Studio recorded what it prepends, so it can't say whether that is your intro or a music lead-in — re-merging records it.`,
      certainty: 'measured',
      hasIntro: false,
    }
  }

  // Recorded — the merge wrote down what it did, so name it.
  const music = Number(opening.music_lead_in_sec) || 0
  const intro = opening.intro

  if (!intro && music <= 0) {
    return { text: 'No intro — narration only.', certainty: 'stated', hasIntro: false }
  }

  if (!intro) {
    return {
      text: `No intro file — a ${secs(music)} music lead-in plays first, so the narration starts at ${secs(lead)}.`,
      certainty: 'stated',
      hasIntro: false,
    }
  }

  const introDur = intro.duration_sec === null || intro.duration_sec === undefined
    ? ''
    : ` (${secs(intro.duration_sec)})`
  const gap = Number(intro.gap_after_sec) || 0
  const parts = [`Intro included — ${intro.filename}${introDur}`]
  if (gap > 0) parts.push(`+ ${secs(gap)} gap`)
  if (music > 0) parts.push(`+ ${secs(music)} music lead-in`)
  return {
    text: `${parts.join(' ')}. The narration starts at ${secs(lead)}.`,
    certainty: 'stated',
    hasIntro: true,
  }
}
