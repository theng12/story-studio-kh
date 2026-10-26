import { describeChatRate } from './genstudio-credit-cost'
import type { GenStudioLlmCostTier } from './genstudio-cost-tier'
import { describeModelRetirement, isRetiring } from './genstudio-model-retirement'
import {
  describeRelaxedQueueHint,
  isRelaxedQueue,
  queueClassGroupLabel,
  type RelaxedQueueHint,
} from './genstudio-relaxed-queue'

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
  /** Undiscounted rates, present only while GenStudio applies a sale to this
   *  account. Shown struck through beside what the account actually pays. */
  standard_input_credits_per_million_tokens?: number | null
  standard_output_credits_per_million_tokens?: number | null
  minimum_credits: number
  price_version: string
  cost_tier?: GenStudioLlmCostTier
  /** GenStudio's shelf, and the offer that shelf carries. Forwarded by the
   *  vision route for the same reason the language catalogue forwards them:
   *  this menu is a second place a customer commits to a chat product and
   *  pays for it, so the cheaper shelf must exist here too. */
  queue_class?: 'direct' | 'relaxed' | null
  relaxed_queue_hint?: RelaxedQueueHint | null
  /** GenStudio's published retirement flag and withdrawal date. Forwarded by
   *  the vision route for the same reason the language catalogue forwards
   *  them: this menu is a second place a customer commits to a chat product. */
  deprecation_warning?: boolean
  retires_at?: string | null
}

/**
 * `now` is injectable for the same reason `describeModelRetirement` takes it:
 * the countdown is derived from the clock, so a test that cannot pin the
 * instant is a test that starts failing the next day. It is an OPTIONS BAG, not
 * a second positional parameter, because the only app caller is
 * `thumbnailVisionModels.value.map(thumbnailVisionModelMenuOption)` and `map`
 * hands its callback the array INDEX second — which a positional `now` would
 * silently accept as an instant near the epoch.
 */
export function thumbnailVisionModelMenuOption(
  model: ThumbnailVisionModel,
  { now = Date.now() }: { now?: number } = {},
) {
  const rate = describeChatRate(model)
  // This route publishes the name as `display_name`; the retirement vocabulary
  // reads `label`, the way the language catalogue delivers it. One adapter,
  // written once, rather than the spread order silently deciding it.
  const retirement = { ...model, label: model.display_name }
  return {
    id: model.id,
    label: model.display_name,
    group: queueClassGroupLabel(model, 'Gateway · Vision only'),
    groupNote: isRelaxedQueue(model) ? describeRelaxedQueueHint(model.relaxed_queue_hint) : '',
    meta: `${model.max_input_images} image · ${model.supported_detail_levels.join(', ')} detail`,
    price: rate.text,
    priceTitle: rate.title,
    badges: [
      { label: 'Vision', tone: 'info' as const },
      { label: 'JSON', tone: 'neutral' as const },
      ...(isRetiring(retirement)
        ? [{ label: 'Retiring', tone: 'warning' as const, title: describeModelRetirement(retirement, now) }]
        : []),
    ],
      }
}
