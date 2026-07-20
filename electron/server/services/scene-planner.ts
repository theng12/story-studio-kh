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
import { callAi, sanitizeJsonControlChars } from '../lib/ai-client.js'
import { parseSrt, formatSrtTime, type SrtCue } from '../lib/subtitle-builder.js'
import { getApiKey } from './app-secrets-store.js'
import { parseEndpoints } from '../lib/endpoint-pool.js'
import { resetChatstudioDispatcher } from '../lib/chatstudio-client.js'
import { CHATSTUDIO_MODEL_PREFIX } from '../providers/text/chatstudio.js'
import { isLocalTextModel } from './job-retry-policy.js'
import {
  buildCreativeDirectionPrompt,
  CREATIVE_STRATEGY_INSTRUCTIONS,
} from './scene-creative-direction.js'
import type {
  ResearchOutput,
  SceneCreativeDirection,
  SceneCreativeStrategy,
  ScenePlan,
  ScenePlanEntry,
  ScenePlanRunOptions,
  SceneType,
} from '../models/types.js'

const MIN_SCENE_SEC = 3
const MAX_SCENE_SEC = 12

// v1.0.336 — coerce the planner's `scene_type` to a valid value (or undefined,
// which the renderer treats as a character scene for back-compat).
const VALID_SCENE_TYPES: ReadonlySet<string> = new Set(['character', 'event', 'environment', 'map', 'artifact'])
function coerceSceneType(v: unknown): SceneType | undefined {
  return typeof v === 'string' && VALID_SCENE_TYPES.has(v) ? (v as SceneType) : undefined
}

// v1.0.337 — distribute scene_type across scenes the planner left UNTAGGED
// (two-pass deterministic split, salvage fallbacks) to hit the configured guide
// density. An even-spread accumulator scatters the character scenes rather than
// clustering them: 0 → none, 100 → all character, 40 → ~40% spread out. Scenes
// that already carry a type (single-pass LLM classification, or a user
// override) are left untouched.
const NONCHAR_CYCLE: SceneType[] = ['event', 'environment', 'map', 'artifact']
export function assignDensityToUntagged(scenes: ScenePlanEntry[], density: number): void {
  const d = Math.max(0, Math.min(100, density))
  let acc = 0
  let nonCharIdx = 0
  for (const s of scenes) {
    if (s.scene_type) continue
    acc += d / 100
    if (acc >= 1) { acc -= 1; s.scene_type = 'character' }
    else { s.scene_type = NONCHAR_CYCLE[nonCharIdx++ % NONCHAR_CYCLE.length] }
  }
}

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

/**
 * v1.0.468 — image-to-video motion-intensity scale (1–4) for the per-scene
 * `motion_prompt`. Mirrors DETAIL_SPECS. EVERY level forbids fast, jittery, or
 * frantic motion — the clips animate a still image with restraint. `allow`
 * describes what kind of movement is permitted at that level; `camera` suggests
 * the camera feel. The LLM is told to ground all motion in THIS scene's image
 * prompt + narration, so a character only "walks/points" if the scene depicts
 * one. Level 2 (Gentle) is the sleep-story default.
 */
export const MOTION_SPECS: Record<number, { label: string; allow: string; camera: string }> = {
  1: {
    label: 'Still',
    allow: 'almost no movement — only the faintest ambient life (a slow drift of mist, a subtle shimmer of water or light). No subject motion. A living photo.',
    camera: 'a barely-perceptible slow push-in or hold; essentially static.',
  },
  2: {
    label: 'Gentle',
    allow: 'soft ambient motion (drifting clouds, gentle ripples, swaying foliage, floating dust in light) and the smallest natural sways. No deliberate subject action.',
    camera: 'a slow, smooth pan or push-in/pull-back — calm and hypnotic.',
  },
  3: {
    label: 'Moderate',
    allow: 'subtle subject motion that the narration actually implies — a character slowly walking, turning their head, gesturing or pointing, hair or clothing moving — plus the ambient motion of lower levels.',
    camera: 'a gentle pan, tilt, or dolly that follows the subject; unhurried.',
  },
  4: {
    label: 'Lively',
    allow: 'clear but smooth movement — the subject walks, reaches, or interacts; more active ambient elements (flowing water, rustling leaves, flickering flame) — all of it flowing, never abrupt.',
    camera: 'a confident but smooth move (slow orbit, tracking push-in); energetic yet graceful.',
  },
}

/**
 * v1.0.468 — resolve the effective motion-intensity level: an explicit per-run
 * value wins, else the project default, else 2 (Gentle). Always clamped to the
 * 1–4 range MOTION_SPECS defines; non-finite inputs fall through to the default.
 */
export function resolveMotionLevel(explicit?: number | null, projectDefault?: number | null): number {
  const pick = (v: unknown): number | null => {
    if (v == null || v === '') return null  // unset — fall through (Number(null) is 0, which would wrongly clamp to 1)
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : null
  }
  return pick(explicit) ?? pick(projectDefault) ?? 2
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
  /** v1.0.468 — image-to-video motion intensity (1–4); see MOTION_SPECS.
   *  Drives the per-scene motion_prompt. Higher = livelier (still smooth,
   *  never fast). Default 2 (Gentle). */
  motion_level?: number
  /** v1.0.468 — when false, skip motion-prompt generation entirely (plan only
   *  produces visual prompts). Default true. */
  generate_motion_prompts?: boolean
  /** v1.0.242 — global style woven into every visual_prompt. */
  style_prompt?: string
  /** v1.0.242 — extra free-text planner instructions. */
  custom_instructions?: string
  /** continuity-chain density pacing — see ScenePlanRunOptions.pacing. */
  pacing?: { min_sec: number; max_sec: number; mode?: 'live' }
  /** v1.0.337 — % of scenes that feature the recurring guide character
   *  (continuity-chain). 0 = no guide at all; 100 = guide in every scene;
   *  ~40 (default) = selective. Drives the planner's cast guidance. */
  character_density?: number
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
  const detail = DETAIL_SPECS[opts.detail_level ?? 4] ?? DETAIL_SPECS[4]!

  // continuity-chain only: classify each scene so the renderer can keep the
  // guide character SELECTIVE. The explainer planner has no anchored character,
  // so it skips this field.
  const sceneTypeLine = opts.pacing
    ? `\n      "scene_type": "<one of: character | event | environment | map | artifact — see rule about the character>",`
    : ''
  const schemaBlock = `Output JSON schema:
{
  "scenes": [
    {
      "start_sec": <number>,
      "end_sec": <number>,
      "transcript_segment": "<verbatim text from the SRT for this window>",${sceneTypeLine}
      "visual_prompt": "<${detail.length} describing the still image — cover: ${detail.cover}>",
      "boundary_reason": "<short hint: why you chose this boundary>"
    }
  ]
}`

  // v1.0.337 — cast control. `character_density` (0–100) sets how often the
  // recurring guide appears: 0 = none (no on-screen character at all), 100 =
  // every scene (the pre-v1.0.336 behaviour), in between = selective.
  const density = Math.max(0, Math.min(100, Math.round(opts.character_density ?? 40)))
  const castIntro = density === 0
    ? 'This video has NO recurring on-screen character — a calm narrator speaks over imagery of the events, places, maps, and artifacts themselves.'
    : density >= 100
      ? 'There is ONE recurring GUIDE CHARACTER — a curious observer who travels through the story while a calm narrator explains what unfolds — and he appears in EVERY scene.'
      : 'There is ONE recurring GUIDE CHARACTER — a curious observer who travels through the story while a calm narrator explains what unfolds. The guide is a STORYTELLING DEVICE, not the subject of every shot: he appears SELECTIVELY so he stays special.'
  const castRule = density === 0
    ? `4. There is NO recurring guide character. Classify EVERY scene as one of "event" / "environment" / "map" / "artifact" (NEVER "character") — pick the one that best fits what the narration describes. Never show a recurring person-guide.`
    : density >= 100
      ? `4. Classify each scene with a "scene_type". The guide appears in EVERY scene, so set "scene_type" to "character" for all of them, and keep his appearance and wardrobe consistent across scenes.`
      : `4. CLASSIFY each scene with a "scene_type", and keep the guide SELECTIVE — he should appear in about ${density}% of scenes, and NEVER in two or three shots in a row while the narration is describing the event itself:
       • "character"   — the guide is on screen, reacting to or exploring the moment.
       • "event"       — the historical action/event itself, NO guide (soldiers marching, a ship in a storm, a treaty signed).
       • "environment" — a place or setting, NO guide (a city, a landscape, an interior).
       • "map"         — a map, route, or diagram, NO guide.
       • "artifact"    — a single object, document, or detail in focus, NO guide.
     Aim for about ${density}% character scenes; split the remaining ${100 - density}% across event (the largest share), then environment/map, then the occasional artifact. When the narration introduces an event, place, or object, CUT AWAY to it; bring the guide back to react a beat later.`

  // continuity-chain: a character-driven, live-paced planner. Scenes track the
  // action moment-to-moment and cut denser on busy passages.
  const system = opts.pacing
    ? `You are a video scene planner for a LIVE-paced video. ${castIntro} Each scene becomes ONE still image, and consecutive character images are rendered to flow into one another.

Rules:
  1. Pick scene boundaries that follow the ACTION and the speaker's beats: a new action, a new place, a new object handled, a shift in what's on screen.
  2. PACE FOR A LIVE FEEL. Every scene must be at least ${minSec} seconds and at most ${maxSec} seconds. Cut MORE often during busy, fast, or action-packed passages (multiple actions, list items, rapid delivery) — favour the SHORTER end of the range there. Hold longer (toward ${maxSec}s) only during slow, reflective, single-idea passages.
  3. Boundaries must align to actual cue start/end times from the SRT — don't invent timestamps that fall mid-cue.
${castRule}
  5. Write each scene's \`visual_prompt\` — ${detail.length}, cover: ${detail.cover}; descriptive and concrete, not a short caption; avoid vague filler like "an interesting image":
       • "character" scenes: describe the GUIDE performing the specific beat (what he's doing, holding, looking at), keeping his appearance and wardrobe consistent with the other character scenes.
       • every NON-character scene ("event" / "environment" / "map" / "artifact"): describe ONLY the subject of the shot. Do NOT mention, include, or imply the guide — no boy, no observer in frame.
  6. Return ONLY a JSON object. No prose, no markdown fences.

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
    // v1.0.499 — the style is prepended to the FRONT of every visual_prompt
    // deterministically after parsing (see the finalize pass in planScenes), so
    // the model doesn't need to restate it — asking a weak model to "weave it in"
    // just buried it at the end where image models under-apply it. Shown here as
    // context so scene content suits the style.
    userParts.push(
      `\nGLOBAL VISUAL STYLE (context only) — this exact clause is placed at the START of every scene's visual_prompt automatically, so DON'T restate it; just describe each scene's content (subject, action, setting, framing, lighting, mood) to suit this style:\n${style}`,
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
      return JSON.parse(sanitizeJsonControlChars(cleaned.slice(first, last + 1)))
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
    try { out.push(JSON.parse(sanitizeJsonControlChars(text.slice(objStart, j + 1)))) } catch { /* skip one bad object */ }
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
      scene_type: coerceSceneType(s.scene_type),
      approved: false,
    })
    prevEnd = end
  }
  // v1.0.522 — close INTERNAL GAPS by extending the previous scene's end to
  // the next scene's start. The overlap snap above only handled start <
  // prevEnd; a start > prevEnd (inter-cue silence, LLM boundary slop) used to
  // pass through, leaving seconds of narration with no scene — which
  // accumulated into visual drift and an early video end at assembly time.
  // Starts are never moved: they are the sync anchors on the audio timeline.
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.start_sec > out[i - 1]!.end_sec) {
      out[i - 1]!.end_sec = out[i]!.start_sec
    }
  }
  return out
}

