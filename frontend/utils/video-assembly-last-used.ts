/**
 * Video Assembly remembers what each render was made with.
 *
 * Dreamlands E2E 2026-10-03: a re-render silently reverted to Ken Burns, no
 * subtitles and CRF 18 because the page only remembered choices saved as a
 * preset. Every submitted render now records its settings for that episode
 * and as the channel's starting point; opening an episode restores its own
 * last render, else the channel's.
 *
 * The snapshot is the same reusable shape a bundle preset's fallback carries
 * (intro/timeline/effects/subtitles/export — no scene images, no subtitle
 * file, no title-image path). The title-card TEXT is the episode's own title,
 * so it is kept only for that episode and never offered to another one
 * (AGENTS.md §4).
 */

export interface VideoAssemblySettingsSnapshot {
  intro?: unknown
  timeline?: unknown
  effects?: Record<string, any>
  subtitles?: unknown
  export?: unknown
}

/** The five reusable sections a snapshot (and a bundle) carries. */
export const SNAPSHOT_SECTIONS = ['intro', 'timeline', 'effects', 'subtitles', 'export'] as const
export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number]

interface Entry { episode_id: string; saved_at: string; settings: VideoAssemblySettingsSnapshot }

export interface VideoAssemblyLastUsed {
  channel?: Entry | null
  episodes?: Record<string, Entry>
}

export const LAST_USED_CONFIG_KEY = 'video_assembly_last_used'

function withoutEpisodeText(settings: VideoAssemblySettingsSnapshot): VideoAssemblySettingsSnapshot {
  const card = settings.effects?.title_card
  if (!card || typeof card !== 'object') return settings
  const { text: _text, subtitle: _subtitle, ...reusable } = card
  return { ...settings, effects: { ...settings.effects, title_card: reusable } }
}

export function recordLastUsedSettings(
  store: VideoAssemblyLastUsed | null | undefined,
  episodeId: string,
  settings: VideoAssemblySettingsSnapshot,
  now = new Date(),
): VideoAssemblyLastUsed {
  const episode = episodeId.trim().toUpperCase()
  const saved_at = now.toISOString()
  const copy = JSON.parse(JSON.stringify(settings)) as VideoAssemblySettingsSnapshot
  return {
    channel: { episode_id: episode, saved_at, settings: withoutEpisodeText(copy) },
    episodes: { ...(store?.episodes || {}), [episode]: { episode_id: episode, saved_at, settings: copy } },
  }
}

export function pickLastUsedSettings(
  store: VideoAssemblyLastUsed | null | undefined,
  episodeId: string,
): { scope: 'episode' | 'channel'; from_episode: string; settings: VideoAssemblySettingsSnapshot } | null {
  const episode = episodeId.trim().toUpperCase()
  const own = store?.episodes?.[episode]
  if (own?.settings) return { scope: 'episode', from_episode: episode, settings: own.settings }
  const channel = store?.channel
  if (channel?.settings) {
    return { scope: 'channel', from_episode: channel.episode_id, settings: withoutEpisodeText(channel.settings) }
  }
  return null
}

/**
 * Resolves which sections are covered by the current active preset state.
 * A section is covered if it has a pointed slot preset (slotActive is truthy)
 * OR if the selected video bundle supplies a valid fallback for that section.
 * When a bundle applies fallback data, it clears slot.activeId, so inspecting
 * both sources is necessary to ensure selected bundle fallbacks are not
 * overwritten by a stale channel snapshot (Production 2026-11-07 item 19).
 */
export function coveredSectionsFromActivePresets(
  slots: Partial<Record<SnapshotSection, unknown>>,
  bundleFallback?: Partial<Record<SnapshotSection, unknown>> | null,
): SnapshotSection[] {
  const covered: SnapshotSection[] = []
  for (const section of SNAPSHOT_SECTIONS) {
    const hasSlot = Boolean(slots[section])
    const hasFallback = Boolean(bundleFallback && bundleFallback[section] && typeof bundleFallback[section] === 'object')
    if (hasSlot || hasFallback) covered.push(section)
  }
  return covered
}

/**
 * A NEW episode has no own snapshot, so the channel's last render is the only
 * starting point the store offers — but it is a STALE snapshot from a previous
 * episode, and it must not silently overwrite the bundle / per-section presets
 * the customer has selected NOW (Production 2026-11-07: a freshly chosen
 * bundle applied on mount, then the channel last-used ran over it and reverted
 * the chosen values). The selected presets are the newer, deliberate choice.
 *
 * Own-episode picks are returned untouched: they are that episode's own
 * recorded render and always win (AGENTS.md §4). For a channel pick, a section
 * already covered by a selected preset is dropped, so that section keeps the
 * preset's value; a section with no configured preset keeps the channel
 * starting point. `coveredSections` is the set of sections the page currently
 * has an applied/selected preset for.
 */
