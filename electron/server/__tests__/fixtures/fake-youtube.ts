import { redactSecrets } from '../../lib/redact-secrets.js'

export interface FakeYouTubeCall {
  method: string
  path: string
  status: number
  /**
   * The request body as sent, when it was text, with every registered secret
   * redacted.
   *
   * Recorded so a test can assert on what actually LEFT rather than on whether
   * a call happened. Redacted because the recording itself is evidence: an
   * OAuth exchange body carries the client secret, and the Phase 1 foundation
   * test rightly fails the moment that appears in call evidence.
   */
  body?: string
  headers?: Record<string, string>
}

interface QueuedResponse {
  status: number
  body: unknown
  /** Extra response headers. The resumable upload flow needs `Location`. */
  headers?: Record<string, string>
}

type TransportInput = Parameters<typeof fetch>[0]

function requestUrl(input: TransportInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function requestMethod(input: TransportInput, init?: RequestInit): string {
  if (typeof init?.method === 'string' && init.method) return init.method.toUpperCase()
  if (input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function requestPath(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value, 'https://fake.youtube.test')
  } catch {
    throw new Error('Fake YouTube request URL is invalid')
  }
  return `${parsed.pathname}${parsed.search}`
}

function responseBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined
  return JSON.stringify(body)
}

/**
 * Provider-free YouTube transport for tests. Every response is explicitly
 * queued, and an unqueued request fails locally instead of touching the
 * ambient network or global fetch.
 */
export class FakeYouTube {
  readonly calls: FakeYouTubeCall[] = []
  private readonly responses = new Map<string, QueuedResponse[]>()
  private readonly patterns: Array<{ method: string, match: RegExp, response: QueuedResponse }> = []

  respond(input: { method: string; path: string; status?: number; body: unknown; headers?: Record<string, string> }): void {
    this.enqueue(input, input.status ?? 200)
  }

  rejectNext(input: { method: string; path: string; status: number; body: unknown; headers?: Record<string, string> }): void {
    this.enqueue(input, input.status)
  }

  /**
   * Queue a response for a path matched by pattern rather than spelled out.
   *
   * For callers that build a URL from many parameters, where restating the
   * exact query string in the test would duplicate the code under test - and
   * would then agree with it even when both are wrong. Exact queues still win;
   * this is only consulted when none matches, and an unmatched request still
   * fails locally rather than reaching the network.
   */
  respondMatching(input: { method: string; match: RegExp; status?: number; body: unknown }): void {
    this.patterns.push({
      method: input.method.trim().toUpperCase(),
      match: input.match,
      response: { status: input.status ?? 200, body: input.body },
    })
  }

  transport(): typeof fetch {
    return async (input, init) => {
      const method = requestMethod(input, init)
      const path = requestPath(requestUrl(input))
      const key = `${method} ${path}`
      const queue = this.responses.get(key)
      let next = queue?.shift()
      if (queue?.length === 0) this.responses.delete(key)
      if (!next) {
        const index = this.patterns.findIndex(entry => entry.method === method && entry.match.test(path))
        if (index >= 0) next = this.patterns.splice(index, 1)[0]!.response
      }
      if (!next) throw new Error(`Fake YouTube has no queued response for ${key}`)
      const rawBody = typeof init?.body === 'string' ? init.body : undefined
      const sentBody = rawBody === undefined ? undefined : redactSecrets(rawBody)
      const requestHeaders = new Headers(init?.headers)
      const safeHeaders = Object.fromEntries(
        [...requestHeaders.entries()].filter(([name]) => name.toLowerCase() !== 'authorization'),
      )
      this.calls.push({
        method, path, status: next.status,
        ...(sentBody ? { body: sentBody } : {}),
        ...(Object.keys(safeHeaders).length ? { headers: safeHeaders } : {}),
      })
      return new Response(responseBody(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
      })
    }
  }

  private enqueue(
    input: { method: string; path: string; body: unknown; headers?: Record<string, string> },
    status: number,
  ): void {
    if (typeof input.method !== 'string' || !input.method.trim()) throw new Error('Fake YouTube method is required')
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Fake YouTube status is invalid')
    const method = input.method.trim().toUpperCase()
    const path = requestPath(input.path)
    const key = `${method} ${path}`
    const queue = this.responses.get(key) ?? []
    queue.push({ status, body: input.body, ...(input.headers ? { headers: input.headers } : {}) })
    this.responses.set(key, queue)
  }
}
