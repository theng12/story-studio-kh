# Content Catalog Release and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the reviewed Story/GenStudio/catalog work, bind one final Story version and first-party trust key, qualify deterministic production archives, package the desktop release, and prepare exact GenStudio stocking evidence behind explicit owner approval gates.

**Architecture:** Build one clean integration branch from current `main`, cherry-pick only independently approved heads in dependency order, then compute the next patch version from the integration base. Ship the public trust record and schema/UI support before externally signing immutable archives; keep production private keys outside the repository and separate local qualification from every GenStudio draft/upload/publish or desktop push/install/restart action.

**Tech Stack:** Git, npm/TypeScript/Nuxt/Electron Builder, existing release scripts, Content Pack publisher/validator, Ed25519 public trust ring, GenStudio signed commerce/delivery APIs and admin handoffs.

## Global Constraints

- Known approved heads are: catalog spec `2acf4168a9e51a3a38a5b6dfbbe32eeb7be60b1e`, GenStudio 1.7 + 1.9–1.11 adoption `35eb3942c0090925065d7268acb979105f77c086` (which contains `9c083083`), Archival source/runtime `18e6bbe02f382ee7dcd1868da7052296e24222d8`, and stale Scene Render reliability `b6143164f51e4061f8a75947c3a796cec746e110`.
- Include stale Scene Render only when its task report/review is GO and focused tests remain green after catalog integration. Its exclusion must be recorded, not silently dropped.
- Every shipped Story change bumps both package manifests and adds the matching newest-first changelog entry. Derive the next patch from the integration base; do not guess it in documentation.
- Every production pack `min_app_version` equals the final Story version that ships its interpreter and public key. Publisher fails on mismatch.
- Production private key remains outside repository, app, worktrees, logs, handoffs, and shell history. Only canonical Ed25519 SPKI public PEM and stable key ID enter `trust-keys.json`.
- Free-recovery test key is never trusted for production catalog artifacts. Every archive is immutable, at most 52,428,800 bytes, and recorded with version/SHA-256/bytes/components/changelog.
- Story support ships before GenStudio exposes products requiring it. Free kits stock before Archival Ledger; later paid waves require separate reviewed plans.
- No merge to `main`, push, tag, public package, production signing, GenStudio draft/upload/publish, purchase, install, restart, or deploy occurs without the explicit owner gate named in the task.
- This Mac remains control/development-only and never performs fleet generation/model qualification.

## Dependencies and execution order

1. Task 1 integrates reviewed branches and produces a reproducible manifest.
2. Task 2 sets the final version/changelog and public trust record after owner supplies the public key identity.
3. Task 3 runs source/full-app qualification with ephemeral test keys.
4. Task 4 requires owner authorization to access the external production signing operation.
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
- Produces a manifest recording `base_sha`, ordered `included_sha`, review evidence, conflicts/resolutions, and excluded optional work.

- [ ] **Step 1: Verify clean inputs and record immutable heads**

```bash
git fetch origin
git status --short
git rev-parse origin/main codex/genstudio-111-adoption codex/archival-ledger-pack codex/fix-stale-render-state
```

Expected: clean integration worktree and known heads matching the reviewed reports. Resolve future heads with `git rev-parse codex/content-store-catalog-experience codex/free-starter-channel-kits codex/paid-component-catalog` and write those exact hashes to the manifest before cherry-picking.

- [ ] **Step 2: Create the integration branch and cherry-pick in dependency order**

```bash
git switch -c codex/content-catalog-release origin/main
git cherry-pick 35eb3942c0090925065d7268acb979105f77c086
git cherry-pick 2acf4168a9e51a3a38a5b6dfbbe32eeb7be60b1e
```

Then cherry-pick the reviewed bundle-schema/publisher, catalog-experience, free-kit, Archival componentization/paid-catalog heads in that order. Cherry-pick `b6143164...` only if its GO evidence and focused tests satisfy the global constraint. Do not duplicate `18e6bbe0` if the paid-catalog head already contains it.

