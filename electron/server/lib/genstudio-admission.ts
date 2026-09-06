export interface GenStudioServiceTier {
  code: string
  display_name: string
  threshold_cents: number
  paid_concurrency_limit: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  max_api_keys: number
}

export interface GenStudioServiceTierStanding {
  current: GenStudioServiceTier
  ladder: GenStudioServiceTier
  floor?: GenStudioServiceTier | null
  overridden: boolean
  lifetime_paid_cents: number
  next_tier: GenStudioServiceTier | null
  cents_to_next_tier: number | null
}

export interface GenStudioAccountCapacity {
  credit_balance?: number
  paid_concurrency_limit: number
  paid_active_jobs: number
  paid_queued_jobs: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  burst_concurrency_ceiling?: number
  service_tier?: GenStudioServiceTierStanding
}

export type GenStudioAdmissionState =
  | 'waiting_local'
  | 'waiting_account_capacity'
  | 'submitting'

export interface GenStudioAdmissionSnapshot extends GenStudioAccountCapacity {
  local_waiting: number
  submitting: number
  available_paid_slots: number
  submissions_in_window: number
  queue_near_capacity: boolean
  submissions_blocked: boolean
  submission_block_reason: string | null
  retry_after_ms: number
  refreshed_at: string | null
  limitSource: 'account-overview' | 'safe-fallback'
  capacity_verified: boolean
}

interface AdmissionWaiter {
  apiKey: string
  work: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
  onState?: (state: GenStudioAdmissionState) => void | Promise<void>
  state?: GenStudioAdmissionState
}

interface CreditHold {
  error: Error
  balance: number | null
}

const WINDOW_MS = 60_000
const DEFAULT_REFRESH_MS = 15_000
const QUEUED_REFRESH_MS = 5_000
const DEFAULT_GLOBAL_FAILURE_RETRY_MS = 60_000
const SAFE_FALLBACK: GenStudioAccountCapacity = {
  paid_concurrency_limit: 1,
  paid_active_jobs: 0,
  paid_queued_jobs: 0,
  max_queued_jobs: 10,
  generation_submissions_per_minute: 5,
}

interface CapacityState {
  capacity: GenStudioAccountCapacity
  limitSource: GenStudioAdmissionSnapshot['limitSource']
  capacityVerified: boolean
  refreshedAt: number
  refreshAfter: number
  refreshPromise: Promise<void> | null
  holdUntil: number
  submitting: number
  submissionTimes: number[]
}

function freshCapacityState(): CapacityState {
  return {
    capacity: { ...SAFE_FALLBACK },
    limitSource: 'safe-fallback',
    capacityVerified: false,
    refreshedAt: 0,
    refreshAfter: 0,
    refreshPromise: null,
    holdUntil: 0,
    submitting: 0,
    submissionTimes: [],
  }
}

function whole(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

function positiveWhole(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : fallback
}

function hasVerifiedCapacity(value: GenStudioAccountCapacity): boolean {
  return typeof value.paid_concurrency_limit === 'number'
    && Number.isInteger(value.paid_concurrency_limit)
    && value.paid_concurrency_limit >= 1
    && typeof value.paid_active_jobs === 'number'
    && Number.isInteger(value.paid_active_jobs)
    && value.paid_active_jobs >= 0
    && typeof value.paid_queued_jobs === 'number'
    && Number.isInteger(value.paid_queued_jobs)
    && value.paid_queued_jobs >= 0
    && typeof value.max_queued_jobs === 'number'
    && Number.isInteger(value.max_queued_jobs)
    && value.max_queued_jobs >= 1
    && typeof value.generation_submissions_per_minute === 'number'
    && Number.isInteger(value.generation_submissions_per_minute)
    && value.generation_submissions_per_minute >= 1
}

function validTier(value: unknown): value is GenStudioServiceTier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tier = value as Record<string, unknown>
  return typeof tier.code === 'string' && !!tier.code.trim()
    && typeof tier.display_name === 'string' && !!tier.display_name.trim()
    && typeof tier.threshold_cents === 'number' && Number.isInteger(tier.threshold_cents) && tier.threshold_cents >= 0
    && typeof tier.paid_concurrency_limit === 'number' && Number.isInteger(tier.paid_concurrency_limit) && tier.paid_concurrency_limit > 0
    && typeof tier.max_queued_jobs === 'number' && Number.isInteger(tier.max_queued_jobs) && tier.max_queued_jobs > 0
    && typeof tier.generation_submissions_per_minute === 'number' && Number.isInteger(tier.generation_submissions_per_minute) && tier.generation_submissions_per_minute > 0
    && typeof tier.max_api_keys === 'number' && Number.isInteger(tier.max_api_keys) && tier.max_api_keys > 0
}

