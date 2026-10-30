/**
 * Still Posts — before the spend and after it (owner, 2026-10-30).
 *
 *  - Write shows the batch as an editable list: edit, remove and add before any drawing;
 *  - Draw states the count, the model and free-or-paid before starting, and shows posts as they finish;
 *  - Publish lists ONLY approved posts, with what went where, the result and its link, or "Not sent";
 *  - empty states name the next action, and the page works at narrow widths.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { stillPostSource } from './_stillPostSource'

const source = stillPostSource()
const component = (name: string) => readFileSync(
  fileURLToPath(new URL(`../components/still-posts/${name}`, import.meta.url)),
  'utf8',
)

test('Write is an editable list you can add to, edit and remove from before any drawing', () => {
  const write = component('StillPostsWrite.vue')
  assert.match(write, /Add a quote/, 'a row can be added by hand')
  assert.match(write, /Save .* change/, 'edits are saved explicitly')
  assert.match(write, /Remove/, 'a row can be removed (to the channel Trash)')
  assert.match(write, /before drawing/, 'the page says this costs nothing before drawing')
  // Edits in progress survive a workspace reload (a running job reloads the page).
  assert.match(write, /if \(row\?\.dirty\) return \{ \.\.\.row, drawn \}/)
  // A hand-typed row becomes a real post through the add route, not a second write path.
  assert.match(source, /still-posts\/posts`,\s*\{\s*text: trimmed/)
})

test('Draw says the model, the drawing count and free-or-paid before starting', () => {
  const draw = component('StillPostsDraw.vue')
  assert.match(draw, /imageModelInfo\?\.display_name/, 'the model is named before the spend')
  assert.match(draw, /drawingsForBatch \}\} drawing/, 'the count is stated')
  assert.match(draw, /CREDIT_BASIS_LABEL\[drawCost\.basis\]/, 'the price basis is named (free, paid, or not reported)')
  assert.match(draw, /Each post shows up above as soon as its pictures are done/, 'progress is described honestly')
  // The workspace is re-read WHILE a job runs, so posts appear as they finish.
  assert.match(source, /setInterval\(\(\) => \{ void load\(\) \}, 4000\)/)
})

test('Publish lists only approved posts, with what went where, the result and its link', () => {
  const publish = component('StillPostsPublish.vue')
  assert.match(publish, /posts\.value\.filter\(entry => !!entry\.approved_at\)/, 'only approved posts')
  assert.match(publish, /Not sent/, 'a not-sent state is shown plainly')
  assert.match(publish, /Failed:/, 'a failed attempt shows the reason')
  assert.match(publish, /\.permalink/, 'a sent post links to its result')
  assert.match(publish, /sentCount/, 'how many were sent is stated')
  assert.match(publish, /Nothing is sent until you press a button/)
  assert.match(publish, /Copy caption/, 'YouTube is prepared here and posted by hand')
  assert.match(publish, /Instagram needs a public image address/, 'Instagram says why it cannot post')
})

test('every empty state names the next action', () => {
  assert.match(component('StillPostsWrite.vue'), /No posts yet\. Describe a batch above and write it, or add a quote by hand\./)
  assert.match(component('StillPostsDraw.vue'), /Nothing to draw yet\. Write posts on the Write step first\./)
  assert.match(component('StillPostsReview.vue'), /Write a batch on the Write step\./)
  assert.match(component('StillPostsPublish.vue'), /Approve posts on the Review step/)
})

test('the page works at narrow widths', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/still-posts.vue', import.meta.url)), 'utf8')
  assert.match(page, /@media \(max-width: 720px\)/)
  assert.match(page, /@media \(max-width: 640px\)/)
  assert.match(page, /\.sp-batch-row \{ grid-template-columns: 24px minmax\(0, 1fr\); \}/, 'the batch list stacks')
  assert.match(page, /\.sp-publish-actions \{ grid-column: 1 \/ -1; justify-content: flex-start; \}/, 'publish actions wrap')
})
