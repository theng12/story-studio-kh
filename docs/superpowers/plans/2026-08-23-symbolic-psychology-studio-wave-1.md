# Symbolic Psychology Studio Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the free Symbolic Psychology Studio as one exact reusable Channel Kit closure and deliver deterministic local candidates plus a non-mutating stocking handoff.

**Architecture:** Reuse Human Behavior Formula, Social Dynamics Topic, Editorial Psychology Symbolic Split, Pastel Surreal Psychological Collage, and Impasto Psychological Animals unchanged. Promote the three receipt-bound sources. Package Oil Painting Classical as a Store Style with its built-in rendering strings copied exactly. Gothic Charcoal is blocked for missing owner evidence and is excluded from this wave.

**Tech Stack:** Content Pack JSON schemas, authoring-registry CAS/receipt CLI, Node tests, sharp, SHA-256, deterministic publisher/validator, keyless genstudio-store-receipt-v1.

**Spec:** docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md

## Global Constraints

- Registry baseline is revision 10 with 72 records. Validate before every mutation; use the observed CAS revision and stop on stale revision.
- Proposed slugs/request values are not identities. Only exact `verify-receipt` output may be used as a Story identity.
- Existing exact nodes are Formula `com.storystudio.pack.formula.human-behavior-explained@1.0.0`, Topic `com.storystudio.pack.topic.human-behavior-social-dynamics@1.0.0`, Recipe `com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split@1.0.0`, Pastel `com.storystudio.pack.style.pastel-surreal-psychological-collage@1.0.0`, and Impasto `com.storystudio.pack.style.impasto-psychological-animals@1.0.0`.
- Coordinator closure is exactly Formula, Topic, Recipe, Pastel default, Impasto optional, Oil optional; it is bundle-only and has no Gothic dependency.
- Use only existing owner-authorized Capi bytes or the existing built-in Oil WebP. No image generation, paid request, production key, upload, purchase, signing, publication, runtime catalog edit, price, or GenStudio field.
- Oil `style_bible` and `negative_prompt` equal the built-in `builtin-oil-painting-classical` values character-for-character.
- Gothic Charcoal is blocked for missing original preview bytes, source/rightsholder provenance, rights/license basis, transformation record, and independent visual review. Create no registry record, source, archive, or kit dependency.
- Prior archive evidence is immutable: Impasto SHA `d0ef0f01b992b91ad9aca8cd1161dd8e038683a674df2f8ed6edefc481bcee99`/292157 bytes comes from the external 15-archive ledger; Formula SHA `f31f09dc268b11a8248133d8b75b7702ac896b8a781a15cd21438f2f1b836dba` and Topic SHA `5885ef3186de126d4643677565cddbe3c39f6102f8378d305dcfb89693b5d738` come from the v1.0.843 catalog ledger. Do not backfill those releases.
- Four new candidates only—Recipe, Pastel, Oil, Kit—use `genstudio-store-receipt-v1`, min app version `1.0.843`, no archive key_id/signature.ed25519, and no more than 52428800 bytes.
- Every new candidate ledger/handoff entry has Story-owned `component_summary`: `{schema_version:1,kind:'canonical kind',summary:'short prose',slots:{'own kind':1}}`. Leaf slots contain exactly its own canonical kind with value 1. Kit slots are `{ 'series-formula':1, 'topic-pack':1, 'visual-style':3, 'thumbnail-recipe':1 }`; omit zero keys. The object never duplicates identity, version, hash, or closure.

## File Structure

| Path | Responsibility |
| --- | --- |
| content-packs/authoring-registry.json | CAS promotion/reservation history |
| .superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1/ | Request and exact receipt-derived identities |
| content-packs/symbolic-psychology-studio/PREVIEW-PROVENANCE.md | Oil evidence and Gothic block |
| content-packs/symbolic-psychology-studio/style/oil-painting-classical/ | New Store Style |
| content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio/pack.json | Exact bundle-only coordinator |
| electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts | Source/evidence/closure tests |
| scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs | Registry/candidate/summary tests |
| /build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/ | Fresh candidate root |

---

### Task 1: Write failing evidence, identity, and summary tests

**Files:** Create the two test files above.

**Interfaces:** Consumes Capi receipt `authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa`, Impasto receipt `authoring:befab004ee2231cdbfc5f076f5b8a87d1fae03b58716cf5ab45d512fce7904b5`, and Oil SHA `721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a`. Produces gates before mutation.

- [ ] **Step 1: Add source assertions**

