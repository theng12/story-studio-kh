/**
 * One authoritative headline in a saved thumbnail prompt (2026-11-16).
 *
 * The measured failure: a repair appended "exactly ROME" beside the existing "reading FIFTEEN
 * MILES", and the model omitted the large headline or lettered the word into the small FOR SLEEP
 * badge. The supported edit replaces the one headline in place; a prompt that does not contain the
 * old headline is refused, never appended to.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { replaceHeadlineInPrompt } from '../generators/image-prompts.js'
import { UpdatePromptSchema } from '../routes/image-prompts-edit.js'

// Real prompt shapes from a-world-before-us, shortened around the headline and badge.
const EP0005 = 'The top band is a quiet dark sky reserved for the single line of heavy outlined capitals reading FIFTEEN MILES, and the bottom-left corner holds one small cream rounded rectangle badge with a dark outline and dark capitals reading FOR SLEEP.'
const EP0008 = 'The top band stays quiet and dark for the ornate golden-glow serif line FROM CITADEL TO FORUM, and a small cream rounded badge with a dark outline reading FOR SLEEP sits in the bottom-left corner.'

test('a captured headline is replaced in place, and the badge is untouched', () => {
  const result = replaceHeadlineInPrompt(EP0005, 'FIFTEEN MILES', 'ROME')
  assert.ok(result.ok)
  assert.equal(result.replacements, 1)
  assert.match(result.prompt, /reading ROME,/)
  assert.doesNotMatch(result.prompt, /FIFTEEN MILES/)
  assert.match(result.prompt, /FOR SLEEP/, 'the independent badge text survives')
})

test('the “line …” form is replaced too, and nothing is appended', () => {
  const result = replaceHeadlineInPrompt(EP0008, 'FROM CITADEL TO FORUM', 'GREECE')
  assert.ok(result.ok)
  assert.match(result.prompt, /serif line GREECE,/)
  assert.doesNotMatch(result.prompt, /FROM CITADEL TO FORUM/)
  assert.equal(result.prompt.split('GREECE').length - 1, 1, 'exactly one headline mention')
  assert.match(result.prompt, /FOR SLEEP/)
})

test('a quoted headline is replaced only where the clause names a headline', () => {
  const straight = replaceHeadlineInPrompt('Then draw the headline "OLD TITLE" large.', 'OLD TITLE', 'NEW TITLE')
  assert.ok(straight.ok)
  assert.equal(straight.prompt, 'Then draw the headline "NEW TITLE" large.')
  const curly = replaceHeadlineInPrompt('Then draw the headline “OLD TITLE” large.', 'OLD TITLE', 'NEW TITLE')
  assert.ok(curly.ok)
  assert.equal(curly.prompt, 'Then draw the headline “NEW TITLE” large.', 'the original quote style is kept')
})

test('repeating the same edit changes nothing', () => {
  const once = replaceHeadlineInPrompt(EP0005, 'FIFTEEN MILES', 'ROME')
  assert.ok(once.ok)
  const twice = replaceHeadlineInPrompt(once.prompt, 'FIFTEEN MILES', 'ROME')
  assert.ok(twice.ok)
  assert.equal(twice.changed, false)
  assert.equal(twice.prompt, once.prompt)
})

test('a prompt without the old headline is refused, not appended to', () => {
  const result = replaceHeadlineInPrompt('A river at dawn. The badge reads FOR SLEEP.', 'FIFTEEN MILES', 'ROME')
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.reason : '', /does not contain the old headline "FIFTEEN MILES"/)
})

test('a bare mention outside a headline form is not rewritten', () => {
  const prose = 'The road to FIFTEEN MILES is shown in the middle distance. The line reading ANOTHER TITLE stays.'
  const result = replaceHeadlineInPrompt(prose, 'FIFTEEN MILES', 'ROME')
  assert.equal(result.ok, false, 'the safe answer is a refusal, not a scene edit')
  if (!result.ok) assert.match(result.reason, /does not contain the old headline/)
})

test('the save contract accepts a headline replacement without a full prompt, and refuses an empty body', () => {
  assert.equal(UpdatePromptSchema.safeParse({ kind: 'thumbnail', number: 4, title: 'ROME', replace_headline: { from: 'FIFTEEN MILES', to: 'ROME' } }).success, true)
  assert.equal(UpdatePromptSchema.safeParse({ kind: 'thumbnail', number: 4, title: 'ROME', prompt: 'A scene, long enough to pass.' }).success, true)
  assert.equal(UpdatePromptSchema.safeParse({ kind: 'thumbnail', number: 4, title: 'ROME' }).success, false)
})

test('the same words in a sign or badge are left alone (review finding 1)', () => {
  const prompt = 'Draw a large headline reading OLD TITLE beside a museum sign "OLD TITLE".'
  const result = replaceHeadlineInPrompt(prompt, 'OLD TITLE', 'NEW TITLE')
  assert.ok(result.ok)
  assert.equal(result.replacements, 1)
  assert.equal(result.prompt, 'Draw a large headline reading NEW TITLE beside a museum sign "OLD TITLE".')
})

test('a same-word badge is not changed', () => {
  const prompt = 'The top band reads HELLO. A small badge reading HELLO sits bottom-left.'
  const result = replaceHeadlineInPrompt(prompt, 'HELLO', 'GOODBYE')
  assert.ok(result.ok)
  assert.equal(result.replacements, 1)
  assert.match(result.prompt, /top band reads GOODBYE/)
  assert.match(result.prompt, /badge reading HELLO/, 'the badge keeps its own words')
})

test('idempotence needs the new headline in a headline position, not a substring (finding 2)', () => {
  const result = replaceHeadlineInPrompt('A trip to ROME. Draw headline reading PARIS.', 'LONDON', 'ROME')
  assert.equal(result.ok, false, 'ROME as a place name is not proof the headline changed')
  assert.match(!result.ok ? result.reason : '', /does not contain the old headline "LONDON"/)
})

test('a prefix of a longer headline is not a match (finding 3)', () => {
  const result = replaceHeadlineInPrompt('The headline reading ROME CITY sits on top.', 'ROME', 'PARIS')
  assert.equal(result.ok, false)
})
