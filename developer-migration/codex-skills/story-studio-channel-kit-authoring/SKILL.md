---
name: story-studio-channel-kit-authoring
description: Use when a YouTube channel, channel format, thumbnail or visual reference, or product concept should become modular Story Studio Content Store `.sspack` components or a Channel Kit.
---

# Story Studio Channel Kit Authoring

Coordinate reusable content; do not treat a Channel Kit as a fifth creative schema. It composes exact Formula, Topic Pack, Visual Style, and Thumbnail Recipe releases.

## Workflow

1. Read Story `AGENTS.md`, the approved launch-catalog specification, and [the component-handoff contract](references/component-handoff-contract.md). Inspect the registry, existing sources, and provenance. Reuse a compatible component; create only a materially distinct schema unit.
2. For a product concept, capture the customer outcome, editorial promise, proofable claim, and reusable components—not price, shelf placement, or GenStudio data. Classify Formula, Topic Pack, Style, Recipe, and optional coordinator. Keep editorial coverage, rendering, and thumbnail grammar separate. A coordinator has no creative documents/assets.
3. Follow the required registry authority below. It reserves Story `pack_id`, `item_id`, `bundle_id` (kit only), `version`, and `publisher_id`; it may record `family`/`sku` stocking proposals pending field-exact GenStudio confirmation. Leaves never derive IDs.
4. After a reservation, require the relevant leaf workflow(s):
   - Formula or Topic Pack: `$story-studio-niche-adoption`.
   - Visual Style or visual references: `$story-studio-visual-style-adoption`.
   - Thumbnail Recipe or thumbnail references: `$story-studio-thumbnail-adoption`.

   Give each leaf its reserved identity and brief only; collect the contract handoff. Leaves never decide membership, merchandising, GenStudio fields, or identities.
5. Assemble exact handoffs and, only when needed, the bundle-only coordinator. Run provenance, compatibility, offline coverage, decoded-preview, and independent-review gates. Candidates are deterministic, local, ephemeral-key validated—not publication.
6. Produce distinct **authoring**, **candidate archive**, and **stocking handoff** outputs. Use contract statuses/owner gates. Never add an invented `publish: false` or merchandising manifest field.

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

## Boundaries

- Normal components contain usable content/files; only a bundle-only coordinator can be empty and must declare an exact closure.
- Enforce 52,428,800 bytes (50 MiB), exact `pack_id@version` dependencies, ephemeral-key validation, and independent review.
- Preserve originality: analyze reference grammar and record provenance; never copy creator identity, wording, logos, people, assets, or composition.
- `family`/`sku` are Story stocking proposals until referenced GenStudio confirmation. GenStudio owns prices, live state, product/release/account IDs, commerce, delivery, and wire fields; never guess them.
- This control/development Mac never generates production previews: use Studio Hub or owner assets. Never publish, upload, purchase, use production keys, or make paid generation requests.

Example: “Turn these paleontology channel and thumbnail references into a reusable starter kit; reuse an existing documentary recipe if compatible, otherwise reserve a new Recipe and route its preview to Studio Hub.”
