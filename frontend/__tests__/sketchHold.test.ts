/**
 * The Sketch Draw closing hold in Motion Review (1.4.353): what a customer types becomes a setting,
 * or a plain sentence saying what to fix, before anything is sent; the control sits beside the pen,
 * edits THIS episode, rolls back a failed save, blanks and reloads on an episode change, and is never
 * part of a preset. The server owns the rule and the clamp (electron/server/__tests__/sketch-hold.test.ts).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { HOLD_MAX_SECONDS, holdDrafts, holdFromDraft, holdLabel } from '../utils/sketch-hold'

const source = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')
const drafts = { fixed: '2.5', min: '1.5', max: '3' }

function fn(name: string): string {
  const marker = `function ${name}(`
  const asyncStart = source.indexOf(`async ${marker}`)
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(marker)
  assert.ok(start >= 0, `expected ${name}`)
  const nextAsync = source.indexOf('\nasync function ', start + 10)
  const nextSync = source.indexOf('\nfunction ', start + 10)
  return source.slice(start, Math.min(...[nextAsync, nextSync].filter(index => index > 0)))
}

test('the choices without numbers turn into their setting, and "channel" clears the episode hold', () => {
  assert.deepEqual(holdFromDraft('channel', drafts), { ok: true, hold: null })
  assert.deepEqual(holdFromDraft('off', drafts), { ok: true, hold: { mode: 'off' } })
  assert.deepEqual(holdFromDraft('auto', drafts), { ok: true, hold: { mode: 'auto' } })
  assert.equal(holdFromDraft('', drafts).ok, false, 'the unreadable-file placeholder is not a choice')
})

test('fixed seconds are validated with a sentence that says what to fix', () => {
  assert.deepEqual(holdFromDraft('fixed', { ...drafts, fixed: '2' }), { ok: true, hold: { mode: 'fixed', seconds: 2 } })
  assert.deepEqual(holdFromDraft('fixed', { ...drafts, fixed: ' 0.5 ' }), { ok: true, hold: { mode: 'fixed', seconds: 0.5 } })
  for (const bad of ['', '  ', '0', '-1', 'abc', '2s', 'NaN', 'Infinity', String(HOLD_MAX_SECONDS + 1)]) {
    const result = holdFromDraft('fixed', { ...drafts, fixed: bad })
    assert.equal(result.ok, false, JSON.stringify(bad))
    if (!result.ok) assert.match(result.error, /^Enter the hold in seconds, more than 0 and at most \d+\.$/)
  }
  assert.equal(holdFromDraft('fixed', { ...drafts, fixed: String(HOLD_MAX_SECONDS) }).ok, true)
})

test('a range needs both ends, in order, and names which end is wrong', () => {
  assert.deepEqual(holdFromDraft('range', { ...drafts, min: '1', max: '3' }), { ok: true, hold: { mode: 'range', min_seconds: 1, max_seconds: 3 } })
  assert.deepEqual(holdFromDraft('range', { ...drafts, min: '2', max: '2' }), { ok: true, hold: { mode: 'range', min_seconds: 2, max_seconds: 2 } })
  const noMin = holdFromDraft('range', { ...drafts, min: '', max: '3' })
  assert.ok(!noMin.ok && /shortest hold/.test(noMin.error))
  const noMax = holdFromDraft('range', { ...drafts, min: '1', max: 'x' })
  assert.ok(!noMax.ok && /longest hold/.test(noMax.error))
  const swapped = holdFromDraft('range', { ...drafts, min: '4', max: '2' })
  assert.deepEqual(swapped, { ok: false, error: 'The shortest hold cannot be longer than the longest hold.' })
})

test('labels say what each setting does, and the drafts show the saved setting or the usual starting values', () => {
  assert.equal(holdLabel({ mode: 'off' }), 'no hold')
  assert.equal(holdLabel({ mode: 'auto' }), 'auto: follows the clip length')
  assert.equal(holdLabel({ mode: 'fixed', seconds: 2.5 }), '2.5 s hold')
  assert.equal(holdLabel({ mode: 'range', min_seconds: 1, max_seconds: 3 }), '1–3 s, random per scene')
  assert.deepEqual(holdDrafts(null), { fixed: '2.5', min: '1.5', max: '3' })
  assert.deepEqual(holdDrafts({ mode: 'fixed', seconds: 4 }), { fixed: '4', min: '1.5', max: '3' })
  assert.deepEqual(holdDrafts({ mode: 'range', min_seconds: 0.5, max_seconds: 2 }), { fixed: '2.5', min: '0.5', max: '2' })
  assert.deepEqual(holdDrafts({ mode: 'auto' }), holdDrafts(null))
})

test('the hold control sits beside the pen: one select, numbers only for fixed and range, and the four options', () => {
  assert.match(source, /<span>Closing hold for \{\{ episodeId \}\}<\/span>/)
  assert.match(source, /v-model="holdChoice"[^>]*@change="onHoldChoice"/)
  assert.ok(source.indexOf('Closing hold for {{ episodeId }}') > source.indexOf('Pen for {{ episodeId }}'), 'after the pen')
  assert.ok(source.indexOf('Closing hold for {{ episodeId }}') < source.indexOf('id="sketch-pen-help"'), 'inside the same controls row')
  for (const option of [
    '<option value="channel">Channel default ({{ holdLabel(channelHold) }})</option>',
    '<option value="auto">Auto (follows the clip length)</option>',
    '<option value="off">No hold</option>',
    '<option value="fixed">Fixed seconds</option>',
    '<option value="range">Random range</option>',
    '<option v-if="holdUnreadable" value="" disabled>Choose a hold…</option>',
  ]) assert.ok(source.includes(option), option)
  assert.match(source, /v-if="isSketchDraw && holdLoaded && \(holdChoice === 'fixed' \|\| holdChoice === 'range'\)"/)
  assert.match(source, /aria-label="Closing hold in seconds"/)
  assert.match(source, /aria-label="Shortest closing hold in seconds"/)
  assert.match(source, /aria-label="Longest closing hold in seconds"/)
  assert.match(source, /:disabled="!holdLoaded \|\| holdSaving"/, 'disabled until this episode answers')
  assert.match(source, /Apply hold<\/button>/)
})

test('the help line says whose hold is in force, the half-scene cap, and that older clips keep their old hold', () => {
  assert.match(source, /\{\{ episodeId \}\} uses its own hold: \{\{ holdLabel\(episodeHold\) \}\}\. Other episodes are not affected\./)
  assert.match(source, /\{\{ episodeId \}\} follows the channel default hold: \{\{ holdLabel\(channelHold\) \}\}/)
  assert.match(source, /A hold never takes more than half a scene, so the drawing always has time; scene length and narration do not change\./)
  assert.match(source, /Clips made before this setting keep their old hold until you re-generate them\./)
  assert.match(source, /\{\{ holdUnreadable \}\} Choose a hold to replace it; Sketch Draw waits until you do\./)
  assert.match(source, /Not applied yet\. Apply the hold, or pick another option, before generating\./)
})

test('off, auto and "follow the channel" save at once; fixed and range wait for Apply and are validated first', () => {
  const choose = fn('onHoldChoice')
  assert.match(choose, /if \(holdChoice\.value === 'fixed' \|\| holdChoice\.value === 'range'\) \{[\s\S]*return\n  \}/)
  assert.match(choose, /void saveEpisodeHold\(parsed\.hold\)/)
  const apply = fn('applyHold')
  assert.match(apply, /holdFromDraft\(holdChoice\.value, holdDraft\.value\)/)
  assert.match(apply, /if \('error' in parsed\) \{ holdError\.value = parsed\.error; return \}/, 'a bad value is explained and nothing is sent')
})

test('saving the hold edits THIS episode, rolls a failed save back, and drops a late answer for another episode', () => {
  const save = fn('saveEpisodeHold')
  assert.match(save, /const ep = episodeId\.value/)
  assert.match(save, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-hold`, \{ hold: next \}/)
  assert.match(save, /if \(ep !== episodeId\.value\) return/)
  assert.match(save, /holdChoice\.value = acceptedHoldChoice\(\)[\s\S]*holdDraft\.value = holdDrafts\(episodeHold\.value \?\? channelHold\.value\)/, 'a failed save restores the control and its numbers')
  assert.match(save, /showError\(holdError\.value\)/)
  assert.match(save, /finally \{ if \(ep === episodeId\.value\) holdSaving\.value = false \}/)
  assert.match(save, /holdUnreadable\.value = ''/, 'a successful save clears an unreadable-file state')
  assert.match(save, /await loadReview\(\)/, 'clip freshness is re-read after the change')
})

test('an episode change blanks the hold, disables the control until the new answer, and reloads it', () => {
  const reset = fn('resetEpisodeScopedMotionState')
  for (const line of ['episodeHold.value = null', "holdChoice.value = 'channel'", 'holdDraft.value = holdDrafts(null)',
    'holdLoaded.value = false', 'holdSaving.value = false', "holdUnreadable.value = ''", "holdError.value = ''"]) {
    assert.ok(reset.includes(line), line)
  }
  assert.match(source, /watch\(episodeId, \(\) => \{[\s\S]*resetEpisodeScopedMotionState\(\)[\s\S]*void loadEpisodeHold\(\)/)
  const load = fn('loadEpisodeHold')
  assert.match(load, /if \(ep !== episodeId\.value\) return/)
  assert.match(load, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-hold`/)
  assert.match(load, /episodeHold\.value = result\.episode_hold/)
  assert.match(load, /holdUnreadable\.value = result\.error \|\| ''/)
  assert.match(load, /holdLoaded\.value = true/, 'loaded, so an unreadable file does not lock the select')
})

test('generation waits for a loaded, readable, applied hold, and says why it is waiting', () => {
  assert.match(source, /loaded: presentationLoaded\.value && penLoaded\.value && !penUnreadable\.value && holdLoaded\.value && !holdUnreadable\.value && !holdPending\.value/)
  assert.match(source, /saving: presentationSaving\.value \|\| penSaving\.value \|\| holdSaving\.value/)
  assert.match(source, /if \(!holdLoaded\.value\) return presentationError\.value \|\| 'Loading Sketch Draw settings'/)
  assert.match(source, /if \(holdUnreadable\.value\) return 'Choose a closing hold'/)
  assert.match(source, /if \(holdPending\.value\) return 'Apply the closing hold, or pick another option'/)
})

test('the channel default moves only on purpose, asks first, and the renderer save never carries a hold', () => {
  const move = fn('setChannelHoldDefault')
  assert.match(move, /await ask\(\{[\s\S]*Episodes without their own hold will use \$\{holdLabel\(hold\)\}/)
  assert.ok(move.indexOf('await ask(') < move.indexOf("put(`/projects/"), 'nothing is saved before the answer')
  assert.match(move, /\{ renderer: clipRenderer\.value, hold \}/)
  assert.match(move, /success\(`Channel default hold is now \$\{holdLabel\(hold\)\}\./)
  assert.match(source, /Make this the channel default hold/)
  assert.doesNotMatch(fn('saveMotionPresentation'), /\bhold/i, 'saving the renderer sends no hold')
  assert.doesNotMatch(fn('saveEpisodePen'), /\bhold/i)
})

test('presets never carry the hold: the preset snapshot and apply are built without it', () => {
  const start = source.indexOf('const motionPresets = usePresets(')
  const preset = source.slice(start, source.indexOf('\n})\n', start))
  assert.ok(preset.includes('duration_mode'), 'found the preset')
  assert.doesNotMatch(preset, /\b(hold|holdChoice|channelHold|episodeHold|holdDraft)\b/)
})
