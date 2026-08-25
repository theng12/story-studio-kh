# Paid Specialist Kits — Wave 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Author five materially distinct specialist Channel Kit source closures—Comparison Lab, Cinematic Mini-Docs, Challenge & Progress, Case Study Breakdown, and Mystery & Investigation—without pricing, catalog creation, or publication.

**Architecture:** Wave 4 is evidence-gated authoring. It adds four narrow Formulae and five deep Topics; it reuses exact existing/Wave 2 Formula/Style/Recipe releases and creates five empty bundle-only coordinators. Admission tests compare actual contract fields against all free closures and Archival Ledger before reservation; Mystery consolidates into a future Archival Ledger expansion rather than becoming a competing kit if the boundary fails.

**Tech Stack:** Content Pack registry receipt/CAS lifecycle, Content Pack JSON/adapters, Node node:test, planIdeaAssignments, keyless genstudio-store-receipt-v1 validation.

**Spec:** docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md; docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md; docs/superpowers/specs/2026-08-15-content-pack-authoring-registry-design.md; docs/product/content-store-paid-wave-boundaries.md.

## Global Constraints

- Start only after committed registry/source/provenance facts show authored Wave 2 Before/After Timeline/Object Hero + Question and Wave 3 closures. Obtain fresh compatibility review for every intended closure; external handoffs may support human review but never durable clean-checkout tests. Do not reserve while a required predecessor is unresolved.
- New names below are proposed slugs only. No new Story identity may be derived/written/printed before one successful atomic Wave 4 reservation and exact verify-receipt result.
- Reserve exactly 14 records: four series-formula, five topic-pack, five channel-kit. Reserve no Style/Recipe and no duplicate/free Formula.
- Paid is a future owner-approved stocking proposal, not a price, quote, entitlement, product/release/account field, or publication right. Any family/SKU is registry-returned Story proposed status only.
- Existing/Wave 2 Formula/Style/Recipe releases are immutable exact pack_id@version dependencies; never clone, palette-fork, re-preview, rename, or add an asset. No new visual/recipe asset means no preview request in this wave.
- component_summary is release-handoff metadata only, never strict pack.json/creative content. Test exact v1 test-local candidate-handoff fixtures: leaf own-kind slot 1; kit closure slots 1/1/1/1; no ID/version/hash/dependency duplication.
- Candidate boundary: retained external keyless candidates. Build twice with genstudio-store-receipt-v1 and min app 1.0.843; prove equal bytes/SHA-256, <= 52,428,800 bytes, validator success, absent key_id/signature/private key, retain one stream in a fresh artifact root with ledger and non-mutating GenStudio handoff. No upload/product/release/price/purchase/grant/publication mutation.
- Do not change runtime/checkout/version/changelog/current pins/legacy access/Archival Ledger bytes; do not price, generate, upload, purchase, grant, sign production content, publish, push, or deploy.

## Proposed units and fixed reuse closures

| Kit proposed slug | New Formula proposed slug | New Topic proposed slug | Formula | Style | Recipe |
| --- | --- | --- | --- | --- | --- |
| comparison-lab | comparison-lab | comparison-domains-criteria | new Comparison Lab | existing Hand-Drawn Editorial Diagram | Wave 2 Object Hero + Question |
| cinematic-mini-docs | cinematic-mini-docs | human-scale-documentary-subjects | new Cinematic Mini-Docs | existing Cinematic Photoreal | existing Documentary Label Tableau |
| challenge-progress | none | progress-evidence-challenge-constraints | Wave 2 Before/After Timeline | existing Flat Vector Explainer | existing Annotated Business Board |
| case-study-breakdown | case-study-breakdown | case-evidence-operating-decisions | new Case Study Breakdown | existing Hand-Drawn Editorial Diagram | existing Annotated Business Board |
| mystery-investigation | mystery-investigation | open-questions-evidence-boundaries | new Mystery & Investigation | existing Archival Documentary Reconstruction | existing Archival Map Investigation |

Challenge uses Before/After Timeline as its sole Formula closure. Existing Practical Motivation and Habits & Momentum are reference/compatibility inputs only, never paid-kit dependencies; this prevents re-selling free Build Momentum.

## Files and responsibilities

