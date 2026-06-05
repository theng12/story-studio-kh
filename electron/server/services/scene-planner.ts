/**
 * Scene planner (v1.0.143+).
 *
 * Reads the stitched-timeline SRT (output of subtitle-stitcher) and an
 * optional research.json + narration docx, asks an LLM to pick natural
 * narrative beats, and emits a ScenePlan: one entry per scene with
 * start/end timestamps + transcript segment + visual prompt.
 *
 * Strategy: NATURAL BEATS (your locked answer). The LLM reads the full
 * transcript and decides scene boundaries based on:
 *   - Topic shifts (new subtopic introduced)
 *   - Named entity introductions (first time a person/place/thing is
 *     named)
 *   - Numeric milestones (dates, statistics, percentages)
 *   - Tonal pivots (explanation → counterargument, setup → punchline)
 *
 * Output is constrained to scenes between 3-10 seconds (avoids "every
 * sentence is a scene" cost explosion AND avoids "one image for 60s"
 * dead-air). LLM may break this; we post-validate + nudge boundaries
 * before persisting.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import { callAi } from '../lib/ai-client.js'
import { parseSrt, formatSrtTime, type SrtCue } from '../lib/subtitle-builder.js'
import { getApiKey } from './app-secrets-store.js'
import type {
  ResearchOutput,
  ScenePlan,
  ScenePlanEntry,
  ScenePlanRunOptions,
} from '../models/types.js'

const MIN_SCENE_SEC = 3
const MAX_SCENE_SEC = 12

/**
 * v1.0.242 — visual-prompt detail levels for the scene planner. The UI slider
 * (1–4) maps directly to these. `length` sets how many sentences/words to aim
 * for; `cover` enumerates which visual elements to describe. Level 2 is the
 * historical default ("2-3 sentences (~30-60 words)") so existing/unset runs
 * are byte-for-byte unchanged in intent.
 */
const DETAIL_SPECS: Record<number, { length: string; cover: string }> = {
  1: {
    length: '1 concise sentence (~12–20 words)',
    cover: 'the main subject, the core action, and the setting',
  },
  2: {
    length: '2-3 concrete sentences (~30-60 words)',
    cover: 'the main subject + appearance, the action/pose, the setting/background, the camera framing/angle, the lighting, and the mood',
  },
  3: {
    length: '3-4 rich sentences (~70-100 words)',
    cover: 'the main subject with specific physical + wardrobe detail, the precise action/pose, the setting/background with notable props, the camera framing/angle and lens feel, the lighting direction + quality, the colour palette, and the mood',
  },
  4: {
    length: '4-5 vivid, cinematic sentences (~110-150 words)',
    cover: 'the main subject in full physical, wardrobe, and expression detail; the exact action/pose and what they hold or touch; a layered foreground/background with props; the shot type, angle, lens, and depth of field; the lighting setup (key/fill/rim, direction, quality, time of day); the colour palette and grade; atmosphere (haze, particles, weather); and the overall emotional mood',
  },
}

