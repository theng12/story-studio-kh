/**
 * Thumbnail text + font style catalogs — single source of truth for the
 * thumbnail-prompt generator's "Text Style" and "Font Style" pickers.
 *
 * Previously these maps were duplicated inside routes/scripts.ts and
 * generators/image-prompts.ts and the frontend's `<option>` list in
 * image-prompts.vue. Every time someone added a preset, one place got
 * updated and the others silently diverged. This file consolidates.
 *
 * The frontend keeps its own *display* labels per option (under a
 * matching `id`), but the backend is authoritative for the actual phrase
 * injected into the LLM prompt. Keep `TEXT_STYLE_IDS` and `FONT_STYLE_IDS`
 * below in sync with the frontend `<option value="...">` ids.
 */

import { truncateChars } from '../lib/well-formed-text.js'

/** User-facing id → rich phrase the LLM sees. */
export const TEXT_STYLES: Record<string, string> = {
  // Existing presets — descriptive phrases kept identical to pre-refactor
  // so generations remain stable for users with saved projects. The one
  // exception is `script`, corrected below: it was filed on the wrong axis
  // and described a letterform, which no phrase in this map may do.
  //
  // EVERY phrase here is a TREATMENT — the finish applied to the letters.
  // The SHAPE of the letters is `FONT_STYLES`, and the two are combined
  // independently. A phrase that names a shape here silently overrides the
  // font the user picked on the other axis.
  gold:     'radiant golden glow, warm magical light',
  white:    'clean crisp white, subtle shadow',
  neon:     'neon glow, vibrant electric light',
  metallic: '3D metallic, dramatically lit, rich glow',
  script:   'delicate golden shimmer, fine sparkling highlights along the edges',

  // New presets — cover the common channel aesthetics people ask for.
  chrome:          'chrome silver metallic, mirror reflections, hard specular highlights',
  fire:            'fiery orange and red gradient, glowing embers, warm flame flicker',
  ice:             'cool icy blue tones, frosted crystalline texture, cold shimmer',
  'gradient-sunset': 'warm sunset gradient from pink through orange to yellow, soft glow',
  'gradient-ocean':  'cool ocean gradient from teal to deep blue, soft luminous shine',
  comic:           'comic-book pop art, thick black outline, bold flat fill',
  horror:          'blood-drip horror style, cracked dark red, ominous shadow',
  retro:           'retro 80s synthwave, magenta-and-cyan gradient, chromatic aberration',
  shadow:          'deep drop shadow, clean solid fill, strong contrast',
  glitch:          'digital glitch effect, RGB split, scan-line texture',
  embossed:        'embossed metallic 3D bevel, subtle gold highlights',
  handwritten:     'inked finish, slightly uneven edges, soft ink bleed, organic feel',
  vintage:         'vintage sepia print, lightly weathered, muted warm tones',
  pastel:          'soft pastel palette, gentle airbrushed glow, dreamlike',
}

/** User-facing id → rich phrase the LLM sees. */
export const FONT_STYLES: Record<string, string> = {
  serif:    'ornate serif font',
  script:   'flowing elegant script',
  bold:     'bold sweeping sans-serif letters',
  fantasy:  'mystical fantasy font',

  // New additions
  display:      'large display headline font, tight tracking',
  condensed:    'condensed narrow sans-serif, compact and efficient',
  handwritten:  'casual handwritten font, personal and warm',
  gothic:       'blackletter gothic calligraphy, ornate medieval style',
  'retro-chrome': 'retro 1970s chrome lettering, smooth curves, stacked reflections',
  futuristic:   'futuristic tech font, geometric and angular',
  typewriter:   'monospace typewriter font, evenly spaced, slightly inked',
  brush:        'brush-stroke font, loose energetic strokes',
  graffiti:     'graffiti street-art lettering, spray-paint texture',
  playful:      'playful rounded font, friendly and approachable',
  stencil:      'stencil font with breaks in the strokes, industrial',
  'hand-drawn': 'hand-drawn rough outline font, sketch-like',
}

