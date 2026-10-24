/**
 * The Sketch Draw closing hold, as Motion Review edits it. The server owns the rule
 * (electron/server/lib/sketch-hold.ts resolves it to frames per scene and clamps every hold to half
 * the scene); this only turns what the customer typed into a setting, or a plain sentence saying
 * what to fix, before anything is sent.
 */
export type SketchHold =
  | { mode: 'off' }
  | { mode: 'auto' }
  | { mode: 'fixed'; seconds: number }
  | { mode: 'range'; min_seconds: number; max_seconds: number }

/** `channel` is not a setting: it clears this episode's own hold so it follows the channel. */
export type HoldChoice = '' | 'channel' | 'off' | 'auto' | 'fixed' | 'range'

/** Input sanity only; matches the server's bound. The server still validates. */
export const HOLD_MAX_SECONDS = 60

export interface HoldDrafts { fixed: string; min: string; max: string }

function seconds(text: string, label: string): { ok: true; value: number } | { ok: false; error: string } {
  const value = text.trim() === '' ? NaN : Number(text)
  if (!Number.isFinite(value) || value <= 0 || value > HOLD_MAX_SECONDS) {
    return { ok: false, error: `Enter ${label} in seconds, more than 0 and at most ${HOLD_MAX_SECONDS}.` }
  }
  return { ok: true, value }
}

/** What to send for a choice: null for "follow the channel", a setting, or the sentence to show. */
export function holdFromDraft(choice: HoldChoice, drafts: HoldDrafts): { ok: true; hold: SketchHold | null } | { ok: false; error: string } {
  switch (choice) {
    case 'channel': return { ok: true, hold: null }
    case 'off': return { ok: true, hold: { mode: 'off' } }
    case 'auto': return { ok: true, hold: { mode: 'auto' } }
    case 'fixed': {
      const fixed = seconds(drafts.fixed, 'the hold')
      if ('error' in fixed) return { ok: false, error: fixed.error }
      return { ok: true, hold: { mode: 'fixed', seconds: fixed.value } }
    }
    case 'range': {
      const min = seconds(drafts.min, 'the shortest hold')
      if ('error' in min) return { ok: false, error: min.error }
      const max = seconds(drafts.max, 'the longest hold')
      if ('error' in max) return { ok: false, error: max.error }
      if (min.value > max.value) return { ok: false, error: 'The shortest hold cannot be longer than the longest hold.' }
      return { ok: true, hold: { mode: 'range', min_seconds: min.value, max_seconds: max.value } }
    }
    default: return { ok: false, error: 'Choose a closing hold.' }
  }
}

/** The words for a setting, used in the select's "Channel default (...)" row and the help line. */
export function holdLabel(hold: SketchHold): string {
  switch (hold.mode) {
    case 'off': return 'no hold'
    case 'auto': return 'auto: follows the clip length'
    case 'fixed': return `${hold.seconds} s hold`
    case 'range': return `${hold.min_seconds}–${hold.max_seconds} s, random per scene`
  }
}

/** Drafts that show a setting in the inputs; a mode with no inputs leaves the usual starting values. */
export function holdDrafts(hold: SketchHold | null): HoldDrafts {
  return {
    fixed: hold?.mode === 'fixed' ? String(hold.seconds) : '2.5',
    min: hold?.mode === 'range' ? String(hold.min_seconds) : '1.5',
    max: hold?.mode === 'range' ? String(hold.max_seconds) : '3',
  }
}
