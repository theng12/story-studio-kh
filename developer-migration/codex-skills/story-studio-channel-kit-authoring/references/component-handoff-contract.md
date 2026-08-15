# Channel Kit Component Handoff Contract

Use these exact output shapes. The coordinator owns catalog reservations and kit composition; leaf skills author only their assigned component.

## 1. Reservation and authoring handoff

First verify a coordinator-owned **authoring catalog registry** exists in the target Story worktree and offers an approved, atomic reservation flow. A runtime discovery registry, a test-local object, a manifest, or an ID pattern is not a reservation authority.

When available, record the registry location/revision and its reservation receipt. Keep authorities distinct:

- **Story content identities:** registry-issued `pack_id`, `item_id`, `bundle_id` (kit only), `version`, `publisher_id`, and `min_app_version` status.
- **Story stocking proposal/reservation:** `family` and `sku`, each marked `proposed`, `reserved`, or `confirmed` with a GenStudio confirmation reference. Do not imply confirmation from a naming pattern.
- **GenStudio identities:** `product_id`, `release_id`, account, quote, purchase, entitlement, grant, and every wire identity are server-owned and absent unless a field-exact GenStudio record supplies them. Never infer or reserve them here.

Never manufacture a missing value.

Each leaf returns one **component authoring handoff**:

```text
status: authored-for-review
component: formula | topic | style | recipe
reservation: registry location/revision + receipt reference
identity: exact registry-issued values only
stocking_proposal: family/SKU plus proposed|reserved|confirmed status and confirmation reference when confirmed
source: source root and declared content/assets
intent: reusable editorial/rendering/composition contract
compatibility: exact compatible reserved components and reasons
dependencies: [] or exact pack_id@version dependencies
originality_provenance: reference inventory, transformations, exclusions, asset origin/license
evidence: structured shape below
review_requests: named independent reviews still required
blocked_by: [] or explicit blockers
```

`dependencies` is explicit: leaves use `[]` unless they really consume an exact external component; a coordinator lists its complete exact closure. For a coordinator, return `component: coordinator`, no creative source/assets, one bundle, and the exact dependency closure. It must have exactly one Formula, one or more Topics, one or more Styles, and one or more Recipes as the approved launch requires; every component reference must name an item in a declared `pack_id@version` dependency.

### Evidence subshape

Use this exact subshape in authoring and candidate handoffs. Every field is `passed` with a concrete reference, `not_applicable` with a reason, or `blocked` with the missing input/gate. Do not invent a pass or omit an applicable field.

```text
evidence:
  schema: passed | not_applicable | blocked
  coverage_uniqueness: passed | not_applicable | blocked
  golden_prompt_parity: passed | not_applicable | blocked
  decoded_previews: passed | not_applicable | blocked
  tests: passed | not_applicable | blocked
  deterministic_build: passed | not_applicable | blocked
```

Coverage/uniqueness is required for Formula/Topic claims; golden/prompt parity for continuity claims; decoded previews for Style/Recipe assets; deterministic build for a candidate archive. Include the check name, source/revision, result, and reason where not applicable or blocked.

### Missing registry: fail closed

Return this instead of sources, manifests, IDs, or archives:

```text
status: blocked
blocker: Registry task required
needed: coordinator-owned authoring catalog registry with collision-safe reservation
requested_records: component kinds, proposed human names/slugs, intended reuse/compatibility
do_not_create: Story content IDs, family/SKU proposals, manifests, candidate archives, GenStudio records
```

## 2. Candidate archive handoff

Candidate is a local review artifact, not a catalog state and not a manifest property. Keep it separate from source authoring.

```text
status: candidate-validated | blocked
content_identities: exact Story pack/item/bundle/version/publisher records
stocking_proposals: family/SKU status and GenStudio confirmation reference only when confirmed
dependencies: [] or complete exact pack_id@version closure
coordinator: exact dependency closure, or none
evidence: structured shape above; deterministic_build includes digest, byte count <= 52428800, and ephemeral key validation
provenance_originality: source/revision and review evidence
independent_reviews: schema, originality/coverage, compatibility, prompt-equivalence, visual, thumbnail, safety, copy, commercial-boundary
ephemeral_key_disposition: generated for validation; private material and distributable candidate removed after qualification
blocked_by: unresolved reviews or contract gates
```

Do not include credentials, private keys, arbitrary URLs, provider/model routing, executable content, GenStudio product/release fields, pricing, discounts, or shelf state. Do not retain a private test key or call the candidate a production archive.

## 3. Stocking handoff

Stocking is an owner/GenStudio task after candidate qualification; it does not publish anything.

```text
status: ready-for-owner-stocking | blocked
content_identities: Story pack_id@version, item_id, bundle_id if applicable, publisher_id, digest, size, min-app-version
stocking_proposals: family/SKU plus proposed|reserved|confirmed status; a confirmed entry cites GenStudio evidence
dependencies: [] or exact pack_id@version closure
kit: bundle-only coordinator Story identity and exact closure, if any
review_evidence: completed independent approvals and unresolved findings
evidence: structured shape above, with all applicable items passed
genstudio_inputs: owner-approved product/copy/license/merchandising requests only; field-exact contract references, never guessed product/release/account/wire fields
production_gates: deployed delivery-attestation profile, released Story support, final sealing evidence, owner publication authorization
explicitly_not_done: upload, draft creation, price/discount decision, purchase, grant, publication, or production signing
```

Price, discount, shelf placement, live product state, ownership, quotes, purchases, grants, delivery, and production sealing remain GenStudio/owner authority. A production preview comes from Studio Hub or owner-supplied assets; this control/development Mac does not generate it.
