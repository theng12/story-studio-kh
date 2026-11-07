/**
 * Story entity extraction — sizing, reconciliation and review semantics
 * (Episode Visual Setup extraction phase).
 *
 * These pin the parts that can go quietly wrong:
 *   - chunks respect the SELECTED product's published prompt limit, and a
 *     product that publishes none is refused rather than guessed (§1);
 *   - the same entity from two chunks merges into one canonical id, keeping
 *     the more complete story facts and OR-ing `important`;
 *   - unusable model rows are counted, not silently treated as complete (§8);
 *   - a re-extraction never reverses a stored Keep/Drop or `important` choice,
 *     and a dropped entity stays dropped (§5/§8).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accumulateExtracted,
  annotateProposals,
  finalizeExtracted,
  planExtractionChunks,
  type ExtractedStoryEntity,
} from '../generators/story-entities.js'
import type { StoryEntity } from '../contracts/story-entities.js'

describe('story entity extraction', () => {
  test('chunks stay inside the published prompt cap and cover every chapter in order', () => {
    const chapters = [
      { number: 1, text: 'a'.repeat(900) },
      { number: 2, text: 'b'.repeat(900) },
    ]
    const chunks = planExtractionChunks(chapters, { maxPromptCharacters: 1200, outputTokens: 512 }, 'system')
    assert.ok(chunks.length >= 2, 'two long chapters must not share one over-cap request')
    for (const chunk of chunks) {
      assert.ok(chunk.text.length + 400 + 'system'.length <= 1200, 'chunk exceeded the published cap')
    }
    assert.ok(chunks[0]!.numbers.includes(1))
    assert.ok(chunks.at(-1)!.numbers.includes(2))
  })

  test('a product that publishes no prompt limit is refused, never guessed', () => {
    assert.throws(
      () => planExtractionChunks([{ number: 1, text: 'story' }], { outputTokens: 512 }, 'system'),
      /publishes no prompt limit/,
    )
  })

  test('one entity from two chunks merges into one canonical record', () => {
    const map = new Map<string, ExtractedStoryEntity>()
    const skipped = accumulateExtracted([
      { kind: 'cast', name: 'Aria', description: 'carries a silver lamp', important: false },
      { kind: 'cast', name: ' aria ', description: 'a guide with a silver lamp and a red coat', important: true },
      { kind: 'nope', name: 'Boro', description: '' },
      { kind: 'object', name: '', description: '' },
    ], map)

    assert.equal(skipped, 2)
    const entities = finalizeExtracted(map)
    assert.equal(entities.length, 1)
    assert.equal(entities[0]!.name, 'Aria')
    assert.equal(entities[0]!.important, true)
    assert.match(entities[0]!.description, /red coat/)
  })

  test('a Khmer name still gets a stable, valid canonical id', () => {
    const map = new Map<string, ExtractedStoryEntity>()
    accumulateExtracted([{ kind: 'cast', name: 'សុភា', description: 'the guide' }], map)
    const [entity] = finalizeExtracted(map)
    assert.match(entity!.id, /^cast-[a-z0-9][a-z0-9-]{0,63}$/)
  })

  test('re-extraction keeps the stored Keep/Drop and important choices', () => {
    const stored: StoryEntity[] = [{
      id: 'cast-aria',
      kind: 'cast',
      name: 'Aria',
      description: 'old facts',
      important: true,
      review: 'drop',
      reference_images: [],
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
    }]
    const proposals = annotateProposals([
      { id: 'cast-aria', kind: 'cast', name: 'Aria', description: 'new facts', important: false },
      { id: 'object-lamp', kind: 'object', name: 'Lamp', description: '', important: false },
    ], stored)

    assert.equal(proposals[0]!.existing, true)
    assert.equal(proposals[0]!.review, 'drop', 'a dropped entity must stay dropped')
    assert.equal(proposals[0]!.important, true, 'the stored reference decision wins')
    assert.equal(proposals[0]!.current_description, 'old facts')
    assert.equal(proposals[1]!.existing, false)
    assert.equal(proposals[1]!.review, 'keep')
  })
})
