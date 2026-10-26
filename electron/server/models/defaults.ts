/**
 * Story Studio does not maintain a provider catalog. GenStudio is the only
 * generation boundary and supplies the live model and voice inventory.
 *
 * Empty defaults deliberately prevent new projects from inheriting retired
 * provider ids, prices, or routing metadata from an old local installation.
 */

import type { AudioModelConfig, ImageModelConfig, VoicePreset } from './types.js'

export const DEFAULT_IMAGE_MODELS: Record<string, ImageModelConfig> = {}
export const DEFAULT_AUDIO_MODELS: Record<string, AudioModelConfig> = {}
export const DEFAULT_VOICE_PRESETS: VoicePreset[] = []
