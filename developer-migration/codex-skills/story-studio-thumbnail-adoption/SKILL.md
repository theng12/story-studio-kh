---
name: story-studio-thumbnail-adoption
description: Use when matching, adding, auditing, or extending a reusable Story Studio KH thumbnail format or catalog, or contributing a Thumbnail Recipe component to a modular Content Store/Channel Kit.
---

# Story Studio Thumbnail Adoption

Use this workflow to turn a thumbnail reference into a reusable Story Studio format. A recipe controls composition and headline behavior; the visual art style remains a separate choice.

## Choose the lane first

Before doing any other work, classify the request. For modular Content Store/Channel Kit work, use the Channel Kit component lane below and do not run ordinary runtime wiring, built-in-catalog mutation, niche-default, or release mutation unless the coordinator explicitly scopes a built-in migration. Source/contract analysis and component-specific tests remain allowed. For ordinary Story Studio thumbnail-catalog work, follow the workflow below.

## Workflow

1. Read the repository `AGENTS.md` and inspect the existing thumbnail catalog before changing anything:
   - `electron/server/thumbnail-templates/`
   - `electron/server/models/types.ts`
   - `electron/server/services/thumbnail-template-loader.ts`
   - `frontend/components/ThumbnailRecipeLibraryModal.vue`
   - `frontend/pages/projects/[slug]/image-prompts.vue`
   - `electron/server/generators/image-prompts.ts` and `images.ts`

2. Analyze the reference as a *visual grammar*, never a template to copy. Identify focal hierarchy, title-safe space, object density, palette, annotation treatment, and the editorial headline shape. Do not reuse source wording, logos, people, branded assets, or exact composition.

3. Search the existing catalog. If a recipe is already 80–90% compatible, extend or select it rather than creating a competing near-duplicate. Otherwise add one JSON catalog entry with:
   - searchable `category` and `tags`;
   - `recipe` composition rules, required elements, and avoid list;
   - `headlineFormats` for reusable editorial shapes;
   - `titleMode: "ai"` and exact-title instructions for the selected image model;
   - a title-safe composition band that still contains the AI-rendered headline.

4. Obtain 2–3 original 16:9 preview images as owner-supplied originals or through a Studio Hub production-preview handoff. This control/development Mac does not run production image generation. They must be visibly different subject examples of the same recipe, retain the title band, include an AI-rendered sample headline, and contain no copied material. Verify the returned bytes and record actual WebP dimensions, decoding result, byte size, checksum, source/provenance, and license; do not invent missing evidence.

5. Wire the recipe end to end. Prompt generation must direct the selected image model to render the exact episode title in the title band; thumbnail rendering must preserve the model’s complete output without post-render text compositing. Do not merge scene and thumbnail generation surfaces.

6. Set a niche default only when the format belongs to that niche. Keep project overrides and visual art-style selection independent.

7. Add regression tests covering catalog metadata/assets, exact in-image-title prompt enforcement, direct provider-output preservation, and UI browse/select visibility. Run focused tests, typecheck, and the release checks required by `AGENTS.md`.

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

When the request is modular Content Store/Channel Kit work, this skill is a leaf component lane: **REQUIRED PARENT SKILL:** use `story-studio-channel-kit-authoring` for the coordinator contract and lifecycle. Consume only coordinator-reserved Story content identities; keep Story `identity` separate from the coordinator-supplied `stocking_proposal` for family/SKU. Never invent or renumber Story identities, and never imply a family/SKU is confirmed without its GenStudio confirmation reference.

Return exactly one `status: authored-for-review`, `component: recipe` handoff using the parent contract with its required `reservation`, `identity`, `stocking_proposal`, `source`, `intent`, `compatibility`, `dependencies`, `originality_provenance`, `evidence`, `review_requests`, and `blocked_by` fields. Story `identity` contains exact registry-issued content values only; `stocking_proposal` carries family/SKU as `proposed`, `reserved`, or `confirmed`, with a confirmation reference only when confirmed. `dependencies` is `[]` or exact `pack_id@version` dependencies. It must carry the canonical identity/version/source/provenance/build contract, including source and asset paths, exact content version and dependencies, Formula compatibility, and actual preview WebP dimensions/decoding/size/provenance/license/checksum evidence.

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

## Safety boundary

- Never claim a recipe reproduces a channel or creator.
- Do not introduce a text-free, text-overlay, or post-render-compositing path unless the user explicitly asks for it.
- Preserve existing templates and user-library JSON files. Do not overwrite them to force a reference match.

## Reference

Read [recipe-schema.md](references/recipe-schema.md) when selecting fields or tracing the render path.