```bash
git cherry-pick "$(git rev-parse codex/content-store-catalog-experience)"
git cherry-pick "$(git rev-parse codex/free-starter-channel-kits)"
git cherry-pick "$(git rev-parse codex/paid-component-catalog)"
```

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

### Task 2: Bind final Story version and first-party public trust

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `electron/server/content-packs/recovery/trust-keys.json`
- Modify: `electron/server/__tests__/content-pack-state.test.ts`
- Modify: `electron/server/__tests__/content-pack-recovery.test.ts`
- Create: `scripts/content-packs/__tests__/release-binding.test.mjs`

**Interfaces:**
- Consumes: owner-supplied stable key ID and canonical Ed25519 SPKI public PEM; current integrated package version.
- Produces `STORY_CATALOG_RELEASE_VERSION` as next patch and a public-key-only packaged trust record.

- [ ] **Step 1: Verify the owner-controlled public input gate**

```bash
test -n "$STORY_CATALOG_PUBLIC_KEY_ID"
test -s "$STORY_CATALOG_PUBLIC_KEY_PEM_PATH"
openssl pkey -pubin -in "$STORY_CATALOG_PUBLIC_KEY_PEM_PATH" -text -noout
```

Expected: an Ed25519 public key. If absent, stop; never derive it from a private key on this machine.

- [ ] **Step 2: Write failing trust/release-binding tests**

```js
assert.equal(packageJson.version, packageLock.version)
assert.equal(packageJson.version, packageLock.packages[''].version)
assert.equal(changelogNewestVersion, packageJson.version)
assert.equal(trust.keys.some(row => row.key_id === process.env.STORY_CATALOG_PUBLIC_KEY_ID), true)
assert.equal(trustText.includes('PRIVATE KEY'), false)
```

Also assert every production source token is resolved only through explicit `--min-app-version` / `--key-id`, and any mismatch with package version fails.

- [ ] **Step 3: Run RED, derive next patch, and update release records**

```bash
STORY_CATALOG_RELEASE_VERSION="$(node -e "const v=require('./package.json').version.split('.').map(Number); v[2]+=1; process.stdout.write(v.join('.'))")"
npm version "$STORY_CATALOG_RELEASE_VERSION" --no-git-tag-version
```

Add a newest-first changelog entry naming catalog merchandising/proof/library, componentized kit schema, ten free source kits, Archival Ledger source, GenStudio 1.11 contract adoption, and Scene Render reliability only if included. Add the exact public record to `trust-keys.json`; never add private material.

- [ ] **Step 4: Run GREEN and commit**

```bash
node --test scripts/content-packs/__tests__/release-binding.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-state.test.ts \
  electron/server/__tests__/content-pack-recovery.test.ts
npm run check:changelog
git diff --check
git add package.json package-lock.json CHANGELOG.md \
  electron/server/content-packs/recovery/trust-keys.json \
  electron/server/__tests__/content-pack-state.test.ts \
  electron/server/__tests__/content-pack-recovery.test.ts \
  scripts/content-packs/__tests__/release-binding.test.mjs
git commit -m "chore: prepare Content Catalog release"
```

- [ ] **Step 5: Obtain independent trust/release review**

Reviewer validates the PEM/key ID, version/changelog agreement, packaged resource path, no private material, and key rotation compatibility.

### Task 3: Qualify sources and the complete Story application locally

**Files:**
- Verify: all integrated code/content sources
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/qualification.md`

**Interfaces:**
- Consumes: Task 2 release version/public trust, source packs, ephemeral test keys.
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

Record commands, counts, hashes of tested source trees, and any warnings. Reviewer must issue GO before production signing authority is requested.

### Task 4: Build and verify production archives externally

**Files:**
- External input: owner-controlled private key path
- Output: immutable versioned `.sspack` archives outside the repository
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/archive-ledger.json`

