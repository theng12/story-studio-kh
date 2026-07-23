import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildThumbnailDirective,
  enforceThumbnailPromptElements,
} from '../generators/image-prompts.js'

test('thumbnail prompts use one user idea and render the episode title in the image', () => {
  const directive = buildThumbnailDirective({
    thumbs: 3,
    title: 'The Impossible Storm',
    textStyle: 'neon',
    fontStyle: 'display',
    textPosition: 'top',
    creativeDirection: 'A lone ship against an impossible storm.',
    referenceStyle: 'Bold silhouette, cold teal palette, huge wave behind the ship.',
  })

  assert.match(directive, /USER IDEA: A lone ship/i)
  assert.match(directive, /REFERENCE DIRECTION: Bold silhouette/i)
  assert.match(directive, /The Impossible Storm/)
  assert.match(directive, /inside the image/i)
  assert.match(directive, /neon glow/i)
  assert.match(directive, /large display headline font/i)
  assert.match(directive, /place it at the top/i)
})

test('auto title controls give the LLM freedom to vary the title treatment', () => {
  const directive = buildThumbnailDirective({
    thumbs: 1,
    title: 'The Impossible Storm',
    textStyle: 'auto',
    fontStyle: 'auto',
    textPosition: 'auto',
  })

  assert.match(directive, /choose the font, text treatment, and placement/i)
})

test('thumbnail prompt repair preserves the aspect ratio and ready-to-use title', () => {
  const fixed = enforceThumbnailPromptElements('A storm-tossed ship lit by lightning.', {
    aspectRatio: '16:9',
    title: 'The Impossible Storm',
  })

  assert.match(fixed, /YouTube thumbnail \(16:9\)/i)
  assert.match(fixed, /The Impossible Storm/)
  assert.match(fixed, /inside the image/i)
})
