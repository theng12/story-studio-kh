/**
 * Tests for `useProjectFlow` — the format-aware production step list.
 *
 * `flowForVisualSource()` is the single source of truth for the ordered
 * pipeline steps, consumed by THREE surfaces that must stay in lock-step:
 *   - the sidebar nav (which generator pages show, per format)
 *   - the flow ribbon ("where am I / what's next")
 *   - the Production Board (its columns are these steps)
 *
 * `normalizeVisualSource()` collapses the unified `scenes` format
 * (visualSource 'scene-images' + sceneAlignment) onto the pipeline's
 * VisualSource vocabulary. A regression here silently mis-shapes all three
 * surfaces, so the per-format step sets are pinned explicitly.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeVisualSource,
  flowForVisualSource,
  type VisualSource,
} from '../composables/useProjectFlow.js'

const keys = (vs: VisualSource) => flowForVisualSource(vs).map(s => s.key)

describe('normalizeVisualSource', () => {
  test('unified scenes format pivots on sceneAlignment', () => {
    assert.equal(normalizeVisualSource('scene-images', 'chapter'), 'scene-images')
    assert.equal(normalizeVisualSource('scene-images', 'sentence'), 'narrated-scenes')
    assert.equal(normalizeVisualSource('scene-images', undefined), 'scene-images')
  })

  test('explicit visualSource values pass through unchanged', () => {
    assert.equal(normalizeVisualSource('broll', 'chapter'), 'broll')
    assert.equal(normalizeVisualSource('continuity-chain', 'sentence'), 'continuity-chain')
    assert.equal(normalizeVisualSource('timestamp-driven', undefined), 'timestamp-driven')
    assert.equal(normalizeVisualSource('narrated-scenes', 'chapter'), 'narrated-scenes')
  })

  test('unknown / missing visualSource falls back via sceneAlignment', () => {
    assert.equal(normalizeVisualSource(undefined, undefined), 'scene-images')
    assert.equal(normalizeVisualSource(null, 'sentence'), 'narrated-scenes')
    assert.equal(normalizeVisualSource('something-new', undefined), 'scene-images')
  })
})

describe('flowForVisualSource — per-format step sets', () => {
  test('scene-images: classic chain with per-scene prompts + images, no research/plan', () => {
    const k = keys('scene-images')
    for (const s of ['ideas', 'script', 'metadata', 'thumb-prompts', 'scene-prompts',
      'thumbnails', 'scenes', 'audio', 'audio-merge', 'video-assembly']) {
      assert.ok(k.includes(s), `scene-images should include ${s}`)
    }
    for (const s of ['research', 'scene-plan', 'scene-review', 'character-sheet', 'timestamp-assemble']) {
      assert.ok(!k.includes(s), `scene-images should NOT include ${s}`)
    }
  })

  test('broll: no per-scene prompts/images, ends at video-assembly', () => {
    const k = keys('broll')
    assert.ok(!k.includes('scene-prompts'), 'broll has no scene prompts')
    assert.ok(!k.includes('scenes'), 'broll has no scene images')
    assert.ok(k.includes('thumb-prompts') && k.includes('thumbnails'))
    assert.ok(k.includes('video-assembly'))
  })

  test('timestamp-driven: research + scene plan/review + video assembly, no scene-prompts', () => {
    const flow = flowForVisualSource('timestamp-driven')
    const k = flow.map(s => s.key)
    for (const s of ['research', 'scene-plan', 'scene-review', 'motion-review', 'video-assembly']) {
      assert.ok(k.includes(s), `timestamp-driven should include ${s}`)
    }
    assert.ok(!k.includes('scene-prompts'))
    assert.ok(!k.includes('character-sheet'), 'timestamp-driven has no character sheet')
    assert.ok(!k.includes('timestamp-assemble'), 'uses full video-assembly as the default final step')
    assert.equal(flow.find(s => s.key === 'motion-review')?.optional, true,
      'Motion Review must remain visible but non-blocking')
  })

  test('continuity-chain: adds character sheet on top of the audio-paced flow', () => {
    const k = keys('continuity-chain')
    for (const s of ['research', 'character-sheet', 'scene-plan', 'scene-review', 'motion-review', 'video-assembly']) {
      assert.ok(k.includes(s), `continuity-chain should include ${s}`)
    }
    assert.ok(!k.includes('timestamp-assemble'), 'fast timestamp assembler stays available as a tab, not the main flow step')
    assert.ok(!k.includes('scene-prompts'))
  })

  test('narrated-scenes: audio-paced flow with optional research + character sheet', () => {
    const k = keys('narrated-scenes')
    for (const s of ['research', 'character-sheet', 'scene-plan', 'scene-review', 'motion-review', 'video-assembly']) {
      assert.ok(k.includes(s), `narrated-scenes should include ${s}`)
    }
    assert.ok(!k.includes('timestamp-assemble'), 'fast timestamp assembler stays available as a tab, not the main flow step')
  })

  test('every step is a well-formed FlowStep with a unique key', () => {
    const sources: VisualSource[] = ['scene-images', 'broll', 'timestamp-driven', 'continuity-chain', 'narrated-scenes']
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
    const sources: VisualSource[] = ['scene-images', 'broll', 'timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      const k = keys(vs)
      assert.equal(k[0], 'ideas', `${vs} should start at Ideas`)
      assert.ok(
        ['video-assembly', 'timestamp-assemble'].includes(k[k.length - 1]),
        `${vs} should end on an assembly step`,
      )
    }
  })
})
