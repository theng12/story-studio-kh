/**
 * Shared prompt builder + JSON parser for GenStudio Research.
 *
 * Centralised here so prompt quality and the persisted JSON contract stay
 * stable while the published GenStudio model changes.
 *
 * Output contract: the LLM must return ONLY a JSON object matching
 * `ResearchJsonContract`. The parser is tolerant of leading prose
 * (some models prepend "Here's the research:" no matter what you
 * ask) — it walks the string for the first `{...}` block and
 * `JSON.parse`s that. Returns a minimal empty-shape object if
 * parsing fails so downstream code doesn't crash; the script
 * generator will surface "no claims" to the user instead.
 */

import type {
  ResearchClaim,
  ResearchCitation,
  ResearchMode,
  ResearchOutput,
  ResearchRunOptions,
  ResearchStructureSection,
  ResearchWebRunReport,
} from '../../models/types.js'

export interface ResearchJsonContract {
  summary?: string
  claims?: Array<{
    text: string
    citation_indices?: number[]
    /**
     * URLs the model says back this claim, in web mode with attribution on.
     *
     * Read by GENSTUDIO, not by this app. GenStudio keeps only the ones that
     * match what the provider really retrieved and returns the survivors as
     * `citation_claims`. Story Studio deliberately never consumes this field
     * directly: doing so would put an unverified model-typed URL in front of
     * the user with the same authority as a checked one.
     */
    sources?: string[]
    confidence?: 'high' | 'medium' | 'low' | 'unknown'
    note?: string
  }>
  citations?: Array<{
    title: string
    url: string
    snippet?: string
  }>
  structure?: Array<{
    heading: string
    brief: string
    /** Indices into the claims array (not the final ids — those are
     *  assigned client-side after parsing). */
    claim_indices?: number[]
  }>
}

const SYSTEM_TEMPLATE = `You are a research assistant for a factual explainer video.

Your job:
  1. Research the user's topic.
  2. Return a structured JSON object with verifiable claims, citations, and a recommended episode structure.

Output rules (strict):
  - Return ONLY a JSON object. No prose before or after. No markdown fences.
  - Every claim is a short declarative sentence (one sentence per claim, never compound).
  - Cite every claim. Use \`citation_indices\` to point into the \`citations\` array (zero-based).
  - When you can't cite a claim, mark it with \`"confidence": "low"\` and add a \`note\` recommending manual verification. Don't make up URLs.
  - \`summary\` is 2-4 sentences of context — the user reads this before the claims list.
  - \`structure\` is 4-8 recommended episode sections (heading + brief + which claims belong there). The script generator uses this as a default outline; the user can edit it later.

JSON schema:
{
  "summary": "<2-4 sentences>",
  "claims": [
    { "text": "<one declarative sentence>", "citation_indices": [<int>...], "confidence": "high|medium|low|unknown", "note": "<optional caveat>" }
  ],
  "citations": [
    { "title": "<source title>", "url": "<URL or empty>", "snippet": "<optional quoted passage>" }
  ],
  "structure": [
    { "heading": "<short section title>", "brief": "<one sentence on what this section covers>", "claim_indices": [<int>...] }
  ]
}`

const LLM_ONLY_SYSTEM_NOTE = `

IMPORTANT — you do NOT have live web access on this call. Don't fabricate URLs. For every claim:
  - Mark confidence "low" or "unknown" unless you are absolutely certain from training data.
  - In the \`note\` field, recommend a specific verification path (e.g. "Cross-check against [specific archive/journal/database]").
  - Leave \`citation_indices\` empty for any unverifiable claim — the user will research these manually.
  - \`citations\` can be empty (or list well-known canonical sources like "Encyclopedia Britannica entry on X" with empty URL).`

/**
 * Web-mode note. The provider records what it actually read in the RESPONSE
 * ENVELOPE, so the model is told not to hand-copy URLs into its JSON: a URL
 * the model types is a model claim, while an envelope citation is provider
 * evidence. Keeping the two apart is the whole reason web mode can say
 * "cited its sources" at all.
 */
