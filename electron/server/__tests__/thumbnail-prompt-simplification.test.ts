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

  assert.match(directive, /render this exact title inside the image/i)
  assert.match(directive, /six supporting operating objects/i)
  assert.match(fixed, /Render the exact title "The Economics of a Coffee Shop" inside the image/i)
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

  assert.match(directive, /render this exact title inside the image/i)
  assert.match(directive, /The Loan That Changed Egypt/)
  assert.match(directive, /parchment map/i)
  assert.match(directive, /stacked white headline bands/i)
  assert.match(directive, /unsupported secret plots/i)
  assert.match(directive, /sole-cause claim/i)
})

test('signed Archival Ledger recipe keeps the archival map composition rules in its effective prompt', async () => {
  const source = new URL('../../../content-packs/paid/archival-ledger/thumbnail/archival-map-investigation/content/thumbnail-recipe.json', import.meta.url)
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

  // Wording moved into the shared headline-mode catalogue in 1.4.56, where
  // every invented mode carries an explicit word budget. The two guarantees
  // this test exists for are unchanged: the hook is truthful and curiosity-
  // driving, and it never falls back to the full episode title.
  assert.match(directive, /truthful, curiosity-driving question/i)
  assert.match(directive, /at most 5 words/i)
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

/**
 * The owner reported thumbnails with the word "Episode" lettered into the art.
 *
 * Titles ARE drawn on purpose, so the fix is not to stop sending the title --
 * it is to stop sending the LABEL attached to it. Every prompt that reaches an
 * image model passes through `enforceThumbnailPromptElements`, so that is where
 * the guarantee is asserted.
 *
 * The inputs below are real phrasings taken from shipped content-pack headline
 * guidance, niche concept guidance, and LLM-authored prompts -- not invented
 * strings -- so a passing run means the rule holds against the corpus that
 * actually caused the bug.
 */
test('no emitted thumbnail prompt labels the drawn text as an "episode" title', () => {
  const realWorldPhrasings = [
    'Render the exact episode title as one big centered all-caps headline.',
    'Reserve an uncluttered upper title-safe band for the complete exact episode title.',
    'Render the complete intended full episode title directly into the title card.',
    'Reserve the top quarter for a compact two-line uppercase episode title.',
    'Two to four stacked white bands containing the exact episode title.',
    'Keep the full YouTube episode title out of the artwork.',
    "Set the episode's title in large condensed type against the background.",
    'A weathered map with the Episode Title lettered across the lower third.',
    'Use an episode-title block anchored right inside the safe margins.',
  ]

  for (const prompt of realWorldPhrasings) {
    const emitted = enforceThumbnailPromptElements(prompt, {
      aspectRatio: '16:9',
      title: 'The Loan That Changed Egypt',
    })
    assert.doesNotMatch(
      emitted,
      /\bepisode(?:['’]s)?[\s-]+(?:title|headline)\b/i,
      `"episode" still labels the drawn text in: ${emitted}`,
    )
    // The title itself must survive -- this is a label fix, not a text removal.
    assert.match(emitted, /title/i)
  }
})

test('the enforcement pass never emits the episode label in its own added clause', () => {
  // Title absent from the prompt: the pass appends its own render clause, which
  // is the path that produced the reported thumbnails.
  const appended = enforceThumbnailPromptElements('A lone ship against a storm.', {
    aspectRatio: '16:9',
    title: 'The Impossible Storm',
    headlineMode: 'episode-title',
  })
  assert.match(appended, /Render the exact title "The Impossible Storm" inside the image/i)
  assert.doesNotMatch(appended, /\bepisode(?:['’]s)?[\s-]+(?:title|headline)\b/i)

  const hook = enforceThumbnailPromptElements('A single poison bottle.', {
    aspectRatio: '16:9',
    title: 'POISON OR CURE?',
    headlineMode: 'curiosity-hook',
  })
  assert.match(hook, /exact thumbnail hook "POISON OR CURE\?"/i)
  assert.doesNotMatch(hook, /\bepisode(?:['’]s)?[\s-]+(?:title|headline)\b/i)
})

test('stripping the episode label leaves unrelated mentions of the episode alone', () => {
  const emitted = enforceThumbnailPromptElements(
    'A cinematic moment from the episode: a lone ship in a storm, 16:9 thumbnail.',
    { aspectRatio: '16:9', title: 'The Impossible Storm' },
  )
  assert.match(emitted, /moment from the episode/i)
})
