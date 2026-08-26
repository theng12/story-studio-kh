/**
 * One vocabulary for "how old is this GenStudio figure".
 *
 * Every surface that shows a published GenStudio number — a balance, a price, a
 * character limit — can be showing a copy kept from before a service blip. The
 * server already knows which, and says so; this is the shared wording so the
 * header badge, the catalog settings and the generator pages all mark old data
 * the same way instead of each inventing a phrase.
 */

/** Past this age a copy stops being "old but usable" and stops being shown. */
export const GENSTUDIO_STALE_CEILING_MS = 30 * 60_000

/** Matches the wording the catalog settings page has always used. */
export function formatGenStudioAge(loadedAt: number | null): string {
  if (loadedAt === null) return 'never fetched'
  const minutes = Math.max(0, Math.round((Date.now() - loadedAt) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`
}

/**
 * The unobtrusive marker shown beside a figure that is only on screen because a
 * refresh failed. Empty string when the figure is current, so a template can
 * `v-if` on it and render nothing at all on the happy path.
 */
export function genstudioStaleNote(stale: boolean, loadedAt: number | null): string {
  return stale ? `Last known · ${formatGenStudioAge(loadedAt)}` : ''
}

/**
 * Whether a FAILED refresh should keep showing the figure already on screen.
 *
 * This is the whole difference between "the service blipped" and "the service
 * is gone", and getting it wrong is what made the header announce
 * `GenStudio Unavailable` beside a narration job that was generating fine. A
 * refresh that fails is not evidence the account is unreachable: the server
 * already retried, and already fell back to its own last known copy before it
 * reported failure at all.
 *
 * Two things do end the value's life:
 *   - a scope failure, which is definitive rather than transient — the key can
 *     no longer read this account, so the last balance is not ours to show
 *   - age past the ceiling, after which "last known" stops being informative
 *     and starts being misleading
 */
export function keepStandingAfterFailedRefresh(
  credits: number | null,
  loadedAt: number | null,
  errorCode?: string,
  now: number = Date.now(),
): boolean {
  if (credits === null || loadedAt === null) return false
  if (errorCode === 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE') return false
  return now - loadedAt <= GENSTUDIO_STALE_CEILING_MS
}
