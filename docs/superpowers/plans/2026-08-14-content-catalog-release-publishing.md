# Content Catalog Release and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the reviewed Story/GenStudio/catalog work, adopt the
owner-approved single GenStudio commerce-keyring production trust model after
its exact delivery contract is live, qualify deterministic production archives,
package the desktop release, and prepare exact GenStudio stocking evidence
behind explicit owner approval gates.

**Architecture:** Build one clean integration branch from current `main`,
cherry-pick only independently approved heads in dependency order, then compute
the next patch version from the integration base. Production Store archives use
only GenStudio's commerce authority once GenStudio 1.14 publishes an exact,
deployed delivery-attestation/archive profile. Recovery and local-import
publisher-signature paths remain independent. Do not implement the new delivery
mode or seal production archives until that contract is verified.

**Tech Stack:** Git, npm/TypeScript/Nuxt/Electron Builder, existing release
scripts, Content Pack publisher/validator, recovery/local-import Ed25519 test
trust, GenStudio signed commerce/delivery APIs, and admin handoffs.

## Global Constraints

- Known approved heads are: catalog spec `2acf4168a9e51a3a38a5b6dfbbe32eeb7be60b1e`, GenStudio 1.7 + 1.9–1.11 adoption `35eb3942c0090925065d7268acb979105f77c086` (which contains `9c083083`), Archival source/runtime `18e6bbe02f382ee7dcd1868da7052296e24222d8`, and stale Scene Render reliability `b6143164f51e4061f8a75947c3a796cec746e110`.
- Include stale Scene Render only when its task report/review is GO and focused tests remain green after catalog integration. Its exclusion must be recorded, not silently dropped.
- Every shipped Story change bumps both package manifests and adds the matching newest-first changelog entry. Derive the next patch from the integration base; do not guess it in documentation.
- Every production pack `min_app_version` equals the final Story version that
  ships its interpreter and GenStudio-delivery verifier. Production sealing
  fails on mismatch under GenStudio's documented profile.
- There is no separate Story production publisher key or private-key operation.
  The bundled recovery/local-import test key remains public-key-only, scoped to
  those independent paths, and is never trusted for a production Store release.
- The existing 900-second GenStudio download grant is insufficient for
  permanent offline verification. No production-delivery code or production
  sealing starts until GenStudio 1.14 supplies a field-exact signed
  delivery-attestation/archive profile, key-history semantics, and deployed
  evidence.
- Every production archive is immutable, at most 52,428,800 bytes, and
  recorded with version/SHA-256/bytes/components/changelog plus the exact
  GenStudio evidence defined by that profile.
- Story support ships before GenStudio exposes products requiring it. Free kits stock before Archival Ledger; later paid waves require separate reviewed plans.
- No merge to `main`, push, tag, public package, production sealing,
  GenStudio draft/upload/publish, purchase, install, restart, or deploy occurs
  without the explicit owner gate named in the task.
- This Mac remains control/development-only and never performs fleet generation/model qualification.

## Dependencies and execution order

1. Task 1 integrates reviewed branches and produces a reproducible manifest.
2. Task 2 waits for the exact deployed GenStudio 1.14 delivery profile before
   any production-delivery code or release binding.
3. Task 3 runs source/full-app qualification with ephemeral test keys.
4. Task 4 waits for Task 2 and explicit owner authorization for GenStudio's
   documented production sealing operation.
5. Task 5 creates field-exact handoff records; GenStudio mutations require a separate owner approval.
6. Task 6 packages/QA locally; merge/push/install/restart are three explicit owner gates.
7. Task 7 is the final independent release/publishing review.

---

### Task 1: Create the clean combined integration branch

