/**
 * Resolve the project's CURRENT opening assets — the clips that will play
 * before the first scene in Video Assembly — so Scene Plan can reserve exactly
 * that much, measured, instead of a number the customer has to remember.
 *
 * The owner's ruling (2026-08-17): *"i already have the intro inside the audio
 * assembly which already has it's data. why isn't it just get's included in all
 * places that needs this 'intro offset'? like just derive it there directly is
 * the best option. i don't have to also keep remembering. if it doesn't have
 * intro, then no need to leave the offset."*
 *
 * Where the truth lives
 * ---------------------
 * Video Assembly persists its form as per-slot presets in the project config —
 * `intro_presets` + `intro_last_preset` for the intro video and the user's
 * timeline clips, `timeline_presets` + `timeline_last_preset` for the title
 * card. A saved bundle (`video_bundle_presets` + `video_bundle_last_preset`)
 * ties one preset per slot together and carries a `fallback` snapshot for slots
 * whose preset has since been deleted.
 *
 * This module resolves in exactly the order the Video Assembly page itself
 * does: the active slot preset first, the active bundle's fallback snapshot
 * second. Nothing here invents a default — an unresolvable opening is reported
 * as no opening, and Scene Plan then reserves 0, which is the right answer for
 * a project with no branded intro.
 */

import { getConfig, getProjectOutputRoot } from './project-manager.js'
import { isPortablePath, resolveAssetPath } from './path-resolver.js'
import { checkAssetAvailability } from '../lib/sync-safe.js'
import { emptyOpeningHead, measureClipSec, type OpeningHead, type OpeningHeadClip } from '../lib/opening-duration.js'
import { postRollSeconds } from '../lib/closing-tail.js'
import type { FinalCheckIntro } from '../lib/final-video-check.js'

/** Default seconds a title image holds for, mirroring the Video Assembly form. */
const DEFAULT_TITLE_HOLD_SEC = 5

interface StoredPreset { id?: string; name?: string; data?: any }

function pickPreset(list: unknown, activeId: unknown): any | null {
  if (!Array.isArray(list) || typeof activeId !== 'string' || !activeId) return null
  const hit = (list as StoredPreset[]).find(p => p && p.id === activeId)
  return hit?.data ?? null
}

/**
 * The active Video Assembly slot data for one slot, resolved the way the page
 * resolves it: the slot's own active preset, else the active bundle's fallback
 * snapshot for that slot.
 */
function resolveSlot(config: any, slot: 'intro' | 'timeline' | 'effects'): any | null {
  const direct = pickPreset(config?.[`${slot}_presets`], config?.[`${slot}_last_preset`])
  if (direct) return direct
  const bundle = pickPreset(config?.video_bundle_presets, config?.video_bundle_last_preset)
  if (!bundle) return null
  const viaBundleSlot = pickPreset(config?.[`${slot}_presets`], bundle[`${slot}_preset_id`])
  if (viaBundleSlot) return viaBundleSlot
  return bundle?.fallback?.[slot] ?? null
}

/**
 * The active TIMELINE slot's saved data, in the page's own resolution order.
 *
 * Exported (2026-10-19) because the closing music tail lives there — `post_audio`
 * with its `closing_music` block — and Audio Assembly has to read the SAME block
 * the renderer does. A second copy of this order would be a second answer to
 * "which timeline is this channel using".
 */
export function resolveTimelineSlot(config: any): any | null {
  return resolveSlot(config, 'timeline')
}

/**
 * The active INTRO slot's saved data, in the page's own resolution order.
 *
 * Exported (2026-10-20) because the user's timeline clips live there — `after_scenes` /
 * `after_outro` are the episode's own tail content, and the final check has to know what the
 * episode's settings put after the narration. A second copy of this order would be a second answer
 * to "which intro is this channel using".
 */
export function resolveIntroSlot(config: any): any | null {
  return resolveSlot(config, 'intro')
}

export interface ResolvedOpening {
  head: OpeningHead
  /**
   * Openings assets the project asks for but this machine cannot play right
   * now — an unexpandable `${NAME}` token, a deleted file, or an iCloud
   * placeholder. They contribute nothing to the reserve (the renderer skips
   * them too), and the caller says so rather than reserving a shorter opening
   * in silence.
   */
  unresolved: string[]
}

/**
 * Expand a portable `${NAME}` token and confirm the asset can actually play.
 *
 * The renderer runs the same `checkAssetAvailability` gate and skips anything that fails it, so
 * applying it here is what keeps plan and render agreeing. Nothing usable → `undefined`, with the
 * reason pushed onto `unresolved` for the caller to say out loud.
 */
