/**
 * DS-08 (F-11, Q-06, Q-07, Q-08, Q-10) — the single job-type label authority
 * and the Jobs-page admission/filter/empty-state rules.
 *
 * F-11: four hand-maintained label maps had drifted from the live `JobType`
 * union, so current types rendered as raw slugs in the Jobs rows, the
 * completion toasts and the episode dropdown. `utils/job-presentation.ts` is
 * now the one map; this file pins that it covers every live type and that the
 * mode-aware labels, the retry-admission mirror and the empty-state copy behave.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { JOB_TYPES } from '../../electron/server/models/types.js'
import {
  JOB_TYPE_LABELS,
  jobDisplayLabel,
  jobsEmptyState,
  jobTypeLabel,
  retryAdmissionAllowed,
} from '../utils/job-presentation.js'

test('F-11: every live job type has an explicit human label in the one map', () => {
  const missing = JOB_TYPES.filter(type => !JOB_TYPE_LABELS[type])
  assert.deepEqual(missing, [], `live job types missing a label: ${missing.join(', ')}`)
  for (const type of JOB_TYPES) {
    const label = JOB_TYPE_LABELS[type]!
    assert.ok(label.trim().length > 0, `${type} needs a non-empty label`)
    assert.doesNotMatch(label, /_/, `${type} must not render as an internal slug`)
    assert.equal(jobTypeLabel(type), label, `${type} must resolve through the shared label`)
    assert.notEqual(jobTypeLabel(type), type, `${type} must not render its raw id`)
  }
})

test('F-11: an unknown future type is humanized, never a raw slug', () => {
  assert.equal(jobTypeLabel('some_future_job_type'), 'Some Future Job Type')
  assert.equal(jobTypeLabel('metadata'), 'YouTube Finalizer')
})

test('F-11: prompt jobs keep the thumbnail/scene distinction', () => {
  assert.equal(jobDisplayLabel({ type: 'image_prompts', params: { mode: 'thumbnails' } }), 'Thumbnail Prompts')
  assert.equal(jobDisplayLabel({ type: 'image_prompts', params: { mode: 'scenes' } }), 'Scene Prompts')
  assert.equal(jobDisplayLabel({ type: 'image_prompts', params: {} }), 'Prompts')
  assert.equal(jobDisplayLabel({ type: 'audio' }), 'Audio')
})

test('Q-06: retry admission mirrors the backend legacy prompt/image rules', () => {
  // Allowed shapes.
  assert.equal(retryAdmissionAllowed({ type: 'image_prompts' }), true)
  assert.equal(retryAdmissionAllowed({ type: 'image_prompts', params: { mode: 'thumbnails' } }), true)
  assert.equal(retryAdmissionAllowed({ type: 'images' }), true)
  assert.equal(retryAdmissionAllowed({ type: 'images', params: { mode: 'thumbs' } }), true)
  assert.equal(retryAdmissionAllowed({ type: 'audio', params: { mode: 'scenes' } }), true)
  // The exact shapes `retryAdmissionError` always refuses with a 409.
  assert.equal(retryAdmissionAllowed({ type: 'image_prompts', params: { mode: 'scenes' } }), false)
  assert.equal(retryAdmissionAllowed({ type: 'images', params: { mode: 'scenes' } }), false)
  // Truthiness mirror: a falsy mode is admitted, matching the backend guard.
  assert.equal(retryAdmissionAllowed({ type: 'image_prompts', params: { mode: '' } }), true)
  assert.equal(retryAdmissionAllowed({ type: 'image_prompts', params: { mode: null } }), true)
})

test('Q-08: a filter that empties a nonempty list says "no matches", not "no jobs yet"', () => {
  const base = {
    hiddenInScope: 0, showHidden: false, scopedJobs: 5,
    typeFilter: 'all', typeLabel: 'All', batchFilter: null, universal: false,
  }
  const statusFiltered = jobsEmptyState({ ...base, statusFilter: 'error' })
  assert.equal(statusFiltered.title, 'No matching jobs')
  assert.match(statusFiltered.message, /5 jobs/)
  assert.match(statusFiltered.message, /Clear the filter/)

  const batchFiltered = jobsEmptyState({ ...base, statusFilter: 'all', batchFilter: 'batch-1' })
  assert.equal(batchFiltered.title, 'No matching jobs')

  const typeFiltered = jobsEmptyState({ ...base, statusFilter: 'all', typeFilter: 'audio', typeLabel: 'Audio' })
  assert.equal(typeFiltered.title, 'No matching jobs')

  // Genuinely empty history keeps the original copy.
  const genuinelyEmpty = jobsEmptyState({ ...base, scopedJobs: 0, statusFilter: 'error' })
  assert.equal(genuinelyEmpty.title, 'No jobs yet')

  const hiddenOnly = jobsEmptyState({ ...base, hiddenInScope: 3, statusFilter: 'all' })
  assert.equal(hiddenOnly.title, 'No visible jobs')
})

test('Q-08: a type filter with no jobs at all names the empty type', () => {
  const copy = jobsEmptyState({
    hiddenInScope: 0, showHidden: false, scopedJobs: 0,
    typeFilter: 'audio', typeLabel: 'Audio', statusFilter: 'all', batchFilter: null, universal: false,
  })
  assert.equal(copy.title, 'No Audio jobs')
  assert.match(copy.message, /All tab/)
})
