import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

export const MOCK_GENSTUDIO_FULL_KEY = 'gsk_mock_story_full_scope'

export type MockGenStudioOperation = 'chat' | 'image' | 'tts' | 'transcription' | 'video' | 'music'

export type MockGenStudioState =
  | 'accepted'
  | 'reserved'
  | 'dispatched'
  | 'running'
  | 'reconciling'
  | 'validating'
  | 'succeeded'
  | 'failed'

export type MockGenStudioScope =
  | 'models:read'
  | 'voices:read'
  | 'tts:generate'
  | 'audio:transcribe'
  | 'images:generate'
  | 'chat:generate'
  | 'video:generate'
  | 'music:generate'
  | 'usage:read'
  | 'content:read'
  | 'content:purchase'

export interface MockContentPurchaseOutcome {
  status?: 200 | 401 | 402 | 404 | 409 | 418 | 503
  body?: Record<string, unknown>
  dropResponse?: boolean
  delayMs?: number
  rawBody?: string
}

export interface MockCreditSnapshot {
  quoted: number
  reserved: number
  final: number
  returned: number
}

export interface MockGenStudioScenario {
  states?: MockGenStudioState[]
  quotedCredits?: number
  reservedCredits?: number
  finalCredits?: number
  failureCode?: string
  routingStatusCode?: string
  outputText?: string
  /** Chat only. Anything other than a stop must be refused, never returned as
   *  a finished result. Defaults to `stop`. */
  finishReason?: string
  /** Chat only. Extra top-level response fields — the web-research evidence
   *  envelope (`citations`, `research_ran_at`, …) rides here. */
  envelope?: Record<string, unknown>
  artifactExpired?: boolean
  /** Omit optional settlement output to exercise a provider that publishes none. */
  omitReleasedCredits?: boolean
  dropFirstSubmitResponse?: boolean
  /** Keeps a submitted job in flight long enough for fan-out tests to observe. */
  submitDelayMs?: number
  /** Test-only barrier: hold TTS submit responses until this many have entered. */
  waitForConcurrentTtsSubmissions?: number
  /** Close exactly the first cancellation response after accepting the POST. */
  dropFirstCancellationResponse?: boolean
}

export interface MockGenStudioRequest {
  method: string
  path: string
  authorization: string
  idempotencyKey: string
  bodyText: string
}

export interface MockGenStudioSubmission {
  operation: MockGenStudioOperation
  jobId: string
  idempotencyKey: string
  bodyText: string
  parsedBody: Record<string, unknown> | null
  replay: boolean
}

interface StoredScenario extends Required<Omit<MockGenStudioScenario,
  'failureCode' | 'routingStatusCode' | 'outputText' | 'finishReason' | 'envelope'>> {
  failureCode: string | null
  routingStatusCode: string | null
  outputText: string
  finishReason: string
  envelope: Record<string, unknown>
}

interface MockJob {
  id: string
  operation: MockGenStudioOperation
  idempotencyKey: string
  scenario: StoredScenario
  stateIndex: number
  modelId: string
  body: Record<string, unknown>
  bodyText: string
  responseDropped: boolean
  replayCount: number
  pollCount: number
  credits: MockCreditSnapshot
  cancelled: boolean
  cancellationResponseDropped: boolean
}

interface MockTranscriptionQuote {
  id: string
  idempotencyKey: string
  body: Record<string, unknown>
  bodyText: string
}

