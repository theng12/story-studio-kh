import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withCrossProcessLock } from '../lib/atomic-store.js'
import { normalizeServiceBaseUrl } from '../lib/security.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { APP_TRASH, libraryTrashDir, moveToTrashSync } from '../lib/trash-move.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import { logLine } from './logger.js'
import { getUserDataDir, projectsRoot } from './project-manager.js'

export interface PrivateRenderIdentityV1 {
  format: 'studio.private-render.identity.v1'
  story_instance_id: string
}

/**
 * Gateway identity pinned on the first valid capabilities response. A different
 * identity at the *same* origin is refused, never re-paired. A different origin
 * means the owner pointed Story at another Gateway (a move to a new Mac), so the
 * pairing re-pairs itself there — see `repairGatewayBinding`.
 */
export interface GatewayBindingV1 {
  origin: string
  owner_scope: string
  gateway_instance_id: string
}

/** The pairing a changed Gateway origin replaced, kept so Settings can say what happened. */
export interface GatewayBindingRepairV1 {
  origin: string
  gateway_instance_id: string
  at: string
}

export type GatewayBindingStatus =
  | {
    bound: false
    story_instance_id: string
    configured_origin: string | null
    matches_configured_gateway: null
    repaired_from: GatewayBindingRepairV1 | null
  }
  | ({
    bound: true
    story_instance_id: string
    configured_origin: string | null
    /** null when the configured Gateway address cannot be read. */
    matches_configured_gateway: boolean | null
    repaired_from: GatewayBindingRepairV1 | null
  } & GatewayBindingV1)

/** Origin, regular Gateway API key and Story identity; enough to call capabilities. */
export interface PrivateRenderConnection {
  origin: string
  bearer: string
  story_instance_id: string
  binding: GatewayBindingV1 | null
}

