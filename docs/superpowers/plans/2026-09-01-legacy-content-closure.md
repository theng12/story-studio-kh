# Legacy Content Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all approved legacy Content Pack work with 21 authored standalone products, five terminal pre-sale withdrawals, a complete disposition ledger, and enforced read-only Channel Kit compatibility.

**Architecture:** Extend the existing receipt-bound registry lifecycle with a pre-sale-only terminal state, then use the registry’s ordinary reservation and transition commands for every closure. Existing prepared assets are promoted in place; the niche conversion wave translates legacy runtime JSON into strict independent Formula and Topic sources while preserving the legacy loaders as fallback. A tested audit ledger proves every old lane is either authored, absorbed, withdrawn, retained free, retired-compatible, or historical read-only.

**Tech Stack:** Node.js MJS authoring tools; JSON Content Pack sources; TypeScript Zod schemas/adapters/planner; Node/tsx tests; deterministic `genstudio-store-receipt-v1` archive builds; Electron/Nuxt release gates.

**Spec:** `docs/superpowers/specs/2026-09-01-legacy-content-closure-design.md`

## Global Constraints

- Every new product is one standalone Content Pack with exactly one supported kind; no new Channel Kit, `bundle_id`, coordinator product, shared entitlement, or implied dependency.
- Preserve all historical authored Kit records and customer install/validation behavior; reject only new authoring, promotion, arbitrary build, shipping, and stocking paths.
- `withdrawn` is pre-sale-only and terminal. It burns pack/item-or-bundle/family/SKU ownership, requires source absence, and never enters a runtime archive.
- Reserve the five Formulas and twelve Topics atomically before source creation; each leaf verifies the exact returned receipt and remains independently purchasable with `dependencies: []`.
- Preserve runtime legacy niche and Topic JSON files and fallback loading. Do not silently rewrite persisted project IDs or pins.
- Topic products advertise and test only their authored capacity. Do not claim 1,000 ideas.
- Visual and Thumbnail previews come only from the already committed owner-authorized bytes. No production generation runs on this control Mac.
- Story Studio performs no GenStudio upload, publication, pricing, purchase, grant, charge, or customer-data mutation.
- Candidate archives use `genstudio-store-receipt-v1`, `min_app_version: 1.4.93`, two fresh paths per leaf, equal bytes/SHA-256, validation, and maximum size 52,428,800 bytes.
- Runtime/tooling changes release as Story Studio `1.4.93` with matching `package.json`, `package-lock.json`, and newest `CHANGELOG.md` entry.

---

### Task 1: Add terminal withdrawal and enforce read-only Channel Kits

**Files:**
- Modify: `scripts/content-packs/authoring-registry.mjs`
- Modify: `scripts/content-packs/lib.mjs`
- Modify: `scripts/content-packs/ship-pack.mjs`
- Modify: `scripts/content-packs/README.md`
- Modify: `docs/superpowers/specs/2026-08-15-content-pack-authoring-registry-design.md`
- Modify: `developer-migration/codex-skills/story-studio-content-pack-authoring/SKILL.md`
- Test: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Test: `scripts/content-packs/__tests__/publisher-tools.test.mjs`
- Test: `scripts/content-packs/__tests__/ship-pack.test.mjs`
- Test: `scripts/content-packs/__tests__/authoring-skill-migration.test.mjs`

**Interfaces:**
- Produces: registry record status `withdrawn`; lifecycle request `{ changes: { status: 'withdrawn' } }`; exact historical-Kit build allowlist derived from authored registry records.
- Preserves: archive manifest lifecycle `active | retired | replaced`; validation/install of historical Kit archives.

- [ ] **Step 1: Write failing registry tests.** Add behavior tests proving `reserved -> withdrawn`, unchanged original receipt verification, missing-source requirement, existing-source refusal, terminal no-revival/no-proposal mutation, no same-lineage successor, and immutable registry bytes on every rejection. The production change each test catches is an unauthorized identity reuse, materialized withdrawn source, or non-terminal withdrawal.
- [ ] **Step 2: Run the registry test red.**

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
```

Expected: the new withdrawal cases fail because `withdrawn` is not accepted.

- [ ] **Step 3: Implement the minimal registry lifecycle.** Extend stored statuses, keep reservation requests restricted to `reserved`, accept only `reserved -> authored` or `reserved -> withdrawn`, forbid stocking changes in a withdrawal event, keep identities/proposals burned, reject later versions of a withdrawn pack ID, and require the final withdrawn source path not to exist.
- [ ] **Step 4: Run registry tests green.**

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
```