Use `parseContentPackDocument`, `sharp`, and SHA-256. Assert Capi hashes match its provenance ledger; Impasto is 1672×941 WebP and compatible only with Human Behavior; Oil Store strings equal built-in strings, Oil SHA equals `721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a`, Oil is 1672×941, and runtime JSON contains no Capi, episode, provider, model, price, discount, GenStudio, or absolute owner path. Assert the Gothic directory is absent and ledger says `status: blocked` with all five missing evidence items.

- [ ] **Step 2: Add registry, closure, and candidate-summary assertions**

Assert Recipe/Pastel/Impasto start reserved and must be authored. Require kit root entries `['pack.json']`; dependencies and bundle components have identical ordered pairs Formula, Topic, Recipe, Pastel, Impasto, receipt-issued Oil. For every new candidate assert `component_summary` keys are exactly schema_version, kind, summary, slots; a leaf slot contains only its own canonical kind: 1; the Kit map equals the Global Constraint map; no summary has pack_id, version, SHA, or closure.

- [ ] **Step 3: Run RED**

```bash
npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
npm run content-pack:registry -- validate
```

Expected: both new tests fail for missing Wave 1 sources; registry reports revision 10/72.

---

### Task 2: Promote the three reserved sources with original receipts

**Files:** Modify registry; create expected identities for Recipe, Pastel, Impasto.

**Interfaces:** Consumes original records; produces only three reserved-to-authored transitions.

- [ ] **Step 1: Verify receipts**

Copy each registry record to expected identity JSON omitting only receipt_ref, then run exactly:

```bash
npm run content-pack:registry -- verify-receipt --revision 2 --receipt authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa --expected-identity .superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1/expected-identities/editorial-psychology-symbolic-split.json
npm run content-pack:registry -- verify-receipt --revision 2 --receipt authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa --expected-identity .superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1/expected-identities/pastel-surreal-psychological-collage.json
npm run content-pack:registry -- verify-receipt --revision 3 --receipt authoring:befab004ee2231cdbfc5f076f5b8a87d1fae03b58716cf5ab45d512fce7904b5 --expected-identity .superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1/expected-identities/impasto-psychological-animals.json
```

- [ ] **Step 2: Serial CAS transitions**

Validate before each request. Transition Recipe at expected revision 10, then Pastel, then Impasto, each with `{status:'authored'}`, exact original receipt, `version:'1.0.0'`, and coordinator task `symbolic-psychology-studio-wave-1` / branch `codex/content-expansion-portfolio`. Use the reported revision for each later request; do not alter family/SKU status.

- [ ] **Step 3: GREEN and commit**

```bash
npx tsx --test electron/server/__tests__/capi-psychology-components-source.test.ts electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
npm run content-pack:registry -- validate
git add content-packs/authoring-registry.json .superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1 electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
git commit -m "feat(content-packs): promote symbolic psychology sources"
```

---

### Task 3: Evidence Oil and atomically reserve Oil plus coordinator

**Files:** Create provenance ledger, reservation request, receipt-derived Oil/Kit identity files; modify registry.

**Interfaces:** Consumes built-in Oil asset/strings and promoted nodes. Produces one two-record receipt and no Gothic identity.

- [ ] **Step 1: Record evidence**

Ledger Oil source `frontend/public/builtin-style-previews/oil-painting-classical.webp`, source commit `3838fbccc33d7f58485063c2819e23c80c792976`, SHA `721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a`, 402056 bytes, 1672×941 decode, owner-supplied built-in rights basis, exact string parity, and the explicit Gothic block.

- [ ] **Step 2: Reserve complete batch**

With observed revision 13 only, write reservation request records for proposed Oil `com.storystudio.pack.style.oil-painting-classical` / `com.storystudio.style.oil-painting-classical` at source `content-packs/symbolic-psychology-studio/style/oil-painting-classical`, and proposed Kit `com.storystudio.pack.kit.symbolic-psychology-studio` / `com.storystudio.bundle.symbolic-psychology-studio` at source `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio`. Both are 1.0.0, publisher com.storystudio, release-bound minimum token, reserved status, proposed family/SKU. Oil has no dependencies. Kit dependencies are the six Global Constraint component pairs in exact order. Run reserve once; copy returned records minus receipt_ref to expected identity files and verify both with returned revision/receipt before writing source. If revision differs from 13, stop and assess the intervening registry event.

---

### Task 4: Author exact Oil and exact coordinator

**Files:** Create Oil pack/content/asset and Kit pack; modify registry/tests.

