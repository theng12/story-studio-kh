// v1.0.364 — Shipped style library (the single source of truth).
//
// A "style" is the channel LOOK: the medium / art style / rendering / palette
// that rides on every scene. It maps onto continuity.json's `style_bible`
// (applied at render to every prompt) plus a `negative_prompt`. These ship with
// the app so a user can pick one instead of writing art direction by hand.
//
// Used by both the Character Sheet and the Scene Plan via <StylePicker>, so the
// SAME look + the SAME gallery appear wherever the style is set. Custom looks
// are still savable through the existing Continuity page preset.
//
// `preview_image`, when set, is a bundled thumbnail shown instantly (no
// generation). Until a style is baked, <StylePicker> falls back to the
// on-demand /style-preview render so the card is never blank.

export interface BuiltInStyle {
  id: string
  name: string
  /** Always true — distinguishes shipped styles from user-saved looks. */
  builtin: true
  /** One-line description shown under the name. */
  blurb: string
  data: {
    /** The look, appended to every scene at render (continuity.json style_bible). */
    style_bible: string
    /** Things to avoid, where the provider supports a negative prompt. */
    negative_prompt: string
  }
  /** Optional bundled preview path (served by the backend). When absent the
   *  picker renders an on-demand preview instead. */
  preview_image?: string
}

