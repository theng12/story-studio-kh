import type { FormulaEpisodeProfile, Niche } from '../models/types.js'

export function resolveFormulaEpisodeProfile(
  niche: Niche,
  dimensions?: Record<string, string>,
): FormulaEpisodeProfile | undefined {
  const value = dimensions?.['episode-profile']
  if (!value) return undefined
  return niche.productionKit?.episodeProfiles?.find(profile => profile.ideaAxisValue === value)
}

/** Apply the declarative runtime fields owned by one durable episode mode.
 * Unset profile fields inherit the Formula, preserving existing packs. */
export function applyFormulaEpisodeProfile(
  niche: Niche,
  dimensions?: Record<string, string>,
): Niche {
  const profile = resolveFormulaEpisodeProfile(niche, dimensions)
  if (!profile) return niche
  return {
    ...niche,
    introDefaults: profile.introDefaults
      ? { ...profile.introDefaults, beats: profile.introDefaults.beats?.map(beat => typeof beat === 'string' ? beat : { ...beat }) }
      : niche.introDefaults,
    scriptStructure: profile.scriptStructure
      ? {
          ...profile.scriptStructure,
          chapterCountRange: profile.scriptStructure.chapterCountRange
            ? [...profile.scriptStructure.chapterCountRange] as [number, number]
            : undefined,
          lengthMinutesRange: profile.scriptStructure.lengthMinutesRange
            ? [...profile.scriptStructure.lengthMinutesRange] as [number, number]
            : undefined,
          durationPresets: profile.scriptStructure.durationPresets?.slice(),
          pacingArc: profile.scriptStructure.pacingArc?.slice(),
          additionalRules: profile.scriptStructure.additionalRules?.slice(),
        }
      : niche.scriptStructure,
    recencyAvoidance: profile.recencyAvoidance
      ? {
          ...profile.recencyAvoidance,
          extractPatterns: profile.recencyAvoidance.extractPatterns.slice(),
          scopes: profile.recencyAvoidance.scopes?.slice(),
        }
      : niche.recencyAvoidance,
    defaultNarratorStyleId: profile.narratorStyleId ?? niche.defaultNarratorStyleId,
    ideaSystemPromptRole: profile.ideaSystemPromptRole ?? niche.ideaSystemPromptRole,
    ideaGuidanceText: profile.ideaGuidanceText ?? niche.ideaGuidanceText,
    scriptContext: profile.scriptContext ?? niche.scriptContext,
    scriptSystemPromptRole: profile.scriptSystemPromptRole ?? niche.scriptSystemPromptRole,
    scriptClosingHint: profile.scriptClosingHint ?? niche.scriptClosingHint,
  }
}

/** Resolve the durable campaign dimensions for an accepted episode code. */
export async function resolveFormulaEpisodeDimensions(
  slug: string,
  episodeId?: string,
): Promise<Record<string, string> | undefined> {
  if (!episodeId) return undefined
  const { getIdeas } = await import('./idea-manager.js')
  const wanted = episodeId.toUpperCase()
  return (await getIdeas(slug)).find(idea => (idea.episode_code || '').toUpperCase() === wanted)?.idea_dimensions
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
