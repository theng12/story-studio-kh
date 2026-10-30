/** An image-backed on-screen label. All geometry is a fraction of the asset. */
export interface LabelDesign {
  id: `label:${string}`
  name: string
  family: string
  /** Free-form grouping used by the picker, so a new themed set is only data. */
  theme: string
  asset: string
  /** True when the design points at something and carries an anchor. */
  pointing: boolean
  /** Where the design's pointer sits on the asset. */
  anchor?: { x: number; y: number }
  /** Empty area of the asset the cue's words are drawn into. */
  text_box: { x: number; y: number; width: number; height: number }
  /** Nominal cap height as a fraction of the asset height. */
  font_size: number
  text_color: string
  /** Motions this design suits. */
  motions: string[]
}

/** Names are identifiers, never paths supplied by a timeline. */
export function isLabelDesignId(value: unknown): value is `label:${string}` {
  return typeof value === 'string' && /^label:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 90
}
