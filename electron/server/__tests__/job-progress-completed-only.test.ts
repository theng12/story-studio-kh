/**
 * A job's bar is a claim about work that EXISTS (owner, 2026-11-16).
 *
 * Production HMH0113 — 18 chapters planned, 0 completed, 17 failed, one still
 * running — read "running 94%", and a batch with 0 of 18 done later read 100%.
 * The bar was counting SETTLED work (`completed + failed`), so a run that
 * produced nothing walked to the end of the bar. These tests pin the exact
 * production numbers and forbid the formula coming back at any generator.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { completedPercent } from '../lib/job-progress.js'

test('HMH0113: 18 planned, 0 completed, 17 failed, one active reads 0% — never 94%', () => {
  const row = { total: 18, completed: 0, failed: 17, active: 1 }
  assert.equal(completedPercent(row.completed, row.total), 0)
  assert.notEqual(completedPercent(row.completed, row.total), 94)
})

test('HMH0113: a run where all 18 failed reads 0% — never 100%', () => {
  const row = { total: 18, completed: 0, failed: 18, active: 0 }
  assert.equal(completedPercent(row.completed, row.total), 0)
  assert.notEqual(completedPercent(row.completed, row.total), 100)
})

test('94% and 100% are reachable only from real completions', () => {
  assert.equal(completedPercent(17, 18), 94)
  assert.equal(completedPercent(18, 18), 100)
  assert.equal(completedPercent(1, 3), 33)
})

test('an empty batch is finished work, not an indeterminate bar', () => {
  assert.equal(completedPercent(0, 0), 100)
})

test('every progress-writing generator counts completions and keeps failures on the row', () => {
  const dir = new URL('../generators/', import.meta.url)
  const generators = ['audio.ts', 'images.ts', 'music-generate.ts', 'image-pool-generate.ts']
  for (const file of generators) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    // The shared rule, not a local reimplementation.
    assert.match(source, /completedPercent\(/, `${file} must use lib/job-progress.ts`)
    // Never `completed + failed` (or any `+ failed`) inside a progress write.
    assert.doesNotMatch(source, /job\.progress = [^\n]*\+ *failed/i, `${file} still adds failures to progress`)
  }

  // The failures are stated in the SAME row as the count they were taken from.
  for (const file of ['audio.ts', 'images.ts']) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    assert.match(source, /job\.item_progress = \{[^}]*failed:/, `${file} must publish failed beside completed`)
  }
})