function freshId(): string {
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Build the system + user prompt sent to the LLM. */
function buildScenePlannerPrompt(opts: {
  stitched_srt: string
  research?: ResearchOutput | null
  narration_text?: string | null
  target_scene_count?: number
  total_duration_sec: number
  /** v1.0.242 — visual-prompt richness (1–4); see DETAIL_SPECS below. */
  detail_level?: number
  /** v1.0.242 — global style woven into every visual_prompt. */
  style_prompt?: string
  /** v1.0.242 — extra free-text planner instructions. */
  custom_instructions?: string
  /** continuity-chain density pacing — see ScenePlanRunOptions.pacing. */
  pacing?: { min_sec: number; max_sec: number; mode?: 'live' }
  /** v1.0.226 — when set, the planner is working on ONE time-segment of a
   *  longer video (chunked planner). `stitched_srt` then holds only this
   *  segment's cues, and the model is asked for scenes covering [start,end]
   *  only — bounding the output so it never truncates. */
  window?: {
    index: number; total: number; start_sec: number; end_sec: number; prev_scene_end_sec: number
    /** v1.0.228 — rolling "story so far": a compact recap of scenes already
     *  planned in earlier segments (establishing shot + the last few visual
     *  prompts) so wardrobe/character/setting stay consistent across seams. */
    story_so_far?: string
  }
}): { system: string; user: string } {
  const minSec = opts.pacing ? opts.pacing.min_sec : MIN_SCENE_SEC
  const maxSec = opts.pacing ? opts.pacing.max_sec : MAX_SCENE_SEC

  // v1.0.242 — visual-prompt detail level. Drives how long + how rich each
  // `visual_prompt` is. Level 2 reproduces the historical "2-3 sentences
  // (~30-60 words)" behaviour, so unset/legacy runs are unchanged.
  const detail = DETAIL_SPECS[opts.detail_level ?? 2] ?? DETAIL_SPECS[2]!

  const schemaBlock = `Output JSON schema:
{
  "scenes": [
    {
      "start_sec": <number>,
      "end_sec": <number>,
      "transcript_segment": "<verbatim text from the SRT for this window>",
      "visual_prompt": "<${detail.length} describing the still image — cover: ${detail.cover}>",
      "boundary_reason": "<short hint: why you chose this boundary>"
    }
  ]
}`

  // continuity-chain: a character-driven, live-paced planner. Scenes track the
  // action moment-to-moment and cut denser on busy passages.
  const system = opts.pacing
    ? `You are a video scene planner for a character-driven, LIVE-paced video. Each scene becomes ONE still image, and consecutive images are rendered to flow into one another — so scenes should track the on-screen action moment to moment.

Rules:
  1. Pick scene boundaries that follow the ACTION and the speaker's beats: a new action, a new place, a new object handled, a shift in what's on screen.
  2. PACE FOR A LIVE FEEL. Every scene must be at least ${minSec} seconds and at most ${maxSec} seconds. Cut MORE often during busy, fast, or action-packed passages (multiple actions, list items, rapid delivery) — favour the SHORTER end of the range there. Hold longer (toward ${maxSec}s) only during slow, reflective, single-idea passages.
  3. Boundaries must align to actual cue start/end times from the SRT — don't invent timestamps that fall mid-cue.
  4. Each scene's \`visual_prompt\` is ${detail.length}, detailed enough for an image generator to render it well. Cover: ${detail.cover}. Keep the SAME on-screen character, wardrobe, and setting consistent across scenes, and anchor on the specific beat they're performing (what they're doing, holding, or looking at). Write a descriptive prompt, not a short caption — be concrete and avoid vague filler like "an interesting image" or "a person speaking".
  5. Return ONLY a JSON object. No prose, no markdown fences.

${schemaBlock}`
    : `You are a video scene planner for a fact-checked explainer channel.

Your job: read a narration transcript with timestamps and decide where the visual scene should change. Each scene becomes ONE still image in the final video.

Rules:
  1. Pick scene boundaries at NATURAL NARRATIVE BEATS, not on a fixed cadence:
     - When a new subtopic is introduced
     - When a named entity (person, place, year, statistic) is first mentioned
     - When the tone pivots (e.g. setup → conclusion, claim → counterclaim)
  2. Every scene must be at least ${minSec} seconds long and at most ${maxSec} seconds. Pick boundaries that fit this window — if a natural beat would create a too-short or too-long scene, choose the nearest acceptable break.
  3. Boundaries must align to actual cue start/end times from the SRT — don't invent timestamps that fall mid-cue.
  4. Each scene gets a \`visual_prompt\` — ${detail.length} describing what the still image should show, detailed enough for an image generator to render it well. Cover (where relevant): ${detail.cover}. Be SPECIFIC — name the subject; write a descriptive prompt, not a short caption. Avoid vague filler like "an interesting image" or "a person speaking".
  5. Return ONLY a JSON object. No prose, no markdown fences.

${schemaBlock}`

  const win = opts.window
  // Effective span the model is planning for: the window when chunked, else
  // the whole video. Drives the pacing estimate + framing.
  const spanSec = win ? (win.end_sec - win.start_sec) : opts.total_duration_sec

  const userParts: string[] = []
  if (win) {
    userParts.push(
      `This is SEGMENT ${win.index} of ${win.total} of a ${opts.total_duration_sec.toFixed(0)}s video.`,
      `Plan scenes ONLY for the time range ${win.start_sec.toFixed(2)}s – ${win.end_sec.toFixed(2)}s (this segment is ${spanSec.toFixed(1)}s long).`,
      `Your first scene must start at or after ${win.prev_scene_end_sec.toFixed(2)}s (where the previous segment ended), and your last scene must reach ${win.end_sec.toFixed(2)}s so there's no gap. Do NOT plan past ${win.end_sec.toFixed(2)}s — the next segment covers that.`,
    )
  } else {
    userParts.push(`Total duration: ${opts.total_duration_sec.toFixed(1)} seconds`)
  }
  if (opts.pacing) {
    const est = Math.max(2, Math.round(spanSec / ((minSec + maxSec) / 2)))
    userParts.push(`Pacing: each scene ${minSec}–${maxSec} seconds, cutting denser on busy passages for a live feel. That's roughly ${est} scenes for this ${win ? 'segment' : 'duration'} — but let the pacing decide the exact count.`)
  } else if (opts.target_scene_count && !win) {
    userParts.push(`Target scene count: ~${opts.target_scene_count} (treat as a guideline, not strict)`)
  } else {
    // Default: ~1 scene per 8 seconds if not specified.
    const est = Math.max(win ? 1 : 5, Math.round(spanSec / 8))
    userParts.push(`Target scene count: ~${est} for this ${win ? 'segment' : 'video'} (guideline; you decide based on natural beats)`)
  }

  // v1.0.242 — global visual style. Woven into EVERY scene's visual_prompt
  // (medium / art style / rendering / colour), not echoed verbatim each time.
  const style = opts.style_prompt?.trim()
  if (style) {
    userParts.push(
      `\nGLOBAL VISUAL STYLE — apply to EVERY scene's visual_prompt (the medium, art style, rendering, lighting feel, and colour treatment), weaving it in naturally rather than copying it word-for-word:\n${style}`,
    )
  }
  // v1.0.242 — extra planner instructions the user wants honoured throughout.
  const custom = opts.custom_instructions?.trim()
  if (custom) {
    userParts.push(`\nADDITIONAL INSTRUCTIONS — follow these for all scenes:\n${custom}`)
  }

  // Research context — surfaces named entities + concrete facts the
  // planner can use to anchor scene choices.
  if (opts.research && opts.research.claims.length) {
    const verified = opts.research.claims.filter(c => c.status === 'verified')
    if (verified.length) {
      userParts.push(
        '\nResearch context (verified claims you can use to anchor visual prompts):',
        ...verified.map((c, i) => `${i + 1}. ${c.text}`),
      )
    }
  }

  // Optional full-text narration context.
  if (opts.narration_text) {
    userParts.push('\nFull narration text (for tone / context — the SRT below is the timestamps source of truth):')
    // Cap to avoid huge prompt for long episodes — first 6k chars is
    // enough for tone/voice; the SRT carries the timestamps.
    userParts.push(opts.narration_text.slice(0, 6000))
  }

  // Rolling continuity recap so visual choices stay consistent across the
  // segment seams (chunked planner). Placed right before the cues so it's the
  // freshest context when the model writes this segment's visual prompts.
  if (win?.story_so_far) {
    userParts.push('\n' + win.story_so_far)
  }

  userParts.push(
    win
      ? `\nSRT cues for THIS segment (${win.start_sec.toFixed(2)}s–${win.end_sec.toFixed(2)}s — the timestamps your boundaries must align to):`
      : '\nStitched SRT (the timestamps your boundaries must align to):',
    opts.stitched_srt,
  )
  userParts.push('\nReturn the JSON now.')

  return { system, user: userParts.join('\n\n') }
}

/** Tolerant JSON parser — strips fences, handles prose preamble, and (v1.0.225)
 *  salvages complete scene objects from output truncated at the token cap. */
export function parsePlannerJson(raw: string): { scenes?: Array<{
  start_sec: number
  end_sec: number
  transcript_segment?: string
  visual_prompt?: string
  boundary_reason?: string
}> } {
  if (!raw) return {}
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1))
    } catch { /* fall through to salvage — output was likely truncated */ }
  }
  // v1.0.225 — salvage. A long episode's plan can exceed the model's output
  // token cap, truncating the JSON mid-array. Rather than throw away the
  // whole response, extract every COMPLETE scene object that did finish.
  const salvaged = salvageScenes(cleaned)
  return salvaged.length ? { scenes: salvaged } : {}
}

