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
