import { redactSecrets } from '../../lib/redact-secrets.js'

export interface FakeSocialCall {
  method: string
  url: string
  status: number
  /** The request body as sent, with every registered secret redacted. */
  body?: string
  headers?: Record<string, string>
}

interface QueuedResponse {
  status: number
  body: unknown
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

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) return `<binary ${body.byteLength} bytes>`
  if (body instanceof ArrayBuffer) return `<binary ${body.byteLength} bytes>`
  return '<body>'
}

/**
 * A recorded-response transport for Facebook, Instagram and TikTok.
 *
 * Nothing here reaches the network: every response is queued by the test. A
 * request with no queued response FAILS the test loudly rather than falling
 * through to `fetch`, which is the whole point — this feature must be provable
 * without the owner's accounts existing.
 */
export class FakeSocial {
  readonly calls: FakeSocialCall[] = []
  private queue: Array<{ match: (method: string, url: string) => boolean; response: QueuedResponse }> = []

  respond(input: {
    method?: string
    /** A substring of the URL, or a predicate. */
    url?: string | ((url: string) => boolean)
    status?: number
    body?: unknown
    headers?: Record<string, string>
  }): this {
    const method = (input.method || 'GET').toUpperCase()
    const url = input.url
    const match = (callMethod: string, callUrl: string): boolean => {
      if (callMethod !== method) return false
      if (url === undefined) return true
      if (typeof url === 'function') return url(callUrl)
      return callUrl.includes(url)
    }
    this.queue.push({
      match,
      response: { status: input.status ?? 200, body: input.body ?? {}, headers: input.headers },
    })
    return this
  }

  /** Queue the same answer for any number of matching calls. */
  respondMany(input: Parameters<FakeSocial['respond']>[0], times: number): this {
    for (let i = 0; i < times; i++) this.respond(input)
    return this
  }

  transport = async (input: TransportInput, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)
    const index = this.queue.findIndex(entry => entry.match(method, url))
    if (index < 0) {
      throw new Error(`FakeSocial has no response queued for ${method} ${url}. A test must never reach the real platform.`)
    }
    const [entry] = this.queue.splice(index, 1)
    const body = bodyText(init?.body)
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => { headers[key.toLowerCase()] = value })
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) headers[key.toLowerCase()] = value
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value)
      }
    }
    this.calls.push({
      method,
      url,
      status: entry!.response.status,
      ...(body !== undefined ? { body: redactSecrets(body) } : {}),
      headers,
    })
    return new Response(JSON.stringify(entry!.response.body), {
      status: entry!.response.status,
      headers: { 'Content-Type': 'application/json', ...(entry!.response.headers ?? {}) },
    })
  }

  /** Every call whose URL contains `fragment`. */
  callsTo(fragment: string): FakeSocialCall[] {
    return this.calls.filter(call => call.url.includes(fragment))
  }
}
