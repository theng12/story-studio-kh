import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  checkpointExpressionSection,
  inspectExpressionMarkup,
  readExpression,
} from '../services/audio-expression.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('expression markup narration integrity', () => {
  it('accepts inserted Fish tags without changing narration tokens', () => {
    const original = 'The lantern dimmed. Then the room fell quiet.'
    const tagged = '[warmly] The lantern dimmed. [short pause] Then the room fell quiet. [long pause]'
    assert.deepEqual(inspectExpressionMarkup(original, tagged, 'fish'), { valid: true })
  })

  it('accepts ElevenLabs ellipses only as additive pacing', () => {
    const original = 'The answer was close, but not yet clear.'
    const tagged = '[whispers] The answer was close, … but not yet clear. [pause]'
    assert.deepEqual(inspectExpressionMarkup(original, tagged, 'elevenlabs'), { valid: true })
  })

  it('rejects omitted narration words', () => {
    const result = inspectExpressionMarkup(
      'The old bridge crossed the narrow river.',
      '[softly] The bridge crossed the river.',
      'fish',
    )
    assert.equal(result.valid, false)
    assert.match(result.reason || '', /narration changed|ended early/)
  })

  it('rejects reworded or reordered narration', () => {
    const result = inspectExpressionMarkup(
      'She opened the wooden door slowly.',
      '[curious] Slowly, she opened the old door.',
      'fish',
    )
    assert.equal(result.valid, false)
    assert.match(result.reason || '', /narration changed/)
  })

  it('rejects a non-empty response with no actual expression tags', () => {
    const result = inspectExpressionMarkup('Nothing moved.', 'Nothing moved.', 'fish')
    assert.deepEqual(result, { valid: false, reason: 'the model returned no expression tags' })
  })

  it('does not let ElevenLabs replace original punctuation with an ellipsis', () => {
    const result = inspectExpressionMarkup('Wait. Listen.', '[whispers] Wait… Listen.', 'elevenlabs')
    assert.equal(result.valid, false)
  })

  it('keeps concurrent section checkpoints without overwriting either result', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expression-checkpoint-'))
    tempDirs.push(dir)
    const narrationPath = path.join(dir, 'EP0001_Script_Narration.md')
    await fs.writeFile(narrationPath, 'fixture')

    await Promise.all([
      checkpointExpressionSection(narrationPath, 'Chapter_01', '[warmly] First.', 'local-model', 'fish'),
      checkpointExpressionSection(narrationPath, 'Chapter_02', '[softly] Second.', 'local-model', 'fish'),
    ])

    const saved = await readExpression(narrationPath)
    assert.equal(saved?.sections.Chapter_01, '[warmly] First.')
    assert.equal(saved?.sections.Chapter_02, '[softly] Second.')
  })

  it('drops incompatible old-dialect sections instead of mixing provider tags', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expression-checkpoint-'))
    tempDirs.push(dir)
    const narrationPath = path.join(dir, 'EP0001_Script_Narration.md')
    await fs.writeFile(narrationPath, 'fixture')
    await checkpointExpressionSection(narrationPath, 'Chapter_01', '[warmly] First.', 'fish-model', 'fish')
    await checkpointExpressionSection(narrationPath, 'Chapter_02', '[whispers] Second.', 'el-model', 'elevenlabs')

    const saved = await readExpression(narrationPath)
    assert.equal(saved?.sections.Chapter_01, undefined)
    assert.equal(saved?.sections.Chapter_02, '[whispers] Second.')
    assert.equal(saved?.dialect, 'elevenlabs')
  })
})
