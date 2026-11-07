/**
 * Sleep Video Title Placement (v1.4.386).
 *
 * Owner requirement (2026-11-07): "Sleep videos: show the video title once, after the intro."
 *
 * Rules:
 *   1. ONLY sleep videos: non-sleep videos keep existing behavior byte-for-byte.
 *   2. ONCE: Never duplicate title image and title card. Exactly one authoritative
 *      title presentation is selected (title card preferred if drawtext/text is
 *      available, else title image / thumbnail cover frame).
 *   3. AFTER THE INTRO:
 *      - If an intro video clip is present, the title appears immediately after it.
 *      - If a spoken Introduction chapter is present (welcome ritual / breathing),
 *        the title appears after that intro chapter (at `story_start_sec`), when the
 *        story narration actually begins.
 *      - If both are present, the title appears after both have concluded.
 *      - When a branded opening is configured, sleep videos do NOT suppress the title
 *        card/image (fixing the defect where video.ts lines 3851-3857 dropped title cards).
 *   4. Explicit choices preserved: if an episode explicitly turns off titles, that
 *      choice is respected.
 *   5. No media or stored project data is rewritten.
 */

export interface SleepVideoContext {
  niche_id?: string
  niche?: string
  format_id?: string
  formula_id?: string
  formulaFamily?: string
  formula_choice?: string
  is_sleep?: boolean
}

export const SLEEP_FORMULA_IDS = new Set([
  'sleep',
  'com.storystudio.formula.sleep-story',
  'com.storystudio.formula.sleep-history-compilation',
  'com.storystudio.formula.calm-science-for-sleep',
  'com.storystudio.formula.mythology-for-sleep',
  // NOTE: `com.storystudio.formula.a-world-before-us` is the GENERAL
  // illustrated-history pack — not sleep. The sleep variant is its own id below.
  'com.storystudio.formula.illustrated-history-for-sleep',
  'kh.owner.formula.illustrated-history-for-sleep',
])

/**
 * Determine if a project / episode belongs to a Sleep format, niche, or formula.
 * Returns false for non-sleep channels (preserving all non-sleep behavior).
 */
export function isSleepVideo(ctx: SleepVideoContext | null | undefined): boolean {
  if (!ctx || typeof ctx !== 'object') return false
  if (ctx.is_sleep === true) return true
  if (ctx.is_sleep === false) return false

  const niche = String(ctx.niche_id || ctx.niche || '').trim().toLowerCase()
  if (niche === 'sleep' || niche.startsWith('sleep-') || niche.endsWith('-sleep') || niche.includes('sleep')) {
    return true
  }

  const format = String(ctx.format_id || '').trim().toLowerCase()
  if (format === 'sleep-story' || format.startsWith('sleep')) {
    return true
  }

  const formula = String(ctx.formula_id || '').trim()
  if (formula) {
    if (SLEEP_FORMULA_IDS.has(formula)) return true
    if (/sleep/i.test(formula)) return true
  }

  const family = String(ctx.formulaFamily || '').trim()
  if (family === 'Calm stories' || /calm\s*stories/i.test(family)) {
    return true
  }

  return false
}

export interface SleepTitleImageConfig {
  enabled?: boolean
  image_path?: string
  duration?: number
  transition_type?: string
  transition_duration?: number
}

export interface SleepTitleCardConfig {
  enabled?: boolean
  text?: string
  subtitle?: string
  duration?: number
  style?: string
  background?: string
  background_media_path?: string
}

export interface SleepIntroVideoConfig {
  enabled?: boolean
  video_path?: string
  duration?: number
}

export interface SleepIntroAudioConfig {
  has_intro_chapter?: boolean
  story_start_sec?: number
  intro_label?: string | null
  intro_video_sec?: number
  hold_sec?: number
}

export interface SleepTitlePlacementInput {
  project?: SleepVideoContext | null
  title_image?: SleepTitleImageConfig | null
  title_card?: SleepTitleCardConfig | null
  intro?: SleepIntroVideoConfig | null
  intro_audio?: SleepIntroAudioConfig | null
  plan_opening_reserved_sec?: number | null
  plan_opening_measured?: boolean
  can_drawtext?: boolean
  thumbnail_path?: string
  default_title_text?: string
  user_override?: {
    enabled?: boolean
    preferred_type?: 'title_card' | 'title_image' | 'none'
  }
}

export type SleepTitleType = 'title_card' | 'title_image' | 'none'
export type SleepTitleAnchor = 'after_intro_video' | 'after_intro_audio' | 'after_combined_intro' | 'start'

export interface SleepTitleTiming {
  intro_duration_sec: number
  title_start_sec: number
  title_duration_sec: number
  story_scenes_start_sec: number
}

export interface SleepTitlePlacementResult {
  is_sleep: boolean
  display_title: boolean
  title_type: SleepTitleType
  anchor: SleepTitleAnchor
  duration_sec: number
  start_sec: number
  effective_title_image: SleepTitleImageConfig
  effective_title_card: SleepTitleCardConfig
  prevent_opening_suppression: boolean
  timing: SleepTitleTiming
  explanation: string
}

