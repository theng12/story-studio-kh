export type ProjectSettingsSaveSection = 'identity' | 'publishing' | 'files'

export function projectSettingsSavePlan(
  section: ProjectSettingsSaveSection,
  draft: Record<string, any>,
  savedSeasonSize: number,
) {
  if (section === 'identity') {
    return { project: { name: draft.name }, config: null, hasPendingSeasonSize: false }
  }
  if (section === 'publishing') {
    return {
      // v1.4.249: Publishing owns no project.json field (the unused channel link is gone).
      project: null,
      config: {
        category_id: typeof draft.category_id === 'number' && draft.category_id > 0 ? draft.category_id : undefined,
        // `undefined` is omitted by JSON.stringify, which cannot clear a
        // previously persisted boolean override. `null` is the established
        // explicit-inherit sentinel: upload settings resolve booleans only,
        // so it follows the current app default without inventing ON or OFF.
        mark_as_ai_generated: typeof draft.mark_as_ai_generated === 'boolean'
          ? draft.mark_as_ai_generated
          : null,
      },
      hasPendingSeasonSize: false,
    }
  }
  return {
    project: { episode_prefix: draft.episode_prefix, season_prefix: draft.season_prefix },
    config: null,
    hasPendingSeasonSize: Number.isInteger(draft.season_size)
      && draft.season_size >= 1
      && draft.season_size !== savedSeasonSize,
  }
}
