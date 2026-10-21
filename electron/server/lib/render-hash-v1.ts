import { createHash } from 'node:crypto'
import { types } from 'node:util'

/** Render-only identity bytes, not a DTO validator, signature or authorization.
 * Outbound trusted plain data only: there is deliberately no raw JSON decoder.
 * Callers must validate their closed schema before hashing. No NFC normalization.
 */
export type RenderHashKind = 'recipe' | 'manifest' | 'packet' | 'gateway-envelope' | 'hub-envelope'
const KINDS = new Set<string>(['recipe', 'manifest', 'packet', 'gateway-envelope', 'hub-envelope'])
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_BYTES = 1024 * 1024
const MAX_STRING_BYTES = 256 * 1024
const MAX_VISITS = 65536
const MAX_DEPTH = 32 // Root is depth zero; keys and values each count as a visit.

function invalid(reason: string): never {
  throw new Error(`Invalid render hash value: ${reason}`)
}

function stringBytes(value: string): Buffer {
  if (value.length > MAX_STRING_BYTES) invalid('string exceeds 256 KiB')
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++i)
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid('unpaired surrogate')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid('unpaired surrogate')
  }
  const length = Buffer.byteLength(value, 'utf8')
  if (length > MAX_STRING_BYTES) invalid('string exceeds 256 KiB')
  return Buffer.from(value, 'utf8')
}

function encode(value: unknown, prefix: Buffer): Buffer {
  const chunks: Buffer[] = []
  const active = new Set<object>()
  let bytes = 0
  let visits = 0
  function emit(part: Buffer | string): void {
    const length = typeof part === 'string' ? Buffer.byteLength(part, 'ascii') : part.length
    if (bytes + length > MAX_BYTES) invalid('preimage exceeds 1 MiB')
    bytes += length
    chunks.push(typeof part === 'string' ? Buffer.from(part, 'ascii') : part)
  }
  function walk(item: unknown, depth: number): void {
    if (depth > MAX_DEPTH) invalid('depth exceeds 32')
    if (++visits > MAX_VISITS) invalid('value/key visits exceed 65536')
    if (item === null) { emit('n'); return }
    if (typeof item === 'boolean') { emit(item ? 't' : 'f'); return }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        invalid('number must be finite with safe integral magnitude')
      }
      const number = Buffer.allocUnsafe(9)
      number[0] = 0x64
      number.writeDoubleBE(item === 0 ? 0 : item, 1)
      emit(number)
      return
    }
    if (typeof item === 'string') {
      const text = stringBytes(item)
      emit(`s${text.length}:`); emit(text)
      return
    }
    if (typeof item !== 'object' || types.isProxy(item)) invalid('plain JSON data required')
    if (active.has(item)) invalid('cycle')
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      invalid('unsupported prototype')
    }
    if (array && item.length > MAX_VISITS - visits) invalid('value/key visits exceed 65536')
    // Reflection allocates a key list on already-trusted outbound data. Bound it
    // before sorting or descriptors; this is not an untrusted-object sandbox.
    const keys = Reflect.ownKeys(item)
    if (array ? keys.length !== item.length + 1 : keys.length * 2 > MAX_VISITS - visits) {
      invalid('array properties or value/key visit limit')
    }
    if (keys.some(key => typeof key !== 'string')) invalid('symbol key')
    active.add(item)
    if (array) {
      emit(`a${item.length}:`)
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid('sparse/accessor array')
        walk(descriptor.value, depth + 1)
      }
    } else {
      const names = keys as string[]
      for (const key of names) {
        if (/[^\x20-\x7e]/.test(key) || UNSAFE_KEYS.has(key)) invalid('unsafe or non-ASCII object key')
      }
      names.sort() // ASCII bytes, never locale ordering or JS numeric-key ordering.
      emit(`o${names.length}:`)
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!descriptor.enumerable || !('value' in descriptor)) invalid('hidden/accessor property')
        walk(key, depth + 1)
        walk(descriptor.value, depth + 1)
      }
    }
    active.delete(item)
  }
  emit(prefix)
  walk(value, 0)
  return Buffer.concat(chunks, bytes)
}

/** C(value), with the same static bounds as a complete domain preimage. */
export function canonicalRenderValue(value: unknown): Buffer {
  return encode(value, Buffer.alloc(0))
}

/** The 1 MiB bound includes the prefix and closed kind, not just C(value). */
export function renderHashPreimage(kind: RenderHashKind, value: unknown): Buffer {
  if (typeof kind !== 'string' || !KINDS.has(kind)) invalid('unsupported hash kind')
  return encode(value, Buffer.from(`studio.render.hash.v1\0${kind}\0`, 'ascii'))
}

export function renderHash(kind: RenderHashKind, value: unknown): string {
  return createHash('sha256').update(renderHashPreimage(kind, value)).digest('hex')
}
