/**
 * An overlay's LOOK is reusable; an overlay's WINDOW belongs to one episode.
 *
 * ── The owner's ruling, 2026-08-18 ──
 *
 * *"overlays should belong to episodes and can be in the presets because i
 * might want to randomize the overlays effects."*
 *
 * Two things that sound contradictory and are not. Which overlay file, its
 * opacity, scale, position, blend, chroma key and loop are taste — reusable
 * across episodes, and something he wants to shuffle between. `time_range` —
 * when that overlay appears in THIS episode — is a fact about one episode's
 * runtime, and it is meaningless anywhere else. A 12-second flourish placed
 * over the closing line of a 16-minute episode lands mid-sentence in a
 * 9-minute one.
 *
 * So the split is: the layer definition travels in presets, and the window does
 * not travel at all.
 *
 * ── The sixth instance ──
 *
 * This is the sixth time this codebase has shipped the same shape (AGENTS.md,
 * "Preset Boundaries"): episode-specific state surviving an episode change. The
 * five before it were `title_image.image_path`, `pacing`, `references.sheet`,
 * Contextual Cues' `auto_approve`, and `subtitles.srt_path` — the last of which
 * put one episode's captions into another episode's finished video. Overlay
 * windows had the same two routes in: a preset carried them, and an episode
 * change never revisited them.
 *
 * ── Why randomising the effects cannot randomise the timing ──
 *
 * He wants to shuffle overlay looks. Once the window is not in the preset, no
 * shuffle over presets can reach it — the guarantee is structural rather than a
 * rule a future randomiser has to remember. `overlayLayersForPreset` is the one
 * place that decides what a preset carries, and it is asserted by test.
 */

export interface OverlayTimeRange {
  start_s: number
  /** null means "until the end of the episode". */
  end_s: number | null
}

export interface TimedOverlayLayer {
  id: string
  time_range?: OverlayTimeRange | null
  [key: string]: unknown
}

/** One episode's windows, keyed by layer id. */
export type EpisodeOverlayTimings = Record<string, OverlayTimeRange>

/**
 * A window is only usable if it describes a real span. A half-written or
 * malformed one is dropped rather than repaired, because guessing what someone
 * meant is how a 0 that means "start" becomes a 0 that means "unknown".
 */
export function isUsableRange(range: unknown): range is OverlayTimeRange {
  if (!range || typeof range !== 'object') return false
  const r = range as Partial<OverlayTimeRange>
  if (typeof r.start_s !== 'number' || !Number.isFinite(r.start_s) || r.start_s < 0) return false
  if (r.end_s == null) return true
  return Number.isFinite(r.end_s) && (r.end_s as number) > r.start_s
}

/**
 * The layer as a preset should carry it: everything that makes it a look, and
 * no window.
 *
 * `source_filename` is display-only and already stripped from the API payload
 * elsewhere; it is harmless in a preset and is left alone. `source_path` stays,
 * because overlay assets live in the PROJECT's `overlays/` folder rather than
 * in any episode, so a path is reusable taste and not episode state.
 */
export function overlayLayersForPreset<T extends TimedOverlayLayer>(
  layers: T[] | null | undefined,
): Array<Omit<T, 'time_range'>> {
  return (Array.isArray(layers) ? layers : []).map((layer) => {
    // Deliberately a delete on a copy rather than an allow-list. An allow-list
    // would silently drop any NEW look property someone adds to a layer, which
    // is the same class of quiet loss this module exists to prevent — and the
    // owner explicitly wants looks to travel.
    const copy = { ...layer } as Record<string, unknown>
    delete copy.time_range
    return copy as Omit<T, 'time_range'>
  })
}

/** The windows currently on screen, ready to be stored against one episode. */
export function collectOverlayTimings(
  layers: TimedOverlayLayer[] | null | undefined,
): EpisodeOverlayTimings {
  const out: EpisodeOverlayTimings = {}
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer?.id && isUsableRange(layer.time_range)) {
      out[layer.id] = { start_s: layer.time_range.start_s, end_s: layer.time_range.end_s }
    }
  }
  return out
}

