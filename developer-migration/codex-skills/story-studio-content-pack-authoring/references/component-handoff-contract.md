# Standalone Content Pack Handoff Contract

Use these shapes for new Content Store work. Each handoff describes one independently purchasable pack. A multi-pack launch repeats the shapes; it never adds a coordinator product, bundle, or Channel Kit.

## 1. Reservation and authoring handoff

Keep these authorities separate:

- **Story identity:** registry-issued `pack_id`, `item_id`, `version`, `publisher_id`, and minimum-app-version status. New products have no `bundle_id`.
- **Story stocking proposal:** `family` and `sku`, each marked `proposed`, `reserved`, or `confirmed`; confirmation requires a field-exact GenStudio reference.
- **GenStudio identity:** product, release, price-version, account, quote, purchase, entitlement, grant, and wire identities remain absent until GenStudio returns them.

Never manufacture a missing value. Each pack returns:

```text
status: authored-for-review
component: series-formula | topic-pack | visual-style | thumbnail-recipe | subtitle-style | scene-effect | overlay | lettering-style | metadata-formula
reservation: registry location/revision + receipt reference
identity: exact registry-issued Story values only; bundle_id absent
stocking_proposal: family/SKU plus proposed|reserved|confirmed status and confirmation reference when confirmed
source: source root and declared content/assets
intent: reusable customer-selectable production contract
compatibility: compatible packs and reasons; never implied bundle membership
dependencies: [] or exact technically required pack_id@version dependencies
originality_provenance: reference inventory, transformations, exclusions, asset origin/license
evidence: structured shape below
review_requests: named independent reviews still required
blocked_by: [] or explicit blockers
```

Compatibility is descriptive. Do not convert a suggested combination into a dependency. A pack must remain useful on its own unless its schema has a real runtime dependency.

### Evidence

Each value is `passed` with a concrete check reference, `not_applicable` with a reason, or `blocked` with the missing input or gate:

```text
evidence:
  schema: passed | not_applicable | blocked
  coverage_uniqueness: passed | not_applicable | blocked
  golden_prompt_parity: passed | not_applicable | blocked
  decoded_previews: passed | not_applicable | blocked
  tests: passed | not_applicable | blocked
  deterministic_build: passed | not_applicable | blocked
```

Coverage/uniqueness applies to Formula and Topic claims; golden/prompt parity to continuity claims; decoded previews to visual assets; deterministic build to candidate archives.

A `thumbnail-recipe` pack requires 3–5 original 16:9 previews that demonstrate meaningful subject and composition variation while preserving the recipe's hierarchy and readability invariants. Reject palette-only variants, near-duplicates, clipped or misspelled text, malformed subjects, and visible UI contamination. `decoded_previews` records dimensions, decoding result, byte size, checksum, provenance, and license for every retained file.

### Missing registry

Return this instead of sources, manifests, identities, archives, or GenStudio records:

```text
status: blocked
blocker: Registry task required
needed: authoring catalog registry with collision-safe atomic reservation
requested_records: standalone pack kinds, proposed human names/slugs, intended compatibility
do_not_create: Story content IDs, family/SKU proposals, manifests, candidate archives, GenStudio records, Channel Kits
```

## 2. Candidate archive handoff

Candidate state is a local review artifact, not a manifest property or live catalog state.

```text
status: candidate-validated | blocked
content_identity: exact Story pack/item/version/publisher record; bundle_id absent
stocking_proposal: family/SKU status and GenStudio confirmation reference only when confirmed
dependencies: [] or exact technically required pack_id@version dependencies
evidence: structured shape above; deterministic_build includes digest, byte count <= 52428800, and local validation profile
provenance_originality: source/revision and review evidence
independent_reviews: applicable schema, originality/coverage, compatibility, prompt-equivalence, visual, thumbnail, safety, copy, commercial-boundary reviews
ephemeral_key_disposition: generated for validation; private material and distributable candidate removed after qualification
blocked_by: unresolved reviews or contract gates
```

Do not include credentials, private keys, arbitrary URLs, provider/model routing, executable content, live GenStudio fields, pricing, discounts, shelf state, or Kit membership.

## 3. Stocking handoff

Stocking is an owner/GenStudio task after qualification. Multiple completed packs may share one submission, but every entry remains a separate product.

```text
status: ready-for-owner-stocking | blocked
products: one entry per standalone pack with Story pack_id@version, item_id, publisher_id, digest, size, min-app-version, family/SKU proposal, compatibility, dependencies, and review evidence
merchandising_request: separate active product + published release + direct listing/purchase/delivery + one published 300-credit price version with no discount for each entry
bundle_or_kit: not-applicable; do not create or mutate
genstudio_identities: absent until returned by GenStudio
production_gates: deployed delivery-attestation profile, released Story support, final sealing evidence, owner publication authorization
explicitly_not_done: Story-side upload, live product/release/price creation, purchase, grant, publication, production signing, or legacy-product mutation
```

Submit only complete, unblocked entries with existing exact archives. GenStudio owns live identities and mutation results. This contract never authorizes customer charges, purchases, grants, refunds, customer-data changes, paid generation, or unrelated product changes.
