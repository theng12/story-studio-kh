/**
 * Apply a saved Audio Assembly preset's ambient rows onto the session's live
 * clips (`audio-merge.vue`'s preset `apply`).
 *
 * The preset carries settings only — `usePresets` strips `source_path` at the
 * read boundary — and each row keeps the `id` it had when it was saved. Rows
 * are therefore never replaced wholesale:
 *
 *   - a preset row whose id names a live clip writes its settings onto THAT
 *     clip, so a reorder can never move a fade or volume onto another clip;
 *   - a preset row matching no live clip (a session that built its own clips)
 *     applies positionally to the first live clip still without settings —
 *     the preset still restores its look, the clip keeps its id and source;
 *   - rows left over after every live clip is covered append as the layers
 *     they define (this is also the mount-time auto-apply, where no live clip
 *     exists yet);
 *   - a live clip the preset does not name is never dropped.
 *
 * Only the settings keys are copied. Identity (`id`), the clip (`source_path`)
 * and its display name stay the session's own.
 */

const AMBIENT_SETTING_KEYS = ['enabled', 'volume', 'fade_in', 'fade_out', 'loop'] as const

export function applyAmbientPresetRows<T extends { id: string }>(
  live: T[],
  presetTracks: Array<Record<string, any>>,
): void {
  const indexById = new Map(live.map((row, index) => [row.id, index]))
  const taken = new Set<number>()
  const matched = new Set(presetTracks.map(row => indexById.get(row.id)).filter(index => index !== undefined))
  const leftover: Array<Record<string, any>> = []

  for (const row of presetTracks) {
    const byId = indexById.get(row.id)
    const index = byId !== undefined && !taken.has(byId)
      ? byId
      : live.findIndex((_, i) => !taken.has(i) && !matched.has(i))
    if (index < 0) {
      leftover.push(row)
      continue
    }
    taken.add(index)
    const target = live[index]!
    for (const key of AMBIENT_SETTING_KEYS) {
      if (row[key] !== undefined) (target as any)[key] = row[key]
    }
  }

  for (const row of leftover) live.push({ ...row } as unknown as T)
}