/**
 * Put this episode's windows onto the layers — REPLACING, never filling.
 *
 * `if (newValue) field = newValue` with no else is the defect this whole class
 * is made of, spelled optimistically: a layer with no window in the new episode
 * would keep the previous episode's. A layer the episode says nothing about is
 * cleared to `null`, which is the documented default (always visible) and not a
 * guess.
 */
export function applyOverlayTimings<T extends TimedOverlayLayer>(
  layers: T[] | null | undefined,
  timings: EpisodeOverlayTimings | null | undefined,
): T[] {
  const map = timings && typeof timings === 'object' ? timings : {}
  return (Array.isArray(layers) ? layers : []).map((layer) => {
    const range = map[layer.id]
    return { ...layer, time_range: isUsableRange(range) ? { ...range } : null }
  })
}

export interface OverlayTimingMigration {
  /** The episode's windows after taking in whatever the preset still carried. */
  timings: EpisodeOverlayTimings
  /** Layer ids whose window was adopted from the preset. Empty on the happy path. */
  migrated: string[]
}

/**
 * Take windows out of a legacy preset without overwriting the episode's own.
 *
 * Presets saved before this release still carry `time_range` on every layer.
 * Simply ignoring them would be a silent data loss dressed up as a fix — people
 * have overlays timed right now, and that timing lives nowhere else. So a
 * legacy window is adopted as this episode's, but ONLY where the episode has
 * nothing to say: an episode that already has its own window keeps it, because
 * the episode is the authority on its own runtime and the preset is not.
 *
 * The caller announces a non-empty `migrated`, once. A value that moves without
 * a word is the quiet version of the same fault.
 */
export function migrateLegacyOverlayTimings(
  presetLayers: TimedOverlayLayer[] | null | undefined,
  episodeTimings: EpisodeOverlayTimings | null | undefined,
): OverlayTimingMigration {
  const timings: EpisodeOverlayTimings = { ...(episodeTimings || {}) }
  const migrated: string[] = []
  for (const layer of Array.isArray(presetLayers) ? presetLayers : []) {
    if (!layer?.id || !isUsableRange(layer.time_range)) continue
    if (isUsableRange(timings[layer.id])) continue
    timings[layer.id] = { start_s: layer.time_range.start_s, end_s: layer.time_range.end_s }
    migrated.push(layer.id)
  }
  return { timings, migrated }
}

/**
 * Read one episode's windows out of the project-level store.
 *
 * Storing every episode's windows in one project-scoped map rather than one
 * file per episode is deliberate: it is the smallest place that already exists,
 * and reading it cannot fail halfway. The episode CODE is the key, so a map
 * entry can never be applied to a different episode by accident.
 */
export function timingsForEpisode(
  store: Record<string, EpisodeOverlayTimings> | null | undefined,
  episodeCode: string | null | undefined,
): EpisodeOverlayTimings {
  if (!store || typeof store !== 'object' || !episodeCode) return {}
  const found = store[String(episodeCode).toUpperCase()]
  return found && typeof found === 'object' ? found : {}
}

/**
 * Write one episode's windows back, dropping the entry entirely when it has
 * none. An empty object left behind would grow one key per episode forever and
 * make "this episode has no overlay timing" indistinguishable from "this
 * episode was opened once".
 */
export function withEpisodeTimings(
  store: Record<string, EpisodeOverlayTimings> | null | undefined,
  episodeCode: string,
  timings: EpisodeOverlayTimings,
): Record<string, EpisodeOverlayTimings> {
  const next = { ...(store && typeof store === 'object' ? store : {}) }
  const key = String(episodeCode).toUpperCase()
  if (Object.keys(timings).length) next[key] = timings
  else delete next[key]
  return next
}
