/**
 * Tests for `useProjectFlow` — the format-aware production step list.
 *
 * `flowForVisualSource()` is the single source of truth for the ordered
 * pipeline steps, consumed by THREE surfaces that must stay in lock-step:
 *   - the sidebar nav (which generator pages show, per format)
 *   - the flow ribbon ("where am I / what's next")
 *   - the Production Board (its columns are these steps)
 *
 * `normalizeVisualSource()` allows only live values through and uses the
 * Continuity Engine for anything else. A regression here could silently
 * restore obsolete board columns and routes, so the modern step sets are
 * pinned explicitly.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeVisualSource,
  flowForVisualSource,
  FLOW_PHASES,
  requiredFlowSteps,
  type VisualSource,
} from '../composables/useProjectFlow.js'
import { canonicalFormatId } from '../composables/useFormats.js'

const keys = (vs: VisualSource) => flowForVisualSource(vs).map(s => s.key)

describe('canonicalFormatId', () => {
  test('every saved or arbitrary selection resolves to the Continuity Engine', () => {
    assert.equal(canonicalFormatId('continuity-chain'), 'continuity-chain')
    assert.equal(canonicalFormatId('my-custom-format'), 'continuity-chain')
  })
})

describe('normalizeVisualSource', () => {
  test('active visualSource values pass through unchanged', () => {
    assert.equal(normalizeVisualSource('continuity-chain', 'sentence'), 'continuity-chain')
    assert.equal(normalizeVisualSource('timestamp-driven', undefined), 'timestamp-driven')
    assert.equal(normalizeVisualSource('narrated-scenes', 'chapter'), 'narrated-scenes')
  })

  test('unknown / missing visualSource safely falls back to continuity-chain', () => {
    assert.equal(normalizeVisualSource(undefined, undefined), 'continuity-chain')
    assert.equal(normalizeVisualSource(null, 'sentence'), 'continuity-chain')
    assert.equal(normalizeVisualSource('something-new', undefined), 'continuity-chain')
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

  test('YouTube Finalizer runs once after subtitles in every active flow', () => {
    const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      const flow = flowForVisualSource(vs)
      const k = flow.map(step => step.key)
      const finalizerIndex = k.indexOf('metadata')
      assert.equal(flow[finalizerIndex]?.label, 'YouTube Finalizer')
      assert.ok(finalizerIndex > k.indexOf('subtitles'), `${vs} should finalize after subtitles`)
      assert.ok(finalizerIndex < k.indexOf('scene-plan'), `${vs} should finalize before scene planning`)
      assert.equal(k.filter(key => key === 'metadata').length, 1)
    }
  })

  test('every step is a well-formed FlowStep with a unique key', () => {
    const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
    for (const vs of sources) {
      const steps = flowForVisualSource(vs)
      const seen = new Set<string>()
      for (const s of steps) {
        assert.ok(s.key && s.label && s.icon && s.path && s.phase, `${vs} step missing a field: ${JSON.stringify(s)}`)
        assert.ok(FLOW_PHASES.some(phase => phase.key === s.phase), `${vs} step has unknown phase: ${s.phase}`)
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
