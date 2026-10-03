/**
 * The "How much runs at once" numbers (Settings → Performance & recovery).
 *
 * v1.4.249 — one row per number with a one-line hint; the long reasoning that
 * used to sit under every dropdown is the row's `help`, shown behind "More".
 * `recommended` is shown as a quiet marker instead of being written into every
 * option label. Server keys and clamping are unchanged (routes/app-settings.ts).
 */
export type ThroughputKey = 'subtitleEpisodes' | 'llmJobs' | 'imageEpisodes' | 'thumbnailEpisodes' | 'imageFanout'
  | 'outlineHeadroom' | 'languageTimeoutMinutes' | 'languageFloorTps' | 'languagePreferredTps'

export interface ThroughputField {
  key: ThroughputKey
  server: string
  label: string
  hint: string
  help: string
  recommended: string | number
  recommendedLabel?: string
  unit?: string
  allowsAuto?: boolean
  /** The number a field starts at when switched from Auto to a number. */
  autoSeed?: number
  advanced?: boolean
  input: { min: number; max: number; step: number }
}

export const THROUGHPUT_FIELDS: ThroughputField[] = [
  {
    key: 'llmJobs', server: 'llm_concurrency', label: 'Writing jobs at once',
    hint: 'Ideas, research, scripts, metadata, prompts and scene plans share this.',
    help: 'How many writing requests Story Studio sends at once; the Gateway still decides how many it runs.',
    recommended: 8, input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'imageEpisodes', server: 'image_episode_concurrency', label: 'Episodes making scene images',
    hint: 'Scene Review and Image Pool, on your own Macs.',
    help: 'Scene Review and Image Pool share this — the work that runs on locally hosted models. Thumbnails have their own number, so a few cloud thumbnails can never hold up this queue.',
    recommended: 2, input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'thumbnailEpisodes', server: 'thumbnail_episode_concurrency', label: 'Episodes making thumbnails',
    hint: 'A separate queue, so thumbnails never hold up scene images.',
    help: 'Separate from scene images because thumbnails usually run on a cloud model while Scene Review runs on a locally hosted one. Raising this cannot slow that queue down, and a thumbnail batch cannot stall it.',
    recommended: 3, input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'subtitleEpisodes', server: 'subtitle_episode_concurrency', label: 'Episodes transcribing',
    hint: 'Each episode still transcribes all of its chapters together.',
    help: 'This is how many EPISODES start transcribing at the same time. Thirty at once overwhelmed the available capacity and lost a third of the work.',
    recommended: 2, input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'imageFanout', server: 'image_fanout_per_episode', label: 'Image requests per episode',
    hint: 'Auto follows what your Gateway allows.',
    help: 'Covers image requests inside ONE episode, including Scene Review and thumbnails. Auto follows what your account allows, so it rises by itself as your capacity grows. A number only limits what Story Studio sends; the Gateway still decides what runs.',
    recommended: 'auto', recommendedLabel: 'Auto', allowsAuto: true, autoSeed: 50, input: { min: 1, max: 500, step: 1 },
  },
  {
    key: 'outlineHeadroom', server: 'outline_chapter_headroom', label: 'Extra chapters an outline may add',
    hint: 'How far past the target an outline may run. Never shorter.',
    help: 'A longer outline is kept — more runtime — and it is never allowed to come back SHORT.',
    recommended: 2, recommendedLabel: '2×', unit: '× target', advanced: true, input: { min: 1, max: 10, step: 0.5 },
  },
  {
    key: 'languageTimeoutMinutes', server: 'genstudio_language_timeout_minutes', label: 'Time limit for one writing request',
    hint: 'How long to wait before giving up on one request.',
    help: 'A big scene-plan batch or a long chapter is written while the request is still open. Longer is safer — a request cut off part-way is still charged for, and the writing is lost — but a genuinely stuck request takes this long to notice. Anything from 5 to 240 minutes.',
    recommended: 30, unit: 'min', advanced: true, input: { min: 5, max: 240, step: 5 },
  },
  {
    key: 'languageFloorTps', server: 'language_floor_tokens_per_second', label: 'Slowest writing speed you accept',
    hint: 'Only used for a warning on Scene Plan. Nothing is refused.',
    help: 'In tokens a second. Nothing is refused or rerouted because of this — it is only used to warn you, on the Scene Plan page, when a batch looks too big to come back in time even from the slowest provider you would accept.',
    recommended: 25, unit: 'tok/s', advanced: true, input: { min: 1, max: 10_000, step: 5 },
  },
  {
    key: 'languagePreferredTps', server: 'language_preferred_tokens_per_second', label: 'Writing speed you expect',
    hint: 'Also only used in that Scene Plan warning.',
    help: 'Also tokens a second: the speed the warning says most providers actually manage, so you can see how much of the worry is worst case.',
    recommended: 50, unit: 'tok/s', advanced: true, input: { min: 1, max: 10_000, step: 5 },
  },
]

/** Server response → editor values. Missing keys fall back to the recommended number. */
export function throughputFromServer(r: Record<string, any> | null | undefined): Record<ThroughputKey, string | number> {
  const out = {} as Record<ThroughputKey, string | number>
  for (const f of THROUGHPUT_FIELDS) {
    const v = r?.[f.server]
    out[f.key] = v === undefined || v === null ? f.recommended : (v === 'auto' ? 'auto' : Number(v))
  }
  return out
}

/** Editor values → the PUT /app-settings/concurrency body. */
export function throughputPayload(values: Record<ThroughputKey, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const f of THROUGHPUT_FIELDS) {
    const v = values[f.key]
    out[f.server] = f.allowsAuto && v === 'auto' ? 'auto' : Number(v)
  }
  return out
}
