/**
 * The ONE place that decides what a narration is submitted to GenStudio as.
 *
 * A long narration is not one TTS request. `generators/audio.ts` normalizes
 * each section, filters to the ones asked for, and splits each remaining
 * section at the selected model's published `maximum_input_characters` —
 * submitting one billed job per resulting piece (`_part1.mp3`, `_part2.mp3`, …).
 *
 * Quoting has to ask GenStudio about those SAME pieces. If quoting split
 * differently — a different normalization, a different boundary, the sections
 * joined before splitting — the parts quoted would not be the parts billed and
 * the total would be fiction. So both callers come through here, and the
 * regression test asserts the plan the quote route uses is the identical array
 * the generator submits.
 *
 * Nothing in this module knows a limit, a price or a capability. The request
 * boundary is derived here, but only ever FROM the selected model's published
 * figures — `resolveTtsRequestBudget` below is the one place that decides it,
 * and both callers plan from that same budget.
 */

import { splitGenStudioApiRequests } from '../lib/genstudio-client.js'
import { normalizeForTts } from '../lib/tts-text.js'

/**
 * Story Studio's own head-room on a published request boundary — POLICY, not a
 * catalogue value.
 *
 * It is a FRACTION of whatever the selected model publishes. The base it
 * multiplies stays live and per-model, so the boundary still moves with the
 * catalogue; this can never become a fixed cap of Story Studio's own.
 *
 * Why it exists: GenStudio charges for `billable_characters`, counted under its
 * own `character_rule_version`, and that count need not equal a raw JavaScript
 * string length — normalization, combining marks, whitespace rules and the
 * quote endpoint's own body limit all count in GenStudio's terms, not ours.
 * Planning exactly ON the published limit therefore risks a rejection on part N
 * after the customer has already been charged for parts 1..N-1, which is the
 * one failure mode worth spending head-room to avoid. It also keeps a
 * generation unit inside the quote endpoint's smaller body limit, so the parts
 * that will be billed stay quotable.
 */
// model-drift-allow: a Story Studio safety margin, never a published figure. It
// is a fraction applied to the live per-model limit, not a limit of its own.
export const TTS_REQUEST_SAFETY_MARGIN = 0.1

/**
 * The floor the margin may reduce a published boundary to.
 *
 * Not a limit either: it exists only so a very small published boundary cannot
 * be rounded down to nothing, which `splitGenStudioApiRequests` refuses. It is
 * clamped to the live base below, so it can never RAISE a budget above what the
 * model publishes.
 */
// model-drift-allow: a floor that stops the margin rounding to zero, clamped to
// the published base so it can never exceed what the model itself allows.
const MINIMUM_PLANNED_REQUEST_CHARACTERS = 1

/**
 * The published figures a request budget is derived from.
 *
 * Structurally typed so a live `GenStudioTtsModel` row satisfies it directly —
 * callers pass the catalogue row they just read, never a remembered number.
 */
export interface TtsRequestBudgetSource {
  /** The model's published `maximum_input_characters`. Per model, read live. */
  maximum_input_characters: number
  /**
   * A quote-specific published limit, IF GenStudio ever ships one.
   *
   * It does not exist today: `TTSModelResponse` publishes no such field (checked
   * against the live `/openapi.json`), while `TTSQuoteRequest.text` carries a
   * fixed `maxLength` that no catalogue field mirrors — the inconsistency
   * `docs/genstudio-handoff/quote-limit-request.md` asks them to resolve. Story
   * Studio does NOT invent it. The smaller of the two already wins below, so the
   * day GenStudio publishes it the only change needed is to carry the field
   * through the catalogue mapper into this optional property.
   */
  maximum_quote_characters?: number | null
}

/** What planning splits at, and the published figures behind it. */
export interface TtsRequestBudget {
  /** The model's published `maximum_input_characters`, unmodified. */
  published: number
  /**
   * The smaller of the published limits in force — today always `published`,
   * because no quote-specific limit is published.
   */
  ceiling: number
  /** The budget both generation and quoting actually plan from. */
  effective: number
  /** The fraction of the ceiling held back. Story Studio policy. */
  safety_margin: number
  /** True when a published quote limit, not the input limit, set the ceiling. */
  quote_limited: boolean
}

function publishedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const count = Math.floor(value)
  return count > 0 ? count : 0
}

/**
 * THE one place that decides how large a TTS request Story Studio will make.
 *
 * Derived live, on every call, from the selected model's own published figures:
 * change the model and every number here changes with it. Nothing is cached,
 * and no figure survives a selection change.
 *
 * A model that publishes no boundary yields an effective budget of 0, which
 * `splitGenStudioApiRequests` refuses loudly rather than guessing one.
 */