/**
 * Pull complete `{...}` scene objects out of a (possibly truncated) JSON
 * string. Brace-matches with string-awareness so commas/braces inside
 * prompt text don't fool it; stops at the first incomplete object.
 */
function salvageScenes(text: string): Array<any> {
  const arrKey = text.search(/"scenes"\s*:\s*\[/)
  let i = arrKey >= 0 ? text.indexOf('[', arrKey) + 1 : text.indexOf('[') + 1
  if (i <= 0) return []
  const out: any[] = []
  while (i < text.length && i > 0) {
    const objStart = text.indexOf('{', i)
    if (objStart < 0) break
    let depth = 0, inStr = false, esc = false, j = objStart
    for (; j < text.length; j++) {
      const ch = text[j]!
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) break }
    }
    if (depth !== 0 || j >= text.length) break  // truncated object — stop here
    try { out.push(JSON.parse(text.slice(objStart, j + 1))) } catch { /* skip one bad object */ }
    i = j + 1
    if (/^\s*\]/.test(text.slice(i))) break  // reached the array close
  }
  return out
}

/** Snap a timestamp to the nearest SRT cue boundary so visual changes
 *  don't happen mid-word. */
function snapToCueBoundary(
  candidateSec: number,
  cueBoundaries: number[],
): number {
  if (cueBoundaries.length === 0) return candidateSec
  let closest = cueBoundaries[0]!
  let closestDist = Math.abs(candidateSec - closest)
  for (const b of cueBoundaries) {
    const d = Math.abs(candidateSec - b)
    if (d < closestDist) {
      closest = b
      closestDist = d
    }
  }
  return closest
}