export const BUILT_IN_STYLES: BuiltInStyle[] = [
  {
    id: 'builtin-ms-paint-fantasy',
    name: 'MS Paint Fantasy',
    builtin: true,
    blurb: 'Deliberately rough fantasy art with thick outlines, flat fills, and goofy old-web energy.',
    data: {
      style_bible:
        'crude MS Paint fantasy art, retro internet animation aesthetic, medieval fantasy atmosphere, thick black outlines, rough hand-drawn lines, flat colors, limited color palette, simple shading, intentionally low-detail rendering, expressive faces, minimal textures, clean digital fill areas, dramatic perspective, wide-angle framing, dynamic off-center composition',
      negative_prompt:
        'photorealism, realistic anatomy, cinematic realism, ultra detailed rendering, 3D render, smooth skin, glossy realism, centered composition',
    },
    preview_image: '/builtin-style-previews/ms-paint-fantasy.svg',
  },
  {
    id: 'builtin-pixel-art-story',
    name: 'Pixel Art Story',
    builtin: true,
    blurb: 'Readable retro RPG pixel art with strong silhouettes and playful adventure framing.',
    data: {
      style_bible:
        '16-bit pixel art fantasy, retro RPG aesthetic, pixel-defined edges, restricted retro palette, clean sprite-like forms, readable silhouettes, tileable background logic, playful scene staging, side-scrolling adventure energy, simple dramatic lighting translated into pixel clusters',
      negative_prompt:
        'photorealism, painterly brushwork, smooth gradients, ultra detailed rendering, 3D render, soft airbrush shading, realistic skin texture, centered static composition',
    },
    preview_image: '/builtin-style-previews/pixel-art-story.svg',
  },
  {
    // v1.0.364 — user-requested from a Shackleton / Antarctic-expedition study reference.
    id: 'builtin-sepia-ink-wash',
    name: 'Sepia Ink & Wash',
    builtin: true,
    blurb: 'Muted line-and-wash illustration — fine ink over desaturated watercolor, lamplit and weathered, like a period expedition journal.',
    data: {
      style_bible:
        'line-and-wash illustration, fine pen-and-ink linework over loose watercolor washes, heavily desaturated muted palette, sepia browns and charcoal greys with cold blue-grey shadows, warm lamplight accents, dim atmospheric lighting, low contrast, aged foxed paper texture, granulated watercolor, subtle crosshatching in the shadows, painterly editorial illustration, somber contemplative historical mood, soft vignette at the edges, early-20th-century documentary feel',
      negative_prompt:
        'vivid saturated colours, neon, photorealism, 3D render, glossy CGI, clean flat vector, bright cheerful palette, hard digital edges, anime, lens flare',
    },
    preview_image: '/builtin-style-previews/sepia-ink-wash.svg',
  },
  {
    id: 'builtin-watercolor-storybook',
    name: 'Watercolor Storybook',
    builtin: true,
    blurb: 'Soft children’s-book watercolor — gentle washes, rounded shapes, warm and cozy.',
    data: {
      style_bible:
        'soft watercolor storybook illustration, gentle layered washes, visible paper grain, warm inviting palette, rounded friendly shapes, light pencil underdrawing, soft diffuse lighting, whimsical cozy mood, hand-painted picture-book aesthetic, delicate colour bleeds, airy negative space',
      negative_prompt:
        'photorealism, 3D render, harsh contrast, neon colours, hard vector edges, gritty texture, horror, heavy black outlines',
    },
    preview_image: '/builtin-style-previews/watercolor-storybook.svg',
  },
  {
    id: 'builtin-prehistoric-stick-cartoon',
    name: 'Prehistoric Stick Cartoon',
    builtin: true,
    blurb: 'Playful history-explainer cartoon with stick-limbed cave people, mammoths, flat snowy scenes, and bold black outlines.',
    data: {
      style_bible:
        'simple 2D educational cartoon, prehistoric explainer animation style, white round faces with tiny dot eyes and simple smiles, thin stick-limbed human bodies, shaggy brown cave-hair silhouettes, thick clean black outlines, flat digital colors, soft limited palette, pale icy blues and warm browns, friendly mammoths and primitive camp scenes, uncluttered wide composition, readable storytelling silhouettes, light playful tone, minimal shading, smooth clean fills, YouTube explainer thumbnail energy',
      negative_prompt:
        'photorealism, painterly brushwork, 3D render, realistic anatomy, cinematic lighting, detailed textures, gritty darkness, heavy gradients, anime rendering, realistic skin pores, horror mood, complex background clutter',
    },
    preview_image: '/builtin-style-previews/prehistoric-stick-cartoon.svg',
  },
  {
    id: 'builtin-cinematic-photoreal',
    name: 'Cinematic Photoreal',
    builtin: true,
    blurb: 'Filmic photoreal look — shallow depth of field, golden-hour light, graded like a movie still.',
    data: {
      style_bible:
        'cinematic photorealistic still, shallow depth of field, soft bokeh, golden-hour key light with cool fill, filmic colour grade, gentle film grain, naturalistic skin and materials, anamorphic framing, volumetric atmosphere, high dynamic range, prestige-drama mood',
      negative_prompt:
        'cartoon, illustration, flat colours, hard outlines, lowres, oversaturated, plastic CGI look, harsh on-camera flash, text, watermark',
    },
    preview_image: '/builtin-style-previews/cinematic-photoreal.svg',
  },
  {
    id: 'builtin-flat-vector-explainer',
    name: 'Flat Vector Explainer',
    builtin: true,
    blurb: 'Clean flat-vector infographic look — bold shapes, limited palette, crisp and modern.',
    data: {
      style_bible:
        'clean flat vector illustration, bold simple geometric shapes, limited modern palette of three to four colours, no gradients, crisp even line weights, generous negative space, friendly explainer-video aesthetic, balanced flat lighting, clear readable silhouettes, minimal detail',
      negative_prompt:
        'photorealism, 3D render, painterly brushwork, texture, gradients, film grain, busy clutter, realistic shading, sketchy lines',
    },
    preview_image: '/builtin-style-previews/flat-vector-explainer.svg',
  },
  {
    id: 'builtin-oil-painting-classical',
    name: 'Oil Painting Classical',
    builtin: true,
    blurb: 'Old-master oil painting — rich impasto, chiaroscuro lighting, museum-canvas depth.',
    data: {
      style_bible:
        'classical oil painting, old-master technique, visible impasto brushwork, rich layered glazes, deep chiaroscuro lighting, warm earthen palette with deep shadows, canvas texture, dramatic single light source, baroque atmosphere, painterly edges, museum-quality depth',
      negative_prompt:
        'flat vector, pixel art, cartoon, neon colours, 3D CGI render, hard digital edges, lowres, modern clip-art, text, watermark',
    },
    preview_image: '/builtin-style-previews/oil-painting-classical.svg',
  },
  {
    id: 'builtin-anime-cel',
    name: 'Anime Cel',
    builtin: true,
    blurb: 'Modern anime cel-shading — clean lineart, flat cel light, expressive and vivid.',
    data: {
      style_bible:
        'modern anime cel-shaded illustration, clean confident lineart, flat cel shading with crisp shadow shapes, vivid but harmonious palette, expressive faces, soft rim light, detailed painted backgrounds, dynamic composition, key-visual quality, subtle gradient skies',
      negative_prompt:
        'photorealism, 3D render, western cartoon, muddy colours, sketchy unfinished lines, heavy film grain, realistic skin pores, text, watermark',
    },
    preview_image: '/builtin-style-previews/anime-cel.svg',
  },
]
