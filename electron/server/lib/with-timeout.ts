/** How long one YouTube verification may take before Free up space gives up on that file (env for tests). */
export function verifyTimeoutMs(): number {
  return Number(process.env.STORY_VERIFY_TIMEOUT_MS) || 60_000
}

/** `work`, or a rejection with `message` once `ms` pass. The work itself is not cancelled; its answer is ignored. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
