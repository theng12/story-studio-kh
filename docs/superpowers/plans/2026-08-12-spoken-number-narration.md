# Spoken-Number Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store speakable English numbers in narration and guarantee the same spoken form at every TTS request boundary without changing technical identifiers or automatically spending credits.

**Architecture:** Add one small dependency-free spoken-number helper in the existing TTS text module, reuse it at chapter persistence and TTS normalization, strengthen the universal script prompt, and retain the existing live-model TTS fanout resolver.

**Tech Stack:** TypeScript, Node.js `node:test`, existing narration assembly, TTS request planner, Mock GenStudio service.

## Global Constraints

- The converter must be deterministic and idempotent.
- It must fail conservative: ambiguous technical tokens retain digits.
- Quote, generation, reconciliation, chunk boundaries, and idempotency use the
  same normalized request text.
- Do not add a number-word dependency, second audio queue, fixed concurrency,
  or automatic regeneration.
- Do not touch HMH0001 artifacts until the owner gives a separate greenlight.

---

### Task 1: Spoken-number helper and prompt contract

**Files:**
- Modify: `electron/server/lib/tts-text.ts`
- Modify: `electron/server/generators/episode.ts`
- Test: `electron/server/__tests__/tts-text.test.ts`
- Test: `electron/server/__tests__/tts-text.test.ts` (also reads the universal prompt source)

**Interfaces:**
- Produces: `normalizeSpokenNumbers(input: string): { text: string; changes: number }`
- Extends: `normalizeForTts(input: string): TtsNormalizeResult`
- Preserves: `TtsNormalizeResult.changes` as the total count used by existing callers.

- [ ] **Step 1: Write the spoken-number RED tests.** Add table cases equivalent
      to:

```ts
const cases = [
  ['In 1871, it changed.', 'In eighteen seventy-one, it changed.'],
  ['In 2001 and 2010.', 'In two thousand one and twenty ten.'],
  ['January 18, 1871', 'January eighteenth, eighteen seventy-one'],
  ['42 percent cost $5 million.', 'forty-two percent cost five million dollars.'],
  ['From 1862–1866.', 'From eighteen sixty-two to eighteen sixty-six.'],
]
for (const [input, expected] of cases) {
  assert.equal(normalizeSpokenNumbers(input).text, expected)
}
```

      Add preservation cases for `HMH0001`, `GPT-5.6`, `S2.1`, `v1.0.826`,
      URLs, Markdown link targets, code spans, `2 + 2 = 4`, citations, paths,
      timecodes, and a second-pass idempotence assertion.

- [ ] **Step 2: Run the focused test and record RED.**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 server/__tests__/tts-text.test.ts
```

      Expected: fail because `normalizeSpokenNumbers` is not exported.

- [ ] **Step 3: Add the universal prompt RED assertion.** Verify the script
      prompt contains the three approved year examples, the “ordinary numbers
      as words” rule, and the technical-identifier exception.

- [ ] **Step 4: Implement the minimal converter.** Add private cardinal,
      ordinal, and year helpers in `tts-text.ts`; scan only standalone prose
      numeric tokens; mask/restore protected technical spans; return the exact
      `normalizeSpokenNumbers` result type above. Invoke it from
      `normalizeForTts` before punctuation cleanup (so numeric ranges retain
      their meaning) and include its count in
      `changes` without changing any existing caller signature.

- [ ] **Step 5: Strengthen `ttsWritingGuidance`.** Add the approved policy and
      examples to the one universal `systemPrompt()` guidance block in
      `episode.ts`; do not duplicate it in format/niche prompts.

- [ ] **Step 6: Run Task 1 GREEN.**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  server/__tests__/tts-text.test.ts \
  server/__tests__/intro-lead-in-episode.test.ts
```

- [ ] **Step 7: Commit the independently reviewable helper/prompt batch.**

```bash
git add electron/server/lib/tts-text.ts electron/server/generators/episode.ts \
  electron/server/__tests__/tts-text.test.ts \
  docs/superpowers/specs/2026-08-12-spoken-number-narration-design.md \
  docs/superpowers/plans/2026-08-12-spoken-number-narration.md
git commit -m "fix: write narration numbers for speech"
```

### Task 2: Clean saved narration

**Files:**
- Modify: `electron/server/lib/narration-assembly.ts`
- Test: `electron/server/__tests__/narration-assembly.test.ts`

**Interfaces:**
- Consumes: `normalizeSpokenNumbers(input)` from Task 1.
- Preserves: existing `writeChapterFiles(...)` signature and chapter heading/metadata format.

- [ ] **Step 1: Write the persistence RED test.** Pass chapter body text
      containing `1871`, `January 18, 1871`, `HMH0001`, and `GPT-5.6` through
      `writeChapterFiles`, then assert the Markdown body uses the spoken date
      while its heading/identifiers remain exact. Reassemble and assert the
      unified body matches.

