// v1.0.364 — Shipped style library (the single source of truth).
//
// A "style" is the channel LOOK: the medium / art style / rendering / palette
// that rides on every scene. It maps onto continuity.json's `style_bible`
// (applied at render to every prompt) plus a `negative_prompt`. These ship with
// the app so a user can pick one instead of writing art direction by hand.
//
// Used by Character Sheet, Thumbnail Prompts, and project Settings through the
// shared style-library components, so the same look appears wherever style is
// selected. Scene Plan consumes the Character Sheet choice rather than owning
// another style selector.
//
// Every shipped style owns a real generated preview so the gallery accurately
// demonstrates the selected look without spending credits or relying on a
// network connection.

export interface BuiltInStyle {
  id: string
  name: string
  /** Always true — distinguishes shipped styles from user-saved looks. */
  builtin: true
  /** One-line description shown under the name. */
  blurb: string
  /** Broad library grouping used by the scalable style browser. */
  category: 'Digital' | 'Explainer' | 'Illustration' | 'Realistic'
  /** Search aliases. Keep these short and visual rather than channel-specific. */
  tags: string[]
  data: {
    /** The look, appended to every scene at render (continuity.json style_bible). */
    style_bible: string
    /** Things to avoid, where the provider supports a negative prompt. */
    negative_prompt: string
  }
  /** Bundled generated preview path, served with the frontend. */
  preview_image: string
}

