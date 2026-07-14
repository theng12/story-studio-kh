/**
 * Tests for `useProjectFlow` — the format-aware production step list.
 *
 * `flowForVisualSource()` is the single source of truth for the ordered
 * pipeline steps, consumed by THREE surfaces that must stay in lock-step:
 *   - the sidebar nav (which generator pages show, per format)
 *   - the flow ribbon ("where am I / what's next")
 *   - the Production Board (its columns are these steps)
 *
 * `normalizeVisualSource()` migrates retired `scene-images` and unknown
 * formats onto the narration-timed Scene Plan workflow. A regression here
 * silently restores obsolete board columns and routes, so the modern step
 * sets are pinned explicitly.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeVisualSource,
  flowForVisualSource,
  requiredFlowSteps,
  type VisualSource,
} from '../composables/useProjectFlow.js'
import { canonicalFormatId } from '../composables/useFormats.js'

const keys = (vs: VisualSource) => flowForVisualSource(vs).map(s => s.key)

describe('canonicalFormatId', () => {
  test('retired format selections heal to the modern scenes shell', () => {
    for (const id of ['stock-footage', 'image-pool', 'broll', 'scene-images']) {
      assert.equal(canonicalFormatId(id), 'scenes')
    }
  })

  test('active and custom format ids remain unchanged', () => {
    assert.equal(canonicalFormatId('continuity-chain'), 'continuity-chain')
    assert.equal(canonicalFormatId('listicle'), 'listicle')
    assert.equal(canonicalFormatId('my-custom-format'), 'my-custom-format')
  })
})

describe('normalizeVisualSource', () => {
  test('retired scene-images always migrates to narrated-scenes', () => {
    assert.equal(normalizeVisualSource('scene-images', 'chapter'), 'narrated-scenes')
    assert.equal(normalizeVisualSource('scene-images', 'sentence'), 'narrated-scenes')
    assert.equal(normalizeVisualSource('scene-images', undefined), 'narrated-scenes')
  })

  test('active visualSource values pass through unchanged', () => {
    assert.equal(normalizeVisualSource('continuity-chain', 'sentence'), 'continuity-chain')
    assert.equal(normalizeVisualSource('timestamp-driven', undefined), 'timestamp-driven')
    assert.equal(normalizeVisualSource('narrated-scenes', 'chapter'), 'narrated-scenes')
  })

  test('retired B-Roll and Image Pool formats migrate to narrated-scenes', () => {
    assert.equal(normalizeVisualSource('broll', 'chapter'), 'narrated-scenes')
    assert.equal(normalizeVisualSource('image-pool', 'sentence'), 'narrated-scenes')
  })

  test('unknown / missing visualSource safely falls back to narrated-scenes', () => {
    assert.equal(normalizeVisualSource(undefined, undefined), 'narrated-scenes')
    assert.equal(normalizeVisualSource(null, 'sentence'), 'narrated-scenes')
    assert.equal(normalizeVisualSource('something-new', undefined), 'narrated-scenes')
  })
})

describe('flowForVisualSource — per-format step sets', () => {
  test('timestamp-driven: research + scene plan/review + video assembly, no scene-prompts', () => {
    const flow = flowForVisualSource('timestamp-driven')
    const k = flow.map(s => s.key)
    for (const s of ['research', 'scene-plan', 'scene-review', 'motion-review', 'video-assembly']) {
      assert.ok(k.includes(s), `timestamp-driven should include ${s}`)
    }
    assert.ok(!k.includes('scene-prompts'))
    assert.ok(!k.includes('character-sheet'), 'timestamp-driven has no character sheet')
    assert.equal(flow.find(s => s.key === 'motion-review')?.optional, true,
      'Motion Review must remain visible but non-blocking')
  })

  test('continuity-chain: adds character sheet on top of the audio-paced flow', () => {
    const k = keys('continuity-chain')
    for (const s of ['research', 'character-sheet', 'scene-plan', 'scene-review', 'motion-review', 'video-assembly']) {
      assert.ok(k.includes(s), `continuity-chain should include ${s}`)
    }
    assert.ok(!k.includes('scene-prompts'))
  })

  test('narrated-scenes: audio-paced flow with optional research + character sheet', () => {
    const flow = flowForVisualSource('narrated-scenes')
    const k = flow.map(s => s.key)
    for (const s of ['research', 'character-sheet', 'scene-plan', 'scene-review', 'motion-review', 'video-assembly']) {
      assert.ok(k.includes(s), `narrated-scenes should include ${s}`)
    }
    assert.equal(flow.find(s => s.key === 'research')?.optional, true,
      'Research must remain visible but non-blocking')
  })

  test('Research never counts toward required production completion', () => {
    const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      assert.ok(keys(vs).includes('research'), `${vs} should keep optional Research available`)
      assert.ok(!requiredFlowSteps(vs).some(step => step.key === 'research'),
        `${vs} must not require Research for completion`)
    }
  })

  test('every step is a well-formed FlowStep with a unique key', () => {
    const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      const steps = flowForVisualSource(vs)
      const seen = new Set<string>()
      for (const s of steps) {
        assert.ok(s.key && s.label && s.icon && s.path, `${vs} step missing a field: ${JSON.stringify(s)}`)
        assert.ok(!seen.has(s.key), `${vs} has a duplicate step key: ${s.key}`)
        seen.add(s.key)
        assert.ok(s.path.startsWith('/'), `${vs} step path should be a suffix: ${s.path}`)
      }
    }
  })

  test('Ideas is always first; the flow always ends on an assembly step', () => {
    const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      const k = keys(vs)
      assert.equal(k[0], 'ideas', `${vs} should start at Ideas`)
      assert.equal(k[k.length - 1], 'video-assembly', `${vs} should end on unified Video Assembly`)
    }
  })

  test('no active flow exposes retired scene prompt or scene image stages', () => {
    const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      const k = keys(vs)
      assert.ok(!k.includes('scene-prompts'), `${vs} must not expose Scene Prompts`)
      assert.ok(!k.includes('scenes'), `${vs} must not expose Scene Images`)
    }
  })
})
