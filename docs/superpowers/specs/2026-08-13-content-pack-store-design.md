# Story Studio Content Pack and Store Design

**Status:** Approved architecture awaiting written-spec review
**Date:** 2026-08-13
**Repositories:** Story Studio KH and GenStudio KH

## 1. Goal

Let Story Studio receive new and updated creative content without an application release when the installed app already understands that content. The same system must support bundled free content, downloadable free content, permanently owned paid content, offline use, deterministic project regeneration, safe rollback, and future first-party upsells.

The initial commercial catalog consists of:

- Series Formula packs
- Topic/Idea packs
- Visual Style packs
- Thumbnail Recipe packs
- Niche Packs, presented commercially as bundles of the component types above

The store uses GenStudio credits. A purchase deducts credits once and grants permanent account ownership. Purchased content is owned by the stable GenStudio account, never by an individual API key.

## 2. Product principles

1. **Content is data, not code.** A pack may populate only schemas and behavior already supported by the installed Story Studio version.
2. **Application behavior remains application-owned.** Algorithms, workflow steps, UI controls, validation logic, renderers, model routing, charging, cancellation, and security changes require an app release.
3. **Existing projects are reproducible.** Projects pin exact pack versions; a catalog update never silently changes future regeneration.
4. **Permanent ownership means permanent use.** A zero credit balance, revoked purchase-time key, store outage, or later listing retirement does not remove an installed owned pack.
5. **API keys are credentials, not ownership.** Any key belonging to the owning account can restore ownership. Switching generation keys does not delete local entitlements.
6. **The same path serves free and paid content.** Free packs are signed, versioned, installed, and updated through the same runtime as paid packs.
7. **Story remains usable offline.** Every app release includes a small immutable recovery catalog.
8. **No silent cost escalation.** Packs cannot name provider products or override GenStudio model, pricing, tier, or routing decisions.
9. **First-party before marketplace.** The first release supports only publisher keys controlled by the owner. Third-party publishing is deferred.
10. **No speculative DRM.** Signatures protect authenticity and integrity. They do not pretend locally rendered prompts or preview images cannot be copied.

## 3. Current-state findings

Story already has three partial content-library systems:

- 21 Series Formula/Niche JSON documents plus user `.niches` overrides
- 26 Topic Pack JSON documents plus user `.topic-packs` content
- 6 Thumbnail Template JSON documents plus user `.thumbnail-templates` content

It also has 17 visual styles embedded directly in frontend TypeScript. Several formula names, narrative policies, and metadata defaults are still injected by `niche-loader.ts`. Thumbnail style catalogs are duplicated between frontend and backend. Current built-in content is copied through Electron `extraResources`, so changing it requires a full application release.

These systems have different loader implementations and incomplete trust boundaries. Current content documents lack immutable content versions, minimum app versions, publisher identity, signatures, hashes, dependencies, entitlements, and rollback metadata. Projects also persist bare content IDs rather than exact content versions.

The new design replaces those separate built-in loaders with one registry while preserving the existing public loader functions as compatibility adapters during migration.

## 4. Pack taxonomy

### 4.1 Series Formula

A Formula defines the repeatable editorial and production identity of a channel:

- channel promise and audience
- narrative perspective and quality rules
- title and logline shapes
- script structure and duration ranges
- evidence expectations
- idea axes owned by the Formula
- metadata section ordering and existing-section configuration
- compatibility with Topic Packs
- recommended installed Style and Thumbnail Recipe IDs
- allowlisted motion or creative-profile selections already understood by the app

A Formula cannot add a new algorithm, metadata section implementation, creative strategy ID, renderer feature, or UI control.

### 4.2 Topic/Idea Pack

A Topic Pack supplies reusable subject-domain coverage beneath a compatible Formula:

- broad and specific subjects
- episode objects such as institutions, policies, decisions, documents, infrastructure systems, transactions, factions, or bounded periods
- time and place scopes
- causal or explanatory mechanisms
- evidence lenses and evidence expectations
- exclusions and compatibility rules
- maximum sibling concentration per broad subject
- pack-specific idea axes
- examples and bounded prompt context