const DEFAULT_TITLE_DURATION_SEC = 5

/**
 * Pure decision function for sleep title placement and deduplication.
 * Guaranteed idempotent and side-effect free.
 */
export function resolveSleepTitlePlacement(input: SleepTitlePlacementInput): SleepTitlePlacementResult {
  const isSleep = isSleepVideo(input.project)

  const rawTitleImage: SleepTitleImageConfig = { ...(input.title_image || {}) }
  const rawTitleCard: SleepTitleCardConfig = { ...(input.title_card || {}) }
  const rawIntro: SleepIntroVideoConfig = { ...(input.intro || {}) }
  const rawIntroAudio: SleepIntroAudioConfig = { ...(input.intro_audio || {}) }
  const canDrawtext = input.can_drawtext !== false

  // ── NON-SLEEP BEHAVIOR PRESERVED ──────────────────────────────────────────
  if (!isSleep) {
    const hasCard = !!(rawTitleCard.enabled && rawTitleCard.text?.trim() && canDrawtext)
    const hasImage = !!(rawTitleImage.enabled && (rawTitleImage.image_path || input.thumbnail_path))
    const displayTitle = hasCard || hasImage
    const titleType: SleepTitleType = hasCard ? 'title_card' : hasImage ? 'title_image' : 'none'
    const duration = hasCard
      ? (Number(rawTitleCard.duration) || DEFAULT_TITLE_DURATION_SEC)
      : hasImage
        ? (Number(rawTitleImage.duration) || DEFAULT_TITLE_DURATION_SEC)
        : 0
    const introVideoSec = rawIntro.enabled && rawIntro.video_path ? (Number(rawIntro.duration) || 5) : 0
    const anchor: SleepTitleAnchor = introVideoSec > 0 ? 'after_intro_video' : 'start'

    return {
      is_sleep: false,
      display_title: displayTitle,
      title_type: titleType,
      anchor,
      duration_sec: duration,
      start_sec: introVideoSec,
      effective_title_image: rawTitleImage,
      effective_title_card: rawTitleCard,
      prevent_opening_suppression: false,
      timing: {
        intro_duration_sec: introVideoSec,
        title_start_sec: introVideoSec,
        title_duration_sec: duration,
        story_scenes_start_sec: introVideoSec + duration,
      },
      explanation: 'Non-sleep video: standard title card and image behavior preserved.',
    }
  }

  // ── SLEEP VIDEO DECISION ──────────────────────────────────────────────────
  // 1. Explicit user override / disable check
  if (input.user_override?.enabled === false) {
    return makeDisabledSleepResult('Title display explicitly disabled by user override.')
  }

  // Explicit disable in both cards without user override turning it on
  const cardExplicitlyOff = rawTitleCard.enabled === false
  const imageExplicitlyOff = rawTitleImage.enabled === false
  const cardConfigured = rawTitleCard.enabled === true
  const imageConfigured = rawTitleImage.enabled === true

  if (!cardConfigured && !imageConfigured && cardExplicitlyOff && imageExplicitlyOff) {
    return makeDisabledSleepResult('Title display explicitly disabled for this episode.')
  }

  // 2. Select EXACTLY ONE title presentation (deduplicate)
  let chosenType: SleepTitleType = 'none'
  const preferred = input.user_override?.preferred_type

  if (preferred === 'none') {
    return makeDisabledSleepResult('Title display set to none.')
  } else if (preferred === 'title_card' && canDrawtext) {
    chosenType = 'title_card'
  } else if (preferred === 'title_image') {
    chosenType = 'title_image'
  } else {
    // Normal auto-resolution with title_card precedence when text is available
    const hasText = !!(rawTitleCard.text?.trim() || input.default_title_text?.trim())
    if (cardConfigured && hasText && canDrawtext) {
      chosenType = 'title_card'
    } else if (imageConfigured && (rawTitleImage.image_path || input.thumbnail_path)) {
      chosenType = 'title_image'
    } else if (cardConfigured && !canDrawtext && (rawTitleImage.image_path || input.thumbnail_path)) {
      chosenType = 'title_image'
    } else if (!imageExplicitlyOff && !cardExplicitlyOff && hasText && canDrawtext) {
      // Default to clean title card for sleep videos — never past an explicit off.
      chosenType = 'title_card'
    } else if (!imageExplicitlyOff && (rawTitleImage.image_path || input.thumbnail_path)) {
      chosenType = 'title_image'
    } else if (!cardExplicitlyOff && hasText && canDrawtext) {
      chosenType = 'title_card'
    } else if (!imageExplicitlyOff && input.thumbnail_path) {
      chosenType = 'title_image'
    }
  }

  if (chosenType === 'none') {
    return makeDisabledSleepResult('No usable title text, card, or image available.')
  }

  // 3. Resolve duration
  const rawDuration = chosenType === 'title_card'
    ? Number(rawTitleCard.duration)
    : Number(rawTitleImage.duration)
  const durationSec = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.max(2, Math.min(15, rawDuration))
    : DEFAULT_TITLE_DURATION_SEC

  // 4. Resolve placement anchor and timing
  const hasIntroVideo = !!(rawIntro.enabled && rawIntro.video_path)
  const introVideoSec = hasIntroVideo ? (Number(rawIntro.duration) || rawIntroAudio.intro_video_sec || 5) : 0
  const hasIntroAudio = !!(rawIntroAudio.has_intro_chapter && (rawIntroAudio.story_start_sec || 0) > 0)
  const introAudioSec = hasIntroAudio ? (rawIntroAudio.story_start_sec || 0) : 0

  let anchor: SleepTitleAnchor = 'start'
  let introDurationSec = 0
  let titleStartSec = 0
  let explanation = ''

  if (hasIntroVideo && hasIntroAudio) {
    anchor = 'after_combined_intro'
    introDurationSec = Math.max(introVideoSec, introAudioSec)
    titleStartSec = introDurationSec
    explanation = `Sleep video: title (${durationSec}s) shown once, after the combined intro video (${introVideoSec.toFixed(1)}s) and spoken welcome ritual (${introAudioSec.toFixed(1)}s).`
  } else if (hasIntroVideo) {
    anchor = 'after_intro_video'
    introDurationSec = introVideoSec
    titleStartSec = introVideoSec
    explanation = `Sleep video: title (${durationSec}s) shown once, immediately after the ${introVideoSec.toFixed(1)}s intro video.`
  } else if (hasIntroAudio) {
    anchor = 'after_intro_audio'
    introDurationSec = introAudioSec
    titleStartSec = introAudioSec
    explanation = `Sleep video: title (${durationSec}s) shown once, after the ${introAudioSec.toFixed(1)}s spoken Introduction chapter (at story start).`
  } else {
    anchor = 'start'
    introDurationSec = 0
    titleStartSec = 0
    explanation = `Sleep video: no intro detected; title (${durationSec}s) shown once at the start.`
  }

  // 5. Build sanitized effective configs (ENFORCING EXACTLY ONE ACTIVE TITLE)
  const effectiveTitleCard: SleepTitleCardConfig = {
    ...rawTitleCard,
    enabled: chosenType === 'title_card',
    duration: durationSec,
    text: (rawTitleCard.text?.trim() || input.default_title_text?.trim() || 'Episode Title'),
  }

  const effectiveTitleImage: SleepTitleImageConfig = {
    ...rawTitleImage,
    enabled: chosenType === 'title_image',
    duration: durationSec,
    image_path: rawTitleImage.image_path || input.thumbnail_path || '',
  }

  return {
    is_sleep: true,
    display_title: true,
    title_type: chosenType,
    anchor,
    duration_sec: durationSec,
    start_sec: titleStartSec,
    effective_title_image: effectiveTitleImage,
    effective_title_card: effectiveTitleCard,
    prevent_opening_suppression: true,
    timing: {
      intro_duration_sec: introDurationSec,
      title_start_sec: titleStartSec,
      title_duration_sec: durationSec,
      story_scenes_start_sec: titleStartSec + durationSec,
    },
    explanation,
  }
}

