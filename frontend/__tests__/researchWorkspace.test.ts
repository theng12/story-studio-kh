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
    assert.match(research, /<ModelSelector v-model="form\.source_model"/)
    assert.doesNotMatch(research, /<PresetPicker/)
    assert.match(research, /Episode topics remain episode-specific/)
    assert.doesNotMatch(research, /label="Run settings and reusable preset"/)
    assert.doesNotMatch(research, /research_run_settings_open_/)
  })

  test('uses one fixed GenStudio LLM route without a provider selector', () => {
    assert.match(research, />GenStudio LLM</)
    assert.match(research, /Only published GenStudio LLM models appear here/)
    assert.match(research, /<ModelSelector v-model="form\.source_model"/)
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

  test('is honest about where the claims came from', () => {
    assert.match(research, /no live web access/)
    assert.match(research, /No source cited/)
  })
})