Topic Packs do not contain a fixed list of 1,000 titles. They provide structured coverage space to the Story-owned uniqueness planner.

### 4.3 Visual Style

A Visual Style contains:

- stable ID, name, description, category, and tags
- Style Bible
- negative prompt guidance
- safe raster preview images
- optional compatibility and recommended-use guidance

It cannot include provider IDs, arbitrary URLs, executable templates, or renderer operations.

### 4.4 Thumbnail Recipe

A Thumbnail Recipe contains:

- bounded layout primitives already supported by Story
- prompt and composition guidance
- required and avoided elements
- headline modes and headline rules
- text/font descriptions understood by the current renderer
- safe raster examples
- optional Formula recommendations

The thumbnail composer, image generation, text rendering, supported layout enums, and model choice remain application behavior.

### 4.5 Niche Pack / Channel Kit

A Niche Pack is a store bundle, not a new monolithic runtime schema. It references independently versioned components:

- one Series Formula
- one or more Topic Packs
- zero or more Visual Styles
- zero or more Thumbnail Recipes

Components can also be sold separately. Bundle checkout discounts components already owned instead of charging for them twice.

## 5. Later content types

After the first four component types are stable, the same registry may add schemas for:

- metadata blueprints using existing section implementations
- creative-direction profiles using existing strategy IDs
- motion prompt packs
- bounded video presentation looks
- subtitle and title-card presentation styles
- bounded audio presentation profiles

The following remain private customer data and are not store content by default:

- cloned or favorited voices
- API keys
- selected model IDs
- local music, sound effects, fonts, and paths
- channel links, affiliate links, CTAs, and publishing credentials
- saved episode state and timelines
- generic page presets containing arbitrary settings

## 6. Pack format

The distribution unit is an immutable `.sspack` ZIP archive:

```text
pack.sspack
├── manifest.json
├── signature.ed25519
├── content/
│   ├── formula.json
│   ├── topic-pack.json
│   ├── visual-style.json
│   └── thumbnail-recipe.json
└── assets/
    ├── style-preview.webp
    └── thumbnail-preview.webp
```

The detached signature covers the exact raw `manifest.json` bytes. The manifest binds every other file by SHA-256, byte size, relative path, and MIME type.

Required manifest data:

- `pack_format`
- globally namespaced `pack_id`
- `publisher_id`
- `key_id`
- exact semantic `version`
- `min_app_version`
- content schema version per item
- exact-version dependencies
- stable qualified item IDs
- lifecycle status: active, retired, or replaced
- entitlement SKU/family
- file hashes, sizes, and MIME types
- optional changelog and successor references

Version 1 uses exact dependency versions. Semver range resolution and delta updates are deliberately deferred.

## 7. IDs, precedence, and migration

Signed content uses globally namespaced IDs such as:

```text
com.storystudio.formula.hidden-mechanics-history
com.storystudio.topic.historical-finance
com.storystudio.style.archival-documentary
com.storystudio.thumbnail.archival-map
```

A publisher key may define content only inside its assigned namespace.

User-created content receives an explicit ID such as `user:<uuid>`. New user content cannot silently shadow signed content. Existing same-ID `.niches`, `.topic-packs`, and `.thumbnail-templates` remain readable through a migration adapter and are converted to explicit user forks when edited.

Resolution order:

1. explicit project-selected user fork
2. project-pinned exact signed pack version
3. immutable built-in recovery content or a declared legacy alias

The current bare-ID shadowing behavior is not extended to new packs.

## 8. Local runtime and filesystem

Story’s Electron backend owns all network and filesystem operations. The renderer never downloads, verifies, or extracts a pack.

```text
<Story userData>/content-packs/
├── state.json
├── .staging/<transaction-id>/
├── installed/<publisher-id>/<pack-id>/<exact-version>/
└── quarantine/
```

`state.json` records installed versions, activation, disabled discovery state, verification metadata, cached entitlement references, and pending removal. It uses the existing atomic-store lock and rename behavior.

