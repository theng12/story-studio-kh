export interface GenStudioAccountCapacity {
  paid_concurrency_limit: number
  paid_active_jobs: number
  paid_queued_jobs: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
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

function whole(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

function normalizeCapacity(value: GenStudioAccountCapacity): GenStudioAccountCapacity {
  return {
    paid_concurrency_limit: whole(value.paid_concurrency_limit, 1, 1),
    paid_active_jobs: whole(value.paid_active_jobs, 0),
    paid_queued_jobs: whole(value.paid_queued_jobs, 0),
    max_queued_jobs: whole(value.max_queued_jobs, 10, 1),
    generation_submissions_per_minute: whole(value.generation_submissions_per_minute, 5, 1),
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
  private capacity = { ...SAFE_FALLBACK }
  private limitSource: GenStudioAdmissionSnapshot['limitSource'] = 'safe-fallback'
  private refreshedAt = 0
  private refreshAfter = 0
  private refreshPromise: Promise<void> | null = null
  private submitting = 0
  private holdUntil = 0
  private globalFailure: Error | null = null
  private globalFailureUntil = 0
  private readonly submissionTimes: number[] = []
  private readonly waiters: AdmissionWaiter[] = []
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private wakeAt = 0

  constructor(
    private readonly loadCapacity: (apiKey: string) => Promise<GenStudioAccountCapacity>,
    private readonly cacheMs = DEFAULT_REFRESH_MS,
    private readonly retryMs = QUEUED_REFRESH_MS,
  ) {}

  snapshot(): GenStudioAdmissionSnapshot {
    const now = Date.now()
    this.pruneWindow(now)
    return {
      ...this.capacity,
      local_waiting: this.waiters.length,
      submitting: this.submitting,
      available_paid_slots: Math.max(
        0,
        this.capacity.paid_concurrency_limit - this.capacity.paid_active_jobs,
      ),
      submissions_in_window: this.submissionTimes.length,
      queue_near_capacity: this.queueNearCapacity(),
      submissions_blocked: Boolean(this.globalFailure && this.globalFailureUntil > now),
      submission_block_reason: this.globalFailure?.message || null,
      retry_after_ms: Math.max(0, this.holdUntil - now, this.globalFailureUntil - now),
      refreshed_at: this.refreshedAt ? new Date(this.refreshedAt).toISOString() : null,
      limitSource: this.limitSource,
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
    this.refreshAfter = 0
    await this.refresh(apiKey)
    return this.snapshot()
  }

  async notifyTerminal(apiKey: string): Promise<void> {
    await this.refreshNow(apiKey).catch(() => undefined)
    this.drain()
  }

  async noteRateLimit(apiKey: string, retryAfterMs: number): Promise<void> {
    const jitterMs = Math.floor(Math.random() * Math.min(750, Math.max(100, retryAfterMs * 0.1)))
    this.holdUntil = Math.max(this.holdUntil, Date.now() + Math.max(0, retryAfterMs) + jitterMs)
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

  private async refresh(apiKey: string): Promise<void> {
    if (Date.now() < this.refreshAfter) return
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      try {
        this.capacity = normalizeCapacity(await this.loadCapacity(apiKey))
        this.limitSource = 'account-overview'
        this.refreshedAt = Date.now()
        this.refreshAfter = Date.now() + this.cacheMs
      } catch {
        // A missing usage scope or temporary overview failure must fail
        // closed. The accepted job remains GenStudio-owned and recoverable.
        this.capacity = { ...SAFE_FALLBACK }
        this.limitSource = 'safe-fallback'
        this.refreshedAt = Date.now()
        this.refreshAfter = Date.now() + this.retryMs
      }
    })().finally(() => {
      this.refreshPromise = null
      this.drain()
    })
    return this.refreshPromise
  }

  private queueNearCapacity(): boolean {
    const reserve = Math.max(1, Math.ceil(this.capacity.max_queued_jobs * 0.05))
    return this.capacity.paid_queued_jobs >= this.capacity.max_queued_jobs - reserve
  }

  private pruneWindow(now = Date.now()): void {
    while (this.submissionTimes.length && this.submissionTimes[0]! <= now - WINDOW_MS) {
      this.submissionTimes.shift()
    }
  }

  private nextDelay(now = Date.now()): number {
    this.pruneWindow(now)
    if (this.holdUntil > now) return this.holdUntil - now
    if (this.submissionTimes.length >= this.capacity.generation_submissions_per_minute) {
      return Math.max(25, this.submissionTimes[0]! + WINDOW_MS - now)
    }
    if (this.queueNearCapacity()) return this.retryMs
    return 0
  }

  private dispatchLimit(): number {
    const available = Math.max(
      0,
      this.capacity.paid_concurrency_limit - this.capacity.paid_active_jobs,
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
    const delay = this.nextDelay(now)
    if (delay > 0) {
      const state: GenStudioAdmissionState = this.queueNearCapacity()
        ? 'waiting_account_capacity'
        : 'waiting_local'
      for (const waiter of this.waiters) void this.setWaiterState(waiter, state)
      this.scheduleWake(delay)
      return
    }
    const probingAfterGlobalFailure = Boolean(this.globalFailure)
    while (
      this.waiters.length
      && this.submitting < this.dispatchLimit()
      && this.submissionTimes.length < this.capacity.generation_submissions_per_minute
      && !this.queueNearCapacity()
    ) {
      const waiter = this.waiters.shift()!
      if (waiter.signal?.aborted) {
        waiter.abort?.()
        continue
      }
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort)
      }
      this.submitting += 1
      this.submissionTimes.push(Date.now())
      void this.setWaiterState(waiter, 'submitting')
      void waiter.work().then(
        value => {
          if (probingAfterGlobalFailure) this.noteSubmissionReachable()
          waiter.resolve(value)
        },
        error => waiter.reject(error instanceof Error ? error : new Error(String(error))),
      ).finally(() => {
        this.submitting = Math.max(0, this.submitting - 1)
        this.drain()
      })
      if (probingAfterGlobalFailure) break
    }
    if (this.waiters.length) this.scheduleWake(this.retryMs)
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
      if (apiKey && (this.queueNearCapacity() || Date.now() >= this.refreshAfter)) {
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
