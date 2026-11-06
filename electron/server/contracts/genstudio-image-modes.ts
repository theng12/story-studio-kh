export interface GenStudioImageMode {
  id: 'txt2img' | 'edit'
  label: 'Text to image' | 'Reference to image'
  available: boolean
  reason?: string | null
  references?: { min?: number; max?: number; max_dimension?: number }
}

/** Only the published mode contract offers a mode; legacy flags cannot create one. */
export function publishedImageModes(value: unknown): GenStudioImageMode[] | undefined {
  if (!Array.isArray(value)) return undefined
  const modes: GenStudioImageMode[] = []
  for (const row of value) {
    if (!row || (row.id !== 'txt2img' && row.id !== 'edit') || typeof row.available !== 'boolean'
      || modes.some(mode => mode.id === row.id)) continue
    const references: NonNullable<GenStudioImageMode['references']> = {}
    for (const key of ['min', 'max', 'max_dimension'] as const) {
      const limit = row.references?.[key]
      if (Number.isSafeInteger(limit) && limit >= 0) references[key] = limit
    }
    modes.push({
      id: row.id,
      label: row.id === 'txt2img' ? 'Text to image' : 'Reference to image',
      available: row.available,
      ...(typeof row.reason === 'string' || row.reason === null ? { reason: row.reason } : {}),
      ...(Object.keys(references).length ? { references } : {}),
    })
  }
  return modes
}

export function imageModeId(mode: 'text2img' | 'img2img'): GenStudioImageMode['id'] {
  return mode === 'img2img' ? 'edit' : 'txt2img'
}
