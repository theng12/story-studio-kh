# Visual Style Content Store Cutover Design

**Status:** Owner-approved direction; authoring and cutover specification
**Date:** 2026-08-25
**Repository:** Story Studio KH
**Supersedes for visual styles only:** the legacy-preservation requirements in
`docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md`

## Decision

Story Studio will use signed Content Store Visual Style components as the only
visual-style catalog and runtime authority.

Before the static catalog is removed, these six legacy-only looks become
complete standalone signed products:

1. MS Paint Fantasy
2. Pixel Art Story
3. Anime Cel
4. Studio Catalog Realism
5. Whiteboard Doodle Explainer
6. Hand-Drawn Cartoon Explainer

Each is a new standalone product under the owner's standing 2026-08-25
merchandising decision: active product, published release, direct
listing/purchase/delivery, and one published 300-credit price version with no
discount. Story carries that request only in a complete stocking handoff;
GenStudio owns every product, release, price-version, shelf, commerce, and wire
identity.

## Hard-cutover ruling

After all six products are stocked, published, installed, and visible through
Story's signed Visual Style API:

- delete all 17 static `BUILT_IN_STYLES` records and their static preview files;
- delete static merge, fallback, and recovery behavior;
- delete visual-style legacy aliases, grandfathering, project-pin migration,
  and `builtin-*` resolution;
- do not migrate or rewrite saved presets, projects, jobs, or user files;
- allow an old saved `builtin-*` selection to become unavailable;
- keep unrelated Formula, Topic Pack, Thumbnail Recipe, and user-authored style
  behavior unless it can resolve a retired built-in visual-style ID;
- keep generic Image Prompt style presets separate from the Content Store
  Visual Style catalog.

This is an explicit owner reversal of visual-style compatibility requirements
in sections 2.5, 17.1, 18, 20, 22.1, 23.6, and 24.6 of the 2026-08-14 launch
catalog design. The reversal is scoped to built-in visual styles only.

## Authority and sequencing

`content-packs/authoring-registry.json` is the sole Story identity authority.
The coordinator must validate the latest landed registry and reserve the
complete six-record batch atomically. No leaf may author before verifying the
exact registry revision and receipt against its expected identity.

The reservation landed on 2026-08-27 against registry revision 42, the current
committed authority at that point, and is recorded as batch revision 43 under
receipt `authoring:0b7e8bcafc21b4cc6ea8bfd16ee9c21211544fdcb67d2a27dc71c28dedbc30ae`.
Six lifecycle transitions then advanced the records to `authored` (revisions
44-49). An earlier attempt reserved against revision 8; that receipt was never
merged and is void — a receipt is a hash of the request, expected revision
included, so a stale reservation cannot be rebased, only re-made.

The cutover order is strict:

1. Land the current authoritative registry work.
2. Atomically reserve the six Story identities.
3. Author exact source packs from the approved built-in contracts and preview
   bytes.
4. Complete schema, parity, provenance, decoded-preview, visual, safety, copy,
   commercial-boundary, and deterministic-build review.
5. Build and validate six exact `genstudio-store-receipt-v1` archives.
6. Send one complete GenStudio stocking handoff and receive field-exact
   product/release/price/publication evidence.
7. Confirm all six signed styles are installed and API-visible.
8. Remove the static catalog and every visual-style legacy path.
9. Release Story Studio only after source, focused, full, build, and rendered-UI
   verification passes.

## Six product contracts

The registry will issue the exact identities. The proposed stable slugs are:

- `ms-paint-fantasy`
- `pixel-art-story`
- `anime-cel`
- `studio-catalog-realism`
- `whiteboard-doodle-explainer`
- `hand-drawn-cartoon-explainer`

Each source pack contains exactly:

- `pack.json`;
- `content/visual-style.json`;
- one copied, checksum-bound WebP preview under `assets/`.

The signed edition preserves the corresponding static record's name,
description, category, tags, `style_bible`, and `negative_prompt` byte-for-byte
at the semantic string level. `compatible_formula_ids` is empty because these
are standalone reusable rendering systems, not Formula-restricted Channel Kit
components. Dependencies are empty.

The checked-in preview is an owner-approved migration source. Provenance must
record its original static path, SHA-256, decoded 1672x941 dimensions, byte
count, reuse authority, destination path, and identical-byte proof.

## Signed-only runtime

The signed `/api/visual-styles` response is the sole customer catalog. On API
failure, Story shows an explicit unavailable/error state and an empty catalog;
it does not invent, merge, or recover static styles. An authenticated empty
signed response remains an honest empty catalog.

The runtime must accept valid signed style metadata rather than silently
dropping a product because its published category is outside the retired four
static categories. Hand-Drawn Hardship Cartoon must become visible through an
explicit supported category contract or a validated dynamic category path.

Existing shipped niche recommendations that still name `builtin-*` values are
changed to the exact signed Content Store style IDs already stocked for those
looks. No alias remains behind.

## Deletion boundary

Delete after signed availability is proven:

- the `BUILT_IN_STYLES` array and legacy helpers in
  `frontend/composables/useBuiltInStyles.ts`;
- `frontend/public/builtin-style-previews/`;
- visual-style-only legacy resolver and project-pin migration paths;
- built-in source/golden/grandfathering fixtures and assertions;
- docs and developer skill copies that instruct contributors to add static
  built-ins.

Retain the reactive catalog composable and shared UI consumers, renamed as
needed, but have them expose signed API data only.

## Acceptance criteria

- Six complete source packs have exact registry receipts and authored lifecycle
  state.
- Six archives exist, are at most 52,428,800 bytes, validate under
  `genstudio-store-receipt-v1`, and have matching declared and measured digest
  and byte counts.
- Independent reviews have no unresolved finding.
- GenStudio returns six server-assigned product, release, and price-version
  identities with active/published/directly reachable state and one 300-credit
  no-discount price each.
- The installed signed API exposes all six and does not silently drop any
  active signed style.
- No production source, test, fixture, niche, resolver, persisted selection,
  or public asset refers to `BUILT_IN_STYLES`, `builtin-style-previews`, or a
  `builtin-*` visual-style ID.
- API failure or an empty signed catalog never restores static styles.
- Old saved built-in selections fail honestly and are not migrated, aliased,
  guessed, or rewritten.
- Current signed selections persist exact signed IDs and both prompt fields.
- Focused frontend/backend/content-pack tests, registry validation, lint,
  typecheck, security/model-drift checks, production builds, and rendered picker
  inspection pass.
- The release increments both package versions, adds the newest changelog
  entry, and passes release integrity checks.

## Explicit non-goals

- No compatibility for saved legacy visual-style presets or projects.
- No additional style expansion beyond the six conversions in this batch.
- No Channel Kit creation or modification.
- No retroactive mutation of existing products or prices.
- No production image generation; the six approved checked-in previews are the
  migration sources.
- No Story-side product creation, publication, pricing mutation, purchase,
  entitlement, customer-data change, production signing, or fleet work.
