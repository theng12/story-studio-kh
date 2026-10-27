/**
 * The Still Posts catalogue: ten LOOKS and twenty-four LAYOUTS.
 *
 * Owner, 2026-10-27: "FORMATS: 10 visual formats… Plus 7 more ORIGINAL formats that you design.
 * Each format has a name, a style bible, a negative prompt, a background treatment, and a lettering
 * style using bundled fonts." and "POST OPTIONS: at least 20… Keep formats (look) and options
 * (layout/structure) separate, so any option works with any format."
 *
 * The three sample-derived looks are ORIGINAL TAKES on a genre: a dark painterly night, a cute flat
 * sticker on white, and a naive doodle on paper. No sample character, logo, palette composition or
 * wording is reproduced — the samples were read for format and mood only.
 *
 * Everything here is app-owned presentation data. No GenStudio model value lives in this file
 * (AGENTS §1): a model reaches a job only through a live catalogue lookup or the preset the
 * customer saved.
 */

import type {
  StillPostFormat,
  StillPostOption,
  StillPostPreset,
  StillPostPresetData,
  StillPostTextBox,
} from '../contracts/still-posts.js'
import type { TextAnchor } from '../contracts/thumbnail-text.js'

/** Anything the picture must never contain, appended to EVERY format's own negatives. */
export const UNIVERSAL_NEGATIVE =
  'text, letters, words, numbers, captions, handwriting, typography, glyphs, subtitles, '
  + 'watermark, signature, logo, brand mark, stamp, frame border, UI overlay'

function negatives(specific: string): string {
  return `${specific}, ${UNIVERSAL_NEGATIVE}`
}

// ── The ten formats ────────────────────────────────────────────────────────

