/**
 * One vocabulary for "this model is going away".
 *
 * GenStudio records a retirement schedule for every product it sells and
 * publishes the whole thing on each row of the chat catalogue: whether the
 * warning window is open, when it opened, its internal target date, the date
 * the product stops being available to customers, and the id of the successor
 * it recorded. Story Studio read none of it.
 *
 * The consequence was not that the app said nothing — it was that the app could
 * only speak AFTERWARDS. The picker's existing message ("… is retired or
 * unavailable. Choose a replacement") fires when a saved model has already
 * stopped working, which is the one moment when a warning is worth nothing. A
 * countdown that had been running on the server for weeks reached nobody.
 *
 * WHAT THIS SAYS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It says two things: the date the model stops being available, and how far
 * away that is. The second is not decoration — a bare date makes the reader do
 * the arithmetic, and a reader who does not bother has learned nothing.
 *
 * It says NOTHING about what to switch to, even though GenStudio publishes a
 * `replacement_model_id` and the transport layer carries it. That is a
 * deliberate position, not an omission: the picker's own message already
 * promises "Story Studio will not switch products automatically", and steering
 * the customer toward one named successor would quietly break that promise. The
 * customer picks the next model; this module's whole job is to make sure they
 * are picking it before the deadline rather than after it.
 *
 * Two rules hold the rest of it together:
 *
 *   1. Story Studio decides NOTHING about a retirement. Not the date, not when
 *      the warning starts. Every value here is read from the payload; the only
 *      thing computed locally is the arithmetic between a published instant and
 *      now, which is exactly the arithmetic we are sparing the reader.
 *
 *   2. Dates are read and rendered in UTC. GenStudio publishes an instant;
 *      rendering it in the reader's local zone can move it onto the previous or
 *      the following calendar day, and a withdrawal date that is a day out is
 *      worse than no date at all.
 */

const DAY_MS = 86_400_000

/**
 * The subset of a catalogue row this module reads.
 *
 * `replacement_model_id` is absent on purpose. The field is carried through the
 * client and the `/api/models` whitelist — dropping it at the transport layer
 * would be a separate decision, and a future change of mind should not need a
 * plumbing change — but no display reads it, and this type is the boundary that
 * makes that visible rather than accidental.
 */
export interface RetirementFields {
  label?: string
  deprecation_warning?: boolean
  retires_at?: string | null
}

/** A published instant, or null when GenStudio published nothing usable. */
function publishedInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value.trim())
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The date GenStudio published, written out as a calendar day.
 *
 * Fixed to `en-GB` and UTC rather than the reader's locale, because this string
 * is the same date GenStudio states elsewhere and the two must agree. A
 * locale-shifted rendering of the same instant is a different date.
 */
