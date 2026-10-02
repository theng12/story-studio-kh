/**
 * Quote a narration the way GenStudio will actually bill it: one quote per job.
 *
 * Story Studio never computes a customer charge. It cannot, here, either — a
 * long narration is submitted as N separate TTS jobs (see
 * services/tts-request-plan.ts), each priced by GenStudio in its own right and
 * each subject to the model's published per-job `minimum_credits`. Multiplying
 * a rate by the whole character count would therefore be wrong twice over: it
 * is Story Studio's arithmetic, and it silently drops N−1 minimums.
 *
 * So this asks GenStudio for a quote on every piece that will be submitted and
 * adds those returned figures up. The only local operation is the addition, and
 * the caller labels it as such — a sum of GenStudio quotes, not an estimate.
 *
 * The quoting call is injected so this can be exercised with no network and no
 * paid request.
 */

import { GenStudioApiError, type GenStudioTtsQuote } from '../lib/genstudio-client.js'
import type { PlannedTtsRequest } from './tts-request-plan.js'

/** One submitted job, with GenStudio's own figure for it. */
export interface QuotedTtsPart {
  section_slug: string
  section_label: string
  part: number
  part_count: number
  /** Characters Story Studio will submit for this job. */
  characters: number
  /** GenStudio's figure for this exact job. Never derived here. */
  credits: number
  /** What GenStudio counted as billable for this job. */
  billable_characters: number
  chargeable: boolean
  /**
   * Null when GenStudio's 200 quote carried no duration. Not money, so it does
   * not make the quote unavailable — but it is still never replaced with 0.
   */
  estimated_duration_ms: number | null
  price_version: string
  notice: string
}

export type TtsQuoteUnavailableReason =
  /** GenStudio publishes this voice as not quotable. */
  | 'quote_disabled'
  /**
   * GenStudio's quote endpoint refused a request body that generation will
   * submit unchanged — a body the selected model publishes as acceptable.
   * Should not happen now that the model owns the only ceiling; kept as
   * defence, because the alternative is a silently wrong total.
   */
  | 'generation_unit_rejected'
  /**
   * The quote call failed for some other reason (auth, network, outage), OR it
   * answered 200 without the figures a total is made of. The second case used
   * to be invisible: `?? 0` in the client turned an unpublished `credits` into
   * a confident zero, and a zero total reads as FREE. A quote that cannot be
   * totalled is reported as unavailable, never rounded down to nothing.
   */
  | 'quote_failed'

export interface TtsNarrationQuote {
  quotable: boolean
  parts: QuotedTtsPart[]
  /** How many jobs this narration will be submitted as, quotable or not. */
  part_count: number
  /** Sum of the per-part figures GenStudio returned. Only when `quotable`. */
  total_credits: number | null
  /** Sum of the per-part billable counts GenStudio returned. */
  total_billable_characters: number | null
  /** True when GenStudio marked at least one part chargeable. */
  chargeable: boolean
  unavailable_reason: TtsQuoteUnavailableReason | null
  /** GenStudio's own words for the refusal, relayed verbatim. */
  unavailable_detail: string
  /** HTTP status GenStudio answered the refused quote with, when there was one. */
  unavailable_status: number | null
  /** Size of the generation unit GenStudio would not quote, when one was refused. */
  unquotable_characters: number | null
}

/**
 * Statuses that mean "this request body is not acceptable to the quote
 * endpoint" rather than "something went wrong on the way".
 *
 * These are HTTP semantics, not a GenStudio limit: 413 and 422 are the two
 * ways a server says the body itself was refused. Story Studio encodes no
 * request-size ceiling of its own — the selected model publishes the only one.
 * If a body inside it is still refused, that is reported, never worked around.
 */
function isRequestBodyRefusal(error: unknown): error is GenStudioApiError {
  return error instanceof GenStudioApiError && (error.status === 413 || error.status === 422)
}

/**
 * The discovered-refusal cache that used to sit here is GONE (v1.0.777).
 *
 * It remembered, per model and per process, the smallest body the quote
 * endpoint had already refused, so a second ask at the same size or larger
 * could skip the round trip. Its whole reason for existing was
 * `TTSQuoteRequest.text`'s fixed `maxLength` — a second, smaller ceiling that
 * no catalogue field mirrored, so the only way to learn it was to be told no.
 * GenStudio has removed that cap; the model's published
 * `maximum_input_characters` is now the only boundary, and Story Studio already
 * plans below it. There is no undiscoverable size left to remember.
 *
 * The refusal HANDLING below stays, as defence: if the quote endpoint ever
 * refuses a body generation would submit unchanged, that is reported as a
 * contract mismatch rather than papered over by sub-splitting.
 */

