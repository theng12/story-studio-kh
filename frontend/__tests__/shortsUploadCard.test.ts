/**
 * 1.4.374 — the Shorts upload control on the channel's Publishing card.
 *
 * Source assertions, the same as the rest of the frontend lane. What this
 * pins is the PROMISE of the control, which no render check can see:
 *
 *   - the switch is off unless the owner picks otherwise, and the control
 *     reads the channel's stored value rather than assuming one;
 *   - a Short is never uploaded public — the only options are private and
 *     a scheduled private;
 *   - the limit (how many per episode) and the spacing (how far apart their
 *     dates fall) are SHOWN, not silently applied;
 *   - an out-of-range value is refused with a sentence that says what the
 *     range is, instead of being written.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const card = read('../components/PublishingScheduleCard.vue')

test('the Shorts switch is beside the Shorts count, in the channel card', () => {
  assert.match(card, /aria-label="Shorts per episode"/)
  assert.match(card, /aria-label="Upload Shorts to YouTube"/)
  assert.match(card, /aria-label="Days between Shorts"/)
  // Both live in the same controls row, so the count the owner just set is on
  // screen next to the switch that spends it.
  assert.match(card, /<div class="schedule-upload-controls">/)
  const row = card.slice(card.indexOf('<div class="schedule-upload-controls">'), card.indexOf('</div>', card.indexOf('<div class="schedule-upload-controls">')))
  assert.ok(row.includes('aria-label="Shorts per episode"'), 'the count is in the row')
  assert.ok(row.includes('aria-label="Upload Shorts to YouTube"'), 'the switch is in the row')
})

test('the switch reads the channel’s stored value, and off is the fallback', () => {
  // The value comes from the channel, never from an assumed default in the
  // template: a saved 'scheduled' must show as scheduled.
  assert.ok(card.includes(':value="state.shorts_auto_upload || \'off\'"'), 'the switch reads the channel value')
  assert.ok(card.includes(':value="state.shorts_upload_spacing_days ?? 1"'), 'the spacing reads the channel value')
  assert.ok(card.includes(':value="shortsCount"'), 'the count reads the channel value')
})

test('every option is private, and public is never a choice', () => {
  // The Shorts switch, and nothing else on the card.
  const start = card.indexOf('aria-label="Upload Shorts to YouTube"')
  const shorts = card.slice(start, card.indexOf('</select>', start))
  const values = [...shorts.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]!)
  assert.deepEqual(values, ['off', 'private', 'scheduled'])
  // There is no way to choose public from this card.
  assert.doesNotMatch(shorts, /value="public"/)
})

test('the limit and the spacing are shown, not silent', () => {
  // The count, its ceiling and the spacing are all on screen, in words.
  assert.match(card, /type="number"\s+min="0"\s+max="3"/)
  assert.match(card, /type="number"\s+min="1"\s+max="30"/)
  assert.match(card, /20–58 seconds/)
  assert.match(card, /day\{\{ spacingDays === 1 \? '' : 's' \}\} after it/)
})

test('an out-of-range count or spacing is refused, and says what the range is', () => {
  assert.match(card, /if \(!Number\.isInteger\(count\) \|\| count < 0 \|\| count > 3\)/)
  assert.match(card, /Shorts per episode must be a whole number from 0 to 3\./)
  assert.match(card, /if \(!Number\.isInteger\(days\) \|\| days < 1 \|\| days > 30\)/)
  assert.match(card, /Days between Shorts must be a whole number from 1 to 30\./)
  // A refused value is put back rather than left looking saved.
  assert.match(card, /box\.value = String\(before\)/)
})

test('each switch reports what it did in plain words', () => {
  assert.match(card, /Shorts are not uploaded to YouTube\./)
  assert.match(card, /Shorts now upload as private and stay private\./)
  assert.match(card, /YouTube makes each one public on its own date/)
  assert.match(card, /This channel makes no Shorts\./)
})

test('the spacing field only appears once it can mean something', () => {
  // Days between Shorts only applies in 'scheduled' mode.
  assert.match(card, /v-if="state\.shorts_auto_upload === 'scheduled'"/)
})
