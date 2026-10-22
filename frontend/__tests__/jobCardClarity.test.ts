/**
 * next348 — one job card, one summary, one credit explanation, one details.
 *
 * From the owner's screenshot: a single job card said "Running",
 * "CheckingProviderStatus", "The Gateway is generating", "credit pending" and
 * "awaiting settlement" — five lines for one piece of work — and the request
 * it sent sat behind an expander inside an expander inside the drawer.
 *
 * This file pins the shape that replaced it:
 *   • ONE summary line on the card face, derived from our own evidence;
 *   • ONE credit explanation, and it is not an exception;
 *   • the provider's own wording in the details, where diagnostics belong;
 *   • ONE list of the Gateway items, each with the request it was sent with;
 *   • the raw payload behind exactly ONE expander;
 *   • a local job stays provider-free — it names no provider and no operation;
 *   • freshness comes from the provider's own progress timestamp when there
 *     is one, and says nothing when there is not;
 *   • a held song is never counted as settled.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { lastProgressAt, summariseSettlement } from '../composables/useJobEta.js'
import { jobOperationLabel } from '../utils/job-presentation.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const page = read('../pages/projects/[slug]/jobs.vue')
const details = read('../components/JobCardDetails.vue')
const ledger = read('../components/GenStudioBatchLedger.vue')
const preview = read('../components/GenStudioRequestPreview.vue')
const hint = read('../components/GenStudioCreditSettlementHint.vue')
const shared = read('../utils/job-presentation.ts')

/** The page's markup only — the script block is not what a customer reads. */
const template = page.slice(0, page.indexOf('<script setup'))
/** The request preview's markup only — its comments are not what a customer reads. */
const previewTemplate = preview.slice(0, preview.indexOf('<script setup'))

describe('the card face carries one summary and one credit line', () => {
  test('there is exactly one summary line per card, and it is on the face', () => {
    assert.equal((template.match(/class="job-summary-line"/g) || []).length, 2, 'the Active card and the History card')
    // …and it is NOT inside a drawer: the face shows it without a click.
    const drawers = template.match(/<AdvancedDisclosure[\s\S]*?<\/AdvancedDisclosure>/g) || []
    assert.equal(drawers.length, 2)
    for (const drawer of drawers) assert.doesNotMatch(drawer, /class="job-summary-line"/)
  })

  test('the summary line is not a live region', () => {
    // The timing readings at the end of the line tick every second. A
    // `role="status"` region announces its whole content whenever any of it
    // changes, so a screen reader would repeat the counts, the estimate and
    // the freshness every second while the job was fresh.
    assert.doesNotMatch(template, /class="job-summary-line" role="status"/)
    assert.equal((template.match(/class="job-summary-line"/g) || []).length, 2)
  })

  test('the provider\'s own wording is not on the face any more', () => {
    // "CheckingProviderStatus" and "The Gateway is generating" repeated the
    // state the summary line already carried.
    assert.doesNotMatch(template, /class="genstudio-status-detail"/)
    assert.doesNotMatch(template, /class="genstudio-queue-detail"/)
    // …it is in the details, under a heading that says what it is.
    assert.match(details, /What the provider reported/)
    assert.match(details, /v-if="providerStatus" class="job-detail-line"/)
    assert.match(details, /v-if="providerQueue" class="job-detail-line"/)
  })

  test('the money is ONE line, with ONE explanation of it', () => {
    assert.equal((template.match(/<GenStudioCreditSettlementHint/g) || []).length, 2, 'one per card')
    // The hint rides inside the money line rather than in a box of its own.
    assert.match(template, /<GenStudioCreditSettlementHint :remote-jobs="summary\.remoteJobs" compact inline :link="false" \/>/)
    // The item list carries the FIGURES, and no second sentence about money.
    assert.doesNotMatch(ledger, /<GenStudioCreditSettlementHint/)
  })

  test('the credit explanation is one sentence, and it never claims a settlement', () => {
    assert.match(hint, /The Gateway has published a provisional reservation while this work settles\./)
    assert.match(hint, /Story Studio is checking the Gateway for the final credit outcome\./)
    // One sentence at a time — never both.
    assert.match(hint, /if \(heldCount\.value\) return/)
    assert.match(hint, /if \(!confirmed\.value\) return/)
    // The link only appears while there is something unsettled.
    assert.match(hint, /const showLink = computed\(\(\) => props\.link && !confirmed\.value\)/)
  })
})

