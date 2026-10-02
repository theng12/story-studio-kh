/**
 * The review grids ask for the small cached thumbnail; only the lightbox loads the full image.
 * What this cannot catch: the server side (electron/server/__tests__/scene-review-thumbnails.test.ts).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name: string) => readFileSync(new URL(`../pages/projects/[slug]/${name}`, import.meta.url), 'utf8')

test('Scene Review: grid cards use thumbUrl, the lightbox keeps the full-resolution URL', () => {
  const source = read('scene-review.vue')
  assert.match(source, /class="review-thumb"/)
  const card = source.slice(source.lastIndexOf('<img', source.indexOf('class="review-thumb"')), source.indexOf('class="review-thumb"'))
  assert.match(card, /:src="thumbUrl\(scene\)"/)
  const lightbox = source.slice(source.indexOf('class="sr-lb-img"') - 200, source.indexOf('class="sr-lb-img"'))
  assert.match(lightbox, /:src="imageUrl\(previewScene\)"/)
  assert.match(source, /return `\$\{imageUrl\(scene\)\}&thumb=1`/)
})

test('Motion Review: the grid still is the thumbnail', () => {
  assert.match(read('motion-review.vue'), /\/image\/\$\{scene\.id\}\?t=\$\{cacheBuster\.value\}&thumb=1/)
})
