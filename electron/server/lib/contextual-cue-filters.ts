import type { ContextualCue } from '../models/types.js'

/** Escape a reviewed cue for FFmpeg's drawtext value parser. */
function escapeCueText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\n/g, '\\n')
}

function escapedExpression(value: string): string {
  return value.replace(/,/g, '\\,')
}

function cueAlpha(cue: ContextualCue): string {
  const start = cue.start_sec.toFixed(3)
  const end = cue.end_sec.toFixed(3)
  const entrance = cue.entrance === 'dissolve' ? 0.42 : cue.entrance === 'fade' ? 0.20 : 0.12
  const exit = cue.exit === 'dissolve' ? 0.42 : cue.exit === 'fade' ? 0.20 : 0.12
  return escapedExpression(`if(lt(t,${(cue.start_sec + entrance).toFixed(3)}),(t-${start})/${entrance.toFixed(3)},if(gt(t,${(cue.end_sec - exit).toFixed(3)}),(${end}-t)/${exit.toFixed(3)},1))`)
}

function cueX(cue: ContextualCue, baseX: string, left: boolean): string {
  if (cue.entrance !== 'slide' && cue.exit !== 'slide') return baseX
  const duration = 0.28
  const start = cue.start_sec.toFixed(3)
  const leaveAt = (cue.end_sec - duration).toFixed(3)
  const end = cue.end_sec.toFixed(3)
  const outer = left ? '-text_w-40' : 'w+40'
  const inExpr = `${outer}+(${baseX}-(${outer}))*(t-${start})/${duration}`
  const outExpr = `${baseX}+(${outer}-(${baseX}))*(t-${leaveAt})/${duration}`
  if (cue.entrance === 'slide' && cue.exit === 'slide') {
    return escapedExpression(`if(lt(t,${(cue.start_sec + duration).toFixed(3)}),${inExpr},if(gt(t,${leaveAt}),${outExpr},${baseX}))`)
  }
  if (cue.entrance === 'slide') return escapedExpression(`if(lt(t,${(cue.start_sec + duration).toFixed(3)}),${inExpr},${baseX})`)
  return escapedExpression(`if(gt(t,${leaveAt}),${outExpr},${baseX})`)
}

function shared(cue: ContextualCue, x: string, y: string): string {
  const enable = `between(t,${cue.start_sec.toFixed(3)},${cue.end_sec.toFixed(3)})`
  const left = cue.placement.endsWith('left')
  return `x=${cueX(cue, x, left)}:y=${y}:alpha='${cueAlpha(cue)}':enable='${enable}'`
}

/**
 * Builds the exact drawtext filters for an already-approved cue. It consumes
 * only the reviewed text, timing, placement, treatment, and transitions—no
 * model call or timing inference happens at video-assembly time.
 */
export function buildContextualCueDrawtextFilters(cue: ContextualCue): string[] {
  const label = cue.subtitle ? `${cue.title}\n${cue.subtitle}` : cue.title
  const top = cue.placement.startsWith('top')
  const left = cue.placement.endsWith('left')
  const cornerX = left ? '56' : 'w-text_w-56'
  const cornerY = top ? '56' : 'h-text_h-56'
  const common = (x = cornerX, y = cornerY) => shared(cue, x, y)

  switch (cue.template) {
    case 'map-pin': {
      // A compact geographic marker, intentionally not a fabricated map.
      // It works over the reviewed scene image and preserves the cue's exact
      // timing while reserving a clear visual hierarchy for place names.
      const pinX = left ? '56' : 'w-text_w-56'
      const labelX = left ? '90' : 'w-text_w-92'
      return [
        `drawtext=text='●':fontcolor=0xf4c75d:fontsize=h*0.030:borderw=1:bordercolor=0x111827@0.85:${common(pinX, cornerY)}`,
        `drawtext=text='${escapeCueText(label)}':fontcolor=white:fontsize=h*0.030:line_spacing=10:box=1:boxcolor=0x111827@0.88:boxborderw=16:${common(labelX, cornerY)}`,
      ]
    }
    case 'archival-caption':
      return [
        `drawtext=text='${escapeCueText(label)}':fontcolor=0xf4ead1:fontsize=h*0.028:line_spacing=10:borderw=1:bordercolor=0x080808@0.85:box=1:boxcolor=0x2c211b@0.82:boxborderw=18:${common()}`,
      ]
    case 'chapter-plate':
      return [
        `drawtext=text='${escapeCueText(label)}':fontcolor=white:fontsize=h*0.052:line_spacing=16:borderw=2:bordercolor=0x111827@0.9:box=1:boxcolor=0x111827@0.82:boxborderw=30:${common('(w-text_w)/2', 'h*0.18')}`,
      ]
    case 'documentary-label':
    default:
      return [
        `drawtext=text='${escapeCueText(label)}':fontcolor=white:fontsize=h*0.032:line_spacing=12:box=1:boxcolor=0x111827@0.88:boxborderw=22:${common()}`,
      ]
  }
}
