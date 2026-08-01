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
 * boundary is passed in, read live from the selected model.
 */

import { splitGenStudioApiRequests } from '../lib/genstudio-client.js'
import { normalizeForTts } from '../lib/tts-text.js'

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
 * its own audio file. `maxInputCharacters` must be the live
 * `maximum_input_characters` of the selected model; `splitGenStudioApiRequests`
 * refuses a missing one rather than inventing a boundary.
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
