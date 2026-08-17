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
import { emptyOpeningHead, type OpeningHead, type OpeningHeadClip } from '../lib/opening-duration.js'

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
function resolveSlot(config: any, slot: 'intro' | 'timeline'): any | null {
  const direct = pickPreset(config?.[`${slot}_presets`], config?.[`${slot}_last_preset`])
  if (direct) return direct
  const bundle = pickPreset(config?.video_bundle_presets, config?.video_bundle_last_preset)
  if (!bundle) return null
  const viaBundleSlot = pickPreset(config?.[`${slot}_presets`], bundle[`${slot}_preset_id`])
  if (viaBundleSlot) return viaBundleSlot
  return bundle?.fallback?.[slot] ?? null
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
 * Build the `OpeningHead` for a project from its saved Video Assembly settings.
 *
 * Never throws for missing assets: a path that does not exist, or a portable
 * `${NAME}` token this machine cannot expand, contributes nothing and is
 * reported in `unresolved` so the caller can say so out loud rather than
 * silently reserving a shorter opening.
 */
export async function resolveProjectOpening(slug: string): Promise<ResolvedOpening> {
  const head = emptyOpeningHead()
  const unresolved: string[] = []
  let config: any = null
  try {
    config = await getConfig(slug)
  } catch { /* no config → no opening */ }
  if (!config) return { head, unresolved }

  const outputRoot = await getProjectOutputRoot(slug).catch(() => '')
  // Resolve a portable token AND confirm the asset can actually play. The
  // renderer runs the same `checkAssetAvailability` gate and skips anything
  // that fails it, so applying it here is what keeps plan and render agreeing.
  const expand = (raw: unknown, label: string): string | undefined => {
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
      unresolved.push(`${label} (${availability.status === 'placeholder' ? 'not downloaded from iCloud yet' : 'file not found'})`)
      return undefined
    }
    return resolved
  }

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
  const titleCard = timeline?.title_card
  if (titleCard?.enabled && typeof titleCard.text === 'string' && titleCard.text.trim()) {
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

  return { head, unresolved }
}