function expandAvailable(raw: unknown, label: string, outputRoot: string, unresolved: string[]): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  let resolved = raw
  if (isPortablePath(raw)) {
    try {
      resolved = resolveAssetPath(raw, outputRoot || undefined)
    } catch {
      unresolved.push(`${label} (named root not defined on this Mac)`)
      return undefined
    }
  }
  const availability = checkAssetAvailability(resolved, label)
  if (availability.status !== 'available') {
    unresolved.push(`${label} (file not found)`)
    return undefined
  }
  return resolved
}

/**
 * The head of the video a project's saved Video Assembly settings ask for, measured the way the
 * renderer measures it. `unresolved` collects what the settings name but this machine cannot play.
 */
async function buildOpeningHead(config: any, outputRoot: string, unresolved: string[]): Promise<OpeningHead> {
  const head = emptyOpeningHead()
  const expand = (raw: unknown, label: string): string | undefined => expandAvailable(raw, label, outputRoot, unresolved)

  const intro = resolveSlot(config, 'intro')
  const timeline = resolveSlot(config, 'timeline')

  if (intro?.enabled && intro.video_path) {
    const introPath = expand(intro.video_path, 'intro video')
    if (introPath) head.intro = { path: introPath, label: 'intro' }
  }

  // The title card only reaches the composed video when it has real content:
  // an enabled title image needs a path (the owner's live BL preset is enabled
  // with no image and is correctly skipped at render time), and a text card
  // needs text. A text card replaces the image when both are set, exactly as
  // the renderer does.
  const titleImage = timeline?.title_image
  if (titleImage?.enabled && titleImage.image_path) {
    const titlePath = expand(titleImage.image_path, 'title image')
    if (titlePath) {
      head.title = {
        path: titlePath,
        duration_sec: Number(titleImage.duration) > 0 ? Number(titleImage.duration) : DEFAULT_TITLE_HOLD_SEC,
        label: 'title',
      }
    }
  }
  // 1.4.286 — the text card is saved in the Effects slot (it never was in Timeline, so it was
  // never reserved). Its text is the episode's title at render time, so being on is enough.
  const titleCard = resolveSlot(config, 'effects')?.title_card ?? timeline?.title_card
  if (titleCard?.enabled) {
    head.title = {
      duration_sec: Number(titleCard.duration) > 0 ? Number(titleCard.duration) : DEFAULT_TITLE_HOLD_SEC,
      label: 'title card',
    }
  }

  // User timeline clips live on the intro slot preset. Only the two head
  // anchors precede the scenes; `after_scenes` / `after_outro` are tail
  // content and must never inflate the reserve.
  const clips = Array.isArray(intro?.timeline_clips) ? intro.timeline_clips : []
  for (const clip of clips) {
    if (!clip || clip.enabled === false) continue
    if (clip.anchor !== 'before_intro' && clip.anchor !== 'after_intro') continue
    const bucket: OpeningHeadClip[] = clip.anchor === 'before_intro' ? head.before_intro : head.after_intro
    if (clip.kind === 'static') {
      const imagePath = expand(clip.image_path, `timeline clip (${clip.anchor})`)
      if (!imagePath) continue
      bucket.push({
        path: imagePath,
        duration_sec: Number(clip.duration_sec) > 0 ? Number(clip.duration_sec) : DEFAULT_TITLE_HOLD_SEC,
        label: `${clip.anchor} still`,
      })
      continue
    }
    const videoPath = expand(clip.video_path, `timeline clip (${clip.anchor})`)
    if (!videoPath) continue
    bucket.push({ path: videoPath, label: `${clip.anchor} clip` })
  }

  return head
}

/**
 * Build the `OpeningHead` for a project from its saved Video Assembly settings.
 *
 * Never throws for missing assets: a path that does not exist, or a portable
 * `${NAME}` token this machine cannot expand, contributes nothing and is
 * reported in `unresolved` so the caller can say so out loud rather than
 * silently reserving a shorter opening.
 */
export async function resolveProjectOpening(slug: string): Promise<ResolvedOpening> {
  const unresolved: string[] = []
  let config: any = null
  try {
    config = await getConfig(slug)
  } catch { /* no config → no opening */ }
  if (!config) return { head: emptyOpeningHead(), unresolved }

  // `getProjectOutputRoot` answers null when the project has none: no named root, so a portable
  // `${NAME}` token cannot be expanded and every asset it names is reported unresolved.
  const outputRoot = (await getProjectOutputRoot(slug).catch(() => '')) || ''
  return { head: await buildOpeningHead(config, outputRoot, unresolved), unresolved }
}

