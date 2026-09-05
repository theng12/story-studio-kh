/**
 * Where a paged sweep resumes, and when it must not.
 *
 * A provider page token is only meaningful for the channel and the query it
 * was issued under. Resuming one after a reassignment would page through a
 * stranger's list with this project's credentials and file the results as this
 * project's own - the same defect the channel-scoping predicate exists to
 * prevent, arriving through stored state instead of through a filter.
 *
 * So a cursor carries its channel, and a mismatch is DISCARDED with a named
 * reason rather than silently ignored: "we restarted" and "we resumed" are
 * different facts, and the caller reports which happened.
 */

export interface PageCursor {
  /** The channel the token was issued under. */
  channel_id: string
  /** The provider's opaque next-page token. */
  token: string
  /** When the page this token follows was fetched. */
  issued_at: string
}

export type CursorDecision =
  | { resume: true, token: string }
  | { resume: false, reason: 'no_cursor' | 'channel_changed' }

/**
 * Decide whether a stored cursor may be used.
 *
 * Written as a REFUSE predicate: every path that is not an exact channel match
 * returns `resume: false`. There is deliberately no "no channel, so allow it"
 * branch - that is the opt-out shape (tell 8), and this is precisely the kind
 * of function where it would be invisible.
 */
export function cursorDecision(
  cursor: PageCursor | undefined,
  currentChannelId: string | null,
): CursorDecision {
  // An empty token is not a cursor. Resuming on one would restart from the
  // newest batch while REPORTING a resume, so the restart would never appear
  // in `restarted_video_ids` — a silent version of the thing this type exists
  // to make loud.
  if (!cursor || !cursor.token.trim() || currentChannelId === null) {
    return { resume: false, reason: 'no_cursor' }
  }
  if (cursor.channel_id !== currentChannelId) return { resume: false, reason: 'channel_changed' }
  return { resume: true, token: cursor.token }
}

/** The key a cursor is stored under. Scoped by surface so two never collide. */
export const cursorKey = (surface: 'comments', id: string): string => `${surface}:${id}`
