# Thumbnail Successor Store Archives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the five exact kit-successor sources and the fifteen deterministic delivery-attested `.sspack` archives GenStudio needs to publish the approved restored-thumbnail upgrade.

**Architecture:** Preserve all published `1.0.0` bytes. Reserve and author five same-lineage `1.0.1` bundle-only coordinators whose only closure change is the approved thumbnail dependency moving to `1.0.1`. Build the six new components, four thumbnail successors, and five kit successors with the keyless `genstudio-store-receipt-v1` profile into one immutable external artifact batch with an exact ledger.

**Tech Stack:** Story authoring registry CAS/receipt workflow, JSON bundle-only manifests, Node content-pack publisher/validator, Git, SHA-256, existing Content Pack tests.

**Spec:** `docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md`

## Global Constraints

- Source baseline is clean commit `22308b72808b9408806272e4426cb22980d0a227` on isolated branch `codex/editorial-psychology-components`.
- The authoritative component source and preview bytes are exactly those at that commit; do not regenerate or edit previews.
- Existing published `1.0.0` sources and archives remain byte-identical and restorable. Every new byte uses exact version `1.0.1` or a genuinely new component's already-reserved `1.0.0`.
- Five kit successors are required: Calm Mind, Human Behavior, A Life As…, Sleep Journeys, and First Humans.
- Each kit successor retains the same pack, bundle, family, SKU, and all non-thumbnail dependency identities. Exactly one thumbnail dependency moves from `1.0.0` to its approved same-pack `1.0.1`.
- All fifteen Store archives use `--delivery-profile genstudio-store-receipt-v1`, `--min-app-version 1.0.843`, no private key, no archive `key_id`, and no `signature.ed25519`.
- The archive batch must be deterministic, structurally validated, at most 52,428,800 bytes per archive, and written to a new non-existent directory under `<owner-home>/Developer/_handoffs/artifacts/`.
- The owner has authorized stocking/publishing, but Story performs no GenStudio product/release/archive upload, closure mutation, price/discount change, purchase, charge, deploy, tag, push, or public DMG action.
- Do not touch the main checkout's active Content Store/music work or reset any unrelated files.

---

### Task 1: Reserve and author five same-lineage kit successors

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Create: `content-packs/free-starters/kit/calm-mind-v1.0.1/pack.json`
- Create: `content-packs/free-starters/kit/human-behavior-v1.0.1/pack.json`
- Create: `content-packs/free-starters/kit/a-life-as-v1.0.1/pack.json`
- Create: `content-packs/free-starters/kit/sleep-journeys-v1.0.1/pack.json`
- Create: `content-packs/free-starters/kit/first-humans-v1.0.1/pack.json`
- Modify or add: focused Content Pack tests proving exact closure/version behavior

**Interfaces:**
- Consumes: authoring registry revision 4; exact `1.0.0` kit sources; approved thumbnail successors at registry receipt `authoring:ebdae94fffab98d8cf31d1241a29a42c515615cbbf89a18228354ec310e92768`.
- Produces: one new registry CAS receipt for five `channel-kit@1.0.1` records and five verified bundle-only coordinator sources.

- [ ] **Step 1: Write the failing tests**

Add data-driven assertions that each successor has version `1.0.1`, the same stable identity and entitlement proposal as its `1.0.0` lineage, and the exact closure below:

| Kit successor | Only moved dependency |
| --- | --- |
| Calm Mind | `com.storystudio.pack.thumbnail.centered-hero-headline@1.0.1` |
| Human Behavior | `com.storystudio.pack.thumbnail.centered-hero-headline@1.0.1` |
| A Life As… | `com.storystudio.pack.thumbnail.portrait-block-right@1.0.1` |
| Sleep Journeys | `com.storystudio.pack.thumbnail.dreamscape-story-window@1.0.1` |
| First Humans | `com.storystudio.pack.thumbnail.prehistoric-discovery@1.0.1` |

Assert every other dependency is byte-for-byte equal to the corresponding `1.0.0` source declaration, each coordinator has no creative files/assets, and all five exact dependencies exist in the registry.

- [ ] **Step 2: Run the focused tests and observe RED**

Run the new focused file plus:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
```

Expected: the new successor-source assertions fail because the five paths and records do not exist; the baseline registry checks remain green.

- [ ] **Step 3: Reserve the complete five-record batch atomically**

Create one request in this plan's ignored SDD workspace with `expected_revision: 4`, actual branch/task metadata, five same-lineage `channel-kit` identities, exact source paths above, and exact dependency closures. Run:

```bash
npm run content-pack:registry -- reserve --request <request-path>
```

Record revision/receipt. For each issued record, create an expected-identity file and run `verify-receipt`; do not author a source until all five pass.

- [ ] **Step 4: Author the minimal coordinator sources**

Copy each canonical `1.0.0` `pack.json` to its versioned path, then change only:

- top-level `version` to `1.0.1`;
- the one approved thumbnail dependency and matching bundle component dependency to `1.0.1`;
- `changelog` to a truthful one-line note that the release adds the restored thumbnail gallery.

Keep `{{MIN_APP_VERSION}}` and `{{KEY_ID}}` authoring tokens. Do not add creative documents/assets, merchandising fields, GenStudio IDs, price, discount, or publication state.

Transition all five registry records to `authored` with one CAS transition after source/tests pass.

- [ ] **Step 5: Run GREEN verification and commit**

Run:

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/*starter*.test.mjs scripts/content-packs/__tests__/*thumbnail*.test.mjs
npm run typecheck:electron
git diff --check
```