function validTierStanding(value: unknown): value is GenStudioServiceTierStanding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const standing = value as Record<string, unknown>
  return validTier(standing.current) && validTier(standing.ladder)
    && (standing.floor === undefined || standing.floor === null || validTier(standing.floor))
    && typeof standing.overridden === 'boolean'
    && typeof standing.lifetime_paid_cents === 'number' && Number.isInteger(standing.lifetime_paid_cents) && standing.lifetime_paid_cents >= 0
    && (standing.next_tier === null || validTier(standing.next_tier))
    && (standing.cents_to_next_tier === null
      || typeof standing.cents_to_next_tier === 'number'
        && Number.isInteger(standing.cents_to_next_tier)
        && standing.cents_to_next_tier >= 0)
}

function normalizeCapacity(value: GenStudioAccountCapacity): GenStudioAccountCapacity {
  return {
    ...(typeof value.credit_balance === 'number'
      && Number.isInteger(value.credit_balance)
      && value.credit_balance >= 0
      ? { credit_balance: value.credit_balance }
      : {}),
    paid_concurrency_limit: whole(value.paid_concurrency_limit, 1, 1),
    paid_active_jobs: whole(value.paid_active_jobs, 0),
    paid_queued_jobs: whole(value.paid_queued_jobs, 0),
    max_queued_jobs: whole(value.max_queued_jobs, 10, 1),
    generation_submissions_per_minute: positiveWhole(value.generation_submissions_per_minute, 5),
    ...(positiveWhole(value.burst_concurrency_ceiling, 0) > 0
      ? { burst_concurrency_ceiling: value.burst_concurrency_ceiling }
      : {}),
    ...(validTierStanding(value.service_tier) ? { service_tier: value.service_tier } : {}),
  }
}

/**
 * One app-wide admission queue for every GenStudio modality and API key.
 *
 * This queue controls only HTTP generation submissions. Accepted GenStudio
 * jobs release their local slot immediately and continue polling separately;
 * GenStudio remains authoritative for account execution and provider capacity.
 */
export class GenStudioAdmissionPool {
  // Capacity facts are scoped to the API key that proved them. Two keys may
  // belong to different accounts, and a refresh for one must never overwrite
  // the advisory used to stage work for the other.
  private readonly capacityStates = new Map<string, CapacityState>()
  // Submission ordering remains one FIFO queue; each drain picks its first
  // runnable waiter. Capacity gates are per key so an exhausted account cannot
  // throttle an unrelated account's local staging.
  // GenStudio is still the remote admission authority.
  private globalFailure: Error | null = null
  private globalFailureUntil = 0
  private readonly creditBalances = new Map<string, number>()
  private readonly creditHolds = new Map<string, CreditHold>()
  private readonly waiters: AdmissionWaiter[] = []
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private wakeAt = 0

  constructor(
    private readonly loadCapacity: (apiKey: string) => Promise<GenStudioAccountCapacity>,
    private readonly cacheMs = DEFAULT_REFRESH_MS,
    private readonly retryMs = QUEUED_REFRESH_MS,
  ) {}