// ── Audio-coverage safeguard (v1.0.522) ────────────────────────────────────
// "Every second of narration must have a scene." These pure helpers are the
// single source of truth for coverage math, shared by: plan generation
// (prevention), the repair-coverage route (healing existing plans), and both
// assemblers' render gates (loud failure past the tolerance).

/** Gaps smaller than this are float/cue-rounding noise, not real coverage holes. */
export const COVERAGE_NOISE_SEC = 0.05
/** Render gate: total uncovered narration above this fails the assembly (user
 *  policy: strict — no silent black frames, no frozen tails, no dropped audio). */
export const COVERAGE_FAIL_SEC = 2

export interface PlanCoverage {
  headGapSec: number
  internalGaps: Array<{ afterSceneId: string; afterIndex: number; gapSec: number }>
  internalGapTotalSec: number
  tailGapSec: number
  uncoveredTotalSec: number
}

export interface ScenePlanCoverageIntegrity {
  /** False for legacy plans that do not carry enough timing metadata to audit. */
  authoritative: boolean
  complete: boolean
  headCovered: boolean
  blockingUncoveredSec: number
  coverage: PlanCoverage | null
  reason?: 'missing-duration' | 'invalid-timing' | 'coverage-gap'
}

/**
 * Measure how much of the narration audio the plan's scenes do NOT cover:
 * before the first scene (head), between consecutive scenes (internal), and
 * after the last scene (tail). Scenes are assumed to be in timeline order
 * (they are — the planner emits them ordered and scene_index is 1-based).
 */
export function computePlanCoverage(
  scenes: Array<Pick<ScenePlanEntry, 'id' | 'start_sec' | 'end_sec'>>,
  audioDurationSec: number,
): PlanCoverage {
  const clean = (n: number) => (n > COVERAGE_NOISE_SEC ? n : 0)
  if (!scenes.length) {
    const all = clean(Math.max(0, audioDurationSec))
    return { headGapSec: all, internalGaps: [], internalGapTotalSec: 0, tailGapSec: 0, uncoveredTotalSec: all }
  }
  const headGapSec = clean(Math.max(0, scenes[0]!.start_sec))
  const internalGaps: PlanCoverage['internalGaps'] = []
  for (let i = 0; i < scenes.length - 1; i++) {
    const gap = clean(scenes[i + 1]!.start_sec - scenes[i]!.end_sec)
    if (gap > 0) internalGaps.push({ afterSceneId: scenes[i]!.id, afterIndex: i, gapSec: gap })
  }
  const internalGapTotalSec = internalGaps.reduce((s, g) => s + g.gapSec, 0)
  const tailGapSec = clean(Math.max(0, audioDurationSec - scenes[scenes.length - 1]!.end_sec))
  return {
    headGapSec,
    internalGaps,
    internalGapTotalSec,
    tailGapSec,
    uncoveredTotalSec: headGapSec + internalGapTotalSec + tailGapSec,
  }
}

/**
 * Completion-level coverage check shared by Scene Plan status and its UI.
 * A branded opening deliberately owns the time before scene 1, so that head
 * interval is not a missing scene. Older plans did not persist opening_mode;
 * a >2s initial gap is treated as their legacy reserved opening rather than
 * making every previously valid branded-opening episode pending forever.
 */
export function inspectScenePlanCoverage(
  plan: {
    scenes: Array<Pick<ScenePlanEntry, 'id' | 'start_sec' | 'end_sec'>>
    total_duration_sec?: number
    opening_mode?: 'branded-opening' | 'from-start'
  },
  options: { headCovered?: boolean } = {},
): ScenePlanCoverageIntegrity {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : []
  const totalDurationSec = Number(plan?.total_duration_sec)
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) {
    return {
      authoritative: false,
      complete: true,
      headCovered: false,
      blockingUncoveredSec: 0,
      coverage: null,
      reason: 'missing-duration',
    }
  }
  if (!scenes.length || scenes.some(scene =>
    !Number.isFinite(Number(scene?.start_sec))
    || !Number.isFinite(Number(scene?.end_sec))
    || Number(scene.end_sec) <= Number(scene.start_sec),
  )) {
    return {
      authoritative: true,
      complete: false,
      headCovered: false,
      blockingUncoveredSec: totalDurationSec,
      coverage: null,
      reason: 'invalid-timing',
    }
  }

  const coverage = computePlanCoverage(scenes, totalDurationSec)
  const headCovered = typeof options.headCovered === 'boolean'
    ? options.headCovered
    : plan.opening_mode === 'branded-opening'
      || (plan.opening_mode == null && coverage.headGapSec > COVERAGE_FAIL_SEC)
  const blockingUncoveredSec = coverage.internalGapTotalSec
    + coverage.tailGapSec
    + (headCovered ? 0 : coverage.headGapSec)
  const complete = blockingUncoveredSec <= COVERAGE_FAIL_SEC
  return {
    authoritative: true,
    complete,
    headCovered,
    blockingUncoveredSec,
    coverage,
    reason: complete ? undefined : 'coverage-gap',
  }
}

/**
 * Heal a plan to full coverage (returns a new array of shallow-copied scenes;
 * input untouched):
 *   - every internal gap: the PRECEDING scene's end_sec extends to the next
 *     scene's start_sec (starts never move — they anchor narration sync),
 *   - tail: the last scene's end_sec extends to the real audio duration,
 *   - head: the first scene's start_sec is pulled to 0 only when the gap is
 *     ≤ COVERAGE_FAIL_SEC (lead-in noise). A larger head gap is left alone —
 *     it's either an intentional intro-skip (covered by a title card in the
 *     rich assembler) or a real problem the render gate reports loudly.
 * Returns human-readable change lines for job logs / toasts.
 */
