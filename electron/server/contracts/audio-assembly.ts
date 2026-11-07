/**
 * Audio Assembly's shared vocabulary — one page, one mix, one duration.
 *
 * The page and the generator must agree on three things or the customer is
 * told something the file does not do (AGENTS.md §6/§8):
 *
 *   1. the ORDER of the mix: opening → narration → closing;
 *   2. the four reusable POOLS a layer may come from;
 *   3. how long the assembled file will be.
 *
 * Every value here is either a name the page renders or arithmetic over
 * numbers the caller measured. Nothing is a fallback for a missing
 * measurement: an unknown length is returned as `unmeasured`, never as 0.
 */

export type AudioAssemblyStage = 'opening' | 'narration' | 'closing'

export interface AudioAssemblyStageDefinition {
  stage: AudioAssemblyStage
  label: string
  description: string
}

export const AUDIO_ASSEMBLY_STAGES: readonly AudioAssemblyStageDefinition[] = [
  { stage: 'opening', label: 'Opening', description: 'The clip or music that plays before the first word.' },
  { stage: 'narration', label: 'Narration', description: 'The chapter audio, its pauses, and the voice level.' },
  { stage: 'closing', label: 'Closing', description: 'Music and layers that continue after the last word.' },
]

/**
 * The reusable pools. Music and ambience already existed; effects and
 * background voice are the same mechanism (a channel folder of audio files)
 * under their own names, so one picker serves all four.
 *
 * `folder` is the channel folder scanned for the pool. Music is `null` because
 * its pool is the richer Music Pool (cycling, per-track overrides) and must
 * not be reimplemented here.
 */
export type AudioAssemblyPoolKind = 'music' | 'ambience' | 'effects' | 'background_voice'

export interface AudioAssemblyPoolDefinition {
  kind: AudioAssemblyPoolKind
  label: string
  description: string
  folder: string | null
  /** Every optional layer starts OFF; the page turns on what this episode needs. */
  default_enabled: false
}

export const AUDIO_ASSEMBLY_POOLS: readonly AudioAssemblyPoolDefinition[] = [
  {
    kind: 'music',
    label: 'Music',
    description: 'One bed under the episode, from the channel Music Pool or chosen for this episode.',
    folder: null,
    default_enabled: false,
  },
  {
    kind: 'ambience',
    label: 'Ambience',
    description: 'A continuous atmosphere — rain, fire, wind, or a custom file.',
    folder: 'ambient',
    default_enabled: false,
  },
  {
    kind: 'effects',
    label: 'Effects',
    description: 'Reusable one-off sounds from the channel effects folder.',
    folder: 'effects',
    default_enabled: false,
  },
  {
    kind: 'background_voice',
    label: 'Background voice',
    description: 'Optional extra voices under the narration — never a replacement for it.',
    folder: 'background-voice',
    default_enabled: false,
  },
]

export function audioAssemblyPool(kind: AudioAssemblyPoolKind): AudioAssemblyPoolDefinition {
  return AUDIO_ASSEMBLY_POOLS.find(pool => pool.kind === kind)!
}

/** One layer row, in the same shape the mixer already reads for ambient tracks. */
export interface AudioAssemblyLayerTrack {
  id: string
  enabled?: boolean
  source_path: string
  /** Linear gain, 0–1. */
  volume?: number
  fade_in?: number
  fade_out?: number
  loop?: boolean
}

export interface AudioAssemblyLayerRequest {
  /** Master switch for the ambience group. When off, its rows are kept but not mixed. */
  ambience?: { enabled?: boolean }
  ambient_tracks?: AudioAssemblyLayerTrack[]
  effects_tracks?: AudioAssemblyLayerTrack[]
  background_voice_tracks?: AudioAssemblyLayerTrack[]
}

/**
 * A layer's identity is its pool and its file, so the same ambience keeps the
 * same id when it is disabled, re-enabled, or a preset is applied. A random id
 * made the same clip a different row on every visit.
 */
