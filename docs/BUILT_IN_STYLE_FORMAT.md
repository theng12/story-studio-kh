# Story Studio KH Built-in Style Format

This is the contract for adding permanent looks to the searchable Style Library. Built-in styles ship with the app, work offline, and provide the canonical art direction used by Character Sheet, prompt generation, and image rendering.

## Source of truth

- Metadata: `frontend/composables/useBuiltInStyles.ts`
- Preview assets: `frontend/public/builtin-style-previews/`
- Library UI: `frontend/components/BuiltInStyleLibraryModal.vue`
- Validation: `frontend/__tests__/builtInStyles.test.ts`

Do not create a second built-in style list in a page, generator, or settings file. Every permanent style belongs in `BUILT_IN_STYLES`.

## Accepted entry

```ts
{
  id: 'builtin-short-kebab-name',
  name: 'Human Readable Name',
  builtin: true,
  blurb: 'One concise sentence describing the visible result.',
  category: 'Digital',
  tags: ['search alias', 'medium', 'mood', 'technique', 'subject fit'],
  data: {
    style_bible:
      'medium, art movement or rendering language, line and shape treatment, palette, lighting, texture, subject design, composition, atmosphere',
    negative_prompt:
      'conflicting media, unwanted rendering traits, common image defects, text, watermark',
  },
  preview_image: '/builtin-style-previews/short-kebab-name.webp',
}
```

Required categories are intentionally broad so 100+ styles remain browsable:

- `Digital`: pixel art, anime, retro-computer, digital illustration, game aesthetics.
- `Explainer`: whiteboard, vector, diagram, stick figure, educational editorial looks.
- `Illustration`: watercolor, ink, oil, printmaking, collage, storybook, hand-made media.
- `Realistic`: photography, cinematic, documentary, studio, miniature, realistic 3D looks.

If the library eventually needs another category, add it to the `BuiltInStyle.category` union and update existing tests. Do not create a category for one style; use tags for narrower concepts.

## Prompt rules

The `style_bible` describes the visual language, not episode content. It should cover:

1. Medium and rendering method.
2. Line, edge, shape, and detail treatment.
3. Palette and color behavior.
4. Lighting and shadows.
5. Texture or surface treatment.
6. Character or subject design language.
7. Composition and framing tendencies.
8. Mood and atmosphere.

Avoid named characters, channel names, episode subjects, scene actions, aspect ratios, model IDs, provider syntax, and instructions to copy a living artist. Scene content is supplied separately. The negative prompt should remove genuinely conflicting traits without suppressing valid scene content.

## Preview asset rules

- Generate a truthful example with the exact `style_bible`; do not use a look-alike stock image.
- Use a 16:9 landscape composition with no important text, logo, or watermark.
- Save as WebP under `frontend/public/builtin-style-previews/`.
- Use the style ID without the `builtin-` prefix as the filename.
- Keep enough quality to show texture and line treatment. The regression test rejects files smaller than 20 KB.
- The preview must be committed with the metadata entry. A missing preview is a release blocker, even though the UI has an emergency on-demand fallback.

## Add a style safely

1. Analyze references for reusable visual traits only; do not copy captions, characters, logos, or exact compositions.
2. Choose a stable `builtin-*` ID, one broad category, and three to eight useful search tags.
3. Write the positive and negative style prompts using the contract above.
4. Generate and visually verify the 16:9 preview.
5. Add the WebP and the `BUILT_IN_STYLES` entry.
6. Run `npm --prefix frontend test -- builtInStyles` if a focused runner exists, otherwise run `npm run test:frontend`.
7. Run `npm --prefix frontend run typecheck` and confirm the Style Library search finds the name, category, and tags.

## Handoff prompt for another session

```text
Add permanent art styles to Story Studio KH using docs/BUILT_IN_STYLE_FORMAT.md as the strict contract.

For every supplied reference set:
- analyze only reusable visual traits;
- propose a unique builtin-* ID, concise name, one allowed category, and useful search tags;
- write a content-independent style_bible and a conflict-focused negative_prompt;
- generate one truthful 16:9 WebP preview using that exact style direction;
- add the metadata only to frontend/composables/useBuiltInStyles.ts;
- save previews only in frontend/public/builtin-style-previews/;
- do not create page-local style catalogs or restore retired custom-style systems;
- run the built-in style regression test and frontend typecheck;
- list any reference whose style cannot be represented honestly instead of inventing a misleading preview.
```

