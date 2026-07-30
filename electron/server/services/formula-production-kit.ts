import type { FormulaEpisodeProfile, Niche } from '../models/types.js'

export function resolveFormulaEpisodeProfile(
  niche: Niche,
  dimensions?: Record<string, string>,
): FormulaEpisodeProfile | undefined {
  const value = dimensions?.['episode-profile']
  if (!value) return undefined
  return niche.productionKit?.episodeProfiles?.find(profile => profile.ideaAxisValue === value)
}

/** Enforce only machine-readable title boundaries. Creative wording remains
 * with the idea model, while Formula authors can guarantee that one profile
 * claims a publishing suffix and another never inherits it accidentally. */
export function applyFormulaEpisodeProfileTitle(
  input: string,
  niche: Niche,
  dimensions?: Record<string, string>,
): string {
  let title = input.trim()
  const profile = resolveFormulaEpisodeProfile(niche, dimensions)

  for (const forbidden of profile?.forbiddenTitleSuffixes || []) {
    const suffix = forbidden.trim()
    if (suffix && title.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())) {
      title = title.slice(0, Math.max(0, title.length - suffix.length))
        .replace(/\s*[|—–:-]\s*$/, '')
        .trim()
    }
  }

  const suffix = profile?.titleSuffix || ''
  if (suffix && !title.toLocaleLowerCase().endsWith(suffix.trim().toLocaleLowerCase())) {
    title = `${title}${suffix}`.trim()
  }
  return title
}
