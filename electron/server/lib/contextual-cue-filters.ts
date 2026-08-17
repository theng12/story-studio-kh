import type { ContextualCue } from '../models/types.js'
import { escapeFilterArgValue } from './ffmpeg-utils.js'

// Cue text is LLM-drafted and human-approved. `validateContextualCueTimeline`
// caps its length but deliberately does not restrict which characters it may
// contain, so the renderer has to handle everything a reviewer could approve —
// apostrophes above all ("Constantinople's main avenue" is real approved copy).
// `escapeFilterArgValue` is the only thing between that text and the filtergraph
// parser; see its contract for why nothing emitted here is quoted.

function cueAlpha(cue: ContextualCue): string {
  const start = cue.start_sec.toFixed(3)
  const end = cue.end_sec.toFixed(3)
  const entrance = cue.entrance === 'dissolve' ? 0.42 : cue.entrance === 'fade' ? 0.20 : 0.12
  const exit = cue.exit === 'dissolve' ? 0.42 : cue.exit === 'fade' ? 0.20 : 0.12
  return `if(lt(t,${(cue.start_sec + entrance).toFixed(3)}),(t-${start})/${entrance.toFixed(3)},if(gt(t,${(cue.end_sec - exit).toFixed(3)}),(${end}-t)/${exit.toFixed(3)},1))`
}

function cueX(cue: ContextualCue, baseX: string, left: boolean): string {
  if (cue.entrance !== 'slide' && cue.exit !== 'slide') return baseX
  const duration = 0.28
  const start = cue.start_sec.toFixed(3)
  const leaveAt = (cue.end_sec - duration).toFixed(3)
  const outer = left ? '-text_w-40' : 'w+40'
  const inExpr = `${outer}+(${baseX}-(${outer}))*(t-${start})/${duration}`
  const outExpr = `${baseX}+(${outer}-(${baseX}))*(t-${leaveAt})/${duration}`
  if (cue.entrance === 'slide' && cue.exit === 'slide') {
    return `if(lt(t,${(cue.start_sec + duration).toFixed(3)}),${inExpr},if(gt(t,${leaveAt}),${outExpr},${baseX}))`
  }
  if (cue.entrance === 'slide') return `if(lt(t,${(cue.start_sec + duration).toFixed(3)}),${inExpr},${baseX})`
  return `if(gt(t,${leaveAt}),${outExpr},${baseX})`
}

function shared(cue: ContextualCue, x: string, y: string): string {
  const enable = `between(t,${cue.start_sec.toFixed(3)},${cue.end_sec.toFixed(3)})`
  const left = cue.placement.endsWith('left')
  // Every emitted value goes through the same two-level escape and is left
  // unquoted; the timing expressions need it for their commas just as much as
  // the reviewed copy needs it for its apostrophes.
  return [
    `x=${escapeFilterArgValue(cueX(cue, x, left))}`,
    `y=${escapeFilterArgValue(y)}`,
    `alpha=${escapeFilterArgValue(cueAlpha(cue))}`,
    `enable=${escapeFilterArgValue(enable)}`,
  ].join(':')
}

/**
 * `expansion=none` stops drawtext treating `%` / `%{...}` in approved copy as a
 * strftime or metadata template. Cue text is literal editorial copy, never a
 * template, so a rate like "40% mortality" must render as written.
 */
const LITERAL_TEXT = 'expansion=none'

function drawCueText(label: string, options: string): string {
  return `drawtext=text=${escapeFilterArgValue(label)}:${LITERAL_TEXT}:${options}`
}

/**
 * Builds the exact drawtext filters for an already-approved cue. It consumes
 * only the reviewed text, timing, placement, treatment, and transitions—no
 * model call or timing inference happens at video-assembly time.
 *
 * `offsetSec` moves the reviewed window onto the COMPOSED video's clock. A cue
 * is reviewed against Scene Plan time, but the composed video may open with a
 * branded opening (before-intro clips + intro + after-intro clips + title
 * card) that the plan does not carry, which pushes every scene later by
 * exactly the opening's measured length. Video Assembly derives that number
 * from the real opening assets and hands it in here; see
 * `sceneTimelineOffsetSec` in `generators/video.ts`. It is 0 when nothing
 * precedes the scenes, so an intro-less episode renders byte-identically to
 * before. The reviewed window itself is never mutated — only where it lands.
 */
export function buildContextualCueDrawtextFilters(cue: ContextualCue, offsetSec = 0): string[] {
  if (offsetSec) {
    cue = { ...cue, start_sec: cue.start_sec + offsetSec, end_sec: cue.end_sec + offsetSec }
  }
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
        drawCueText('●', `fontcolor=0xf4c75d:fontsize=h*0.030:borderw=1:bordercolor=0x111827@0.85:${common(pinX, cornerY)}`),
        drawCueText(label, `fontcolor=white:fontsize=h*0.030:line_spacing=10:box=1:boxcolor=0x111827@0.88:boxborderw=16:${common(labelX, cornerY)}`),
      ]
    }
    case 'archival-caption':
      return [
        drawCueText(label, `fontcolor=0xf4ead1:fontsize=h*0.028:line_spacing=10:borderw=1:bordercolor=0x080808@0.85:box=1:boxcolor=0x2c211b@0.82:boxborderw=18:${common()}`),
      ]
    case 'chapter-plate':
      return [
        drawCueText(label, `fontcolor=white:fontsize=h*0.052:line_spacing=16:borderw=2:bordercolor=0x111827@0.9:box=1:boxcolor=0x111827@0.82:boxborderw=30:${common('(w-text_w)/2', 'h*0.18')}`),
      ]
    case 'documentary-label':
    default:
      return [
        drawCueText(label, `fontcolor=white:fontsize=h*0.032:line_spacing=12:box=1:boxcolor=0x111827@0.88:boxborderw=22:${common()}`),
      ]
  }
}
