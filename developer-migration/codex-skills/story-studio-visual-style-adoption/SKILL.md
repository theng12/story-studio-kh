---
name: story-studio-visual-style-adoption
description: Use when a user asks to match, recreate, add, ship, or wire a visual or art style into Story Studio KH, including modular Content Store or Channel Kit component-pack work.
---

# Story Studio Visual Style Adoption

Add one reference-driven style without creating per-page catalogs or weakening existing styles.

## Workflow branch (read first)

- If the request mentions modular Content Store, Channel Kit, component packs, `.sspack`, or a coordinator handoff, use the Channel Kit component lane below as the early branch. Skip ordinary built-in runtime/catalog/default/version/changelog/release mutation; source/contract analysis and component-specific tests remain allowed. Resume ordinary steps only if the coordinator explicitly scopes a built-in migration.
- Otherwise, use the ordinary built-in visual-style workflow below. The preview sourcing and evidence rules apply to both branches.

## Workflow

1. Read the repository `AGENTS.md`, inspect `git status`, and preserve unrelated work.
2. Inspect every supplied reference. Describe medium, line quality, shape language, palette, lighting, composition, character grammar, environments, text treatment, and recurring motifs.
3. Compare the references with every entry in `frontend/composables/useBuiltInStyles.ts`. Add a new style only when the visual contract is meaningfully distinct; otherwise propose a correction to the closest style before editing.
4. Define a stable kebab-case id, concise name, one-line blurb, category, at least three unique visual search tags, a positive `style_bible`, and a provider-friendly `negative_prompt`.
5. Keep the style bible about repeatable rendering traits. Do not bake episode subjects, channel topics, exact captions, or copied compositions into it.
6. Obtain one original 16:9 preview only from owner-supplied original bytes or a Studio Hub production-preview handoff. This control Mac must not invoke production image generation. Demonstrate the distinguishing character, prop, environment, palette, and line treatment; avoid generated sentences and watermarks.
7. Save the supplied or handed-off preview as a 1672x941 WebP over 20 KB at `frontend/public/builtin-style-previews/<style-slug>.webp`. Independently inspect the final workspace image visually and record WebP provenance, license/rights, SHA-256 checksum, decoding result, exact dimensions, and file size. Do not infer or invent missing evidence; mark it blocked instead.
8. Add exactly one entry to `BUILT_IN_STYLES`. This shared source already feeds Character Sheet, Settings, Image Prompts, the searchable modal, project style starters, and render-time saved style data. Do not add parallel page-specific entries.
9. Update `frontend/__tests__/builtInStyles.test.ts`: adjust the expected count and assert the new style's distinctive contract. The existing loop must prove the preview exists and is non-empty.
10. Search all `BUILT_IN_STYLES` consumers to confirm the shared path remains intact. Verify style selection persists both `style_bible` and `negative_prompt`.
11. Run the focused style tests, frontend tests, TypeScript/build checks, and visual asset dimension/size checks. Update version and changelog when making a release, then stage only owned files.

## Channel Kit component lane

## Content Pack registry authority (required for Channel Kit work)

The sole Story content-identity authority in the target Story Studio worktree is `content-packs/authoring-registry.json`. First run `npm run content-pack:registry -- validate`. A missing, invalid, unwritable, stale, collided, or otherwise unavailable registry is not an authority.

Only the coordinator reserves a complete batch of Story content identities. It must use `npm run content-pack:registry -- reserve --request <path>` with the current `expected_revision`, coordinator task/branch, proposal reference, and complete Story identity records. Record the returned registry revision and `receipt_ref`; pass both, plus the exact registry-issued identity and separate stocking proposal, to every leaf.

