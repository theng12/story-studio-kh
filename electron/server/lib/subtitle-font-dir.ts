/**
 * The bundled fonts directory, for a libass burn.
 *
 * ── Why a burn needs this at all ───────────────────────────────────────────
 *
 * The app ships its own OFL faces in `bundled/fonts/` — `fonts.json` is the
 * only list, and it grows — so a headline is identical on every Mac. The
 * thumbnail renderer already resolves them by family through its own
 * Fontconfig file. The VIDEO burn did not, and the difference is not cosmetic:
 *
 * libass picks its font provider from the build. This FFmpeg is built against
 * CoreText, and `fontselect` (measured 2026-10-27) resolves a family through
 * macOS's installed fonts and NOT through `FONTCONFIG_FILE`. So a caption
 * asking for a bundled face that is not also installed system-wide was drawn
 * in Helvetica — silently, with no warning anywhere — which is the "CSS that
 * silently does nothing" shape from AGENTS §3, in the renderer.
 *
 * `ass=…:fontsdir=…` is the one thing that works for a CoreText libass: it
 * makes the bundled directory a search root for that filter. Measured with the
 * bundled FFmpeg:
 *
 *   - `Moul` + `fontsdir` → `Moul-Regular, 0, Moul-Regular` (the bundled file)
 *   - `Helvetica` + `fontsdir` → `/System/Library/Fonts/Helvetica.ttc` (system,
 *     unchanged — every episode already delivered keeps its face)
 *   - an unknown family + `fontsdir` → falls back to Helvetica as before, so a
 *     missing font still renders rather than dropping the caption
 *
 * The directory is passed whole (`bundled/fonts`, not one face's folder) so a
 * face added later needs no code change: drop the files, add the manifest
 * entry, and the burn can already see it.
 */

import { existsSync } from 'fs'
import { escapeFilterPath } from './ffmpeg-filter-escape.js'
import { fontsResourceDir } from './thumbnail-fonts.js'

/**
 * The `:fontsdir=…` fragment for an `ass=`/`subtitles=` filter, or `''`.
 *
 * Empty when the directory is not on disk (a stripped build, a test fixture),
 * so a caller emits exactly the filter it emitted before this existed and no
 * burn can fail because a font folder is missing.
 */
export function bundledFontsFilterOption(): string {
  try {
    const dir = fontsResourceDir()
    if (!dir || !existsSync(dir)) return ''
    // Same two-level escape as `filename=`; the value is emitted unquoted.
    return `:fontsdir=${escapeFilterPath(dir)}`
  } catch {
    return ''
  }
}
