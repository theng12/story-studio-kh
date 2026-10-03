/**
 * The sixteen built-in caption looks.
 *
 * DATA, in one module. Not branches in the renderer — a preset is a patch over
 * `defaultSubtitleStyle()` and nothing more, which is the same thing a
 * downloadable content pack will be. If a look cannot be expressed here, the
 * engine is missing a field; the answer is to add the field, never to special-
 * case the name.
 *
 * These are BUILT-INS. They are shipped with the app and never written into
 * `config.subtitles_presets`, so a customer's own saved presets are untouched
 * by anything in this file.
 *
 * `approximation` is filled in wherever libass cannot do the thing the name
 * promises. It is shown in the UI. A preset that quietly renders something
 * other than its name is worse than one that says what it actually does.
 */

import {
  defaultSubtitleStyle,
  mergeSubtitleStyle,
  type SubtitleStyleDocument,
  type SubtitleStylePatch,
} from './subtitle-style.js'

export interface BuiltInSubtitlePreset {
  id: string
  name: string
  /** One line, shown under the name in the gallery. */
  description: string
  /** Honest note about what libass cannot render exactly. */
  approximation?: string
  /** True when the look depends on word-by-word timing. */
  wordLevel: boolean
  style: SubtitleStyleDocument
}

function preset(
  id: string,
  name: string,
  description: string,
  patch: SubtitleStylePatch,
  extra?: { approximation?: string },
): BuiltInSubtitlePreset {
  const style = mergeSubtitleStyle(defaultSubtitleStyle(), patch)
  return {
    id,
    name,
    description,
    wordLevel: style.word.mode !== 'off',
    ...(extra?.approximation ? { approximation: extra.approximation } : {}),
    style,
  }
}