/** Post-validate + nudge scene boundaries. Clamps to min/max duration
 *  and snaps to cue boundaries so visual changes land on natural beats
 *  in the spoken audio rather than mid-sentence. */
function normalizeScenes(
  rawScenes: Array<any>,
  cueBoundaries: number[],
  totalDuration: number,
  minSec: number = MIN_SCENE_SEC,
  maxSec: number = MAX_SCENE_SEC,
  initialPrevEnd = 0,
): ScenePlanEntry[] {
  const out: ScenePlanEntry[] = []
  let prevEnd = initialPrevEnd
  for (let i = 0; i < rawScenes.length; i++) {
    const s = rawScenes[i]!
    let start = Math.max(0, Number(s.start_sec) || 0)
    let end = Math.min(totalDuration, Number(s.end_sec) || start + minSec)

    // Enforce no-overlap with prev scene.
    if (start < prevEnd) start = prevEnd

    // Snap to cue boundaries.
    start = snapToCueBoundary(start, cueBoundaries)
    end = snapToCueBoundary(end, cueBoundaries)

    // Enforce min/max duration (the user's pacing band for continuity-chain).
    if (end - start < minSec) end = Math.min(totalDuration, start + minSec)
    if (end - start > maxSec) end = start + maxSec

    if (end <= start) continue

    out.push({
      id: freshId(),
      scene_index: out.length + 1,
      start_sec: start,
      end_sec: end,
      transcript_segment: typeof s.transcript_segment === 'string' ? s.transcript_segment : '',
      visual_prompt: typeof s.visual_prompt === 'string' ? s.visual_prompt : '',
      boundary_reason: typeof s.boundary_reason === 'string' ? s.boundary_reason : undefined,
      approved: false,
    })
    prevEnd = end
  }
  return out
}

/**
 * v1.0.245 — graceful fallback when a window's LLM call fails repeatedly.
 * Instead of ONE giant filler scene spanning the whole window (the old
 * behaviour that produced 150s+ scenes), slice the span into cue-aligned
 * chunks no longer than `maxSec`, each carrying its cues' text as the
 * transcript and an EMPTY visual_prompt. The empty prompt + boundary_reason
 * make these easy to flag in the Plan-health check, and the user can re-plan
 * or fill them — but the timeline is never blocked by a single huge scene.
 */
