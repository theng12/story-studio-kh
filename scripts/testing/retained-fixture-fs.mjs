import { createHash, randomUUID } from 'node:crypto'
import fs, { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { constants as osConstants } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainThread } from 'node:worker_threads'

const REFUSED = 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED'
const SNAPSHOT = 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT'
const BUSY = 'ERR_STORY_STUDIO_RETAINED_FS_BUSY'
const LOCK_NAME = '.retained-fixture-fs.lock'
const RELEASED_LOCKS = 'released-locks'
const BARRIER_CONTROL = '.retained-fixture-fs-test-barrier.json'
const BARRIER_REACHED = '.retained-fixture-fs-test-barrier-reached.json'
const BARRIER_RESUME = '.retained-fixture-fs-test-barrier-resume'
const BOOTSTRAP_PARENT_PREFIX = '.retained-fixture-fs-bootstrap-'
const BOOTSTRAP_ABSENT_CHILD = 'absent'
const BARRIER_TIMEOUT_MS = 8_000
const MAX_HARDLINK_PARENT_ENTRIES = 4_096
const sleepCell = new Int32Array(new SharedArrayBuffer(4))

// Keep every primitive before patching the public fs objects. Adapter I/O must
// never recurse through the interception layer it is implementing.
const native = {
  chmodSync: fs.chmodSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  fstatSync: fs.fstatSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  mkdtempSync: fs.mkdtempSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  readlinkSync: fs.readlinkSync.bind(fs),
  realpathSync: fs.realpathSync.native.bind(fs.realpathSync),
  renameSync: fs.renameSync.bind(fs),
  symlinkSync: fs.symlinkSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
}
const originalCallback = Object.fromEntries(['rm', 'unlink', 'rmdir', 'rename'].map(name => [name, fs[name]]))
const originalSync = Object.fromEntries(['rmSync', 'unlinkSync', 'rmdirSync', 'renameSync'].map(name => [name, fs[name]]))
const originalPromise = Object.fromEntries(['rm', 'unlink', 'rmdir', 'rename'].map(name => [name, fsp[name]]))
const originalProcessEmit = process.emit

function codedError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function refused(message, cause) {
  return codedError(REFUSED, message, cause)
}

function snapshotFailure(message, cause) {
  return codedError(SNAPSHOT, message, cause)
}

function busy(message) {
  return codedError(BUSY, message)
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino }
}

function sameStat(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function assertPrivateDirectory(configured, label) {
  if (!configured || !path.isAbsolute(configured) || path.resolve(configured) !== configured) {
    throw new Error(`${label} must be an exact absolute path`)
  }
  const before = native.lstatSync(configured)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} must name a real directory`)
  if ((before.mode & 0o077) !== 0) throw new Error(`${label} must be private to the current user`)
  const uid = process.getuid?.()
  if (uid !== undefined && before.uid !== uid) throw new Error(`${label} must be owned by the current user`)
  const canonical = native.realpathSync(configured)
  const after = native.lstatSync(configured)
  if (canonical !== configured || !sameIdentity(before, after)) throw new Error(`${label} identity changed`)
  return { path: canonical, identity: identityOf(after), device: after.dev }
}

const sandbox = assertPrivateDirectory(
  process.env.STORY_STUDIO_TEST_HARNESS_ROOT,
  'STORY_STUDIO_TEST_HARNESS_ROOT',
)
const snapshots = assertPrivateDirectory(
  process.env.STORY_STUDIO_RETAINED_SNAPSHOT_ROOT,
  'STORY_STUDIO_RETAINED_SNAPSHOT_ROOT',
)
const rootsRelative = path.relative(sandbox.path, snapshots.path)
const reverseRelative = path.relative(snapshots.path, sandbox.path)
if (
  sameIdentity(sandbox.identity, snapshots.identity)
  || rootsRelative === ''
  || (!path.isAbsolute(rootsRelative) && rootsRelative !== '..' && !rootsRelative.startsWith(`..${path.sep}`))
  || (!path.isAbsolute(reverseRelative) && reverseRelative !== '..' && !reverseRelative.startsWith(`..${path.sep}`))
) throw new Error('Retained fixture sandbox and snapshot roots must be separate, non-nested directories')
if (sandbox.device !== snapshots.device) throw new Error('Retained fixture sandbox and snapshot roots must share a device')

const bootstrapParent = native.mkdtempSync(path.join(sandbox.path, BOOTSTRAP_PARENT_PREFIX))
native.chmodSync(bootstrapParent, 0o700)
const bootstrapParentBefore = native.lstatSync(bootstrapParent)
const bootstrapUid = process.getuid?.()
if (
  !bootstrapParentBefore.isDirectory()
  || bootstrapParentBefore.isSymbolicLink()
  || (bootstrapParentBefore.mode & 0o077) !== 0
  || bootstrapParentBefore.dev !== sandbox.device
  || (bootstrapUid !== undefined && bootstrapParentBefore.uid !== bootstrapUid)
) throw new Error('Retained fixture native rm bootstrap parent is invalid')
const bootstrapIdentity = identityOf(bootstrapParentBefore)
const bootstrapTarget = path.join(bootstrapParent, BOOTSTRAP_ABSENT_CHILD)
try {
  native.lstatSync(bootstrapTarget)
  throw new Error('Retained fixture native rm bootstrap target must be absent')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
await new Promise((resolve, reject) => {
  try {
    Reflect.apply(originalCallback.rm, fs, [bootstrapTarget, { force: true }, error => {
      if (error) reject(error)
      else resolve()
    }])
  } catch (error) {
    reject(error)
  }
})
const bootstrapParentAfter = native.lstatSync(bootstrapParent)
if (
  !bootstrapParentAfter.isDirectory()
  || bootstrapParentAfter.isSymbolicLink()
  || !sameIdentity(bootstrapParentAfter, bootstrapIdentity)
  || (bootstrapParentAfter.mode & 0o077) !== 0
  || bootstrapParentAfter.dev !== sandbox.device
  || bootstrapParentAfter.uid !== bootstrapParentBefore.uid
) throw new Error('Retained fixture native rm bootstrap parent changed')
try {
  native.lstatSync(bootstrapTarget)
  throw new Error('Retained fixture native rm bootstrap target was created')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const sandboxBuffer = Buffer.from(sandbox.path)
const snapshotBuffer = Buffer.from(snapshots.path)
const lockPath = path.join(snapshots.path, LOCK_NAME)
const releasedLocksPath = path.join(snapshots.path, RELEASED_LOCKS)
native.mkdirSync(releasedLocksPath, { recursive: true, mode: 0o700 })
native.chmodSync(releasedLocksPath, 0o700)

const manifestPath = path.join(snapshots.path, `manifest-${process.pid}-${randomUUID()}.jsonl`)
// A worker thread can never emit the process 'exit' settlement (and is torn down
// abruptly with the main thread), so it must not create a manifest it cannot
// finish. Workers still intercept destructive work and refuse it below; only the
// main thread owns durable per-process evidence.
const manifestFd = isMainThread
  ? native.openSync(
    manifestPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  )
  : null
if (manifestFd !== null) fsyncDirectory(snapshots.path)

function appendRecord(record) {
  if (manifestFd === null) {
    throw refused('Retained fixture filesystem evidence belongs to the main thread')
  }
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    receiptId: record.receiptId ?? randomUUID(),
    pid: process.pid,
    timestamp: new Date().toISOString(),
    ...record,
  })}\n`)
  let offset = 0
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset
    const written = native.writeSync(manifestFd, bytes, offset, remaining)
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error('Retained fixture manifest write made no valid progress')
    }
    offset += written
  }
  native.fsyncSync(manifestFd)
}

