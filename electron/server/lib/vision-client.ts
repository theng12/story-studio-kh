/**
 * GenStudio-only vision boundary.
 *
 * Story Studio previously sent reference images directly to OpenAI or a local
 * Chat Studio instance. GenStudio does not yet publish a qualified image-input
 * LLM endpoint, so those paths are deliberately unavailable. Keeping this
 * small compatibility module lets historical UI and queued-job evidence fail
 * safely without retaining a hidden provider bypass.
 */

export const GENSTUDIO_VISION_UNAVAILABLE =
  'Image analysis is temporarily unavailable. The Gateway must publish and qualify an image-input LLM route before this feature can be enabled.'

export function isBrollVisionModelSupported(_modelId: string | undefined | null): boolean {
  return false
}

export interface AnalyzeStyleInput {
  imagePath: string
  model?: string
  apiKey?: string
  baseURL?: string
  focus?: string | null
  mode?: 'style' | 'character' | 'tags'
}

export interface AnalyzeStyleResult {
  style_text: string
  model_used: string
}
