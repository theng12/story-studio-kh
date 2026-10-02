/**
 * Retired direct-provider image-edit client.
 *
 * Story Studio is a GenStudio client. GenStudio does not yet expose a
 * qualified image-edit endpoint, so this module intentionally contains no
 * provider SDK, credential, upload, polling, or network implementation.
 */

export const IMAGE_EDIT_UNAVAILABLE_MESSAGE =
  'Image editing requires a qualified Gateway image-edit endpoint.'

export const IMAGE_EDIT_MODELS = [] as const

export type ImageEditModel = string

export interface EditImageInput {
  imagePath: string
  prompt: string
  model: ImageEditModel
  apiKey?: never
  maskB64?: string
}

export interface EditImageResult {
  imageBytes: Buffer
  model_used: ImageEditModel
}

export function imageEditModelInfo(id: string): null {
  void id
  return null
}

export async function editImage(input: EditImageInput): Promise<EditImageResult> {
  void input
  throw new Error(IMAGE_EDIT_UNAVAILABLE_MESSAGE)
}
