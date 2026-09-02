---
name: story-studio-thumbnail-adoption
description: Use when matching, adding, auditing, or extending a reusable Story Studio KH thumbnail format or authoring a standalone Thumbnail Recipe product.
---

# Story Studio Thumbnail Adoption

Use this workflow to turn a thumbnail reference into a reusable Story Studio format. A recipe controls composition and headline behavior; the visual art style remains a separate choice.

## Choose the lane first

Before doing any other work, classify the request. For Content Store `.sspack` work, use the standalone Content Pack lane below and do not run ordinary built-in-catalog, niche-default, or release mutation unless the request separately scopes a built-in migration. Source/contract analysis and component-specific tests remain allowed. For ordinary Story Studio thumbnail-catalog work, follow the workflow below.

## Workflow

1. Read the repository `AGENTS.md` and inspect the existing thumbnail catalog before changing anything:
   - `electron/server/thumbnail-templates/`
   - `electron/server/models/types.ts`
   - `electron/server/services/thumbnail-template-loader.ts`
   - `frontend/components/ThumbnailRecipeLibraryModal.vue`
   - `frontend/pages/projects/[slug]/image-prompts.vue`
   - `electron/server/generators/image-prompts.ts` and `images.ts`

2. Analyze the reference as a *visual grammar*, never a template to copy. Exact matching is not required: references define reusable visual grammar and may seed inspired or materially varied thumbnails. Identify focal hierarchy, title-safe space, object density, palette, annotation treatment, and the editorial headline shape. Do not reuse source wording, logos, people, branded assets, or exact composition.

3. Search the existing catalog. Keep one recipe when differences are parameters; split only when layout, hierarchy, reading order, incompatible typography, or cropping invariants differ. Extend or select a compatible recipe rather than creating a competing near-duplicate; do not use a closest-to-reference baseline as the matching criterion. Otherwise add one JSON catalog entry with:
   - searchable `category` and `tags`;
   - `recipe` composition rules, required elements, and avoid list;
   - `headlineFormats` for reusable editorial shapes;
   - `titleMode: "ai"` and exact-title instructions for the selected image model;
   - a title-safe composition band that still contains the AI-rendered headline.

4. Prepare all preview prompts in one pass and route one parallel Studio Hub production-preview batch, or use owner-supplied originals. Never run production generation on this control/development Mac, and do not call paid generation without an exact quote and explicit authorization. Obtain 3–5 original 16:9 previews that collectively vary subject side, angle, distance, location, palette, symbol, and 1/2/3-line headline arrangements while preserving the core hierarchy, title-safe band, and readability invariants. Palette-only or near-duplicate samples do not count. Cull clipped, misspelled, malformed, UI-contaminated, or near-duplicate previews. Verify each retained file's dimensions, decoding, byte size, checksum, provenance, and license; do not invent missing evidence.

5. Wire the recipe end to end. Prompt generation must direct the selected image model to render the exact episode title in the title band; thumbnail rendering must preserve the model’s complete output without post-render text compositing. Do not merge scene and thumbnail generation surfaces.

6. Set a niche default only when the format belongs to that niche. Keep project overrides and visual art-style selection independent.

7. Add regression tests covering catalog metadata/assets, exact in-image-title prompt enforcement, direct provider-output preservation, and UI browse/select visibility. For built-in application work, run focused tests, typecheck, and the application release checks required by `AGENTS.md`.

## Standalone Content Pack lane

For `.sspack` or Content Store work, first use `$story-studio-content-pack-authoring`. A Thumbnail Recipe is its own independently purchasable product. Do not create a Channel Kit, `bundle_id`, coordinator product, shared entitlement, or dependency merely because a style, Formula, or Topic Pack is compatible.

Consume only the parent workflow's registry-issued Story identity, reservation revision/receipt, brief, and separate family/SKU stocking proposal. Never invent or renumber identities, and never imply a family/SKU is confirmed without its GenStudio confirmation reference.

Return exactly one `status: authored-for-review`, `component: thumbnail-recipe` handoff using the parent contract's required fields. `dependencies` is `[]` unless the recipe technically consumes an exact external `pack_id@version`; compatibility is descriptive. The standalone pack still requires 3–5 original 16:9 previews with meaningful subject, composition, distance, location, palette, symbol, and headline-line variation; palette-only or near-duplicate samples do not count. Cull clipped, misspelled, malformed, UI-contaminated, or near-duplicate outputs. Include actual preview WebP dimensions, decoding, size, provenance, license, and checksum evidence for every retained preview.

Use this exact structured evidence shape; every field is `passed` with a concrete check reference, `not_applicable` with a reason, or `blocked` with the missing input/gate:

```text
evidence:
  schema: passed | not_applicable | blocked
  coverage_uniqueness: passed | not_applicable | blocked
  golden_prompt_parity: passed | not_applicable | blocked
  decoded_previews: passed | not_applicable | blocked
  tests: passed | not_applicable | blocked
  deterministic_build: passed | not_applicable | blocked
```

`decoded_previews` must carry the actual WebP dimensions, decoding result, byte size, checksum, provenance, and license evidence. Require applicable independent reviews in `review_requests`: schema, originality/provenance, compatibility, prompt-equivalence/exact-title, visual/thumbnail, safety, copy, and commercial-boundary. For any review that is not applicable, include the reason. If evidence or a required review is unavailable, report an explicit blocker in `blocked_by` instead of filling the gap with an assumption.

Candidate archive builds may use ephemeral test keys only. Do not add live GenStudio fields, uploads, publishing, or pricing. This control Mac must not execute production image generation: owner-supplied originals or a Studio Hub production handoff supplies preview bytes, and this leaf only verifies them. Keep the thumbnail/visual-style boundary and the scene-generation boundary intact.

Classify an already-supported standalone Thumbnail Recipe as `content-only`: merge and stock its pack release without an application version/changelog bump, DMG, or restart. Use `requires-app-release` only when its schema or rendering behavior needs new Story runtime code.

## Safety boundary

- Never claim a recipe reproduces a channel or creator.
- Do not introduce a text-free, text-overlay, or post-render-compositing path unless the user explicitly asks for it.
- Preserve existing templates and user-library JSON files. Do not overwrite them to force a reference match.

## Reference

Read [recipe-schema.md](references/recipe-schema.md) when selecting fields or tracing the render path.
