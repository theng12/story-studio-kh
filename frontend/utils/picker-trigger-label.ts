/**
 * What a closed picker is allowed to call the thing you picked.
 *
 * ── The rule ──
 *
 * A raw identifier is never a label. Not the model id, not the voice id, not a
 * transport prefix — none of them may reach the screen as the name of a
 * customer's selection, in the trigger's text or in its tooltip.
 *
 * Both pickers used to break this rule the same way, with the same shape of
 * expression: a chain of `??`-style fallbacks whose LAST term was the saved
 * value itself. In the happy path the chain never got that far, so the defect
 * was invisible for as long as the catalogue kept loading. The moment it did not
 * — an unreachable gateway, an expired key, a disk too busy to answer — the
 * chain fell all the way through and the customer was shown something like
 * `gemini-3.1-flash-lite-discount` in the place where the name of their model
 * goes. The model picker had partial machinery for the retirement case and none
 * for this one; the voice picker had nothing at all.
 *
 * The decision lives here rather than inside a `<script setup>` block for one
 * reason: this is a rule about what the app may SAY, and a rule about what an
 * app may say should be exercised with real inputs, including every failure
 * state, rather than inspected as text.
 *
 * ── What this is not ──
 *
 * This governs display only. It has nothing to do with what may be SUBMITTED. A
 * selection the app could not confirm against a live catalogue is still refused
 * at submission time by the server exactly as before — that fence is what stops
 * a customer being charged against a stale price, and nothing here touches it.
 * Saying a truthful sentence about an unconfirmed selection and allowing a
 * generation against one are different questions with different answers.
 */

/** The suffix that admits the app cannot vouch for what it is showing. */
export const UNVERIFIED_SUFFIX = '(unverified — catalog unavailable)'

export interface UnverifiedLabelState {
  /** The saved id. Never rendered. */
  savedId: string
  /** Rows currently in hand. A non-empty catalogue speaks for itself. */
  catalogueSize: number
  /** A read is in flight. Nothing has failed yet, so nothing may be called unverified. */
  loading: boolean
  /** The name this browser remembers for `savedId`, or ''. */
  rememberedName: string
  /** What to call an unremembered selection, e.g. 'Saved model'. */
  unknownNoun: string
}

/**
 * The sentence a picker shows for a selection it could not confirm, or ''.
 *
 * '' means "there is nothing unusual to say" — either nothing is selected, or
 * the catalogue loaded and can answer for itself.
 */
export function unverifiedSelectionLabel(state: UnverifiedLabelState): string {
  const saved = (state.savedId || '').trim()
  if (!saved) return ''
  // A catalogue we could read speaks for itself: the row is either present (the
  // picker shows its published name) or genuinely gone (which is a different
  // message, because retirement and unreachability are different facts).
  if (state.catalogueSize > 0) return ''
  const remembered = (state.rememberedName || '').trim()
  // Mid-flight nothing has failed. Show the remembered name plainly, or nothing
  // and let the caller fall back to its loading word.
  if (state.loading) return remembered
  return remembered
    ? `${remembered} ${UNVERIFIED_SUFFIX}`
    : `${state.unknownNoun} ${UNVERIFIED_SUFFIX}`
}

export interface TriggerLabelState {
  /** The published name of the matched catalogue row, or ''. */
  selectedLabel?: string
  /** The owner's word for a selection known to be retired, or ''. */
  missingLabel?: string
  /** The sentence from `unverifiedSelectionLabel`, or ''. */
  unverifiedLabel?: string
  loading?: boolean
  loadingLabel?: string
  placeholder?: string
}

/**
 * The headline on a closed picker.
 *
 * Every branch returns something a person can read. There is deliberately no
 * branch that returns an identifier — that absence is the fix, and it is what
 * the guard test pins.
 */
export function pickerTriggerLabel(state: TriggerLabelState): string {
  if (state.selectedLabel) return state.selectedLabel
  if (state.missingLabel) return state.missingLabel
  if (state.unverifiedLabel) return state.unverifiedLabel
  return (state.loading ? state.loadingLabel : state.placeholder) || ''
}
