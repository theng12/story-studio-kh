export interface TitleImageState {
  enabled: boolean
  image_path: string
  duration: number
  transition_type: string
  transition_duration: number
}

export type TitleImagePresetData = Omit<TitleImageState, 'image_path'>

/** Title-image timing is reusable; the selected image belongs to one episode. */
export function snapshotTitleImagePreset(source: TitleImageState): TitleImagePresetData {
  return {
    enabled: source.enabled,
    duration: source.duration,
    transition_type: source.transition_type,
    transition_duration: source.transition_duration,
  }
}

/** Apply reusable settings without ever restoring a legacy episode image path. */
export function applyTitleImagePreset(
  target: TitleImageState,
  data: Partial<TitleImageState> | null | undefined,
): void {
  if (!data) return
  if (typeof data.enabled === 'boolean') target.enabled = data.enabled
  if (typeof data.duration === 'number') target.duration = data.duration
  if (typeof data.transition_type === 'string') target.transition_type = data.transition_type
  if (typeof data.transition_duration === 'number') target.transition_duration = data.transition_duration
}
