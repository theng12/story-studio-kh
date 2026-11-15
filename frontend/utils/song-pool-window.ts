/**
 * Song Pool row readiness (1.4.402). One place decides what "in window" and "free for the next
 * episode" mean on the page, matching the server's builder context: a song is held when a rendered
 * use OR a saved draft sits in the no-repeat window; a free song is drawable and held by neither.
 */
export interface PoolWindowBasis {
  slug: string
  windowCodes: readonly string[]
  blocked: Readonly<Record<string, string>>
  poolId: string
}

export const poolSongKey = (poolId: string, song: { id: string }): string => `${poolId}/${song.id}`

/** The rendered episode code holding this song in the window, if any. */
export function renderedInWindow(song: any, basis: PoolWindowBasis): string {
  const codes = new Set(basis.windowCodes)
  const use = (song.episodes || []).find((e: any) => e.project_slug === basis.slug && codes.has(e.code))
  return use?.code || ''
}

/** The code holding this song — rendered first, otherwise a saved draft. */
export function holdingCode(song: any, basis: PoolWindowBasis): string {
  return renderedInWindow(song, basis) || basis.blocked[poolSongKey(basis.poolId, song)] || ''
}

export function inWindow(song: any, basis: PoolWindowBasis): boolean {
  return !!holdingCode(song, basis)
}

export function isDrawable(song: any): boolean {
  return song.status === 'ready' && song.enabled && !song.file_missing && Number(song.duration_s) > 0
}

export function freeForNext(song: any, basis: PoolWindowBasis): boolean {
  return isDrawable(song) && !inWindow(song, basis)
}

/** What the "in window" chip names: a rendered episode or a saved plan. */
export function holdingLabel(song: any, basis: PoolWindowBasis): string {
  const rendered = renderedInWindow(song, basis)
  if (rendered) return rendered
  const draft = basis.blocked[poolSongKey(basis.poolId, song)]
  return draft ? `${draft} (saved plan)` : ''
}

/** Select-all acts on the rows actually shown, never on filtered-out rows. */
export function toggleAllShown(shownIds: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected)
  const all = shownIds.length > 0 && shownIds.every(id => next.has(id))
  for (const id of shownIds) all ? next.delete(id) : next.add(id)
  return next
}