export function audioAssemblyLayerId(kind: AudioAssemblyPoolKind, sourcePath: string): string {
  const text = `${kind}:${String(sourcePath || '').trim()}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${kind}_${(hash >>> 0).toString(36)}`
}

/**
 * The rows the mixer should actually hear. Disabled groups and disabled rows
 * are excluded here, never by deleting them from the page's state: a pick the
 * customer made must survive the switch that turns it off (§5).
 */
export function activeAudioAssemblyLayers(
  request: AudioAssemblyLayerRequest,
): Array<{
  kind: 'ambience' | 'effects' | 'background_voice'
  id: string
  enabled: true
  source_path: string
  volume: number
  fade_in: number
  fade_out: number
  loop?: boolean
}> {
  const groups: Array<{ kind: 'ambience' | 'effects' | 'background_voice'; rows?: AudioAssemblyLayerTrack[] }> = [
    { kind: 'ambience', rows: request.ambient_tracks },
    { kind: 'effects', rows: request.effects_tracks },
    { kind: 'background_voice', rows: request.background_voice_tracks },
  ]
  if (request.ambience?.enabled === false) groups[0]!.rows = undefined
  return groups.flatMap(({ kind, rows }) => (rows || [])
    .filter(row => row && row.enabled !== false && typeof row.source_path === 'string' && row.source_path.length > 0)
    .map(row => ({
      ...row,
      kind,
      enabled: true as const,
      // The page always sends a level; an absent one stays silent rather than
      // borrowing a level the customer never chose.
      volume: Number(row.volume) || 0,
      fade_in: Number(row.fade_in) || 0,
      fade_out: Number(row.fade_out) || 0,
    })))
}

export interface AssembledNarrationParts {
  chapter_sec: number
  chapter_gap_sec?: number
  chunk_pause_sec?: number
  /** `null` = the intro clip is chosen but its length was not measured here. */
  intro_clip_sec?: number | null
  intro_gap_sec?: number
}

export interface DurationMeasurement {
  seconds: number
  /** Parts that are known to exist but could not be measured; never counted as zero. */
  unmeasured: string[]
}

/** The narration master the mixer runs over: chapters, pauses, and the opening clip. */
export function assembledNarrationDuration(parts: AssembledNarrationParts): DurationMeasurement {
  const unmeasured: string[] = []
  let seconds = Math.max(0, Number(parts.chapter_sec) || 0)
    + Math.max(0, Number(parts.chapter_gap_sec) || 0)
    + Math.max(0, Number(parts.chunk_pause_sec) || 0)
    + Math.max(0, Number(parts.intro_gap_sec) || 0)
  if (parts.intro_clip_sec === null || parts.intro_clip_sec === undefined) {
    if ((Number(parts.intro_gap_sec) || 0) > 0) unmeasured.push('intro clip length')
  } else {
    seconds += Math.max(0, Number(parts.intro_clip_sec) || 0)
  }
  return { seconds, unmeasured }
}

export interface AudioAssemblyDurationParts {
  /** The assembled narration track (chapters, pauses, and any intro clip). */
  narration_sec: number
  music_lead_in_sec?: number
  /** `null` = resolved by the merge from Video Assembly's closing settings. */
  closing_tail_sec?: number | null
}

/**
 * The one definition of the assembled file's length. The generator passes the
 * real tail it resolved; the page passes `null` and is told the tail is not
 * counted rather than being shown a number that excludes it.
 */
export function expectedAudioAssemblyDuration(parts: AudioAssemblyDurationParts): DurationMeasurement {
  const unmeasured: string[] = []
  let seconds = Math.max(0, Number(parts.narration_sec) || 0)
    + Math.max(0, Number(parts.music_lead_in_sec) || 0)
  if (parts.closing_tail_sec === null || parts.closing_tail_sec === undefined) {
    unmeasured.push('closing tail')
  } else {
    seconds += Math.max(0, Number(parts.closing_tail_sec) || 0)
  }
  return { seconds, unmeasured }
}