function assertRoot(root, label) {
  const before = native.lstatSync(root.path)
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, root.identity)) {
    throw snapshotFailure(`${label} identity changed`)
  }
  if ((before.mode & 0o077) !== 0) throw snapshotFailure(`${label} is no longer private`)
  const uid = process.getuid?.()
  if (uid !== undefined && before.uid !== uid) throw snapshotFailure(`${label} owner changed`)
  const canonical = native.realpathSync(root.path)
  const after = native.lstatSync(root.path)
  if (canonical !== root.path || !sameIdentity(after, root.identity)) throw snapshotFailure(`${label} identity changed`)
}

function assertRoots() {
  assertRoot(sandbox, 'Retained fixture sandbox')
  assertRoot(snapshots, 'Retained snapshot root')
}

function pathKind(value) {
  if (typeof value === 'string') return 'string'
  if (Buffer.isBuffer(value)) return 'buffer'
  if (value instanceof URL && value.protocol === 'file:') return 'url'
  return null
}

function hasNullByte(value) {
  if (typeof value === 'string') return value.includes('\0')
  if (Buffer.isBuffer(value)) return value.includes(0)
  return false
}

function normalizeBufferPath(input) {
  if (process.platform === 'win32') throw refused('Raw Buffer paths are unsupported on this runner platform')
  const slash = 47
  const dot = Buffer.from('.')
  const dotdot = Buffer.from('..')
  const absolute = input[0] === slash ? Buffer.from(input) : Buffer.concat([Buffer.from(process.cwd()), Buffer.from('/'), input])
  const parts = []
  let start = 0
  for (let index = 0; index <= absolute.length; index += 1) {
    if (index !== absolute.length && absolute[index] !== slash) continue
    const part = absolute.subarray(start, index)
    start = index + 1
    if (part.length === 0 || part.equals(dot)) continue
    if (part.equals(dotdot)) parts.pop()
    else parts.push(Buffer.from(part))
  }
  if (parts.length === 0) return Buffer.from('/')
  return Buffer.concat([Buffer.from('/'), ...parts.flatMap((part, index) => index ? [Buffer.from('/'), part] : [part])])
}

