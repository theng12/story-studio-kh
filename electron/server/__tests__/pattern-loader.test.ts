/**
 * Tests for the Pattern loader (services/pattern-loader.ts) and the
 * Pattern + Format composition pipeline.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let loader: typeof import('../services/pattern-loader.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

describe('pattern-loader', () => {
  before(async () => {
    tmp = await useTempDataDir()
    loader = await import('../services/pattern-loader.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'),
      'PROJECTS_ROOT must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(() => {
    loader._clearPatternCaches()
  })

  test('listPatterns returns all 6 built-ins', async () => {
    const list = await loader.listPatterns()
    const ids = list.map(p => p.id).sort()
    assert.ok(ids.includes('fall-asleep-to-X'), `fall-asleep-to-X missing; got ${ids.join(',')}`)
    assert.ok(ids.includes('born-as-X'))
    assert.ok(ids.includes('history-of-X-explained'))
    assert.ok(ids.includes('survive-in-X'))
    assert.ok(ids.includes('whisper-tour-X'))
    assert.ok(ids.includes('day-in-the-life-X'))
  })

  test('loadPattern returns null for unknown id', async () => {
    assert.equal(await loader.loadPattern('does-not-exist'), null)
  })

  test('built-in pattern fields validate', async () => {
    const p = await loader.loadPattern('history-of-X-explained')
    assert.ok(p)
    assert.equal(p!.builtin, true)
    assert.equal(p!.schemaVersion, 1)
    assert.ok(p!.titleTemplate.includes('{X}'))
    assert.ok(['first', 'second', 'third', 'mixed'].includes(p!.pov))
  })

  test('applyPatternSubject substitutes {X}, {last}, {lastButOne}', async () => {
    const p = (await loader.loadPattern('history-of-X-explained'))!
    const result = loader.applyPatternSubject(p, 'London', 10)
    assert.equal(result.resolvedTitle, 'The entire history of London explained')
    // bodyStructure has {lastButOne} and {last}
    assert.ok(result.resolvedBodyStructure)
    const joined = result.resolvedBodyStructure!.join(' ')
    assert.ok(!joined.includes('{lastButOne}'), 'all {lastButOne} placeholders substituted')
    assert.ok(!joined.includes('{last}'), 'all {last} placeholders substituted')
    assert.ok(!joined.includes('{X}'), 'all {X} placeholders substituted')
  })

  test('applyPatternSubject falls back to subjectLabel when subject is empty', async () => {
    const p = (await loader.loadPattern('fall-asleep-to-X'))!
    const result = loader.applyPatternSubject(p, '   ', 8)
    // Empty/whitespace subject → uses subjectLabel ('Topic') in title.
    assert.equal(result.resolvedTitle, `Fall asleep to ${p.subjectLabel}`)
  })

  test('every built-in pattern has both bodyStructure and metadata additions', async () => {
    const all = await loader.listPatterns()
    for (const p of all) {
      assert.ok(p.bodyStructure && p.bodyStructure.length > 0,
        `${p.id} should declare bodyStructure for full composition power`)
      assert.ok(p.metadataKeywordAdditions && p.metadataKeywordAdditions.length > 0,
        `${p.id} should declare metadataKeywordAdditions to extend the keyword pool`)
    }
  })
})
