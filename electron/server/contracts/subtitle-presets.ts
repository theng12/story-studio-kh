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
  // Dreamlands E2E 2026-10-03: the old 24 px, 82 %-opacity grey with a 1 px,
  // 55 % outline was nearly unreadable at 1080p over bright scenes. Now the size
  // of Gentle Fade with a firm outline; the softness is the warm-grey tint and
  // the long fade, not missing contrast.
  preset('sleep-soft', 'Sleep Soft',
    'Soft warm-grey captions with a long, slow fade. Built for sleep stories.', {
      typography: { font_family: 'Avenir Next', font_size_px: 30 },
      color: { primary_hex: '#E6E9EE', primary_opacity: 0.95, outline_opacity: 0.85 },
      edge: { outline_px: 2, blur_px: 1 },
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

  /**
   * A vertical Short (owner, 2026-10-27).
   *
   * YouTube draws its own furniture over the bottom-right of a Short — the
   * like / comment / share stack, the channel handle and the description
   * button — and over the bottom band with the title. A caption centred at the
   * default 92% sits UNDER that chrome on a phone, which is where these are
   * watched. So the resting place is 62% down the frame: high enough to clear
   * the whole stack, low enough to read as a caption rather than a title.
   *
   * `safe_margin_pct` is raised to 10 because the protected band is measured
   * against the frame's HEIGHT, which on a 9:16 frame is the long edge: 10% of
   * 1920 is 192px of protected edge top and bottom, the honest amount for a
   * vertical player.
   *
   * The type is bigger than the broadcast default on purpose — a phone screen
   * at arm's length — and the face is the app's bundled Kantumruy Pro, which
   * covers Khmer and Latin in one file. It reaches the burn through
   * `lib/subtitle-font-dir.ts`, which is what makes a bundled face actually
   * resolve instead of silently falling back to Helvetica.
   */
  preset('shorts-vertical', 'Shorts Vertical',
    'Vertical captions placed clear of YouTube\'s Shorts buttons and title. Khmer and Latin.', {
      typography: { font_family: 'Kantumruy Pro', font_size_px: 40, bold: true, max_chars_per_line: 22, max_lines: 3 },
      edge: { outline_px: 4 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
      animation: { type: 'fade', in_ms: 140, out_ms: 140 },
    }),

  /**
   * The same Short, with the spoken word emphasised — the reading rhythm a
   * quote Short wants: one sentence at a time, each word landing as it is
   * spoken. Same placement rule as above, so it clears the same chrome.
   */
  preset('shorts-vertical-word-pop', 'Shorts Vertical — Word Pop',
    'Vertical word-by-word captions, clear of the Shorts buttons. Khmer and Latin.', {
      typography: { font_family: 'Kantumruy Pro', font_size_px: 40, bold: true, max_chars_per_line: 22, max_lines: 3 },
      word: { mode: 'pop', active_color_hex: '#FFD9A0', inactive_color_hex: '#FFFFFF', active_scale_pct: 120, transition_ms: 90 },
      edge: { outline_px: 4 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
    }),

  /**
   * Quote Shorts Phase 2 (owner, 2026-10-27).
   * High-energy Anton font with word-pop bounce animation.
   * Clears the YouTube Shorts buttons and description stack.
   */
  preset('shorts-vertical-bounce', 'Shorts Vertical — Bounce (Anton)',
    'High-energy Anton font with word-pop bounce animation, clear of the Shorts chrome.', {
      typography: { font_family: 'Anton', font_size_px: 46, bold: true, all_caps: true, max_chars_per_line: 18, max_lines: 2 },
      word: { mode: 'pop', active_color_hex: '#FFE712', inactive_color_hex: '#FFFFFF', active_scale_pct: 125, transition_ms: 90 },
      edge: { outline_px: 5, shadow_px: 2 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
    }),

  /**
   * Vibrant electric highlight in Anton, inside 9:16 safe area.
   */
  preset('shorts-vertical-electric', 'Shorts Vertical — Electric Highlight (Anton)',
    'Bold Anton text with vibrant cyan word highlight, inside the 9:16 safe area.', {
      typography: { font_family: 'Anton', font_size_px: 46, bold: true, all_caps: true, max_chars_per_line: 18, max_lines: 2 },
      word: { mode: 'highlight', active_color_hex: '#00E5FF', inactive_color_hex: '#FFFFFF', transition_ms: 80 },
      edge: { outline_px: 5 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
    }),

  /**
   * The ornate Khmer display face Moul with gentle fade.
   */
  preset('shorts-vertical-moul', 'Shorts Vertical — Moul Display',
    'Expressive Khmer display face Moul with gentle fade, clear of Shorts controls.', {
      typography: { font_family: 'Moul', font_size_px: 38, max_chars_per_line: 22, max_lines: 3 },
      color: { primary_hex: '#FFF8E7' },
      edge: { outline_px: 4, shadow_px: 2 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
      animation: { type: 'fade', in_ms: 150, out_ms: 150 },
    }),

  /**
   * Bold Battambang type sliding up as each line is spoken.
   */
  preset('shorts-vertical-battambang', 'Shorts Vertical — Battambang Slide',
    'Bold Battambang type sliding up into place, clear of Shorts controls. Khmer and Latin.', {
      typography: { font_family: 'Battambang', font_size_px: 42, bold: true, max_chars_per_line: 22, max_lines: 3 },
      edge: { outline_px: 4 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
      animation: { type: 'slide-up' },
    }),

  /**
   * Hand-lettered ink on paper (owner, 2026-10-29).
   *
   * The references are social quote posts lettered by hand: warm off-white
   * paper, soft dark ink, loose line spacing, nothing square about it. Patrick
   * Hand is the bundled face that carries that hand, and it ships through the
   * same `:fontsdir=` root as every other bundled face, so it draws the same on
   * a Mac that has never installed it.
   *
   * ── Why the edge is a shadow AND an outline
   *
   * "Warm off-white ink" is the whole look and also the hardest to read: white
   * type disappears over a bright sky and cream disappears over paper-white
   * scenes. So the ink carries a soft dark outline (the pen's own edge) plus a
   * blurred shadow beneath it — the two together read over any picture, which
   * is what a caption has to do. `blur_px` is what makes the shadow soft rather
   * than a hard second copy of the letters.
   *
   * ── The organic motion, honestly
   *
   * A per-line tilt would need a rotation field this engine does not have, and
   * a fake one is worse than none. What libass DOES render here is the cue
   * fade — so each phrase fades in over 260 ms and out over 220 ms, a slow
   * hand-set rhythm instead of a snap. Nothing moves; nothing is approximate.
   *
   * ── Khmer, and why this preset's size is per script
   *
   * Patrick Hand has no Khmer glyphs and there is no bundled hand-lettered
   * Khmer face. `lib/subtitle-script-fallback.ts` tags a Khmer line with the
   * bundled Kantumruy Pro face (the manifest's `text` face for `khmr`), so a
   * Khmer caption renders in real Khmer type rather than boxes. That is a burn
   * rule, not a preset field — it applies to any bundled Latin-only face.
   *
   * The same rule gives the line a size it can live with: Khmer is written
   * without spaces, so a phrase is one unbreakable word and libass cannot
   * shrink to fit, so a Khmer line takes the script's measured cap (64 px at
   * the 1080 reference — 50 characters measure 876 px there, and 80 px clips
   * the same phrase) while Latin keeps this preset's 100 px. It also drops the style's letter spacing on that line, because a
   * non-zero ASS `Spacing` makes this libass draw every Khmer vowel on its own
   * dotted circle (measured 2026-10-29). Both are part of the fallback, so the
   * preset states the size the look wants and the burn keeps Khmer honest.
   */
  preset('shorts-vertical-hand-lettered', 'Shorts Vertical — Hand-lettered',
    'Big centred hand-lettered ink: warm off-white, soft dark edge, unhurried fade. Khmer renders in bundled Kantumruy Pro.', {
      typography: {
        font_family: 'Patrick Hand',
        font_size_px: 100,
        letter_spacing_px: 1.5,
        line_spacing_px: 12,
        max_chars_per_line: 20,
        max_lines: 3,
      },
      color: {
        primary_hex: '#FBF4E4',
        outline_hex: '#241B14',
        outline_opacity: 0.9,
        shadow_hex: '#1A120C',
        shadow_opacity: 0.75,
      },
      edge: { outline_px: 6, shadow_px: 4, blur_px: 3 },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
      animation: { type: 'fade', in_ms: 260, out_ms: 220 },
    }),

  /**
   * The same hand, with the spoken word picked out quietly.
   *
   * This is the GENTLE half of word-by-word: `highlight` changes the active
   * word's COLOUR only and never scales it, so the line holds still while the
   * voice moves through it. The accent is a soft warm amber rather than the
   * white-hot yellow the energetic styles use — it reads as ink catching light,
   * not as a graphic effect. The 220 ms ease is deliberately slower than the
   * snappy styles' 80-90 ms.
   */
  preset('shorts-vertical-hand-lettered-highlight', 'Shorts Vertical — Hand-lettered Gentle Highlight',
    'Hand-lettered ink with the spoken word warmed to soft amber. Same hand, quieter motion.', {
      typography: {
        font_family: 'Patrick Hand',
        font_size_px: 100,
        letter_spacing_px: 1.5,
        line_spacing_px: 12,
        max_chars_per_line: 20,
        max_lines: 3,
      },
      color: {
        primary_hex: '#FBF4E4',
        outline_hex: '#241B14',
        outline_opacity: 0.9,
        shadow_hex: '#1A120C',
        shadow_opacity: 0.75,
      },
      edge: { outline_px: 6, shadow_px: 4, blur_px: 3 },
      word: {
        mode: 'highlight',
        active_color_hex: '#F2C87B',
        inactive_color_hex: null,
        transition_ms: 220,
      },
      placement: { position: 'bottom', align: 'center', position_x_pct: 50, position_y_pct: 62, safe_margin_pct: 10 },
      animation: { type: 'fade', in_ms: 260, out_ms: 220 },
    }),
]