export interface QuoteNarrationOptions {
  /** The exact jobs about to be submitted, in submission order. */
  requests: PlannedTtsRequest[]
  /** GenStudio publishes whether this voice can be quoted at all. */
  quoteEnabled: boolean
  /** Asks GenStudio to price one submitted job. Must not alter the text. */
  quoteRequest: (text: string) => Promise<GenStudioTtsQuote>
}

/**
 * Ask GenStudio to price every job, in order, and total its answers.
 *
 * Stops at the first job GenStudio will not price. A partial sum is not a
 * smaller quote — it is a wrong one — so the whole quote becomes unavailable
 * and the reason is reported instead.
 */
export async function quoteNarrationRequests(
  options: QuoteNarrationOptions,
): Promise<TtsNarrationQuote> {
  const { requests, quoteEnabled, quoteRequest } = options
  const empty: TtsNarrationQuote = {
    quotable: false,
    parts: [],
    part_count: requests.length,
    total_credits: null,
    total_billable_characters: null,
    chargeable: false,
    unavailable_reason: null,
    unavailable_detail: '',
    unavailable_status: null,
    unquotable_characters: null,
  }

  if (!requests.length) {
    return { ...empty, unavailable_reason: 'quote_failed', unavailable_detail: 'There is no narration to quote.' }
  }
  if (!quoteEnabled) {
    return {
      ...empty,
      unavailable_reason: 'quote_disabled',
      unavailable_detail: 'The Gateway publishes this voice as not quotable, so there is no quote to show for it.',
    }
  }

  const parts: QuotedTtsPart[] = []
  for (const request of requests) {
    let quote: GenStudioTtsQuote
    try {
      quote = await quoteRequest(request.text)
    } catch (error: any) {
      // GenStudio refused to price a body that generation submits as-is. Do
      // NOT split it smaller to make the quote succeed — that would price
      // units nobody is ever billed for. Report the contract mismatch.
      if (isRequestBodyRefusal(error)) {
        return {
          ...empty,
          unavailable_reason: 'generation_unit_rejected',
          unavailable_detail: error.detail || error.message,
          unavailable_status: error.status,
          unquotable_characters: request.characters,
        }
      }
      return {
        ...empty,
        unavailable_reason: 'quote_failed',
        unavailable_detail: error?.detail || error?.message || 'The Gateway could not quote this narration.',
        unavailable_status: error instanceof GenStudioApiError ? error.status : null,
      }
    }
    // A 200 quote that omitted the money. `quote.credits` is `null` only in
    // that exact case — a non-200 threw above — so this says so plainly instead
    // of adding a substituted 0 into a total the customer would read as free.
    if (quote.credits == null || quote.billable_characters == null) {
      const missing = [
        quote.credits == null ? 'credits' : '',
        quote.billable_characters == null ? 'billable_characters' : '',
      ].filter(Boolean).join(' and ')
      return {
        ...empty,
        unavailable_reason: 'quote_failed',
        unavailable_detail: `The Gateway answered the quote for this narration without ${missing}. `
          + 'Story Studio will not show a total it had to invent a figure for.',
      }
    }
    parts.push({
      section_slug: request.section_slug,
      section_label: request.section_label,
      part: request.part,
      part_count: request.part_count,
      characters: request.characters,
      credits: quote.credits,
      billable_characters: quote.billable_characters,
      chargeable: quote.chargeable,
      estimated_duration_ms: quote.estimated_duration_ms,
      price_version: quote.price_version,
      notice: quote.notice,
    })
  }

  return {
    quotable: true,
    parts,
    part_count: requests.length,
    total_credits: parts.reduce((sum, part) => sum + part.credits, 0),
    total_billable_characters: parts.reduce((sum, part) => sum + part.billable_characters, 0),
    chargeable: parts.some(part => part.chargeable),
    unavailable_reason: null,
    unavailable_detail: '',
    unavailable_status: null,
    unquotable_characters: null,
  }
}