describe('one list of the Gateway items', () => {
  test('the item list and the request preview are one list, not two', () => {
    assert.match(ledger, /<GenStudioRequestPreview :entry="remote" \/>/)
    // The page no longer renders either of them itself.
    assert.doesNotMatch(page, /<GenStudioBatchLedger/)
    assert.doesNotMatch(page, /<GenStudioRequestPreview/)
    // And there is no expander between the reader and the items.
    assert.doesNotMatch(ledger, /Show Gateway Requests/)
    assert.doesNotMatch(ledger, /<details/)
  })

  test('the raw payload sits behind exactly one expander', () => {
    assert.equal((preview.match(/<details/g) || []).length, 1)
    assert.equal((preview.match(/<summary>/g) || []).length, 1)
    assert.match(preview, /Show the raw request \(\{\{ rawCharacterCount\.toLocaleString\(\) \}\} characters\)/)
    // One expander for the whole request — not one per message inside it.
    assert.doesNotMatch(preview, /<details[^>]*>\s*<summary>[^<]*message/i)
  })

  test('a request with no preview says so plainly, and does not guess why', () => {
    // The server keeps only the newest previews and strips the rest without
    // leaving a marker, so the reason a preview is missing is not knowable
    // from here. The line states the one fact that is.
    assert.match(previewTemplate, /No request preview is stored for this request\./)
    // …and no user-visible word claims a reason for it.
    const visible = previewTemplate.replace(/<!--[\s\S]*?-->/g, '')
    assert.doesNotMatch(visible, /dropped/i)
    // …and the request that HAS one still shows its facts.
    assert.match(previewTemplate, /<dl v-if="entry\.request" class="gs-req-facts">/)
  })

  test('the request preview shows the facts that were actually sent', () => {
    for (const fact of ['Request sent', 'Product / model submitted', 'response_format', 'Captured']) {
      assert.match(preview, new RegExp(fact))
    }
    // The token limits and the submitted fields are rendered, not summarised.
    assert.match(preview, /v-for="limit in tokenLimits\(entry\)"/)
    assert.match(preview, /v-for="field in entry\.request\.fields \|\| \[\]"/)
    // …and no credential-shaped name is ever rendered.
    assert.doesNotMatch(preview, /Idempotency-Key/)
  })
})

describe('both cards share ONE details body', () => {
  test('the Active card and the History card render the same component', () => {
    assert.equal((template.match(/<JobCardDetails/g) || []).length, 2)
    assert.match(template, /:remote-jobs="settledRemoteJobs\(job\)"/)
    assert.match(template, /:counts="job\.item_progress \? jobCounts\(job\) : null"/)
  })

  test('the shared body holds what the details drawer is for', () => {
    assert.match(details, /<GenStudioBatchLedger/)
    assert.match(details, /<EpisodeRecoveryStatus :job="job" diagnostics-only \/>/)
    assert.match(details, /class="job-items"/)
    assert.match(details, /itemAttemptText\(item\)/)
    assert.match(details, /deriveOutputDir/)
    // The request preview rides inside the item list, so there is one list.
    assert.match(ledger, /<GenStudioRequestPreview :entry="remote" \/>/)
    // One component, so the two cards cannot drift apart again.
    assert.equal((details.match(/<GenStudioBatchLedger/g) || []).length, 1)
  })

  test('the counts are stated once, from the one shared derivation', () => {
    // The Gateway item list states the counts. The details body says them
    // only when that list is not there — a local job has no Gateway items —
    // so the same numbers never appear twice on one screen.
    assert.match(details, /const hasItemList = computed\(\(\) => props\.remoteJobs\.length > 0\)/)
    assert.match(details, /v-if="!hasItemList"/)
    // …and what it prints comes from the one derivation, not from the raw
    // per-field values: those two disagree about a held item, which is
    // settling, not failed.
    assert.doesNotMatch(details, /job\.item_progress\.(settling|cancelled|not_submitted|failed|completed)\b/)
  })
})