export const STILL_POST_FORMATS: StillPostFormat[] = [
  {
    id: 'night-painterly',
    name: 'Night Painterly',
    description: 'A dark painted night — moon, mist and one small figure — with a single warm accent.',
    style_bible:
      'Hand-painted digital illustration in the mood of a dark storybook: visible brushwork, soft '
      + 'chiaroscuro, deep midnight blues and forest charcoal, drifting mist, a luminous moon or a '
      + 'field of stars, and exactly one warm accent (a scarf, a lantern, a ribbon) as the focal '
      + 'point. Quiet, atmospheric, melancholy. The figure is small in the frame and simply drawn, '
      + 'never detailed or heroic. Painterly edges, no hard vector lines, gentle grain.',
    negative_prompt: negatives(
      'photorealism, photographs, anime, manga, cel shading, flat vector art, neon, bright pastel, '
      + 'daylight, crowded scene, busy detail, multiple figures, detailed faces, chibi',
    ),
    background: 'Painted night sky, mist and silhouetted land; the text sits in open sky.',
    lettering: {
      fonts: { latn: 'patrick-hand', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 400,
      uppercase: true,
      fill: { type: 'solid', color: '#F3E9D2' },
      outline: { enabled: false, color: '#0B1020', width_px: 0 },
      shadow: { enabled: true, color: '#05070F', opacity: 0.75, dx: 0, dy: 6, blur_px: 14 },
      line_height: 1.25,
    },
    text_panel: { color: '#0B1020', opacity: 0.55, padding_px: 38, radius_px: 18 },
    default_aspect: '1:1',
  },
  {
    id: 'sticker-flat',
    name: 'Flat Sticker',
    description: 'A cute flat sticker character on plain white, thick outline, soft drop shadow.',
    style_bible:
      'A single cute flat 2D sticker illustration on a pure white background: clean bold outlines, '
      + 'simple cel shading with at most three flat tones, a chubby simplified character with '
      + 'rounded shapes, and a soft grey drop shadow under it so it reads as a sticker. Generous '
      + 'empty white space around the character. Friendly, minimal, modern — like a printed sticker '
      + 'sheet.',
    negative_prompt: negatives(
      'painting, brush texture, gradient background, photograph, 3D render, realism, detailed '
      + 'background, scenery, multiple characters, complex shading',
    ),
    background: 'Pure white, with a soft shadow grounding the sticker.',
    lettering: {
      fonts: { latn: 'inter', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 500,
      uppercase: false,
      fill: { type: 'solid', color: '#3A3A3A' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, dx: 0, dy: 0, blur_px: 0 },
      line_height: 1.3,
    },
    text_panel: { color: '#FFFFFF', opacity: 0.9, padding_px: 30, radius_px: 26 },
    default_aspect: '1:1',
  },
  {
    id: 'doodle-paper',
    name: 'Doodle on Paper',
    description: 'A naive ink doodle on plain or pastel paper, with one small spot of colour.',
    style_bible:
      'A naive hand-drawn ink doodle on a flat off-white or pastel paper background: wobbly '
      + 'fine-liner lines, a simple little character with dot eyes, and at most one small coloured '
      + 'element (a red heart, a blue puddle). Deliberately imperfect, sparse, and quiet — paper '
      + 'texture visible, no shading, no perspective.',
    negative_prompt: negatives(
      'painting, 3D render, photograph, polished vector art, cel shading, gradients, realism, '
      + 'detailed background, many objects, colourful palette',
    ),
    background: 'Flat cream or pastel paper with faint grain; a lot of empty space.',
    lettering: {
      fonts: { latn: 'patrick-hand', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 400,
      uppercase: false,
      fill: { type: 'solid', color: '#1E1E1E' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, dx: 0, dy: 0, blur_px: 0 },
      line_height: 1.35,
    },
    text_panel: { color: '#FFFFFF', opacity: 0.85, padding_px: 28, radius_px: 20 },
    default_aspect: '1:1',
  },
  {
    id: 'woodcut-crimson',
    name: 'Crimson Woodcut',
    description: 'A high-contrast block print on crimson canvas — one silhouette, one stare.',
    style_bible:
      'A high-contrast woodcut or linocut print: a single bold black silhouette with sharply cut '
      + 'edges against a deep crimson textured canvas, rough linen grain across the whole frame, '
      + 'only two or three flat values, and white eyes or highlights as the sole bright note. '
      + 'Graphic, severe, dramatic — poster-like, with no soft gradients.',
    negative_prompt: negatives(
      'painting, 3D render, photograph, cel shading, anime, pastel palette, soft gradients, '
      + 'multiple colours, busy detail, many figures',
    ),
    background: 'Deep crimson canvas with visible linen grain.',
    lettering: {
      fonts: { latn: 'anton', khmr: 'moul', hani: 'noto-sans-sc' },
      weight: 400,
      uppercase: true,
      fill: { type: 'solid', color: '#F7F1E4' },
      outline: { enabled: false, color: '#000000', width_px: 0 },
      shadow: { enabled: true, color: '#000000', opacity: 0.6, dx: 0, dy: 4, blur_px: 10 },
      line_height: 1.15,
    },
    text_panel: { color: '#3A060B', opacity: 0.5, padding_px: 34, radius_px: 8 },
    default_aspect: '1:1',
  },
  {
    id: 'riso-duotone',
    name: 'Risograph Duotone',
    description: 'Two-colour riso print — flat ink, visible misregistration, paper grain.',
    style_bible:
      'A risograph print in exactly two inks (a saturated navy and a warm coral) plus paper white: '
      + 'flat shapes, limited halftone dot texture, slight ink misregistration between layers, and '
      + 'coarse paper grain. Graphic and calm, like a small-press zine page — simplified forms, no '
      + 'fine detail, no realistic shading.',
    negative_prompt: negatives(
      'painting, 3D render, photograph, cel shading, photorealistic shading, more than two inks, '
      + 'full colour, glossy, busy detail',
    ),
    background: 'Warm paper white with two flat ink layers and visible grain.',
    lettering: {
      fonts: { latn: 'inter', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 600,
      uppercase: true,
      fill: { type: 'solid', color: '#12214A' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, dx: 0, dy: 0, blur_px: 0 },
      line_height: 1.2,
    },
    text_panel: { color: '#F6EFE3', opacity: 0.7, padding_px: 30, radius_px: 6 },
    default_aspect: '1:1',
  },
  {
    id: 'ink-wash',
    name: 'Ink Wash',
    description: 'A quiet East-Asian ink wash on rice paper — one stroke, vast emptiness.',
    style_bible:
      'A minimal East-Asian ink-wash painting on warm rice paper: one or two confident brush '
      + 'strokes, wet ink bleeding into the paper, a pale wash of grey for distance, and a vast '
      + 'untouched area of empty paper. A tiny figure or a single object carries the whole scene. '
      + 'Restrained, contemplative, almost nothing in the frame.',
    negative_prompt: negatives(
      'saturated colour, neon, 3D render, photograph, cel shading, anime, dense detail, busy '
      + 'background, heavy texture, multiple figures',
    ),
    background: 'Warm rice paper with a pale grey wash and open empty space.',
    lettering: {
      fonts: { latn: 'inter', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 300,
      uppercase: false,
      fill: { type: 'solid', color: '#232323' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, dx: 0, dy: 0, blur_px: 0 },
      line_height: 1.4,
    },
    text_panel: { color: '#F7F2E7', opacity: 0.82, padding_px: 32, radius_px: 10 },
    default_aspect: '1:1',
  },
  {
    id: 'clay-matte',
    name: 'Matte Clay',
    description: 'A soft matte 3D clay figure in a pastel studio, gently lit.',
    style_bible:
      'A soft matte 3D render that looks like modelling clay: rounded simplified character shapes '
      + 'with fingerprint-level surface texture, pastel backdrop, one soft key light and a long '
      + 'gentle shadow, shallow depth of field. Warm, tactile and toy-like — no glossy plastic, no '
      + 'hard edges.',
    negative_prompt: negatives(
      'painting, 2D illustration, anime, flat vector, photograph of a real person, harsh contrast, '
      + 'neon, glossy plastic, sharp mechanical detail, busy scene',
    ),
    background: 'A soft pastel studio backdrop with a gentle floor shadow.',
    lettering: {
      fonts: { latn: 'inter', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 600,
      uppercase: false,
      fill: { type: 'solid', color: '#3B2F2F' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: true, color: '#000000', opacity: 0.22, dx: 0, dy: 5, blur_px: 12 },
      line_height: 1.28,
    },
    text_panel: { color: '#FFFFFF', opacity: 0.72, padding_px: 32, radius_px: 28 },
    default_aspect: '1:1',
  },
  {
    id: 'papercut',
    name: 'Paper Cut-Out',
    description: 'Layered coloured paper in a shallow shadow box, cut edges and real shadows.',
    style_bible:
      'A layered paper cut-out scene: flat coloured paper shapes stacked in a shallow shadow box, '
      + 'visible cut edges and soft real shadows between layers, four or five muted colours, and a '
      + 'few small perfect circle details. Charming and handmade, with clear depth but no drawn '
      + 'lines.',
    negative_prompt: negatives(
      'painting, photograph, 3D render with glossy materials, cel shading, anime, gradients, '
      + 'realistic lighting, busy detail, many colours',
    ),
    background: 'Stacked paper layers with soft shadow gaps; a plain paper sky.',
    lettering: {
      fonts: { latn: 'inter', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 600,
      uppercase: false,
      fill: { type: 'solid', color: '#2A211C' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: true, color: '#000000', opacity: 0.25, dx: 0, dy: 4, blur_px: 8 },
      line_height: 1.26,
    },
    text_panel: { color: '#FBF6EE', opacity: 0.8, padding_px: 30, radius_px: 12 },
    default_aspect: '1:1',
  },
  {
    id: 'neon-rain',
    name: 'Neon Rain',
    description: 'A rainy neon city at night — wet reflections, one figure under the lights.',
    style_bible:
      'A cinematic rainy neon night scene: a narrow wet street or alley, saturated magenta, cyan '
      + 'and electric-blue signage as pure light, long reflections in puddles, drifting rain, haze, '
      + 'and a single small figure with an umbrella or a coat. High contrast, deep blacks, glow and '
      + 'bloom. The signage is abstract light only — never readable characters.',
    negative_prompt: negatives(
      'daylight, muted colours, painting, cel shading, anime, pastel, crowds, busy detail, '
      + 'photorealism of a real city landmark',
    ),
    background: 'Rain-soaked asphalt, glowing signage reflected in puddles.',
    lettering: {
      fonts: { latn: 'inter', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 700,
      uppercase: true,
      fill: { type: 'solid', color: '#EAF6FF' },
      outline: { enabled: false, color: '#05070F', width_px: 0 },
      shadow: { enabled: true, color: '#6FE3FF', opacity: 0.9, dx: 0, dy: 0, blur_px: 22 },
      line_height: 1.18,
    },
    text_panel: { color: '#05070F', opacity: 0.6, padding_px: 32, radius_px: 10 },
    default_aspect: '1:1',
  },
  {
    id: 'watercolour',
    name: 'Watercolour Wash',
    description: 'Loose watercolour blooms on cream paper — soft, blooming, unfinished edges.',
    style_bible:
      'A loose watercolour illustration on cream cold-press paper: wet-in-wet blooms, granulating '
      + 'edges, a soft limited palette of three or four washes, pencil underdrawing faintly visible '
      + 'and deliberately unfinished corners. A single simple figure or object, generous paper '
      + 'showing through, no hard outlines.',
    negative_prompt: negatives(
      'photograph, 3D render, cel shading, anime, flat vector, crisp outlines, saturated neon, '
      + 'dense detail, busy background',
    ),
    background: 'Cream cold-press paper with soft washes and visible white space.',
    lettering: {
      fonts: { latn: 'patrick-hand', khmr: 'kantumruy-pro', hani: 'noto-sans-sc' },
      weight: 400,
      uppercase: false,
      fill: { type: 'solid', color: '#2B2B2B' },
      outline: { enabled: false, color: '#FFFFFF', width_px: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, dx: 0, dy: 0, blur_px: 0 },
      line_height: 1.32,
    },
    text_panel: { color: '#FBF7EF', opacity: 0.8, padding_px: 30, radius_px: 22 },
    default_aspect: '1:1',
  },
]

/** Format lookup. Unknown ids are refused by the callers, never silently replaced. */
export function stillPostFormat(id: string): StillPostFormat | null {
  return STILL_POST_FORMATS.find(format => format.id === id) ?? null
}

// ── The twenty-four options ────────────────────────────────────────────────
//
// Every box is in percent of the EXPORT canvas, so the same option reads correctly at 1:1, 9:16
// and 16:9. `composition` is the instruction that reserves that space in the picture.

function box(
  anchor: TextAnchor,
  x: number,
  y: number,
  width: number,
  height: number,
  align: 'left' | 'center' | 'right',
  maxLines: number,
): StillPostTextBox {
  return { anchor, x_pct: x, y_pct: y, width_pct: width, height_pct: height, align, max_lines: maxLines }
}

const COMMENTARY = 'Keep the upper quarter calm and free of detail so lettering placed over it stays legible.'

export const STILL_POST_OPTIONS: StillPostOption[] = [
  {
    id: 'quote-top',
    name: 'Quote on top',
    description: 'The words across the top third, the character below them.',
    panels: 1,
    text: [box('top', 50, 6, 86, 26, 'center', 3)],
    composition: [`Place the character in the lower half of the frame. ${COMMENTARY}`],
    text_background: false,
  },
  {
    id: 'quote-bottom',
    name: 'Quote at the bottom',
    description: 'Art fills the frame; the words sit along the bottom third.',
    panels: 1,
    text: [box('bottom', 50, 94, 86, 26, 'center', 3)],
    composition: ['Keep the lower quarter of the frame simple and uncluttered; put the character above it.'],
    text_background: false,
  },
  {
    id: 'centred-quote',
    name: 'Centred quote',
    description: 'A quiet centred line in the upper half, figure low in the frame.',
    panels: 1,
    text: [box('center', 50, 40, 78, 26, 'center', 3)],
    composition: ['Compose the character small and low, with open space through the middle of the frame.'],
    text_background: false,
  },
  {
    id: 'caption-under-figure',
    name: 'Caption under the figure',
    description: 'A small centred figure with its caption beneath.',
    panels: 1,
    text: [box('bottom', 50, 96, 80, 20, 'center', 2)],
    composition: ['Place the character centred in the middle of the frame and leave the bottom fifth empty.'],
    text_background: false,
  },
  {
    id: 'wide-scene-small-figure',
    name: 'Small figure, wide scene',
    description: 'A vast scene with a tiny figure — the world dwarfs them.',
    panels: 1,
    text: [box('top', 50, 7, 88, 22, 'center', 3)],
    composition: ['A wide scan of the environment with a very small figure low and off-centre. Keep the sky open.'],
    text_background: false,
  },
  {
    id: 'close-up',
    name: 'Close-up',
    description: 'The character fills the frame; the words sit under the chin.',
    panels: 1,
    text: [box('bottom', 50, 95, 84, 24, 'center', 3)],
    composition: ['A tight close-up of the character occupying most of the frame, centred slightly high.'],
    text_background: false,
  },
  {
    id: 'silhouette-moon',
    name: 'Silhouette and moon',
    description: 'A silhouette against a big moon or sun, words in the lit space.',
    panels: 1,
    text: [box('center', 50, 42, 72, 24, 'center', 3)],
    composition: ['A large moon or sun in the upper half behind a smaller silhouette below it.'],
    text_background: false,
  },
  {
    id: 'object-still-life',
    name: 'The object alone',
    description: 'No figure — one object carries the feeling, words above.',
    panels: 1,
    text: [box('top', 50, 8, 84, 24, 'center', 3)],
    composition: ['One ordinary object as the subject, centred low, shot like a still life. No character at all.'],
    text_background: false,
  },
  {
    id: 'two-line-stack',
    name: 'Two-line stack',
    description: 'Two short stacked lines, centred, figure low.',
    panels: 1,
    text: [box('center', 50, 34, 76, 18, 'center', 2)],
    composition: ['Keep the middle band of the frame open; place the character in the bottom third.'],
    text_background: false,
  },
  {
    id: 'setup-punchline',
    name: 'Setup / punchline',
    description: 'Two panels: the setup, then the punchline in the same framing.',
    panels: 2,
    text: [box('top', 50, 7, 86, 22, 'center', 2), box('top', 50, 7, 86, 22, 'center', 2)],
    composition: [
      'Same framing as the second panel, neutral and calm: the setup. Leave the top quarter open.',
      'Same framing as the first panel, with a small change in the character\'s pose or expression: the punchline.',
    ],
    text_background: false,
  },
  {
    id: 'pair-wide-then-close',
    name: 'Wide, then close',
    description: 'Two panels: the whole scene, then the face.',
    panels: 2,
    text: [box('top', 50, 7, 86, 20, 'center', 2), box('top', 50, 7, 86, 20, 'center', 2)],
    composition: [
      'A wide view of the place, character small, top quarter open.',
      'A close-up of the same character in the same place, top quarter open.',
    ],
    text_background: false,
  },
  {
    id: 'quote-then-scene',
    name: 'Words, then the scene',
    description: 'Two panels: the line on plain space, then the illustration.',
    panels: 2,
    text: [box('center', 50, 40, 80, 32, 'center', 3), box('bottom', 50, 96, 80, 18, 'center', 2)],
    composition: [
      'A plain, almost empty background with one small incidental detail and a large open middle.',
      'The full illustrated scene the first panel set up; keep the bottom fifth clear.',
    ],
    text_background: false,
  },
  {
    id: 'question-answer',
    name: 'Question, answer',
    description: 'Two panels: a question above the picture, the answer below.',
    panels: 2,
    text: [box('top', 50, 8, 86, 22, 'center', 2), box('top', 50, 8, 86, 22, 'center', 2)],
    composition: [
      'The character looking away, thinking; top quarter open.',
      'The same character a beat later, changed expression; top quarter open.',
    ],
    text_background: false,
  },
  {
    id: 'bottom-banner',
    name: 'Bottom banner',
    description: 'A solid banner across the bottom holds the words.',
    panels: 1,
    text: [box('bottom', 50, 94, 92, 20, 'center', 2)],
    composition: ['Compose the whole scene in the top four-fifths; keep the bottom fifth plain.'],
    text_background: true,
  },
  {
    id: 'top-banner',
    name: 'Top banner',
    description: 'A solid banner across the top holds the words.',
    panels: 1,
    text: [box('top', 50, 6, 92, 20, 'center', 2)],
    composition: ['Compose the whole scene in the lower four-fifths; keep the top fifth plain.'],
    text_background: true,
  },
  {
    id: 'polaroid',
    name: 'Polaroid',
    description: 'The picture inset with a wide lower margin, the words written there.',
    panels: 1,
    text: [box('bottom', 50, 95, 74, 16, 'center', 2)],
    composition: ['Frame the scene as a single photograph with a calm lower edge and one clear subject.'],
    text_background: false,
  },
  {
    id: 'corner-note',
    name: 'Corner note',
    description: 'Art dominates; a small note sits in one corner.',
    panels: 1,
    text: [box('bottom-left', 8, 92, 52, 18, 'left', 3)],
    composition: ['An expressive full-frame scene; keep the bottom-left corner calm and dark.'],
    text_background: false,
  },
  {
    id: 'headline-big',
    name: 'Big headline',
    description: 'A very short line set large across the top half.',
    panels: 1,
    text: [box('top', 50, 12, 88, 40, 'center', 2)],
    composition: ['Keep the whole upper half open and simple; the character sits low.'],
    text_background: false,
  },
  {
    id: 'whisper',
    name: 'Whisper',
    description: 'Small quiet words under the figure, with a lot of empty space.',
    panels: 1,
    text: [box('bottom', 50, 97, 66, 12, 'center', 1)],
    composition: ['A sparse scene with the character small and high, and generous empty space below.'],
    text_background: false,
  },
  {
    id: 'side-split',
    name: 'Side split',
    description: 'Two vertical panels, one line each, read like a diptych.',
    panels: 2,
    text: [box('bottom', 50, 96, 84, 20, 'center', 2), box('bottom', 50, 96, 84, 20, 'center', 2)],
    composition: [
      'The first half of the scene, character on the left, lower fifth calm.',
      'The second half of the scene, character on the right, lower fifth calm.',
    ],
    text_background: false,
  },
  {
    id: 'sky-headroom',
    name: 'Sky headroom',
    description: 'Half the frame is sky for the words; the figure sits bottom-right.',
    panels: 1,
    text: [box('center', 50, 34, 80, 24, 'center', 3)],
    composition: ['An empty sky filling the upper half; the character small in the bottom-right corner.'],
    text_background: false,
  },
  {
    id: 'lower-third-caption',
    name: 'Lower-third caption',
    description: 'The scene above, a caption line set across the lower third.',
    panels: 1,
    text: [box('bottom', 50, 88, 88, 20, 'center', 2)],
    composition: ['The subject sits in the middle band of the frame; the lower third stays plain.'],
    text_background: false,
  },
  {
    id: 'offset-diagonal',
    name: 'Diagonal balance',
    description: 'Words upper-left, figure lower-right — a diagonal composition.',
    panels: 1,
    text: [box('top-left', 6, 10, 62, 30, 'left', 3)],
    composition: ['Place the character in the lower-right; leave the upper-left corner calm.'],
    text_background: false,
  },
  {
    id: 'overlap-silhouette',
    name: 'Over the silhouette',
    description: 'The words overlap the figure\'s dark silhouette.',
    panels: 1,
    text: [box('center', 50, 44, 82, 30, 'center', 3)],
    composition: ['A large dark silhouette fills the centre of the frame so light lettering can sit over it.'],
    text_background: false,
  },
]

export function stillPostOption(id: string): StillPostOption | null {
  return STILL_POST_OPTIONS.find(option => option.id === id) ?? null
}

// ── Built-in presets ───────────────────────────────────────────────────────

const BRANDING_BOTTOM: StillPostPresetData['branding'] = {
  handle_enabled: true,
  handle_text: null,
  logo_enabled: true,
  position: 'bottom',
  handle_size_px: 30,
  logo_width_pct: 12,
  margin_pct: 4,
  opacity: 0.85,
}

const BRANDING_CORNER: StillPostPresetData['branding'] = {
  ...BRANDING_BOTTOM,
  position: 'bottom-right',
  handle_size_px: 26,
  logo_width_pct: 8,
  margin_pct: 3.5,
}

function preset(id: string, name: string, data: Partial<StillPostPresetData>): StillPostPreset {
  return {
    id,
    name,
    builtin: true,
    data: {
      writing_model: null,
      image_model: null,
      format_id: STILL_POST_FORMATS[0]!.id,
      option_id: 'quote-top',
      language: 'en',
      aspects: ['1:1'],
      fresh_drawing_per_size: false,
      text_scale: 1,
      branding: BRANDING_BOTTOM,
      ...data,
    },
  }
}

/**
 * Built-in presets ship with the app and cannot be edited (they can be copied).
 *
 * None of them names a model: the writing model is a live Gateway choice (AGENTS §1/§7) and the
 * image model is always the one the customer picked for the batch. A preset that names no model
 * resolves to this Mac's default at use time, and is refused with a plain sentence when there is
 * no default.
 */
export const STILL_POST_BUILTIN_PRESETS: StillPostPreset[] = [
  preset('clean-handle', 'Clean handle — bottom', {}),
  preset('corner-mark', 'Corner mark', { branding: BRANDING_CORNER }),
  preset('unbranded', 'No branding', {
    branding: { ...BRANDING_BOTTOM, handle_enabled: false, logo_enabled: false },
  }),
  preset('khmer-quiet', 'Khmer — quiet centre', {
    language: 'km',
    option_id: 'centred-quote',
    text_scale: 1.05,
  }),
]