Installation lifecycle:

1. Download into `.staging` with bounded timeout, redirect, and size rules.
2. Verify the archive hash supplied by the authenticated GenStudio catalog.
3. Reject absolute paths, `..`, backslashes, symlinks, duplicate normalized paths, and case/Unicode collisions.
4. Verify publisher namespace and the Ed25519 signature using Story’s pinned key ring.
5. Verify every declared file and reject undeclared files.
6. Strictly validate every content object with complete schemas.
7. Validate dependencies, cycles, cross-item references, app/schema compatibility, and namespace ownership.
8. Fully decode raster assets and enforce byte and pixel limits.
9. Atomically rename the immutable version into installed storage.
10. Atomically activate it in `state.json` as the final operation.

The runtime retains the previous two verified versions. Boot performs local verification only; it never needs the network. A damaged active version rolls back to the last verified version. A failed installation leaves the currently active version untouched.

Initial limits:

- 50 MiB compressed archive
- 100 MiB expanded archive
- 256 archive entries
- 1 MiB per JSON document
- 15 MiB per raster image
- explicit decoded pixel limits

## 9. Security policy

Version 1 permits only:

- strict JSON
- PNG
- JPEG
- WebP

Version 1 rejects:

- JavaScript, modules, or executable template expressions
- HTML and CSS
- SVG
- binaries or dynamic libraries
- fonts
- symlinks
- arbitrary URLs
- absolute or external file paths
- credentials, tokens, account data, or customer publishing data

Asset references use manifest asset IDs served through an authenticated, path-contained Story endpoint. Packs cannot provide filesystem paths or web-root URLs.

Prompt text is active content even though it is not executable code. It is accepted only in documented fields with strict size limits and cannot grant undeclared tools or capabilities.

## 10. Project pinning and update behavior

Project metadata gains exact pack pins:

```json
{
  "content_pack_versions": {
    "com.storystudio.hmh-kit": "2.1.0",
    "com.storystudio.archival-style": "1.4.2"
  }
}
```

Rules:

- New projects select the newest compatible installed version.
- Existing projects continue using their pinned versions.
- Pack updates never silently change an existing prompt or renderer input.
- The user upgrades a project explicitly after reviewing the content diff.
- Generated jobs and durable artifacts record exact pack IDs, versions, and content hashes.
- Disable hides content from new selection but does not break pinned projects.
- Uninstall is blocked while any project pins the exact version.
- Retirement hides content from new selection; existing pins remain usable.
- A successor reference is advisory and never silently rewrites a project.
- Imported projects with missing packs show exact install requirements and block only affected generation.
- Rollback restores both the prior pack version and the project’s prior pins.

## 11. Store and account ownership

GenStudio owns:

- product catalog
- credit pricing
- purchase quotes
- atomic credit deduction
- purchase ledger
- permanent account entitlements
- signed entitlement receipts
- authorized immutable download grants
- publisher/key policy

Story owns:

- store UI
- local entitlement receipt cache
- pack verification and installation
- enable, disable, update, rollback, and uninstall
- project selection and exact pinning
- offline use
- compatibility and affected-project reporting

Object storage/CDN owns only immutable pack bytes addressed by hash. It makes no entitlement decision.

## 12. Credit purchase contract

Pack purchases use GenStudio credits but are not generation jobs.

Purchase flow:

1. Story requests a signed, expiring quote for a pack or bundle.
2. GenStudio returns pack version, component ownership, exact price, balance before, balance after, quote expiry, and stable account ID.
3. Story displays the exact deduction and remaining generation balance.
4. The customer confirms explicitly.
5. Story submits the quote with an idempotency key.
6. GenStudio atomically deducts credits, records a distinct `content_pack_purchase` ledger entry, grants the permanent entitlement, and issues a signed receipt.
7. Story verifies and caches the receipt before downloading the pack.
8. Installation follows the normal signed-pack path.

Required financial behavior:

