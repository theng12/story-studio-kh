/** The codes either side of `current` in the list as shown; nothing selected → → starts at the first. */
export function adjacentEpisodeCodes(codes: string[], current: string | null | undefined): { previous: string | null; next: string | null } {
  const index = current ? codes.indexOf(current) : -1
  if (index < 0) return { previous: null, next: codes[0] ?? null }
  return { previous: codes[index - 1] ?? null, next: codes[index + 1] ?? null }
}