export const BUILT_IN_STYLES: BuiltInStyle[] = [
  {
    id: 'builtin-ms-paint-fantasy',
    name: 'MS Paint Fantasy',
    builtin: true,
    blurb: 'Deliberately rough fantasy art with thick outlines, flat fills, and goofy old-web energy.',
    category: 'Digital',
    tags: ['retro', 'fantasy', 'rough', 'flat color', 'old web'],
    data: {
      style_bible:
        'crude MS Paint fantasy art, retro internet animation aesthetic, medieval fantasy atmosphere, thick black outlines, rough hand-drawn lines, flat colors, limited color palette, simple shading, intentionally low-detail rendering, expressive faces, minimal textures, clean digital fill areas, dramatic perspective, wide-angle framing, dynamic off-center composition',
      negative_prompt:
        'photorealism, realistic anatomy, cinematic realism, ultra detailed rendering, 3D render, smooth skin, glossy realism, centered composition',
    },
    preview_image: '/builtin-style-previews/ms-paint-fantasy.webp',
  },
  {
    id: 'builtin-pixel-art-story',
    name: 'Pixel Art Story',
    builtin: true,
    blurb: 'Readable retro RPG pixel art with strong silhouettes and playful adventure framing.',
    category: 'Digital',
    tags: ['pixel', 'retro', 'rpg', 'game', 'fantasy'],
    data: {
      style_bible:
        '16-bit pixel art fantasy, retro RPG aesthetic, pixel-defined edges, restricted retro palette, clean sprite-like forms, readable silhouettes, tileable background logic, playful scene staging, side-scrolling adventure energy, simple dramatic lighting translated into pixel clusters',
      negative_prompt:
        'photorealism, painterly brushwork, smooth gradients, ultra detailed rendering, 3D render, soft airbrush shading, realistic skin texture, centered static composition',
    },
    preview_image: '/builtin-style-previews/pixel-art-story.webp',
  },
  {
    // v1.0.364 — user-requested from a Shackleton / Antarctic-expedition study reference.
    id: 'builtin-sepia-ink-wash',
    name: 'Sepia Ink & Wash',
    builtin: true,
    blurb: 'Muted line-and-wash illustration — fine ink over desaturated watercolor, lamplit and weathered, like a period expedition journal.',
    category: 'Illustration',
    tags: ['historical', 'ink', 'watercolor', 'sepia', 'journal'],
    data: {
      style_bible:
        'line-and-wash illustration, fine pen-and-ink linework over loose watercolor washes, heavily desaturated muted palette, sepia browns and charcoal greys with cold blue-grey shadows, warm lamplight accents, dim atmospheric lighting, low contrast, aged foxed paper texture, granulated watercolor, subtle crosshatching in the shadows, painterly editorial illustration, somber contemplative historical mood, soft vignette at the edges, early-20th-century documentary feel',
      negative_prompt:
        'vivid saturated colours, neon, photorealism, 3D render, glossy CGI, clean flat vector, bright cheerful palette, hard digital edges, anime, lens flare',
    },
    preview_image: '/builtin-style-previews/sepia-ink-wash.webp',
  },
  {
    id: 'builtin-watercolor-storybook',
    name: 'Watercolor Storybook',
    builtin: true,
    blurb: 'Soft children’s-book watercolor — gentle washes, rounded shapes, warm and cozy.',
    category: 'Illustration',
    tags: ['watercolor', 'storybook', 'children', 'cozy', 'painted'],
    data: {
      style_bible:
        'soft watercolor storybook illustration, gentle layered washes, visible paper grain, warm inviting palette, rounded friendly shapes, light pencil underdrawing, soft diffuse lighting, whimsical cozy mood, hand-painted picture-book aesthetic, delicate colour bleeds, airy negative space',
      negative_prompt:
        'photorealism, 3D render, harsh contrast, neon colours, hard vector edges, gritty texture, horror, heavy black outlines',
    },
    preview_image: '/builtin-style-previews/watercolor-storybook.webp',
  },
  {
    id: 'builtin-prehistoric-stick-cartoon',
    name: 'Prehistoric Stick Cartoon',
    builtin: true,
    blurb: 'Playful history-explainer cartoon with stick-limbed cave people, mammoths, flat snowy scenes, and bold black outlines.',
    category: 'Explainer',
    tags: ['history', 'cartoon', 'stick figure', 'educational', 'prehistoric'],
    data: {
      style_bible:
        'simple 2D educational cartoon, prehistoric explainer animation style, white round faces with tiny dot eyes and simple smiles, thin stick-limbed human bodies, shaggy brown cave-hair silhouettes, thick clean black outlines, flat digital colors, soft limited palette, pale icy blues and warm browns, friendly mammoths and primitive camp scenes, uncluttered wide composition, readable storytelling silhouettes, light playful tone, minimal shading, smooth clean fills, YouTube explainer thumbnail energy',
      negative_prompt:
        'photorealism, painterly brushwork, 3D render, realistic anatomy, cinematic lighting, detailed textures, gritty darkness, heavy gradients, anime rendering, realistic skin pores, horror mood, complex background clutter',
    },
    preview_image: '/builtin-style-previews/prehistoric-stick-cartoon.webp',
  },
  {
    id: 'builtin-cinematic-photoreal',
    name: 'Cinematic Photoreal',
    builtin: true,
    blurb: 'Filmic photoreal look — shallow depth of field, golden-hour light, graded like a movie still.',
    category: 'Realistic',
    tags: ['cinematic', 'photo', 'film', 'dramatic', 'realistic'],
    data: {
      style_bible:
        'cinematic photorealistic still, shallow depth of field, soft bokeh, golden-hour key light with cool fill, filmic colour grade, gentle film grain, naturalistic skin and materials, anamorphic framing, volumetric atmosphere, high dynamic range, prestige-drama mood',
      negative_prompt:
        'cartoon, illustration, flat colours, hard outlines, lowres, oversaturated, plastic CGI look, harsh on-camera flash, text, watermark',
    },
    preview_image: '/builtin-style-previews/cinematic-photoreal.webp',
  },
  {
    id: 'builtin-studio-catalog-realism',
    name: 'Studio Catalog Realism',
    builtin: true,
    blurb: 'Crisp tabletop realism with neutral surfaces, honest materials, soft studio light, and carefully staged miniature scenes.',
    category: 'Realistic',
    tags: ['studio', 'catalog', 'diorama', 'product', 'miniature'],
    data: {
      style_bible:
        'clean studio catalog photography, carefully staged physical miniature diorama aesthetic, neutral charcoal textured sweep, soft large-source overhead lighting, natural soft-edged shadows, accurate restrained color, crisp tactile materials, centered product-documentation composition, high depth of field, minimal styling, subtle commercial polish, honest documentary clarity, full subject visible with generous breathing room',
      negative_prompt:
        'logos, packaging, labels, barcodes, typography, watermark, dramatic cinematic lighting, fantasy digital painting, clutter, glossy CGI, floating objects, extreme shallow depth of field, harsh reflections, oversaturated colors',
    },
    preview_image: '/builtin-style-previews/studio-catalog-realism.webp',
  },
  {
    id: 'builtin-flat-vector-explainer',
    name: 'Flat Vector Explainer',
    builtin: true,
    blurb: 'Clean flat-vector infographic look — bold shapes, limited palette, crisp and modern.',
    category: 'Explainer',
    tags: ['vector', 'infographic', 'flat', 'modern', 'educational'],
    data: {
      style_bible:
        'clean flat vector illustration, bold simple geometric shapes, limited modern palette of three to four colours, no gradients, crisp even line weights, generous negative space, friendly explainer-video aesthetic, balanced flat lighting, clear readable silhouettes, minimal detail',
      negative_prompt:
        'photorealism, 3D render, painterly brushwork, texture, gradients, film grain, busy clutter, realistic shading, sketchy lines',
    },
    preview_image: '/builtin-style-previews/flat-vector-explainer.webp',
  },
  {
    id: 'builtin-whiteboard-doodle-explainer',
    name: 'Whiteboard Doodle Explainer',
    builtin: true,
    blurb: 'Hand-drawn whiteboard doodles — stick figures, big expressive faces, one idea per frame.',
    category: 'Explainer',
    tags: ['whiteboard', 'doodle', 'stick figure', 'marker', 'educational'],
    data: {
      style_bible:
        'simple hand-drawn whiteboard-doodle illustration, thick black marker outlines, smooth rounded shapes, clean vector-like lines, minimal detail, high readability at small sizes, looks quickly sketched on a whiteboard, stick-figure humans with circle heads and simple line bodies, highly expressive faces with big eyes and raised eyebrows showing clear emotion, everyday objects simplified into symbolic icons that can be anthropomorphised with faces and personality for visual metaphor, pure white background, one main idea per image, a large central character or object, generous empty space, no realistic perspective or complex environment, arrows and circles and lines to direct attention, simple icons as visual shortcuts, mostly black-and-white line art with limited flat colour accents reserved for important elements only (blue for important or science or earth, yellow for energy or success or discovery, red for danger or problem, green for nature or growth), no realistic lighting, no cinematic shadows, optional big bold uppercase handwritten marker lettering at the top with only a few words',
      negative_prompt:
        'photorealism, 3D render, painterly brushwork, cinematic lighting, realistic shading, gradients, film grain, busy cluttered background, detailed environment, soft airbrush, colour photograph, realistic anatomy',
    },
    preview_image: '/builtin-style-previews/whiteboard-doodle-explainer.webp',
  },
  {
    id: 'builtin-minimal-stick-figure-explainer',
    name: 'Minimal Stick-Figure Explainer',
    builtin: true,
    blurb: 'Polished stick-figure storytelling with expressive faces, generous white space, and restrained color accents.',
    category: 'Explainer',
    tags: ['stick figure', 'minimal', 'editorial', 'white space', 'diagram'],
    data: {
      style_bible:
        'polished minimalist 2D stick-figure editorial explainer, smooth thick black outlines with consistent line weight, round white faces with simple highly expressive eyes eyebrows and mouths, clean line bodies and limbs, icon-like props and visual metaphors, pure white background, generous negative space, one instantly readable idea per frame, simple diagram-like staging, sparse environmental cues, mostly black-and-white artwork with restrained flat muted color accents, red for urgency or emphasis, warm yellow for discovery or success, subdued blue and green for context, subtle light-gray grounding shadows only, crisp professional YouTube explainer illustration, clear at thumbnail size, no texture and no realistic lighting',
      negative_prompt:
        'photorealism, 3D render, painterly brushwork, whiteboard marker texture, rough sketching, scratchy lines, realistic anatomy, cinematic lighting, gradients, detailed scenery, cluttered background, dense colors, complex perspective, illegible text, random letters, watermark',
    },
    preview_image: '/builtin-style-previews/minimal-stick-figure-explainer.webp',
  },
  {
    id: 'builtin-hand-drawn-cartoon-explainer',
    name: 'Hand-Drawn Cartoon Explainer',
    builtin: true,
    blurb: 'Casual YouTube explainer cartoons with rounded mascots, slightly imperfect ink lines, flat muted colors, and familiar everyday props.',
    category: 'Explainer',
    tags: ['hand drawn', 'cartoon', 'mascot', 'educational', 'flat color', 'youtube'],
    data: {
      style_bible:
        'simple hand-drawn 2D cartoon explainer, casual educational YouTube animation aesthetic, clean but slightly uneven thick black outlines, flat solid color fills, muted friendly palette of medium blue, teal, sage green, warm yellow, tan, cream, and grey, round-headed simplified characters with oversized outlined circular eyes, dot pupils, bold eyebrows, and small expressive mouths, black line limbs, rounded plain colored torsos, recognizable everyday props, playful anthropomorphic objects and visual metaphors, simple white or pale cream backgrounds, lightly detailed interiors, one clear visual idea or action per frame, readable medium-wide composition, generous breathing room, minimal shading, soft flat visual treatment, slightly wobbly human-drawn contours rather than geometric vector perfection',
      negative_prompt:
        'photorealism, 3D render, anime, painterly brushwork, glossy polished vector art, perfectly geometric shapes, cinematic lighting, gradients, complex textures, realistic skin, dense clutter, dramatic depth of field, tiny details, illegible writing, random letters, captions, speech bubbles, watermark',
    },
    preview_image: '/builtin-style-previews/hand-drawn-cartoon-explainer.webp',
  },
  {
    id: 'builtin-waxy-outline-cartoon',
    name: 'Waxy Outline Cartoon',
    builtin: true,
    blurb: 'Bold curiosity-cartoon art with waxy imperfect outlines, saturated flats, and instantly readable reactions.',
    category: 'Explainer',
    tags: ['crayon', 'waxy outline', 'cartoon', 'curiosity', 'saturated'],
    data: {
      style_bible:
        'original waxy-outline 2D cartoon illustration, thick black crayon-marker contours with visibly wobbly hand-drawn imperfections and gentle wax texture, flat saturated color blocks in sky blue, leaf green, warm orange, sunny yellow, purple, and small red warning accents, rounded simplified subjects, oversized highly expressive eyes and brows, stick-limbed guide characters only when the scene calls for one, one dominant visual situation with one clear reveal object or reaction, simple location cues with uncluttered layers, readable silhouettes at mobile size, minimal shading, no glossy polish, playful science-and-curiosity explainer energy',
      negative_prompt:
        'photorealism, 3D render, anime, polished vector art, perfectly smooth geometric lines, airbrushed gradients, cinematic lighting, detailed painterly scenery, dense infographic callouts, tiny unreadable labels, copied mascot characters, logos, watermark, random letters, placeholder text',
    },
    preview_image: '/builtin-style-previews/waxy-outline-cartoon.webp',
  },
  {
    id: 'builtin-hand-drawn-editorial-diagram',
    name: 'Hand-Drawn Editorial Diagram',
    builtin: true,
    blurb: 'Fine ink outlines, lightly painted natural color, and clear object-led diagrams for approachable visual explainers.',
    category: 'Explainer',
    tags: ['editorial', 'diagram', 'ink outline', 'economics', 'hand drawn'],
    data: {
      style_bible:
        'hand-drawn editorial diagram illustration, fine dark ink outlines with subtly irregular human-drawn contours, warm off-white paper background, lightly painted opaque natural color fills in ochre, terracotta, sage green, dusty blue, and warm brown, restrained crosshatching, sparse pencil texture, clear object-led explanatory staging, recognizable locations and everyday operating objects, one strong central subject with a balanced perimeter of supporting objects, generous breathing room, crisp mobile-readable silhouettes, practical optimistic educational mood, lightly grounded shadows, polished magazine-style visual explainer',
      negative_prompt:
        'photorealism, 3D render, glossy vector art, mascot cartoon characters, thick marker doodles, dark moody sepia wash, monochrome parchment, heavy watercolor bleeding, cinematic lighting, dense clutter, tiny unreadable details, logos, labels, random letters, captions, watermark',
    },
    preview_image: '/builtin-style-previews/hand-drawn-editorial-diagram.webp',
  },
  {
    id: 'builtin-oil-painting-classical',
    name: 'Oil Painting Classical',
    builtin: true,
    blurb: 'Old-master oil painting — rich impasto, chiaroscuro lighting, museum-canvas depth.',
    category: 'Illustration',
    tags: ['oil', 'classical', 'old master', 'museum', 'baroque'],
    data: {
      style_bible:
        'classical oil painting, old-master technique, visible impasto brushwork, rich layered glazes, deep chiaroscuro lighting, warm earthen palette with deep shadows, canvas texture, dramatic single light source, baroque atmosphere, painterly edges, museum-quality depth',
      negative_prompt:
        'flat vector, pixel art, cartoon, neon colours, 3D CGI render, hard digital edges, lowres, modern clip-art, text, watermark',
    },
    preview_image: '/builtin-style-previews/oil-painting-classical.webp',
  },
  {
    id: 'builtin-anime-cel',
    name: 'Anime Cel',
    builtin: true,
    blurb: 'Modern anime cel-shading — clean lineart, flat cel light, expressive and vivid.',
    category: 'Digital',
    tags: ['anime', 'cel shading', 'line art', 'vivid', 'character'],
    data: {
      style_bible:
        'modern anime cel-shaded illustration, clean confident lineart, flat cel shading with crisp shadow shapes, vivid but harmonious palette, expressive faces, soft rim light, detailed painted backgrounds, dynamic composition, key-visual quality, subtle gradient skies',
      negative_prompt:
        'photorealism, 3D render, western cartoon, muddy colours, sketchy unfinished lines, heavy film grain, realistic skin pores, text, watermark',
    },
    preview_image: '/builtin-style-previews/anime-cel.webp',
  },
]
