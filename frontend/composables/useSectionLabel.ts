/**
 * Format-aware section-label composable.
 *
 * Returns a format's primary content-unit noun, falling back to "Chapter"
 * when the field is unset.
 *
 * Usage (in a Vue component):
 *
 *   const formatId = ref('continuity-chain')
 *   const label = useSectionLabel(formatId)
 *
 *   <h2>{{ label.Singular }} {{ n }}: {{ title }}</h2>      <!-- "Reason 03: ..." -->
 *   <span>{{ count }} {{ label.plural }}</span>             <!-- "6 reasons" -->
 *   <button>+ Add {{ label.singular }}</button>             <!-- "+ Add reason" -->
 *
 * Reactive: switches automatically when the format id changes (e.g. on
 * project switch or wizard format-card click). All four casings are
 * exposed so callers don't have to wrap their own toLowerCase/uppercase
 * calls in template expressions.
 */

import { computed, type Ref, type ComputedRef, isRef } from 'vue'
import { useFormats, type Format } from './useFormats.js'

export interface SectionLabel {
  /** Title-case singular ("Chapter", "Reason"). */
  Singular: string
  /** Title-case plural ("Chapters", "Reasons"). */
  Plural: string
  /** Lowercase singular ("chapter", "reason"). */
  singular: string
  /** Lowercase plural ("chapters", "reasons"). */
  plural: string
}

const DEFAULT: SectionLabel = {
  Singular: 'Chapter',
  Plural: 'Chapters',
  singular: 'chapter',
  plural: 'chapters',
}

function deriveLabel(format: Format | undefined): SectionLabel {
  const sl = format?.script?.sectionLabel
  if (!sl?.singular || !sl?.plural) return DEFAULT
  return {
    Singular: sl.singular,
    Plural: sl.plural,
    singular: sl.singular.toLowerCase(),
    plural: sl.plural.toLowerCase(),
  }
}

/**
 * Look up the section label for `formatId`. `formatId` may be a plain
 * string OR a Vue ref/computed — the returned ComputedRef updates when
 * either the format list or the id ref changes.
 */
export function useSectionLabel(formatId: string | Ref<string> | ComputedRef<string>): ComputedRef<SectionLabel> {
  const { find } = useFormats()
  return computed(() => {
    const id = isRef(formatId) ? formatId.value : formatId
    return deriveLabel(find(id))
  })
}