**Files:**
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/integration-manifest.md`
- Integrate: approved feature branches only

**Interfaces:**
- Consumes: current `origin/main`, known approved heads above, plus independently GO-reviewed heads produced by the Catalog Experience, Free Starter, and Paid Catalog plans.
- Produces a manifest recording, for every feature branch, `base_sha`, `head_sha`, the complete ordered `included_sha` range, review evidence, conflicts/resolutions, and excluded optional work.

- [ ] **Step 1: Verify clean inputs and record immutable heads**

```bash
git fetch origin
git status --short
git rev-parse origin/main codex/genstudio-111-adoption codex/archival-ledger-pack codex/fix-stale-render-state
```

Expected: clean integration worktree and known heads matching the reviewed reports. Resolve every future branch's reviewed base and head from its SDD ledger/report, verify that the recorded base is an ancestor of the head, reject merge commits in the range, and write the full oldest-first commit list to the manifest before cherry-picking. A branch name or tip commit by itself is not sufficient evidence because each plan produces multiple task commits.

- [ ] **Step 2: Create the integration branch and cherry-pick in dependency order**

```bash
git switch -c codex/content-catalog-release origin/main
git cherry-pick 35eb3942c0090925065d7268acb979105f77c086
git cherry-pick 2acf4168a9e51a3a38a5b6dfbbe32eeb7be60b1e
```

Then cherry-pick the reviewed bundle-schema/publisher, catalog-experience, free-kit, Archival componentization/paid-catalog commit ranges in that order. Cherry-pick `b6143164...` only if its GO evidence and focused tests satisfy the global constraint. Do not duplicate `18e6bbe0` if the paid-catalog range already contains it.

```bash
apply_reviewed_range() {
  feature_base="$1"
  feature_head="$2"
  git merge-base --is-ancestor "$feature_base" "$feature_head"
  test -z "$(git rev-list --merges "$feature_base..$feature_head")"
  git rev-list --reverse --topo-order "$feature_base..$feature_head" |
    while IFS= read -r commit; do git cherry-pick "$commit"; done
}

apply_reviewed_range "$CATALOG_EXPERIENCE_BASE" "$CATALOG_EXPERIENCE_HEAD"
apply_reviewed_range "$FREE_STARTER_BASE" "$FREE_STARTER_HEAD"
apply_reviewed_range "$PAID_CATALOG_BASE" "$PAID_CATALOG_HEAD"
```

Expected: every SHA listed in the manifest is applied exactly once. After each range, compare the resulting tree for that feature's owned paths against its reviewed head; stop on an omitted task commit, unexpected merge, or duplicate patch.

- [ ] **Step 3: Run post-integration conflict tests**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/genstudio-content-store-delivery.test.ts \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/idea-campaign-planner.test.ts
npm run typecheck
git diff --check
```

Expected: all pass before version/release edits.

- [ ] **Step 4: Commit the integration manifest and independently review**

```bash
git add .superpowers/sdd/2026-08-14-content-catalog-release/integration-manifest.md
git commit -m "chore: record Content Catalog integration"
```

Reviewer verifies ancestry, no missing reviewed correction, no duplicate cherry-pick, no user change overwritten, and exact optional-render disposition.

### Task 2: Wait for and adopt the exact GenStudio production-delivery contract

**Interfaces:**
- Consumes: a deployed GenStudio 1.14 handoff with field-exact signed
  delivery-attestation/archive-profile semantics, archive-sealing workflow,
  public-key history/rotation policy, recall behavior, and a redacted deployed
  response fixture.
- Produces: an approved implementation contract for a strict dual-mode
  verifier; it does not itself change production code, package version,
  changelog, or archive bytes.

- [ ] **Step 1: Stop until the exact deployed contract exists**

The current signed download grant expires after 900 seconds. It authorizes a
transfer but cannot be permanent offline verification evidence. Do not guess
replacement fields, use a local Story publisher key, or begin
production-delivery code until GenStudio 1.14 supplies the exact contract.

- [ ] **Step 2: Review the dual-mode boundary, then implement and release-bind**

After the contract is live, require RED/GREEN coverage for valid/tampered
delivery evidence; archive digest, byte-count, identity, signature, and
key-history failures; no-network boot verification; state/archive tampering;
exact dependency closure; historical key rotation; terminal recall; and
local-import refusal. Preserve recovery and developer publisher-tool tests.
Only then bind the next Story version/changelog. Do not add a Story production
public key, private key, or production archive to the app.

### Task 3: Qualify sources and the complete Story application locally