- no automatic purchases
- no provisional provider reservation
- no double charge on retry
- no debit without entitlement
- no entitlement without the matching debit except zero-price/free grants
- insufficient balance returns a purchase-specific error and a Buy Credits action
- low post-purchase generation balance receives a warning before confirmation
- bundle pricing removes already-owned component value
- free packs use zero-price permanent entitlements
- pack ledger entries remain distinct from generation charges and returns

Ownership is of the entitlement family/SKU. Compatible updates under the same entitlement family are included. A separately sold expansion uses a separate entitlement family even when compatible with an existing Niche Pack.

## 13. API-key switching and offline entitlements

Ownership belongs to stable `account_id`, not an API key.

- Rotating or revoking a key does not change ownership.
- Any key from the owning account can restore purchases.
- Switching to another key from the same account is seamless.
- Story caches GenStudio’s signed entitlement receipt locally.
- Switching generation to a key from another account does not remove installed packs or break pinned projects on that Mac.
- A zero credit balance does not disable owned content.
- New downloads, restoration on another Mac, and updates require proof from the owning account.
- If the active generation key belongs to another account, Story asks for an owning-account credential only when a remote content action requires it.
- Any owning-account credential is handled through Story's existing encrypted secret store or as a one-use prompt; it is never written into project files, pack state, logs, or entitlement receipts.
- A future named multi-account manager may remember separate Content and Generation credentials, but the first release does not require it.
- Signing out or replacing a generation key never deletes installed pack bytes or cached receipts.

The UI always names both identities when they differ:

- “Generation billed to account B.”
- “This pack is owned by account A.”

## 14. Store experience

Primary sections:

- Discover
- Included
- Owned
- Installed
- Updates

Every product page shows:

- component types included
- preview gallery
- exact credit price and owned-component discount
- current and post-purchase balance
- permanent-ownership statement
- publisher, version, and changelog
- minimum app version
- dependencies and compatibility
- installed and project-usage state
- whether an app update is required
- license terms

The store blocks incompatible checkout before purchase. It never sells content that the installed Story version cannot interpret.

## 15. Application-release boundary

An application release is required for:

- generator algorithms
- workflow steps and tabs
- schema interpreters and content types
- idea uniqueness and coverage-planning behavior
- Continuity and Scene Plan behavior
- new creative strategy/runtime enum values
- rendering, FFmpeg, subtitle, transition, and codec operations
- new metadata section implementations
- GenStudio model, capability, provider, price, and routing behavior
- charging, cancellation, reconciliation, and job safeguards
- trust keys, entitlement protocol, and security policy

A content release is sufficient for:

- Formula prose and rules within existing fields
- new Topic Pack subjects and episode objects
- expanded idea axes and compatibility rules
- new Visual Styles using the existing Style schema
- new Thumbnail Recipes using existing layout primitives
- preview images and content descriptions
- retiring or replacing a content item without deleting existing pins

## 16. Delivery decomposition

This platform is implemented as six independently reviewable subprojects.

### Subproject A — Contracts and publisher tooling

- complete strict schemas for the four item types and Channel Kit references
- define `.sspack` manifest and entitlement receipt schemas
- implement publisher namespace and version rules
- implement an internal signer/validator CLI
- convert one free pack as a golden fixture
- capture prompt-equivalence snapshots before loader migration

**Exit gate:** a signed free fixture validates offline; all tamper, traversal, dependency, and schema-negative fixtures fail deterministically.

### Subproject B — Story local pack runtime

- immutable registry and state store
- bounded staging/download/import
- signature, hash, archive, asset, and dependency validation
- activation, disable, rollback, quarantine, and uninstall guards
- safe asset-serving endpoint
- built-in recovery catalog
- compatibility adapters for existing loaders

**Exit gate:** local signed-pack import and rollback work without GenStudio or renderer network access; interruption never damages active content.

### Subproject C — Catalog migration and project reproducibility

- migrate formulas, Topic Packs, visual styles, and thumbnail recipes
- move hardcoded formula decoration into data
- move visual styles behind the backend catalog
- eliminate duplicated thumbnail style catalogs
- migrate legacy user shadow files to explicit forks
- add exact project pins and job/artifact provenance
- add explicit project upgrade and rollback