- [ ] **Step 5: Write failing Channel Kit and shipping tests.** Assert new `channel-kit` reservations and authored promotion are refused; only exact already-authored registry identities may use historical rebuild support; direct withdrawn selection is terminal; a mixed selector skips withdrawn records and ships authored leaves.
- [ ] **Step 6: Run those tests red.**

```bash
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs scripts/content-packs/__tests__/ship-pack.test.mjs
```

- [ ] **Step 7: Implement minimal authoring/build/shipping guards.** Existing authored Kit identities remain validation/recovery compatible. New Kit reservation, reserved-to-authored promotion, unregistered/arbitrary Kit build, and Kit shipping/stocking guidance fail closed. Withdrawal of the existing reserved Symbolic Psychology coordinator remains allowed.
- [ ] **Step 8: Document the lifecycle and sync the canonical skill copy.** Explain pre-sale withdrawal, burned identities, the post-sale retirement distinction, and read-only historical Kits.
- [ ] **Step 9: Run focused green gates.**

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/publisher-tools.test.mjs scripts/content-packs/__tests__/ship-pack.test.mjs scripts/content-packs/__tests__/authoring-skill-migration.test.mjs
npm run content-pack:registry -- validate
```

- [ ] **Step 10: Commit.**

```bash
git add scripts/content-packs developer-migration/codex-skills/story-studio-content-pack-authoring docs/superpowers/specs/2026-08-15-content-pack-authoring-registry-design.md
git commit -m "feat(content-packs): close pre-sale reservations safely"
```

### Task 2: Close the nine existing reserved records

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Modify: `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`
- Delete: `content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation/`
- Delete: `content-packs/free-starters/thumbnail/centered-hero-headline-v1.0.1/`
- Delete: `content-packs/free-starters/thumbnail/portrait-block-right-v1.0.1/`
- Delete: `content-packs/free-starters/thumbnail/dreamscape-story-window-v1.0.1/`
- Delete: `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/`
- Create: `content-packs/legacy-thumbnail-restoration/PREPARED-VISUAL-REVIEW.md`
- Test: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`
- Test: `scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs`
- Test: `scripts/content-packs/__tests__/free-starter-inventory.test.mjs`
- Test: `scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs`
- Test: `electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
- Test: `scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`

**Interfaces:**
- Consumes: Task 1 `withdrawn` lifecycle.
- Produces: four authored prepared records and five source-absent withdrawn tombstones; registry revision advances once per exact transition.

- [ ] **Step 1: Write failing closure expectations.** Update source/inventory tests so the four approved products must be authored and independently buildable, while the five obsolete versions must be withdrawn, source-absent, and still lineage-owned.
- [ ] **Step 2: Run the closure tests red.**

```bash
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --test scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs scripts/content-packs/__tests__/free-starter-inventory.test.mjs scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
```

- [ ] **Step 3: Independently inspect the retained preview galleries.** Record subject/composition variation, title readability, malformed-content rejection, style distinctiveness, dimensions, hashes, provenance, and owner-authorized rights basis in `content-packs/legacy-thumbnail-restoration/PREPARED-VISUAL-REVIEW.md`. Reject rather than promote a leaf with unresolved visual evidence.
- [ ] **Step 4: Serialize nine receipt-bound lifecycle transitions.** Starting from the live validated revision, promote the four exact prepared sources to `authored`; withdraw the five exact obsolete records. Use the registry command for every event and validate after every transition.
- [ ] **Step 5: Remove only the five withdrawn source roots.** Re-run `rg` for imports, tests, dependencies, component refs, and provenance before each deletion. Preserve authored replacements, runtime built-ins, historical hashes, published customer closures, and every creative Symbolic Psychology leaf.
- [ ] **Step 6: Run closure tests green and build the four retained sources twice.**

```bash
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --test scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs scripts/content-packs/__tests__/free-starter-inventory.test.mjs scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
npm run content-pack:registry -- validate
```

- [ ] **Step 7: Commit.**

```bash
git add content-packs electron/server/__tests__ scripts/content-packs/__tests__
git commit -m "feat(content-packs): finish prepared legacy products"
```

### Task 3: Reserve and author five standalone Series Formulas

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Create: `content-packs/legacy-niche-conversion/formula/counted-explainer/{pack.json,content/series-formula.json}`
- Create: `content-packs/legacy-niche-conversion/formula/build-under-constraints/{pack.json,content/series-formula.json}`
- Create: `content-packs/legacy-niche-conversion/formula/philosophy-real-problem/{pack.json,content/series-formula.json}`
- Create: `content-packs/legacy-niche-conversion/formula/pastoral-scripture/{pack.json,content/series-formula.json}`
- Create: `content-packs/legacy-niche-conversion/formula/prayer/{pack.json,content/series-formula.json}`
- Test: `scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs`
- Test: `electron/server/__tests__/legacy-content-closure-source.test.ts`

**Interfaces:**
- Produces: five exact Formula IDs from the spec; Counted Explainer and Pastoral Scripture IDs consumed by Task 4 Topic compatibility.

- [ ] **Step 1: Atomically reserve all seventeen new leaf identities.** Use one request at the live revision for five `series-formula` and twelve `topic-pack` records, version `1.0.0`, release-bound minimum app version, proposed family/SKU, `dependencies: []`, and source roots from the spec. Store and verify all seventeen expected identities before creating any source.
- [ ] **Step 2: Write failing Formula source tests.** For each Formula, assert strict schema parse, qualified identity, explicit legacy-field parity, narrative-quality rules, adapter projection, reciprocal Topic compatibility, empty dependency closure, and no Channel Kit metadata.
- [ ] **Step 3: Run Formula tests red.**

```bash
node --test --test-name-pattern "legacy Formula" scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs
npx tsx --test --test-name-pattern "legacy Formula" electron/server/__tests__/legacy-content-closure-source.test.ts
```

- [ ] **Step 4: Author the five minimal strict Formula sources.** Translate legacy camel-case fields explicitly. Merge Devotional and Preaching into Pastoral Scripture modes; keep Prayer separate; do not create Dark Psychology or Music Mix products.
- [ ] **Step 5: Run Formula tests green, build every Formula twice, and transition each exact record to `authored`.**

```bash
node --test --test-name-pattern "legacy Formula" scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs
npx tsx --test --test-name-pattern "legacy Formula" electron/server/__tests__/legacy-content-closure-source.test.ts
npm run content-pack:registry -- validate
```

- [ ] **Step 6: Commit.**

```bash
git add content-packs/authoring-registry.json content-packs/legacy-niche-conversion/formula scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs electron/server/__tests__/legacy-content-closure-source.test.ts
git commit -m "feat(content-packs): add legacy Series Formula products"
```

### Task 4: Author five historical and deep-time Topic Packs

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Create: `content-packs/free-starters/formula/history-explained-v1.0.2/{pack.json,content/series-formula.json}` as the minimal reciprocal free successor
- Create: `content-packs/legacy-niche-conversion/topic/<approved-slug>/{pack.json,content/topic-pack.json}` for Ancient Humans Environments, Social Life, Technology, Speculative Earth, and Ancient Civilizations Economics
- Modify: `scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs`
- Modify: `electron/server/__tests__/legacy-content-closure-source.test.ts`
- Modify: `scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs`

**Interfaces:**
- Consumes: Task 3 reservations.
- Produces: five independently purchasable, strict Topic documents with exact reciprocal compatibility.

- [ ] **Step 1: Add failing tests for the five reserved leaves.** Assert every legacy subject survives, strict planning corpora are non-empty and materially distinct, exclusions are domain-specific, safety requirements hold, compatibility resolves, adapter output is usable, deterministic planning returns unique assignments up to the pack’s declared capacity, and the next assignment exhausts safely.
- [ ] **Step 2: Run Topic tests red.**

```bash
node --test --test-name-pattern "legacy Topic" scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs
npx tsx --test --test-name-pattern "legacy Topic" electron/server/__tests__/legacy-content-closure-source.test.ts
```

- [ ] **Step 3: Restore exact reciprocal compatibility without mutating authored bytes.** At the live registry revision, reserve `com.storystudio.pack.formula.history-explained@1.0.2` with the existing item/family/SKU and a new source root. Before creating that source, verify the reservation receipt. Copy the latest free source, add only the Ancient Civilizations Economics Topic ID and a truthful changelog, build twice, validate equality, and transition the exact successor record to `authored`.
- [ ] **Step 4: Author Ancient Humans, Speculative Earth, and Ancient Civilizations Economics leaves.** Preserve all legacy subjects; add evidence-aware planning dimensions; label Speculative Earth counterfactuals; use only the approved Formula IDs.
- [ ] **Step 5: Run the five cases green, build each leaf twice, validate equal archives, and transition every exact record to `authored`.**

```bash
node --test scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs
npx tsx --test electron/server/__tests__/legacy-content-closure-source.test.ts
npm run content-pack:registry -- validate
```

- [ ] **Step 6: Commit.**

```bash
git add content-packs/authoring-registry.json content-packs/free-starters/formula/history-explained-v1.0.2 content-packs/legacy-niche-conversion/topic scripts/content-packs/__tests__ electron/server/__tests__/legacy-content-closure-source.test.ts
git commit -m "feat(content-packs): add historical Topic products"
```

### Task 5: Author three Natural World Topic Packs

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Create: `content-packs/legacy-niche-conversion/topic/<approved-slug>/{pack.json,content/topic-pack.json}` for Fungi, Insects, and Plants
- Modify: `scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs`
- Modify: `electron/server/__tests__/legacy-content-closure-source.test.ts`
- Modify: `scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs`

**Interfaces:**
- Consumes: Task 3 Counted Explainer Formula ID and the existing Natural World Formula ID.
- Produces: three organism-specific Topic products with reciprocal compatibility.

- [ ] **Step 1: Add failing tests for the three reserved leaves.** Assert legacy subjects, distinct planning corpora, organism-specific mechanisms/evidence, safe exclusions, compatibility, adapter usability, deterministic capacity, and exhaustion.
- [ ] **Step 2: Run the Topic tests red.**

```bash
node --test --test-name-pattern "legacy Topic" scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs
npx tsx --test --test-name-pattern "legacy Topic" electron/server/__tests__/legacy-content-closure-source.test.ts
```

- [ ] **Step 3: Author Fungi, Insects, and Plants leaves.** Preserve all subjects; add organism-specific mechanisms/evidence; support Natural World and Counted Explainer.
- [ ] **Step 4: Run the three cases green, build each leaf twice, validate equal archives, and transition every exact record to `authored`.**

```bash
node --test scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs
npx tsx --test electron/server/__tests__/legacy-content-closure-source.test.ts
npm run content-pack:registry -- validate
```

- [ ] **Step 5: Commit.**

```bash
git add content-packs/authoring-registry.json content-packs/legacy-niche-conversion/topic scripts/content-packs/__tests__ electron/server/__tests__/legacy-content-closure-source.test.ts
git commit -m "feat(content-packs): add Natural World Topic products"
```

### Task 6: Author four pastoral and institutional POV Topic Packs

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Create: `content-packs/legacy-niche-conversion/topic/<approved-slug>/{pack.json,content/topic-pack.json}` for Daily Reflection, Expository Teaching, Criminal Hierarchies, and Law Enforcement
- Modify: `scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs`
- Modify: `electron/server/__tests__/legacy-content-closure-source.test.ts`
- Modify: `scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs`

**Interfaces:**
- Consumes: Task 3 Pastoral Scripture Formula and the existing POV Your Life As Formula.
- Produces: four independent Topic products with faith/evidence boundaries and non-glorifying institutional safety rules.

- [ ] **Step 1: Add failing tests for the four reserved leaves.** Assert legacy subjects, distinct planning corpora, exact compatibility, adapter usability, deterministic capacity, and the domain-specific faith and crime-safety boundaries.
- [ ] **Step 2: Run the Topic tests red.**

```bash
node --test --test-name-pattern "legacy Topic" scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs
npx tsx --test --test-name-pattern "legacy Topic" electron/server/__tests__/legacy-content-closure-source.test.ts
```

- [ ] **Step 3: Author Daily Reflection, Expository Teaching, Criminal Hierarchies, and Law Enforcement leaves.** Keep faith interpretation distinct from scripture, and enforce non-glorification, no operational criminal guidance, and institutional/factual evidence rules for the POV lanes.
- [ ] **Step 4: Run the four cases green, build each leaf twice, validate equal archives, and transition every exact record to `authored`.**

```bash
node --test scripts/content-packs/__tests__/legacy-niche-conversion-pack.test.mjs scripts/content-packs/__tests__/compatible-formula-ids-resolve.test.mjs
npx tsx --test electron/server/__tests__/legacy-content-closure-source.test.ts
npm run content-pack:registry -- validate
```

- [ ] **Step 5: Commit.**

```bash
git add content-packs/authoring-registry.json content-packs/legacy-niche-conversion/topic scripts/content-packs/__tests__ electron/server/__tests__/legacy-content-closure-source.test.ts
git commit -m "feat(content-packs): add pastoral and POV Topic products"
```

### Task 7: Add the complete disposition ledger and release record

**Files:**
- Create: `content-packs/legacy-migration-dispositions.json`
- Create: `scripts/content-packs/__tests__/legacy-migration-dispositions.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: final registry/source state from Tasks 1–6.
- Produces: a tested, non-authoritative closure map and Story Studio version `1.4.93`.