const WEB_SEARCH_SYSTEM_NOTE = `

IMPORTANT — you DO have live web search on this call. Use it.
  - Search for current, primary sources before answering. Prefer them over recollection.
  - Do NOT hand-copy URLs into the \`citations\` array, and leave every \`citation_indices\` empty. That array is filled in from what the search tool recorded you reading, not from what you type.
  - Set \`confidence\` honestly: "high" only for claims you just confirmed in a source you read on this call.`

/**
 * Added on top of the web note when GenStudio will ground the answer.
 *
 * Note what this does NOT do: it does not soften the rule above. A URL the
 * model types is still not evidence here. The difference is that GenStudio now
 * checks each named URL against the provider's own record of what was
 * retrieved and discards the rest, so a typed URL becomes a *link* between a
 * claim and a source that was independently proven real. Story Studio still
 * never reads these strings itself — it reads GenStudio's grounded
 * `citation_claims` — which is why the app cannot be made to show a
 * hallucinated source no matter what the model writes here.
 */
const CLAIM_ATTRIBUTION_SYSTEM_NOTE = `
  - Give every claim object one extra field, \`sources\`, so each claim reads: { "text": "...", "sources": ["<url>", ...], "confidence": "...", "note": "..." }
  - In a claim's \`sources\`, list the URLs of the pages you actually opened that support that specific claim, copied exactly. Do not list a page you did not read, and do not repeat a page that does not support that particular claim.
  - If none of the pages you read supports a claim, leave its \`sources\` array empty. An unsourced claim is an expected and acceptable answer — a guessed source is not.`

export function buildResearchPrompt(
  opts: ResearchRunOptions,
  mode: 'web' | 'llm-only' = 'web',
  /** Whether GenStudio will ground per-claim sources for this run. Asking for
   *  them when nothing will check them would put unverified URLs in front of
   *  the user, so the request and the prompt are turned on together. */
  claimAttribution = false,
): {
  system: string
  user: string
} {
  const system = mode === 'llm-only'
    ? SYSTEM_TEMPLATE + LLM_ONLY_SYSTEM_NOTE
    : SYSTEM_TEMPLATE + WEB_SEARCH_SYSTEM_NOTE
      + (claimAttribution ? CLAIM_ATTRIBUTION_SYSTEM_NOTE : '')

  const sourceCap = opts.max_sources ?? 8
  const userParts: string[] = [
    `Topic: ${opts.topic}`,
    `Cap on distinct sources: ${sourceCap}`,
  ]
  if (opts.specific_questions && opts.specific_questions.trim()) {
    userParts.push(`Specifically answer these questions:\n${opts.specific_questions.trim()}`)
  }
  userParts.push('Return the JSON object now.')

  return { system, user: userParts.join('\n\n') }
}

/** Tolerant JSON parser. Some models prepend "Here's the research:"
 *  or wrap output in markdown fences despite instructions. Walk for
 *  the first { and the matching last } and parse that slice. */
export function parseResearchJson(raw: string): ResearchJsonContract {
  if (!raw || typeof raw !== 'string') return {}

  // Strip common markdown fence wrappers.
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }

  // Find the first { and the last } — naive but works when there's
  // a single top-level object (which our prompt enforces).
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) return {}
  const slice = cleaned.slice(firstBrace, lastBrace + 1)

  try {
    const parsed = JSON.parse(slice)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // Fall through to empty
  }
  return {}
}