export function repairPlanCoverage(
  scenes: ScenePlanEntry[],
  audioDurationSec: number,
): { scenes: ScenePlanEntry[]; changes: string[]; coverageBefore: PlanCoverage } {
  const coverageBefore = computePlanCoverage(scenes, audioDurationSec)
  const out = scenes.map(s => ({ ...s }))
  const changes: string[] = []
  if (!out.length) return { scenes: out, changes, coverageBefore }

  if (coverageBefore.headGapSec > 0 && coverageBefore.headGapSec <= COVERAGE_FAIL_SEC) {
    changes.push(`Scene 1 start pulled ${coverageBefore.headGapSec.toFixed(2)}s back to 0:00 (lead-in).`)
    out[0]!.start_sec = 0
  }
  let closed = 0
  let closedSec = 0
  for (const g of coverageBefore.internalGaps) {
    out[g.afterIndex]!.end_sec = out[g.afterIndex + 1]!.start_sec
    closed++
    closedSec += g.gapSec
  }
  if (closed > 0) {
    changes.push(`Closed ${closed} gap(s) between scenes (${closedSec.toFixed(1)}s) by holding each preceding scene.`)
  }
  if (coverageBefore.tailGapSec > 0) {
    const last = out[out.length - 1]!
    last.end_sec = audioDurationSec
    changes.push(
      `Extended final scene by ${coverageBefore.tailGapSec.toFixed(1)}s to the real audio end (${audioDurationSec.toFixed(1)}s)` +
      (coverageBefore.tailGapSec > 30
        ? ` — ⚠ that's a long hold on one image; review it in Scene Review or split it into more scenes.`
        : '.'),
    )
  }
  return { scenes: out, changes, coverageBefore }
}

// ── Reconcile plan timings to the current subtitles (v1.0.523) ──────────────
// When the audio is re-generated / re-stitched AFTER a plan was made (e.g.
// files added, an intro chapter dropped), the plan's start/end become stale —
// the scenes drift out of sync with the voice (measured: a uniform 28s shift
// on brain-wise EP0022/24 after the intro-skip offset changed). Re-anchor each
// existing scene to WHERE ITS NARRATION ACTUALLY IS NOW by text-matching its
// transcript_segment against the current stitched-SRT cues — preserving every
// scene id, image, and prompt (no re-plan, no forfeited images).

/** Normalize a chunk of narration to comparable word tokens (lowercase,
 *  alphanumeric-only, whitespace-collapsed). */
function normalizeWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export interface ReconcileResult {
  scenes: ScenePlanEntry[]
  matchedCount: number
  unmatchedIds: string[]
  /** Median start-time delta (newStart − oldStart) across matched scenes — the
   *  effective shift, for the summary line. */
  medianShiftSec: number
  changes: string[]
}

/**
 * Re-anchor a plan's scene timings to the current stitched-SRT cues by
 * matching each scene's transcript_segment text, in order. Starts come from
 * the matched cue; ends are made contiguous (end = next scene's start; the
 * last scene ends at the audio/SRT end) so the result is gap-free and fully
 * covering by construction. Scenes whose text can't be found are linearly
 * interpolated between their matched neighbours (and reported). Pure: input
 * scenes are untouched; a new array is returned.
 */
export function reconcilePlanToSubtitles(
  scenes: ScenePlanEntry[],
  cues: SrtCue[],
  audioDurationSec?: number,
): ReconcileResult {
  const out = scenes.map(s => ({ ...s }))
  const changes: string[] = []
  if (!out.length || !cues.length) {
    return { scenes: out, matchedCount: 0, unmatchedIds: out.map(s => s.id), medianShiftSec: 0, changes }
  }

  // Flatten cues → per-word timing stream (each word carries its cue's window).
  const words: Array<{ w: string; start: number; end: number }> = []
  for (const c of cues) {
    for (const w of normalizeWords(c.text)) words.push({ w, start: c.start_sec, end: c.end_sec })
  }
  const srtEnd = cues[cues.length - 1]!.end_sec
  const timelineEnd = (typeof audioDurationSec === 'number' && audioDurationSec > srtEnd)
    ? audioDurationSec
    : srtEnd

  const ANCHOR = 6          // opening words used to locate a scene
  const MATCH_RATIO = 0.6   // tolerate minor narration/SRT wording drift
  const newStart: Array<number | null> = new Array(out.length).fill(null)
  let cursor = 0
  const shifts: number[] = []

  for (let i = 0; i < out.length; i++) {
    const anchor = normalizeWords(out[i]!.transcript_segment).slice(0, ANCHOR)
    if (!anchor.length) continue   // no text → interpolate later
    const need = Math.max(1, Math.ceil(anchor.length * MATCH_RATIO))
    let found = -1
    for (let p = cursor; p <= words.length - 1; p++) {
      let score = 0
      for (let j = 0; j < anchor.length && p + j < words.length; j++) {
        if (words[p + j]!.w === anchor[j]) score++
      }
      if (score >= need) { found = p; break }
    }
    if (found >= 0) {
      newStart[i] = words[found]!.start
      shifts.push(words[found]!.start - out[i]!.start_sec)
      cursor = found + 1   // next scene must start later in the stream
    }
  }

  // Interpolate any scene we couldn't match, between its matched neighbours.
  const unmatchedIds: string[] = []
  for (let i = 0; i < out.length; i++) {
    if (newStart[i] != null) continue
    unmatchedIds.push(out[i]!.id)
    let lo = i - 1; while (lo >= 0 && newStart[lo] == null) lo--
    let hi = i + 1; while (hi < out.length && newStart[hi] == null) hi++
    const loT = lo >= 0 ? newStart[lo]! : 0
    const hiT = hi < out.length ? newStart[hi]! : timelineEnd
    const span = (hi < out.length ? hi : out.length) - (lo >= 0 ? lo : -1)
    const step = (hiT - loT) / Math.max(1, span)
    newStart[i] = loT + step * (i - (lo >= 0 ? lo : -1))
  }

  // Enforce monotonic non-decreasing starts, then derive contiguous ends.
  for (let i = 1; i < out.length; i++) {
    if (newStart[i]! < newStart[i - 1]!) newStart[i] = newStart[i - 1]!
  }
  for (let i = 0; i < out.length; i++) {
    out[i]!.start_sec = Math.max(0, newStart[i]!)
    out[i]!.end_sec = i < out.length - 1 ? Math.max(newStart[i]!, newStart[i + 1]!) : timelineEnd
  }

  shifts.sort((a, b) => a - b)
  const medianShiftSec = shifts.length ? shifts[Math.floor(shifts.length / 2)]! : 0
  const matchedCount = out.length - unmatchedIds.length
  changes.push(
    `Re-anchored ${matchedCount}/${out.length} scene(s) to the current subtitles` +
    (Math.abs(medianShiftSec) >= 0.5 ? ` (median shift ${medianShiftSec > 0 ? '+' : ''}${medianShiftSec.toFixed(1)}s)` : '') +
    `; scene 1 now starts at ${out[0]!.start_sec.toFixed(1)}s, last scene ends at ${out[out.length - 1]!.end_sec.toFixed(1)}s.`,
  )
  if (unmatchedIds.length) {
    changes.push(`⚠ ${unmatchedIds.length} scene(s) had no matching subtitle text and were interpolated — spot-check them in Scene Review.`)
  }
  return { scenes: out, matchedCount, unmatchedIds, medianShiftSec, changes }
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
      // v1.0.515 — only the FIRST split part keeps the source prompt. Children
      // used to inherit it verbatim, so an over-long LLM scene chopped into N
      // parts rendered N IDENTICAL images back-to-back (EP0012: scenes 95–116,
      // 22 copies of one prompt). Children start empty and are filled from
      // their own transcripts by the post-plan regen pass in planScenes.
      visual_prompt: out.length === 0 ? scene.visual_prompt : '',
      rendered_prompt: undefined,
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
  // For continuity, anchor on the first CHARACTER scene (the guide's
  // establishing look) so he stays consistent across the seam even when the
  // immediately-preceding scenes were character-free cutaways.
  const charAnchor = live ? withVisual.find(s => !s.scene_type || s.scene_type === 'character') : undefined
  const anchor = (charAnchor || withVisual[0]!).visual_prompt.trim()
  const recent = withVisual.slice(-5)
  const recentLines = recent.map(s => `  • [${s.start_sec.toFixed(0)}s]${s.scene_type ? ` (${s.scene_type})` : ''} ${s.visual_prompt.trim()}`)
  const rule = live
    ? 'CONTINUITY: this is one continuous character-driven video with ONE recurring guide character who appears SELECTIVELY — only in "character" scenes. In "character" scenes, keep the SAME guide (face, age, hair, wardrobe) and the established setting consistent with the character scenes already planned below; do not restyle or re-introduce him. In non-character scenes (event / environment / map / artifact), do NOT include the guide at all.'
    : 'CONTINUITY: keep the visual style, recurring subjects, and setting consistent with the scenes already planned below; don\'t contradict or re-introduce what\'s already established.'
  return [
    rule,
    `Establishing shot (from segment 1): ${anchor}`,
    'Most recent scenes already planned (the LAST one is immediately before your first scene — continue smoothly from it):',
    ...recentLines,
  ].join('\n')
}

