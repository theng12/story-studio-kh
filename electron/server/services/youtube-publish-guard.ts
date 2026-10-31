/**
 * The one publish-date guard.
 *
 * WHY IT EXISTS. Google's YouTube Data API revision history says a `publishAt`
 * in the past is not an error: the video is published immediately, with no
 * complaint (https://developers.google.com/youtube/data/revision_history).
 * So a date that has already gone does not fail loudly — it goes PUBLIC.
 * Story Studio's own package builder used to call that "YouTube will reject
 * it", which was wrong, and the warning only ever reached a job log.
 *
 * A video that goes public at the wrong moment is the worst outcome this
 * product can produce, so the date is checked in the ONE place that decides
 * whether an upload may be queued (`admitYouTubeUpload`), and AGAIN in the
 * generator immediately before the provider call — because a job can sit in
 * the queue for hours, and the date that was safe at admission can be gone by
 * the time the bytes are sent.
 *
 * THE LEAD TIME. Story Studio must never hand YouTube a date that has passed,
 * or one that could pass while the upload is still running: a resumable upload
 * of a long render takes real time, and the moment it completes a publishAt
 * that is already behind it publishes the video at once. Six hours is the
 * single named figure for both readings — a date inside it is refused with the
 * same words a passed date gets, and the auto-scheduler never offers one.
 *
 * WHAT IT DOES NOT DO. It never drops the date, never re-dates it and never
 * lets the upload go through anyway. The owner's choice is refused with the
 * date named, so the choice can be made again.
 */

/**
 * How far ahead of now a publish date must be. One figure, used by every
 * caller, so the admission and the generator cannot disagree about what
 * "soon enough" means.
 */
export const YOUTUBE_PUBLISH_LEAD_TIME_MS = 6 * 60 * 60 * 1000

/**
 * The same figure in the words an owner reads. Derived, not restated: if the
 * lead time ever changes, the sentence changes with it — a limit that is
 * enforced must also be shown, and shown as the number it is.
 */
export const YOUTUBE_PUBLISH_LEAD_TIME_TEXT =
  `${YOUTUBE_PUBLISH_LEAD_TIME_MS / (60 * 60 * 1000)} hours`

export type YouTubePublishDateProblem =
  | 'invalid'
  | 'past'
  | 'too_soon'

export interface YouTubePublishDateVerdict {
  ok: boolean
  /** The date as it was given, for the message. */
  value: string
  /** The parsed instant, or null when the date is not a date at all. */
  at: number | null
  problem?: YouTubePublishDateProblem
}

/**
 * What is wrong with a date, in the provider's own terms — no advice yet, so
 * the same fact can be reported differently at a preview and at a refusal.
 */
export function describeYouTubePublishDateProblem(
  problem: YouTubePublishDateProblem,
  value: string,
): string {
  const when = value.trim() || '(empty)'
  if (problem === 'invalid') return `The publish date "${when}" is not a valid date.`
  if (problem === 'past') {
    return `The publish date "${when}" is in the past — YouTube publishes a video immediately when its publish date has already passed, so it would go public at once instead of on that date.`
  }
  return `The publish date "${when}" is less than ${YOUTUBE_PUBLISH_LEAD_TIME_TEXT} away, so it could pass before the upload finishes.`
}

/**
 * The advice half of the message. It is the same everywhere: pick a later
 * date, or send no date and let the schedule be set in YouTube Studio.
 */
const YOUTUBE_PUBLISH_DATE_ADVICE =
  `Choose a date at least ${YOUTUBE_PUBLISH_LEAD_TIME_TEXT} from now, or upload without a date and set the schedule in YouTube Studio.`

/**
 * The full sentence a REFUSAL reads. It names the date, says what YouTube
 * would do, and says how to repair it — a refusal the owner cannot act on is
 * a mystery (AGENTS.md §8).
 */
export function youTubePublishDateRefusalMessage(
  problem: YouTubePublishDateProblem,
  value: string,
): string {
  return `${describeYouTubePublishDateProblem(problem, value)} ${YOUTUBE_PUBLISH_DATE_ADVICE}`
}

/**
 * `Date.parse` quietly rolls an impossible day forward — 2030-04-31 becomes
 * 1 May, and the owner's "31 April" reaches YouTube as a date they never
 * chose. An ISO date is therefore read as written, not as V8 repairs it.
 * Returns false only for a date-shaped value whose calendar does not exist;
 * anything not shaped like one is left to `Date.parse`.
 */
function impossibleDayInISO(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false // Date.parse already rejects these
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day < 1 || day > lastDay
}

/**
 * Check one publish date against the lead time.
 *
 * `now` is a parameter so a test can pin the instant; it defaults to the
 * current time. A date that is not a date at all is a distinct answer from a
 * date that has passed — §6: "the answer is none" and "I could not work out
 * the answer" must not share a value.
 */
export function checkYouTubePublishDate(
  value: string | null | undefined,
  now: number = Date.now(),
): YouTubePublishDateVerdict {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return { ok: false, value: text, at: null, problem: 'invalid' }
  const at = Date.parse(text)
  if (!Number.isFinite(at) || impossibleDayInISO(text)) {
    return { ok: false, value: text, at: null, problem: 'invalid' }
  }
  if (at <= now) return { ok: false, value: text, at, problem: 'past' }
  if (at - now < YOUTUBE_PUBLISH_LEAD_TIME_MS) {
    return { ok: false, value: text, at, problem: 'too_soon' }
  }
  return { ok: true, value: text, at }
}

/**
 * The check for a caller that has a date and wants the refusal sentence.
 * Returns null when the date may be used.
 */
export function youTubePublishDateRefusal(
  value: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const verdict = checkYouTubePublishDate(value, now)
  return verdict.ok ? null : youTubePublishDateRefusalMessage(verdict.problem!, verdict.value)
}
