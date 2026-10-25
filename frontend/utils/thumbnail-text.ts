import type { ThumbnailFont, ThumbnailTextStyle, ThumbnailTextRenderReport } from '@shared/thumbnail-text'

/** Unicode accepts ISO 15924 aliases; the installed inventory supplies the script vocabulary. */
function scriptPattern(code: string): RegExp | null {
  try { return new RegExp(`\\p{Script_Extensions=${code.charAt(0).toUpperCase()}${code.slice(1).toLowerCase()}}`, 'u') }
  catch { return null }
}

export function fontsForText(fonts: ThumbnailFont[], text: string): ThumbnailFont[] {
  const characters = [...text].filter(c => /[\p{Letter}\p{Mark}\p{Number}]/u.test(c)
    && !/\p{Script=Common}|\p{Script=Inherited}/u.test(c))
  return fonts.filter(font => {
    const patterns = font.scripts.map(scriptPattern).filter((p): p is RegExp => !!p)
    return characters.every(c => patterns.some(pattern => pattern.test(c)))
  })
}

export function textHasCase(text: string): boolean {
  return text.toUpperCase() !== text.toLowerCase()
}

/** Allowlist the look at BOTH preset boundaries, even if an old preset carries extra keys. */
export function thumbnailTextStyleOnly(style: ThumbnailTextStyle): ThumbnailTextStyle {
  return JSON.parse(JSON.stringify({
    font_id: style.font_id, weight: style.weight,
    size: { mode: style.size.mode, px: style.size.px, min_px: style.size.min_px, max_px: style.size.max_px },
    max_lines: style.max_lines, align: style.align, line_height: style.line_height,
    letter_spacing: style.letter_spacing, uppercase: style.uppercase,
    fill: { type: style.fill.type, color: style.fill.color, color2: style.fill.color2, angle: style.fill.angle },
    opacity: style.opacity,
    outline: { enabled: style.outline.enabled, color: style.outline.color, width_px: style.outline.width_px },
    shadow: { enabled: style.shadow.enabled, color: style.shadow.color, opacity: style.shadow.opacity, dx: style.shadow.dx, dy: style.shadow.dy, blur_px: style.shadow.blur_px },
    background: { enabled: style.background.enabled, color: style.background.color, opacity: style.background.opacity, padding_px: style.background.padding_px, radius_px: style.background.radius_px },
    placement: { anchor: style.placement.anchor, x_pct: style.placement.x_pct, y_pct: style.placement.y_pct, width_pct: style.placement.width_pct, height_pct: style.placement.height_pct },
  }))
}

export function thumbnailTextReportValid(report: ThumbnailTextRenderReport | null): boolean {
  return !!report && Number.isFinite(report.font_px) && report.font_px > 0
    && Number.isInteger(report.lines) && report.lines > 0 && report.overflow === false
    && report.glyphs_complete === true && Array.isArray(report.missing_characters)
    && report.missing_characters.length === 0
}

export function thumbnailTextEnabled(config: unknown): boolean {
  return (config as { thumbnail_text_layer_enabled?: boolean } | null)?.thumbnail_text_layer_enabled === true
}
