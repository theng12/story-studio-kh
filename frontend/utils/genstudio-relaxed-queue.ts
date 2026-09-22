/**
 * The relaxed shelf, as a picker renders it.
 *
 * GenStudio sells some language products twice: once on the direct queue and
 * once, cheaper, on a slower one. `queue_class` is the ONLY thing that decides
 * which shelf a row belongs on. The words "(Relaxed Queue)" that appear inside
 * some display names are copy the owner edits in Studio Control, so a picker
 * that grouped by searching for the phrase would regroup itself, silently and
 * on live, the next time he reworded a product.
 *
 * Everything the section says about the offer is GenStudio's. There is no
 * percentage, no dollar figure and no sentence about the offer anywhere in
 * this app — not as a default, not as a fallback, not as a constant. A hint
 * GenStudio does not send is a hint that is not shown, and a catalogue that
 * predates the field is one undivided list exactly as it has always been.
 */

/** Section heading for the relaxed shelf. The only string here that is ours. */
export const RELAXED_QUEUE_GROUP_LABEL = 'Relaxed Queue'

export interface RelaxedQueueHint {
  discount_percent: number
  unlock_threshold_cents: number
  message: string
}

/** Any catalogue row a language picker draws, from any of the three routes. */
export interface QueueClassedModel {
  queue_class?: 'direct' | 'relaxed' | null
  relaxed_queue_hint?: RelaxedQueueHint | null
}

/**
 * True only for a row GenStudio has explicitly put on the relaxed shelf.
 *
 * An absent or unrecognised `queue_class` is `direct`. That is not a lenient
 * default — it is the truth for every product that predates the field, and for
 * every GenStudio release that has never published it.
 */
export function isRelaxedQueue(model: QueueClassedModel | null | undefined): boolean {
  return model?.queue_class === 'relaxed'
}

/** Which section heading this row sits under. `direct` keeps whatever heading
 *  the picker already used, so an all-direct catalogue is unchanged. */
export function queueClassGroupLabel(
  model: QueueClassedModel | null | undefined,
  directLabel: string,
): string {
  return isRelaxedQueue(model) ? RELAXED_QUEUE_GROUP_LABEL : directLabel
}

function moneyFromCents(cents: number): string {
  const dollars = cents / 100
  // model-drift-allow: this renders GenStudio's own published cents figure, never a Story-owned rate
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * The one line shown under the "Relaxed Queue" heading, or '' when there is
 * nothing GenStudio has said to show.
 *
 * The two numbers are printed beside the sentence, never interpolated into it.
 * GenStudio's own note explains why: `message` is written to contain neither
 * figure, because the owner may reword it into a shape where they no longer
 * fit — and a client that had spliced them in would then be showing a sentence
 * he never wrote. Cents become dollars here because dollars are how he says it;
 * the amount itself is GenStudio's.
 */
export function describeRelaxedQueueHint(hint: RelaxedQueueHint | null | undefined): string {
  if (!hint) return ''
  const message = hint.message?.trim()
  if (!message) return ''
  if (!Number.isFinite(hint.discount_percent) || !Number.isFinite(hint.unlock_threshold_cents)) return ''
  const percent = hint.discount_percent.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
  return `Discount ${percent}% · Unlocks at ${moneyFromCents(hint.unlock_threshold_cents)} — ${message}`
}

/** One already-built menu row, as far as sectioning is concerned. */
export interface SectionedMenuOption {
  group?: string
  provider?: string
  groupNote?: string
}

export interface MenuSection<T> {
  label: string
  items: T[]
  /** Shown once under the heading. '' when the rows carry no note. */
  note: string
}

/**
 * Split menu rows into their sections, with the relaxed shelf always last.
 *
 * Two rules, and nothing else:
 *
 *   • The relaxed section comes after every other section, whatever order the
 *     rows arrived in and whatever a search query has just filtered away. It
 *     is the cheaper, slower alternative to the catalogue above it, and a
 *     section that moved depending on which row happened to be first in the
 *     response would not read as one. The sort is stable, so every other
 *     section keeps the order the rows built it in.
 *   • A section's note is the FIRST non-empty one its rows carry, shown once.
 *     GenStudio sends the hint on every relaxed row because `/v1/chat/models`
 *     returns a bare list; repeating those sentences under every model would
 *     turn the only thing a customer needs to read into furniture.
 *
 * Rows with no `group`, no note and no relaxed shelf come back as exactly the
 * sections they always did — which is what a catalogue that has never heard of
 * `queue_class` produces.
 */
export function groupMenuOptions<T extends SectionedMenuOption>(
  options: readonly T[],
): Array<MenuSection<T>> {
  const groups = new Map<string, MenuSection<T>>()
  for (const option of options) {
    const label = option.group || option.provider || 'Models'
    if (!groups.has(label)) groups.set(label, { label, items: [], note: '' })
    const group = groups.get(label)!
    group.items.push(option)
    if (!group.note && option.groupNote) group.note = option.groupNote
  }
  return Array.from(groups.values()).sort(
    (a, b) => Number(a.label === RELAXED_QUEUE_GROUP_LABEL) - Number(b.label === RELAXED_QUEUE_GROUP_LABEL),
  )
}
