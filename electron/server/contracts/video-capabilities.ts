/** Published metadata is separate from a priced, runnable video variant. */
export interface PublishedVideoCapabilities {
  duration_seconds?: { min: number; max: number; step: number; default?: number; auto?: boolean } | null
  resolutions?: string[]
  output_counts?: number[]
  support_status?: string
  support_reason?: string
  resolution_status?: string
  pricing_status?: string
  availability?: string
  activation_blockers?: string[]
  supports_start_frame?: boolean
  supports_end_frame?: boolean
  supports_reference_images?: boolean
  max_reference_images?: number | null
  reference_image_kinds?: string[]
  capability_source?: string
  capability_as_of?: string | null
}

export function publishedVideoCapabilities(value: unknown): PublishedVideoCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  const result: PublishedVideoCapabilities = {}
  const positiveInteger = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
  if ('duration_seconds' in row) {
    const duration = row.duration_seconds as PublishedVideoCapabilities['duration_seconds']
    result.duration_seconds = duration && positiveInteger(duration.min) && positiveInteger(duration.max)
      && duration.max >= duration.min && positiveInteger(duration.step)
      ? {
          min: duration.min, max: duration.max, step: duration.step,
          ...(positiveInteger(duration.default) && duration.default >= duration.min
            && duration.default <= duration.max && (duration.default - duration.min) % duration.step === 0
            ? { default: duration.default } : {}),
          ...(typeof duration.auto === 'boolean' ? { auto: duration.auto } : {}),
        }
      : null
  }
  for (const key of ['resolutions', 'reference_image_kinds', 'activation_blockers'] as const) {
    if (Array.isArray(row[key])) result[key] = row[key].filter((item): item is string => typeof item === 'string')
  }
  if (Array.isArray(row.output_counts)) result.output_counts = row.output_counts.filter(positiveInteger)
  for (const key of ['support_status', 'support_reason', 'resolution_status', 'pricing_status',
    'availability', 'capability_source', 'capability_as_of'] as const) {
    if (typeof row[key] === 'string') result[key] = row[key]
  }
  if (row.capability_as_of === null) result.capability_as_of = null
  for (const key of ['supports_start_frame', 'supports_end_frame', 'supports_reference_images'] as const) {
    if (typeof row[key] === 'boolean') result[key] = row[key]
  }
  if ((typeof row.max_reference_images === 'number' && Number.isSafeInteger(row.max_reference_images)
    && row.max_reference_images >= 0) || row.max_reference_images === null) {
    result.max_reference_images = row.max_reference_images
  }
  return result
}

/** Story consumes one clip per scene; additional paid outputs have no consumer. */
export function videoCapabilityRefusal(model: PublishedVideoCapabilities): string {
  if (model.support_status === 'update_required') {
    return model.support_reason || 'Update required: the Gateway has no verified video mapping for this model.'
  }
  if (model.output_counts?.some(count => count !== 1)) {
    return `The Gateway publishes ${model.output_counts.join(', ')} outputs per request. Story Studio requires one clip per scene; choosing an output count is unavailable. Update required before generation.`
  }
  return ''
}