| Path | Responsibility |
| --- | --- |
| content-packs/authoring-registry.json | One atomic Wave 4 reservation and status-only authored transitions. |
| .sdd/wave-4-paid-reservation-request.json | Ignored coordinator request; delete before commit. |
| .sdd/wave-4-paid-expected-identities/*.json | Ignored per-record receipt inputs; delete before commit. |
| content-packs/paid-specialists/formula/{comparison-lab,cinematic-mini-docs,case-study-breakdown,mystery-investigation}/{pack.json,content/series-formula.json} | Four new Formula leaves. |
| content-packs/paid-specialists/topic/{comparison-domains-criteria,human-scale-documentary-subjects,progress-evidence-challenge-constraints,case-evidence-operating-decisions,open-questions-evidence-boundaries}/{pack.json,content/topic-pack.json} | Five deep, safe Topic leaves. |
| content-packs/paid-specialists/kit/{comparison-lab,cinematic-mini-docs,challenge-progress,case-study-breakdown,mystery-investigation}/pack.json | Five manifest-only coordinators. |
| scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs | Admission, collision, coverage, closure, summary, safety, keyless candidate, and review tests. |
| <owner-home>/Developer/_handoffs/artifacts/story-wave-4-paid-specialist-candidates-2026-08-23/ | Fresh retained candidate archives and evidence ledger. |
| <owner-home>/Developer/_handoffs/2026-08-23_to-genstudio_wave-4-paid-specialist-candidates.md | Non-mutating candidate/stocking handoff. |

### Task 1: Write paid-admission and collision tests before reservation

**Files:**
- Create: scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
- Read: docs/product/content-store-paid-wave-boundaries.md, registry, free-starter sources, and content-packs/paid/archival-ledger/.

**Interfaces:**
- Consumes: validateAuthoringRegistry(), registered documents, and the seven existing paid-boundary headings.
- Produces: assertMateriallyDistinct(candidate, freeClosures), assertNoArchivalLedgerCollision(candidate), and summaryFixtureFor(source). The fixture is test-local and has exactly schema_version, kind, summary, and slots keys; compare script_structure, evidence expectations, axes, exclusions, compatibility rules, and acceptance claims rather than title/palette/path.

- [ ] **Step 1: Write failing admission tests**

~~~
test('every specialist has inspectable net-new material value', () => {
  for (const candidate of proposedKits) {
    assert.ok(candidate.newFormula || candidate.newTopic)
    assert.ok(candidate.acceptanceClaims.length >= 3)
    assertMateriallyDistinct(candidate, freeStarterClosures)
  }
})
test('Mystery cannot be an Archival Ledger relabel', () => {
  assertNoArchivalLedgerCollision(mystery)
  assert.match(text(mystery.exclusions), /accusation|identification|conspiracy certainty|unsupported solution/i)
})
~~~

Require: Comparison has two-or-more options, declared criteria/evidence limits, non-prescriptive conclusion; Cinematic is human-scale and excludes archival reconstruction/historical-system investigation; Challenge has baseline/change/time-window/measurements/confounders/bounded result; Case Study is one decision/operating chain with alternatives/limits, not multi-option comparison or generic anatomy; Mystery uses claim/evidence/uncertainty and excludes accusations/identification/conspiracy/solution certainty. Test every policy gate: net-new outcome, material content, no legacy rebilling, independent identity, proofable claim, complete use, transparent dependency.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs

Expected: specialist tests FAIL because Wave 4 contracts are absent; policy test stays green.

- [ ] **Step 3: Implement test-only proposed-slug contract definitions**

Keep five data definitions keyed only by proposed slug: exact reuse roles, net-new outcome, three acceptance claims, exclusions, expected source path. Do not include Story/GenStudio identity, price, SKU, family, release, or product values. Reject equality of all relevant normalized fields with every free closure and all Archival Ledger Topic/Formulas.

- [ ] **Step 4: Run GREEN and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

~~~bash
git add scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
git commit -m "test: gate specialist kits on material value"
~~~

### Task 2: Reserve and verify the exact 14-record specialist batch

**Files:**
- Modify: content-packs/authoring-registry.json
- Create then remove: .sdd/wave-4-paid-reservation-request.json
- Create then remove: .sdd/wave-4-paid-expected-identities/*.json
- Modify: scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

**Interfaces:**
- Consumes: Task 1 passing admission plus exact existing/Wave 2/3 registry records.
- Produces: one receipt/revision, 14 reserved records, 14 exact verification replies.

- [ ] **Step 1: Write the failing batch/closure test**

~~~
const batch = findBatchForProposal(registry, '2026-08-23-paid-specialist-kits-wave-4')
assert.equal(batch.request.records.length, 14)
assert.deepEqual(countBy(batch.request.records, 'kind'), {
  'series-formula': 4, 'topic-pack': 5, 'channel-kit': 5,
})
assert.ok(batch.request.records.every(record => record.status === 'reserved'))
~~~

Assert every source path is listed above; all new leaves have []; every coordinator has exactly its four table dependencies ordered Formula/Topic/Style/Recipe; reject Style/Recipe reservation, Challenge dependency on Practical Motivation/Habits, missing Wave 2 primitive, unknown/GenStudio/commerce field.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

Expected: FAIL because no Wave 4 receipt exists.

- [ ] **Step 3: Submit one coordinator-owned complete request**

Freshly validate registry. Request uses current expected_revision, task wave-4-paid-specialists, branch codex/content-expansion-portfolio, proposal ref docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md#43-paid-specialist-proposals, 14 paths, release-bound minimum status, proposed stocking states, and exact registry-resolved dependencies.

Run: npm run content-pack:registry -- reserve --request .sdd/wave-4-paid-reservation-request.json

On stale/collision delete/revalidate/rebuild the entire 14-record request; never reserve leaves separately.

- [ ] **Step 4: Verify all issued records before sources exist**

Write each returned record minus receipt_ref as uniquely named formula-*, topic-*, and kit-* expected JSON. For each run:

~~~bash
npm run content-pack:registry -- verify-receipt --revision "$WAVE4_REVISION" --receipt "$WAVE4_RECEIPT" --expected-identity .sdd/wave-4-paid-expected-identities/formula-comparison-lab.json
~~~

Repeat with the actual unique file for every 14 records. One failed reply blocks all authoring.

- [ ] **Step 5: Run GREEN and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

Remove .sdd/wave-4-paid-* then commit:

~~~bash
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
git commit -m "chore: reserve specialist kit wave"
~~~

### Task 3: Author four narrow specialist Formulae

**Files:**
- Create: content-packs/paid-specialists/formula/comparison-lab/{pack.json,content/series-formula.json}
- Create: content-packs/paid-specialists/formula/cinematic-mini-docs/{pack.json,content/series-formula.json}
- Create: content-packs/paid-specialists/formula/case-study-breakdown/{pack.json,content/series-formula.json}
- Create: content-packs/paid-specialists/formula/mystery-investigation/{pack.json,content/series-formula.json}
- Modify: scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

**Interfaces:**
- Consumes: verified Formula and exact matching Topic identities.
- Produces: four receipt-bound series-formula leaves with only one compatible new Topic each.

- [ ] **Step 1: Write failing Formula/summary tests**

~~~
assert.match(text(comparison.script_structure), /criteria|evidence limits|non-prescriptive conclusion/i)
assert.match(text(cinematic.script_structure), /place|craft|community|object|human-scale/i)
assert.match(text(caseStudy.script_structure), /decision|operating change|alternatives|limits/i)
assert.match(text(mystery.script_structure), /claim|evidence|uncertainty/i)
assert.deepEqual(summaryFixtureFor(comparison).slots, { 'series-formula': 1 })
assert.doesNotMatch(text(mystery), /identify|accuse|conspiracy certainty|solved/i)
~~~

Require test-local handoff fixtures to have schema_version 1, kind series-formula, short summary, only own slot, no identity/version/hash/dependency duplication; assert source manifests/documents have no component_summary. Assert Cinematic excludes historical-system/archival reconstruction; Case Study excludes ranking/generic anatomy; all Formulae exclude provider/style/recipe/commerce behavior.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

Expected: FAIL because the Formula sources are absent.

- [ ] **Step 3: Implement minimal contracts**

Comparison: two-or-more options → explicit criteria → evidence limits/trade-offs → bounded conclusion. Cinematic: place/craft/community/object → human-scale observation → evidence-led story without archival-system claim. Case Study: bounded decision/change/outcome → alternatives → evidence/mechanism → limits. Mystery: observation → claim → evidence → competing explanation → unknown → safe next question.

- [ ] **Step 4: Run GREEN and commit**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

~~~bash
git add content-packs/paid-specialists/formula scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
git commit -m "feat: author specialist formula contracts"
~~~

### Task 4: Author five deep Topics and prove collision-safe coverage

**Files:**
- Create: content-packs/paid-specialists/topic/comparison-domains-criteria/{pack.json,content/topic-pack.json}
- Create: content-packs/paid-specialists/topic/human-scale-documentary-subjects/{pack.json,content/topic-pack.json}
- Create: content-packs/paid-specialists/topic/progress-evidence-challenge-constraints/{pack.json,content/topic-pack.json}
- Create: content-packs/paid-specialists/topic/case-evidence-operating-decisions/{pack.json,content/topic-pack.json}
- Create: content-packs/paid-specialists/topic/open-questions-evidence-boundaries/{pack.json,content/topic-pack.json}
- Modify: scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

**Interfaces:**
- Consumes: four issued Formula compatibility values plus exact Wave 2 Before/After Timeline.
- Produces: five topic-pack leaves with subjects, episode objects, scopes, mechanisms, evidence lenses, exclusions, compatibility rules, exactly five common axes, positive sibling limit, bounded prompt context, and topic-pack:1 summary.

- [ ] **Step 1: Write failing Topic/assignment tests**

~~~
for (const topic of specialistTopics) {
  assert.ok(topic.subjects.length >= 12)
  assert.deepEqual(topic.idea_axes.map(axis => axis.id), ['subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'])
  assert.deepEqual(summaryFixtureFor(topic).slots, { 'topic-pack': 1 })
  assert.ok(topic.prompt_context.length <= 4000)
}
assert.match(text(progress.exclusions), /causal transformation|uncontrolled before/after/i)
assert.match(text(openQuestions.exclusions), /accusation|identification|conspiracy certainty/i)
~~~

Run planIdeaAssignments twice per pair with the literal seed formed by prefixing each table slug with wave-4-; require equal arrays, unique fingerprints, all dimensions, and sibling difference in episode object plus mechanism. Add negative cases: Comparison cannot use Mystery ladder; Case Study cannot rank two options; Challenge cannot claim uncontrolled causality; Mystery cannot select Archival Ledger political/economic historical-system subject scope.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

Expected: FAIL because the Topic sources are absent.

- [ ] **Step 3: Implement required differentiating axes**

| Topic | Required axes beyond common five |
| --- | --- |
| Comparison Domains & Criteria | option set, criterion, evidence quality, trade-off, conclusion boundary |
| Human-Scale Documentary Subjects | subject, place/craft/community/object, observation source, change-over-time, ethical representation boundary |
| Progress Evidence & Challenge Constraints | baseline, change, time window, measurement, confounder, bounded result |
| Case Evidence & Operating Decisions | decision, operating condition, alternative, evidence source, mechanism/outcome, uncertainty limit |
| Open Questions & Evidence Boundaries | question, observation, evidence class, competing explanation, uncertainty, safe next inquiry |

Challenge supports only Before/After Timeline. Mystery excludes Archival Ledger political/economic historical-system scope and every accusation/identification/conspiracy/unsupported solution. If that restriction cannot sustain material distinction, stop Mystery authoring and return the specified consolidation finding for a future Archival Ledger Topic expansion.

- [ ] **Step 4: Run GREEN material-value checks and commit**

Run: node --test scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs scripts/content-packs/__tests__/archival-ledger-components.test.mjs scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

~~~bash
git add content-packs/paid-specialists/topic scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
git commit -m "feat: add specialist topic depth"
~~~

### Task 5: Compose five exact bundle-only specialist coordinators

**Files:**
- Create: content-packs/paid-specialists/kit/{comparison-lab,cinematic-mini-docs,challenge-progress,case-study-breakdown,mystery-investigation}/pack.json
- Modify: content-packs/authoring-registry.json
- Modify: scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

**Interfaces:**
- Consumes: 14 issued records and table-selected exact releases.
- Produces: five channel-kit manifests and 14 status-only transitions.

- [ ] **Step 1: Write failing closure/summary tests**

~~~
for (const kit of kits) {
  const parts = kit.manifest.bundles[0].components
  assert.equal(parts.filter(x => x.kind === 'series-formula').length, 1)
  assert.ok(parts.some(x => x.kind === 'topic-pack'))
  assert.ok(parts.some(x => x.kind === 'visual-style'))
  assert.ok(parts.some(x => x.kind === 'thumbnail-recipe'))
  assert.deepEqual(summaryFixtureFor(kit.manifest).slots, {
    'series-formula': 1, 'topic-pack': 1, 'visual-style': 1, 'thumbnail-recipe': 1,
  })
}
~~~

Resolve IDs/versions/item kinds from registry, never literals. Reject missing exact dependency, latest, coordinator creative files, product/release/price/discount/quote claims, Challenge Practical Motivation/Habits dependency, or Mystery omission of both selected archival visual components.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

Expected: FAIL because coordinator manifests are absent.

- [ ] **Step 3: Write closures and transition**

Write each manifest from the verified receipt plus registry resolver in table order. Put schema_version 1/channel-kit short summary/slots 1/1/1/1 only in test-local candidate-handoff fixtures, not manifests. After all tests pass, status-transition every Wave 4 record to authored through its common receipt/current revision, revalidating after every response.

- [ ] **Step 4: Run GREEN and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

~~~bash
git add content-packs/authoring-registry.json content-packs/paid-specialists/kit scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
git commit -m "feat: compose specialist kit closures"
~~~

### Task 6: Build retained keyless candidates, evidence ledger, and non-mutating handoff

**Files:**
- Modify: scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
- Create externally: <owner-home>/Developer/_handoffs/artifacts/story-wave-4-paid-specialist-candidates-2026-08-23/archives/*.sspack
- Create externally: <owner-home>/Developer/_handoffs/artifacts/story-wave-4-paid-specialist-candidates-2026-08-23/evidence-ledger.json
- Create externally: <owner-home>/Developer/_handoffs/2026-08-23_to-genstudio_wave-4-paid-specialist-candidates.md

**Interfaces:**
- Consumes: 14 authored sources and deployed keyless delivery profile.
- Produces: retained verified candidates, exact evidence ledger, and blocked-or-ready non-mutating candidate handoff.

- [ ] **Step 1: Write failing candidate-boundary test**

~~~
const first = await buildContentPack({ sourceDirectory, outputPath: firstPath, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })
const second = await buildContentPack({ sourceDirectory, outputPath: secondPath, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })
assert.equal(first.sha256, second.sha256)
assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
assert.ok((await stat(firstPath)).size <= 52_428_800)
assert.equal(zip.file('signature.ed25519'), null)
assert.equal(Object.hasOwn(manifest, 'key_id'), false)
~~~

Validate every archive with this profile; a coordinator contains only manifest.json and leaves contain only manifest/declared JSON/permitted rasters. Test component_summary fixtures with sorted keys exactly [kind, schema_version, slots, summary], schema_version 1, canonical kind, short prose, exact v1 leaf/kit slots, and assert source manifests/documents contain no component_summary. Use temporary comparison outputs only; retain one accepted stream later.

- [ ] **Step 2: Run RED then GREEN**

Run: node --test scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs

Expected: RED before source qualification. This step uses temporary two-build outputs only; do not create the named artifact root until Step 3 identifies at least one independently qualified source/kit.

- [ ] **Step 3: Request independent reviews**

For every Formula/Topic request schema, originality/coverage, compatibility, prompt-equivalence, safety, copy, commercial-boundary, and material-value review. For reused Style/Recipe request fresh compatibility plus visual/thumbnail review and state not_applicable: exact existing/Wave 2 asset reused; no new preview. Independently review all five closures against free catalog and Archival Ledger. Critical/Important/missing/rejected review blocks only that candidate. If at least one source/kit independently passes all applicable gates, fail if the named artifact root exists, rerun its two builds, and copy only that accepted stream into archives/. Write evidence-ledger.json and receiver handoff with ready-for-owner-stocking entries for every retained candidate plus exact blocked entries (identity, source, failed/missing gate, no archive path) for every sibling. Each retained entry records source commit/path, registry receipt/revision, issued Story identity, digest, bytes, min app 1.0.843, delivery profile, validator result, dependencies, component_summary v1, provenance and review evidence. If none pass, create no artifact root and issue only blocked report. It requests field-exact GenStudio stocking inputs but contains no product/release ID, price, discount, quote, upload, or publication instruction.

- [ ] **Step 4: Final checks and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs scripts/content-packs/__tests__/archival-ledger-components.test.mjs scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs && npm run typecheck:electron && git diff --check

~~~bash
git add scripts/content-packs/__tests__/paid-specialist-wave-four.test.mjs
git commit -m "test: qualify specialist kit boundaries"
~~~

## Dependencies and blockers

- Wave 2 Before/After Timeline/Object Hero + Question, Wave 3 authored closures, exact selected existing sources, and validated Archival Ledger are hard dependencies.
- Failure of any paid-boundary gate, absent exact dependency, receipt mismatch, collision, coverage/safety failure, or missing/rejected review blocks the affected candidate before stocking; it never authorizes price or GenStudio action.
- If Mystery overlaps Archival Ledger historical-system scope, do not weaken it or create a competing source: return the consolidation finding.
- A retained handoff is stock-ready only with all applicable review/evidence gates passed; it never authorizes GenStudio product/release creation, commerce terms, upload, purchase, grant, or publication.

## Plan Self-Review

**Spec coverage:** all five specialist outcomes, exactly four new Formulae/five Topics, chosen exact reuse closures, paid admission/material-value tests, Archival Ledger collision defense, safety, five coordinators, receipts, summaries, reviews, and keyless candidates are covered.

**Placeholder scan:** source paths, proposed slugs, exact closure roles, commands, tests, material-value conditions, and blockers are concrete. New identities are intentionally issued by receipt authority.

**Type consistency:** four leaves are series-formula, five are topic-pack, five coordinators are channel-kit, and every kit has exact Formula/Topic/Style/Recipe closure slots; summaries do not repeat identity/archive facts.