function subdivideWindow(
  cues: SrtCue[],
  startSec: number,
  endSec: number,
  maxSec: number,
): ScenePlanEntry[] {
  const out: ScenePlanEntry[] = []
  let chunkStart = startSec
  let chunkCues: SrtCue[] = []
  const flush = (end: number): void => {
    if (end <= chunkStart) return
    out.push({
      id: freshId(),
      scene_index: 0,
      start_sec: chunkStart,
      end_sec: end,
      transcript_segment: chunkCues.map(c => c.text).join(' ').slice(0, 2000),
      visual_prompt: '',
      boundary_reason: 'auto-split (planner failed here — re-plan this scene or write a prompt)',
      approved: false,
    })
    chunkStart = end
    chunkCues = []
  }
  for (const c of cues) {
    chunkCues.push(c)
    if (c.end_sec - chunkStart >= maxSec) flush(c.end_sec)
  }
  flush(endSec)
  return out
}

/**
 * v1.0.252 — the ACTUAL spoken text for a scene's [start, end], assembled from
 * the SRT cues by time. We override the LLM's `transcript_segment` with this:
 * the model was asked to copy the SRT verbatim but reliably drifts (paraphrases
 * / shifts by a cue or two), which made Scene Review's transcript "not follow
 * the voiceover". The cues are the ground truth, so derive it mechanically.
 */
