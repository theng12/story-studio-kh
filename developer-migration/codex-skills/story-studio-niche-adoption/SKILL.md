---
name: story-studio-niche-adoption
description: Use when adopting a Story Studio KH channel niche, main/sub-niche format, duplicate-resistant topic system, or standalone Series Formula or Topic Pack product.
---

# Story Studio Niche Adoption

Use this workflow for scalable channel systems: one reusable main format (Series Formula) plus many subject domains (Topic Packs). It prevents a 100-idea request from degenerating into near-duplicates.

## Workflow

1. Read repository `AGENTS.md`, then inspect existing `electron/server/niches/`, `topic-packs/`, `series-formulas/` (where present), idea campaign routes/jobs, and the current generator contracts. Preserve old projects through migration/fallback behavior.

2. Model the request in two layers:
   - **Series Formula**: hook, title shapes, script flow, evidence rules, scene/thumbnail grammar, and structural variety.
   - **Topic Pack**: eras, places, occupations, business types, events, constraints, assets, and factual exclusions.

   Examples: `How did ancient humans…` + Ice Age survival topics; `The Economics of…` + businesses or ancient civilizations; `POV: your life…` + law-enforcement roles or historical occupations.

3. Define diversity axes before generating ideas. Use several independent axes (subject, era/place, role, tension, operating stage, economic lens, outcome) and state incompatible combinations. Seed a recency/duplicate guard against existing episodes and generated candidates.

4. Make generation queueable. Large batches must produce a Job Queue entry with progress, output persistence, retry behavior, and a clear completion contract. Never report success when only part of the campaign was written.

5. Give each formula enough production guidance to carry through scripts, research, scenes, titles, and thumbnails. Attach a thumbnail recipe only where it fits; do not conflate the niche system with visual art style.

6. Test at least: formula/topic-pack compatibility, batch uniqueness, existing-idea avoidance, job queued/running/done/error states, partial output/retry recovery, and UI visibility. For application/runtime changes, complete the required version/changelog/release checks.

## Standalone Content Pack lane

For `.sspack` or Content Store work, first use `$story-studio-content-pack-authoring` and its standalone handoff contract. Produce one independent `series-formula` handoff per Formula and one independent `topic-pack` handoff per Topic Pack. If a request needs both, they are two separately purchasable products—not a Kit, bundle, coordinator product, or shared entitlement.

Consume only the parent workflow's registry-issued Story identity, reservation revision/receipt, brief, and separate family/SKU stocking proposal. Never derive or repair identities, add `bundle_id`, or imply GenStudio confirmation without field-exact evidence. Keep `dependencies: []` unless one pack technically consumes an exact external `pack_id@version`; compatibility or a recommended pairing is not a dependency.

Return the parent contract's `identity`, `source`, `intent`, `compatibility`, `dependencies`, `originality_provenance`, structured `evidence`, `review_requests`, and `blocked_by` fields for each pack. Candidate archives are independent. Do not create Channel Kit artifacts, live GenStudio fields, uploads, publication, pricing mutations, or production generation.

An already-supported standalone Formula or Topic Pack is a `content-only` release: do not bump the Story application version or changelog, build a DMG, or restart the app. Use `requires-app-release` only when the pack needs new Story runtime behavior.

## Design rules

- A Formula is reusable across many Packs; a Pack can support multiple Formulas.
- Topic title strings are not the data model. Store distinguishing axes explicitly so uniqueness remains reliable at 100+ ideas.
- Do not make a subjective style field the primary niche identity.
- Keep research opt-in and do not reintroduce the retired Co-writer or Brand systems.

## Reference

Read [two-layer-model.md](references/two-layer-model.md) before adding a new formula or pack.
