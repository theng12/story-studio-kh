/**
 * Variant operations are GenStudio-published identities, not interchangeable
 * duration/resolution rows. A caller supplies the operation it can submit.
 */
export interface PublishedVideoVariant {
  operation: string
  duration_seconds: number
  resolution: string
  /**
   * The ratio this exact row has, where GenStudio publishes one per row.
   *
   * A Studio Hub video lane's `448p` class carries both 704x448 (11:7) and 448x448 (1:1),
   * so duration and resolution alone do not identify one picture. Absent means the product
   * states none (every cloud video lane), never that the ratio is 16:9.
   */
  aspect_ratio?: string
}

export function variantsForVideoOperation<T extends PublishedVideoVariant>(
  variants: readonly T[] | null | undefined,
  operation: string,
): T[] {
  return Array.isArray(variants) ? variants.filter(variant => variant.operation === operation) : []
}

export function videoVariantKey(variant: PublishedVideoVariant): string {
  // The ratio is part of the identity where it is published: two rows of the same lane can
  // share an operation, a duration and a resolution and still be two different canvases, and
  // a key that collapsed them would let the UI show one while submitting the other.
  const ratio = typeof variant.aspect_ratio === 'string' && variant.aspect_ratio.trim()
    ? `:${variant.aspect_ratio.trim()}`
    : ''
  return `${variant.operation}:${variant.duration_seconds}:${variant.resolution}${ratio}`
}