export function formatRetirementDate(instant: number): string {
  return new Date(instant).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

/**
 * How far away that is, in the plainest unit that is still exact.
 *
 * Whole days throughout, never "about two months": a rounded figure invites the
 * reader to plan against it, and the rounding would be ours, not GenStudio's.
 * Days are counted between calendar days in UTC so the answer does not change
 * when the reader's clock crosses midnight before the published instant does.
 */
export function formatRetirementCountdown(instant: number, now: number): string {
  const dayNumber = (ms: number) => Math.floor(ms / DAY_MS)
  const days = dayNumber(instant) - dayNumber(now)
  if (days > 1) return `${days} days from now`
  if (days === 1) return 'tomorrow'
  if (days === 0) return 'today'
  if (days === -1) return 'yesterday'
  return `${Math.abs(days)} days ago`
}

/**
 * The sentence shown while a retiring model is selected, or '' when the model
 * carries no retirement.
 *
 * Gated on `deprecation_warning`, which is GenStudio's own flag for "the
 * warning window is open". Story Studio does not re-derive that window from the
 * dates: how much notice a customer gets is GenStudio's decision, and a second
 * policy here would disagree with it the first time GenStudio changed its mind.
 *
 * The flag can be open before a withdrawal date exists. That is still worth
 * saying — the flag is a published fact — but the date is not ours to supply,
 * so the sentence says plainly that none has been published rather than
 * inventing one or staying silent.
 */
export function describeModelRetirement(
  selected: RetirementFields | null | undefined,
  now: number = Date.now(),
  { advice = true }: { advice?: boolean } = {},
): string {
  if (!selected || selected.deprecation_warning !== true) return ''
  const name = (selected.label || '').trim() || 'This model'
  const retires = publishedInstant(selected.retires_at)
  if (retires === null) {
    return `${name} is scheduled for retirement. GenStudio has not published the date it stops `
      + `being available yet.${advice ? ' Choose another model before it does.' : ''}`
  }
  const date = formatRetirementDate(retires)
  const countdown = formatRetirementCountdown(retires, now)
  if (retires <= now) return `${name} stopped being available on ${date} — ${countdown}.`
  // `advice` is off when the caller is listing several models at once and will
  // say what to do about all of them once at the end. Repeating "choose another
  // model" after every line turns a two-model warning into a wall the reader
  // skims, which costs exactly the attention the warning exists to buy.
  return `${name} stops being available on ${date} — ${countdown}.`
    + `${advice ? ' Choose another model before then.' : ''}`
}

/**
 * Whether the row should carry a badge in the list.
 *
 * The badge is a signpost, scannable before anything is opened; the sentence
 * above is the actual warning. Same division as the data notice — a badge that
 * tried to carry the whole message would be truncated into uselessness at the
 * first narrow window.
 */
export function isRetiring(model: RetirementFields): boolean {
  return model.deprecation_warning === true
}

/**
 * Every model id a channel has committed to, wherever it was saved.
 *
 * THE PICKER IS NOT WHERE THE DAMAGE LANDS. A channel configured months ago
 * carries its model choice in its own config, and nobody opens the picker again
 * until something breaks — which, for a retirement, is precisely too late. So
 * the same published schedule has to be checked against what the channel
 * already chose, not only against what someone is choosing right now.
 *
 * The walk is deliberately structural rather than a list of known fields. Story
 * Studio saves a chosen model in at least four shapes: a bare `prompt_model` on
 * the config, a per-page remembered id, `model` inside a saved preset's `data`,
 * and `form.model` one level deeper inside another preset's snapshot — and each
 * generator page invented its own. A hardcoded list of paths would have to be
 * extended by whoever adds the fifth shape, and would therefore be wrong from
 * the first time somebody forgot. Any string under a `model`-shaped key, at any
 * depth, is a model id; matching it against the catalogue is what decides
 * whether it means anything.
 *
 * Ids that belong to another catalogue (an image or voice product) simply match
 * no chat row and fall out. That is the check doing its job, not a gap.
 */
const MODEL_FIELD = /(?:^|_)models?(?:_id)?$/i
const MAX_WALK_DEPTH = 8

export function collectConfiguredModelIds(config: unknown, depth = 0): string[] {
  if (depth > MAX_WALK_DEPTH || !config || typeof config !== 'object') return []
  const found: string[] = []
  if (Array.isArray(config)) {
    for (const item of config) found.push(...collectConfiguredModelIds(item, depth + 1))
    return found
  }
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (MODEL_FIELD.test(key) && value.trim()) found.push(value.trim())
    } else {
      found.push(...collectConfiguredModelIds(value, depth + 1))
    }
  }
  return found
}

/** A catalogue row as the channel check needs to see it. */
export interface ChannelCatalogRow extends RetirementFields {
  id: string
  label?: string
  legacy_ids?: string[]
}

/**
 * The retiring models this channel is already committed to, each with the same
 * sentence the picker shows.
 *
 * Deduplicated by catalogue row, because one model is typically saved in
 * several places at once and a channel does not have three problems when three
 * stages point at the same product. Ordered by how soon each one goes, so the
 * most urgent is read first — an unscheduled one sorts last, since it has no
 * deadline to be late for.
 */
export function retiringConfiguredModels(
  config: unknown,
  catalog: readonly ChannelCatalogRow[],
  now: number = Date.now(),
): Array<{ id: string, label: string, notice: string }> {
  const wanted = new Set(collectConfiguredModelIds(config))
  if (!wanted.size) return []
  const hits = catalog.filter(row => (
    isRetiring(row) && (wanted.has(row.id) || (row.legacy_ids || []).some(alias => wanted.has(alias)))
  ))
  return hits
    .map(row => ({
      id: row.id,
      // Never `row.id` as a fallback. This label is the notification's title,
      // and the one rule this module does not bend is that a catalogue id is
      // an internal handle and does not go in front of a customer. An unnamed
      // row reads the same way the sentence does.
      label: (row.label || '').trim() || 'This model',
      notice: describeModelRetirement(row, now, { advice: false }),
      // Sorted on the published instant, never on the rendered sentence.
      at: publishedInstant(row.retires_at) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.at - b.at)
    .map(({ id, label, notice }) => ({ id, label, notice }))
}