function transcriptForRange(cues: SrtCue[], start: number, end: number): string {
  return cues
    .filter(c => c.end_sec > start + 0.05 && c.start_sec < end - 0.05)
    .map(c => c.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

/**
 * v1.0.252 — split a scene that runs longer than `maxSec` into cue-aligned
 * sub-scenes (each ≤ maxSec), every part inheriting the parent's visual_prompt
 * and getting its own SRT-derived transcript. Over-long scenes come from the
 * contiguity step stretching an under-covered window's last scene to the window
 * end without re-capping — that produced the 90s / 22s blobs. If the span has
 * ≤1 cue (genuinely one long subtitle) it can't be split and is returned as-is.
 */
function splitLongScene(scene: ScenePlanEntry, cues: SrtCue[], maxSec: number): ScenePlanEntry[] {
  const inner = cues.filter(c => c.end_sec > scene.start_sec + 0.05 && c.start_sec < scene.end_sec - 0.05)
  if (inner.length <= 1) return [scene]
  const out: ScenePlanEntry[] = []
  let segStart = scene.start_sec
  let segCues: SrtCue[] = []
  const flush = (end: number): void => {
    if (end <= segStart || !segCues.length) return
    out.push({
      ...scene,
      id: freshId(),
      start_sec: segStart,
      end_sec: end,
      transcript_segment: segCues.map(c => c.text.trim()).filter(Boolean).join(' ').trim(),
    })
    segStart = end
    segCues = []
  }
  for (const c of inner) {
    // Cut before this cue when adding it would exceed maxSec (and we already
    // have content) — keeps every part ≤ maxSec, aligned to a cue boundary.
    if (segCues.length && c.end_sec - segStart > maxSec) flush(c.start_sec)
    segCues.push(c)
  }
  flush(scene.end_sec)
  return out.length ? out : [scene]
}

/** Serialize a cue list back into SRT text (global timestamps preserved). */
function cuesToSrt(cues: SrtCue[]): string {
  const lines: string[] = []
  cues.forEach((c, i) => {
    lines.push(String(i + 1))
    lines.push(`${formatSrtTime(c.start_sec)} --> ${formatSrtTime(c.end_sec)}`)
    lines.push(c.text)
    lines.push('')
  })
  return lines.join('\n')
}

interface PlanWindow { start: number; end: number; cues: SrtCue[] }

/**
 * Split the cue list into contiguous time-windows aligned to cue boundaries.
 * Each window targets ~`windowSec` of audio so the per-window LLM output
 * stays well under the token cap — the planner asks for one window at a
 * time, so total episode length no longer matters. Windows never split a cue.
 */
export function buildWindows(cues: SrtCue[], windowSec: number): PlanWindow[] {
  if (!cues.length) return []
  const windows: PlanWindow[] = []
  let cur: PlanWindow = { start: cues[0]!.start_sec, end: cues[0]!.end_sec, cues: [] }
  for (const c of cues) {
    // Close the current window once it has spanned ~windowSec and has content.
    if (cur.cues.length && c.start_sec - cur.start >= windowSec) {
      cur.end = cur.cues[cur.cues.length - 1]!.end_sec
      windows.push(cur)
      cur = { start: c.start_sec, end: c.end_sec, cues: [] }
    }
    cur.cues.push(c)
    cur.end = c.end_sec
  }
  if (cur.cues.length) windows.push(cur)
  return windows
}

/**
 * v1.0.228 — build the rolling "story so far" recap from scenes already
 * planned in earlier segments, so the next segment keeps wardrobe / character
 * / setting consistent across the seam. Derived from the plan (no extra LLM
 * call). Carries the ESTABLISHING shot (anchor) + the last few scenes (the
 * immediate seam). `live` true → character-continuity wording (continuity
 * chain); false → general visual-consistency wording (explainer).
 */
export function buildStorySoFar(scenes: ScenePlanEntry[], live: boolean): string {
  const withVisual = scenes.filter(s => s.visual_prompt && s.visual_prompt.trim())
  if (!withVisual.length) return ''
  const anchor = withVisual[0]!.visual_prompt.trim()
  const recent = withVisual.slice(-5)
  const recentLines = recent.map(s => `  • [${s.start_sec.toFixed(0)}s] ${s.visual_prompt.trim()}`)
  const rule = live
    ? 'CONTINUITY: this is one continuous character-driven video. Keep the SAME character (face, age, hair, wardrobe) and the established setting consistent with the scenes already planned below — do not restyle or re-introduce them.'
    : 'CONTINUITY: keep the visual style, recurring subjects, and setting consistent with the scenes already planned below; don\'t contradict or re-introduce what\'s already established.'
  return [
    rule,
    `Establishing shot (from segment 1): ${anchor}`,
    'Most recent scenes already planned (the LAST one is immediately before your first scene — continue smoothly from it):',
    ...recentLines,
  ].join('\n')
}

/** Run the LLM planner. Returns a ScenePlan object ready to persist. */
export async function planScenes(opts: ScenePlanRunOptions): Promise<ScenePlan> {
  if (!existsSync(opts.stitched_srt_path)) {
    throw new Error(`Stitched SRT not found at ${opts.stitched_srt_path}. Run "Stitch subtitles" first.`)
  }

  const stitchedRaw = await fs.readFile(opts.stitched_srt_path, 'utf-8')
  const cues = parseSrt(stitchedRaw)
  if (cues.length === 0) {
    throw new Error('Stitched SRT contains no cues. Re-derive subtitles before planning scenes.')
  }

  // Pull cue boundaries for the snap step. Both start AND end count
  // as potential boundaries — natural scene change points.
  const cueBoundaries: number[] = []
  for (const c of cues) {
    cueBoundaries.push(c.start_sec)
    cueBoundaries.push(c.end_sec)
  }
  // De-dupe + sort.
  const dedupedBoundaries = Array.from(new Set(cueBoundaries.map(b => Math.round(b * 1000) / 1000))).sort((a, b) => a - b)
  const totalDuration = cues[cues.length - 1]!.end_sec

  // Optional context: research + narration docx.
  let research: ResearchOutput | null = null
  if (opts.research_path && existsSync(opts.research_path)) {
    try {
      research = JSON.parse(await fs.readFile(opts.research_path, 'utf-8')) as ResearchOutput
    } catch { /* ignore — proceed without */ }
  }
  let narrationText: string | null = null
  if (opts.narration_docx_path && existsSync(opts.narration_docx_path)) {
    try {
      const { narrationDocxToMarkdown } = await import('../lib/docx-parser.js')
      const md = await narrationDocxToMarkdown(opts.narration_docx_path)
      narrationText = md || null
    } catch { /* ignore — proceed without */ }
  }

  // continuity-chain density pacing (the user's per-episode band) overrides
  // the default 3–12s window for both the prompt and the post-validation.
  const minSec = opts.pacing ? opts.pacing.min_sec : MIN_SCENE_SEC
  const maxSec = opts.pacing ? opts.pacing.max_sec : MAX_SCENE_SEC

  // ── Chunked planning (v1.0.226; per-model tuning v1.0.285) ──────────────
  // Split the timeline into contiguous windows and plan each one in its own
  // LLM call. Input context (narration/research) is cheap and re-sent per
  // window; only the OUTPUT was ever the constraint, and each window's output
  // is bounded — so episode length no longer causes truncation. Windows never
  // split a cue.
  //
  // v1.0.285 — window size is now tunable. The 'auto' default keeps the
  // historical 30 scenes/window for cloud models (Claude/GPT/OpenRouter) and
  // drops to 10 scenes/window for local LM Studio models (smaller JSON output
  // → fewer truncation/parse failures → fewer empty visual_prompt fallbacks).
  // Manual 'full' / 'small' override the auto choice for the rare case where
  // the user wants the other behaviour (e.g. cloud with smaller windows to
  // bound a single call's cost, or local with full windows on a beefy
  // long-context model). See ScenePlanRunOptions.window_size for the
  // user-facing description.
  const avgSceneSec = (minSec + maxSec) / 2
  const isLocalModel = typeof opts.model === 'string' && opts.model.startsWith('lmstudio:')
  const sizeMode = opts.window_size || 'auto'
  const TARGET_SCENES_PER_WINDOW =
    sizeMode === 'small' ? 10
      : sizeMode === 'full' ? 30
        : (isLocalModel ? 10 : 30) // 'auto'
  // Window-seconds bounds shrink in lockstep with the target count so a
  // 10-scene window doesn't accidentally span 5 minutes of audio. The
  // 60–300s clamp came from the historical 30-scene size; for 10-scene
  // mode we drop the lower bound to 30s and the upper to 120s so the
  // window naturally lands around 80–100s of audio.
  const minWindow = TARGET_SCENES_PER_WINDOW <= 10 ? 30 : 60
  const maxWindow = TARGET_SCENES_PER_WINDOW <= 10 ? 120 : 300
  const windowSec = Math.max(minWindow, Math.min(maxWindow, Math.round(TARGET_SCENES_PER_WINDOW * avgSceneSec)))

  // v1.0.245 — range re-plan: plan ONLY the cues overlapping [start, end], seed
  // the chain at range.start, and clamp coverage to range.end. The full-episode
  // path leaves these at their defaults (all cues, start 0, total duration).
  const range = opts.range
  const planCues = range
    ? cues.filter(c => c.end_sec > range.start_sec + 0.001 && c.start_sec < range.end_sec - 0.001)
    : cues
  const initialPrevEnd = range ? range.start_sec : 0
  const coverEnd = range ? range.end_sec : totalDuration
  const windows = buildWindows(planCues, windowSec)

  // Pull candidate keys once; callAi picks the right one per call.
  const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
    getApiKey('anthropic').catch(() => ''),
    getApiKey('openai').catch(() => ''),
    getApiKey('kie').catch(() => ''),
  ])
  const apiKeys = { anthropic_api_key, openai_api_key, kie_api_key }

  const allScenes: ScenePlanEntry[] = []
  let prevEnd = initialPrevEnd
  let lastError: Error | null = null

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w]!
    const { system, user } = buildScenePlannerPrompt({
      stitched_srt: cuesToSrt(win.cues),
      research,
      narration_text: narrationText,
      total_duration_sec: totalDuration,
      pacing: opts.pacing,
      target_scene_count: opts.target_scene_count,
      detail_level: opts.detail_level,
      style_prompt: opts.style_prompt,
      custom_instructions: opts.custom_instructions,
      window: {
        index: w + 1,
        total: windows.length,
        start_sec: win.start,
        end_sec: win.end,
        prev_scene_end_sec: prevEnd,
        // Rolling continuity recap from earlier segments (empty for the first).
        story_so_far: w > 0 ? buildStorySoFar(allScenes, !!opts.pacing) : undefined,
      },
    })

    // v1.0.245 — guardrail: retry a window before giving up. A single
    // transient LLM failure (timeout, malformed JSON) used to collapse the
    // whole window into one giant filler scene.
    let winScenes: ScenePlanEntry[] = []
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && winScenes.length === 0; attempt++) {
      try {
        const raw = await callAi(opts.model, system, user, apiKeys, false, { maxTokens: 16000 })
        const parsed = parsePlannerJson(raw)
        // Clamp this window's scenes to [prevEnd, win.end] so they stay in-segment
        // and don't overlap the next window; seed prevEnd for cross-window order.
        winScenes = normalizeScenes(parsed.scenes || [], dedupedBoundaries, win.end, minSec, maxSec, prevEnd)
        if (winScenes.length === 0 && attempt < MAX_ATTEMPTS) {
          opts.onWarn?.(`Segment ${w + 1}/${windows.length} (${win.start.toFixed(0)}–${win.end.toFixed(0)}s) returned no usable scenes — retrying…`)
        }
      } catch (e: any) {
        lastError = e instanceof Error ? e : new Error(String(e))
        if (attempt < MAX_ATTEMPTS) {
          opts.onWarn?.(`Segment ${w + 1}/${windows.length} failed (${lastError.message}) — retrying…`)
        }
      }
    }

    // Contiguity: a window must fully cover [prevEnd, win.end] so the video
    // never has a gap with no image. Extend the last scene to the window end.
    // If the window failed every attempt, SUBDIVIDE it into cue-aligned
    // ≤maxSec scenes (empty prompts, flagged) rather than one giant blob —
    // so a failed window degrades gracefully and is easy to spot + fix.
    if (winScenes.length) {
      const last = winScenes[winScenes.length - 1]!
      if (last.end_sec < win.end) last.end_sec = win.end
    } else if (win.end > prevEnd) {
      winScenes = subdivideWindow(win.cues, prevEnd, win.end, maxSec)
      opts.onWarn?.(
        `⚠ Segment ${w + 1}/${windows.length} (${win.start.toFixed(0)}–${win.end.toFixed(0)}s) failed after ${MAX_ATTEMPTS} tries — ` +
        `split into ${winScenes.length} placeholder scene(s) with empty prompts. Use "Re-plan this scene" or write prompts for them.`,
      )
    }

    allScenes.push(...winScenes)
    prevEnd = win.end
    opts.onProgress?.(w + 1, windows.length, allScenes.length)
  }

  // v1.0.245 — range re-plan must fully cover [range.start, range.end] so the
  // spliced result leaves no gap before the next (untouched) scene.
  if (range && allScenes.length) {
    const last = allScenes[allScenes.length - 1]!
    if (last.end_sec < coverEnd) last.end_sec = coverEnd
  }

  if (allScenes.length === 0) {
    throw new Error(
      `Scene planner produced no usable scenes across ${windows.length} segment(s). ` +
      (lastError ? `Last error: ${lastError.message}` : 'Check the model output in the Jobs panel.'),
    )
  }

  // v1.0.252 — finalize pass over every scene (full plan AND range re-plan):
  //   1. Override transcript_segment with the SRT text by time, so the
  //      displayed transcript always matches the voiceover (the LLM's copy
  //      drifts). Falls back to the LLM's text only if no cue overlaps (rare
  //      silence gap).
  //   2. Split any scene longer than maxSec into cue-aligned ≤maxSec parts
  //      (inheriting the visual prompt) — kills the over-long "blob" scenes
  //      from contiguity over-extension at the source.
  const finalScenes: ScenePlanEntry[] = []
  for (const s of allScenes) {
    s.transcript_segment = transcriptForRange(cues, s.start_sec, s.end_sec) || s.transcript_segment
    if (s.end_sec - s.start_sec > maxSec + 0.5) {
      finalScenes.push(...splitLongScene(s, cues, maxSec))
    } else {
      finalScenes.push(s)
    }
  }
  // Re-index into a single ordered list.
  finalScenes.forEach((s, i) => { s.scene_index = i + 1 })

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    planner_model: opts.model,
    source_stitched_srt: opts.stitched_srt_path.split('/').pop(),
    total_duration_sec: totalDuration,
    research_used: !!research,
    scenes: finalScenes,
    planned_in_windows: windows.length,
  }
}