- [ ] **Step 1: Write a failing disposition coverage test.** Load actual built-in niche/topic/style/thumbnail/subtitle/effect/overlay/lettering/metadata inventories and the authoring registry. Assert every audited legacy key appears exactly once, every target exists with the claimed terminal state, all 17 new products are authored, all five obsolete reservations are withdrawn, and no unresolved reserved row remains.
- [ ] **Step 2: Run it red.**

```bash
node --test scripts/content-packs/__tests__/legacy-migration-dispositions.test.mjs
```

- [ ] **Step 3: Add the exact disposition ledger.** Record authored replacements, Dark Psychology absorption, Music Mix runtime-compatible retirement, free built-in baselines, historical read-only Kits, and the five withdrawn tombstones. State that the authoring registry—not this ledger—is identity authority.
- [ ] **Step 4: Run the disposition test green.**
- [ ] **Step 5: Bump the desktop release to `1.4.93` and add an answer-first changelog entry describing standalone legacy completion, safe withdrawal, and preserved old projects.**
- [ ] **Step 6: Run focused release gates.**

```bash
npm run check:changelog
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/legacy-migration-dispositions.test.mjs
```

- [ ] **Step 7: Commit.**

```bash
git add content-packs/legacy-migration-dispositions.json scripts/content-packs/__tests__/legacy-migration-dispositions.test.mjs package.json package-lock.json CHANGELOG.md
git commit -m "docs(content-packs): close the legacy migration ledger"
```

