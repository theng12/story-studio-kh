import type { SceneMotionProfile } from '../models/types.js'

/** App-owned motion behavior selectable by trusted Formula data. */
export const MOTION_PROFILE_IDS = ['ambient-documentary'] as const
export type MotionProfileId = typeof MOTION_PROFILE_IDS[number]

export const MOTION_PROFILES: Readonly<Record<MotionProfileId, SceneMotionProfile>> = {
  'ambient-documentary': {
    id: 'ambient-documentary',
    label: 'Ambient documentary',
    description: 'Follows scene role first, then uses a calm stable mix: evidence views hold still, landscapes drift gently, and only genuine phenomena receive limited animation.',
    opening_duration_sec: 900,
    opening: { still: 20, gentle: 55, limited: 25 },
    settled: { still: 40, gentle: 50, limited: 10 },
  },
}

export function resolveMotionProfile(id: string): SceneMotionProfile {
  const profile = MOTION_PROFILES[id as MotionProfileId]
  if (!profile) throw new Error(`Unknown motion profile: ${id}`)
  return {
    ...profile,
    opening: { ...profile.opening },
    settled: { ...profile.settled },
  }
}
