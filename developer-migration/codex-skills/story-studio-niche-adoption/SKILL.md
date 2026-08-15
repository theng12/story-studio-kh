---
name: story-studio-niche-adoption
description: Use when adopting a Story Studio KH channel niche, main/sub-niche format, duplicate-resistant topic system, or modular Content Store/Channel Kit component pack.
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

6. Test at least: formula/topic-pack compatibility, batch uniqueness, existing-idea avoidance, job queued/running/done/error states, partial output/retry recovery, and UI visibility. Complete required version/changelog/release checks.

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

When the request is modular Content Store/Channel Kit authoring, this skill is a
leaf of the parent **story-studio-channel-kit-authoring** coordinator. Read and
follow that parent contract first. Produce exactly one canonical component
authoring handoff for each Formula and each Topic Pack, using the parent
contract's exact output shape; do not invent an ad hoc JSON schema or create
new identifiers. Put coordinator-reserved Story content identities in the
separate `identity` field. Consume coordinator-supplied family/SKU values in a
separate `stocking_proposal` field, with its proposed/reserved/confirmed status
and confirmation reference; never present a family/SKU as GenStudio-confirmed
without field-exact evidence.

Each handoff must carry the parent contract's fields for: `identity` (including
the reserved Story content version); `source`; `dependencies`; `compatibility`;
`originality_provenance` and license boundary; the exact structured `evidence`
shape (including coverage/uniqueness, tests, and deterministic build where
applicable); `review_requests`; and `blocked_by`. Candidate builds may use
ephemeral test keys only. Do not add live GenStudio fields, uploads,
publishing, pricing, or other live mutations. Preview, image/thumbnail
generation, and generation execution are outside this leaf's job; return the
handoff to the coordinator instead.

## Design rules

- A Formula is reusable across many Packs; a Pack can support multiple Formulas.
- Topic title strings are not the data model. Store distinguishing axes explicitly so uniqueness remains reliable at 100+ ideas.
- Do not make a subjective style field the primary niche identity.
- Keep research opt-in and do not reintroduce the retired Co-writer or Brand systems.

## Reference

Read [two-layer-model.md](references/two-layer-model.md) before adding a new formula or pack.