interface TtsSubmissionBarrier {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const FULL_SCOPES: MockGenStudioScope[] = [
  'models:read',
  'voices:read',
  'tts:generate',
  'audio:transcribe',
  'images:generate',
  'chat:generate',
  'video:generate',
  'music:generate',
  'usage:read',
  'content:read',
  'content:purchase',
]

const OPERATION_NAME: Record<MockGenStudioOperation, string> = {
  chat: 'chat.response',
  image: 'image.generation',
  tts: 'voice.tts',
  transcription: 'audio.transcription',
  video: 'video.generation',
  music: 'music.generation',
}

const DEFAULT_CREDITS: Record<MockGenStudioOperation, number> = {
  chat: 9,
  image: 7,
  tts: 5,
  transcription: 7,
  video: 50,
  music: 13,
}

/** Not a playable clip — just deterministic, non-empty bytes with an ftyp box. */
const TINY_MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(16, 0x21),
])

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function silentWav(): Buffer {
  const sampleRate = 8_000
  const sampleCount = 800
  const dataLength = sampleCount * 2
  const wav = Buffer.alloc(44 + dataLength)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataLength, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataLength, 40)
  return wav
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const encoded = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(encoded.length),
  })
  response.end(encoded)
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function parseJson(body: Buffer): Record<string, unknown> {
  if (!body.length) return {}
  try {
    const value = JSON.parse(body.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function multipartField(bodyText: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = bodyText.match(new RegExp(`name="${escaped}"\\r\\n\\r\\n([^\\r\\n]+)`))
  return match?.[1]?.trim() || ''
}

function normalizeScenario(
  operation: MockGenStudioOperation,
  scenario: MockGenStudioScenario,
): StoredScenario {
  const states: MockGenStudioState[] = scenario.states?.length ? [...scenario.states] : ['succeeded']
  const quotedCredits = scenario.quotedCredits ?? DEFAULT_CREDITS[operation]
  const reservedCredits = scenario.reservedCredits ?? quotedCredits
  const terminal = states.at(-1)
  const finalCredits = scenario.finalCredits ?? (terminal === 'failed' ? 0 : reservedCredits)
  if (!['succeeded', 'failed'].includes(terminal || '')) {
    throw new Error('Mock GenStudio scenarios must end in succeeded or failed')
  }
  if (quotedCredits < 0 || reservedCredits < 0 || finalCredits < 0 || finalCredits > reservedCredits) {
    throw new Error('Mock GenStudio credit values are invalid')
  }
  return {
    states,
    quotedCredits,
    reservedCredits,
    finalCredits,
    failureCode: scenario.failureCode || null,
    routingStatusCode: scenario.routingStatusCode || null,
    outputText: scenario.outputText || 'Mock GenStudio output.',
    finishReason: scenario.finishReason || 'stop',
    envelope: scenario.envelope || {},
    artifactExpired: scenario.artifactExpired === true,
    omitReleasedCredits: scenario.omitReleasedCredits === true,
    dropFirstSubmitResponse: scenario.dropFirstSubmitResponse === true,
    submitDelayMs: Number.isFinite(scenario.submitDelayMs) && scenario.submitDelayMs! > 0
      ? scenario.submitDelayMs!
      : 0,
    waitForConcurrentTtsSubmissions:
      Number.isInteger(scenario.waitForConcurrentTtsSubmissions)
      && scenario.waitForConcurrentTtsSubmissions! > 0
        ? scenario.waitForConcurrentTtsSubmissions!
        : 0,
    dropFirstCancellationResponse: scenario.dropFirstCancellationResponse === true,
  }
}

function requiredScope(pathname: string, method: string): MockGenStudioScope | null {
  if (pathname === '/v1/content/account' || pathname === '/v1/content/products'
    || pathname === '/v1/content/quotes' || pathname === '/v1/content/public-key'
    || pathname === '/v1/content/receipts' || pathname === '/v1/content/downloads'
    || /^\/v1\/content\/entitlements\/[^/]+\/releases$/.test(pathname)) return 'content:read'
  if (pathname === '/v1/content/purchases') return 'content:purchase'
  if (pathname === '/v1/models' || pathname === '/v1/chat/models'
    || pathname === '/v1/video/models' || pathname === '/v1/videos/models') {
    return 'models:read'
  }
  if (pathname === '/v1/voices') return 'voices:read'
  if (pathname === '/v1/transcription/models') return 'audio:transcribe'
  if (pathname === '/v1/image/models' || pathname === '/v1/images/models') return 'images:generate'
  if (pathname === '/v1/account/overview') return 'usage:read'
  if (pathname.startsWith('/v1/chat/responses') || pathname === '/v1/chat/completions') {
    return 'chat:generate'
  }
  if (pathname.startsWith('/v1/images')) return 'images:generate'
  if (pathname.startsWith('/v1/audio/transcriptions') || pathname.startsWith('/v1/transcriptions')) {
    return 'audio:transcribe'
  }
  if (pathname.startsWith('/v1/audio/jobs') || pathname.startsWith('/v1/jobs')) return 'tts:generate'
  if (pathname.startsWith('/v1/videos')) return 'video:generate'
  if (pathname.startsWith('/v1/music/jobs')) return 'music:generate'
  return method === 'POST' ? null : null
}

export class MockGenStudioService {
  readonly requests: MockGenStudioRequest[] = []
  readonly submissions: MockGenStudioSubmission[] = []
  readonly server: Server
  ttsModels: Array<Record<string, unknown>> = [{
    id: 'mock-tts-v1', display_name: 'Mock TTS', provider_id: 'mock-provider', provider_name: 'GenStudio mock',
    description: 'In-process TTS fixture.', credits_per_1000_characters: 1, minimum_credits: 1,
    maximum_input_characters: 15_000, supports_speed: true, supports_voice_cloning: false,
    preview_policy: '', generation_enabled: true, provider_submit_concurrency: null, controls: [],
  }]

  private readonly keys = new Map<string, Set<MockGenStudioScope>>()
  private readonly contentAccounts = new Map<string, string>()
  private readonly contentPurchases = new Map<string, Record<string, unknown>>()
  private readonly contentSigningKey = generateKeyPairSync('ed25519')
  private readonly contentArchives = new Map<string, Uint8Array>()
  private readonly queuedContentPurchaseOutcomes: MockContentPurchaseOutcome[] = []
  contentProducts: Array<Record<string, unknown>> = []
  contentPurchasePostCount = 0
  contentDownloadPostCount = 0
  contentArchiveGetCount = 0
  contentDownloadRefusal: { status: number; code: string; detail: string } | null = null
  tamperContentPurchaseReceipt = false
  private readonly queuedScenarios = new Map<MockGenStudioOperation, StoredScenario[]>()
  private readonly jobs = new Map<string, MockJob>()
  private readonly jobByIdempotency = new Map<string, string>()
  private readonly transcriptionQuotes = new Map<string, MockTranscriptionQuote>()
  private readonly transcriptionQuoteByIdempotency = new Map<string, string>()
  private readonly sequence: Record<MockGenStudioOperation, number> = {
    chat: 0,
    image: 0,
    tts: 0,
    transcription: 0,
    video: 0,
    music: 0,
  }
  private activeTtsSubmissions = 0
  private maxInFlightTtsSubmissions = 0
  private readonly ttsSubmissionBarriers = new Map<number, TtsSubmissionBarrier>()

  baseUrl = ''

  private sourceAssets = 1

  constructor() {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    this.registerKey(MOCK_GENSTUDIO_FULL_KEY, FULL_SCOPES)
  }

  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Mock GenStudio did not bind a TCP port')
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return this
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.close()
    await once(this.server, 'close')
  }

  reset(): void {
    this.requests.length = 0
    this.submissions.length = 0
    this.queuedScenarios.clear()
    this.jobs.clear()
    this.jobByIdempotency.clear()
    this.transcriptionQuotes.clear()
    this.transcriptionQuoteByIdempotency.clear()
    this.contentPurchases.clear()
    this.queuedContentPurchaseOutcomes.length = 0
    this.contentPurchasePostCount = 0
    this.contentDownloadPostCount = 0
    this.contentArchiveGetCount = 0
    this.contentDownloadRefusal = null
    this.tamperContentPurchaseReceipt = false
    this.contentArchives.clear()
    this.contentProducts = []
    for (const operation of Object.keys(this.sequence) as MockGenStudioOperation[]) {
      this.sequence[operation] = 0
    }
    this.activeTtsSubmissions = 0
    this.maxInFlightTtsSubmissions = 0
  }

  registerKey(key: string, scopes: Iterable<MockGenStudioScope>): void {
    this.keys.set(key, new Set(scopes))
  }

  registerContentStoreKey(
    key: string,
    accountId: string,
    scopes: Iterable<MockGenStudioScope> = ['content:read', 'content:purchase'],
  ): void {
    this.registerKey(key, scopes)
    this.contentAccounts.set(key, accountId)
  }

  queueContentPurchaseOutcome(outcome: MockContentPurchaseOutcome): void {
    this.queuedContentPurchaseOutcomes.push(outcome)
  }

  setContentArchive(releaseId: string, archiveBytes: Uint8Array): void {
    const product = this.contentProducts.find(entry => (entry.current_release as Record<string, unknown> | null)?.release_id === releaseId)
    if (!product) throw new Error(`Unknown mock Content Store release: ${releaseId}`)
    const release = product.current_release as Record<string, unknown>
    const digest = createHash('sha256').update(archiveBytes).digest('hex')
    release.archive_sha256 = digest
    release.archive_bytes = archiveBytes.byteLength
    release.archive_available = true
    this.contentArchives.set(digest, Uint8Array.from(archiveBytes))
  }

  setContentProductOwned(productId: string, owned = true): void {
    const product = this.contentProducts.find(entry => entry.product_id === productId)
    if (!product) throw new Error(`Unknown mock Content Store product: ${productId}`)
    product.owned = owned
  }

  queueScenario(operation: MockGenStudioOperation, scenario: MockGenStudioScenario): void {
    const queue = this.queuedScenarios.get(operation) || []
    queue.push(normalizeScenario(operation, scenario))
    this.queuedScenarios.set(operation, queue)
  }

  jobCount(operation?: MockGenStudioOperation): number {
    if (!operation) return this.jobs.size
    return [...this.jobs.values()].filter(job => job.operation === operation).length
  }

  providerSubmissionCount(operation?: MockGenStudioOperation): number {
    const unique = new Set(
      this.submissions
        .filter(submission => !submission.replay && (!operation || submission.operation === operation))
        .map(submission => submission.jobId),
    )
    return unique.size
  }

  maxInFlightTtsSubmissionCount(): number {
    return this.maxInFlightTtsSubmissions
  }

  private async waitForTtsSubmissionBarrier(target: number): Promise<void> {
    let barrier = this.ttsSubmissionBarriers.get(target)
    if (!barrier) {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      const timeout = setTimeout(() => {
        this.ttsSubmissionBarriers.delete(target)
        reject(new Error(
          `Timed out waiting for ${target} concurrent TTS submissions; observed ${this.maxInFlightTtsSubmissions}`,
        ))
      }, 10_000)
      barrier = { promise, resolve, reject, timeout }
      this.ttsSubmissionBarriers.set(target, barrier)
    }

    if (this.activeTtsSubmissions >= target) {
      clearTimeout(barrier.timeout)
      this.ttsSubmissionBarriers.delete(target)
      barrier.resolve()
    }

    await barrier.promise
  }

  pollCount(jobId: string): number {
    return this.requireJob(jobId).pollCount
  }

  replayCount(jobId: string): number {
    return this.requireJob(jobId).replayCount
  }

  creditSnapshot(jobId: string): MockCreditSnapshot {
    return { ...this.requireJob(jobId).credits }
  }

  private requireJob(jobId: string): MockJob {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Unknown mock GenStudio job: ${jobId}`)
    return job
  }

  private authorize(request: IncomingMessage, scope: MockGenStudioScope): boolean {
    const header = request.headers.authorization || ''
    const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    return this.keys.get(key)?.has(scope) === true
  }

  private bearerKey(request: IncomingMessage): string {
    const header = request.headers.authorization || ''
    return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  }

  private contentAccountId(request: IncomingMessage): string {
    return this.contentAccounts.get(this.bearerKey(request)) || 'acct_mock'
  }

  private canonicalContentJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(entry => this.canonicalContentJson(entry)).join(',')}]`
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${this.canonicalContentJson(row[key])}`).join(',')}}`
  }

  private signContentPayload(payload: Record<string, unknown>): string {
    return sign(null, Buffer.from(this.canonicalContentJson(payload), 'utf8'), this.contentSigningKey.privateKey).toString('base64')
  }

  private contentPublicKeyBody(): Record<string, unknown> {
    const der = this.contentSigningKey.publicKey.export({ format: 'der', type: 'spki' })
    return {
      key_id: 'mock-content-key', algorithm: 'ed25519',
      public_key_base64: der.subarray(der.byteLength - 32).toString('base64'),
      payload_types: [
        'genstudio.content.download.v1', 'genstudio.content.quote.v1',
        'genstudio.content.receipt.v1', 'genstudio.content.restore.v1',
      ],
      canonicalization: 'json:sorted-keys,no-whitespace,utf-8',
    }
  }

  private contentAccountBody(request: IncomingMessage): Record<string, unknown> {
    const accountId = this.contentAccountId(request)
    const owned = this.contentProducts.filter(product => product.owned === true).map(product => ({
      entitlement_family: product.entitlement_family,
      product_id: product.product_id,
      title: product.title,
      kind: product.kind,
      granted_at: '2026-08-14T09:12:44Z',
      purchase_id: null,
      current_release: product.current_release,
      showcase_videos: product.showcase_videos || [],
    }))
    return {
      account_id: accountId,
      content_account_id: accountId,
      available_credits: 5_000,
      content_spendable_credits: 4_000,
      owned,
    }
  }

  private contentReceiptsBody(request: IncomingMessage): Record<string, unknown> {
    const accountId = this.contentAccountId(request)
    const owned = this.contentProducts.filter(product => product.owned === true)
    const entitlements = owned.map((product, index) => ({
      entitlement_id: `cent_restore_${index + 1}`,
      entitlement_family: product.entitlement_family,
      product_id: product.product_id,
      title: product.title,
      kind: product.kind,
      publisher_id: product.publisher_id,
      granted_at: '2026-08-14T09:12:44Z',
      purchase_id: null,
      retired: product.retired === true,
      current_release: product.current_release,
      download_available: Boolean((product.current_release as Record<string, unknown> | null)?.archive_available),
      showcase_videos: product.showcase_videos || [],
    }))
    const signedEntitlements = entitlements.map(item => ({
      entitlement_family: item.entitlement_family,
      product_id: item.product_id,
      title: item.title,
      kind: item.kind,
      granted_at: item.granted_at,
      purchase_id: item.purchase_id,
    }))
    const releases = entitlements.flatMap(item => {
      const release = item.current_release as Record<string, unknown> | null
      return release ? [{
        entitlement_family: item.entitlement_family,
        release_id: release.release_id,
        pack_id: release.pack_id,
        version: release.version,
        archive_sha256: release.archive_sha256,
        archive_bytes: release.archive_bytes,
        min_story_version: release.min_story_version,
      }] : []
    })
    const now = new Date()
    const restore = {
      typ: 'genstudio.content.restore.v1', key_id: 'mock-content-key', receipt_id: `crst_${this.requests.length}`,
      account_id: accountId, content_account_id: accountId,
      entitlement_families: entitlements.map(item => item.entitlement_family),
      entitlements: signedEntitlements,
      releases,
      issued_at: now.toISOString(),
      expiry_policy: {
        ownership: 'permanent', receipt_expires_at: null,
        refresh_recommended_after: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      },
    }
    const purchaseReceipt = {
      typ: 'genstudio.content.receipt.v1', key_id: 'mock-content-key', purchase_id: 'cpur_restore_1',
      account_id: accountId, credits_charged: 300,
    }
    return {
      account_id: accountId,
      content_account_id: accountId,
      restore_receipt: { receipt: restore, receipt_signature: this.signContentPayload(restore), key_id: 'mock-content-key' },
      purchase_receipts: [{
        purchase_id: 'cpur_restore_1', receipt: purchaseReceipt,
        receipt_signature: this.tamperContentPurchaseReceipt
          ? Buffer.alloc(64, 1).toString('base64')
          : this.signContentPayload(purchaseReceipt),
        key_id: 'mock-content-key', credits_charged: 300, created_at: '2026-08-14T09:12:44Z',
      }],
      entitlements,
    }
  }

  private contentOwnedReleasesBody(request: IncomingMessage, entitlementFamily: string): Record<string, unknown> {
    const owned = this.contentProducts.filter(product => product.owned === true)
    const index = owned.findIndex(product => product.entitlement_family === entitlementFamily)
    const product = owned[index]
    if (!product) throw Object.assign(new Error('not entitled'), { mockStatus: 404, mockCode: 'not_entitled' })
    const release = product.current_release as Record<string, unknown> | null
    return {
      entitlement_family: product.entitlement_family,
      entitlement_id: `cent_restore_${index + 1}`,
      product_id: product.product_id,
      title: product.title,
      kind: product.kind,
      publisher_id: product.publisher_id,
      granted_at: '2026-08-14T09:12:44Z',
      retired: product.retired === true,
      current_release_id: release?.release_id || null,
      releases: release ? [{
        ...release,
        state: 'published',
        published_at: '2026-08-14T09:12:44Z',
        current: true,
      }] : [],
    }
  }

  private contentDownloadBody(request: IncomingMessage, body: Buffer): Record<string, unknown> {
    const input = parseJson(body)
    const releaseId = String(input.release_id || '')
    const entitlementFamily = String(input.entitlement_family || '')
    const version = String(input.version || '')
    const product = this.contentProducts.find(entry => {
      const release = entry.current_release as Record<string, unknown> | null
      return releaseId
        ? release?.release_id === releaseId
        : entry.entitlement_family === entitlementFamily && release?.version === version
    })
    if (!product || product.owned !== true) throw Object.assign(new Error('not entitled'), { mockStatus: 404, mockCode: 'not_entitled' })
    const release = product.current_release as Record<string, unknown>
    if (!release.archive_available || !this.contentArchives.has(String(release.archive_sha256))) {
      throw Object.assign(new Error('archive unavailable'), { mockStatus: 409, mockCode: 'archive_unavailable' })
    }
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 900_000)
    const grant = {
      typ: 'genstudio.content.download.v1', key_id: 'mock-content-key', grant_id: `cdg_${this.requests.length}`,
      account_id: this.contentAccountId(request), product_id: product.product_id,
      entitlement_family: product.entitlement_family, release_id: release.release_id,
      pack_id: release.pack_id, version: release.version, archive_sha256: release.archive_sha256,
      archive_bytes: release.archive_bytes, issued_at: now.toISOString(), expires_at: expiresAt.toISOString(),
    }
    return {
      grant_id: grant.grant_id, account_id: grant.account_id, product_id: grant.product_id,
      entitlement_family: grant.entitlement_family, release_id: grant.release_id, pack_id: grant.pack_id,
      version: grant.version, archive_sha256: grant.archive_sha256, archive_bytes: grant.archive_bytes,
      download_url: `${this.baseUrl}/v1/content/archives/${release.archive_sha256}?grant=mock-opaque-token`,
      expires_at: grant.expires_at, ttl_seconds: 900, grant,
      grant_signature: this.signContentPayload(grant), key_id: 'mock-content-key',
    }
  }

  private contentQuoteBody(request: IncomingMessage, body: Buffer): Record<string, unknown> {
    const input = parseJson(body)
    const productId = String(input.product_id || '')
    const product = this.contentProducts.find(entry => entry.product_id === productId)
    if (!product) throw Object.assign(new Error('product unavailable'), { mockStatus: 404, mockCode: 'product_unavailable' })
    const release = product.current_release as Record<string, unknown> | null
    const releaseId = String(input.release_id || release?.release_id || '')
    const account = this.contentAccountBody(request)
    const quoteId = `cq_${productId}_${String(this.requests.length)}`
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    const price = Number(product.credit_price || 0)
    const signed = {
      typ: 'genstudio.content.quote.v1', key_id: 'mock-content-key', quote_id: quoteId,
      account_id: account.account_id, product_id: productId,
      entitlement_family: product.entitlement_family, release_id: releaseId,
      release_version: release?.version, archive_sha256: release?.archive_sha256,
      base_credit_price: price, discount_credits: 0, quoted_credits: price,
      owned_components: [], issued_at: new Date().toISOString(), expires_at: expiresAt,
    }
    return {
      quote: signed,
      quote_signature: Buffer.alloc(64, 7).toString('base64'),
      quote_id: quoteId,
      key_id: 'mock-content-key',
      expires_at: expiresAt,
      account_id: account.account_id,
      product_id: productId,
      entitlement_family: product.entitlement_family,
      release_id: releaseId,
      base_credit_price: price,
      discount_credits: 0,
      quoted_credits: price,
      balance_before: account.content_spendable_credits,
      balance_after: Number(account.content_spendable_credits) - price,
      owned_components: [],
      sufficient_credits: Number(account.content_spendable_credits) >= price,
      insufficient_reason: Number(account.content_spendable_credits) >= price ? null : 'insufficient_credits',
      shortfall_credits: Math.max(0, price - Number(account.content_spendable_credits)),
    }
  }

  private contentPurchaseBody(request: IncomingMessage, body: Buffer, replayed: boolean): Record<string, unknown> {
    const input = parseJson(body)
    const quote = input.quote as Record<string, unknown>
    const product = this.contentProducts.find(entry => entry.product_id === quote.product_id)!
    const release = product.current_release as Record<string, unknown>
    const accountId = this.contentAccountId(request)
    const purchaseId = `cpur_${String(this.contentPurchases.size + 1)}`
    const charged = Number(quote.quoted_credits || 0)
    const receipt = {
      typ: 'genstudio.content.receipt.v1', key_id: 'mock-content-key', receipt_id: `crc_${purchaseId}`,
      purchase_id: purchaseId, account_id: accountId,
      entitlement_families: [product.entitlement_family], product, release,
      credits_charged: charged, issued_at: new Date().toISOString(),
    }
    return {
      purchase_id: purchaseId, account_id: accountId, credits_charged: charged,
      discount_credits: 0, balance_before: 4_000, balance_after: 4_000 - charged,
      entitlement_ids: [`cent_${purchaseId}`], entitlement_families: [product.entitlement_family],
      product, release, ledger_event_key: charged ? `content-purchase:${purchaseId}` : null,
      receipt: {
        receipt,
        receipt_signature: Buffer.alloc(64, 9).toString('base64'),
        key_id: 'mock-content-key',
      },
      replayed,
    }
  }

  private nextScenario(operation: MockGenStudioOperation): StoredScenario {
    const queue = this.queuedScenarios.get(operation)
    return queue?.shift() || normalizeScenario(operation, {})
  }

  private createOrReplay(
    operation: MockGenStudioOperation,
    idempotencyKey: string,
    parsedBody: Record<string, unknown>,
    bodyText: string,
  ): { job: MockJob; replay: boolean } {
    const identity = `${operation}:${idempotencyKey}`
    const existingId = this.jobByIdempotency.get(identity)
    if (existingId) {
      const job = this.requireJob(existingId)
      job.replayCount++
      this.submissions.push({
        operation,
        jobId: job.id,
        idempotencyKey,
        bodyText,
        parsedBody,
        replay: true,
      })
      return { job, replay: true }
    }

    this.sequence[operation]++
    const id = `mock-${operation}-${String(this.sequence[operation]).padStart(3, '0')}`
    const scenario = this.nextScenario(operation)
    const modelId = String(parsedBody.model_id || parsedBody.model || this.defaultModel(operation))
    const job: MockJob = {
      id,
      operation,
      idempotencyKey,
      scenario,
      stateIndex: 0,
      modelId,
      body: parsedBody,
      bodyText,
      responseDropped: false,
      replayCount: 0,
      pollCount: 0,
      credits: {
        quoted: scenario.quotedCredits,
        reserved: scenario.reservedCredits,
        final: 0,
        returned: 0,
      },
      cancelled: false,
      cancellationResponseDropped: false,
    }
    this.jobs.set(id, job)
    this.jobByIdempotency.set(identity, id)
    this.settleIfTerminal(job)
    this.submissions.push({ operation, jobId: id, idempotencyKey, bodyText, parsedBody, replay: false })
    return { job, replay: false }
  }

  private defaultModel(operation: MockGenStudioOperation): string {
    if (operation === 'chat') return 'mock-chat-v1'
    if (operation === 'image') return 'mock-image-v1'
    if (operation === 'transcription') return 'mock-whisper-v1'
    if (operation === 'video') return 'mock-video-v1'
    if (operation === 'music') return 'mock-music-v1'
    return 'mock-tts-v1'
  }

  private state(job: MockJob): MockGenStudioState {
    return job.scenario.states[job.stateIndex]!
  }

  private advance(job: MockJob): void {
    if (job.cancelled) return
    job.pollCount++
    if (job.stateIndex < job.scenario.states.length - 1) job.stateIndex++
    this.settleIfTerminal(job)
  }

  private settleIfTerminal(job: MockJob): void {
    const state = this.state(job)
    if (state === 'succeeded') {
      job.credits.final = job.scenario.finalCredits
      job.credits.returned = job.credits.reserved - job.credits.final
    } else if (state === 'failed') {
      job.credits.final = 0
      job.credits.returned = job.credits.reserved
    }
  }

  /**
   * Honour the submitted `response_format` rather than assuming a shape.
   *
   * A prose workflow now asks for `{ type: 'text' }` and gets the scenario text
   * verbatim — the fall-through below. The one-key `{ "text": … }` envelope is
   * only produced for a caller that explicitly submits that schema, which the
   * client no longer does; it stays so a scenario can still exercise the
   * tolerant unwrap in `validateStructuredOutput`.
   */
  private chatOutputText(job: MockJob): string {
    const responseFormat = job.body.response_format as Record<string, unknown> | undefined
    const schemaDefinition = responseFormat?.json_schema as Record<string, unknown> | undefined
    const schema = schemaDefinition?.schema as Record<string, unknown> | undefined
    const properties = schema?.properties as Record<string, unknown> | undefined
    if (properties && Object.keys(properties).length === 1 && properties.text) {
      return JSON.stringify({ text: job.scenario.outputText })
    }
    return job.scenario.outputText
  }

  private responseBody(job: MockJob, replay = false): Record<string, unknown> {
    const state = this.state(job)
    const settled = state === 'succeeded' || state === 'failed' || job.cancelled
    const base = {
      id: job.id,
      state,
      dispatch_state: state === 'accepted' || state === 'reserved' ? 'pre_dispatch' : 'dispatched',
      operation: OPERATION_NAME[job.operation],
      dispatch_mode: 'asynchronous',
      model_id: job.modelId,
      credit_cost: state === 'failed' ? 0 : (state === 'succeeded' ? job.credits.final : job.credits.reserved),
      remaining_credits: 1_000 - job.credits.reserved + job.credits.returned,
      failure_code: state === 'failed' ? job.scenario.failureCode : null,
      routing_status_code: job.scenario.routingStatusCode,
      idempotent_replay: replay,
      ...(settled && !job.scenario.omitReleasedCredits ? {
        reserved_credits: job.credits.reserved,
        settled_credits: job.credits.final,
        released_credits: job.credits.returned,
      } : {}),
    }

    if (job.operation === 'chat') {
      return {
        ...base,
        // ChatJobResponse also publishes the research evidence envelope at the
        // top level, exactly like the synchronous completion envelope does.
        ...job.scenario.envelope,
        output_text: state === 'succeeded' ? this.chatOutputText(job) : null,
        output_retained: state === 'succeeded',
        finish_reason: state === 'succeeded' ? job.scenario.finishReason : null,
        cancellable: !job.cancelled && (state === 'accepted' || state === 'reserved'),
        cancelled: job.cancelled,
        cancellation_note: job.cancelled ? 'Cancelled before provider execution.' : null,
      }
    }
    if (job.operation === 'image') {
      return {
        ...base,
        // ImageJobResponse publishes released_credits when a reservation settles.
        ...(job.scenario.omitReleasedCredits ? {} : {
          released_credits: state === 'succeeded' || state === 'failed' || job.cancelled ? job.credits.returned : null,
        }),
        prompt: String(job.body.prompt || ''),
        width: Number(job.body.width) || 1_344,
        height: Number(job.body.height) || 768,
        aspect_ratio: String(job.body.aspect_ratio || '16:9'),
        steps: Number(job.body.steps) || 4,
        seed: job.body.seed ?? null,
        image_url: state === 'succeeded' ? `/v1/images/${job.id}/file` : null,
        cancellable: !job.cancelled && (state === 'accepted' || state === 'reserved'),
        cancelled: job.cancelled,
        cancellation_note: job.cancelled ? 'Cancelled before provider execution.' : null,
      }
    }
    if (job.operation === 'music') {
      return {
        ...base,
        cancellable: !job.cancelled && (state === 'accepted' || state === 'reserved'),
        cancelled: job.cancelled,
        cancellation_note: job.cancelled ? 'Cancelled before provider execution.' : null,
      }
    }
    if (job.operation === 'video') {
      // VideoJobResponse publishes cancellation booleans and released credits.
      return {
        ...base,
        ...(job.scenario.omitReleasedCredits ? {} : {
          released_credits: state === 'succeeded' || state === 'failed' || job.cancelled ? job.credits.returned : null,
        }),
        prompt: String(job.body.prompt || ''),
        mode: String(job.body.mode || 'image-to-video'),
        aspect_ratio: String(job.body.aspect_ratio || '16:9'),
        duration_seconds: Number(job.body.duration_seconds) || 5,
        resolution: String(job.body.resolution || '720p'),
        price_version: 'mock-video-price-v1',
        cancellable: !job.cancelled && (state === 'accepted' || state === 'reserved'),
        cancelled: job.cancelled,
        cancellation_note: job.cancelled ? 'Cancelled before provider execution.' : null,
        video_url: state === 'succeeded' ? `/v1/videos/${job.id}/file` : null,
      }
    }
    if (job.operation === 'transcription') {
      return {
        ...base,
        // TranscriptionJobResponse publishes released_credits.
        released_credits: state === 'succeeded' || state === 'failed' || job.cancelled ? job.credits.returned : null,
        cancellable: !job.cancelled && (state === 'accepted' || state === 'reserved'),
        cancelled: job.cancelled,
        cancellation_note: job.cancelled ? 'Cancelled before provider execution.' : null,
        filename: 'mock.wav',
        language: job.body.language || null,
        word_timestamps: job.body.word_timestamps === 'true',
        quoted_credit_cost: job.credits.quoted,
        duration_seconds: 65,
        price_version: 'mock-price-v1',
        preview_only: false,
        transcript: state === 'succeeded' ? 'Hello from the mock GenStudio service.' : null,
        srt_url: state === 'succeeded' ? `/v1/transcriptions/${job.id}/srt` : null,
      }
    }
    return {
      ...base,
      // ClientTTSJobResponse publishes released_credits.
      released_credits: state === 'succeeded' || state === 'failed' || job.cancelled ? job.credits.returned : null,
      cancellable: !job.cancelled && (state === 'accepted' || state === 'reserved'),
      cancelled: job.cancelled,
      cancellation_note: job.cancelled ? 'Cancelled before provider execution.' : null,
      voice_id: String(job.body.voice_id || 'mock-voice'),
      model_revision_id: 'mock-tts-r1',
      speed: Number(job.body.speed) || 1,
      billable_characters: Array.from(String(job.body.text || '')).length,
      preview_only: false,
      audio_url: state === 'succeeded' ? `/v1/jobs/${job.id}/audio` : null,
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = (request.method || 'GET').toUpperCase()
      const url = new URL(request.url || '/', this.baseUrl || 'http://127.0.0.1')
      const body = ['GET', 'HEAD'].includes(method) ? Buffer.alloc(0) : await readBody(request)
      const bodyText = body.toString('utf8')
      const idempotencyKey = String(request.headers['idempotency-key'] || '')
      this.requests.push({
        method,
        path: url.pathname,
        authorization: request.headers.authorization || '',
        idempotencyKey,
        bodyText,
      })

      const scope = requiredScope(url.pathname, method)
      if (scope && !this.authorize(request, scope)) {
        json(response, scope.startsWith('content:') ? 401 : 403, {
          detail: scope.startsWith('content:') ? 'authentication required' : `missing required scope: ${scope}`,
        })
        return
      }

      if (method === 'GET' && url.pathname === '/v1/content/account') {
        json(response, 200, this.contentAccountBody(request))
        return
      }
      if (method === 'GET' && url.pathname === '/v1/content/products') {
        json(response, 200, { products: this.contentProducts })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/content/public-key') {
        json(response, 200, this.contentPublicKeyBody())
        return
      }
      if (method === 'GET' && url.pathname === '/v1/content/receipts') {
        json(response, 200, this.contentReceiptsBody(request))
        return
      }
      const ownedReleasesMatch = url.pathname.match(/^\/v1\/content\/entitlements\/([^/]+)\/releases$/)
      if (method === 'GET' && ownedReleasesMatch) {
        try {
          json(response, 200, this.contentOwnedReleasesBody(request, decodeURIComponent(ownedReleasesMatch[1]!)))
        } catch (error) {
          const shaped = error as Error & { mockStatus?: number; mockCode?: string }
          json(response, shaped.mockStatus || 500, { code: shaped.mockCode, detail: shaped.message })
        }
        return
      }
      if (method === 'POST' && url.pathname === '/v1/content/downloads') {
        this.contentDownloadPostCount += 1
        if (this.contentDownloadRefusal) {
          json(response, this.contentDownloadRefusal.status, {
            code: this.contentDownloadRefusal.code,
            detail: this.contentDownloadRefusal.detail,
            internal_path: '/srv/private/content/archive',
          })
          return
        }
        try {
          json(response, 200, this.contentDownloadBody(request, body))
        } catch (error) {
          const shaped = error as Error & { mockStatus?: number; mockCode?: string }
          json(response, shaped.mockStatus || 500, { code: shaped.mockCode, detail: shaped.message })
        }
        return
      }
      if (method === 'GET' && url.pathname.startsWith('/v1/content/archives/')) {
        this.contentArchiveGetCount += 1
        if (request.headers.authorization) {
          json(response, 400, { code: 'credential_leak', detail: 'Archive fetch must not carry Authorization.' })
          return
        }
        const digest = url.pathname.slice('/v1/content/archives/'.length)
        const archive = this.contentArchives.get(digest)
        if (!archive || url.searchParams.get('grant') !== 'mock-opaque-token') {
          json(response, 404, { code: 'archive_unavailable', detail: 'archive unavailable' })
          return
        }
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(archive.byteLength),
          'X-Archive-SHA256': digest,
        })
        response.end(archive)
        return
      }
      if (method === 'POST' && url.pathname === '/v1/content/quotes') {
        try {
          json(response, 200, this.contentQuoteBody(request, body))
        } catch (error) {
          const shaped = error as Error & { mockStatus?: number; mockCode?: string }
          json(response, shaped.mockStatus || 500, { code: shaped.mockCode, detail: shaped.message })
        }
        return
      }
      if (method === 'POST' && url.pathname === '/v1/content/purchases') {
        this.contentPurchasePostCount += 1
        if (idempotencyKey.length < 8) {
          json(response, 400, { detail: 'Idempotency-Key is required' })
          return
        }
        const existing = this.contentPurchases.get(idempotencyKey)
        if (existing) {
          json(response, 200, { ...existing, replayed: true })
          return
        }
        const outcome = this.queuedContentPurchaseOutcomes.shift()
        if (outcome?.delayMs) await new Promise(resolve => setTimeout(resolve, outcome.delayMs))
        if (outcome?.dropResponse) {
          response.socket?.destroy()
          return
        }
        if (outcome?.status && outcome.status !== 200) {
          if (outcome.rawBody !== undefined) {
            response.writeHead(outcome.status, { 'Content-Type': 'application/json' })
            response.end(outcome.rawBody)
            return
          }
          json(response, outcome.status, outcome.body || {})
          return
        }
        const purchase = this.contentPurchaseBody(request, body, false)
        if (outcome?.body) {
          const creditsCharged = Number(outcome.body.credits_charged ?? purchase.credits_charged)
          const discountCredits = Number(outcome.body.discount_credits ?? purchase.discount_credits)
          const balanceBefore = Number(outcome.body.balance_before ?? purchase.balance_before)
          const balanceAfter = Number(outcome.body.balance_after ?? purchase.balance_after)
          purchase.credits_charged = creditsCharged
          purchase.discount_credits = discountCredits
          purchase.balance_before = balanceBefore
          purchase.balance_after = balanceAfter
          const receiptEnvelope = purchase.receipt as Record<string, unknown>
          const signedReceipt = receiptEnvelope.receipt as Record<string, unknown>
          signedReceipt.credits_charged = creditsCharged
        }
        this.contentPurchases.set(idempotencyKey, purchase)
        json(response, 200, purchase)
        return
      }

      if (method === 'GET' && this.handleCatalog(url.pathname, response)) return
      const byKeyJob = method === 'GET' ? this.lookupJobByIdempotencyKey(url.pathname) : null
      if (byKeyJob) {
        const job = byKeyJob
        json(response, 200, this.responseBody(job))
        return
      }
      if (method === 'POST') {
        const cancellation = this.cancellationJob(url.pathname)
        if (cancellation) {
          const { job } = cancellation
          const state = this.state(job)
          if (!['accepted', 'reserved'].includes(state) || job.cancelled) {
            json(response, 409, { detail: 'provider execution has already started', code: 'CANCELLATION_NOT_AVAILABLE' })
            return
          }
          job.cancelled = true
          job.credits.final = 0
          job.credits.returned = job.credits.reserved
          if (job.scenario.dropFirstCancellationResponse && !job.cancellationResponseDropped) {
            job.cancellationResponseDropped = true
            response.socket?.destroy()
            return
          }
          json(response, 200, this.responseBody(job))
          return
        }
        if (url.pathname === '/v1/chat/completions') {
          if (idempotencyKey.length < 8) {
            json(response, 400, { detail: 'Idempotency-Key is required' })
            return
          }
          const parsedBody = parseJson(body)
          const { job, replay } = this.createOrReplay('chat', idempotencyKey, parsedBody, bodyText)
          if (job.scenario.dropFirstSubmitResponse && !job.responseDropped) {
            job.responseDropped = true
            response.socket?.destroy()
            return
          }
          while (this.state(job) !== 'succeeded' && this.state(job) !== 'failed') this.advance(job)
          if (this.state(job) === 'failed') {
            json(response, 502, { detail: 'language generation failed' })
            return
          }
          const content = this.chatOutputText(job)
          json(response, 200, {
            ...job.scenario.envelope,
            id: job.id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1_000),
            model: job.modelId,
            choices: [{
              index: 0,
              message: { role: 'assistant', content, refusal: null },
              logprobs: null,
              finish_reason: job.scenario.finishReason,
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            idempotent_replay: replay,
          })
          return
        }
        if (url.pathname === '/v1/audio/transcriptions/quotes') {
          if (idempotencyKey.length < 8) {
            json(response, 400, { detail: 'Idempotency-Key is required' })
            return
          }
          const existingId = this.transcriptionQuoteByIdempotency.get(idempotencyKey)
          const parsedBody = {
            model: multipartField(bodyText, 'model'),
            language: multipartField(bodyText, 'language'),
            word_timestamps: multipartField(bodyText, 'word_timestamps'),
          }
          const quote = existingId
            ? this.transcriptionQuotes.get(existingId)!
            : {
                id: `mock-transcription-quote-${String(this.transcriptionQuotes.size + 1).padStart(3, '0')}`,
                idempotencyKey,
                body: parsedBody,
                bodyText,
              }
          if (!existingId) {
            this.transcriptionQuotes.set(quote.id, quote)
            this.transcriptionQuoteByIdempotency.set(idempotencyKey, quote.id)
          }
          json(response, existingId ? 200 : 201, {
            id: quote.id,
            state: 'quoted',
            quoted_credit_cost: DEFAULT_CREDITS.transcription,
          })
          return
        }
        const confirmMatch = url.pathname.match(/^\/v1\/audio\/transcriptions\/quotes\/([^/]+)\/confirm$/)
        if (confirmMatch) {
          if (idempotencyKey.length < 8) {
            json(response, 400, { detail: 'Idempotency-Key is required' })
            return
          }
          const quote = this.transcriptionQuotes.get(decodeURIComponent(confirmMatch[1]!))
          if (!quote) {
            json(response, 404, { detail: 'quote not found' })
            return
          }
          const { job, replay } = this.createOrReplay(
            'transcription',
            idempotencyKey,
            quote.body,
            quote.bodyText,
          )
          if (job.scenario.dropFirstSubmitResponse && !job.responseDropped) {
            job.responseDropped = true
            response.socket?.destroy()
            return
          }
          json(response, 202, this.responseBody(job, replay))
          return
        }
        if (url.pathname === '/v1/videos/source-images' || url.pathname === '/v1/images/source-images') {
          json(response, 201, {
            id: `mock-source-asset-${this.sourceAssets++}`,
            media_type: 'image/png',
            byte_size: body.length,
            width: 1_280,
            height: 720,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          })
          return
        }
        const operation = this.submitOperation(url.pathname)
        if (operation) {
          if (idempotencyKey.length < 8) {
            json(response, 400, { detail: 'Idempotency-Key is required' })
            return
          }
          const parsedBody = operation === 'transcription'
            ? {
                model: multipartField(bodyText, 'model'),
                language: multipartField(bodyText, 'language'),
                word_timestamps: multipartField(bodyText, 'word_timestamps'),
              }
            : parseJson(body)
          if (operation === 'tts') {
            this.activeTtsSubmissions++
            this.maxInFlightTtsSubmissions = Math.max(this.maxInFlightTtsSubmissions, this.activeTtsSubmissions)
          }
          try {
            const { job, replay } = this.createOrReplay(operation, idempotencyKey, parsedBody, bodyText)
            if (operation === 'tts' && job.scenario.waitForConcurrentTtsSubmissions) {
              await this.waitForTtsSubmissionBarrier(job.scenario.waitForConcurrentTtsSubmissions)
            }
            if (job.scenario.dropFirstSubmitResponse && !job.responseDropped) {
              job.responseDropped = true
              response.socket?.destroy()
              return
            }
            if (job.scenario.submitDelayMs) {
              await new Promise(resolve => setTimeout(resolve, job.scenario.submitDelayMs))
            }
            json(response, 202, this.responseBody(job, replay))
          } finally {
            if (operation === 'tts') this.activeTtsSubmissions--
          }
          return
        }
      }

      const artifact = this.artifactJob(url.pathname)
      if (method === 'GET' && artifact) {
        if (artifact.job.scenario.artifactExpired) {
          json(response, 404, { detail: 'asset expired' })
          return
        }
        if (this.state(artifact.job) !== 'succeeded') {
          json(response, 409, { detail: 'asset is not ready' })
          return
        }
        if (artifact.kind === 'image') {
          response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(ONE_PIXEL_PNG.length) })
          response.end(ONE_PIXEL_PNG)
        } else if (artifact.kind === 'audio') {
          const wav = silentWav()
          response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) })
          response.end(wav)
        } else if (artifact.kind === 'video') {
          response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(TINY_MP4.length) })
          response.end(TINY_MP4)
        } else {
          const srt = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello from mock GenStudio.\n')
          response.writeHead(200, { 'Content-Type': 'application/x-subrip', 'Content-Length': String(srt.length) })
          response.end(srt)
        }
        return
      }

      const job = method === 'GET' ? this.lookupJob(url.pathname) : null
      if (job) {
        this.advance(job)
        json(response, 200, this.responseBody(job))
        return
      }

      json(response, 404, { detail: 'mock route not found' })
    } catch (error) {
      json(response, 500, { detail: error instanceof Error ? error.message : String(error) })
    }
  }

  private handleCatalog(pathname: string, response: ServerResponse): boolean {
    if (pathname === '/v1/account/overview') {
      json(response, 200, {
        credit_balance: 1_000,
        credits_used_30d: 0,
        subscription_plan_name: 'Angkor Pro',
        api_concurrency_limit: 3,
        paid_concurrency_limit: 3,
        paid_active_jobs: 0,
        paid_queued_jobs: 0,
        max_queued_jobs: 100,
        generation_submissions_per_minute: 120,
        total_jobs: this.jobs.size,
        active_jobs: 0,
        completed_jobs: this.jobs.size,
        failed_jobs: 0,
        available_assets: 0,
        next_asset_expiration: null,
      })
      return true
    }
    if (pathname === '/v1/models') {
      json(response, 200, [
        {
          id: 'mock-tts-v1', revision: 'r1', display_name: 'Mock TTS', modality: 'audio',
          operation: 'voice.tts', availability: 'available', qualification_only: false,
          pricing_unit: 'characters', limits: { max_characters: 15_000 }, controls: { speed: true },
        },
        {
          id: 'mock-chat-v1', revision: 'r1', display_name: 'Mock Chat', modality: 'text',
          operation: 'chat.response', availability: 'available', qualification_only: false,
          pricing_unit: 'tokens', limits: { max_output_tokens: 4_096 }, controls: { temperature: true },
        },
      ])
      return true
    }
    if (pathname === '/v1/voices') {
      json(response, 200, [{
        id: 'mock-voice', display_name: 'Mock Voice', language: 'en', provider: 'GenStudio mock',
        engine_id: 'mock-tts-v1', engine_name: 'Mock TTS', model_revision_id: 'mock-tts-r1',
        model_family: 'mock', voice_tier: 'standard', generation_enabled: true,
      }])
      return true
    }
    if (pathname === '/v1/tts/models') {
      json(response, 200, this.ttsModels)
      return true
    }
    if (pathname === '/v1/transcription/models') {
      json(response, 200, [{
        id: 'mock-whisper-v1', display_name: 'Mock Whisper', provider: 'GenStudio mock',
        language: 'multilingual', available: true, available_workers: 1, qualification_only: false,
        // Transcription is priced per SECOND with a floor, as GenStudio
        // publishes it. The fixture carries the real field names so a rename
        // on this side shows up here rather than silently parsing to 0.
        credits_per_second: 0.25, minimum_credits: 3, price_version: 'mock-transcribe-price-v1',
      }])
      return true
    }
    if (pathname === '/v1/image/models' || pathname === '/v1/images/models') {
      json(response, 200, [{
        id: 'mock-image-v1', display_name: 'Mock Image', description: 'In-process PNG fixture.',
        available: true, qualification_only: false, aspect_ratios: ['16:9', '1:1'],
        default_aspect_ratio: '16:9', default_resolution: '1K',
        output_options: [
          { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true },
          { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: false },
        ],
        supports_seed: true, supports_image_to_image: false, operations: ['image.generation'],
        max_prompt_characters: 4800, prompt_token_allowance: 1200,
        min_reference_images: 0, max_reference_images: 0,
      }])
      return true
    }
    if (pathname === '/v1/chat/models') {
      json(response, 200, [{
        id: 'mock-chat-v1', display_name: 'Mock Chat', description: 'In-process LLM fixture.',
        available: true, qualification_only: false,
        context_window_tokens: 128_000, max_output_tokens: 4_096,
        max_structured_items_per_request: null,
        controls: ['temperature', 'top_p', 'max_output_tokens'], activation_blockers: [],
        supports_structured_output: true, structured_output_mode: 'request_json_schema',
      }])
      return true
    }
    if (pathname === '/v1/video/models' || pathname === '/v1/videos/models') {
      json(response, 200, [{
        id: 'mock-video-v1', display_name: 'Mock Video', available: false,
        modes: ['image-to-video'],
        aspect_ratios: ['16:9'],
        variants: [{
          operation: 'image-to-video',
          duration_seconds: 5,
          resolution: '720p',
          credits_per_video: 50,
          minimum_credits: 50,
          price_version: 'mock-video-price-v1',
        }],
      }])
      return true
    }
    return false
  }

  private submitOperation(pathname: string): MockGenStudioOperation | null {
    if (pathname === '/v1/chat/responses') return 'chat'
    if (pathname === '/v1/images/generations') return 'image'
    if (pathname === '/v1/audio/jobs') return 'tts'
    if (pathname === '/v1/audio/transcriptions') return 'transcription'
    if (pathname === '/v1/videos/generations') return 'video'
    if (pathname === '/v1/music/jobs') return 'music'
    return null
  }

  private lookupJob(pathname: string): MockJob | null {
    const patterns: Array<[MockGenStudioOperation, RegExp]> = [
      ['chat', /^\/v1\/chat\/responses\/([^/]+)$/],
      ['image', /^\/v1\/images\/([^/]+)$/],
      ['transcription', /^\/v1\/transcriptions\/([^/]+)$/],
      ['tts', /^\/v1\/jobs\/([^/]+)$/],
      ['video', /^\/v1\/videos\/([^/]+)$/],
      ['music', /^\/v1\/music\/jobs\/([^/]+)$/],
    ]
    for (const [operation, pattern] of patterns) {
      const match = pathname.match(pattern)
      if (!match) continue
      const job = this.jobs.get(decodeURIComponent(match[1]!))
      return job?.operation === operation ? job : null
    }
    return null
  }

  private lookupJobByIdempotencyKey(pathname: string): MockJob | null {
    const patterns: Array<[MockGenStudioOperation, RegExp]> = [
      ['chat', /^\/v1\/chat\/responses\/by-idempotency-key\/([^/]+)$/],
      ['image', /^\/v1\/images\/by-idempotency-key\/([^/]+)$/],
      ['transcription', /^\/v1\/transcriptions\/by-idempotency-key\/([^/]+)$/],
      ['tts', /^\/v1\/jobs\/by-idempotency-key\/([^/]+)$/],
      ['video', /^\/v1\/videos\/by-idempotency-key\/([^/]+)$/],
      ['music', /^\/v1\/music\/jobs\/by-idempotency-key\/([^/]+)$/],
    ]
    for (const [operation, pattern] of patterns) {
      const match = pathname.match(pattern)
      if (!match) continue
      const jobId = this.jobByIdempotency.get(`${operation}:${decodeURIComponent(match[1]!)}`)
      const job = jobId ? this.jobs.get(jobId) : null
      return job?.operation === operation ? job : null
    }
    return null
  }

  private cancellationJob(pathname: string): { job: MockJob } | null {
    const patterns: Array<[MockGenStudioOperation, RegExp]> = [
      ['tts', /^\/v1\/jobs\/([^/]+)\/cancel$/],
      ['image', /^\/v1\/images\/([^/]+)\/cancel$/],
      ['transcription', /^\/v1\/transcriptions\/([^/]+)\/cancel$/],
      ['video', /^\/v1\/videos\/([^/]+)\/cancel$/],
      ['chat', /^\/v1\/chat\/responses\/([^/]+)\/cancel$/],
      ['music', /^\/v1\/music\/jobs\/([^/]+)\/cancel$/],
    ]
    for (const [operation, pattern] of patterns) {
      const match = pathname.match(pattern)
      if (!match) continue
      const job = this.jobs.get(decodeURIComponent(match[1]!))
      return job?.operation === operation ? { job } : null
    }
    return null
  }

  private artifactJob(pathname: string): { job: MockJob; kind: 'audio' | 'image' | 'srt' | 'video' } | null {
    const patterns: Array<[MockGenStudioOperation, 'audio' | 'image' | 'srt' | 'video', RegExp]> = [
      ['tts', 'audio', /^\/v1\/jobs\/([^/]+)\/audio$/],
      ['image', 'image', /^\/v1\/images\/([^/]+)\/file$/],
      ['transcription', 'srt', /^\/v1\/transcriptions\/([^/]+)\/srt$/],
      ['video', 'video', /^\/v1\/videos\/([^/]+)\/file$/],
    ]
    for (const [operation, kind, pattern] of patterns) {
      const match = pathname.match(pattern)
      if (!match) continue
      const job = this.jobs.get(decodeURIComponent(match[1]!))
      return job?.operation === operation ? { job, kind } : null
    }
    return null
  }
}

export async function startMockGenStudioService(): Promise<MockGenStudioService> {
  return new MockGenStudioService().start()
}
