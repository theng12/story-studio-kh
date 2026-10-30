/**
 * Still Posts — everything that can be visual is visual (owner, 2026-10-30).
 *
 * What is proved here, from the page and its step components:
 *  - the format and the layout are popups of sample cards, and each sample is drawn from the option's
 *    own box data (so a sample can never drift from the renderer);
 *  - a format with no sample says "No sample yet" instead of borrowing a picture;
 *  - the frames are shapes, the drawing choice is shown as pictures, the fonts are shown in their own
 *    face, text size has a live sample, and placement is a diagram;
 *  - the writing and image models are the SAME pickers the other generators use, and the Settings
 *    default is never written into the preset;
 *  - the logo is picked as a file, never typed as a path.
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

test('format and layout are popups of cards with a sample each', () => {
  const format = component('StillPostsFormatPicker.vue')
  assert.match(format, /PickerDialog/, 'the format list opens in the shared picker dialog')
  assert.match(format, /No sample yet/, 'a format with no sample says so, plainly')
  assert.match(format, /sampleUrl\(format\.id\)/, 'each card shows that format\'s own sample')
  assert.match(format, /formatSampleUrl\(id\)/, 'through the one sample-address helper')
  assert.match(format, /role="radiogroup"/, 'the cards are a single choice')

  const layout = component('StillPostsLayoutPicker.vue')
  assert.match(layout, /PickerDialog/)
  assert.match(layout, /StillPostsLayoutSample/, 'each layout card is drawn, not described')
})

test('the layout sample is drawn from the real option data, with no duplicated coordinates', () => {
  const sample = component('StillPostsLayoutSample.vue')
  assert.match(sample, /props\.option\.text\.map/, 'the boxes come from the option itself')
  assert.match(sample, /box\.x_pct/, 'the centre comes from the option')
  assert.match(sample, /box\.width_pct/)
  assert.match(sample, /box\.align/)
  // No literal percentages that could drift from the catalogue.
  assert.doesNotMatch(sample, /left:\s*['"]\d+%/, 'no hardcoded box coordinates')
  // The format's own ink and panel colour are used, not a made-up palette.
  assert.match(sample, /fill/)
  assert.match(sample, /text_background/)
})

test('frames are shapes, drawings are pictures, and the two drawing choices say what they cost', () => {
  const frames = component('StillPostsFramePicker.vue')
  assert.match(frames, /shape-\$\{aspect\.replace\(':', '-'\)\}/, 'each frame is its own shape')
  assert.match(frames, /aria-pressed/, 'a shape toggle says whether it is on')
  // The last frame can never be turned off: a post with no frame has nothing to publish.
  assert.match(frames, /props\.modelValue\.length === 1/)

  const modes = component('StillPostsDrawModePicker.vue')
  assert.match(modes, /One drawing, fitted to each size \(default\)/)
  assert.match(modes, /A fresh drawing for each size \(up to 3× the drawings\)/)
  assert.match(modes, /role="radiogroup"/)
})

test('fonts are shown in their own face, text size has a live sample, and placement is a diagram', () => {
  const font = component('StillPostsFontSample.vue')
  assert.match(font, /fontSampleUrl\(props\.fontId, preset\.language/, 'the sample is in the post\'s language')
  assert.match(font, /This face cannot draw this language/, 'a face that cannot draw the line says so')
  assert.match(source, /still-posts\/font-sample/, 'the page asks the REAL renderer for the sample')

  const size = component('StillPostsTextSize.vue')
  assert.match(size, /StillPostsFontSample/, 'the size is shown, not only described')
  assert.match(size, /:scale="value"/, 'the sample follows the slider')

  const position = component('StillPostsPositionPicker.vue')
  assert.match(position, /role="radiogroup"/)
  for (const anchor of ['top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right']) {
    assert.ok(position.includes(`'${anchor}'`), `the diagram offers ${anchor}`)
  }
})

test('the writing and image models are the shared pickers, and the default never enters the preset', () => {
  const write = component('StillPostsWrite.vue')
  const draw = component('StillPostsDraw.vue')
  assert.match(write, /<ModelSelector/, 'the writing model uses the same picker as every writing page')
  assert.match(write, /writing-step/, 'so the Settings default is the last link of the chain (§7)')
  assert.match(draw, /<ImageModelPicker/, 'the image model uses the same picker as every image page')
  // The page shows the default but never stores it as the customer's choice.
  assert.match(source, /writingModelChoice/)
  assert.match(source, /if \(!preset\.writing_model && value === appDefaults\.value\.writing\) return/)
  assert.match(source, /if \(!preset\.image_model && value === appDefaults\.value\.image\) return/)
  assert.match(source, /normalizeDefaultModels/)
})

test('the logo is picked as a file, never typed as a path', () => {
  const logo = component('StillPostsLogoField.vue')
  assert.match(logo, /<FilePicker/, 'the logo uses the app\'s file picker')
  assert.doesNotMatch(logo, /<input[^>]*type="text"/, 'there is no typed path box')
  assert.match(logo, /still-posts\/logo/, 'the stored logo is shown as a picture')
  assert.doesNotMatch(source, /Logo file<\/span>\s*<input/, 'the old typed logo field is gone')
})