**Interfaces:**
- Consumes: explicit owner authorization, external key path, Task 2 key ID/version, accepted source packs.
- Produces one ledger row per archive: `pack_id`, `version`, `sha256`, `bytes`, `min_app_version`, `key_id`, components, changelog.

- [ ] **Step 1: Obtain explicit owner authority**

Required wording: authorization to access the external signing key and create immutable production archives. Without it, stop after Task 3.

- [ ] **Step 2: Validate paths and build without exposing secrets**

```bash
test -s "$STORY_CATALOG_PRIVATE_KEY_PATH"
test -d "$STORY_CATALOG_ARCHIVE_OUTPUT_DIR"
test "${STORY_CATALOG_ARCHIVE_OUTPUT_DIR#$(git rev-parse --show-toplevel)}" = "$STORY_CATALOG_ARCHIVE_OUTPUT_DIR"
```

For each accepted source, run `npm run content-pack:build` with explicit private-key path, Task 2 key ID, Task 2 Story version, and a new versioned output path. Never enable shell tracing or print PEM contents.

- [ ] **Step 3: Validate every archive using only the public key**

```bash
npm run content-pack:validate -- "$STORY_CATALOG_ARCHIVE_PATH" \
  --key-id "$STORY_CATALOG_PUBLIC_KEY_ID" \
  --publisher-id com.storystudio \
  --public-key "$STORY_CATALOG_PUBLIC_KEY_PEM_PATH"
```

Additionally assert each archive is at most 52,428,800 bytes, its manifest version/minimum/key/dependencies match source/release, and archive SHA-256/bytes match the ledger.

- [ ] **Step 4: Independently review and freeze the archive ledger**

No rebuild under `1.0.0` is allowed after acceptance. Any changed byte requires a new version/source review. Commit only the bounded ledger, never archives or keys:

```bash
git add .superpowers/sdd/2026-08-14-content-catalog-release/archive-ledger.json
git commit -m "docs: record Content Catalog archives"
```

### Task 5: Prepare exact GenStudio stocking handoffs and qualification fixtures

**Files:**
- Create: `/build/Developer/_handoffs/2026-08-14_to-claude-genstudio_from-gpt-storystudio_content-catalog-release-evidence.md`
- Create: `.superpowers/sdd/2026-08-14-content-catalog-release/genstudio-qualification.md`

**Interfaces:**
- Consumes: archive ledger, exact family/release registry, ten free kit composition, live merchandising/bundle contracts, Archival price ruling.
- Produces evidence for component families/releases, zero-price kits, shelf placement/media metadata, and Archival Ledger at 2,000; no mutation by Story.

- [ ] **Step 1: Write the evidence handoff**

List exact pack/family/SKU/version/hash/bytes/minimum/components/changelog for every archive, ten zero-price permanent grants, shared-family mapping, Archival 2,000 ruling, absent showcase links as allowed metadata, and Story minimum version. Include acceptance checks for atomic grants, owned discount, zero balance, exact downloads, withdrawal/recall, and 50 MiB gate.

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

Expected: unsigned DMG and artifact gates pass; packaged resources contain the public trust record, never the private key or production archives unless separately approved as recovery content.

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

Before Task 7 relies on the result, a fresh reviewer compares the exact artifact checksum, installed version, What's New text, packaged trust key, main/pushed commit, and any authorized GenStudio publication facts against Tasks 1–5. Any mismatch is NO-GO.

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

If production signing, GenStudio drafts/publication, merge/push, or install/restart has not been explicitly authorized, report that exact action and recommendation. Never collapse multiple authorities into an implied blanket approval.

## Self-review

- Spec coverage: branch integration, GenStudio 1.7/1.11, optional Scene Render, final version/minimum, public trust/private separation, deterministic archives, GenStudio handoff/qualification, package/QA, merge/push/install/restart/publication gates are covered.
- Placeholder scan: runtime values are derived from exact branch heads, package version, and owner-provided environment inputs; no guessed release/key/path is embedded.
- Type consistency: the archive ledger is the single handoff/qualification source for versions, hashes, sizes, minimums, and component mappings.