**Interfaces:** Consumes receipt-issued identities; produces a visual-style leaf and six-node bundle-only channel-kit.

- [ ] **Step 1: RED contracts**

Require Oil schema keys `category, compatible_formula_ids, description, id, kind, name, negative_prompt, preview_assets, schema_version, style_bible, tags`; name Oil Painting Classical; category Illustration; tags oil, classical, old master, museum, baroque; one asset; Human Behavior compatibility; receipt-issued manifest values and `{{KEY_ID}}`/`{{MIN_APP_VERSION}}`. Require Kit has no entry other than pack.json and one bundle named Symbolic Psychology Studio with exact ordered closure.

- [ ] **Step 2: Minimal source**

Copy the built-in rendering strings exactly; byte-copy Oil WebP with `cp`; create manifest only from receipt-issued fields. Kit manifest includes ordinary manifest fields, entitlement, six dependencies, one identical six-item bundle, and changelog `Evidence-aware symbolic psychology with three compatible visual styles.` Do not create content/assets for kit or any Gothic artifact.

- [ ] **Step 3: GREEN, transition, commit**

Run Task 2 focused tests; transition Oil then Kit from reserved to authored with exact receipt/current revision. Validate and commit:

```bash
git add content-packs/authoring-registry.json content-packs/symbolic-psychology-studio .superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1 electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
git commit -m "feat(content-packs): compose symbolic psychology studio"
```

---

### Task 5: Build four keyless candidates, review, and hand off

**Files:** Create external candidate root, archives, ledger, and handoff.

**Interfaces:** Consumes committed exact sources and existing archive evidence. Produces Recipe, Pastel, Oil, Kit candidates and canonical handoffs.

- [ ] **Step 1: Fresh deterministic archives**

Fail if external root exists. Build each exact source twice to distinct temporary paths: Capi Recipe, Capi Pastel, Oil, and Kit. Each run uses `npm run content-pack:build -- source-path --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output output-path`, followed by matching validate command. Assert byte/SHA equality, exact receipt-issued pack/version, profile, file hashes, no key_id/signature.ed25519, and size limit.

- [ ] **Step 2: Exact ledger summaries and independent reviews**

Ledger source commit/path, receipt/revision, identity, archive hash/bytes, version floor, profile, validator result, preview evidence, closure separately, and component_summary once. Use Recipe summary `Sparse single-subject psychology thumbnail grammar with an AI-rendered concise title.` with thumbnail-recipe slot; Pastel and Oil each use visual-style slot; Kit uses summary `Evidence-aware symbolic psychology with three compatible visual styles.` and the four nonzero Kit slots. Do not put component_summary in historical entries.

Create component/coordinator handoffs with exact fields status, component, reservation, identity, stocking_proposal, source, intent, compatibility, dependencies, originality_provenance, evidence, review_requests, blocked_by. Request independent schema, originality/provenance, compatibility, prompt-equivalence, visual, thumbnail, safety, copy, commercial-boundary reviews; thumbnail is not_applicable for Styles/Kit with reason. Gothic remains blocked_by.

- [ ] **Step 3: Final validation**

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs scripts/content-packs/__tests__/publisher-tools.test.mjs
npx tsx --test electron/server/__tests__/capi-psychology-components-source.test.ts electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts electron/server/__tests__/content-pack-contract.test.ts electron/server/__tests__/content-pack-registry.test.ts electron/server/__tests__/content-pack-archive.test.ts
npm run typecheck:electron
npm run check:security
npm run check:model-drift
git diff --check
```

Only say ready-for-owner-stocking if all candidates/reviews pass; otherwise return blocked with review names. Handoff explicitly excludes upload, draft creation, price/discount, purchase, grant, signing, publication. Confirm no PEM/private key, provider/model/wire field, executable, or Gothic artifact exists.

## Plan Self-Review

**Spec coverage:** Reuse, source promotion, Oil parity, Gothic qualification failure, exact multi-style coordinator, independent reviews, keyless candidate archives, structured new-candidate summary contract, and handoff boundary are all covered.

**Placeholder scan:** Receipt-derived fields are not guessed and must verify before use; all current paths, receipts, hashes, profiles, and block conditions are exact.

**Type consistency:** Leaf is visual-style; existing kinds remain unchanged; coordinator is channel-kit; every dependency is exact pack_id@version.

## Execution Handoff

Plan saved to docs/superpowers/plans/2026-08-23-symbolic-psychology-studio-wave-1.md. Gothic requires a later evidence-backed reservation wave.
