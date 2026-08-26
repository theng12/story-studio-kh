import { describeChatRate } from './genstudio-credit-cost'
import type { GenStudioCostTier } from './genstudio-cost-tier'
import { describeModelRetirement, isRetiring } from './genstudio-model-retirement'

/** The live, eligible row returned by the thumbnail-reference vision route. */
export interface ThumbnailVisionModel {
  id: string
  display_name: string
  supported_detail_levels: Array<'low' | 'high' | 'auto'>
  max_input_images: number
  accepted_image_mime_types: string[]
  max_image_bytes: number
  max_image_dimension: number
  input_credits_per_million_tokens?: number
  output_credits_per_million_tokens?: number
  minimum_credits: number
  price_version: string
  cost_tier?: GenStudioCostTier
  /** GenStudio's published retirement flag and withdrawal date. Forwarded by
   *  the vision route for the same reason the language catalogue forwards
   *  them: this menu is a second place a customer commits to a chat product. */
  deprecation_warning?: boolean
  retires_at?: string | null
}

export function thumbnailVisionModelMenuOption(model: ThumbnailVisionModel) {
  const rate = describeChatRate(model)
  // This route publishes the name as `display_name`; the retirement vocabulary
  // reads `label`, the way the language catalogue delivers it. One adapter,
  // written once, rather than the spread order silently deciding it.
  const retirement = { ...model, label: model.display_name }
  return {
    id: model.id,
    label: model.display_name,
    group: 'GenStudio KH · Vision only',
    meta: `${model.max_input_images} image · ${model.supported_detail_levels.join(', ')} detail`,
    price: rate.text,
    priceTitle: rate.title,
    badges: [
      { label: 'Vision', tone: 'info' as const },
      { label: 'JSON', tone: 'neutral' as const },
      ...(isRetiring(retirement)
        ? [{ label: 'Retiring', tone: 'warning' as const, title: describeModelRetirement(retirement) }]
        : []),
    ],
    costTier: model.cost_tier,
  }
}
