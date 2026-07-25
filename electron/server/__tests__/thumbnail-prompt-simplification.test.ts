import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildThumbnailPrompt,
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

test('annotated-collage niches get callout guidance without generic collage conflicts', () => {
  const directive = buildThumbnailDirective({
    thumbs: 3,
    title: 'The Economics of Owning a Coffee Shop',
    textStyle: 'auto',
    fontStyle: 'auto',
    textPosition: 'top',
    fmt: {
      layout: 'annotated-collage',
      conceptGuidance: 'A coffee shop surrounded by operating-cost callouts.',
      compositionRules: [
        'One central storefront',
        'Six small supporting callouts',
      ],
      defaultFontStyle: 'bold',
      avoid: ['dark background'],
    },
  })

  assert.match(directive, /annotated explainer cover/i)
  assert.match(directive, /central anchor subject/i)
  assert.match(directive, /Six small supporting callouts/i)
  assert.match(directive, /bold sweeping sans-serif letters/i)
  assert.doesNotMatch(directive, /busy collages or multiple competing subjects/i)
  assert.match(directive, /dense undifferentiated montage/i)
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

test('composite recipes reserve a text-free generation and keep the title for Story Studio overlay', () => {
  const directive = buildThumbnailDirective({
    thumbs: 1,
    title: 'The Economics of a Coffee Shop',
    textStyle: 'shadow',
    fontStyle: 'bold',
    textPosition: 'top',
    titleMode: 'composite',
    fmt: {
      layout: 'annotated-collage',
      conceptGuidance: 'One central storefront with operating objects.',
      requiredElements: ['one central business hero', 'six supporting operating objects'],
      visualStyleGuidance: 'Clean original hand-drawn editorial board.',
    },
  })
  const fixed = enforceThumbnailPromptElements('A central coffee storefront.', {
    aspectRatio: '16:9',
    title: 'The Economics of a Coffee Shop',
    titleMode: 'composite',
  })

  assert.match(directive, /do NOT render any letters, words, numerals, logos, labels, or watermarks/i)
  assert.match(directive, /six supporting operating objects/i)
  assert.doesNotMatch(directive, /render “The Economics of a Coffee Shop”/i)
  assert.match(fixed, /do not render letters, words, numbers, labels, logos, watermarks, or fake typography/i)
  assert.doesNotMatch(fixed, /inside the image/i)
})

test('the thumbnail executor sends a thumbnail-only response contract', () => {
  const prompt = buildThumbnailPrompt({
    episodeId: 'EP0057',
    title: 'A Better Thumbnail',
    storyContext: 'A concise story summary.',
    castBlock: '',
    count: 3,
    styleTag: 'editorial illustration',
    aspectRatio: '16:9',
    thumbnailDirective: 'Keep one dominant focal subject.',
    targetNumbers: [1, 2, 3],
  })

  assert.match(prompt, /exactly 3 distinct YouTube thumbnail briefs/i)
  assert.match(prompt, /"title": "A Better Thumbnail"/)
  assert.match(prompt, /"thumbnails"/)
  assert.doesNotMatch(prompt, /scene prompts/i)
  assert.doesNotMatch(prompt, /"scenes"/)
})