export function scopeLastUsedSettings(
  pick: { scope: 'episode' | 'channel'; from_episode: string; settings: VideoAssemblySettingsSnapshot } | null,
  coveredSections: Iterable<SnapshotSection>,
): { scope: 'episode' | 'channel'; from_episode: string; settings: VideoAssemblySettingsSnapshot } | null {
  if (!pick || pick.scope === 'episode') return pick
  const covered = new Set(coveredSections)
  const settings: VideoAssemblySettingsSnapshot = {}
  let kept = false
  for (const section of SNAPSHOT_SECTIONS) {
    if (covered.has(section)) continue
    const value = pick.settings[section]
    if (value === undefined) continue
    ;(settings as Record<string, unknown>)[section] = value
    kept = true
  }
  return kept ? { ...pick, settings } : null
}

export function withoutEpisodeFiles<T extends Record<string, any>>(fallback: T | null | undefined): T | undefined {
  if (!fallback || typeof fallback !== 'object') return fallback ?? undefined
  const copy = JSON.parse(JSON.stringify(fallback))
  // The title image is chosen per episode (the Timeline preset has excluded it
  // since the 2026-08-03 incident), and the caption file is resolved per
  // episode by the renderer — a stored one is one episode's transcript.
  // Strip at whole-bundle depth
  if (copy.timeline?.title_image) delete copy.timeline.title_image.image_path
  if (copy.subtitles?.srt_path) delete copy.subtitles.srt_path
  // Strip at single-section depth
  if (copy.title_image) delete copy.title_image.image_path
  if ('srt_path' in copy) delete copy.srt_path
  return copy
}

export interface ActivePresetSlotSource<T = unknown> {
  activeId?: string | null
  activeData?: T | null
}

export interface ResolvedEpisodeRestoreSettings {
  scope: 'episode' | 'channel' | 'preset'
  from_episode?: string
  settings: VideoAssemblySettingsSnapshot
  notice: string
}

/**
 * When switching episodes in Video Assembly:
 * - An episode with its OWN last-used render restores those settings whole (AGENTS.md §4).
 * - A channel-backed or new episode restores the currently active per-section or
 *   bundle-fallback presets afresh on the form so values from a previously-opened
 *   episode do not stick to the form. Any section with NO configured preset preserves
 *   the channel's last-used fallback.
 */
export function resolveEpisodeRestoreSettings(params: {
  store: VideoAssemblyLastUsed | null | undefined
  episodeId: string
  slots?: Partial<Record<SnapshotSection, ActivePresetSlotSource | unknown>>
  bundleFallback?: Partial<Record<SnapshotSection, unknown>> | null
}): ResolvedEpisodeRestoreSettings {
  const { store, episodeId, slots, bundleFallback } = params
  const rawPick = pickLastUsedSettings(store, episodeId)
  if (rawPick?.scope === 'episode') {
    return {
      scope: 'episode',
      from_episode: rawPick.from_episode,
      settings: rawPick.settings,
      notice: `Settings restored from ${rawPick.from_episode}'s last render. Change anything below, or apply a preset.`,
    }
  }

  // Derive covered sections to scope channel pick for uncovered sections
  const slotIds: Partial<Record<SnapshotSection, unknown>> = {}
  for (const section of SNAPSHOT_SECTIONS) {
    const slot = slots?.[section]
    if (slot && typeof slot === 'object' && 'activeId' in slot) {
      slotIds[section] = (slot as ActivePresetSlotSource).activeId
    } else if (slot) {
      slotIds[section] = slot
    }
  }
  const covered = coveredSectionsFromActivePresets(slotIds, bundleFallback)
  const scopedChannel = scopeLastUsedSettings(rawPick, covered)

  const settings: VideoAssemblySettingsSnapshot = {}

  for (const section of SNAPSHOT_SECTIONS) {
    // 1. Pointed slot preset (preferred over bundle fallback)
    const slot = slots?.[section]
    let slotData: unknown = undefined
    if (slot && typeof slot === 'object' && 'activeId' in slot) {
      const s = slot as ActivePresetSlotSource
      if (s.activeId && s.activeData) slotData = s.activeData
    } else if (slot && typeof slot === 'object' && !('activeId' in slot)) {
      slotData = slot
    }

    if (slotData !== undefined) {
      ;(settings as Record<string, unknown>)[section] = slotData
      continue
    }

    // 2. Selected bundle fallback
    const fb = bundleFallback?.[section]
    if (fb && typeof fb === 'object') {
      ;(settings as Record<string, unknown>)[section] = withoutEpisodeFiles(fb as Record<string, any>)
      continue
    }

    // 3. Channel fallback for unconfigured sections
    if (scopedChannel?.settings?.[section] !== undefined) {
      ;(settings as Record<string, unknown>)[section] = scopedChannel.settings[section]
    }
  }

  const notice = rawPick?.scope === 'channel'
    ? `Settings start from this channel's last render (${rawPick.from_episode}) for sections with no preset. Change anything below, or apply a preset.`
    : ''

  return {
    scope: rawPick?.scope === 'channel' ? 'channel' : 'preset',
    from_episode: rawPick?.from_episode,
    settings,
    notice,
  }
}

