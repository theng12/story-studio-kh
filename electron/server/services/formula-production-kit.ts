import type { FormulaEpisodeProfile, Niche } from '../models/types.js'

function cloneIntroDefaults(input: Niche['introDefaults']): Niche['introDefaults'] {
  if (!input) return undefined
  return {
    ...input,
    beats: input.beats?.map(beat => typeof beat === 'string' ? beat : { ...beat }),
  }
}

function cloneScriptStructure(input: Niche['scriptStructure']): Niche['scriptStructure'] {
  if (!input) return undefined
  return {
    ...input,
    chapterCountRange: input.chapterCountRange?.slice() as [number, number] | undefined,
    lengthMinutesRange: input.lengthMinutesRange?.slice() as [number, number] | undefined,
    durationPresets: input.durationPresets?.slice(),
    visualPacingProfile: input.visualPacingProfile
      ? {
          ...input.visualPacingProfile,
          opening: { ...input.visualPacingProfile.opening },
          settled: { ...input.visualPacingProfile.settled },
        }
      : undefined,
    motionProfile: input.motionProfile
      ? {
          ...input.motionProfile,
          opening: { ...input.motionProfile.opening },
          settled: { ...input.motionProfile.settled },
        }
      : undefined,
    pacingArc: input.pacingArc?.slice(),
    additionalRules: input.additionalRules?.slice(),
  }
}

function cloneRecencyAvoidance(input: Niche['recencyAvoidance']): Niche['recencyAvoidance'] {
  if (!input) return undefined
  return {
    ...input,
    extractPatterns: input.extractPatterns.slice(),
    scopes: input.scopes?.slice(),
  }
}

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
  const parentIntroDefaults = cloneIntroDefaults(niche.introDefaults)
  const introDefaults = profile.introDefaults
    ? {
        ...parentIntroDefaults,
        ...cloneIntroDefaults(profile.introDefaults),
        beats: (profile.introDefaults.beats ?? parentIntroDefaults?.beats)
          ?.map(beat => typeof beat === 'string' ? beat : { ...beat }),
      }
    : parentIntroDefaults
  const parentStructure = cloneScriptStructure(niche.scriptStructure)
  const overrideStructure = profile.scriptStructure
  const scriptStructure = overrideStructure
    ? {
        ...parentStructure,
        ...overrideStructure,
        chapterCountRange: (overrideStructure.chapterCountRange ?? parentStructure?.chapterCountRange)
          ?.slice() as [number, number] | undefined,
        lengthMinutesRange: (overrideStructure.lengthMinutesRange ?? parentStructure?.lengthMinutesRange)
          ?.slice() as [number, number] | undefined,
        durationPresets: (overrideStructure.durationPresets ?? parentStructure?.durationPresets)?.slice(),
        visualPacingProfile: overrideStructure.visualPacingProfile
          ? {
              ...parentStructure?.visualPacingProfile,
              ...overrideStructure.visualPacingProfile,
              opening: { ...parentStructure?.visualPacingProfile?.opening, ...overrideStructure.visualPacingProfile.opening },
              settled: { ...parentStructure?.visualPacingProfile?.settled, ...overrideStructure.visualPacingProfile.settled },
            }
          : parentStructure?.visualPacingProfile,
        motionProfile: overrideStructure.motionProfile
          ? {
              ...parentStructure?.motionProfile,
              ...overrideStructure.motionProfile,
              opening: { ...parentStructure?.motionProfile?.opening, ...overrideStructure.motionProfile.opening },
              settled: { ...parentStructure?.motionProfile?.settled, ...overrideStructure.motionProfile.settled },
            }
          : parentStructure?.motionProfile,
        pacingArc: (overrideStructure.pacingArc ?? parentStructure?.pacingArc)?.slice(),
        additionalRules: (overrideStructure.additionalRules ?? parentStructure?.additionalRules)?.slice(),
      }
    : parentStructure
  const parentRecencyAvoidance = cloneRecencyAvoidance(niche.recencyAvoidance)
  const recencyAvoidance = profile.recencyAvoidance
    ? (() => {
        const override = cloneRecencyAvoidance(profile.recencyAvoidance)!
        return {
          ...parentRecencyAvoidance,
          ...override,
          extractPatterns: (profile.recencyAvoidance.extractPatterns ?? parentRecencyAvoidance?.extractPatterns ?? []).slice(),
          scopes: (profile.recencyAvoidance.scopes ?? parentRecencyAvoidance?.scopes)?.slice(),
        }
      })()
    : parentRecencyAvoidance
  return {
    ...niche,
    introDefaults,
    scriptStructure,
    recencyAvoidance,
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
