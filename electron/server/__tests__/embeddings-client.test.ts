/**
 * The embedding trust boundary (1.4.316).
 *
 * `POST /v1/embeddings` is the one place a vector enters the app from outside it.
 * The Gateway's contract (gateway/api.py:1968) always sends `index` as a 0-based
 * integer, so a repeated or out-of-range index is a malformed answer rather than a
 * possible one — and it matters, because the caller caches each vector under the
 * text it was asked for and reuses that cache for the rest of the run. A vector
 * filed under the wrong text is wrong for every later batch too.
 *
 * Everything here is pure: no network, no Gateway.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { readEmbeddingVectors } from '../lib/embeddings-client.js'

let cleanup: () => Promise<void>

before(async () => {
  // Points STORY_STUDIO_DATA_DIR at a
  // throwaway dir before any test body runs, matching the other backend tests.
  cleanup = (await useTempDataDir()).cleanup
})

after(async () => { await cleanup() })

describe('reading an embeddings response', () => {
  test('a well-formed answer comes back in input order, made unit', () => {
    const vectors = readEmbeddingVectors([
      { object: 'embedding', index: 0, embedding: [3, 4] },
      { object: 'embedding', index: 1, embedding: [0, 5] },
    ], 2, null)
    assert.deepEqual(vectors, [[0.6, 0.8], [0, 1]])
  })

  test('the index decides the order, not the position in the array', () => {
    const vectors = readEmbeddingVectors([
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ], 2, null)
    assert.deepEqual(vectors, [[1, 0], [0, 1]])
  })

  test('a numeric-string index is accepted, as the sort it replaces used to coerce', () => {
    const vectors = readEmbeddingVectors([
      { index: '1', embedding: [0, 1] },
      { index: '0', embedding: [1, 0] },
    ], 2, null)
    assert.deepEqual(vectors, [[1, 0], [0, 1]])
  })

  test('an answer that names no index at all falls back to array order', () => {
    // The Gateway always names one; this is the tolerance the code this replaces
    // had (`a.index - b.index` was NaN, which left the array untouched), kept so a
    // peer that omits the field cannot switch embeddings off for every channel.
    const vectors = readEmbeddingVectors([
      { embedding: [1, 0] },
      { embedding: [0, 1] },
    ], 2, null)
    assert.deepEqual(vectors, [[1, 0], [0, 1]])
  })

  test('a batch where only some rows name an index is refused', () => {
    assert.throws(
      () => readEmbeddingVectors([{ index: 0, embedding: [1, 0] }, { embedding: [0, 1] }], 2, null),
      /only some embeddings name their input/,
    )
  })

  test('a repeated or out-of-range index is refused rather than mis-filed', () => {
    assert.throws(
      () => readEmbeddingVectors([{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }], 2, null),
      /malformed embedding index/,
    )
    assert.throws(
      () => readEmbeddingVectors([{ index: 0, embedding: [1, 0] }, { index: 2, embedding: [0, 1] }], 2, null),
      /malformed embedding index/,
    )
    assert.throws(
      () => readEmbeddingVectors([{ index: 0.5, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }], 2, null),
      /malformed embedding index/,
    )
  })

  test('a null index is refused, not filed at position 0', () => {
    // Number(null) is 0, so coercing a null index would file that vector at
    // position 0 — silently cached under the wrong text for the rest of the run,
    // which is the harm this boundary exists to prevent.
    assert.throws(
      () => readEmbeddingVectors([{ index: null, embedding: [1, 0] }, { index: null, embedding: [0, 1] }], 2, null),
      /malformed embedding index/,
    )
    // ...including when every other row carries a valid index, which is the case a
    // duplicate-at-0 check alone would miss.
    assert.throws(
      () => readEmbeddingVectors([
        { index: 1, embedding: [1, 0] },
        { index: null, embedding: [0, 1] },
        { index: 2, embedding: [1, 1] },
      ], 3, null),
      /malformed embedding index/,
    )
  })

  test('an index of any other type is refused, not coerced to 0 or 1', () => {
    assert.throws(() => readEmbeddingVectors([{ index: '', embedding: [1, 0] }, { index: '1', embedding: [0, 1] }], 2, null), /malformed embedding index/)
    assert.throws(() => readEmbeddingVectors([{ index: true, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }], 2, null), /malformed embedding index/)
    assert.throws(() => readEmbeddingVectors([{ index: 1.5, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }], 2, null), /malformed embedding index/)
  })

  test('an embedding too large to have a finite length is refused, not flattened to zero', () => {
    // Each component is finite, so the per-value check passes — but the combined
    // length overflows Number.MAX_VALUE and comes back as Infinity, and dividing by
    // Infinity would turn every component into 0, i.e. the all-zero vector the
    // no-direction check exists to refuse. It must be refused, never admitted.
    assert.throws(
      () => readEmbeddingVectors([{ index: 0, embedding: [1.7e308, 1.7e308] }, { index: 1, embedding: [0, 1] }], 2, null),
      /too large to compare/,
    )
  })

  test('the wrong number of rows is refused', () => {
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: [1, 0] }], 2, null), /1 vectors for 2 texts/)
    assert.throws(() => readEmbeddingVectors(null, 2, null), /0 vectors for 2 texts/)
  })

  test('a malformed row is refused', () => {
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: 'nope' }, { index: 1, embedding: [0, 1] }], 2, null), /malformed embedding/)
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: [1, 'x'] }, { index: 1, embedding: [0, 1] }], 2, null), /missing or non-finite/)
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: [1, NaN] }, { index: 1, embedding: [0, 1] }], 2, null), /missing or non-finite/)
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: [1, Infinity] }, { index: 1, embedding: [0, 1] }], 2, null), /missing or non-finite/)
  })

  test('a sparse row is refused, not read as zeroes', () => {
    const sparse = new Array(2) as number[]
    sparse[0] = 1 // index 1 stays a hole
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: sparse }, { index: 1, embedding: [0, 1] }], 2, null), /missing or non-finite/)
  })

  test('an answer with no direction is refused, so it cannot read as "nothing is similar"', () => {
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [0, 1] }], 2, null), /no direction/)
    assert.throws(() => readEmbeddingVectors([{ index: 0, embedding: [] }, { index: 1, embedding: [0, 1] }], 2, null), /no direction/)
  })

  test('a batch of mixed widths is refused', () => {
    assert.throws(
      () => readEmbeddingVectors([{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }], 2, null),
      /3-dimension embedding where 2 were expected/,
    )
  })

  test('the width carries across requests, so chunk 2 cannot change dimension', () => {
    const first = readEmbeddingVectors([{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }], 2, null)
    const width = first[0]!.length
    assert.equal(width, 2)
    assert.throws(
      () => readEmbeddingVectors([{ index: 0, embedding: [1, 0, 0] }], 1, width),
      /3-dimension embedding where 2 were expected/,
    )
  })

  test('a valid but very large or very small vector still normalizes to unit', () => {
    // Math.hypot scales internally, so sqrt(Σx²) overflowing to Infinity at 1e200
    // (or underflowing to 0 at 1e-200) does not turn these into NaN.
    assert.deepEqual(readEmbeddingVectors([{ index: 0, embedding: [1e200, 0] }, { index: 1, embedding: [0, 1] }], 2, null)[0], [1, 0])
    assert.deepEqual(readEmbeddingVectors([{ index: 0, embedding: [1e-200, 0] }, { index: 1, embedding: [0, 1] }], 2, null)[0], [1, 0])
    const scaled = readEmbeddingVectors([{ index: 0, embedding: [1e30, 1e30] }, { index: 1, embedding: [0, 1] }], 2, null)[0]!
    assert.ok(scaled.every(value => Number.isFinite(value)), 'no overflow to Infinity')
    assert.ok(Math.abs(Math.hypot(...scaled) - 1) < 1e-12, 'unit length')
    assert.ok(Math.abs(scaled[0]! - scaled[1]!) < 1e-12, 'equal components')
  })
})