Commit the registry, five source manifests, and focused tests. Do not change application package versions or changelog: this task authors independently delivered content and changes no Story runtime behavior.

---

### Task 2: Build, validate, ledger, and hand off fifteen Store archives

**Files:**
- Create externally: `<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-successors-2026-08-23/archives/*.sspack`
- Create externally: `<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-successors-2026-08-23/archive-ledger.json`
- Create externally: `<owner-home>/Developer/_handoffs/2026-08-23_to-claude-genstudio_from-gpt-storystudio_thumbnail-successor-delivery-archives.md`
- Preserve: repository source bytes after Task 1's commit

**Interfaces:**
- Consumes: six new component sources, four approved thumbnail `1.0.1` sources, five Task 1 kit `1.0.1` sources, GenStudio's same-product/closure contract, and the keyless delivery profile.
- Produces: exact archive bytes plus release/closure input facts for GenStudio; no GenStudio mutation.

- [ ] **Step 1: Establish a fresh immutable output root**

Fail if the target artifact directory already exists. Record Task 1's source commit and the registry revision/receipts. The exact fifteen sources are:

```text
com.storystudio.pack.thumbnail.animal-hardship-annotation@1.0.0
com.storystudio.pack.style.hand-drawn-hardship-cartoon@1.0.0
com.storystudio.pack.style.impasto-psychological-animals@1.0.0
com.storystudio.pack.thumbnail.prehistoric-survival-title-card@1.0.0
com.storystudio.pack.thumbnail.dreamlike-story-title-card@1.0.0
com.storystudio.pack.style.dreamlike-luminous-sleep-illustration@1.0.0
com.storystudio.pack.thumbnail.centered-hero-headline@1.0.1
com.storystudio.pack.thumbnail.portrait-block-right@1.0.1
com.storystudio.pack.thumbnail.dreamscape-story-window@1.0.1
com.storystudio.pack.thumbnail.prehistoric-discovery@1.0.1
com.storystudio.pack.kit.calm-mind@1.0.1
com.storystudio.pack.kit.human-behavior@1.0.1
com.storystudio.pack.kit.a-life-as@1.0.1
com.storystudio.pack.kit.sleep-journeys@1.0.1
com.storystudio.pack.kit.first-humans@1.0.1
```

- [ ] **Step 2: Prove deterministic delivery-profile builds**

For each source, build twice into separate temporary directories using:

```bash
npm run content-pack:build -- <source> \
  --delivery-profile genstudio-store-receipt-v1 \
  --min-app-version 1.0.843 \
  --output <unique-temp-output>.sspack
```

Assert the two byte streams and SHA-256 values match. Validate each with:

```bash
npm run content-pack:validate -- <archive> \
  --delivery-profile genstudio-store-receipt-v1
```

Inspect each ZIP manifest and assert the exact pack/version/minimum, `delivery_profile`, absence of `key_id`, absence of `signature.ed25519`, declared file hashes, bundle dependency closure, and size limit.

- [ ] **Step 3: Freeze one accepted byte stream and exact ledger**

Copy one verified stream per source to the fresh artifact root. Write a machine-readable ledger containing, per release:

- source commit/path and registry receipt;
- `pack_id`, `version`, `archive_sha256`, `archive_bytes`;
- `min_story_version: 1.0.843`;
- truthful `changelog` and `component_summary`;
- `delivery_profile` and structural-validator result;
- for each kit, ordered exact component pack/version closure.

The ledger must distinguish six new component products, four same-product component releases, and five same-product kit releases. It must not invent GenStudio `product_id` or `release_id`; GenStudio resolves those from its existing published records and returns assigned IDs.

- [ ] **Step 4: Write the stocking handoff**

The handoff must:

- cite this plan, the source commit, registry revision/receipts, and ledger path/hash;
- correct the key misunderstanding by citing the `genstudio-store-receipt-v1` profile;
- provide every archive path/hash/byte count and the five exact closures;
- repeat required publication order: create six component products as draft, publish all ten component releases first, then create/pin/publish five kit releases;
- preserve family-level free upgrades for existing owners;
- preserve existing live prices/discounts and require no new purchase/charge;
- request the final GenStudio IDs, immutable hashes, closure evidence, and live verification reply.

- [ ] **Step 5: Verify and report without external mutation**

Run all focused Content Pack tests, registry validation, Electron typecheck, security/model-drift checks, and `git diff --check`. Confirm no PEM/private-key file exists in the repository or artifact root. Confirm the main checkout and GenStudio catalog were not mutated. The external artifacts/handoff are the deliverable; do not upload or publish them from Story.

## Plan Self-Review

**Spec coverage:** The plan preserves exact componentization, stable lineage, immutable historical releases, bundle-only coordinators, keyless GenStudio receipt authority, exact closures, 50 MiB safety, and GenStudio-owned wire identities.

**Placeholder scan:** All fifteen identities, five closure changes, minimum Story version, delivery profile, artifact root, commands, and mutation boundaries are explicit. No paid generation, production key, inferred server ID, or unspecified content is authorized.

**Type consistency:** Kit successors keep the existing `channel-kit`/bundle-only schema; component successors reuse their already-reviewed content schemas. Registry records and archive ledger use exact pack/version identity throughout.
