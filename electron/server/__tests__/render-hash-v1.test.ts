import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/render-hash-v1-vectors.json', import.meta.url), 'utf8')).vectors
const codec = () => import('../lib/render-hash-v1.js')
const MiB = 1024 * 1024
const KiB = 1024

test('literal cross-language vectors preserve typed bytes and all five domains', async () => {
  const { canonicalRenderValue, renderHashPreimage, renderHash } = await codec()
  for (const v of vectors) {
    const value = JSON.parse(v.json)
    assert.equal(canonicalRenderValue(value).toString('hex'), v.canonical_hex, v.name)
    for (const [kind, expected] of Object.entries(v.domains) as [any, any][]) {
      assert.equal(renderHashPreimage(kind, value).toString('hex'), expected.preimage_hex, `${v.name}/${kind}`)
      assert.equal(renderHash(kind, value), expected.sha256, `${v.name}/${kind}`)
    }
  }
})

test('rejects non-JSON numbers and runtime values without coercion', async () => {
  const { canonicalRenderValue: c } = await codec()
  for (const value of [NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), undefined, 1n, Symbol('x'), () => 1,
    new Number(1), new String('x'), new Boolean(false), new Date(), new Map(), new Set(), Buffer.from('x')]) {
    assert.throws(() => c(value), String(value))
  }
})

test('refuses lone surrogates, unsafe keys and unsupported kinds', async () => {
  const { canonicalRenderValue: c, renderHash: hash } = await codec()
  for (const text of ['\ud800', '\udfff', 'x\ud800y']) assert.throws(() => c(text))
  for (const key of ['é', '\0', '\n', '\x7f', '__proto__', 'prototype', 'constructor']) {
    assert.throws(() => c({ [key]: null }), key)
  }
  for (const kind of ['', 'Recipe', 'recipe\0', 'asset', '__proto__', null, 1, new String('recipe')]) {
    assert.throws(() => hash(kind as any, {}))
  }
  assert.equal(c(Object.assign(Object.create(null), { a: null })).toString(), 'o1:s1:an')
  assert.doesNotThrow(() => c({ future_ascii_key: null })) // Codec is not the DTO whitelist.
})

test('refuses sparse, extended and altered-prototype arrays', async () => {
  const { canonicalRenderValue: c } = await codec()
  for (const array of [Array(1), [undefined], Object.assign([], { extra: 1 }),
    Object.assign([], { [Symbol('x')]: 1 }), Object.setPrototypeOf([], null)]) assert.throws(() => c(array))
})

test('refuses accessors, hidden properties, symbols and proxies without executing them', async () => {
  const { canonicalRenderValue: c } = await codec()
  let accessed = 0
  const getter = { get x() { accessed++; return 1 } }
  const array = [1]
  Object.defineProperty(array, '0', { get() { accessed++; return 1 } })
  const proxy = new Proxy({}, { ownKeys() { accessed++; throw Error('trap executed') } })
  for (const value of [getter, array, proxy, Object.create({ x: 1 }),
    Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('x')]: 1 }]) assert.throws(() => c(value))
  assert.equal(accessed, 0)
})

test('rejects cycles but hashes repeated noncyclic references by value', async () => {
  const { canonicalRenderValue: c } = await codec()
  const a: any[] = []; a.push(a)
  const o: any = {}; o.self = o
  assert.throws(() => c(a)); assert.throws(() => c(o))
  const leaf = { a: null }
  assert.deepEqual(c([leaf, leaf]), c([{ a: null }, { a: null }]))
})

test('enforces exact string byte bounds including multibyte scalars', async () => {
  const { canonicalRenderValue: c } = await codec()
  assert.doesNotThrow(() => c('a'.repeat(256 * KiB)))
  assert.throws(() => c('a'.repeat(256 * KiB + 1)))
  assert.doesNotThrow(() => c('😀'.repeat(64 * KiB)))
  assert.throws(() => c('😀'.repeat(64 * KiB + 1)))
  assert.throws(() => c({ ['a'.repeat(256 * KiB + 1)]: 1 }))
})

test('depth is root-zero and capped before recursion can grow', async () => {
  const { canonicalRenderValue: c } = await codec()
  let nested: any = null
  for (let i = 0; i < 32; i++) nested = [nested]
  assert.doesNotThrow(() => c(nested))
  assert.throws(() => c([nested]))
})

test('counts object keys and values and bounds arrays before walking them', async () => {
  const { canonicalRenderValue: c } = await codec()
  assert.doesNotThrow(() => c(Array(65535).fill(null)))
  assert.throws(() => c(Array(65536).fill(null)))
  const object = Object.fromEntries(Array.from({ length: 32767 }, (_, i) => [`k${i}`, null]))
  assert.doesNotThrow(() => c(object))
  object.next = null
  assert.throws(() => c(object))
  assert.throws(() => c(Array(2 ** 32 - 1)))
})

test('caps encoded bytes exactly and counts the hash domain prefix', async () => {
  const { canonicalRenderValue: c, renderHashPreimage: pre } = await codec()
  // a4: (3) + four s262xxx: headers (4*8) + payload.
  const value = ['a'.repeat(256 * KiB), 'b'.repeat(256 * KiB), 'c'.repeat(256 * KiB), 'd'.repeat(256 * KiB - 35)]
  assert.equal(c(value).length, MiB)
  assert.throws(() => pre('recipe', value))
  value[3] = value[3]!.slice(29) // literal 29-byte recipe domain prefix
  assert.equal(pre('recipe', value).length, MiB)
  value[3] += 'd'
  assert.throws(() => pre('recipe', value))
  value[3] += 'd'.repeat(29)
  assert.throws(() => c(value))
})
