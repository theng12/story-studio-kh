export type GenStudioAvailabilityReason = 'daily_quota_depleted' | 'temporary_backpressure'

interface GenStudioAvailabilityRow {
  available: boolean
  availability_reason?: GenStudioAvailabilityReason | null
  available_again_at?: string | null
}

/**
 * Explain a temporary GenStudio availability state without trusting arbitrary
 * upstream prose or inventing a reset time. An empty result deliberately lets
 * the picker keep its existing generic legacy wording.
 */
export function describeGenStudioAvailability(
  model: GenStudioAvailabilityRow,
  now = Date.now(),
  locale?: string,
): string {
  if (model.available || !model.availability_reason) return ''

  const reason = model.availability_reason === 'daily_quota_depleted'
    ? 'Daily capacity is currently depleted.'
    : model.availability_reason === 'temporary_backpressure'
      ? 'Temporarily unavailable while Gateway manages provider capacity.'
      : ''
  if (!reason) return ''

  const timestamp = model.available_again_at ? Date.parse(model.available_again_at) : NaN
  if (Number.isFinite(timestamp) && timestamp > now) {
    try {
      const time = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(timestamp)
      return `${reason} Available again at ${time}.`
    } catch {
      // An invalid browser locale must not hide the availability reason.
    }
  }
  return `${reason} Refresh to check availability.`
}