/** What an episode's own Video Assembly settings put around its narration. */
export interface EpisodeRenderShape {
  /** See `FinalCheckExpectation.after_narration_sec`. 0 when the settings ask for no tail. */
  after_narration_sec: number
  /** Where the episode's branded intro clip plays, or null when it draws none. */
  intro: FinalCheckIntro | null
}

/**
 * What an episode's own Video Assembly settings put around its narration: the tail that follows it
 * and where its branded intro clip sits at the head of the file.
 *
 * The final check needs both for a final that carries no plan of its own — a file rendered before
 * the plan sidecar existed (Story Sprout SS0063, 2026-10-20). Owner decision that day: a final that
 * matches what its own settings asked for is not a fault, and the black inside the channel's own
 * intro asset is the owner's own content. `generators/video.ts` computes the same tail while
 * rendering as `totalRenderDuration` — `sceneTrackTargetDuration + outroDuration +
 * tailClipsDuration`, with the post-roll inside the first term. This is that same sum, read from the
 * settings saved NOW, for a file that recorded none of its own.
 *
 * `probe` is the caller's duration reader (`getAudioDuration` — ffprobe reads video containers too).
 * A clip or an outro this machine cannot measure contributes nothing: a guessed length would become
 * the length the file is then measured against, and a wrong one holds a good file or passes a bad
 * one. Nothing here throws for a missing asset — an unreadable setting is no tail, never a guess.
 */
export async function resolveEpisodeRenderShape(
  slug: string,
  probe: (filePath: string) => Promise<number | undefined>,
): Promise<EpisodeRenderShape> {
  const empty: EpisodeRenderShape = { after_narration_sec: 0, intro: null }
  let config: any = null
  try {
    config = await getConfig(slug)
  } catch { /* no config → no shape */ }
  if (!config) return empty

  // `getProjectOutputRoot` answers null when the project has none: no named root, so a portable
  // `${NAME}` token cannot be expanded and every asset it names is reported unresolved.
  const outputRoot = (await getProjectOutputRoot(slug).catch(() => '')) || ''
  const intro = resolveIntroSlot(config)
  const timeline = resolveTimelineSlot(config)
  const measurable = async (raw: unknown, label: string): Promise<number> => {
    const filePath = expandAvailable(raw, label, outputRoot, [])
    if (!filePath) return 0
    const sec = await probe(filePath).catch(() => undefined)
    return sec && sec > 0 ? sec : 0
  }

  // The timeline clips the episode's settings anchor after the scenes, and the outro after those.
  let afterNarrationSec = 0
  const clips = Array.isArray(intro?.timeline_clips) ? intro.timeline_clips : []
  for (const clip of clips) {
    if (!clip || clip.enabled === false) continue
    if (clip.anchor !== 'after_scenes' && clip.anchor !== 'after_outro') continue
    if (clip.kind === 'static') {
      const sec = Number(clip.duration_sec)
      if (sec > 0) afterNarrationSec += sec
      continue
    }
    afterNarrationSec += await measurable(clip.video_path, `timeline clip (${clip.anchor})`)
  }
  if (intro?.outro?.enabled && intro.outro.video_path) {
    afterNarrationSec += await measurable(intro.outro.video_path, 'outro video')
  }
  // ...and the post-roll the post-audio block asks for sits between them.
  afterNarrationSec += postRollSeconds(timeline?.post_audio)

  // The intro clip plays after any `before_intro` clip, so the head's own clips put it where it is.
  let introShape: FinalCheckIntro | null = null
  const head = await buildOpeningHead(config, outputRoot, [])
  if (head.intro?.path) {
    let beforeIntroSec = 0
    for (const clip of head.before_intro) {
      beforeIntroSec += await measureClipSec(clip, probe).catch(() => 0)
    }
    const introSec = await probe(head.intro.path).catch(() => undefined)
    if (introSec && introSec > 0) {
      introShape = {
        asset: head.intro.path,
        window: { start_sec: beforeIntroSec, end_sec: beforeIntroSec + introSec },
      }
    }
  }

  return { after_narration_sec: Math.round(afterNarrationSec * 1000) / 1000, intro: introShape }
}