export function resolveTtsRequestBudget(model: TtsRequestBudgetSource): TtsRequestBudget {
  const published = publishedCount(model.maximum_input_characters)
  const publishedQuoteLimit = publishedCount(model.maximum_quote_characters)
  const quoteLimited = publishedQuoteLimit > 0 && publishedQuoteLimit < published
  const ceiling = quoteLimited ? publishedQuoteLimit : published

  const withMargin = Math.floor(ceiling * (1 - TTS_REQUEST_SAFETY_MARGIN))
  const effective = ceiling > 0
    ? Math.min(ceiling, Math.max(MINIMUM_PLANNED_REQUEST_CHARACTERS, withMargin))
    : 0

  return { published, ceiling, effective, safety_margin: TTS_REQUEST_SAFETY_MARGIN, quote_limited: quoteLimited }
}

/** The shape `parseNarrationDocx` returns, narrowed to what planning needs. */
export interface PlannableSection {
  label: string
  slug: string
  text: string
}

/** One section and the exact request bodies it will be submitted as. */
export interface PlannedSectionRequests<S extends PlannableSection = PlannableSection> {
  section: S
  /** Byte-for-byte what each TTS job receives. One entry = one billed job. */
  parts: string[]
}

/** A single billed TTS job, flattened for quoting and for display. */
export interface PlannedTtsRequest {
  section_slug: string
  section_label: string
  /** 1-based position of this request within its section. */
  part: number
  /** How many requests this section is submitted as. */
  part_count: number
  /** The exact text this job receives. Never truncated for display here. */
  text: string
  characters: number
}

/**
 * The pre-TTS punctuation cleanup, applied in place before any splitting.
 *
 * Generation runs this before chunking, so the boundaries fall in the CLEANED
 * text. Quoting the raw text would move every boundary after the first change
 * and quote pieces nobody submits. Returns the number of marks rewritten,
 * which the generator reports in its job log.
 */
export function normalizeSectionsForTts(sections: PlannableSection[]): number {
  let totalFixed = 0
  for (const section of sections) {
    const result = normalizeForTts(section.text)
    if (result.changes) {
      section.text = result.text
      totalFixed += result.changes
    }
  }
  return totalFixed
}

/**
 * Resolve the `sections` request parameter to the sections that will actually
 * be generated: `all`, `intro`, a comma list, or a single section reference by
 * number, slug or label. Quoting must select the same set or it prices work
 * that is not about to happen.
 */
export function selectNarrationSections<S extends PlannableSection>(
  allSections: S[],
  sectionsParam: string,
): S[] {
  const param = sectionsParam || 'all'

  if (param.toLowerCase() === 'intro') {
    return allSections.filter(s => s.label.toLowerCase() === 'introduction')
  }

  if (param !== 'all' && param.includes(',')) {
    const requested = param.split(',').map(x => x.trim()).filter(Boolean)
    const filtered: S[] = []
    for (const entry of requested) {
      if (['intro', 'introduction'].includes(entry.toLowerCase())) {
        filtered.push(...allSections.filter(s => s.label.toLowerCase() === 'introduction'))
      } else {
        const norm = entry.replace(/^0+/, '') || '0'
        for (const s of allSections) {
          const slugNum = s.slug.replace(/\D/g, '').replace(/^0+/, '') || '0'
          if (slugNum === norm || s.slug === entry || s.label === entry) filtered.push(s)
        }
      }
    }
    return filtered
  }

  if (param !== 'all') {
    const norm = param.replace(/^0+/, '') || '0'
    return allSections.filter(s => {
      const slugNum = s.slug.replace(/\D/g, '').replace(/^0+/, '') || '0'
      return slugNum === norm || s.slug === param || s.label === param
    })
  }

  return allSections
}

/**
 * Split every selected section at the model's published request boundary.
 *
 * Sections are split INDEPENDENTLY, exactly as generation submits them — one
 * section never shares a request with the next, because each section becomes
 * its own audio file. `maxInputCharacters` must be the `effective` figure from
 * `resolveTtsRequestBudget` for the selected model — the live published
 * boundary less Story Studio's head-room. Generation and quoting pass the same
 * one, so the parts quoted stay the parts billed;
 * `splitGenStudioApiRequests` refuses a missing boundary rather than inventing
 * one.
 */
export function planGenStudioTtsRequests<S extends PlannableSection>(
  sections: S[],
  maxInputCharacters: number,
): PlannedSectionRequests<S>[] {
  return sections.map(section => ({
    section,
    parts: splitGenStudioApiRequests(section.text, maxInputCharacters),
  }))
}

/** The same plan as a flat list of billed jobs, in submission order. */
export function flattenTtsRequestPlan(plan: PlannedSectionRequests[]): PlannedTtsRequest[] {
  const flat: PlannedTtsRequest[] = []
  for (const entry of plan) {
    entry.parts.forEach((text, index) => {
      flat.push({
        section_slug: entry.section.slug,
        section_label: entry.section.label,
        part: index + 1,
        part_count: entry.parts.length,
        text,
        characters: text.length,
      })
    })
  }
  return flat
}
