/**
 * The global Publishing Overview: one read for every channel at once.
 *
 * It answers a question the app has never been able to answer in one place —
 * *what is actually scheduled to go out across all my channels, and which one
 * needs me next?* — without merging three things that are not the same fact:
 *
 *   CONFIRMED  what YouTube itself reported (`publication-cache`). A private
 *              video with a `publishAt` is a real, provider-held schedule.
 *   PLANNED    what Story Studio *intends* — the channel's cadence slots and
 *              the locally chosen date on an episode. A target, never an ETA,
 *              and never promoted to "confirmed" until YouTube says so.
 *   READINESS  how far an episode is through production (`episodeStepJobStates`
 *              and the same rendered-video check the Upload route admits with).
 *
 * THE COVERAGE RULE (this is the point of the whole screen): a local plan does
 * NOT cover a confirmed gap. A channel with a hundred locally chosen dates and
 * no YouTube-confirmed schedule is at risk, and must read as at risk — its
 * `next_uncovered_slot_at` is the earliest expected slot with no CONFIRMED
 * schedule on it. One video covers at most one slot, and one slot is covered by
 * at most one video, so a day with two videos and two slots is two facts, not
 * four.
 *
 * A zero that means two things is a defect (AGENTS §6): an unreadable store is
 * `unknown`, never `0`; a channel with no cadence says "Publishing plan not set"
 * rather than guessing a rhythm; and a cadence that could not be READ says that
 * instead of claiming there is none (`plan_set: null` + `plan_error`). No field
 * here is a production ETA — none exists in the data, so none is invented.
 */

/**
 * How much to trust a channel's confirmed-schedule figures right now.
 *
 * Deliberately conservative: `fresh` means the channel listing is complete and
 * within the TTL AND every live video was observed and is within the TTL. A
 * partly-unchecked cache, a stale or partial listing, or any stale observation
 * reads as `stale` — never a confident `fresh` from a single newest timestamp.
 */
export type PublishingFreshness = 'fresh' | 'stale' | 'unknown'

export interface PublishingOverviewConfirmedSchedule {
  video_id: string
  episode_code?: string
  title?: string
  /** YouTube's own publishAt for this private video. */
  scheduled_for: string
  /** When videos.list last answered about this video, if ever. */
  checked_at?: string
  /** True when the observation is older than the cache TTL. */
  stale: boolean
}

/** A cadence slot the channel's plan expects, and what actually covers it. */
export interface PublishingOverviewPlannedSlot {
  at: string
  /** A YouTube-confirmed schedule sits on this slot's day. The real coverage. */
  confirmed: boolean
  /** A locally chosen episode date sits on this slot's day. Intent, not coverage. */
  planned: boolean
}

/** A locally chosen episode date — the real "planned" event, with its identity. */
export interface PublishingOverviewAssignment {
  /** The episode this date belongs to, when it is one; absent for import/other keys. */
  episode_code?: string
  /**
   * True when the accepted-episode list could not be READ, so an absent
   * `episode_code` means "unknown", not "this key names no episode". Without it
   * the two would be spelled the same way — the defect AGENTS §6 names.
   */
  identity_unknown?: true
  at: string
  /** True when a YouTube-confirmed schedule sits on this same local day. */
  confirmed: boolean
}

/** A concrete next step for one episode, pointing at an EXISTING supported route. */
export interface PublishingOverviewRecommendation {
  episode_code: string
  /** Finished and not on YouTube (schedule/publish), or accepted with no finished video (generate). */
  kind: 'ready_to_publish' | 'needs_generation'
  label: string
  /** An existing route: the publish page deep-linked at the episode, or the Production Board. */
  url: string
  /** A factual statement about this episode — never an invented stage or ETA. */
  reason: string
}

export interface PublishingOverviewChannel {
  slug: string
  name: string
  /**
   * The assigned YouTube channel, or null before one is chosen OR when the
   * assigned one is not connected (`confirmed.error` says which).
   */
  channel: { channel_id: string; title: string } | null
  /**
   * True when a usable cadence/plan was read, false when the reads succeeded and
   * there is none ("Publishing plan not set"), null when a read FAILED — an
   * unreadable plan is not an absent one, so the UI says it could not be read.
   */
  plan_set: boolean | null
  /** Why the plan could not be read. Present only when `plan_set` is null. */
  plan_error?: string
  plan_name: string | null
  /** The plan's timezone, so the calendar can render slots in the right zone. */
  timezone: string | null