/**
 * v1.0.291 — deterministic scene split (no LLM). Walks the SRT cues left
 * to right, groups them into scenes targeting `target_sec` seconds each,
 * snaps boundaries to cue ends so we never mid-sentence-cut, and respects
 * the user's `[min_sec, max_sec]` pacing band.
 *
 * Why this exists: the historical single-pass planner asked the LLM to
 * produce both scene boundaries AND visual prompts as structured JSON.
 * On smaller local models the JSON requirement fails routinely and the
 * planner's fallback subdivides into empty-prompt placeholders. Two-pass
 * mode (v1.0.291) decouples the two concerns — this function does the
 * boundary work deterministically (always succeeds, zero LLM calls),
 * then a second pass generates prompts as plain prose (one LLM call per
 * scene, no JSON to fail at).
 *
 * Algorithm:
 *   1. Iterate cues. Accumulate text + advance the candidate end_sec.
 *   2. When duration >= target_sec, close the scene at the current cue's
 *      end. The next scene starts where this one ends.
 *   3. Enforce min/max: if the trailing scene would be < min_sec, merge
 *      it backward into the previous one. If a scene would exceed max_sec
 *      (single huge cue), accept it anyway — splitting mid-cue isn't safe.
 *
 * Returns scenes with empty `visual_prompt` strings — pass 2 fills those in.
 */
export function splitScenesDeterministically(opts: {
  cues: SrtCue[]
  /** Target scene duration (seconds). Used as the "close scene when we
   *  hit this" trigger. Defaults to (min+max)/2 if not provided. */
  target_sec?: number
  /** Minimum scene duration. Tiny trailing scenes get merged backward. */
  min_sec?: number
  /** Maximum scene duration. Scenes that would exceed this are accepted
   *  anyway (no mid-cue splitting), but we log the over-long case. */
  max_sec?: number
  /** First scene's `start_sec`. Defaults to the first cue's start, or 0. */
  initial_start_sec?: number
  /** Scene IDs are stable across re-plans; provide a generator. Defaults
   *  to incrementing 'scene-1', 'scene-2', ... */
  idGen?: (i: number) => string
}): ScenePlanEntry[] {
  if (!opts.cues.length) return []
  const minSec = opts.min_sec ?? MIN_SCENE_SEC
  const maxSec = opts.max_sec ?? MAX_SCENE_SEC
  const targetSec = Math.max(minSec, Math.min(maxSec, opts.target_sec ?? (minSec + maxSec) / 2))
  const idGen = opts.idGen || ((i: number) => `scene-${i + 1}`)

  const scenes: ScenePlanEntry[] = []
  let bucketStart = opts.initial_start_sec ?? opts.cues[0]!.start_sec
  let bucketCues: SrtCue[] = []

  function emitBucket() {
    if (!bucketCues.length) return
    const start = bucketStart
    const end = bucketCues[bucketCues.length - 1]!.end_sec
    const text = bucketCues.map(c => c.text.trim()).filter(Boolean).join(' ')
    scenes.push({
      id: idGen(scenes.length),
      scene_index: scenes.length + 1,
      start_sec: start,
      end_sec: end,
      transcript_segment: text,
      visual_prompt: '',
      boundary_reason: 'deterministic split (cue-aligned)',
    })
    bucketCues = []
    bucketStart = end
  }

  for (const cue of opts.cues) {
    bucketCues.push(cue)
    const durSoFar = cue.end_sec - bucketStart
    if (durSoFar >= targetSec) {
      emitBucket()
    }
  }
  // Tail bucket — emit if it has content.
  if (bucketCues.length) emitBucket()

  // Post-pass: tiny trailing scenes get merged backward into their
  // predecessor. min_sec enforcement after the fact is cheaper than
  // trying to predict during the walk.
  for (let i = scenes.length - 1; i > 0; i--) {
    const cur = scenes[i]!
    if ((cur.end_sec - cur.start_sec) < minSec) {
      const prev = scenes[i - 1]!
      // Merge cur into prev — extend prev's end + concat transcript.
      prev.end_sec = cur.end_sec
      prev.transcript_segment = (prev.transcript_segment + ' ' + cur.transcript_segment).trim()
      scenes.splice(i, 1)
    }
  }
  // Renumber after any merges.
  scenes.forEach((s, i) => { s.scene_index = i + 1 })

  return scenes
}

export interface RepairOverlongScenesResult {
  scenes: ScenePlanEntry[]
  repairedCount: number
  addedCount: number
  repairedIds: string[]
}

/**
 * Replace only abnormally long scenes with deterministic cue-aligned parts.
 * The first part keeps the original scene id and generated media; new parts
 * start without prompts/media so existing work elsewhere in the episode is
 * never disturbed. This is the safe repair after missing chapter subtitles
 * have been restored and re-stitched.
 */
export function repairOverlongScenesDeterministically(opts: {
  scenes: ScenePlanEntry[]
  cues: SrtCue[]
  threshold_sec?: number
  min_sec?: number
  max_sec?: number
}): RepairOverlongScenesResult {
  const thresholdSec = Math.max(1, opts.threshold_sec ?? 20)
  const minSec = Math.max(1, opts.min_sec ?? MIN_SCENE_SEC)
  const maxSec = Math.max(minSec, opts.max_sec ?? MAX_SCENE_SEC)
  const repairedIds: string[] = []
  const result: ScenePlanEntry[] = []

  for (const scene of opts.scenes) {
    if (scene.end_sec - scene.start_sec <= thresholdSec) {
      result.push({ ...scene })
      continue
    }
    const cues = opts.cues.filter(cue =>
      cue.end_sec > scene.start_sec + 0.01 && cue.start_sec < scene.end_sec - 0.01,
    )
    if (cues.length < 2) {
      result.push({ ...scene })
      continue
    }
    const parts = splitScenesDeterministically({
      cues,
      min_sec: minSec,
      max_sec: maxSec,
      target_sec: (minSec + maxSec) / 2,
      initial_start_sec: scene.start_sec,
      idGen: index => index === 0 ? scene.id : freshId(),
    })
    if (parts.length < 2) {
      result.push({ ...scene })
      continue
    }

    parts[parts.length - 1]!.end_sec = scene.end_sec
    parts.forEach((part, index) => {
      if (index === 0) {
        result.push({ ...scene, ...part, id: scene.id, visual_prompt: scene.visual_prompt })
        return
      }
      result.push({
        ...scene,
        ...part,
        visual_prompt: '',
        visual_prompt_raw: undefined,
        motion_prompt: undefined,
        approved: false,
        image_path: undefined,
        rendered_prompt: undefined,
        image_version: undefined,
        clip_path: undefined,
        rendered_motion_prompt: undefined,
        clip_source_image_version: undefined,
        motion_choice: undefined,
        boundary_reason: 'deterministic repair (restored subtitle cues)',
      })
    })
    repairedIds.push(scene.id)
  }

  result.forEach((scene, index) => { scene.scene_index = index + 1 })
  return {
    scenes: result,
    repairedCount: repairedIds.length,
    addedCount: Math.max(0, result.length - opts.scenes.length),
    repairedIds,
  }
}

export interface CueAwareCoverageRepairResult {
  scenes: ScenePlanEntry[]
  changes: string[]
  coverageBefore: PlanCoverage
  coverageAfter: PlanCoverage
  repairedLongSceneCount: number
  addedSceneCount: number
}

/**
 * Heal missing timeline coverage without turning a missing narrated range into
 * one frozen image. The basic coverage repair first makes the range explicit;
 * complete subtitle cues then divide every abnormal hold into deterministic
 * scene-sized parts. Existing assets stay on the first part and only newly
 * restored parts become pending.
 */
export function repairPlanCoverageWithSubtitleCues(opts: {
  scenes: ScenePlanEntry[]
  cues: SrtCue[]
  audioDurationSec: number
  threshold_sec?: number
  min_sec?: number
  max_sec?: number
}): CueAwareCoverageRepairResult {
  const coverageRepair = repairPlanCoverage(opts.scenes, opts.audioDurationSec)
  const longRepair = repairOverlongScenesDeterministically({
    scenes: coverageRepair.scenes,
    cues: opts.cues,
    threshold_sec: opts.threshold_sec,
    min_sec: opts.min_sec,
    max_sec: opts.max_sec,
  })
  const changes = [...coverageRepair.changes]
  if (longRepair.repairedCount) {
    changes.push(
      `Restored ${longRepair.addedCount} cue-aligned scene(s) inside ` +
      `${longRepair.repairedCount} abnormal long narrated range(s); new scenes need visual prompts and images.`,
    )
  }
  return {
    scenes: longRepair.scenes,
    changes,
    coverageBefore: coverageRepair.coverageBefore,
    coverageAfter: computePlanCoverage(longRepair.scenes, opts.audioDurationSec),
    repairedLongSceneCount: longRepair.repairedCount,
    addedSceneCount: longRepair.addedCount,
  }
}

