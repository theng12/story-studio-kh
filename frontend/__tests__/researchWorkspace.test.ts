import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const research = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/research.vue', import.meta.url)),
  'utf8',
)

describe('Research workspace flow', () => {
  test('uses a compact brief, gather, and review workflow', () => {
    assert.match(research, /class="research-flow-rail"/)
    assert.match(research, /> Brief</)
    assert.match(research, /> Gather</)
    assert.match(research, /> Review</)
    assert.match(research, /title="Define what needs evidence"/)
  })

  test('keeps presets in the shared command bar and run controls visible without a settings disclosure', () => {
    assert.match(research, /:presets="researchPresets"/)
    assert.match(research, /researchPresets\.load\(\)/)
    assert.doesNotMatch(research, /@preset-(?:applied|saved|renamed|deleted).*success/)
    assert.match(research, /class="research-setup-surface"/)
    assert.match(research, /Tune the evidence run/)
    assert.match(research, /<ModelSelector v-else v-model="form\.source_model"/)
    assert.doesNotMatch(research, /<PresetPicker/)
    assert.match(research, /Episode topics remain episode-specific/)
    assert.doesNotMatch(research, /label="Run settings and reusable preset"/)
    assert.doesNotMatch(research, /research_run_settings_open_/)
  })

  // The MODE choice added in this release is not a provider choice: both
  // modes run through the same GenStudio boundary on the same API key.
  test('uses one fixed GenStudio route without a provider selector', () => {
    assert.match(research, />GenStudio LLM</)
    assert.match(research, /Only published GenStudio LLM models appear here/)
    assert.match(research, /<ModelSelector v-else v-model="form\.source_model"/)
    assert.doesNotMatch(research, /form\.source_provider/)
    assert.doesNotMatch(research, /v-for="src in sources"/)
    assert.doesNotMatch(research, /Perplexity \(direct\)/)
  })

  test('makes review completeness and Script handoff explicit', () => {
    assert.match(research, /research-review-score/)
    assert.match(research, /\{\{ reviewProgress \}\}%/)
    assert.match(research, /Only verified claims are passed into Script Generator/)
    assert.match(research, /Save review/)
    assert.match(research, /Sources in the video description/)
  })

  // v1.0.760 — this replaces the former "continues to describe Research as
  // optional" test. Research is now gated per project (`research_required`),
  // so the page must describe BOTH states rather than hardcoding "optional".
  // See AGENTS.md → "Gated Research and Retired Co-writer".
  test('describes Research per the project gate rather than always-optional', () => {
    // Gate on: generating is explicitly not enough.
    assert.match(research, /v-if="researchRequired"/)
    assert.match(research, /generating it is not enough/)
    // Gate off: the previous, unchanged wording still has to be reachable.
    assert.match(research, /Research is optional for this project/)
    // The old unconditional claim must not come back.
    assert.doesNotMatch(research, /Research stays optional and never blocks the production pipeline/)
  })

  // v1.0.761 — this replaces the former "exposes a deliberate, reversible
  // episode-level verification action" test. There is now ONE decision: the
  // per-claim triage. See AGENTS.md → "Gated Research and Retired Co-writer".
  test('keeps the per-claim triage as the only review decision', () => {
    // Per-claim Verified / Ignore, plus the bulk actions, are real editorial
    // work and must survive.
    assert.match(research, /setClaimStatus\(claim, claim\.status === 'verified' \? 'unreviewed' : 'verified'\)/)
    assert.match(research, /setClaimStatus\(claim, claim\.status === 'ignored' \? 'unreviewed' : 'ignored'\)/)
    assert.match(research, /bulkClaims\('verified'\)/)
    assert.match(research, /bulkClaims\('unreviewed'\)/)
    assert.match(research, /bulkClaims\('ignored'\)/)
  })

  test('the separate research-level attestation is gone and must not return', () => {
    assert.doesNotMatch(research, /research\/\$\{episodeId\.value\}\/verify/)
    assert.doesNotMatch(research, /setVerified\(/)
    assert.doesNotMatch(research, /'Verify research'/)
    assert.doesNotMatch(research, /'Un-verify'/)
    // The false claim that made the banner wrong in the first place: the
    // adapter is llm-only, has no live web access, and returns no citations.
    assert.doesNotMatch(research, /against the cited sources/i)
  })

  test('derives the review state from the claim decisions and says what it means', () => {
    assert.match(research, /const reviewed = computed/)
    assert.match(research, /const reviewComplete = computed/)
    assert.match(research, /reviewState/)
    // The all-ignored outcome gets its own, distinct message rather than
    // reading as "still pending" or silently counting as complete.
    assert.match(research, /Reviewed — every claim ignored/)
    assert.match(research, /hands the Script Generator nothing/)
    // Machine completion stays visibly distinct from a person's review.
    assert.match(research, /completedByPipeline/)
    assert.match(research, /No human read them/)
  })

  test('is honest about where the claims came from, per mode', () => {
    // Provenance is read from the SIDECAR, not the form: the form may have
    // been changed since the run, and the page must describe what happened.
    assert.match(research, /const resultMode = computed/)
    assert.match(research, /resultProvenanceNotice/)
    // Softened model-knowledge copy. The old wording read as if the output
    // were worthless, and it is simply wrong for a web run.
    assert.match(research, /Reliable on well-established facts/)
    assert.match(research, /From model knowledge — no source cited/)
    assert.doesNotMatch(research, /no live web access/)
    assert.doesNotMatch(research, /nothing backs this claim but the model/)
    // Web copy never borrows the model-knowledge framing.
    assert.match(research, /Searched the web and cited its sources below/)
    assert.match(research, /aren’t linked to specific sources yet/)
  })

  // ── "Search the web" mode ──────────────────────────────────────────────
  test('offers both research modes with customer-facing names', () => {
    assert.match(research, /Model knowledge only/)
    assert.match(research, />Search the web</)
    assert.match(research, /name="research-mode"/)
    assert.match(research, /value="model-knowledge"/)
    assert.match(research, /value="web-search"/)
    // "LLM" must not appear in the mode copy the customer reads.
    assert.doesNotMatch(research, /Model knowledge only[^<]*LLM/)
  })

  test('keeps web mode visible and self-explaining when nothing qualifies', () => {
    // The option is disabled with a reason, not hidden — and the reason comes
    // from the backend capability check, never invented here.
    assert.match(research, /:disabled="!webModeAvailable"/)
    assert.match(research, /\{\{ webModeReason \}\}/)
    assert.match(research, /'\/research\/web-models'/)
    // A failed request must not be reported as "nothing qualifies".
    assert.match(research, /Could not check which models can search the web/)
    // Web mode can never be ACTIVE while unavailable, whatever a preset says.
    assert.match(research, /form\.value\.research_mode === 'web-search' && webModeAvailable\.value/)
  })

  test('the web-research model picker is the same centred dialog as every other picker', () => {
    // v1.0.778 moved every picker to a centred dialog and missed this one — it
    // stayed a native <select>, so the mode actually in daily use had the
    // cramped dropdown. Both branches of the field are now dialogs.
    assert.match(research, /<ModelMenu\s+v-if="webMode"/)
    assert.match(research, /v-model="form\.web_model"/)
    assert.match(research, /:options="webModelMenuOptions"/)
    assert.doesNotMatch(research, /<select[\s\S]{0,120}research-web-model/)
    assert.doesNotMatch(research, /id="research-web-model"/)
    // The list is still exactly what the backend qualified — filtered on
    // published capability, never on a model name.
    assert.match(research, /webModels\.value\.map/)
    // Each row states the model's PUBLISHED research facts, and nothing else.
    assert.match(research, /credits_per_request/)
    assert.match(research, /credits_per_search/)
    assert.match(research, /max_web_searches/)
    assert.match(research, /returns_citations \? \[\{ label: 'Cites sources'/)
    assert.match(research, /supports_domain_filters \? \[\{ label: 'Domain filters'/)
    // No provider on the row: the chat catalogue publishes none, and one is
    // never reconstructed from an id or a name.
    assert.doesNotMatch(research, /provider: '/)
  })

  test('web availability is read live and never asserted as a fixed state', () => {
    // This page once carried "TODAY every model reports research_qualified:
    // false". Web search went live on GenStudio and that comment became a lie
    // about the running product. Availability is whatever the read says.
    assert.doesNotMatch(research, /TODAY every model reports/)
    assert.doesNotMatch(research, /research_qualified:\s*false/)
    assert.match(research, /webModeAvailable\.value = r\.available === true/)
  })

  test('hides the depth control unless the selected model publishes a cap', () => {
    assert.match(research, /v-if="depthCapLimit"/)
    assert.match(research, /max_web_searches/)
    // The old always-on "Source depth" control is gone: in model-knowledge
    // mode it only ever changed prompt text.
    assert.doesNotMatch(research, />Source depth</)
  })

  test('shows domain filters only when the selected model advertises them', () => {
    assert.match(research, /v-if="webMode && selectedWebModel\?\.supports_domain_filters"/)
    assert.match(research, /allowed_domains/)
    assert.match(research, /blocked_domains/)
  })

  test('quotes a per-search rate and never computes a total charge locally', () => {
    assert.match(research, /Each web search costs/)
    assert.match(research, /the total varies per run|total varies/)
    // The ACTUAL charge is whatever GenStudio reported — unreported stays
    // unreported rather than becoming a number this app made up.
    assert.match(research, /not reported/)
    assert.match(research, /webRunReportLabel/)
  })

  test('shows citations at run level and never fabricates per-claim links', () => {
    assert.match(research, /These sources back the whole run/)
    assert.match(research, /resultMode !== 'web-search'/)
    // A web run with no sources is stated plainly instead of left blank.
    assert.match(research, /research-nosources-note/)
  })

  test('round-trips mode and domain filters through research presets', () => {
    assert.match(research, /research_mode: form\.value\.research_mode/)
    assert.match(research, /allowed_domains: form\.value\.allowed_domains/)
    assert.match(research, /blocked_domains: form\.value\.blocked_domains/)
    // A preset with no mode predates web search and can only mean model
    // knowledge — never optimistically upgraded into a credit-spending mode.
    assert.match(research, /data\.form\.research_mode === 'web-search' \? 'web-search' : 'model-knowledge'/)
  })
})
