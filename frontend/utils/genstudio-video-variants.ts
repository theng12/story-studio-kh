/**
 * Variant operations are GenStudio-published identities, not interchangeable
 * duration/resolution rows. A caller supplies the operation it can submit.
 */
export interface PublishedVideoVariant {
  operation: string
  duration_seconds: number
  resolution: string
}

export function variantsForVideoOperation<T extends PublishedVideoVariant>(
  variants: readonly T[] | null | undefined,
  operation: string,
): T[] {
  return Array.isArray(variants) ? variants.filter(variant => variant.operation === operation) : []
}

export function videoVariantKey(variant: PublishedVideoVariant): string {
  return `${variant.operation}:${variant.duration_seconds}:${variant.resolution}`
}
