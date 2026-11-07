/**
 * Upload pacing frontend (Story 386 Item 1).
 *
 * Three things are pinned here:
 *  1. ONE source — the util re-exports the shared contract; no second copy of
 *     the tier counts or wire types may appear in frontend code.
 *  2. The Upload Center page actually mounts the pacing, queue, captions and
 *     channel-settings panels, and carries params.captions + the pacing dates
 *     into the upload body.
 *  3. The two new components keep their honest states (no invented window
 *     defaults; an absent queue projection never reads as an empty queue).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  UPLOAD_PACING_TIER_DEFAULTS,
  UPLOAD_PACING_TIERS,
  uploadPacingTierLabel,
  validateUploadPacingPolicy,
  waitingReasonLabel,
} from '../utils/upload-pacing'
import * as contract from '../../electron/server/contracts/upload-pacing'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('upload pacing util is the contract, not a copy', () => {
  test('tier defaults are the contract object itself (identity, not equality)', () => {
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS, contract.UPLOAD_PACING_TIER_DEFAULTS)
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS.gentle.daily_limit, 3)
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS.regular.daily_limit, 6)
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS.bulk.daily_limit, 12)
  })

  test('tier list and validators come from the same module the backend uses', () => {
    assert.equal(UPLOAD_PACING_TIERS, contract.UPLOAD_PACING_TIERS)
    assert.equal(validateUploadPacingPolicy, contract.validateUploadPacingPolicy)
    assert.equal(uploadPacingTierLabel, contract.uploadPacingTierLabel)
  })

  test('the util source re-exports the contract and defines no counts of its own', () => {
    const source = read('../utils/upload-pacing.ts')
    assert.match(source, /export \* from '\.\.\/\.\.\/electron\/server\/contracts\/upload-pacing'/)
    assert.doesNotMatch(source, /daily_limit:\s*\d/)
    assert.doesNotMatch(source, /UPLOAD_PACING_TIER_DEFAULTS\s*=/)
  })

  test('a tier label shows the ACTUAL configured count', () => {
    assert.equal(uploadPacingTierLabel('gentle', 5), 'Gentle (up to 5/day)')
    assert.equal(uploadPacingTierLabel('custom', 9), 'Custom (up to 9/day)')
  })
})

describe('waitingReasonLabel', () => {
  test('the server detail wins when present', () => {
    assert.equal(waitingReasonLabel('daily_limit_reached', '3 of 3 used today'), '3 of 3 used today')
  })

  test('known codes get plain words', () => {
    assert.equal(waitingReasonLabel('ready'), 'Ready to upload')
    assert.equal(waitingReasonLabel('quota_exhausted'), 'Quota exhausted, waiting for reset')
    assert.equal(waitingReasonLabel('unconfigured_pacing'), 'Upload pacing not configured')
  })

  test('an unknown reason still reads as waiting, never as blank or code', () => {
    assert.equal(waitingReasonLabel('something_new'), 'Waiting in queue')
    assert.equal(waitingReasonLabel(undefined), 'Waiting in queue')
  })
})

describe('UploadPacingSettings.vue', () => {
  const source = read('../components/UploadPacingSettings.vue')

  test('reads and writes the pinned pacing endpoints', () => {
    assert.match(source, /\/youtube\/upload-pacing`/)
    assert.match(source, /put\(`\/projects\/\$\{encodeURIComponent\(props\.slug\)\}\/youtube\/upload-pacing`/)
    assert.match(source, /\{ policy: result\.policy \}/)
  })

  test('no invented window or spacing defaults — hours are an explicit choice', () => {
    assert.doesNotMatch(source, /08:00|22:00|start:\s*'\d\d:\d\d'/)
    assert.match(source, /No default hours/)
    assert.match(source, /window:\s*\{\s*start:\s*'',\s*end:\s*''\s*\}/)
  })

  test('saves through the shared validator, not a local check', () => {
    assert.match(source, /validateUploadPacingPolicy\(policyFromDraft\(\)\)/)
  })

  test('tier defaults come from the shared contract, never literals', () => {
    assert.match(source, /UPLOAD_PACING_TIER_DEFAULTS/)
    assert.doesNotMatch(source, /daily_limit:\s*(3|6|12)\b/)
  })
})

describe('UploadQueueSection.vue', () => {
  const source = read('../components/UploadQueueSection.vue')

  test('an absent projection is unavailable, an empty array is empty', () => {
    assert.match(source, /server may be offline or asleep/)
    assert.match(source, /Nothing waiting in the queue/)
    assert.match(source, /Array\.isArray\(props\.queue\)/)
  })

  test('controls reuse the existing Jobs queue routes', () => {
    assert.match(source, /\/jobs\/\$\{jobId\}/)
    assert.match(source, /`\$\{base\}\/\$\{action\}`/)
    assert.match(source, /`\$\{base\}\/move`/)
    assert.match(source, /`\$\{base\}\/cancel`/)
    assert.match(source, /direction: action/)
  })

  test('every row shows wait reason and actual next eligible time', () => {
    assert.match(source, /waitingReasonLabel\(entry\.wait_reason, entry\.wait_detail\)/)
    assert.match(source, /entry\.next_eligible_at/)
    assert.match(source, /Upload time/)
    assert.match(source, /Next eligible/)
  })
})

describe('publish.vue wiring', () => {
  const source = read('../pages/projects/[slug]/upload/publish.vue')

  test('mounts the queue, pacing, captions and channel-settings panels', () => {
    assert.match(source, /<UploadQueueSection :slug="slug" :queue="uploadQueue"/)
    assert.match(source, /<UploadPacingSettings :slug="slug" \/>/)
    assert.match(source, /<UploadCaptionsSettings v-model="captionSettings" \/>/)
    assert.match(source, /<ChannelYouTubeSettings :slug="slug" \/>/)
  })

  test('captions default OFF and ride into params.captions on both upload paths', () => {
    assert.match(source, /enabled: false/)
    const bodies = source.match(/params: \{ captions: captionSettings\.value \}/g) || []
    assert.equal(bodies.length, 2, 'single upload and bulk upload both carry params.captions')
  })

  test('bulk preview posts the pinned preview endpoint before enqueue', () => {
    assert.match(source, /\/youtube\/upload-pacing\/preview/)
    assert.match(source, /earliest_upload_on: pacingIso\(pacingUploadOn\.value\)/)
    assert.match(source, /publish_at: pacingIso\(pacingPublishOn\.value\)/)
  })

  test('conflicts block queueing until the plan is clean', () => {
    assert.match(source, /pacingPlanBlocked\.value\) return/)
    assert.match(source, /\|\| pacingPlanBlocked/)
  })

  test('the queue projection rides the overview read and keeps null ≠ empty', () => {
    assert.match(source, /uploadQueue\.value = overview\?\.upload_queue \?\? null/)
    assert.match(source, /uploadQueue\.value = null/)
  })

  test('Upload on and Publish on stay two separate fields', () => {
    assert.match(source, /v-model="pacingUploadOn"/)
    assert.match(source, /v-model="pacingPublishOn"/)
    assert.match(source, /Upload on \(earliest transfer\)/)
    assert.match(source, /Publish on \(goes public\)/)
  })
})
