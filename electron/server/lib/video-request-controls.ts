/** Only published, supported values may become top-level Gateway video fields. */
// shortcut: extra controls support booleans; add other types when their Gateway request contract is confirmed.
const RESERVED = new Set([
  'prompt', 'model', 'model_id', 'mode', 'operation', 'aspect_ratio', 'resolution',
  'duration_seconds', 'duration', 'durationSec', 'aspectRatio', 'videoMode',
  'output_count', 'outputCount', 'n', 'reference_asset_ids', 'end_image_asset_id',
  'reference_asset_id', 'reference_images', 'job_group',
  'job_group_id', 'provider', 'audio', 'api_key', '__proto__', 'constructor', 'prototype',
])

export function videoRequestControls(
  published: readonly { name: string; type: string }[] | null | undefined,
  selected: unknown,
): Record<string, boolean> {
  if (published?.some(control => control.type !== 'boolean')) {
    throw new Error('Update Story Studio to use this model’s newly published video controls. No generation was submitted.')
  }
  if (selected === undefined) return {}
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    throw new Error('video_controls must contain published control values.')
  }
  return Object.fromEntries(Object.entries(selected).map(([name, value]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || RESERVED.has(name)
      || !published?.some(control => control.name === name && control.type === 'boolean')) {
      throw new Error(`The selected model does not publish a supported ${name} control. Refresh its capabilities or update Story Studio.`)
    }
    if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`)
    return [name, value]
  }))
}

/** Stable field order keeps retries attached to the exact purchase. */
export function videoControlIdentity(values?: Record<string, boolean>): Record<string, boolean> | undefined {
  const entries = Object.entries(values || {})
  for (const [name, value] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || RESERVED.has(name) || typeof value !== 'boolean') {
      throw new Error('Unsupported video control field. Refresh capabilities or update Story Studio.')
    }
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return entries.length ? Object.fromEntries(entries) : undefined
}
