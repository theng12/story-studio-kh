/**
 * Motion Review must not fetch and decode every scene image the moment the page opens.
 *
 * The grid renders one card per scene, each with the approved still. Without `loading="lazy"` a
 * 150-scene episode requested all 150 full-resolution stills at once (3-5 MB each, ~6 MB decoded each)
 * on a 16 GB Mac, although a handful are on screen. The motion `<video>` already had `preload="none"`.
 * Scene Review's grid has always been lazy; this pins the same for Motion Review.
 *
 * What this cannot catch: a thumbnail-sized derivative would cut the bytes further; it only keeps the
 * off-screen cards from loading at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

test('every scene image in the Motion Review grid is lazy and decoded off the main thread', () => {
  const images = [...source.matchAll(/<img\b[^>]*>/g)].map(match => match[0])
  assert.ok(images.length >= 1, 'the grid renders scene images')
  for (const tag of images) {
    assert.match(tag, /loading="lazy"/, tag)
    assert.match(tag, /decoding="async"/, tag)
  }
})