/**
 * v1.0.458 — shared per-scene visual-prompt generator. Fans the work out
 * across the LM Studio endpoint pool (concurrency = pool size) and RETRIES
 * transient failures before giving up, so a brief local-model disconnect no
 * longer leaves a scene permanently empty. Mutates `scenes[i].visual_prompt`
 * in place for every index in `targetIndices`.
 *
 * Used by both the two-pass planner (targets = every scene) and the bulk
 * "regen empty prompts" job (targets = just the empties). Scenes NOT in the
 * target set keep their existing prompt and act as back-context, so a bulk
 * regen reads cohesion from the prompts that already landed.
 *
 * Returns the number of target scenes still empty after all retries.
 */
export async function generatePromptsForScenes(
  scenes: ScenePlanEntry[],
  targetIndices: number[],
  ctx: {
    model: string
    detail_level?: number
    style_prompt?: string
    custom_instructions?: string
    creative_direction?: Partial<SceneCreativeDirection>
    neighbor_context_back?: number
    neighbor_context_forward?: number
    apiKeys: { anthropic_api_key: string; openai_api_key: string; kie_api_key: string }
    slug?: string
    /** Local-only retries per scene on a thrown error OR an empty result.
     * Default 2 (→ up to 3 attempts). Cloud/API models always make one call. */
    max_retries?: number
    /** Cooperative cancel — polled between chunks so a user-cancelled job
     *  stops promptly instead of churning through every remaining scene. */
    should_cancel?: () => boolean
    onProgress?: (done: number, total: number) => void
    onWarn?: (msg: string) => void
    /** Called after one prompt is generated. Resolve only after it is durable. */
    onResult?: (sceneIndex: number, prompt: string) => Promise<void>
  },
): Promise<number> {
  if (!targetIndices.length) return 0
  const back = Math.max(0, Math.min(10, ctx.neighbor_context_back ?? 2))
  const forward = Math.max(0, Math.min(10, ctx.neighbor_context_forward ?? 1))
  // A retry creates a second generation request. That is safe for our local
  // Chat Studio fleet, but cloud/API models must remain one-shot so a timeout
  // cannot silently spend again.
  const maxRetries = isLocalTextModel(ctx.model) ? Math.max(0, ctx.max_retries ?? 2) : 0

  // Derive concurrency from the Chat Studio pool size when the model is local.
  // Cloud models stay sequential (no pool to spread across; cloud rate-limits
  // make free parallelism risky). Single-endpoint Chat Studio also stays at 1.
  // v1.0.497 — Chat Studio's cloud-PROXIED models (chatstudio:provider:*) also
  // stay sequential: every endpoint proxies the same upstream free tier, so
  // fanning out across the pool just multiplies 429s.
  const isChatstudioCloudProxy = ctx.model.startsWith(`${CHATSTUDIO_MODEL_PREFIX}provider:`)
  let concurrency = 1
  if (ctx.model.startsWith(CHATSTUDIO_MODEL_PREFIX) && !isChatstudioCloudProxy) {
    const csStored = await getApiKey('chatstudio').catch(() => '')
    // Clear stale "marked down" state so endpoints that recovered since the
    // last connection error get a fair retry at the start of this workload.
    resetChatstudioDispatcher(csStored)
    concurrency = Math.max(1, parseEndpoints(csStored).length)
    if (concurrency > 1) {
      ctx.onWarn?.(
        `Generating ${targetIndices.length} prompt(s) ${concurrency}× parallel across `
        + `${concurrency} Chat Studio endpoints (assuming each has the model loaded).`,
      )
    }
  }

  let failed = 0
  let done = 0
  // Windowed parallel: process the target indices in chunks of `concurrency`.
  // Within a chunk, scenes run in parallel and DON'T see each other's prompts
  // (the cohesion trade-off); chunks run sequentially so every prompt resolved
  // in earlier chunks is available as back-context. concurrency=1 degrades to
  // strict-sequential — byte-for-byte the historical path.
  for (let chunkStart = 0; chunkStart < targetIndices.length; chunkStart += concurrency) {
    if (ctx.should_cancel?.()) break
    const chunk = targetIndices.slice(chunkStart, chunkStart + concurrency)
    const inFlight = new Set(chunk)
    const tasks = chunk.map(i => (async () => {
      const scene = scenes[i]!
      // Back-context: nearest prior scenes that already have a prompt
      // (resolved earlier or pre-existing), EXCLUDING scenes generating
      // concurrently in this chunk — they aren't visible to each other yet.
      const prevPrompts: string[] = []
      for (let j = Math.max(0, i - back); j < i; j++) {
        if (inFlight.has(j)) continue
        const p = scenes[j]?.visual_prompt
        if (p && p.trim()) prevPrompts.push(p)
      }
      // Forward context uses transcripts, so it never depends on prompt
      // resolution order.
      const nextTranscripts: string[] = []
      for (let j = i + 1; j <= Math.min(scenes.length - 1, i + forward); j++) {
        const t = scenes[j]?.transcript_segment
        if (t && t.trim()) nextTranscripts.push(t)
      }

      let lastErr: any = null
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let prompt = ''
        try {
          prompt = await generateVisualPromptOnly({
            transcript_segment: scene.transcript_segment,
            model: ctx.model,
            detail_level: ctx.detail_level,
            style_prompt: ctx.style_prompt,
            custom_instructions: ctx.custom_instructions,
            creative_direction: ctx.creative_direction,
            creative_strategy: scene.creative_strategy,
            apiKeys: ctx.apiKeys,
            slug: ctx.slug,
            prev_visual_prompts: prevPrompts,
            next_transcript_segments: nextTranscripts,
          })
        } catch (e: any) {
          lastErr = e
        }
        if (prompt && prompt.trim()) {
          scene.visual_prompt = prompt
          // Persistence is outside the provider try/catch. A disk failure must
          // stop loudly, never spend another model request for valid output.
          await ctx.onResult?.(i, prompt)
          return
        }
        if (!lastErr) lastErr = new Error('model returned an empty prompt')
        if (attempt < maxRetries) {
          ctx.onWarn?.(
            `Scene #${i + 1}: prompt attempt ${attempt + 1}/${maxRetries + 1} failed `
            + `(${lastErr?.message || 'unknown'}) — retrying…`,
          )
          // Short backoff so a momentarily-down local endpoint has time to wake.
          const rateLimited = /rate.?limit|\b429\b/i.test(String(lastErr?.message || ''))
          const backoffMs = rateLimited ? Math.min(45_000, 15_000 * (attempt + 1)) : 1200 * (attempt + 1)
          if (rateLimited) {
            ctx.onWarn?.(`Scene #${i + 1}: provider rate-limited — waiting ${Math.round(backoffMs / 1000)}s before retrying.`)
          }
          await new Promise(r => setTimeout(r, backoffMs))
        }
      }
      failed++
      ctx.onWarn?.(
        `Scene #${i + 1}: prompt failed after ${maxRetries + 1} attempt(s) `
        + `(${lastErr?.message || 'unknown'}) — left empty for manual fill / bulk regen.`,
      )
    })())
    await Promise.all(tasks)
    done += chunk.length
    ctx.onProgress?.(done, targetIndices.length)
  }
  return failed
}

/**
 * v1.0.499 — put the art style FIRST. Image models (and CLIP-style text
 * encoders) weight leading tokens far more than trailing ones, so a style
 * clause buried at the end of the description gets under-applied — especially
 * by smaller / local models. We prepend the exact style clause to the front of
 * the scene description rather than relying on the LLM to "weave it in". No-op
 * when there's no style, and skips prepending if the description already opens
 * with the style (so a model that restated it doesn't double it up).
 */
export function leadWithStyle(description: string, style: string | undefined): string {
  const desc = (description || '').trim()
  const st = (style || '').trim()
  if (!st) return desc
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const stKey = norm(st).slice(0, 40)
  if (stKey && norm(desc).startsWith(stKey)) return desc   // already leads with it
  const sep = /[.!?…,;:]$/.test(st) ? '' : '.'
  return `${st}${sep} ${desc}`
}

/**
 * v1.0.288 — generate JUST the `visual_prompt` for a single scene, without
 * touching its time boundaries or transcript. Returns the prompt as a
 * plain string — no JSON, no structure.
 *
 * Why this exists: the full `planScenes` call asks the LLM for structured
 * JSON with scene boundaries + transcript_segment + visual_prompt per
 * scene. Smaller local models (gemma-4-e4b and similar 4B-param models)
 * routinely fail that JSON output — truncation, malformed escapes,
 * prose-where-JSON-was-expected — and the user ends up with empty
 * `visual_prompt` strings after the planner's salvage logic gives up.
 *
 * Prompt-only regeneration sidesteps the JSON problem entirely: the
 * system prompt asks for a SINGLE prose description, and the model just
 * has to write one paragraph. Even constrained local models do this
 * reliably. The output replaces only `scene.visual_prompt`; every other
 * field (start_sec, end_sec, transcript_segment, boundary_reason, id) is
 * untouched.
 */
