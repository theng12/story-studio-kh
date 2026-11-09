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

// ── The owner-set channel status label ──────────────────────────────────────
//
// A deliberate choice the owner makes per channel, exactly like the free-text
// `labels` beside it (AGENTS §5: a choice the customer makes elsewhere is the
// owner's to make, never derived from code). It is stored on project.json as
// `channel_status` and read here, because this is the screen that shows it.
//
// ABSENT MEANS "Unclassified" AND IS NEVER INFERRED. A channel nobody has
// labelled is unlabelled: not "Live" because it publishes, not "Paused" because
// it has no schedule, not "Retired" because nothing has shipped in a while.
// Every one of those would be the app deciding for the owner, and a channel
// that has never been asked reads the same as one he deliberately cleared.

/**
 * The five labels. Lower-case ids on the wire and on disk; the display words
 * live in `CHANNEL_STATUS_LABELS` so spelling is decided in one place.
 */
export const CHANNEL_STATUSES = ['live', 'preparing', 'testing', 'paused', 'retired'] as const

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number]

/**
 * The value a channel with no `channel_status` carries — and the value the
 * editor sends to CLEAR one back to that state. It is a real, stored-as-absent
 * answer, not a sixth owner label.
 */
export const UNCLASSIFIED_STATUS = 'unclassified'

export const CHANNEL_STATUS_LABELS: Record<ChannelStatus, string> = {
  live: 'Live',
  preparing: 'Preparing',
  testing: 'Testing',
  paused: 'Paused',
  retired: 'Retired',
}

/**
 * Every option in one list — the editor's options AND the filter chips — so a
 * label the owner can set is exactly a label the page can filter by, and
 * neither list can grow a name the other does not know.
 */
export const CHANNEL_STATUS_OPTIONS: ReadonlyArray<{ value: ChannelStatus | typeof UNCLASSIFIED_STATUS; label: string }> = [
  { value: UNCLASSIFIED_STATUS, label: 'Unclassified' },
  ...CHANNEL_STATUSES.map(status => ({ value: status, label: CHANNEL_STATUS_LABELS[status] })),
]

/** True only for one of the five. Anything else stored is not a label of ours. */
export function isChannelStatus(value: unknown): value is ChannelStatus {
  return typeof value === 'string' && (CHANNEL_STATUSES as readonly string[]).includes(value)
}

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

/**
 * The plan's expected days against the days the channel's releases land on.
 *
 * The two are different facts and they can disagree: a confirmed release can
 * land on a day the plan does not expect. The page then says "nothing placed"
 * for every expected slot and reads as an empty channel, so the disagreement is
 * stated here — as a COUNT of the releases that land on unexpected days.
 *
 * It repairs nothing. No date moves, no plan changes, and a release still
 * covers a slot only on its exact day.
 */
export interface PublishingOverviewCadence {
  /**
   * Confirmed releases inside the expected-slot horizon that land on a day the
   * plan does not expect. Zero means none were counted — not that the plan
   * and the releases agree: there may be no expected slot to compare against.
   */
  off_cadence_count: number
  /** The local weekdays those releases land on (0 = Sunday), sorted and unique. */
  off_cadence_weekdays: number[]
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

export interface PublishingTimelineEpisode {
  id?: string
  episode_code: string
  title: string
  upload_start_at: string | null
  public_release_at: string | null
  date_source: 'confirmed' | 'planned' | 'none'
  stage: 'idea' | 'writing' | 'images' | 'render' | 'final' | 'uploaded' | 'scheduled' | 'public' | 'not_checked'
  state: 'waiting' | 'active' | 'failed' | 'paused' | 'complete' | 'not_checked'
  detail: string
  url: string
  publication_checked_at: string | null
  publication_freshness: PublishingFreshness
  /** Only unchecked artifact stages may be hydrated; read errors and job verdicts must survive. */
  artifacts_pending?: boolean
}

export interface PublishingOverviewChannel {
  slug: string
  name: string
  /**
   * The owner-set status label, or null when there is none ("Unclassified").
   * Read from project.json's `channel_status`; NEVER inferred from the
   * schedule, the readiness sweep, the age of anything, or any other fact on
   * this payload — an absent key and a channel he chose to clear are the same
   * answer, and both are honest.
   */
  channel_status: ChannelStatus | null
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
  /**
   * The plan's expected days against the days the channel's releases land on.
   * Absent on a payload from an older build.
   */
  cadence?: PublishingOverviewCadence

  /** Absent on older payloads means not checked, rather than no episodes. */
  timeline?: { episodes: PublishingTimelineEpisode[]; error?: string }

  confirmed: {
    /** The next confirmed publishAt, or null. */
    next_at: string | null
    count: number
    last_checked_at: string | null
    freshness: PublishingFreshness
    /** `no_channel_assigned` (none chosen) or `channel_not_connected` (chosen, not granted), else a read failure. */
    error?: string
    /**
     * The channel LISTING behind this verdict — a DIFFERENT artifact from a
     * video's observation. A listing can be days old beside a check made an
     * hour ago, so the UI is given both and names the one that is stale
     * instead of hanging the word "stale" on a fresh timestamp.
     *
     * Null when there is no listing to report. Absent on an older payload.
     */
    listing?: {
      /** 'never' = never listed, 'partial' = the last listing stopped early, 'complete' = the whole channel. */
      state: 'never' | 'partial' | 'complete'
      /** When the channel was last listed in full. */
      complete_at: string | null
      /** When the channel was last listed, but the listing stopped early. */
      partial_at: string | null
      /** True when the last COMPLETE listing is past the TTL. */
      stale: boolean
      /** The last attempt, whatever it ended as. */
      last_attempt: { attempted_at: string; outcome: 'complete' | 'partial' | 'failed'; error_code?: string } | null
    } | null
    /**
     * How many known videos are past the observation TTL. Absent on an older
     * payload.
     */
    stale_videos?: number
    /**
     * How many known videos have never been observed. Absent on an older
     * payload.
     */
    unchecked_videos?: number
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
    /**
     * Expected slots in the next 28 days with NO confirmed schedule on them,
     * counted at the channel's OWN cadence — the plan's, walked forward from
     * now. There is no number of ours anywhere in this: a channel with no plan
     * has no cadence to count against, so it is null rather than 0.
     *
     * Null (unknown) whenever the figure could not honestly be computed:
     *   - no usable plan, or a plan that could not be READ;
     *   - confirmed coverage that is unknown (never checked, not connected) or
     *     STALE — a count built on observations past the freshness window would
     *     read as a confident number it is not.
     *
     * A real 0 means every slot in the window is confirmed. Never a zero
     * standing in for any of the above (AGENTS §6).
     */
    missing_slots_4w: number | null
    /**
     * The OLDEST observation behind `confirmed.schedules` — the one that can
     * lie to you, not the newest. Null when no schedule carries a check time.
     *
     * `oldest_checked_stale` marks that observation as past the TTL. The page
     * reads either case as unknown rather than as a confident date, and never
     * renders a zero: "we have not looked lately" and "we have never looked"
     * are both not-a-date, while a fresh one carries its own timestamp.
     */
    oldest_checked_at: string | null
    oldest_checked_stale: boolean
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
