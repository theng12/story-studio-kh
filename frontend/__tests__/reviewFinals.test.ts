/**
 * Review finals page — Pass button, auto-pass chip, Play emphasis, 2x2 grid at 375px.
 *
 * Pins the owner-approved 2026-11-07 requirements from Brief H:
 *   - Rename Approve to "Pass" (stored decision stays approved).
 *   - Per-channel "Auto-pass finished videos" switch beside the channel's review switch, OFF by default.
 *   - Auto-passed row shows "Auto-passed" and channel chip shows count of auto-passed.
 *   - Play is the emphasised button rather than View episode; buttons in a 2x2 grid at 375 px.
 *   - Auto-pass is note-only: no upload, schedule or publish is triggered by any review mark.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'

const reviewVuePath = path.resolve(__dirname, '../pages/review.vue')
const template = await fs.readFile(reviewVuePath, 'utf8')

describe('Review page — Pass button and auto-pass UI', () => {
  test('Approve button is renamed to Pass', () => {
    assert.match(template,/: 'Pass' }}<\/button>/)
    assert.doesNotMatch(template, /Approve/)
  })

  test('Stored decision for Pass remains approved in script', () => {
    assert.match(template, /decide\(item, 'approved'\)/)
  })

  test('stateShort renders Passed, Auto-passed, Needs changes, Not reviewed correctly', () => {
    assert.match(template, /return 'Passed'/)
    assert.match(template, /return 'Auto-passed'/)
    assert.match(template, /return 'Needs changes'/)
    assert.match(template, /return 'Not reviewed'/)
  })

  test('Per-channel Auto-pass switch is in template and OFF by default logic', () => {
    assert.match(template, /Auto-pass finished videos/)
    assert.match(template, /selectedChannelData\?\.auto_pass_enabled \?\? false/)
  })

  test('Auto-passed chip count appears on channel chips', () => {
    assert.match(template, /autoPassedByChannel\(channel\.slug\)/)
    assert.match(template, /totalAutoPassed/)
  })

  test('Clear auto-pass button is available for auto-passed finals', () => {
    assert.match(template, /currentDecision\(item\.review\) === 'auto_passed'/)
    assert.match(template, /Clear auto-pass/)
  })

  test('Play is the emphasised button, View episode is not primary', () => {
    assert.match(template, /class="rv-btn rv-btn-play"/)
    assert.doesNotMatch(template, /class="rv-btn rv-btn-primary"/)
    assert.match(template, /class="rv-btn rv-btn-view"/)
  })

  test('rv-row-actions becomes a 2x2 grid at 375px (max-width: 480px media query)', () => {
    const mediaIdx = template.indexOf('@media (max-width: 480px)')
    assert.notEqual(mediaIdx, -1, 'Media query for small screens must exist')
    const gridIdx = template.indexOf('grid-template-columns: repeat(2, 1fr)', mediaIdx)
    assert.notEqual(gridIdx, -1, '2x2 grid must be defined inside the media query')
  })

  test('Auto-pass toggles call PUT /review/channels/:slug with auto_pass field', () => {
    assert.match(template, /async function toggleChannelAutoPass/)
    assert.match(template, /\{ auto_pass \}/)
  })

  test('Auto-pass and review marks are note-only: no upload/schedule/publish is triggered', () => {
    // The component may SAY a mark "does not upload, schedule or publish" —
    // what it must never do is CALL an upload, schedule or publish endpoint.
    assert.doesNotMatch(template, /\/upload|\/publish|\/schedule/i)
    assert.doesNotMatch(template, /youtube-upload|scheduleVideo|publishVideo/i)
  })
})