export async function generateVisualPromptOnly(opts: {
  transcript_segment: string
  model: string
  detail_level?: number
  style_prompt?: string
  custom_instructions?: string
  creative_direction?: Partial<SceneCreativeDirection>
  creative_strategy?: SceneCreativeStrategy
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  slug?: string
  /**
   * v1.0.291 — optional neighbor context for the two-pass planner. The
   * model sees the previous N scenes' visual prompts (for continuity —
   * "what should look the same?") and the next N scenes' transcript
   * segments (for setup — "what's the upcoming beat I'm establishing?").
   * Omitted entirely on per-scene Re-Plan calls from the v1.0.288 path
   * (which kept zero neighbor context for simplicity).
   */
  prev_visual_prompts?: string[]
  next_transcript_segments?: string[]
}): Promise<string> {
  const detail = DETAIL_SPECS[opts.detail_level ?? 4] || DETAIL_SPECS[4]!
  const sysParts: string[] = [
    'You write a single visual scene description for an AI image generator.',
    'Output ONLY the description as natural prose. No JSON, no labels, no quotes, no preamble, no "Here is the description:" — just the description itself.',
    `Length: ${detail.length}.`,
    `Cover: ${detail.cover}.`,
  ]
  // v1.0.499 — the art style is prepended to the FRONT of the final prompt
  // deterministically (see leadWithStyle below), so the model doesn't need to
  // restate it — that only risks a weak model burying it mid-sentence where
  // image models under-apply it. We still SHOW it as context so the model picks
  // scene details that suit the style.
  const styleForLead = opts.style_prompt?.trim() || ''
  if (styleForLead) {
    sysParts.push(
      `ART STYLE / MEDIUM (context only): "${styleForLead}". This exact clause is placed automatically at the START of the final prompt, so do NOT restate the style — just describe the scene content (subject, action, setting, framing, lighting, mood) in a way that suits that style.`,
    )
  }
  if (opts.custom_instructions && opts.custom_instructions.trim()) {
    sysParts.push(`Additional rules: ${opts.custom_instructions.trim()}`)
  }
  if (opts.creative_direction) {
    sysParts.push(buildCreativeDirectionPrompt(opts.creative_direction))
  }
  if (opts.creative_strategy) {
    sysParts.push(
      `ASSIGNED VISUAL STRATEGY - ${opts.creative_strategy}: ${CREATIVE_STRATEGY_INSTRUCTIONS[opts.creative_strategy]} `
      + 'Follow this strategy for this scene. Do not print the strategy name or explain your choice.',
    )
  }
  // v1.0.291 — when neighbor context is provided, add a continuity
  // instruction so the model knows to flow from what came before and set
  // up what's next. Without this, the model treats each scene as fully
  // standalone and visual style drifts across scenes.
  const hasNeighbors = (opts.prev_visual_prompts && opts.prev_visual_prompts.length > 0)
    || (opts.next_transcript_segments && opts.next_transcript_segments.length > 0)
  if (hasNeighbors) {
    sysParts.push(
      'CONTINUITY: this scene is part of a longer video. Keep the recurring subject(s), '
      + 'setting, and visual style consistent with the previous scene(s) shown below — '
      + 'do not restyle, do not re-introduce characters from scratch. Frame this scene '
      + 'as a natural beat between what just happened and what\'s coming.',
    )
  }
  const system = sysParts.join('\n\n')

  // User-message sections: prev prompts → upcoming transcripts → THIS
  // scene's transcript → instruction. Order matters: putting THIS scene
  // last keeps it freshest in the model's attention while still giving
  // the surrounding context to anchor against.
  const userParts: string[] = []
  if (opts.prev_visual_prompts && opts.prev_visual_prompts.length > 0) {
    const lines = opts.prev_visual_prompts.map((p, i) => `  ${i + 1}. ${p.trim()}`).join('\n')
    userParts.push(`Previous scene(s), most recent last:\n${lines}`)
  }
  if (opts.next_transcript_segments && opts.next_transcript_segments.length > 0) {
    const lines = opts.next_transcript_segments.map((t, i) => `  ${i + 1}. ${t.trim()}`).join('\n')
    userParts.push(`Upcoming scene transcript(s) (don't write for them — just so you know what's coming):\n${lines}`)
  }
  userParts.push(`Narration excerpt for THIS scene:\n${opts.transcript_segment.trim()}`)
  userParts.push('Write the visual scene description (single paragraph, no quotes):')
  const user = userParts.join('\n\n')

  const raw = await callAi(opts.model, system, user, opts.apiKeys, false, { slug: opts.slug })
  // Defensive clean-up: even with explicit instructions, models sometimes
  // wrap the output in quotes, code fences, or add a "Description:" prefix.
  // Strip those so the user sees clean prose in the editor.
  let cleaned = (raw || '').trim()
  // Strip ```...``` fences
  cleaned = cleaned.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  // Strip leading "Description:" / "Visual prompt:" labels
  cleaned = cleaned.replace(/^(visual\s*prompt|visual\s*description|scene\s*description|description|prompt)\s*[:\-]\s*/i, '').trim()
  // Strip surrounding quotes (smart + straight)
  cleaned = cleaned.replace(/^["'`“‘]+|["'`”’]+$/g, '').trim()
  // v1.0.499 — front-load the art style so image models apply it reliably.
  return leadWithStyle(cleaned, styleForLead)
}

/**
 * v1.0.468 — generate the image-to-video MOTION prompt for a single scene.
 *
 * Cohesive-by-construction: it's seeded with the scene's already-written
 * `visual_prompt` (the exact image it will animate) plus the narration, so the
 * motion always matches what's on screen — a character only "walks/points" if
 * the image depicts one. The `motion_level` (1–4, see MOTION_SPECS) controls
 * how lively the movement is; every level stays slow and smooth (no fast/
 * frantic motion). Returns a SHORT instruction (one or two sentences) as plain
 * prose — model-agnostic, ready to feed any i2v model alongside the start image.
 */
export async function generateMotionPromptOnly(opts: {
  transcript_segment: string
  visual_prompt: string
  model: string
  motion_level?: number
  style_prompt?: string
  custom_instructions?: string
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  slug?: string
}): Promise<string> {
  const spec = MOTION_SPECS[opts.motion_level ?? 2] || MOTION_SPECS[2]!
  const sysParts: string[] = [
    'You write a SHORT motion instruction for animating a single still image into a brief video clip (image-to-video).',
    'The image already exists and defines the look — describe ONLY what MOVES and HOW: camera movement, any subject motion, and ambient motion.',
    'Output ONLY the motion instruction as natural prose (one or two short sentences). No JSON, no labels, no quotes, no preamble.',
    `Motion intensity — ${spec.label}: ${spec.allow}`,
    `Camera: ${spec.camera}`,
    'HARD RULE: slight, slow, smooth motion only. Never fast, frantic, shaky, or whip-pan. Ground every movement in what the image + narration actually depict — do not invent action that is not in the scene.',
  ]
  if (opts.style_prompt && opts.style_prompt.trim()) {
    sysParts.push(`Keep the motion in keeping with the visual style: ${opts.style_prompt.trim()}`)
  }
  if (opts.custom_instructions && opts.custom_instructions.trim()) {
    sysParts.push(`Additional rules: ${opts.custom_instructions.trim()}`)
  }
  const system = sysParts.join('\n\n')

  const userParts: string[] = [
    `The image being animated (its visual prompt):\n${opts.visual_prompt.trim()}`,
  ]
  if (opts.transcript_segment && opts.transcript_segment.trim()) {
    userParts.push(`Narration for this scene (for motion cues only):\n${opts.transcript_segment.trim()}`)
  }
  userParts.push('Write the motion instruction (one or two short sentences, no quotes):')
  const user = userParts.join('\n\n')

  const raw = await callAi(opts.model, system, user, opts.apiKeys, false, { slug: opts.slug })
  let cleaned = (raw || '').trim()
  cleaned = cleaned.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  cleaned = cleaned.replace(/^(motion\s*prompt|motion\s*instruction|motion|camera|animation)\s*[:\-]\s*/i, '').trim()
  cleaned = cleaned.replace(/^["'`“‘]+|["'`”’]+$/g, '').trim()
  return cleaned
}

/**
 * v1.0.468 — bulk-generate motion prompts for the given scene indices, in
 * parallel across the Chat Studio pool with per-scene retry. A sibling of
 * generatePromptsForScenes (visual prompts), sharing the same concurrency +
 * failover behaviour. Each target scene must already have a non-empty
 * `visual_prompt` (the motion prompt is generated to match it); scenes without
 * one are skipped. Writes `scene.motion_prompt`. Returns the count that failed.
 */
export async function generateMotionPromptsForScenes(
  scenes: ScenePlanEntry[],
  targetIndices: number[],
  ctx: {
    model: string
    motion_level?: number
    style_prompt?: string
    custom_instructions?: string
    apiKeys: { anthropic_api_key: string; openai_api_key: string; kie_api_key: string }
    slug?: string
    max_retries?: number
    should_cancel?: () => boolean
    onProgress?: (done: number, total: number) => void
    onWarn?: (msg: string) => void
    /** Called after one prompt is generated. Resolve only after it is durable. */
    onResult?: (sceneIndex: number, prompt: string) => Promise<void>
  },
): Promise<number> {
  if (!targetIndices.length) return 0
  const maxRetries = isLocalTextModel(ctx.model) ? Math.max(0, ctx.max_retries ?? 2) : 0

  // Same pool-derived concurrency as the visual-prompt pass.
  let concurrency = 1
  if (ctx.model.startsWith(CHATSTUDIO_MODEL_PREFIX)) {
    const csStored = await getApiKey('chatstudio').catch(() => '')
    resetChatstudioDispatcher(csStored)
    concurrency = Math.max(1, parseEndpoints(csStored).length)
    if (concurrency > 1) {
      ctx.onWarn?.(
        `Generating ${targetIndices.length} motion prompt(s) ${concurrency}× parallel across `
        + `${concurrency} Chat Studio endpoints.`,
      )
    }
  }

  let failed = 0
  let done = 0
  for (let chunkStart = 0; chunkStart < targetIndices.length; chunkStart += concurrency) {
    if (ctx.should_cancel?.()) break
    const chunk = targetIndices.slice(chunkStart, chunkStart + concurrency)
    const tasks = chunk.map(i => (async () => {
      const scene = scenes[i]!
      if (!scene.visual_prompt || !scene.visual_prompt.trim()) {
        // No image prompt to animate — skip (not a failure).
        return
      }
      let lastErr: any = null
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let prompt = ''
        try {
          prompt = await generateMotionPromptOnly({
            transcript_segment: scene.transcript_segment,
            visual_prompt: scene.visual_prompt,
            model: ctx.model,
            motion_level: ctx.motion_level,
            style_prompt: ctx.style_prompt,
            custom_instructions: ctx.custom_instructions,
            apiKeys: ctx.apiKeys,
            slug: ctx.slug,
          })
        } catch (e: any) {
          lastErr = e
        }
        if (prompt && prompt.trim()) {
          scene.motion_prompt = prompt
          await ctx.onResult?.(i, prompt)
          return
        }
        if (!lastErr) lastErr = new Error('model returned an empty motion prompt')
        if (attempt < maxRetries) {
          ctx.onWarn?.(
            `Scene #${i + 1}: motion-prompt attempt ${attempt + 1}/${maxRetries + 1} failed `
            + `(${lastErr?.message || 'unknown'}) — retrying…`,
          )
          await new Promise(r => setTimeout(r, 1200 * (attempt + 1)))
        }
      }
      failed++
      ctx.onWarn?.(
        `Scene #${i + 1}: motion prompt failed after ${maxRetries + 1} attempt(s) `
        + `(${lastErr?.message || 'unknown'}) — left empty for manual fill / bulk regen.`,
      )
    })())
    await Promise.all(tasks)
    done += chunk.length
    ctx.onProgress?.(done, targetIndices.length)
  }
  return failed
}

/**
 * v1.0.291 — Two-pass scene planner. Built specifically for smaller local
 * LLMs that fail the single-pass structured-JSON output.
 *
 * Pass 1: deterministic split. Walks SRT cues, groups to target duration,
 *         snaps to cue boundaries. NO LLM. Always succeeds.
 * Pass 2: per-scene prompt generation. One LLM call per scene, plain prose
 *         output (no JSON), with configurable neighbor context for
 *         cross-scene continuity. If a single call fails, only THAT
 *         scene's prompt is empty — the rest of the plan stays intact.
 *
 * Trade-offs vs single-pass:
 *   + Reliable on local models (no JSON to fail)
 *   + Per-scene failure radius (not per-window)
 *   + Each LLM call is small and parallelizable in the future
 *   - More LLM calls total (~N for N scenes vs ~N/30 windowed)
 *   - Weaker cross-scene cohesion (model sees neighbor_context_back/forward
 *     scenes, not the full 30-scene window)
 *
 * Cohesion is mitigated by:
 *   - Style prompt + custom instructions woven into every call
 *   - Previous N visual_prompts as context for the "what should look the
 *     same?" anchor
 *   - Visual Recipe (v1.0.292+) baking composition into the per-scene prompt
 *
 * v1.0.295 — Pass 2 is now WINDOWED-PARALLEL when the model is on LM Studio
 * with multiple endpoints. Concurrency = pool size; scenes within a chunk
 * resolve in parallel (sacrificing intra-chunk back-context), but cross-
 * chunk continuity is preserved because each chunk sees fully-resolved
 * prompts from all PRIOR chunks. Cloud models + single-endpoint LM Studio
 * keep the previous strict-sequential behaviour (concurrency=1).
 */
export async function planScenesTwoPass(opts: ScenePlanRunOptions): Promise<ScenePlan> {
  if (!existsSync(opts.stitched_srt_path)) {
    throw new Error(`Stitched SRT not found at ${opts.stitched_srt_path}. Run "Stitch subtitles" first.`)
  }
  const stitchedRaw = await fs.readFile(opts.stitched_srt_path, 'utf-8')
  const cues = parseSrt(stitchedRaw)
  if (!cues.length) {
    throw new Error('Stitched SRT has no cues — re-run "Stitch subtitles" and try again.')
  }
  const totalDuration = cues[cues.length - 1]!.end_sec

  // Pacing band — same source as single-pass (continuity.json overrides the
  // 3-12s default for the live continuity-chain format).
  const minSec = opts.pacing ? opts.pacing.min_sec : MIN_SCENE_SEC
  const maxSec = opts.pacing ? opts.pacing.max_sec : MAX_SCENE_SEC
  const targetSec = (minSec + maxSec) / 2

  // v1.0.245 — range plan only the cues overlapping [start, end] when
  // requested. Same shape as single-pass.
  // v1.0.423 — skip_until_sec drops the leading "Introduction" cues so the
  // story is planned from there (range wins if both are set).
  const range = opts.range
  const skipUntil = (!range && typeof opts.skip_until_sec === 'number' && opts.skip_until_sec > 0)
    ? opts.skip_until_sec : 0
  const planCues = range
    ? cues.filter(c => c.end_sec > range.start_sec + 0.001 && c.start_sec < range.end_sec - 0.001)
    : skipUntil > 0
      ? cues.filter(c => c.end_sec > skipUntil + 0.001)
      : cues
  const initialStart = range ? range.start_sec : skipUntil

  // ── PASS 1: deterministic split ───────────────────────────────────────
  const scenes = splitScenesDeterministically({
    cues: planCues,
    target_sec: targetSec,
    min_sec: minSec,
    max_sec: maxSec,
    initial_start_sec: initialStart,
    idGen: (i) => `scene-${Date.now()}-${i + 1}`,
  })
  if (!scenes.length) {
    throw new Error('Deterministic split produced no scenes — SRT may be empty for the requested range.')
  }
  opts.onProgress?.(0, scenes.length, scenes.length)

  // ── PASS 2: per-scene visual prompts ──────────────────────────────────
  // Pull keys once; callAi picks the right one per call.
  const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
    getApiKey('anthropic').catch(() => ''),
    getApiKey('openai').catch(() => ''),
    getApiKey('kie').catch(() => ''),
  ])

  // v1.0.458 — the windowed-parallel loop + per-scene retry + pool-size
  // concurrency all live in the shared `generatePromptsForScenes`, so the
  // initial two-pass plan and the bulk "regen empty prompts" job behave
  // identically (and both now retry transient local-model disconnects).
  // ctx.slug threading isn't exposed here yet — falls back to global keys.
  const failed = await generatePromptsForScenes(
    scenes,
    scenes.map((_, i) => i),
    {
      model: opts.model,
      detail_level: opts.detail_level,
      style_prompt: opts.style_prompt,
      custom_instructions: opts.custom_instructions,
      neighbor_context_back: opts.neighbor_context_back,
      neighbor_context_forward: opts.neighbor_context_forward,
      apiKeys: { anthropic_api_key, openai_api_key, kie_api_key },
      onProgress: (doneCount) => opts.onProgress?.(doneCount, scenes.length, scenes.length),
      onWarn: opts.onWarn,
    },
  )

  if (failed > 0) {
    opts.onWarn?.(
      `Two-pass plan complete with ${failed} empty prompt(s) of ${scenes.length}. `
      + `Use the "✨ Regen N empty prompts only" button to retry.`,
    )
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    planner_model: opts.model,
    source_stitched_srt: opts.stitched_srt_path,
    total_duration_sec: totalDuration,
    research_used: false,
    scenes,
    // v1.0.291 — two-pass uses N independent calls (one per scene), not
    // windowed batches. Reusing the planned_in_windows field to surface
    // this in the UI would be misleading (the page shows it as "Planned
    // in N windows"). Leaving it undefined; the planning mode is logged
    // separately in the Jobs panel and visible there.
  }
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
  const isLocalModel = typeof opts.model === 'string' && opts.model.startsWith('chatstudio:')
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
  // v1.0.423 — skip_until_sec: drop the leading "Introduction" cues and seed the
  // chain at the story start, but still cover to the real episode end (range wins).
  const range = opts.range
  const skipUntil = (!range && typeof opts.skip_until_sec === 'number' && opts.skip_until_sec > 0)
    ? opts.skip_until_sec : 0
  const planCues = range
    ? cues.filter(c => c.end_sec > range.start_sec + 0.001 && c.start_sec < range.end_sec - 0.001)
    : skipUntil > 0
      ? cues.filter(c => c.end_sec > skipUntil + 0.001)
      : cues
  const initialPrevEnd = range ? range.start_sec : skipUntil
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
  // Holder (not a bare `let`) so the per-window closure can record failures
  // without TS's control-flow analysis narrowing the outer variable to `null`.
  const errRef: { last: Error | null } = { last: null }

  // Per-window planner (retry + graceful subdivide). Pure w.r.t. its args so it
  // runs either chained (sequential, with a story-so-far recap) or independent
  // (parallel, no recap). `lowerBound` is where this window's scenes must start
  // (the previous window's fixed end); `storySoFar` is the rolling recap or
  // undefined when continuity is off.
  const planOneWindow = async (w: number, lowerBound: number, storySoFar: string | undefined): Promise<ScenePlanEntry[]> => {
    const win = windows[w]!
    const { system, user } = buildScenePlannerPrompt({
      stitched_srt: cuesToSrt(win.cues),
      research,
      narration_text: narrationText,
      total_duration_sec: totalDuration,
      pacing: opts.pacing,
      character_density: opts.character_density,
      target_scene_count: opts.target_scene_count,
      detail_level: opts.detail_level,
      style_prompt: opts.style_prompt,
      custom_instructions: opts.custom_instructions,
      window: {
        index: w + 1,
        total: windows.length,
        start_sec: win.start,
        end_sec: win.end,
        prev_scene_end_sec: lowerBound,
        story_so_far: storySoFar,
      },
    })

    // v1.0.245 — guardrail: retry a window before giving up. A single
    // transient LLM failure (timeout, malformed JSON) used to collapse the
    // whole window into one giant filler scene.
    let winScenes: ScenePlanEntry[] = []
    const MAX_ATTEMPTS = isLocalTextModel(opts.model) ? 2 : 1
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && winScenes.length === 0; attempt++) {
      try {
        const raw = await callAi(opts.model, system, user, apiKeys, false, { maxTokens: 16000 })
        const parsed = parsePlannerJson(raw)
        // Clamp this window's scenes to [lowerBound, win.end] so they stay
        // in-segment and don't overlap the neighbouring windows.
        winScenes = normalizeScenes(parsed.scenes || [], dedupedBoundaries, win.end, minSec, maxSec, lowerBound)
        if (winScenes.length === 0 && attempt < MAX_ATTEMPTS) {
          opts.onWarn?.(`Segment ${w + 1}/${windows.length} (${win.start.toFixed(0)}–${win.end.toFixed(0)}s) returned no usable scenes — retrying…`)
        }
      } catch (e: any) {
        errRef.last = e instanceof Error ? e : new Error(String(e))
        if (attempt < MAX_ATTEMPTS) {
          opts.onWarn?.(`Segment ${w + 1}/${windows.length} failed (${errRef.last.message}) — retrying…`)
        }
      }
    }

    // Contiguity: a window must fully cover [lowerBound, win.end]. Extend the
    // last scene to the window end; on total failure, subdivide into cue-aligned
    // placeholder scenes rather than one giant blob.
    if (winScenes.length) {
      const last = winScenes[winScenes.length - 1]!
      if (last.end_sec < win.end) last.end_sec = win.end
    } else if (win.end > lowerBound) {
      winScenes = subdivideWindow(win.cues, lowerBound, win.end, maxSec)
      opts.onWarn?.(
        `⚠ Segment ${w + 1}/${windows.length} (${win.start.toFixed(0)}–${win.end.toFixed(0)}s) failed after ${MAX_ATTEMPTS} tries — ` +
        `split into ${winScenes.length} placeholder scene(s) with empty prompts. Use "Re-plan this scene" or write prompts for them.`,
      )
    }
    return winScenes
  }

  // Each window's lower bound is deterministic — the previous window's FIXED
  // end (windows are cut at cue boundaries), so it's known without running the
  // previous window. This is what lets the "no continuity" mode parallelize.
  const lowerBoundFor = (w: number): number => (w === 0 ? initialPrevEnd : windows[w - 1]!.end)

  if (opts.cross_window_context === false && windows.length > 1) {
    // ── Independent windows → PARALLEL (story-so-far OFF) ──────────────────
    // No rolling recap + fixed per-window bounds ⇒ windows don't depend on each
    // other, so plan them concurrently. Concurrency is model-gated: direct paid
    // cloud fans out; a local Chat Studio pool uses its endpoints; free/proxy
    // tiers stay at 1 (parallel would just multiply 429s).
    const isProxy = opts.model.startsWith(`${CHATSTUDIO_MODEL_PREFIX}provider:`)
    let conc = 4
    if (opts.model.startsWith(CHATSTUDIO_MODEL_PREFIX)) {
      if (isProxy) conc = 1
      else {
        const csStored = await getApiKey('chatstudio').catch(() => '')
        resetChatstudioDispatcher(csStored)
        conc = Math.max(1, parseEndpoints(csStored).length)
      }
    }
    opts.onWarn?.(
      `Story-so-far continuity OFF — planning ${windows.length} segments ` +
      `${conc > 1 ? `${conc}× in parallel` : 'independently'} (faster; slightly weaker cross-seam continuity).`,
    )
    const results: ScenePlanEntry[][] = new Array(windows.length)
    let completed = 0
    for (let s = 0; s < windows.length; s += conc) {
      const batch: number[] = []
      for (let w = s; w < Math.min(s + conc, windows.length); w++) batch.push(w)
      await Promise.all(batch.map(async (w) => {
        results[w] = await planOneWindow(w, lowerBoundFor(w), undefined)
        completed++
        opts.onProgress?.(completed, windows.length, results.reduce((n, r) => n + (r?.length || 0), 0))
      }))
    }
    for (const r of results) if (r) allScenes.push(...r)
  } else {
    // ── Chained windows → SEQUENTIAL (default; story-so-far ON) ────────────
    for (let w = 0; w < windows.length; w++) {
      const winScenes = await planOneWindow(w, prevEnd, w > 0 ? buildStorySoFar(allScenes, !!opts.pacing) : undefined)
      allScenes.push(...winScenes)
      prevEnd = windows[w]!.end
      opts.onProgress?.(w + 1, windows.length, allScenes.length)
    }
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
      (errRef.last ? `Last error: ${errRef.last.message}` : 'Check the model output in the Jobs panel.'),
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
    // v1.0.499 — front-load the art style so image models apply it reliably
    // (leading tokens carry more weight). Applied before the long-scene split
    // so split children inherit the prefixed prompt; empty placeholders stay
    // empty. leadWithStyle no-ops if the prompt already opens with the style.
    if (s.visual_prompt && s.visual_prompt.trim()) {
      s.visual_prompt = leadWithStyle(s.visual_prompt, opts.style_prompt)
    }
    if (s.end_sec - s.start_sec > maxSec + 0.5) {
      finalScenes.push(...splitLongScene(s, cues, maxSec))
    } else {
      finalScenes.push(s)
    }
  }
  // Re-index into a single ordered list.
  finalScenes.forEach((s, i) => { s.scene_index = i + 1 })

  // v1.0.515 — fill EMPTY prompts (split-children above + failed-window
  // placeholders from subdivideWindow) with per-scene generated prompts, each
  // from its OWN transcript with neighbor context. Previously placeholders
  // stayed empty behind a "use Regen" warning, and split children silently
  // cloned one prompt across N scenes — the "22 near-identical images" bug.
  const emptyIdx = finalScenes
    .map((s, i) => (s.visual_prompt && s.visual_prompt.trim() ? -1 : i))
    .filter(i => i >= 0)
  if (emptyIdx.length) {
    opts.onWarn?.(`Generating ${emptyIdx.length} per-scene prompt(s) for split/placeholder scenes…`)
    try {
      const stillEmpty = await generatePromptsForScenes(finalScenes, emptyIdx, {
        model: opts.model,
        detail_level: opts.detail_level,
        style_prompt: opts.style_prompt,
        custom_instructions: opts.custom_instructions,
        apiKeys,
        onWarn: opts.onWarn,
      })
      if (stillEmpty > 0) {
        opts.onWarn?.(`${stillEmpty} scene prompt(s) still empty — use "✨ Regen empty prompts" to retry.`)
      }
    } catch (e: any) {
      opts.onWarn?.(`Post-plan prompt fill failed (${e?.message || e}) — use "✨ Regen empty prompts".`)
    }
  }

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