export interface PrivateRenderAccess {
  origin: string
  bearer: string
  story_instance_id: string
  owner_scope: string
  gateway_instance_id: string
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RECORD_MAX_BYTES = 512
/** A repair record names two Gateway origins, so it is allowed more than an identity record. */
const REPAIR_RECORD_MAX_BYTES = 2048
const identityCreates = new Map<string, Promise<PrivateRenderIdentityV1>>()

function privatePaths(): { directory: string; file: string; binding: string; repair: string } {
  const directory = path.join(getUserDataDir(), 'private-render')
  return {
    directory,
    file: path.join(directory, 'identity.json'),
    binding: path.join(directory, 'gateway-binding.json'),
    repair: path.join(directory, 'gateway-binding-repair.json'),
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label} has missing or unknown fields`)
  }
  return record
}

function parseIdentity(value: unknown): PrivateRenderIdentityV1 {
  const record = exactRecord(value, ['format', 'story_instance_id'], 'Private render identity')
  if (record.format !== 'studio.private-render.identity.v1'
    || typeof record.story_instance_id !== 'string'
    || !CANONICAL_UUID.test(record.story_instance_id)) {
    throw new Error('Private render identity has an invalid canonical UUID')
  }
  return {
    format: 'studio.private-render.identity.v1',
    story_instance_id: record.story_instance_id,
  }
}

function parseBinding(value: unknown): GatewayBindingV1 {
  const record = exactRecord(value, ['origin', 'owner_scope', 'gateway_instance_id'], 'Private render Gateway binding')
  if (typeof record.origin !== 'string' || canonicalGatewayOrigin(record.origin) !== record.origin) {
    throw new Error('Private render Gateway binding origin is invalid')
  }
  for (const field of ['owner_scope', 'gateway_instance_id'] as const) {
    if (typeof record[field] !== 'string' || !CANONICAL_UUID.test(record[field])) {
      throw new Error(`Private render Gateway binding ${field} is not a canonical UUID`)
    }
  }
  return {
    origin: record.origin,
    owner_scope: record.owner_scope as string,
    gateway_instance_id: record.gateway_instance_id as string,
  }
}

function canonicalGatewayOrigin(value: string): string {
  const normalized = normalizeServiceBaseUrl(value, 'Gateway')
  const parsed = new URL(normalized)
  if (!normalized || parsed.pathname !== '/' || normalized !== parsed.origin) {
    throw new Error('Configured Gateway origin must not contain a path')
  }
  return normalized
}

/** The configured Gateway origin, or null when it cannot be read — a status read must still answer. */
async function configuredGatewayOrigin(): Promise<string | null> {
  try {
    return canonicalGatewayOrigin(await getGenStudioUrl())
  } catch {
    return null
  }
}

function parseBindingRepair(value: unknown): GatewayBindingRepairV1 {
  const record = exactRecord(
    value, ['format', 'origin', 'gateway_instance_id', 'at'], 'Private render Gateway repair record',
  )
  if (record.format !== 'studio.private-render.repair.v1') {
    throw new Error('Private render Gateway repair record format is invalid')
  }
  if (typeof record.origin !== 'string' || canonicalGatewayOrigin(record.origin) !== record.origin) {
    throw new Error('Private render Gateway repair record origin is invalid')
  }
  if (typeof record.gateway_instance_id !== 'string' || !CANONICAL_UUID.test(record.gateway_instance_id)) {
    throw new Error('Private render Gateway repair record gateway_instance_id is not a canonical UUID')
  }
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))
    || new Date(Date.parse(record.at)).toISOString() !== record.at) {
    throw new Error('Private render Gateway repair record time is invalid')
  }
  return { origin: record.origin, gateway_instance_id: record.gateway_instance_id, at: record.at }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(path.dirname(directory), { recursive: true })
  try {
    await fs.mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Private render directory is unsafe')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Private render directory permissions are unsafe')
  }
}

async function readRecordFile<T>(
  file: string,
  parse: (value: unknown) => T,
  confirmDurability = false,
  maxBytes = RECORD_MAX_BYTES,
): Promise<T> {
  const lstat = await fs.lstat(file)
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.nlink !== 1
    || lstat.size < 1 || lstat.size > maxBytes) {
    throw new Error('Private render record file is unsafe or malformed')
  }
  if (process.platform !== 'win32' && (lstat.mode & 0o077) !== 0) {
    throw new Error('Private render record file permissions are unsafe')
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await fs.open(file, constants.O_RDONLY | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) {
      throw new Error('Private render record descriptor is unsafe')
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
      throw new Error('Private render record bytes are invalid')
    }
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Private render record JSON is malformed') }
    const record = parse(value)
    if (confirmDurability) await handle.sync()
    return record
  } finally {
    await handle.close()
  }
}

async function readDurableExisting<T>(file: string, parse: (value: unknown) => T): Promise<T | null> {
  try {
    const record = await readRecordFile(file, parse, true)
    await fsyncDirectory(path.dirname(file))
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Create-once with fsync: an existing durable record always wins over `create`. */
async function createOnce<T>(
  directory: string,
  file: string,
  store: string,
  parse: (value: unknown) => T,
  create: () => T,
): Promise<T> {
  await ensurePrivateDirectory(directory)
  const existing = await readDurableExisting(file, parse)
  if (existing) return existing
  assertWriteIsolatedInTests(file, store)
  const record = create()
  let handle: FileHandle
  try {
    handle = await fs.open(file, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try { return await readRecordFile(file, parse) } catch (readError) {
        if (attempt === 24) throw readError
        await delay(10)
      }
    }
    throw new Error('Private render record creation did not settle')
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsyncDirectory(directory)
  return readRecordFile(file, parse)
}

export function getOrCreatePrivateRenderIdentity(): Promise<PrivateRenderIdentityV1> {
  const { directory, file } = privatePaths()
  const pending = identityCreates.get(file)
  if (pending) return pending
  const created = withCrossProcessLock(file, () => createOnce(directory, file, 'private-render-identity', parseIdentity, () => ({
    format: 'studio.private-render.identity.v1' as const,
    story_instance_id: randomUUID(),
  })))
  identityCreates.set(file, created)
  void created.finally(() => {
    if (identityCreates.get(file) === created) identityCreates.delete(file)
  }).catch(() => {})
  return created
}

async function readBinding(file: string): Promise<GatewayBindingV1 | null> {
  try {
    return await readRecordFile(file, parseBinding)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Replace one small private-render record atomically; callers hold the cross-process lock. */
async function writeRecord(directory: string, file: string, store: string, value: unknown, maxBytes: number): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (bytes.byteLength > maxBytes) throw new Error('Private render record is too large to store')
  await ensurePrivateDirectory(directory)
  assertWriteIsolatedInTests(file, store)
  const temporary = `${file}.${randomUUID()}.tmp`
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
  await fsyncDirectory(directory)
}

async function readRepairRecord(file: string): Promise<GatewayBindingRepairV1 | null> {
  try {
    return await readRecordFile(file, parseBindingRepair, false, REPAIR_RECORD_MAX_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * A Gateway origin the owner has since changed to another one is a Gateway on another Mac, so the
 * old pairing cannot speak for it. The old file is never destroyed: it moves into Story's Trash.
 */
function trashOldBinding(file: string): void {
  const name = `gateway-binding-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  try {
    moveToTrashSync(file, path.join(libraryTrashDir(projectsRoot()), APP_TRASH, 'private-render', name), 'private-render')
  } catch (error) {
    // A rename never crosses drives: the app's own Trash holds it when the Library is elsewhere.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    moveToTrashSync(file, path.join(libraryTrashDir(getUserDataDir()), 'private-render', name), 'private-render')
  }
}

/** Whether an in-flight remote final render still holds the old Gateway lineage. */
async function inFlightPrivateFinalRender(): Promise<
  { state: 'idle' } | { state: 'in_flight'; project_slug: string; job_id: string } | { state: 'unknown'; reason: string }
> {
  const { findInFlightPrivateFinalRender } = await import('./job-queue.js')
  return findInFlightPrivateFinalRender()
}

function sameBinding(left: GatewayBindingV1, right: GatewayBindingV1): boolean {
  return left.origin === right.origin && left.owner_scope === right.owner_scope
    && left.gateway_instance_id === right.gateway_instance_id
}

/** Pin the Gateway identity once; a later different identity is refused, never re-paired. */
export async function pinGatewayBinding(binding: GatewayBindingV1): Promise<GatewayBindingV1> {
  const wanted = parseBinding(binding)
  const { directory, binding: file } = privatePaths()
  const pinned = await withCrossProcessLock(file, () => createOnce(
    directory, file, 'private-render-gateway-binding', parseBinding, () => wanted,
  ))
  if (!sameBinding(pinned, wanted)) {
    throw new Error('Gateway identity does not match the pinned private render Gateway binding')
  }
  return pinned
}

export async function getGatewayBindingStatus(): Promise<GatewayBindingStatus> {
  const identity = await getOrCreatePrivateRenderIdentity()
  const { binding: file, repair } = privatePaths()
  const binding = await readBinding(file)
  const repaired = await readRepairRecord(repair)
  const configured = await configuredGatewayOrigin()
  if (!binding) {
    return {
      bound: false,
      story_instance_id: identity.story_instance_id,
      configured_origin: configured,
      matches_configured_gateway: null,
      repaired_from: repaired,
    }
  }
  return {
    bound: true,
    story_instance_id: identity.story_instance_id,
    ...binding,
    configured_origin: configured,
    matches_configured_gateway: configured === null ? null : binding.origin === configured,
    repaired_from: repaired,
  }
}

/**
 * Re-pair after the owner points Story at another Gateway origin — a Gateway that moved to a new
 * Mac keeps neither its old address nor its render identity (the identity lives in the Gateway's
 * own database, which a move does not carry). Only the origin may change here. A different identity
 * at the *same* origin is the spoof/replacement case and stays refused, exactly as
 * `pinGatewayBinding` refuses it.
 *
 * Skips the re-pair while a remote final render is still in flight: that render's receipt names the
 * old Gateway identity, so the next capabilities call after it settles does the repair instead.
 */
export async function repairGatewayBinding(binding: GatewayBindingV1): Promise<GatewayBindingV1> {
  const wanted = parseBinding(binding)
  const { directory, binding: file, repair: repairFile } = privatePaths()
  return withCrossProcessLock(file, async () => {
    const pinned = await readDurableExisting(file, parseBinding)
    if (!pinned) {
      return createOnce(directory, file, 'private-render-gateway-binding', parseBinding, () => wanted)
    }
    if (sameBinding(pinned, wanted)) return pinned
    if (pinned.origin === wanted.origin) {
      throw new Error('Gateway identity does not match the pinned private render Gateway binding')
    }
    if (wanted.origin !== canonicalGatewayOrigin(await getGenStudioUrl())) {
      throw new Error('The Gateway pairing can only be re-paired to the configured Gateway origin')
    }
    const inFlight = await inFlightPrivateFinalRender()
    if (inFlight.state === 'unknown') {
      throw new Error(`Gateway pairing was not re-paired yet: Story cannot confirm that no remote final `
        + `render is in flight (${inFlight.reason}); it re-pairs by itself once its jobs are loaded`)
    }
    if (inFlight.state === 'in_flight') {
      throw new Error(`Gateway pairing was not re-paired yet: a remote final render is still in flight `
        + `on job ${inFlight.job_id} in ${inFlight.project_slug}; it re-pairs by itself once that render settles`)
    }
    trashOldBinding(file)
    const next = await createOnce(directory, file, 'private-render-gateway-binding', parseBinding, () => wanted)
    const repaired: GatewayBindingRepairV1 = {
      origin: pinned.origin,
      gateway_instance_id: pinned.gateway_instance_id,
      at: new Date().toISOString(),
    }
    try {
      await writeRecord(directory, repairFile, 'private-render-gateway-repair', {
        format: 'studio.private-render.repair.v1', ...repaired,
      }, REPAIR_RECORD_MAX_BYTES)
    } catch (error) {
      // The pairing itself is already correct; a note that cannot be written must not undo it.
      console.error('[private-render] Re-paired, but could not record what it replaced:', error)
    }
    console.log(`[private-render] Re-paired with the Gateway at ${wanted.origin} `
      + `(instance ${wanted.gateway_instance_id}); it replaced the pairing for ${pinned.origin} `
      + `(instance ${pinned.gateway_instance_id}), which is in Story's Trash.`)
    try {
      logLine('info', `Private final render re-paired with the Gateway at ${wanted.origin} `
        + `(was ${pinned.origin})`, {
        origin: wanted.origin, gateway_instance_id: wanted.gateway_instance_id,
        replaced_origin: pinned.origin, replaced_gateway_instance_id: pinned.gateway_instance_id,
        replaced_binding_in_trash: true,
      })
    } catch {
      // The pairing is already correct; a log line that cannot be written must not undo it.
    }
    return next
  })
}

/**
 * Origin, regular Gateway API key and Story identity; enough to call capabilities. A pinned binding
 * for a *different* origin is returned as-is, because capabilities is the one route allowed to see
 * that answer and re-pair; every other route goes through `readPrivateRenderAccess`.
 */
export async function readPrivateRenderConnection(): Promise<PrivateRenderConnection> {
  const identity = await getOrCreatePrivateRenderIdentity()
  const origin = canonicalGatewayOrigin(await getGenStudioUrl())
  const binding = await readBinding(privatePaths().binding)
  const bearer = await getApiKey('genstudio')
  if (!bearer) throw new Error('Private render requires the Gateway API key')
  return { origin, bearer, story_instance_id: identity.story_instance_id, binding }
}

/** Access for every route except capabilities: a pinned Gateway binding at the configured origin. */
export async function readPrivateRenderAccess(): Promise<PrivateRenderAccess> {
  const { binding, ...connection } = await readPrivateRenderConnection()
  if (!binding) throw new Error('Private render Gateway binding is not established yet')
  if (binding.origin !== connection.origin) {
    throw new Error('Configured Gateway origin does not match the pinned private render Gateway binding')
  }
  return {
    ...connection,
    owner_scope: binding.owner_scope,
    gateway_instance_id: binding.gateway_instance_id,
  }
}