function absolutePath(value) {
  if (Buffer.isBuffer(value)) return normalizeBufferPath(value)
  const stringPath = value instanceof URL ? fileURLToPath(value) : value
  return path.resolve(stringPath)
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

function samePath(left, right) {
  return asBuffer(left).equals(asBuffer(right))
}

function assertRawComponentsOwned(value, label) {
  if (value instanceof URL) return
  const input = asBuffer(value)
  const absolute = input[0] === 47
    ? Buffer.from(input)
    : Buffer.concat([Buffer.from(process.cwd()), Buffer.from('/'), input])
  if (!isWithin(sandboxBuffer, absolute) || absolute.equals(sandboxBuffer)) {
    throw refused(`${label} raw path is outside STORY_STUDIO_TEST_HARNESS_ROOT`)
  }

  const dot = Buffer.from('.')
  const dotdot = Buffer.from('..')
  const suffix = absolute.subarray(sandboxBuffer.length + 1)
  let current = Buffer.from(sandboxBuffer)
  let start = 0
  for (let index = 0; index <= suffix.length; index += 1) {
    if (index !== suffix.length && suffix[index] !== 47) continue
    const component = suffix.subarray(start, index)
    start = index + 1
    if (component.length === 0 || component.equals(dot)) continue
    if (component.equals(dotdot)) {
      if (current.equals(sandboxBuffer)) throw refused(`${label} raw path escaped its sandbox owner`)
      current = parentPath(current)
      if (!isWithin(sandboxBuffer, current)) throw refused(`${label} raw path escaped its sandbox owner`)
      continue
    }
    current = joinPath(current, component)
    const stat = lstatIfPresent(current)
    if (stat?.isSymbolicLink()) throw refused(`${label} raw path refuses a symbolic-link component`)
  }
}

function isWithin(root, target) {
  const rootBytes = asBuffer(root)
  const targetBytes = asBuffer(target)
  return targetBytes.equals(rootBytes)
    || (targetBytes.length > rootBytes.length
      && targetBytes.subarray(0, rootBytes.length).equals(rootBytes)
      && targetBytes[rootBytes.length] === 47)
}

function joinPath(parent, child) {
  if (!Buffer.isBuffer(parent) && !Buffer.isBuffer(child)) return path.join(parent, child)
  const parentBytes = asBuffer(parent)
  const childBytes = asBuffer(child)
  return Buffer.concat([parentBytes, Buffer.from('/'), childBytes])
}

function displayBytes(bytes) {
  let result = ''
  for (const byte of bytes) {
    if (byte === 47) result += '/'
    else if (byte >= 0x21 && byte <= 0x7e && byte !== 0x25) result += String.fromCharCode(byte)
    else result += `%${byte.toString(16).padStart(2, '0').toUpperCase()}`
  }
  return result
}

function displayName(name) {
  return Buffer.isBuffer(name) ? displayBytes(name) : name
}

function relativeTarget(target) {
  const rootBytes = sandboxBuffer
  const targetBytes = asBuffer(target)
  if (targetBytes.equals(rootBytes)) return '.'
  return displayBytes(targetBytes.subarray(rootBytes.length + 1))
}

function relativeWithin(root, target) {
  const rootBytes = asBuffer(root)
  const targetBytes = asBuffer(target)
  if (targetBytes.equals(rootBytes)) return '.'
  return displayBytes(targetBytes.subarray(rootBytes.length + 1))
}

function canonicalPath(value) {
  return native.realpathSync(value, { encoding: Buffer.isBuffer(value) ? 'buffer' : 'utf8' })
}

function resolveContained(value, label) {
  const kind = pathKind(value)
  if (!kind || hasNullByte(value)) throw refused(`${label} is not a supported filesystem path`)
  assertRawComponentsOwned(value, label)
  const absolute = absolutePath(value)
  if (!isWithin(Buffer.isBuffer(absolute) ? sandboxBuffer : sandbox.path, absolute)) {
    throw refused(`${label} is outside STORY_STUDIO_TEST_HARNESS_ROOT`)
  }
  if (samePath(absolute, Buffer.isBuffer(absolute) ? sandboxBuffer : sandbox.path)) {
    throw refused(`${label} must not be the sandbox root`)
  }
  return { absolute, kind, relative: relativeTarget(absolute) }
}

function lstatIfPresent(target) {
  try {
    return native.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function parentPath(target) {
  if (!Buffer.isBuffer(target)) return path.dirname(target)
  const index = target.lastIndexOf(47)
  return index <= 0 ? Buffer.from('/') : target.subarray(0, index)
}

function assertMissingParentContained(resolved, label) {
  let candidate = parentPath(resolved.absolute)
  while (true) {
    const stat = lstatIfPresent(candidate)
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused(`${label} parent is not a real directory`)
      const canonical = canonicalPath(candidate)
      if (!samePath(canonical, candidate) || !isWithin(Buffer.isBuffer(candidate) ? sandboxBuffer : sandbox.path, canonical)) {
        throw refused(`${label} parent escaped its sandbox owner`)
      }
      return
    }
    const parent = parentPath(candidate)
    if (samePath(parent, candidate)) throw refused(`${label} has no owned parent`)
    candidate = parent
  }
}

function inspectHardlinkAliases(target, expectedStat, expectedProof, makeError) {
  const fail = message => { throw makeError(message) }
  const targetBytes = Buffer.from(asBuffer(target))
  const parent = parentPath(targetBytes)
  if (expectedProof && !samePath(parent, expectedProof.parent)) fail('Hard-link parent path changed')

  const parentBefore = native.lstatSync(parent)
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) fail('Hard-link parent is not a real directory')
  if (parentBefore.dev !== sandbox.device) fail('Hard-link parent escaped its sandbox device')
  if (expectedProof && !sameIdentity(parentBefore, expectedProof.parentIdentity)) fail('Hard-link parent identity changed')
  const canonicalParent = canonicalPath(parent)
  const parentConfirmed = native.lstatSync(parent)
  if (
    !samePath(canonicalParent, parent)
    || !isWithin(sandboxBuffer, canonicalParent)
    || !sameIdentity(parentConfirmed, parentBefore)
  ) fail('Hard-link parent escaped its sandbox owner')

  const children = native.readdirSync(parent, { encoding: 'buffer' })
  if (children.length > MAX_HARDLINK_PARENT_ENTRIES) {
    fail(`Hard-link parent exceeds ${MAX_HARDLINK_PARENT_ENTRIES} direct entries`)
  }
  const aliases = []
  for (const child of children) {
    const candidate = joinPath(parent, child)
    const candidateStat = native.lstatSync(candidate)
    if (!sameIdentity(candidateStat, expectedStat)) continue
    if (
      !candidateStat.isFile()
      || candidateStat.isSymbolicLink()
      || candidateStat.dev !== sandbox.device
      || candidateStat.nlink !== expectedStat.nlink
      || !sameStat(candidateStat, expectedStat)
    ) fail('Hard-link alias identity changed')
    aliases.push(candidate)
  }
  aliases.sort(Buffer.compare)

  const targetAfter = native.lstatSync(targetBytes)
  if (
    !targetAfter.isFile()
    || targetAfter.isSymbolicLink()
    || targetAfter.nlink !== expectedStat.nlink
    || !sameStat(targetAfter, expectedStat)
  ) fail('Hard-link target identity changed')
  if (aliases.length !== expectedStat.nlink || !aliases.some(alias => samePath(alias, targetBytes))) {
    fail('Hard-link aliases are not complete within the owned parent')
  }

  const canonicalParentAfter = canonicalPath(parent)
  const parentAfter = native.lstatSync(parent)
  if (
    !parentAfter.isDirectory()
    || parentAfter.isSymbolicLink()
    || parentAfter.dev !== sandbox.device
    || !sameIdentity(parentAfter, parentBefore)
    || !samePath(canonicalParentAfter, parent)
    || !isWithin(sandboxBuffer, canonicalParentAfter)
  ) fail('Hard-link parent identity changed')
  if (expectedProof && !sameChildren(aliases, expectedProof.aliases)) fail('Hard-link alias set changed')

  return {
    target: targetBytes,
    parent: Buffer.from(parent),
    parentIdentity: identityOf(parentBefore),
    aliases,
  }
}

function createHardlinkProof(resolved, stat) {
  const inspected = inspectHardlinkAliases(resolved.absolute, stat, null, refused)
  return {
    ...inspected,
    sourceStat: stat,
    nlink: stat.nlink,
    receipt: {
      parent: relativeTarget(inspected.parent),
      parentIdentity: inspected.parentIdentity,
      nlink: stat.nlink,
      aliases: inspected.aliases.map(relativeTarget),
    },
  }
}

function assertHardlinkProof(proof) {
  inspectHardlinkAliases(proof.target, proof.sourceStat, proof, snapshotFailure)
}

function assertExistingAllowed(resolved, label, operation, args = []) {
  const stat = lstatIfPresent(resolved.absolute)
  if (!stat) return null
  if (stat.isSymbolicLink()) throw refused(`${label} refuses a symbolic link`)
  if (!stat.isFile() && !stat.isDirectory()) throw refused(`${label} refuses a special file`)
  if (stat.dev !== sandbox.device) throw refused(`${label} refuses a device escape`)
  const canonical = canonicalPath(resolved.absolute)
  if (!samePath(canonical, resolved.absolute) || !isWithin(Buffer.isBuffer(canonical) ? sandboxBuffer : sandbox.path, canonical)) {
    throw refused(`${label} escaped its sandbox owner`)
  }
  const confirmed = native.lstatSync(resolved.absolute)
  if (!sameIdentity(stat, confirmed)) throw snapshotFailure(`${label} identity changed`)
  let hardlinkProof = null
  if (stat.isFile() && stat.nlink !== 1) {
    const mayRemoveDirectFile = operation === 'unlink'
      || (operation === 'rm' && args[1]?.recursive !== true)
    if (!mayRemoveDirectFile || stat.nlink < 2) throw refused(`${label} refuses a hard link`)
    if (confirmed.nlink !== stat.nlink || !sameStat(stat, confirmed)) {
      throw snapshotFailure(`${label} hard-link identity changed`)
    }
    hardlinkProof = createHardlinkProof(resolved, stat)
  }
  return { stat, identity: identityOf(stat), hardlinkProof }
}

function assertPathIdentity(resolved, expected, label, hardlinkProof = null) {
  const current = native.lstatSync(resolved.absolute)
  if (!sameIdentity(current, expected) || current.isSymbolicLink()) throw snapshotFailure(`${label} identity changed`)
  if ((!current.isFile() && !current.isDirectory()) || current.dev !== sandbox.device) {
    throw snapshotFailure(`${label} type or device changed`)
  }
  if (current.isFile() && current.nlink !== (hardlinkProof?.nlink ?? 1)) {
    throw snapshotFailure(`${label} hard-link count changed`)
  }
  const canonical = canonicalPath(resolved.absolute)
  if (!samePath(canonical, resolved.absolute)) throw snapshotFailure(`${label} path changed`)
  if (hardlinkProof) assertHardlinkProof(hardlinkProof)
}

function sortedChildren(directory) {
  const options = Buffer.isBuffer(directory) ? { encoding: 'buffer' } : { encoding: 'utf8' }
  const children = native.readdirSync(directory, options)
  children.sort((left, right) => Buffer.isBuffer(left) ? Buffer.compare(left, right) : left.localeCompare(right))
  return children
}

function sameChildren(left, right) {
  return left.length === right.length && left.every((entry, index) => samePath(entry, right[index]))
}

function readStableFile(source, ownerRoot, relative, hardlinkProof = null) {
  const before = native.lstatSync(source)
  if (!before.isFile() || before.isSymbolicLink()) throw refused(`Retained source refuses a special file at ${relative}`)
  if (before.dev !== sandbox.device) throw refused(`Retained source refuses a device escape at ${relative}`)
  if (before.nlink !== (hardlinkProof?.nlink ?? 1)) {
    if (hardlinkProof) throw snapshotFailure(`Retained source hard-link count changed at ${relative}`)
    throw refused(`Retained source refuses a hard link at ${relative}`)
  }
  const canonical = canonicalPath(source)
  if (!samePath(canonical, source) || !isWithin(ownerRoot, canonical)) throw snapshotFailure(`Retained source path changed at ${relative}`)
  if (hardlinkProof) assertHardlinkProof(hardlinkProof)
  const descriptor = native.openSync(
    source,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
  )
  try {
    const opened = native.fstatSync(descriptor)
    if (
      !opened.isFile()
      || opened.nlink !== (hardlinkProof?.nlink ?? 1)
      || !sameIdentity(opened, before)
      || (hardlinkProof && !sameStat(opened, before))
    ) {
      throw snapshotFailure(`Retained source changed while opening ${relative}`)
    }
    const bytes = native.readFileSync(descriptor)
    const afterRead = native.fstatSync(descriptor)
    if (!sameStat(opened, afterRead)) throw snapshotFailure(`Retained source changed while reading ${relative}`)
    const after = native.lstatSync(source)
    if (
      !after.isFile()
      || after.nlink !== (hardlinkProof?.nlink ?? 1)
      || !sameStat(before, after)
    ) throw snapshotFailure(`Retained source changed after reading ${relative}`)
    if (hardlinkProof) assertHardlinkProof(hardlinkProof)
    return bytes
  } finally {
    native.closeSync(descriptor)
  }
}

function inventoryTree(ownerRoot, target, expectedIdentity, hardlinkProof = null) {
  const rootStat = native.lstatSync(target)
  if (expectedIdentity && !sameIdentity(rootStat, expectedIdentity)) throw snapshotFailure('Inventory root identity changed')
  if (rootStat.isSymbolicLink()) throw refused('Retained inventory refuses a symbolic link')
  const canonical = canonicalPath(target)
  if (!samePath(canonical, target) || !isWithin(ownerRoot, canonical)) throw snapshotFailure('Retained inventory path escaped')
  const entries = []

  function visit(absolute, relative) {
    const before = native.lstatSync(absolute)
    if (before.dev !== sandbox.device) throw refused(`Retained inventory refuses a device escape at ${relative || '.'}`)
    if (before.isSymbolicLink()) {
      // Retain the link OBJECT only: never canonicalize, read through, or copy
      // its target. The target text is evidence; its contents belong elsewhere.
      const target = native.readlinkSync(absolute, { encoding: 'buffer' })
      const confirmed = native.lstatSync(absolute)
      if (
        !confirmed.isSymbolicLink()
        || !sameStat(before, confirmed)
        || !samePath(native.readlinkSync(absolute, { encoding: 'buffer' }), target)
      ) throw snapshotFailure(`Retained inventory symlink changed at ${relative || '.'}`)
      entries.push({ path: relative || '.', type: 'symlink', target: displayBytes(target) })
      return
    }
    const canonicalEntry = canonicalPath(absolute)
    const confirmed = native.lstatSync(absolute)
    if (!samePath(canonicalEntry, absolute) || !isWithin(ownerRoot, canonicalEntry) || !sameIdentity(confirmed, before)) {
      throw snapshotFailure(`Retained inventory path changed at ${relative || '.'}`)
    }
    if (before.isDirectory()) {
      entries.push({ path: relative || '.', type: 'directory' })
      const children = sortedChildren(absolute)
      for (const child of children) {
        const childRelative = relative ? `${relative}/${displayName(child)}` : displayName(child)
        visit(joinPath(absolute, child), childRelative)
      }
      const childrenAfter = sortedChildren(absolute)
      const after = native.lstatSync(absolute)
      if (!sameIdentity(after, before) || !sameChildren(children, childrenAfter)) {
        throw snapshotFailure(`Retained directory changed while reading ${relative || '.'}`)
      }
      return
    }
    if (!before.isFile()) throw refused(`Retained inventory refuses a special file at ${relative || '.'}`)
    const bytes = readStableFile(absolute, ownerRoot, relative || '.', relative === '' ? hardlinkProof : null)
    entries.push({
      path: relative || '.',
      type: 'file',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }

  visit(target, '')
  return { root: relativeWithin(ownerRoot, target), entries }
}

function sameEntries(left, right) {
  return JSON.stringify(left.entries) === JSON.stringify(right.entries)
}

function fsyncDirectory(directory) {
  const descriptor = native.openSync(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  try {
    native.fsyncSync(descriptor)
  } finally {
    native.closeSync(descriptor)
  }
}

function writeExclusiveFile(target, bytes, mode = 0o600) {
  const descriptor = native.openSync(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  )
  try {
    native.writeFileSync(descriptor, bytes)
    native.fsyncSync(descriptor)
  } finally {
    native.closeSync(descriptor)
  }
}

function copyEntry(source, destination, sourceOwner, assertDestination, relative = '', hardlinkProof = null) {
  const before = native.lstatSync(source)
  if (before.isSymbolicLink()) {
    if (before.dev !== sandbox.device) throw refused(`Snapshot refuses a device escape at ${relative || '.'}`)
    // Recreate the link object with the same target text. Never follow it, so a
    // link that points outside the fixture cannot smuggle foreign bytes in.
    const target = native.readlinkSync(source, { encoding: 'buffer' })
    assertDestination()
    native.symlinkSync(target, destination)
    const after = native.lstatSync(source)
    if (
      !after.isSymbolicLink()
      || !sameStat(before, after)
      || !samePath(native.readlinkSync(source, { encoding: 'buffer' }), target)
    ) throw snapshotFailure(`Snapshot source symlink changed at ${relative || '.'}`)
    return
  }
  if (before.dev !== sandbox.device) throw refused(`Snapshot refuses a device escape at ${relative || '.'}`)
  const canonical = canonicalPath(source)
  if (!samePath(canonical, source) || !isWithin(sourceOwner, canonical)) {
    throw snapshotFailure(`Snapshot source changed at ${relative || '.'}`)
  }
  assertDestination()
  if (before.isDirectory()) {
    native.mkdirSync(destination, { mode: 0o700 })
    const children = sortedChildren(source)
    for (const child of children) {
      const childRelative = relative ? `${relative}/${displayName(child)}` : displayName(child)
      copyEntry(joinPath(source, child), joinPath(destination, child), sourceOwner, assertDestination, childRelative)
    }
    const childrenAfter = sortedChildren(source)
    const after = native.lstatSync(source)
    if (!sameIdentity(before, after) || !sameChildren(children, childrenAfter)) {
      throw snapshotFailure(`Snapshot source changed while copying ${relative || '.'}`)
    }
    fsyncDirectory(destination)
    return
  }
  if (!before.isFile()) throw refused(`Snapshot refuses a special file at ${relative || '.'}`)
  const bytes = readStableFile(source, sourceOwner, relative || '.', relative === '' ? hardlinkProof : null)
  assertDestination()
  writeExclusiveFile(destination, bytes)
}

function makeReadOnly(target) {
  const stat = native.lstatSync(target)
  // chmod and open both follow links; a retained link's target is not ours.
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const child of sortedChildren(target)) makeReadOnly(joinPath(target, child))
    native.chmodSync(target, 0o500)
    fsyncDirectory(target)
  } else {
    native.chmodSync(target, 0o400)
    const descriptor = native.openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      native.fsyncSync(descriptor)
    } finally {
      native.closeSync(descriptor)
    }
  }
}

function assertReadOnlyTree(target) {
  const stat = native.lstatSync(target)
  if (stat.isSymbolicLink()) return
  if ((stat.mode & 0o222) !== 0) throw snapshotFailure('Snapshot payload remained writable')
  if (stat.isDirectory()) {
    for (const child of sortedChildren(target)) assertReadOnlyTree(joinPath(target, child))
  }
}

function readBarrierPhase() {
  const control = path.join(snapshots.path, BARRIER_CONTROL)
  if (!native.existsSync(control)) return null
  let parsed
  try {
    parsed = JSON.parse(native.readFileSync(control, 'utf8'))
  } catch (error) {
    throw snapshotFailure('Retained fixture test barrier is invalid', error)
  }
  if (!parsed || !['after-baseline', 'before-final-verification'].includes(parsed.phase)) {
    throw snapshotFailure('Retained fixture test barrier phase is invalid')
  }
  return parsed.phase
}

function crossBarrier(phase, target, sourceInventory, snapshotInventory) {
  if (readBarrierPhase() !== phase) return
  const reached = path.join(snapshots.path, BARRIER_REACHED)
  writeExclusiveFile(reached, `${JSON.stringify({ phase, target, sourceInventory, snapshotInventory })}\n`)
  fsyncDirectory(snapshots.path)
  const resume = path.join(snapshots.path, BARRIER_RESUME)
  const deadline = Date.now() + BARRIER_TIMEOUT_MS
  while (!native.existsSync(resume)) {
    if (Date.now() >= deadline) throw snapshotFailure(`Retained fixture test barrier timed out at ${phase}`)
    Atomics.wait(sleepCell, 0, 0, 10)
  }
  if (native.readFileSync(resume, 'utf8') !== `${phase}\n`) {
    throw snapshotFailure(`Retained fixture test barrier resume mismatch at ${phase}`)
  }
}

function createLock() {
  assertRoots()
  native.mkdirSync(lockPath, { mode: 0o700 })
  writeExclusiveFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })}\n`)
  fsyncDirectory(lockPath)
  fsyncDirectory(snapshots.path)
  let released = false
  return () => {
    if (released) return
    released = true
    assertRoot(snapshots, 'Retained snapshot root')
    const destination = path.join(releasedLocksPath, `${process.pid}-${Date.now()}-${randomUUID()}`)
    native.renameSync(lockPath, destination)
    fsyncDirectory(releasedLocksPath)
    fsyncDirectory(snapshots.path)
  }
}

function acquireLockSync() {
  try {
    return createLock()
  } catch (error) {
    if (error?.code === 'EEXIST') throw busy('Retained fixture filesystem lock is busy')
    if (error?.code === REFUSED || error?.code === SNAPSHOT) throw error
    throw snapshotFailure('Unable to acquire retained fixture filesystem lock', error)
  }
}

async function acquireLockAsync() {
  while (true) {
    try {
      return createLock()
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (error?.code === REFUSED || error?.code === SNAPSHOT) throw error
        throw snapshotFailure('Unable to acquire retained fixture filesystem lock', error)
      }
      // The outer process watchdog bounds abandoned locks; never reclaim one.
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

function sanitizeOptions(operation, args) {
  if (
    operation === 'rename'
    || operation === 'unlink'
    || args[1] === undefined
    || args[1] === null
    || typeof args[1] !== 'object'
  ) return {}
  const allowed = operation === 'rm'
    ? ['force', 'maxRetries', 'recursive', 'retryDelay']
    : ['maxRetries', 'recursive', 'retryDelay']
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(args[1], key)).map(key => [key, args[1][key]]))
}

function optionsShapeIsNative(operation, api, args) {
  if (operation === 'rename' || operation === 'unlink' || args[1] === undefined) return true
  if (typeof args[1] === 'function') return api === 'callback'
  if (operation === 'rm' && args[1] === null) return true
  const options = args[1]
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false
  for (const key of ['force', 'recursive']) {
    if (Object.hasOwn(options, key) && typeof options[key] !== 'boolean') return false
  }
  for (const key of ['maxRetries', 'retryDelay']) {
    if (Object.hasOwn(options, key)
      && (!Number.isInteger(options[key]) || options[key] < 0)) return false
  }
  return true
}

function operationPathsAreSupported(operation, api, args) {
  const indexes = operation === 'rename' ? [0, 1] : [0]
  return indexes.every(index => pathKind(args[index]) && !hasNullByte(args[index]))
    && optionsShapeIsNative(operation, api, args)
}

function callbackIndex(operation, args) {
  if (operation === 'unlink') return 1
  if (operation === 'rename') return 2
  return typeof args[1] === 'function' ? 1 : 2
}

function normalizeCaptureError(error) {
  if ([REFUSED, SNAPSHOT, BUSY].includes(error?.code)) return error
  return snapshotFailure(`Retained fixture snapshot failed: ${error?.message ?? String(error)}`, error)
}

function captureLocked(operation, api, args, release) {
  const receiptId = randomUUID()
  let targetRelative = 'not-validated'
  try {
    assertRoots()
    const sourceResolved = operation === 'rename' ? resolveContained(args[0], 'Rename source') : null
    const targetResolved = resolveContained(args[operation === 'rename' ? 1 : 0], 'Destructive target')
    targetRelative = targetResolved.relative
    const sourceExisting = sourceResolved ? assertExistingAllowed(sourceResolved, 'Rename source') : null
    if (sourceResolved && !sourceExisting) {
      assertMissingParentContained(sourceResolved, 'Rename source')
      release()
      return null
    }
    if (sourceResolved && samePath(sourceResolved.absolute, targetResolved.absolute)) {
      release()
      return null
    }
    const targetExisting = assertExistingAllowed(targetResolved, 'Destructive target', operation, args)
    if (!targetExisting) {
      assertMissingParentContained(targetResolved, 'Destructive target')
      release()
      return null
    }
    if (!isMainThread) {
      // Refuse rather than perform a destructive operation that this thread can
      // never settle into durable, reconcilable evidence.
      release()
      throw refused('Retained fixture destructive operations are unsupported in a worker thread')
    }

    const sourceInventory = inventoryTree(
      Buffer.isBuffer(targetResolved.absolute) ? sandboxBuffer : sandbox.path,
      targetResolved.absolute,
      targetExisting.identity,
      targetExisting.hardlinkProof,
    )
    crossBarrier('after-baseline', targetRelative, sourceInventory)
    assertRoots()

    const snapshotDir = native.mkdtempSync(path.join(snapshots.path, 'snapshot-'))
    native.chmodSync(snapshotDir, 0o700)
    const snapshotStat = native.lstatSync(snapshotDir)
    const snapshotIdentity = identityOf(snapshotStat)
    const payloadString = path.join(snapshotDir, 'payload')
    const payload = Buffer.isBuffer(targetResolved.absolute) ? Buffer.from(payloadString) : payloadString
    const assertDestination = () => {
      assertRoot(snapshots, 'Retained snapshot root')
      const current = native.lstatSync(snapshotDir)
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, snapshotIdentity)) {
        throw snapshotFailure('Snapshot destination identity changed')
      }
    }
    copyEntry(
      targetResolved.absolute,
      payload,
      Buffer.isBuffer(targetResolved.absolute) ? sandboxBuffer : sandbox.path,
      assertDestination,
      '',
      targetExisting.hardlinkProof,
    )
    makeReadOnly(payload)
    native.chmodSync(snapshotDir, 0o500)
    fsyncDirectory(snapshotDir)
    fsyncDirectory(snapshots.path)

    const sourceAfter = inventoryTree(
      Buffer.isBuffer(targetResolved.absolute) ? sandboxBuffer : sandbox.path,
      targetResolved.absolute,
      targetExisting.identity,
      targetExisting.hardlinkProof,
    )
    const snapshotInventory = inventoryTree(
      Buffer.isBuffer(payload) ? snapshotBuffer : snapshots.path,
      payload,
      native.lstatSync(payload),
    )
    if (!sameEntries(sourceInventory, sourceAfter) || !sameEntries(sourceInventory, snapshotInventory)) {
      throw snapshotFailure('Snapshot inventory does not match the destructive target')
    }
    crossBarrier('before-final-verification', targetRelative, sourceAfter, snapshotInventory)

    // Every fallible confirmation is complete before the durable verified record.
    assertRoots()
    assertPathIdentity(targetResolved, targetExisting.identity, 'Destructive target', targetExisting.hardlinkProof)
    if (sourceResolved) assertPathIdentity(sourceResolved, sourceExisting.identity, 'Rename source')
    assertDestination()
    if ((native.lstatSync(snapshotDir).mode & 0o222) !== 0) throw snapshotFailure('Snapshot directory remained writable')
    assertReadOnlyTree(payload)
    const finalSourceInventory = inventoryTree(
      Buffer.isBuffer(targetResolved.absolute) ? sandboxBuffer : sandbox.path,
      targetResolved.absolute,
      targetExisting.identity,
      targetExisting.hardlinkProof,
    )
    const finalSnapshotInventory = inventoryTree(
      Buffer.isBuffer(payload) ? snapshotBuffer : snapshots.path,
      payload,
      native.lstatSync(payload),
    )
    if (
      !sameEntries(sourceInventory, finalSourceInventory)
      || !sameEntries(snapshotInventory, finalSnapshotInventory)
      || !sameEntries(finalSourceInventory, finalSnapshotInventory)
    ) throw snapshotFailure('Final retained fixture verification failed')
    if (targetExisting.hardlinkProof) assertHardlinkProof(targetExisting.hardlinkProof)

    const record = {
      receiptId,
      phase: 'snapshot-verified',
      operation,
      api,
      target: targetRelative,
      argumentKind: targetResolved.kind,
      options: sanitizeOptions(operation, args),
      sourceIdentity: targetExisting.identity,
      snapshot: path.basename(snapshotDir),
      payload: 'payload',
      sourceInventory: finalSourceInventory,
      snapshotInventory: finalSnapshotInventory,
    }
    if (targetExisting.hardlinkProof) record.hardlinkProof = targetExisting.hardlinkProof.receipt
    if (sourceResolved) record.source = sourceResolved.relative
    appendRecord(record)
    return { receiptId, release }
  } catch (error) {
    const normalized = normalizeCaptureError(error)
    try {
      appendRecord({
        receiptId,
        phase: 'snapshot-refused',
        operation,
        api,
        target: targetRelative,
        error: normalized.message,
        code: normalized.code,
      })
    } catch { /* an incomplete manifest is itself failed evidence */ }
    try { release() } catch { /* retain the active lock as failure evidence */ }
    throw normalized
  }
}

let activeOperations = 0
let pendingCaptures = 0

function settleOperation(capture, error) {
  try {
    appendRecord({
      receiptId: capture.receiptId,
      phase: 'operation-settled',
      outcome: error ? 'error' : 'success',
      ...(error ? { error: error.name, code: error.code } : {}),
    })
  } catch { /* preserve the original operation outcome; reconciliation will fail */ }
  try { capture.release() } catch { /* the retained active lock makes reconciliation fail */ }
  activeOperations -= 1
}

function invokeSync(operation, original, receiver, args) {
  if (!operationPathsAreSupported(operation, 'sync', args)) return Reflect.apply(original, receiver, args)
  const release = acquireLockSync()
  const capture = captureLocked(operation, 'sync', args, release)
  if (!capture) return Reflect.apply(original, receiver, args)
  activeOperations += 1
  try {
    const value = Reflect.apply(original, receiver, args)
    settleOperation(capture)
    return value
  } catch (error) {
    settleOperation(capture, error)
    throw error
  }
}

function invokePromise(operation, original, receiver, args) {
  if (!operationPathsAreSupported(operation, 'promise', args)) return Reflect.apply(original, receiver, args)
  pendingCaptures += 1
  return acquireLockAsync().then(release => captureLocked(operation, 'promise', args, release)).then(
    capture => {
      if (capture) activeOperations += 1
      pendingCaptures -= 1
      if (!capture) return Reflect.apply(original, receiver, args)
      let outcome
      try {
        outcome = Reflect.apply(original, receiver, args)
      } catch (error) {
        settleOperation(capture, error)
        throw error
      }
      return Promise.resolve(outcome).then(
        value => {
          settleOperation(capture)
          return value
        },
        error => {
          settleOperation(capture, error)
          throw error
        },
      )
    },
    error => {
      pendingCaptures -= 1
      throw error
    },
  )
}

function invokeCallback(operation, original, receiver, args) {
  const index = callbackIndex(operation, args)
  const callback = args[index]
  const pathsSupported = operationPathsAreSupported(operation, 'callback', args)
  if (operation === 'rm' && pathsSupported && typeof callback !== 'function') {
    throw refused('Retained fixture rm requires a callback before native dispatch')
  }
  if (typeof callback !== 'function' || !pathsSupported) {
    return Reflect.apply(original, receiver, args)
  }
  pendingCaptures += 1
  acquireLockAsync().then(
    release => captureLocked(operation, 'callback', args, release),
  ).then(
    capture => {
      if (capture) activeOperations += 1
      pendingCaptures -= 1
      if (!capture) return Reflect.apply(original, receiver, args)
      const forwarded = args.slice()
      forwarded[index] = function retainedCallback(...callbackArgs) {
        settleOperation(capture, callbackArgs[0])
        return Reflect.apply(callback, this, callbackArgs)
      }
      try {
        return Reflect.apply(original, receiver, forwarded)
      } catch (error) {
        settleOperation(capture, error)
        throw error
      }
    },
    error => {
      pendingCaptures -= 1
      process.nextTick(() => callback(error))
    },
  )
  return undefined
}

for (const operation of ['rm', 'unlink', 'rmdir', 'rename']) {
  fs[operation] = function retainedCallbackApi(...args) {
    return invokeCallback(operation, originalCallback[operation], this, args)
  }
  const syncName = `${operation}Sync`
  fs[syncName] = function retainedSyncApi(...args) {
    return invokeSync(operation, originalSync[syncName], this, args)
  }
  const retainedPromiseApi = function retainedPromiseApi(...args) {
    return invokePromise(operation, originalPromise[operation], this, args)
  }
  fsp[operation] = retainedPromiseApi
  fs.promises[operation] = retainedPromiseApi
}
syncBuiltinESMExports()

let finalRecordWritten = false
function retainedSigtermListener() { /* activate Node's OS signal delivery */ }
process.emit = function retainedProcessEmit(event, ...args) {
  if (this === process && event === 'SIGTERM' && args.length === 2
    && args[0] === 'SIGTERM' && args[1] === osConstants.signals.SIGTERM) {
    const listeners = process.rawListeners('SIGTERM')
    if (listeners.length === 1 && listeners[0] === retainedSigtermListener) {
      try {
        if (!finalRecordWritten) {
          finalRecordWritten = true
          appendRecord({
            phase: activeOperations === 0 && pendingCaptures === 0 ? 'child-signal-settled' : 'child-signal-unsettled',
            signal: 'SIGTERM',
            activeOperations,
            pendingCaptures,
          })
        }
      } catch { /* missing or partial final evidence fails reconciliation */ }
      finally {
        try { process.removeListener('SIGTERM', retainedSigtermListener) }
        finally { process.kill(process.pid, 'SIGTERM') }
      }
      return true
    }
    // Inspect before dispatch: once/prepended application listeners may remove themselves.
    return Reflect.apply(originalProcessEmit, this, [event, ...args])
  }
  if (event !== 'exit') return Reflect.apply(originalProcessEmit, this, [event, ...args])
  let emitted
  try {
    emitted = Reflect.apply(originalProcessEmit, this, [event, ...args])
  } catch (error) {
    if (!finalRecordWritten && manifestFd !== null) {
      finalRecordWritten = true
      try {
        appendRecord({
          phase: 'child-unsettled',
          exitCode: args[0],
          activeOperations,
          pendingCaptures,
          error: error.name,
          code: error.code,
        })
      } catch { /* absence of successful final evidence fails reconciliation */ }
    }
    throw error
  }
  if (!finalRecordWritten && manifestFd !== null) {
    finalRecordWritten = true
    appendRecord({
      phase: activeOperations === 0 && pendingCaptures === 0 ? 'child-settled' : 'child-unsettled',
      exitCode: args[0],
      activeOperations,
      pendingCaptures,
    })
  }
  return emitted
}
process.on('SIGTERM', retainedSigtermListener)