export type ThumbnailStylePreset = {
  /** Stable id stored in presets and form payloads. */
  id: string
  /** Human label shown in the picker. */
  label: string
}

/**
 * Frontend picker catalog — exported so the UI can render labels + options
 * without duplicating the list. `id` values match the keys of the maps
 * above; `label` is the display string. `custom` is a sentinel id that
 * tells `resolveTextStyle` / `resolveFontStyle` to use the free-form
 * user input instead of a map lookup.
 */
export const TEXT_STYLE_PRESETS: ThumbnailStylePreset[] = [
  { id: 'gold',             label: 'Golden Glow' },
  { id: 'white',            label: 'Clean White' },
  { id: 'neon',             label: 'Neon Glow' },
  { id: 'metallic',         label: '3D Metallic' },
  { id: 'chrome',           label: 'Chrome / Silver' },
  { id: 'script',           label: 'Golden Shimmer' },
  { id: 'fire',             label: 'Fiery Orange/Red' },
  { id: 'ice',              label: 'Icy Blue' },
  { id: 'gradient-sunset',  label: 'Sunset Gradient' },
  { id: 'gradient-ocean',   label: 'Ocean Gradient' },
  { id: 'comic',            label: 'Comic Book POP' },
  { id: 'horror',           label: 'Horror / Blood Drip' },
  { id: 'retro',            label: 'Retro 80s Synthwave' },
  { id: 'shadow',           label: 'Deep Drop Shadow' },
  { id: 'glitch',           label: 'Digital Glitch' },
  { id: 'embossed',         label: 'Embossed 3D Bevel' },
  { id: 'handwritten',      label: 'Inked Finish' },
  { id: 'vintage',          label: 'Vintage Sepia' },
  { id: 'pastel',           label: 'Soft Pastel' },
  { id: 'custom',           label: 'Custom (describe it…)' },
]

export const FONT_STYLE_PRESETS: ThumbnailStylePreset[] = [
  { id: 'serif',        label: 'Serif (Classic)' },
  { id: 'script',       label: 'Script (Elegant)' },
  { id: 'bold',         label: 'Bold Sans-Serif' },
  { id: 'fantasy',      label: 'Fantasy' },
  { id: 'display',      label: 'Display / Headline' },
  { id: 'condensed',    label: 'Condensed Sans' },
  { id: 'handwritten',  label: 'Handwritten / Casual' },
  { id: 'gothic',       label: 'Blackletter Gothic' },
  { id: 'retro-chrome', label: 'Retro Chrome' },
  { id: 'futuristic',   label: 'Futuristic / Tech' },
  { id: 'typewriter',   label: 'Typewriter / Monospace' },
  { id: 'brush',        label: 'Brush Stroke' },
  { id: 'graffiti',     label: 'Graffiti / Street' },
  { id: 'playful',      label: 'Playful Rounded' },
  { id: 'stencil',      label: 'Stencil' },
  { id: 'hand-drawn',   label: 'Hand-Drawn Sketch' },
  { id: 'custom',       label: 'Custom (describe it…)' },
]

/**
 * Resolve a text-style id (or `'custom'`) to the rich phrase used inside
 * the LLM prompt. Custom falls back to the user-supplied string, trimmed
 * and truncated defensively so a 10 KB paste doesn't derail the prompt
 * budget.
 */
export function resolveTextStyle(id: string | undefined, customText?: string): string {
  if (id === 'custom') {
    const t = (customText || '').trim()
    if (t) return truncateChars(t, 240)
    return TEXT_STYLES.gold!
  }
  return (id && TEXT_STYLES[id]) || TEXT_STYLES.gold!
}

/** Same contract for fonts. */
export function resolveFontStyle(id: string | undefined, customText?: string): string {
  if (id === 'custom') {
    const t = (customText || '').trim()
    if (t) return truncateChars(t, 240)
    return FONT_STYLES.serif!
  }
  return (id && FONT_STYLES[id]) || FONT_STYLES.serif!
}