**Exit gate:** golden fixtures prove unchanged effective prompts for unchanged content; an update affects a project only after explicit upgrade.

### Subproject D — Story Store and library UI

- Discover/Included/Owned/Installed/Updates surfaces
- compatibility, dependency, entitlement, download, install, disable, update, rollback, and affected-project UX
- account-ownership and generation-account copy
- local import for publisher testing
- accessibility, narrow-screen, offline, and error-state QA

**Exit gate:** all free/local workflows are usable before commerce; no purchase control appears without an exact quote.

### Subproject E — GenStudio credit commerce and entitlements

- product catalog and immutable release records
- signed quote contract
- atomic purchase ledger and permanent entitlement transaction
- idempotent purchase endpoint
- signed entitlement receipts
- owned-component-aware bundle pricing
- authorized download grants
- restore-purchase and account-identity endpoints
- operator publishing and retirement controls

**Exit gate:** proof covers success, retry, insufficient credits, concurrent purchase, owned bundle components, permanent entitlement restoration, and account-key rotation without financial ambiguity.

### Subproject F — Cross-app integration and first launch

- connect Story quote/purchase/receipt/download flows
- verify account ID on key changes
- preserve local use with a different generation account
- perform new-Mac restore using the owner account
- publish signed starter packs
- publish one paid Niche Pack and standalone Topic, Style, and Thumbnail products
- test store outage, entitlement outage, CDN failure, rollback, retirement, and project import
- ship Story and GenStudio releases under their normal qualification workflows

**Exit gate:** the first paid purchase is charged exactly once, survives key rotation and zero balance, restores on another Mac, and never changes an existing project without approval.

## 17. Sequencing

Required order:

1. Subproject A
2. Subproject B
3. Subproject C
4. Subproject D
5. Subproject E
6. Subproject F

Subproject E can begin after A’s manifest and entitlement contracts stabilize, but production integration waits for B through D. Commerce must not dictate the local runtime trust boundary.

## 18. Verification matrix

The final platform must prove:

- archive interruption, timeout, disk-full, and concurrent installation safety
- zip-slip, symlink, case/Unicode collision, archive bomb, and size-limit rejection
- unknown key, invalid signature, namespace violation, undeclared file, and hash mismatch rejection
- malformed schemas, incompatible app versions, missing dependencies, and cycles
- corrupt or mislabeled raster assets and excessive decoded dimensions
- crash before install rename and crash before state activation
- local rollback from damaged active content
- disabled, retired, and uninstall-blocked pinned versions
- imported projects with missing free or paid packs
- exact prompt equality before and after migration
- explicit content change only after project upgrade
- purchase idempotency and atomic credit/entitlement behavior
- insufficient balance and low-balance warnings
- bundle pricing with previously owned components
- key rotation within one account
- generation key switching to a different account
- offline use at zero balance
- restoration on another Mac by the owning account
- store, entitlement service, and CDN outages
- absence of executable pack content and renderer network access
- built-in recovery operation with the downloaded cache removed

## 19. Explicit deferrals

The first release does not include:

- third-party publishers
- subscriptions
- rental or expiring pack ownership
- encrypted DRM
- pack sharing between unrelated GenStudio accounts
- semver dependency solving
- delta updates
- executable plugins
- fonts, SVG, HTML, CSS, or arbitrary media
- automatic project upgrades
- a persistent multi-account credential manager

These deferrals keep the first commercial release auditable and reversible.

## 20. Success criteria

The design is complete when:

1. New supported content can be published without a Story app release.
2. Unsupported behavior cannot enter through a pack.
3. Existing projects reproduce with exact pinned content.
4. Free and paid packs share one secure lifecycle.
5. One credit purchase grants one permanent account entitlement atomically.
6. API-key rotation does not affect ownership.
7. Switching generation accounts does not destroy installed owned content.
8. Owned packs work offline and at zero balance.
9. Restore on another Mac requires and honors the owning account.
10. Story remains usable with only its bundled recovery catalog.