describe('freshness comes from the provider when the provider published it', () => {
  const iso = (ms: number) => new Date(ms).toISOString()

  test('a provider progress timestamp counts even while the item is still running', () => {
    const remotes = [{ queue_state: 'running', updated_at: '', last_provider_progress_at: iso(9_000) }]
    assert.equal(lastProgressAt(undefined, remotes), 9_000)
  })

  test('no progress at all says nothing rather than "0s ago"', () => {
    assert.equal(lastProgressAt(undefined, [{ queue_state: 'running', updated_at: '' }]), null)
    assert.equal(lastProgressAt(undefined, undefined), null)
  })

  test('the newest provider reading wins', () => {
    const remotes = [
      { queue_state: 'running', last_provider_progress_at: iso(4_000) },
      { queue_state: 'running', last_provider_progress_at: iso(7_000) },
    ]
    assert.equal(lastProgressAt(undefined, remotes), 7_000)
  })
})

describe('a held song is never settled', () => {
  const held = {
    id: 'song-1', operation: 'music.generation', state: 'failed', queue_state: 'failed',
    recovery_required: true, recovery_state: 'unknown_outcome',
    reserved_credits: 13, settled_credits: 0, released_credits: 0,
  }

  test('its reservation is held, not charged, and the outcome is not confirmed', () => {
    assert.deepEqual(summariseSettlement([held]), {
      confirmed: false, charged: 0, returned: 0, held: 13,
    })
  })

  test('the same item once the Gateway settles it is a normal failure', () => {
    const settled = { ...held, recovery_required: false, recovery_state: null, released_credits: 13 }
    assert.deepEqual(summariseSettlement([settled]), {
      confirmed: true, charged: 0, returned: 13, held: 0,
    })
  })

  test('the item list says the outcome is unknown, and has its own bucket for it', () => {
    // The bucket lives in ONE place: the item list and the settlement
    // sentence read the same rule, so they cannot describe one request two
    // ways.
    assert.match(shared, /if \(holdsUnknownProviderOutcome\(remote\)\) return 'held'/)
    assert.match(ledger, /return jobStateBucket\(remote\)/)
    assert.match(hint, /return jobStateBucket\(remote\)/)
    assert.match(ledger, /Held — outcome unknown/)
    // …and a held item is not in the failed count either.
    assert.match(ledger, /const exceptionJobs = computed\(\(\) => props\.remoteJobs\.filter\(remote => stateBucket\(remote\) === 'failed'\)\)/)
  })

  test('a request the Gateway holds counts as a hold in the settlement sentence too', () => {
    // The card's own figure says "N credits on hold" for it, so the sentence
    // beside it must not say a different thing about the same reservation.
    assert.match(hint, /bucket === 'held'/)
    assert.match(hint, /bucket === 'active' \|\| bucket === 'queued' \|\| bucket === 'held'/)
  })
})

describe('a local job stays provider-free', () => {
  test('the operation vocabulary names the work, and nothing else', () => {
    assert.equal(jobOperationLabel('chat.response'), 'Text')
    assert.equal(jobOperationLabel('image.generation'), 'Image')
    assert.equal(jobOperationLabel('voice.tts'), 'Voice')
    assert.equal(jobOperationLabel('video.generation'), 'Video')
    assert.equal(jobOperationLabel('music.generation'), 'Music')
    assert.equal(jobOperationLabel('audio.transcription'), 'Transcription')
    // An operation nobody published is shown as it stands, not guessed at.
    assert.equal(jobOperationLabel('something.new'), 'something new')
  })

  test('a job with no provider request names no operation', () => {
    assert.equal(jobOperationLabel(undefined), '')
    assert.equal(jobOperationLabel(''), '')
    // …and the item list is not rendered at all for it.
    assert.match(details, /<GenStudioBatchLedger v-if="remoteJobs\.length"/)
  })

  test('a local render says its own state and no provider wording', () => {
    // The summary line carries the local render's state.
    assert.match(template, /<span v-if="finalRenderDetail\(job\)" class="job-stat">/)
    // …and the provider's wording is empty for a job that never called one.
    assert.match(details, /v-if="providerStatus \|\| providerQueue"/)
  })
})