- [ ] **Step 2: Run it RED.**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 server/__tests__/narration-assembly.test.ts
```

      Expected: the chapter body still contains `1871`.

- [ ] **Step 3: Normalize only chapter body prose.** In `writeChapterFiles`,
      pass each `ChapterPart.text` through `normalizeSpokenNumbers` before
      composing its Markdown. Do not normalize the generated heading, episode
      code, title, or file name.

- [ ] **Step 4: Add byte-stability coverage.** Write the same already-normalized
      parts twice and assert the body is unchanged; assemble after each write
      and assert the unified narration is unchanged.

- [ ] **Step 5: Run affected chapter flows GREEN.**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  server/__tests__/narration-assembly.test.ts \
  server/__tests__/chunked-narration-smoke.test.ts \
  server/__tests__/chapter-expansion-model-fallback.test.ts \
  server/__tests__/expansion-selected-model.test.ts
```

- [ ] **Step 6: Commit the persistence batch.**

```bash
git add electron/server/lib/narration-assembly.ts \
  electron/server/__tests__/narration-assembly.test.ts
git commit -m "fix: persist spoken narration numbers"
```

### Task 3: Exact TTS request and concurrency qualification

**Files:**
- Test: `electron/server/__tests__/tts-quote-chunk-parity.test.ts`
- Test: `electron/server/__tests__/audio-generator-published-concurrency.test.ts`
- Test: `electron/server/__tests__/audio-text-stats.test.ts`

**Interfaces:**
- Consumes: `normalizeForTts` through the existing `planTtsRequests` and
  reconciler paths.
- Preserves: `resolveGenStudioTtsFanout(itemCount, providerSubmitConcurrency)`
  and all existing admission caps.

- [ ] **Step 1: Add the request-boundary RED test.** Feed old narration
      containing `January 18, 1871` to the request planner and assert its first
      planned part contains only `January eighteenth, eighteen seventy-one`.

- [ ] **Step 2: Run the planner/reconciler tests RED before relying on Task 1.**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  server/__tests__/tts-quote-chunk-parity.test.ts \
  server/__tests__/audio-text-stats.test.ts
```

- [ ] **Step 3: Verify shared-boundary GREEN.** Task 1 should satisfy the planner
      without another production converter. Compare the exact planned parts
      used by quote/generation with the reconciler's normalized section stats;
      if a second normalization path exists, delete it in favor of the shared
      helper.

- [ ] **Step 4: Qualify published fanout unchanged.** Run the existing real Mock
      GenStudio test that switches the selected TTS model from hint one to hint
      three and observes max simultaneous POSTs of one then three.

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  server/__tests__/audio-generator-published-concurrency.test.ts \
  server/__tests__/genstudio-runtime.test.ts \
  server/__tests__/genstudio-client-boundary.test.ts
```

- [ ] **Step 5: Strengthen only if evidence is incomplete.** If the existing
      integration test does not exercise catalog selection → parser → generator
      → worker POSTs, extend that test fixture; do not add a new concurrency
      setting or production branch.

- [ ] **Step 6: Commit test-only qualification or the minimal deduplication.**

```bash
git add electron/server/__tests__/tts-quote-chunk-parity.test.ts \
  electron/server/__tests__/audio-text-stats.test.ts \
  electron/server/__tests__/audio-generator-published-concurrency.test.ts \
  electron/server/__tests__/genstudio-runtime.test.ts \
  electron/server/__tests__/genstudio-client-boundary.test.ts
git commit -m "test: qualify spoken TTS requests and fanout"
```

### Task 4: Release checkpoint

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: local v1.0.827 release commit and verified unsigned arm64 DMG.
- Preserves: current installed app, main branch, remote branch, HMH artifacts,
  and paused soak until owner greenlight.

- [ ] **Step 1: Run focused verification.**

```bash
npm run typecheck
npm run lint
git diff --check
```

- [ ] **Step 2: Request independent review.** Review the complete branch diff
      for numeric semantic corruption, technical-token preservation, quote/
      generation drift, existing-script compatibility, and concurrency safety.
      Fix every Critical/Important finding with a focused regression.

- [ ] **Step 3: Bump release metadata.** Set package and lock to `1.0.827` and
      add a newest-first `CHANGELOG.md` entry naming spoken-number narration,
      saved-script cleanup, legacy TTS safety, and published audio fanout
      qualification.

- [ ] **Step 4: Run release gates and full verification.**

```bash
npm run check:changelog
npm run check:release
npm run verify
npm audit --omit=dev
npm --prefix frontend audit --omit=dev
npm run dist:smoke
npm run verify:artifact
git diff --check
```

- [ ] **Step 5: Commit the local release.**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v1.0.827"
```

- [ ] **Step 6: Stop and report.** Provide the commit, artifact path/hash,
      verification totals, and the confirmed selected-model fanout evidence.
      Do not merge, push, install, restart, regenerate, or resume the soak.
      Wait for the owner's explicit greenlight to install and regenerate
      HMH0001 with the newly published Andrew Griffin voice.