A leaf may author only from that coordinator-supplied reservation. It must not derive, renumber, reserve, or repair identities; it must not run the reservation command. Before creating source files, write the coordinator-issued complete record (without `receipt_ref`) to an expected-identity JSON file and run `npm run content-pack:registry -- verify-receipt --revision <revision> --receipt <receipt_ref> --expected-identity <path>`. Only an exact successful result authorizes leaf work. Every authoring handoff names `content-packs/authoring-registry.json`, the verified reservation revision, and `receipt_ref` in `reservation`, and uses only the verified receipt's exact Story values in `identity`.

The registry may issue only Story content identities and `family`/`sku` stocking proposals. It must not create GenStudio product, release, account, or wire identities; set pricing or discounts; publish; sign; use production keys; or run production image generation on this control/development Mac.

If any required registry validation, reservation, revision, receipt, expected identity, or exact `verify-receipt` success is absent, fail closed and return this contract response instead of sources, manifests, IDs, archives, or GenStudio records:

```text
status: blocked
blocker: Registry task required
needed: coordinator-owned authoring catalog registry with collision-safe reservation
requested_records: component kinds, proposed human names/slugs, intended reuse/compatibility
do_not_create: Story content IDs, family/SKU proposals, manifests, candidate archives, GenStudio records
```

When the request is modular Content Store or Channel Kit work, first use the parent skill `story-studio-channel-kit-authoring` and follow its coordinator contract. This skill is the Visual Style leaf: consume coordinator-supplied Story reservation identities and stocking proposals/status/confirmation evidence; never invent or renumber Story identities, and never treat family/SKU proposals as identities. Keep Story identity separate from GenStudio identity. Return exactly one canonical Visual Style component handoff with this literal shape:

```text
status: authored-for-review
component: style
reservation: coordinator registry location/revision + receipt reference
identity: exact coordinator-supplied Story values only
stocking_proposal: family/SKU plus proposed|reserved|confirmed status and confirmation reference when confirmed
source: source root and declared content/assets
intent: reusable rendering contract
compatibility: exact compatible reserved components and reasons
dependencies: [] or exact pack_id@version dependencies
originality_provenance: reference inventory, transformations, exclusions, asset origin/license
evidence:
  schema: passed | not_applicable | blocked
  coverage_uniqueness: passed | not_applicable | blocked
  golden_prompt_parity: passed | not_applicable | blocked
  decoded_previews: passed | not_applicable | blocked
  tests: passed | not_applicable | blocked
  deterministic_build: passed | not_applicable | blocked
review_requests: schema, originality/provenance, compatibility, prompt-equivalence/style-bible parity, independent visual, safety, copy, commercial-boundary
blocked_by: [] or explicit blockers
```

Every evidence field must include a concrete check/reference when passed, a reason when `not_applicable`, or the missing input/gate when `blocked`; do not invent a pass or omit an applicable field. `review_requests` must name each review above and include a `not_applicable` reason where applicable. Require independent visual review evidence.

Candidate archives may use ephemeral test keys only. Do not create or populate live GenStudio fields, upload or publish anything, or set pricing. Preview bytes in either branch come from owner-supplied originals or a Studio Hub production-preview handoff; this control Mac must not invoke production image generation and only verifies the returned bytes, provenance, license, checksum, decoding, dimensions, and size. Do not invent missing evidence; put the gap in `blocked_by`. Keep Visual Style and Thumbnail as separate component types, and preserve the shared catalog path; do not create page-specific catalogs or cross-wire thumbnail behavior into this lane.

## Quality Rules

- Prefer medium and rendering language before mood adjectives.
- Separate a recurring character description from generic style traits when continuity matters.
- Keep exact episode wording out of a visual style bible. For thumbnails, defer to `story-studio-thumbnail-adoption`: the selected image model must render the complete title directly in the image, with no post-render text overlay.
- Preserve scene/thumbnail boundaries and the active project art-style precedence documented in `AGENTS.md`.
- Never replace an existing preview unless the user explicitly asks to revise that style.
- Report the preview source provenance and either the Studio Hub task/prompt reference or the owner-supplied source reference, along with the independent visual review and evidence status.
