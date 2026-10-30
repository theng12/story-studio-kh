/** An image-backed on-screen label. Coordinates are fractions of the asset. */
export interface LabelDesign {
  id: `label:${string}`
  name: string
  family: string
  asset: string
  text_box: { x: number; y: number; width: number; height: number }
  font_size: number
  text_color: string
  anchor?: { x: number; y: number }
}

/** Names are identifiers, never paths supplied by a timeline. */
export function isLabelDesignId(value: unknown): value is `label:${string}` {
  return typeof value === 'string' && /^label:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 90
}