  confirmed: {
    /** The next confirmed publishAt, or null. */
    next_at: string | null
    count: number
    last_checked_at: string | null
    freshness: PublishingFreshness
    /** `no_channel_assigned` (none chosen) or `channel_not_connected` (chosen, not granted), else a read failure. */
    error?: string
    schedules: PublishingOverviewConfirmedSchedule[]
  }

  planned: {
    next_slot_at: string | null
    /**
     * Earliest expected slot with NO confirmed YouTube schedule — the coverage
     * gap. A local plan does not clear it.
     */
    next_uncovered_slot_at: string | null
    /** Earliest expected slot with neither a confirmed schedule nor a local plan. */
    next_unplanned_slot_at: string | null
    last_slot_at: string | null
    slots: PublishingOverviewPlannedSlot[]
    /** Locally chosen episode dates, with identity — the actual planned events. */
    assignments: PublishingOverviewAssignment[]
  }

  coverage: {
    /** Latest day a YouTube-confirmed schedule sits on. Confirmed only, never merged with plans. */
    last_confirmed_date: string | null
    /** Latest locally planned episode date. */
    last_planned_date: string | null
    /** Earliest expected slot with no confirmed schedule (= planned.next_uncovered_slot_at). */
    next_uncovered_slot: string | null
    /** Videos YouTube reports as scheduled (private + publishAt). */
    scheduled_video_count: number
    /**
     * Locally chosen publish dates — every key in the channel's item schedule,
     * INCLUDING import/other keys that name no episode. Not a count of episodes.
     */
    planned_date_count: number
    /**
     * Accepted episodes with a finished video and no YouTube copy yet. Null when
     * unreadable: the whole sweep failed, or any single episode could not be read
     * (`readiness.ready_unknown`) — never a count silently short by the failures.
     */
    ready_video_count: number | null
    /** The very next expected slot has no confirmed schedule — the urgent case. */
    at_risk: boolean
  }

  readiness: {
    /**
     * Every accepted idea, code or not — parity with /projects/:slug/channel-counts.
     * Null when the idea store could not be READ: a corrupt store and an empty
     * one are different answers, and 0 would say them the same way.
     */
    episodes: number | null
    /** The coded subset the per-code figures below are computed over. Null when unreadable. */
    episodes_with_code: number | null
    /**
     * Null when unreadable — the whole sweep failed, any episode could not be
     * read (`ready_unknown`), the episode list itself is unknown, or the
     * YouTube link read failed so "finished AND not already on YouTube" cannot
     * be decided. `error` says which.
     */
    ready_to_publish: number | null
    /** Coded accepted episodes the sweep could not read at all (neither ready nor pending). */
    ready_unknown: number
    on_youtube: number | null
    /** Null when the step-job read failed, or the episode list itself is unknown. */
    in_progress: number | null
    needs_attention: number | null
    /** Why a readiness figure is unknown, when one is. Never a code. */
    error?: string
  }

  /** Why this channel ranks where it does. Never a date the app invented. */
  priority: {
    reason: 'earliest_uncovered_slot' | 'close_to_complete' | 'none'
    at: string | null
    detail?: string
  }

  /**
   * Small, bounded per-episode recommendations: which specific episode to act
   * on and the exact existing route to it. Empty when there is nothing concrete
   * to suggest — the channel-level `next_action` is then the fallback.
   */
  recommendations: PublishingOverviewRecommendation[]

  /**
   * The single next thing to do. Prefers the first recommendation (an exact
   * episode route); otherwise falls back to the Production Board. No new flow,
   * no batch scheduler, no auto-dispatch.
   */
  next_action: {
    kind: 'ready_to_publish' | 'needs_generation' | 'needs_attention' | 'none'
    episode_code: string | null
    label: string
    url: string
  }
}

export interface PublishingOverviewCalendarEntry {
  channel_slug: string
  channel_name: string
  kind: 'confirmed' | 'planned'
  at: string
  episode_code?: string
  video_id?: string
  title?: string
  /**
   * For a locally planned date whose episode identity could not be resolved
   * (the accepted-episode list was unreadable). An absent `episode_code` then
   * means unknown, not "not an episode" — and no episode link may be invented.
   */
  identity_unknown?: true
  /** For planned cadence markers with nothing on them. */
  empty?: boolean
}

export interface PublishingOverviewResponse {
  generated_at: string
  /** The observation TTL these freshness figures were judged against. */
  cache_ttl_ms: number
  /** Channels in priority order: earliest confirmed gap first, then closest to finished. */
  channels: PublishingOverviewChannel[]
  calendar: PublishingOverviewCalendarEntry[]
}