**Files:**
- Verify: all integrated code/content sources
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/qualification.md`

**Interfaces:**
- Consumes: Task 2's reviewed implementation when available, source packs, and
  ephemeral recovery/local test keys.
- Produces deterministic source qualification and full app verification; no retained distributable pack.

- [ ] **Step 1: Run all Content Pack/source suites**

```bash
node --test scripts/content-packs/__tests__/*.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-*.test.ts \
  electron/server/__tests__/content-store-*.test.ts \
  electron/server/__tests__/genstudio-content-store-*.test.ts \
  electron/server/__tests__/idea-campaign-planner.test.ts
```

Expected: all pass; test cleanup leaves no PEM or `.sspack` under source/worktree.

- [ ] **Step 2: Run full repository gates**

```bash
npm ci
npm --prefix frontend ci
npm run verify
git diff --check
```

Expected: lint/typecheck/backend/frontend/release tests and production builds pass.

- [ ] **Step 3: Independently review qualification evidence**

Record commands, counts, hashes of tested source trees, and any warnings.
Reviewer must issue GO before production-sealing authority is requested.

### Task 4: Seal and verify production archives through GenStudio

**Files:**
- External input: explicit owner authority and GenStudio's deployed sealing
  workflow from Task 2
- Output: immutable versioned `.sspack` archives and their GenStudio delivery
  evidence outside the repository
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/archive-ledger.json`

**Interfaces:**
- Consumes: Task 2 implementation/GO evidence, explicit owner authorization,
  GenStudio's field-exact sealing contract, final Story version, and accepted
  source packs.
- Produces one ledger row per archive using the exact immutable and
  verification facts GenStudio publishes; no Story private key is involved.

- [ ] **Step 1: Obtain explicit owner authority**

Required wording: authorization to use GenStudio's documented production
sealing workflow and create immutable production archives. Without it, stop
after Task 3.

- [ ] **Step 2: Stop unless Task 2's deployed 1.14 profile is GO**

Do not upload, seal, or create a production archive from a Story private key.
Use only GenStudio's documented workflow after its exact immutable evidence,
offline-verification retention, key-history, and recall semantics have been
implemented and reviewed in Story.

- [ ] **Step 3: Validate every archive through the production delivery verifier**

Validate each archive with the exact GenStudio evidence prescribed by Task 2,
then assert its size, manifest identity, minimum version, dependencies, hash,
and byte count match the ledger. Verify its retained evidence at no-network
boot and prove that recall refuses further exact-version delivery without
silently substituting content.

- [ ] **Step 4: Independently review and freeze the archive ledger**

No rebuild under `1.0.0` is allowed after acceptance. Any changed byte requires
a new version/source review. Commit only the bounded ledger, never archives,
private material, or customer credentials:

```bash
git add .superpowers/sdd/2026-08-14-content-catalog-release/archive-ledger.json
git commit -m "docs: record Content Catalog archives"
```

### Task 5: Prepare exact GenStudio stocking handoffs and qualification fixtures

**Files:**
- Create: `<owner-home>/Developer/_handoffs/2026-08-14_to-claude-genstudio_from-gpt-storystudio_content-catalog-release-evidence.md`
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/genstudio-qualification.md`

**Interfaces:**
- Consumes: archive ledger, exact family/release registry, ten free kit composition, live merchandising/bundle contracts, and the Archival 2,000-credit list-price/operator-discount ruling.
- Produces evidence for component families/releases, zero-price kits, shelf placement/media metadata, and Archival Ledger at 2,000; no mutation by Story.

- [ ] **Step 1: Write the evidence handoff**

List exact pack/family/SKU/version/hash/bytes/minimum/components/changelog for every archive, ten zero-price permanent grants, shared-family mapping, Archival 2,000 list-price ruling, approved 90% operator discount for every customer through optional 2026-12-31, absent showcase links as allowed metadata, and Story minimum version. Include acceptance checks for atomic grants, owned-component deduction followed by operator discount, zero balance, exact downloads, withdrawal/recall, and 50 MiB gate. Do not add eligibility or account-history fields; use GenStudio's final wire names.

- [ ] **Step 2: Obtain explicit owner authority for GenStudio drafts/uploads**

Without this approval, send only the evidence handoff. Creating families, drafts, uploading bytes, setting price/shelves, or publishing are external mutations and stop here.

- [ ] **Step 3: Run authorized cross-app qualification without real customer purchase**

Use GenStudio's release qualification workflow and a designated sandbox account only. Record qualification ID, contract/build versions, PASS evidence, and confirm no real customer debit. Publication still requires a later owner approval.

- [ ] **Step 4: Independently compare GenStudio drafts to the archive ledger**

Every ID/hash/byte/version/minimum/price/free flag/component/shelf fact must match. Any mismatch is NO-GO and does not get corrected by Story-side guessing.

### Task 6: Package, QA, merge, push, install, and restart behind separate gates

**Files:**
- Verify: `docs/operations/desktop-release.md`
- Output: unsigned DMG from existing release workflow
- Update: integration manifest with artifact evidence

**Interfaces:**
- Consumes: Tasks 1–5 GO evidence.
- Produces a locally verified desktop artifact; merge/push/install/restart only after explicit owner approvals.

- [ ] **Step 1: Build and verify the local artifact**

```bash
npm run dist:smoke
npm run check:release -- --built --package-input
STORY_CATALOG_RELEASE_VERSION="$(node -p "require('./package.json').version")"
npm run verify:artifact -- \
  --app "dist/mac-arm64/Story Studio KH.app" \
  --dmg "dist/Story Studio KH ${STORY_CATALOG_RELEASE_VERSION}-arm64.dmg"
```

Expected: unsigned DMG and artifact gates pass; packaged resources retain only
the recovery/local-import public verification resource and never contain a
Story production key, private material, or production archives unless
separately approved as recovery content.

- [ ] **Step 2: Perform packaged visual/read-only QA**

Open the packaged app without fleet registration. Verify global Store navigation, empty/offline states, shelves/detail/libraries with safe fixtures, narrow layouts, keyboard focus, What's New, and installed legacy project behavior. Do not claim/purchase/download production content.

- [ ] **Step 3: Obtain explicit merge and push authority**

After approval:

```bash
git switch main
git merge --ff-only codex/content-catalog-release
git push origin main
```

Do not tag or publish a GitHub release unless separately authorized.

- [ ] **Step 4: Obtain explicit install/restart authority**

After approval, quit Story Studio, install the verified DMG through the existing desktop release procedure, restart, and verify displayed version/What's New/trust resource/Store route. This Mac remains excluded from fleet work.

- [ ] **Step 5: Obtain explicit GenStudio publication authority**

Only after the Story minimum version is live may GenStudio publish ten free kits, then Archival Ledger. Verify live catalog facts read-only after publication; no Story-side real purchase is implied.

- [ ] **Step 6: Obtain independent artifact/rollout review**

Before Task 7 relies on the result, a fresh reviewer compares the exact artifact
checksum, installed version, What's New text, recovery-resource isolation,
GenStudio-delivery implementation, main/pushed commit, and any authorized
GenStudio publication facts against Tasks 1–5. Any mismatch is NO-GO.

### Task 7: Run final independent spec/compliance and code-quality review

**Files:**
- Review: integration manifest, qualification report, archive ledger, GenStudio qualification, artifact evidence
- Review: all four implementation plans and approved design

**Interfaces:**
- Consumes: complete combined release/publishing evidence.
- Produces final GO/NO-GO and the smallest remaining owner action set.

- [ ] **Step 1: Verify repository and artifact evidence**

```bash
git status --short
npm run check:changelog
npm run verify
STORY_CATALOG_RELEASE_VERSION="$(node -p "require('./package.json').version")"
npm run verify:artifact -- \
  --app "dist/mac-arm64/Story Studio KH.app" \
  --dmg "dist/Story Studio KH ${STORY_CATALOG_RELEASE_VERSION}-arm64.dmg"
```

Expected: clean worktree and all gates pass.

- [ ] **Step 2: Run independent specification/compliance review**

Map approved-design sections 19–24 to the trust record, archive ledger, GenStudio draft/qualification, Story artifact, free-first ordering, legacy safety, and explicit owner gates.

- [ ] **Step 3: Run independent code-quality/security/release review**

Inspect branch ancestry, version/changelog, packaged resources, no secret/artifact leakage, exact minimum versions/hashes, financial idempotency, no fleet work, and no unauthorized mutation. Critical/Important findings require RED/GREEN and requalification.

- [ ] **Step 4: Report only concrete owner gates**

If production sealing, GenStudio drafts/publication, merge/push, or
install/restart has not been explicitly authorized, report that exact action
and recommendation. Never collapse multiple authorities into an implied blanket
approval.

## Self-review

- Spec coverage: branch integration, GenStudio 1.7/1.11, the required 1.14
  production delivery profile, optional Scene Render, final version/minimum,
  dual-mode trust separation, deterministic archives, GenStudio
  handoff/qualification, package/QA, merge/push/install/restart/publication
  gates are covered.
- Placeholder scan: runtime values are derived from exact branch heads, package version, and owner-provided environment inputs; no guessed release/key/path is embedded.
- Type consistency: the archive ledger is the single handoff/qualification source for versions, hashes, sizes, minimums, and component mappings.