function freshId(): string {
  return `claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Parse the GenStudio LLM output and write the unified ResearchOutput. */
export function assembleOutput(
  raw: string,
  liveCitations: ResearchCitation[],
  meta: {
    topic: string
    specific_questions?: string
    provider: ResearchOutput['source_provider']
    model?: string
    /** Which route produced this. Absent = 'model-knowledge' (unchanged). */
    mode?: ResearchMode
    /** Actual cost / search count for a web run, when GenStudio reported it. */
    web_run?: ResearchWebRunReport
  },
): ResearchOutput {
  const parsed = parseResearchJson(raw)
  const mode: ResearchMode = meta.mode ?? 'model-knowledge'

  // Merge LLM-supplied citations (from the JSON block) with adapter-
  // supplied ones (annotations / top-level), deduped by URL.
  //
  // WEB MODE IS DIFFERENT, on purpose: only the provider's ENVELOPE citations
  // count. A URL the model typed into its own JSON is a model claim, not
  // evidence that anything was read — accepting those would let web mode
  // present a hallucinated URL with the same authority as a real source.
  const byUrl = new Map<string, ResearchCitation>()
  for (const c of liveCitations) {
    if (c.url && !byUrl.has(c.url)) byUrl.set(c.url, c)
  }
  if (mode !== 'web-search') {
    for (const c of parsed.citations || []) {
      if (c.url && !byUrl.has(c.url)) byUrl.set(c.url, c)
    }
  }
  const finalCitations = Array.from(byUrl.values())

  // In web mode, per-claim links come from GenStudio's GROUNDED
  // `citation_claims` — the model named sources and GenStudio kept only the
  // ones matching what the provider actually retrieved. `claim-N` is the
  // 1-based position in this same claims array, so index N-1 addresses it.
  //
  // A claim GenStudio did not attribute is simply missing from the map, and
  // stays missing here: it keeps an empty `citation_indices`, exactly like a
  // claim the model never sourced. Nothing falls back to the run-level list.
  const citationIndexById = new Map<string, number>()
  finalCitations.forEach((citation, index) => {
    if (citation.source_id) citationIndexById.set(citation.source_id, index)
  })
  const groundedByClaimIndex = new Map<number, number[]>()
  for (const link of meta.web_run?.citation_claims || []) {
    const position = Number(/^claim-(\d+)$/.exec(link.claim_id)?.[1])
    if (!Number.isInteger(position) || position < 1) continue
    const indices: number[] = []
    for (const citationId of link.citation_ids || []) {
      const index = citationIndexById.get(citationId)
      // A citation id with no matching citation is dropped rather than
      // guessed at. It cannot happen with a well-formed envelope, and if it
      // ever does, showing nothing beats showing the wrong source.
      if (index !== undefined && !indices.includes(index)) indices.push(index)
    }
    if (indices.length) groundedByClaimIndex.set(position - 1, indices)
  }

  // Rewrite each parsed claim's citation indices to point into the
  // merged list. The LLM produces indices into ITS own citations
  // array; we map those URLs to positions in finalCitations.
  const parsedCitationUrls = (parsed.citations || []).map(c => c.url)
  const claims: ResearchClaim[] = (parsed.claims || []).map((c, claimIndex) => {
    const remapped: number[] = []
    for (const idx of c.citation_indices || []) {
      const url = parsedCitationUrls[idx]
      if (!url) continue
      const newIdx = finalCitations.findIndex(fc => fc.url === url)
      if (newIdx >= 0) remapped.push(newIdx)
    }
    // Web mode ignores anything the model typed and uses only the grounded
    // links; model-knowledge mode has no grounding available and keeps its
    // existing behaviour unchanged.
    const grounded = mode === 'web-search'
      ? groundedByClaimIndex.get(claimIndex) || []
      : remapped
    return {
      id: freshId(),
      text: c.text,
      status: 'unreviewed',
      citation_indices: grounded,
      confidence: c.confidence,
      note: c.note,
    }
  })

  // The structure (if present) references claim ids — but the parsed
  // version uses original claim indices, since the LLM didn't know
  // the final ids. Rebuild claim_ids from the new claims array using
  // text-match. Cheap O(N*M) walk; M tiny (~5-10 sections).
  let structure: ResearchStructureSection[] | undefined
  if (parsed.structure && parsed.structure.length) {
    structure = parsed.structure.map((s) => ({
      heading: s.heading,
      brief: s.brief,
      claim_ids: (s.claim_indices || []).map((i: number) => claims[i]?.id).filter(Boolean) as string[],
    }))
  }

  return {
    schema_version: 1,
    source_provider: meta.provider,
    source_model: meta.model,
    research_mode: mode,
    ...(meta.web_run ? { web_run: meta.web_run } : {}),
    generated_at: new Date().toISOString(),
    topic: meta.topic,
    specific_questions: meta.specific_questions,
    claims,
    citations: finalCitations,
    structure,
    summary: parsed.summary,
  }
}