export const BUILT_IN_SUBTITLE_PRESETS: BuiltInSubtitlePreset[] = [
  // 1 — the regression anchor. This MUST stay byte-identical to the v1 default
  // style, and `subtitle-ass.test.ts` asserts exactly that.
  preset('clean-broadcast', 'Clean Broadcast',
    'The shipped default: white Helvetica with a thin black stroke.', {}),

  preset('documentary-serif', 'Documentary Serif',
    'Warm cream serif with a soft drop shadow instead of a hard stroke.', {
      typography: { font_family: 'Georgia', font_size_px: 30 },
      color: { primary_hex: '#F6EEDC', shadow_hex: '#000000', shadow_opacity: 0.7 },
      edge: { outline_px: 1, shadow_px: 4, blur_px: 3 },
    }),

  // Sleep-story channels: legible without being the brightest thing on screen.
  preset('sleep-soft', 'Sleep Soft',
    'Dim, low-contrast and small, with a long slow fade. Built for sleep stories.', {
      typography: { font_family: 'Avenir Next', font_size_px: 24 },
      color: { primary_hex: '#C7D0DA', primary_opacity: 0.82, outline_opacity: 0.55 },
      edge: { outline_px: 1, blur_px: 2 },
      animation: { type: 'fade', in_ms: 700, out_ms: 700 },
    }),

  preset('bold-impact', 'Bold Impact',
    'Heavy sans, thick stroke, centred and set in capitals.', {
      typography: { font_family: 'Arial Black', font_size_px: 52, bold: true, all_caps: true, max_chars_per_line: 24 },
      edge: { outline_px: 6 },
      placement: { align: 'center' },
    }),

  preset('karaoke-highlight', 'Karaoke Highlight',
    'The whole line stays visible; the spoken word swaps to the accent colour.', {
      word: { mode: 'highlight', active_color_hex: '#FFD400', inactive_color_hex: '#FFFFFF', transition_ms: 80 },
      typography: { font_family: 'Avenir Next', font_size_px: 34, bold: true },
      edge: { outline_px: 3 },
    }),

  preset('karaoke-pop', 'Karaoke Pop',
    'Karaoke highlight, and the spoken word also scales up and settles back.', {
      word: { mode: 'pop', active_color_hex: '#FFD400', inactive_color_hex: '#FFFFFF', active_scale_pct: 128, transition_ms: 110 },
      typography: { font_family: 'Avenir Next', font_size_px: 34, bold: true },
      edge: { outline_px: 3 },
    }),

  preset('word-reveal', 'Word Reveal',
    'Words fade in one at a time and stay on screen.', {
      word: { mode: 'reveal', transition_ms: 130 },
      typography: { font_family: 'Avenir Next', font_size_px: 34, bold: true },
      edge: { outline_px: 3 },
    }),

  preset('single-word-focus', 'Single Word Focus',
    'Exactly one large word on screen at a time, centred in frame.', {
      word: { mode: 'single', active_color_hex: '#FFFFFF' },
      typography: { font_family: 'Arial Black', font_size_px: 78, bold: true, all_caps: true, max_chars_per_line: 20, max_lines: 1 },
      edge: { outline_px: 6 },
      placement: { position: 'center', align: 'center' },
    }),

  preset('neon-glow', 'Neon Glow',
    'Bright text ringed by a blurred coloured halo.', {
      typography: { font_family: 'Avenir Next', font_size_px: 36, bold: true },
      color: { primary_hex: '#FFFFFF', outline_hex: '#00E5FF' },
      edge: { outline_px: 5, blur_px: 8 },
    }, {
      approximation: 'libass has no bloom. The halo is a blurred outline (\\blur on \\3c), '
        + 'so it hugs the letters rather than spilling light across the frame.',
    }),

  preset('yellow-highlighter', 'Yellow Highlighter',
    'The spoken word sits on a marker-pen block of colour.', {
      word: {
        mode: 'highlight',
        highlight_box: true,
        highlight_box_hex: '#FFE712',
        highlight_box_px: 16,
        active_color_hex: '#131313',
        inactive_color_hex: '#FFFFFF',
        transition_ms: 60,
      },
      typography: { font_family: 'Avenir Next', font_size_px: 34, bold: true },
      edge: { outline_px: 3 },
    }, {
      approximation: 'libass cannot draw a background behind ONE word — only behind a whole '
        + 'line. The block is a thick round-joined outline in the highlight colour, so it '
        + 'follows the shape of the letters instead of being a clean rectangle.',
    }),

  preset('boxed-caption', 'Boxed Caption',
    'Solid opaque panel behind the text. The most legible option over busy footage.', {
      typography: { font_family: 'Helvetica', font_size_px: 32 },
      box: { mode: 'full', padding_px: 14 },
      color: { box_hex: '#000000', box_opacity: 1 },
      edge: { outline_px: 0 },
    }),

  preset('typewriter', 'Typewriter',
    'Monospaced text appearing word by word with no easing.', {
      word: { mode: 'typewriter' },
      typography: { font_family: 'Menlo', font_size_px: 26, max_chars_per_line: 46 },
      edge: { outline_px: 2 },
    }, {
      approximation: 'Reveals whole WORDS, not characters. Story Studio only has word-level '
        + 'timing, so a per-character cadence would be invented rather than measured.',
    }),

  preset('slide-up', 'Slide Up',
    'Each line rises into place as it appears.', {
      animation: { type: 'slide-up' },
      typography: { font_family: 'Avenir Next', font_size_px: 30 },
      edge: { outline_px: 3 },
    }),

  preset('gentle-fade', 'Gentle Fade',
    'A soft, unhurried fade in and out. Nothing moves.', {
      animation: { type: 'fade', in_ms: 420, out_ms: 420 },
      typography: { font_family: 'Avenir Next', font_size_px: 30 },
      edge: { outline_px: 2, blur_px: 1 },
    }),

  preset('explainer-accent', 'Explainer Accent',
    'White body copy with the spoken word picked out in a brand accent.', {
      word: { mode: 'highlight', active_color_hex: '#4FC3F7', inactive_color_hex: '#FFFFFF', transition_ms: 100 },
      typography: { font_family: 'Helvetica Neue', font_size_px: 32, bold: true, letter_spacing_px: 1 },
      edge: { outline_px: 3, shadow_px: 2 },
    }),

  preset('minimal-lower-third', 'Minimal Lower Third',
    'Small, left-aligned, tucked into the bottom-left corner.', {
      typography: { font_family: 'Helvetica Neue', font_size_px: 22, max_chars_per_line: 52, max_lines: 2 },
      placement: { position: 'bottom', align: 'left', position_x_pct: 8, position_y_pct: 88, safe_margin_pct: 6 },
      edge: { outline_px: 2, shadow_px: 2 },
      animation: { type: 'fade' },
    }),
]
