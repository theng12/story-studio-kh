export interface GenStudioAdmissionSnapshot {
  active: number
  queued: number
  limit: number
  limitSource: 'subscription' | 'safe-fallback'
}

interface AdmissionWaiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

export class GenStudioAdmissionPool {
  private active = 0
  private limit = 1
  private limitSource: GenStudioAdmissionSnapshot['limitSource'] = 'safe-fallback'
  private refreshAfter = 0
  private refreshPromise: Promise<void> | null = null
  private readonly waiters: AdmissionWaiter[] = []

  constructor(
    private readonly loadLimit: (apiKey: string) => Promise<number>,
    private readonly cacheMs = 30_000,
    private readonly retryMs = 5_000,
  ) {}

  snapshot(): GenStudioAdmissionSnapshot {
    return {
      active: this.active,
      queued: this.waiters.length,
      limit: this.limit,
      limitSource: this.limitSource,
    }
  }

  async run<T>(
    apiKey: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.refresh(apiKey)
    const release = await this.acquire(signal)
    try {
      return await work()
    } finally {
      release()
    }
  }

  private async refresh(apiKey: string): Promise<void> {
    if (Date.now() < this.refreshAfter) return
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      try {
        const reported = await this.loadLimit(apiKey)
        const normalized = Math.max(1, Math.min(1_000, Math.floor(Number(reported)) || 1))
        this.limit = normalized
        this.limitSource = 'subscription'
        this.refreshAfter = Date.now() + this.cacheMs
        this.drain()
      } catch {
        // A missing usage scope or temporary account-read failure must never
        // turn into a provider burst. Fall closed even if a larger cached
        // subscription limit had previously been loaded.
        this.limit = 1
        this.limitSource = 'safe-fallback'
        this.refreshAfter = Date.now() + this.retryMs
      }
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('Cancelled by user'))
    return new Promise((resolve, reject) => {
      const waiter: AdmissionWaiter = { resolve, reject, signal }
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Cancelled by user'))
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (waiter.signal?.aborted) {
        waiter.abort?.()
        continue
      }
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort)
      }
      this.active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.drain()
      })
    }
  }
}