function makeDisabledSleepResult(reason: string): SleepTitlePlacementResult {
  return {
    is_sleep: true,
    display_title: false,
    title_type: 'none',
    anchor: 'start',
    duration_sec: 0,
    start_sec: 0,
    effective_title_image: { enabled: false },
    effective_title_card: { enabled: false },
    prevent_opening_suppression: false,
    timing: {
      intro_duration_sec: 0,
      title_start_sec: 0,
      title_duration_sec: 0,
      story_scenes_start_sec: 0,
    },
    explanation: `Sleep video: ${reason}`,
  }
}

/**
 * Helper to adjust a video generation request for sleep title placement before rendering.
 * Used by the video generator (generators/video.ts).
 */
export function applySleepTitlePlacementToRequest(
  req: {
    title_image?: SleepTitleImageConfig
    title_card?: SleepTitleCardConfig
    intro?: SleepIntroVideoConfig
    [key: string]: any
  },
  context: SleepVideoContext,
  options?: {
    intro_audio?: SleepIntroAudioConfig
    thumbnail_path?: string
    default_title_text?: string
    can_drawtext?: boolean
  },
): SleepTitlePlacementResult {
  const result = resolveSleepTitlePlacement({
    project: context,
    title_image: req.title_image,
    title_card: req.title_card,
    intro: req.intro,
    intro_audio: options?.intro_audio,
    thumbnail_path: options?.thumbnail_path,
    default_title_text: options?.default_title_text,
    can_drawtext: options?.can_drawtext,
  })

  if (result.is_sleep && result.display_title) {
    req.title_image = { ...result.effective_title_image }
    req.title_card = { ...result.effective_title_card }
  }

  return result
}