### Task 8: Qualify candidates, review the branch, and integrate

**Files:**
- Create outside repository: `/build/Developer/_handoffs/candidates/legacy-content-closure-2026-09-01/`
- Create outside repository: `/build/Developer/_handoffs/artifacts/legacy-content-closure-2026-09-01/`
- Create outside repository: `/build/Developer/_handoffs/2026-09-01_to-genstudio_from-story-studio_legacy-content-closure.json`

- [ ] **Step 1: Build every one of the 21 authored leaves twice to fresh candidate paths.** Use `genstudio-store-receipt-v1` and `--min-app-version 1.4.93`; compare bytes and SHA-256, validate both archives, verify size, and retain one copy only after equality.
- [ ] **Step 2: Create one truthful stocking handoff.** List 21 separate products, their exact Story identities, digests, sizes, compatibility, empty dependencies, review evidence, and proposed 300-credit/no-discount merchandising request. Keep every GenStudio-owned identity absent and state explicitly that no upload/publication/pricing mutation was performed.
- [ ] **Step 3: Run focused and full verification.**

```bash
npm run content-pack:registry -- validate
npm run test:content-packs
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

- [ ] **Step 4: Request task-scoped and whole-branch independent reviews.** Resolve every Critical or Important finding; record any owner-visible ruling in the SDD ledger.
- [ ] **Step 5: Push the clean feature branch, create/update the pull request, merge only when checks and mergeability are clean, synchronize local `main`, and run the required unsigned artifact build from merged `main`.**

```bash
npm run dist:smoke
```

- [ ] **Step 6: Verify the versioned arm64 DMG and bundled `app.asar` report `1.4.93`; do not publish or deploy it.**
