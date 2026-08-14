import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildThumbnailPrompt,
  buildThumbnailDirective,
  enforceThumbnailPromptElements,
} from '../generators/image-prompts.js'
import { readFile } from 'node:fs/promises'
import { contentPackDocumentToThumbnailTemplate } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import type { ContentPackDocument } from '../content-packs/types.js'

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

test('recipe thumbnails instruct the image model to render the complete episode title', () => {
  const directive = buildThumbnailDirective({
    thumbs: 1,
    title: 'The Economics of a Coffee Shop',
    textStyle: 'shadow',
    fontStyle: 'bold',
    textPosition: 'top',
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
  })

  assert.match(directive, /render this exact episode title inside the image/i)
  assert.match(directive, /six supporting operating objects/i)
  assert.match(fixed, /Render the exact episode title "The Economics of a Coffee Shop" inside the image/i)
})

test('archival map investigation keeps the exact title and evidence-led safety rules', () => {
  const directive = buildThumbnailDirective({
    thumbs: 1,
    title: 'The Loan That Changed Egypt',
    textStyle: 'shadow',
    fontStyle: 'bold',
    textPosition: 'bottom',
    fmt: {
      layout: 'annotated-collage',
      conceptGuidance: 'An evidence-led historical investigation.',
      compositionRules: ['Place a weathered parchment map in the upper-right.', 'Render the exact episode title in two to four stacked white headline bands.'],
      requiredElements: ['one period portrait or defining historical artifact', 'one marked parchment map'],
      avoid: ['unsupported secret plots', 'a sole-cause claim'],
    },
  })

  assert.match(directive, /render this exact episode title inside the image/i)
  assert.match(directive, /The Loan That Changed Egypt/)
  assert.match(directive, /parchment map/i)
  assert.match(directive, /stacked white headline bands/i)
  assert.match(directive, /unsupported secret plots/i)
  assert.match(directive, /sole-cause claim/i)
})

test('signed Archival Ledger recipe keeps the archival map composition rules in its effective prompt', async () => {
  const source = new URL('../../../content-packs/archival-ledger/content/thumbnail-recipe.json', import.meta.url)
  const legacySource = new URL('../thumbnail-templates/archival-map-investigation.json', import.meta.url)
  const document = parseContentPackDocument('thumbnail-recipe', JSON.parse(await readFile(source, 'utf8'))) as Extract<ContentPackDocument, { kind: 'thumbnail-recipe' }>
  const legacy = JSON.parse(await readFile(legacySource, 'utf8'))
  const template = contentPackDocumentToThumbnailTemplate(document, [])
  assert.ok(template.recipe)
  const directive = buildThumbnailDirective({
    thumbs: 1,
    title: 'The Loan That Changed Egypt',
    textStyle: 'shadow',
    fontStyle: 'bold',
    textPosition: 'bottom',
    fmt: template.recipe,
  })

  assert.deepEqual(template.recipe.compositionRules, [
    "Place one original period portrait or defining artifact in the left third; never reuse a real channel's crop, identity treatment, logo, or branding.",
    'Place a weathered parchment map in the upper-right with only a few clear route arrows, dots, or boundary marks; preserve a clean visual hierarchy rather than a dense infographic.',
    'Use a narrow lower-right archival-event strip showing a relevant historical setting, document, crowd, ship, rail line, market, or institution.',
    'Reserve the lower-left to lower-middle as a title-safe zone for two to four stacked white headline bands. Render the exact episode title in those bands as bold, readable black uppercase lettering.',
    'Use black, cream, sepia, and restrained oxblood accents; keep the image sober, legible, and mobile-readable.',
  ])
  assert.match(directive, /parchment map/i)
  assert.match(directive, /stacked white headline bands/i)
  const legacyDirective = buildThumbnailDirective({
    thumbs: 1,
    title: 'The Loan That Changed Egypt',
    textStyle: 'shadow',
    fontStyle: 'bold',
    textPosition: 'bottom',
    fmt: legacy.recipe,
  })
  assert.equal(directive.replace(/\r\n/g, '\n'), legacyDirective.replace(/\r\n/g, '\n'))
})

test('curiosity-hook recipes keep a short truthful hook separate from the full episode title', () => {
  const directive = buildThumbnailDirective({
    thumbs: 1,
    title: 'Why Do Poison Dart Frogs Carry Toxins?',
    textStyle: 'shadow',
    fontStyle: 'bold',
    textPosition: 'top',
    fmt: {
      layout: 'hero',
      conceptGuidance: 'One huge frog and one worried scientist.',
      headlineMode: 'curiosity-hook',
      headlineGuidance: 'Use 1–4 truthful words only.',
    },
  })
  const fixed = enforceThumbnailPromptElements('A giant frog on a leaf.', {
    aspectRatio: '16:9',
    title: 'POISON OR CURE?',
    headlineMode: 'curiosity-hook',
  })
  const prompt = buildThumbnailPrompt({
    episodeId: 'EP0058',
    title: 'Why Do Poison Dart Frogs Carry Toxins?',
    storyContext: 'A factual biology explainer.',
    castBlock: '',
    count: 1,
    styleTag: 'waxy outline cartoon',
    aspectRatio: '16:9',
    thumbnailDirective: directive,
    targetNumbers: [1],
    headlineMode: 'curiosity-hook',
  })

  assert.match(directive, /truthful, curiosity-driving thumbnail hook/i)
  assert.match(directive, /Do not render the full episode title/i)
  assert.match(fixed, /exact thumbnail hook "POISON OR CURE\?"/i)
  assert.match(prompt, /Invent a truthful 1–4 word curiosity hook/i)
  assert.match(prompt, /SHORT CURIOSITY HOOK/)
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
