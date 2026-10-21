import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withCrossProcessLock } from '../lib/atomic-store.js'
import { normalizeServiceBaseUrl } from '../lib/security.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import { getUserDataDir } from './project-manager.js'

export interface PrivateRenderIdentityV1 {
  format: 'studio.private-render.identity.v1'
  story_instance_id: string
}

/** Gateway identity pinned on the first valid capabilities response; never re-paired. */
export interface GatewayBindingV1 {
  origin: string
  owner_scope: string
  gateway_instance_id: string
}

export type GatewayBindingStatus =
  | { bound: false; story_instance_id: string }
  | ({ bound: true; story_instance_id: string } & GatewayBindingV1)

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
const identityCreates = new Map<string, Promise<PrivateRenderIdentityV1>>()

function privatePaths(): { directory: string; file: string; binding: string } {
  const directory = path.join(getUserDataDir(), 'private-render')
  return { directory, file: path.join(directory, 'identity.json'), binding: path.join(directory, 'gateway-binding.json') }
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
): Promise<T> {
  const lstat = await fs.lstat(file)
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.nlink !== 1
    || lstat.size < 1 || lstat.size > RECORD_MAX_BYTES) {
    throw new Error('Private render record file is unsafe or malformed')
  }
  if (process.platform !== 'win32' && (lstat.mode & 0o077) !== 0) {
    throw new Error('Private render record file permissions are unsafe')
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await fs.open(file, constants.O_RDONLY | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > RECORD_MAX_BYTES) {
      throw new Error('Private render record descriptor is unsafe')
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength < 1 || bytes.byteLength > RECORD_MAX_BYTES) {
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
  const binding = await readBinding(privatePaths().binding)
  return binding
    ? { bound: true, story_instance_id: identity.story_instance_id, ...binding }
    : { bound: false, story_instance_id: identity.story_instance_id }
}

export async function readPrivateRenderConnection(): Promise<PrivateRenderConnection> {
  const identity = await getOrCreatePrivateRenderIdentity()
  const origin = canonicalGatewayOrigin(await getGenStudioUrl())
  const binding = await readBinding(privatePaths().binding)
  if (binding && binding.origin !== origin) {
    throw new Error('Configured Gateway origin does not match the pinned private render Gateway binding')
  }
  const bearer = await getApiKey('genstudio')
  if (!bearer) throw new Error('Private render requires the Gateway API key')
  return { origin, bearer, story_instance_id: identity.story_instance_id, binding }
}

/** Access for every route except capabilities: requires an already pinned Gateway binding. */
export async function readPrivateRenderAccess(): Promise<PrivateRenderAccess> {
  const { binding, ...connection } = await readPrivateRenderConnection()
  if (!binding) throw new Error('Private render Gateway binding is not established yet')
  return {
    ...connection,
    owner_scope: binding.owner_scope,
    gateway_instance_id: binding.gateway_instance_id,
  }
}