  snapshot(apiKey: string): GenStudioAdmissionSnapshot {
    const state = this.stateFor(apiKey)
    const now = Date.now()
    this.pruneWindow(state, now)
    return {
      ...state.capacity,
      local_waiting: this.waiters.filter(waiter => waiter.apiKey === apiKey).length,
      submitting: state.submitting,
      available_paid_slots: Math.max(
        0,
        state.capacity.paid_concurrency_limit - state.capacity.paid_active_jobs,
      ),
      submissions_in_window: state.submissionTimes.length,
      queue_near_capacity: this.queueNearCapacity(state),
      submissions_blocked: Boolean(this.globalFailure && this.globalFailureUntil > now),
      submission_block_reason: this.globalFailure?.message || null,
      retry_after_ms: Math.max(0, state.holdUntil - now, this.globalFailureUntil - now),
      refreshed_at: state.refreshedAt ? new Date(state.refreshedAt).toISOString() : null,
      limitSource: state.limitSource,
      capacity_verified: state.capacityVerified,
    }
  }

  async run<T>(
    apiKey: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
    onState?: (state: GenStudioAdmissionState) => void | Promise<void>,
  ): Promise<T> {
    if (signal?.aborted) throw new Error('Cancelled by user')
    await this.refresh(apiKey)
    await this.requireCreditReady(apiKey)
    return new Promise<T>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        apiKey,
        work,
        resolve: value => resolve(value as T),
        reject,
        signal,
        onState,
      }
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Cancelled by user'))
          this.scheduleWake()
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
      void this.setWaiterState(waiter, 'waiting_local')
      this.drain()
    })
  }

  async refreshNow(apiKey: string): Promise<GenStudioAdmissionSnapshot> {
    this.stateFor(apiKey).refreshAfter = 0
    await this.refresh(apiKey)
    return this.snapshot(apiKey)
  }

  async notifyTerminal(apiKey: string): Promise<void> {
    await this.refreshNow(apiKey).catch(() => undefined)
    this.drain()
  }

  async currentDispatchLimit(apiKey: string): Promise<number> {
    await this.refresh(apiKey)
    const state = this.stateFor(apiKey)
    const limit = this.dispatchLimit(state)
    const publishedCeiling = state.capacity.burst_concurrency_ceiling
    return publishedCeiling === undefined ? limit : Math.min(limit, publishedCeiling)
  }

  async noteRateLimit(apiKey: string, retryAfterMs: number): Promise<void> {
    const jitterMs = Math.floor(Math.random() * Math.min(750, Math.max(100, retryAfterMs * 0.1)))
    const state = this.stateFor(apiKey)
    state.holdUntil = Math.max(state.holdUntil, Date.now() + Math.max(0, retryAfterMs) + jitterMs)
    await this.refreshNow(apiKey).catch(() => undefined)
    this.scheduleWake()
  }

  /**
   * Stop every not-yet-submitted request after GenStudio reports an
   * account/release-wide generation gate. Accepted jobs are not represented
   * here and continue polling through their durable GenStudio IDs.
   */
  noteGlobalFailure(
    error: Error,
    retryAfterMs = DEFAULT_GLOBAL_FAILURE_RETRY_MS,
  ): void {
    this.globalFailure = error
    this.globalFailureUntil = Math.max(
      this.globalFailureUntil,
      Date.now() + Math.max(1_000, retryAfterMs),
    )
    const queued = this.waiters.splice(0)
    for (const waiter of queued) this.rejectWaiter(waiter, error)
    this.clearWake()
  }

  /** Any non-gated submission response proves the release gate is open again. */
  noteSubmissionReachable(): void {
    if (!this.globalFailure) return
    this.globalFailure = null
    this.globalFailureUntil = 0
    this.drain()
  }

  /** Reject every not-yet-submitted request for the account that returned 402. */
  noteInsufficientCredits(apiKey: string, error: Error): void {
    this.creditHolds.set(apiKey, {
      error,
      balance: this.creditBalances.get(apiKey) ?? null,
    })
    const blocked = this.waiters.filter(waiter => waiter.apiKey === apiKey)
    for (const waiter of blocked) {
      const index = this.waiters.indexOf(waiter)
      if (index >= 0) this.waiters.splice(index, 1)
      this.rejectWaiter(waiter, error)
    }
    this.scheduleWake()
  }

  private async requireCreditReady(apiKey: string): Promise<void> {
    const hold = this.creditHolds.get(apiKey)
    if (!hold) return
    try {
      const overview = await this.loadCapacity(apiKey)
      const fresh = normalizeCapacity(overview)
      const balance = fresh.credit_balance
      if (balance !== undefined) this.creditBalances.set(apiKey, balance)
      if (hold.balance !== null && balance !== undefined && balance > hold.balance) {
        this.creditHolds.delete(apiKey)
        const state = this.stateFor(apiKey)
        state.capacity = fresh
        state.limitSource = 'account-overview'
        state.capacityVerified = hasVerifiedCapacity(overview)
        state.refreshedAt = Date.now()
        state.refreshAfter = Date.now() + this.cacheMs
        return
      }
    } catch {
      // An unavailable balance cannot prove that the account was replenished.
    }
    throw hold.error
  }

  private async refresh(apiKey: string): Promise<void> {
    const state = this.stateFor(apiKey)
    if (Date.now() < state.refreshAfter) return
    if (state.refreshPromise) return state.refreshPromise
    state.refreshPromise = (async () => {
      try {
        const overview = await this.loadCapacity(apiKey)
        state.capacity = normalizeCapacity(overview)
        if (state.capacity.credit_balance !== undefined) {
          this.creditBalances.set(apiKey, state.capacity.credit_balance)
        }
        state.limitSource = 'account-overview'
        state.capacityVerified = hasVerifiedCapacity(overview)
        state.refreshedAt = Date.now()
        state.refreshAfter = Date.now() + this.cacheMs
      } catch {
        // A missing usage scope or temporary overview failure must fail
        // closed. The accepted job remains GenStudio-owned and recoverable.
        state.capacity = { ...SAFE_FALLBACK }
        state.limitSource = 'safe-fallback'
        state.capacityVerified = false
        state.refreshedAt = Date.now()
        state.refreshAfter = Date.now() + this.retryMs
      }
    })().finally(() => {
      state.refreshPromise = null
      this.drain()
    })
    return state.refreshPromise
  }

  private stateFor(apiKey: string): CapacityState {
    let state = this.capacityStates.get(apiKey)
    if (!state) {
      state = freshCapacityState()
      this.capacityStates.set(apiKey, state)
    }
    return state
  }

  private queueNearCapacity(state: CapacityState): boolean {
    const reserve = Math.max(1, Math.ceil(state.capacity.max_queued_jobs * 0.05))
    return state.capacity.paid_queued_jobs >= state.capacity.max_queued_jobs - reserve
  }

  private pruneWindow(state: CapacityState, now = Date.now()): void {
    while (state.submissionTimes.length && state.submissionTimes[0]! <= now - WINDOW_MS) {
      state.submissionTimes.shift()
    }
  }

  private nextDelay(state: CapacityState, now = Date.now()): number {
    this.pruneWindow(state, now)
    if (state.holdUntil > now) return state.holdUntil - now
    if (state.submissionTimes.length >= state.capacity.generation_submissions_per_minute) {
      return Math.max(25, state.submissionTimes[0]! + WINDOW_MS - now)
    }
    if (this.queueNearCapacity(state)) return this.retryMs
    return 0
  }

  private dispatchLimit(state: CapacityState): number {
    const available = Math.max(
      0,
      state.capacity.paid_concurrency_limit - state.capacity.paid_active_jobs,
    )
    // GenStudio accepts and durably queues valid work. When account execution
    // is full, submit at most one paced request at a time while queue headroom
    // remains; never infer that Story Studio owns the full account.
    return Math.max(1, available)
  }

  private drain(): void {
    if (!this.waiters.length) {
      this.clearWake()
      return
    }
    const now = Date.now()
    if (this.globalFailure && this.globalFailureUntil > now) {
      const blocked = this.waiters.splice(0)
      for (const waiter of blocked) this.rejectWaiter(waiter, this.globalFailure)
      this.clearWake()
      return
    }
    const probingAfterGlobalFailure = Boolean(this.globalFailure)
    let earliestDelay = Number.POSITIVE_INFINITY
    while (this.waiters.length) {
      let selectedIndex = -1
      let selectedState: CapacityState | null = null
      for (let index = 0; index < this.waiters.length; index++) {
        const waiter = this.waiters[index]!
        const creditHold = this.creditHolds.get(waiter.apiKey)
        if (creditHold) {
          this.waiters.splice(index, 1)
          this.rejectWaiter(waiter, creditHold.error)
          index--
          continue
        }
        if (waiter.signal?.aborted) {
          this.waiters.splice(index, 1)
          this.rejectWaiter(waiter, new Error('Cancelled by user'))
          index--
          continue
        }
        const state = this.stateFor(waiter.apiKey)
        const delay = this.nextDelay(state, now)
        if (delay > 0 || state.submitting >= this.dispatchLimit(state)) {
          const waiterState: GenStudioAdmissionState = this.queueNearCapacity(state)
            ? 'waiting_account_capacity'
            : 'waiting_local'
          void this.setWaiterState(waiter, waiterState)
          if (delay > 0) earliestDelay = Math.min(earliestDelay, delay)
          continue
        }
        selectedIndex = index
        selectedState = state
        break
      }
      if (selectedIndex < 0 || !selectedState) break

      const waiter = this.waiters.splice(selectedIndex, 1)[0]!
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort)
      }
      selectedState.submitting += 1
      selectedState.submissionTimes.push(Date.now())
      void this.setWaiterState(waiter, 'submitting')
      void waiter.work().then(
        value => {
          if (probingAfterGlobalFailure) this.noteSubmissionReachable()
          waiter.resolve(value)
        },
        error => waiter.reject(error instanceof Error ? error : new Error(String(error))),
      ).finally(() => {
        selectedState!.submitting = Math.max(0, selectedState!.submitting - 1)
        this.drain()
      })
      if (probingAfterGlobalFailure) break
    }
    if (this.waiters.length) {
      this.scheduleWake(
        Number.isFinite(earliestDelay) ? earliestDelay : this.retryMs,
      )
    }
  }

  private async setWaiterState(
    waiter: AdmissionWaiter,
    state: GenStudioAdmissionState,
  ): Promise<void> {
    if (waiter.state === state) return
    waiter.state = state
    await waiter.onState?.(state)
  }

  private rejectWaiter(waiter: AdmissionWaiter, error: Error): void {
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort)
    }
    waiter.reject(error)
  }

  private scheduleWake(delay = this.retryMs): void {
    const boundedDelay = Math.max(25, delay)
    const wakeAt = Date.now() + boundedDelay
    if (this.wakeTimer && this.wakeAt <= wakeAt) return
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeAt = wakeAt
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.wakeAt = 0
      const apiKey = this.waiters[0]?.apiKey
      const state = apiKey ? this.stateFor(apiKey) : null
      if (apiKey && state && (this.queueNearCapacity(state) || Date.now() >= state.refreshAfter)) {
        void this.refreshNow(apiKey)
      } else {
        this.drain()
      }
    }, boundedDelay)
  }

  private clearWake(): void {
    if (!this.wakeTimer) return
    clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    this.wakeAt = 0
  }
}
