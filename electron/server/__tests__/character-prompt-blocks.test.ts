/**
 * Tests for the shared cast → prompt-block helpers used by:
 *   - generators/episode.ts (script generation)
 *   - routes/scripts.ts (/generate/image-prompts interactive route)
 *   - generators/image-prompts.ts (batch executor for the Pipeline runner)
 *
 * The extraction removed three sources of "did the LLM see the cast or not?"
 * drift between those callers; these tests pin the rendering invariants so
 * future edits to one site can't silently diverge from the others.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  castPromptBlock,
  castImagePromptBlock,
} from '../lib/character-prompt-blocks.js'
import type { Character } from '../models/types.js'

function ch(name: string, description: string, extra: Partial<Character> = {}): Character {
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    name,
    description,
    scope: 'project',
    source: 'project',
    schemaVersion: 1,
    created_at: '2026-04-25T00:00:00Z',
    ...extra,
  }
}

describe('castPromptBlock', () => {
  test('empty cast returns empty string (back-compat path)', () => {
    assert.equal(castPromptBlock([]), '')
  })

  test('single-character block: name appears + single-character clause', () => {
    const out = castPromptBlock([ch('Aria', 'tall, plate armour')])
    assert.ok(out.includes('Aria'))
    assert.ok(out.includes('tall, plate armour'))
    // Single-character mode: instructs the LLM to use the one name
    // throughout, not the multi-speaker tag instruction.
    assert.ok(out.includes('Use "Aria" by name throughout'))
    assert.ok(!out.includes('Mark each dialog line with the speaker tag'),
      'single-character mode must NOT emit multi-speaker tag instructions')
  })

  test('multi-character block: speaker-tag instruction emitted', () => {
    const out = castPromptBlock([
      ch('Aria', 'd1'),
      ch('Brick', 'd2'),
    ])
    assert.ok(out.includes('Aria'))
    assert.ok(out.includes('Brick'))
    assert.ok(out.includes('Mark each dialog line with the speaker tag'),
      'Phase 6 voice routing depends on this instruction firing for 2+ chars')
    assert.ok(out.includes('[CHARACTER_NAME]: dialog text'))
  })

  test('archetype + tonation surface in the rendered line', () => {
    const out = castPromptBlock([
      ch('Aria', 'a knight', { archetype: 'protagonist', speech: { tonation: 'soft, slow' } }),
    ])
    assert.ok(out.includes('[protagonist]'))
    assert.ok(out.includes('Tonation: soft, slow.'))
  })

  test('cast block is numbered in source order', () => {
    const out = castPromptBlock([
      ch('Aria', 'd'), ch('Brick', 'd'), ch('Cara', 'd'),
    ])
    assert.ok(out.includes('1. Aria'))
    assert.ok(out.includes('2. Brick'))
    assert.ok(out.includes('3. Cara'))
  })
})

describe('castImagePromptBlock', () => {
  test('empty cast returns empty string', () => {
    assert.equal(castImagePromptBlock([]), '')
  })

  test('single character: name + description appear inline', () => {
    const out = castImagePromptBlock([ch('Aria', 'tall, plate armour, silver braid')])
    assert.ok(out.includes('Aria: tall, plate armour, silver braid'))
    // Header tells the LLM what to do with this block.
    assert.ok(out.includes('CHARACTER REFERENCE'))
    assert.ok(out.includes('include these descriptions inline'))
  })

  test('multi-character: each character on its own dash line', () => {
    const out = castImagePromptBlock([
      ch('Aria', 'plate armour'),
      ch('Brick', 'leather hood'),
      ch('Cara', 'green cloak'),
    ])
    assert.ok(out.includes('- Aria: plate armour'))
    assert.ok(out.includes('- Brick: leather hood'))
    assert.ok(out.includes('- Cara: green cloak'))
  })

  test('cast block does NOT contain the script-only speaker tag instructions', () => {
    // image-prompt block must stay focused on visual descriptions; the
    // Phase 6 [NAME]: dialog tag belongs only in script generation.
    const out = castImagePromptBlock([ch('Aria', 'd'), ch('Brick', 'd')])
    assert.ok(!out.includes('Mark each dialog line'))
    assert.ok(!out.includes('CHARACTER_NAME'))
  })
})
