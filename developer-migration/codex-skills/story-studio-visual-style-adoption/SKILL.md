---
name: story-studio-visual-style-adoption
description: Use when a user asks to match, recreate, add, ship, or wire a visual or art style into Story Studio KH, including a standalone Visual Style product.
---

# Story Studio Visual Style Adoption

Add one reference-driven style without creating per-page catalogs or weakening existing styles.

## Workflow branch (read first)

- If the request mentions the Content Store, content packs, `.sspack`, or a product handoff, use the standalone Content Pack lane below. Skip ordinary built-in runtime/catalog/default/version/changelog/release mutation unless the request separately scopes a built-in migration; source/contract analysis and component-specific tests remain allowed.
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

## Standalone Content Pack lane

For `.sspack` or Content Store work, first use `$story-studio-content-pack-authoring`. A Visual Style is its own independently purchasable product. Do not create a Channel Kit, `bundle_id`, coordinator product, shared entitlement, or dependency merely because a Thumbnail Recipe, Formula, or Topic Pack is compatible.

Consume only the parent workflow's registry-issued Story identity, reservation revision/receipt, brief, and separate family/SKU stocking proposal. Never invent or renumber identities, and never imply a family/SKU is confirmed without field-exact GenStudio evidence. Return exactly one canonical Visual Style handoff:

```text
status: authored-for-review
component: visual-style
reservation: registry location/revision + receipt reference
identity: exact registry-issued Story values only; bundle_id absent
stocking_proposal: family/SKU plus proposed|reserved|confirmed status and confirmation reference when confirmed
source: source root and declared content/assets
intent: reusable rendering contract
compatibility: compatible standalone packs and reasons; never bundle membership
dependencies: [] or exact technically required pack_id@version dependencies
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
