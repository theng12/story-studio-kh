/**
 * Tests for lib/reply-drafter.ts. Pure functions — no async, no I/O.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildReplyDraftPrompt, parseReplyDrafts } from '../lib/reply-drafter.js'
import type { Brand } from '../models/types.js'

describe('buildReplyDraftPrompt', () => {
  test('includes channel name from brand.channel.name', () => {
    const brand: Brand = {
      id: 'b', name: 'Demo', schemaVersion: 1,
      channel: { name: 'Sleep Studio Asia' },
    }
    const prompt = buildReplyDraftPrompt({
      commentText: 'lovely!',
      commentAuthor: 'Alice',
      brand,
    })
    assert.match(prompt, /channel owner of "Sleep Studio Asia"/)
    assert.match(prompt, /by Alice/)
    assert.match(prompt, /lovely!/)
  })

  test('falls back to projectName when brand has no channel name', () => {
    const prompt = buildReplyDraftPrompt({
      commentText: 'hi',
      commentAuthor: 'Alice',
      projectName: 'My Channel',
    })
    assert.match(prompt, /channel owner of "My Channel"/)
  })

  test('falls back to "this channel" when neither brand nor project name', () => {
    const prompt = buildReplyDraftPrompt({ commentText: 'hi', commentAuthor: 'Alice' })
    assert.match(prompt, /channel owner of "this channel"/)
  })

  test('includes brand persona when present', () => {
    const brand: Brand = {
      id: 'b', name: 'Demo', schemaVersion: 1,
      narration: { persona: 'Calm and slow narrator. Always third person.' },
    }
    const prompt = buildReplyDraftPrompt({
      commentText: 'lovely!',
      commentAuthor: 'Alice',
      brand,
    })
    assert.match(prompt, /Channel persona/)
    assert.match(prompt, /Calm and slow narrator/)
  })

  test('omits persona block when none provided', () => {
    const prompt = buildReplyDraftPrompt({ commentText: 'hi', commentAuthor: 'A' })
    assert.doesNotMatch(prompt, /Channel persona/)
  })

  test('includes video title when supplied', () => {
    const prompt = buildReplyDraftPrompt({
      commentText: 'great', commentAuthor: 'A',
      videoTitle: 'Fall Asleep to a Forgotten Lighthouse',
    })
    assert.match(prompt, /"Fall Asleep to a Forgotten Lighthouse"/)
  })

  test('honours count and clamps to 1-5', () => {
    assert.match(buildReplyDraftPrompt({ commentText: 'x', commentAuthor: 'a', count: 1 }), /Draft 1 short/)
    assert.match(buildReplyDraftPrompt({ commentText: 'x', commentAuthor: 'a', count: 3 }), /Draft 3 short/)
    // Out-of-range gets clamped
    assert.match(buildReplyDraftPrompt({ commentText: 'x', commentAuthor: 'a', count: 99 }), /Draft 5 short/)
    assert.match(buildReplyDraftPrompt({ commentText: 'x', commentAuthor: 'a', count: 0 }), /Draft 1 short/)
  })

  test('default count is 3', () => {
    const prompt = buildReplyDraftPrompt({ commentText: 'x', commentAuthor: 'a' })
    assert.match(prompt, /Draft 3 short/)
  })
})

describe('parseReplyDrafts', () => {
  test('splits on blank lines', () => {
    const raw = `Thanks Alice — really glad it helped you drift off!

So happy this episode landed for you. Sweet dreams.

Means a lot, Alice. Thanks for letting me know.`
    const out = parseReplyDrafts(raw, 3)
    assert.equal(out.length, 3)
    assert.match(out[0]!, /Thanks Alice/)
    assert.match(out[2]!, /Means a lot/)
  })

  test('strips numbered leaders like "1." or "1)"', () => {
    const raw = `1. Thanks Alice!\n\n2. So glad it helped.\n\n3) Means a lot.`
    const out = parseReplyDrafts(raw, 3)
    assert.equal(out[0], 'Thanks Alice!')
    assert.equal(out[1], 'So glad it helped.')
    assert.equal(out[2], 'Means a lot.')
  })

  test('strips wrapping quotes', () => {
    const raw = `"Thanks Alice!"\n\n"Means a lot."`
    const out = parseReplyDrafts(raw, 2)
    assert.equal(out[0], 'Thanks Alice!')
    assert.equal(out[1], 'Means a lot.')
  })

  test('caps at requested count even if model returns more', () => {
    const raw = `A\n\nB\n\nC\n\nD\n\nE\n\nF`
    const out = parseReplyDrafts(raw, 3)
    assert.equal(out.length, 3)
  })

  test('falls back to line-by-line when no blank lines', () => {
    const raw = `Thanks Alice!\nSo glad it helped.\nMeans a lot.`
    const out = parseReplyDrafts(raw, 3)
    assert.equal(out.length, 3)
    assert.equal(out[0], 'Thanks Alice!')
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(parseReplyDrafts('', 3), [])
    assert.deepEqual(parseReplyDrafts('   \n\n   ', 3), [])
  })

  test('strips "Reply 1:" and "Option 1 -" leaders', () => {
    const raw = `Reply 1: Thanks Alice!\n\nOption 2 - Means a lot.`
    const out = parseReplyDrafts(raw, 2)
    assert.equal(out[0], 'Thanks Alice!')
    assert.equal(out[1], 'Means a lot.')
  })
})
