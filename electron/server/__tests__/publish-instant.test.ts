import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { canonicalInstant, sameInstant } from '../lib/publish-instant.js'

describe('sameInstant', () => {
  test('two serializations of one instant are the same instant', () => {
    assert.equal(sameInstant('2031-01-02T03:04:05.000Z', '2031-01-02T03:04:05Z'), true)
    assert.equal(sameInstant('2031-01-02T03:04:05Z', '2031-01-02T03:04:05.000Z'), true)
  })

  test('an offset spelling of the same instant matches', () => {
    assert.equal(sameInstant('2031-01-02T10:04:05+07:00', '2031-01-02T03:04:05Z'), true)
  })

  test('a genuinely different instant does not match', () => {
    assert.equal(sameInstant('2031-01-02T03:04:05Z', '2031-01-02T04:04:05Z'), false)
    assert.equal(sameInstant('2031-01-02T03:04:05Z', '2031-01-02T03:04:06Z'), false)
  })

  test('null and undefined mean no schedule and agree only with each other', () => {
    assert.equal(sameInstant(null, null), true)
    assert.equal(sameInstant(undefined, null), true)
    assert.equal(sameInstant(undefined, undefined), true)
    assert.equal(sameInstant(null, '2031-01-02T03:04:05Z'), false)
    assert.equal(sameInstant('2031-01-02T03:04:05Z', null), false)
  })

  test('a malformed value never matches, not even another malformed value', () => {
    assert.equal(sameInstant('not-a-date', '2031-01-02T03:04:05Z'), false)
    assert.equal(sameInstant('not-a-date', 'not-a-date'), false)
    assert.equal(sameInstant('2031-01-02T03:04:05Z', 'still-not-a-date'), false)
  })
})

describe('canonicalInstant', () => {
  test('null stays null', () => {
    assert.equal(canonicalInstant(null), null)
  })

  test('parseable values collapse to one canonical spelling', () => {
    assert.equal(canonicalInstant('2031-01-02T03:04:05Z'), '2031-01-02T03:04:05.000Z')
    assert.equal(canonicalInstant('2031-01-02T03:04:05.000Z'), '2031-01-02T03:04:05.000Z')
    assert.equal(canonicalInstant('2031-01-02T10:04:05+07:00'), '2031-01-02T03:04:05.000Z')
  })

  test('a malformed value is returned unchanged so it stays visible', () => {
    assert.equal(canonicalInstant('not-a-date'), 'not-a-date')
    assert.equal(canonicalInstant('2031-13-99T00:00:00Z'), '2031-13-99T00:00:00Z')
  })
})
