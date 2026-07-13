/**
 * Built-in video prompt presets — curated, loopable prompts users can drop
 * into Manual Prompts mode. Seed a library that grows as we find
 * genuinely-useful templates; today: the cozy campfire loop the user
 * asked for as part of test feedback.
 *
 * Each preset is motion direction for animating an existing source image.
 * Length target ~80 words — short enough that the model doesn't drift,
 * long enough to carry lighting/camera/loop cues.
 */

export interface BuiltInVideoPrompt {
  id: string
  label: string
  hint: string
  /** The exact prompt text dropped into the Manual Prompts textarea. */
  prompt: string
  /** Grouping label for the picker; keeps the dropdown tidy if we add more. */
  category: 'ambience' | 'nature' | 'abstract' | 'other'
}

export const BUILT_IN_VIDEO_PROMPTS: BuiltInVideoPrompt[] = [
  {
    id: 'campfire-loop',
    label: '🔥 Cozy Campfire Loop',
    hint: '10 s seamlessly loopable campfire, no text, no cuts — ideal for sleep-story bed loops',
    category: 'ambience',
    prompt: [
      'Intimate close-up of a small cozy campfire at night in a quiet forest clearing.',
      'Gentle orange and gold flames dancing with subtle variation, warm glow illuminating the nearby logs and ground, soft ember sparks occasionally drifting upward.',
      'The surrounding scene stays dark and unchanged — no people, no camera movement, no pans, no cuts, no text.',
      'Lighting: warm low-key firelight only, no sudden brightness shifts.',
      'Loopability: the first and last frame must match in flame shape, ember positions, and log arrangement so the clip tiles seamlessly.',
      'Style: naturalistic, photoreal, calm and hypnotic.',
    ].join(' '),
  },
]

export function getBuiltInVideoPrompt(id: string): BuiltInVideoPrompt | null {
  return BUILT_IN_VIDEO_PROMPTS.find(p => p.id === id) || null
}
