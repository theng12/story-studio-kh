---
name: story-studio-content-pack-authoring
description: Use when a channel concept, content format, production option, thumbnail or visual reference, or product idea should become independently purchasable Story Studio Content Store `.sspack` products.
---

# Story Studio Content Pack Authoring

Author reusable, independently purchasable Content Packs that customers can mix and match in Production.

## Non-negotiable product model

Every new product is one standalone Content Pack. Do not create, extend, reserve, build, price, or stock a Channel Kit. A related launch may contain several packs, but each pack keeps its own identity, archive, product, price, purchase path, and delivery path.

Legacy Channel Kits remain readable and installable for backward compatibility. Treat them as read-only product history: inspect or validate them when required, but do not use them as the authoring or merchandising model for new work. A later explicit owner decision must change this policy before any new Kit work can begin.

Use exactly one supported content kind per pack: `series-formula`, `topic-pack`, `visual-style`, `thumbnail-recipe`, `subtitle-style`, `scene-effect`, `overlay`, `lettering-style`, or `metadata-formula`. Assets belong inside the pack that consumes them; do not invent an `asset-pack` kind. Keep `dependencies: []` unless the pack technically consumes a specific external `pack_id@version`. Similar branding, suggested pairings, or launch timing are compatibility metadata, not dependencies or a bundle.

## Workflow

1. Read Story `AGENTS.md`, [the standalone handoff contract](references/component-handoff-contract.md), the registry, relevant schemas, existing sources, and provenance. Reuse a compatible product; create only a materially distinct production choice.
2. Split a channel or product concept into customer-selectable units. Route Formula or Topic Pack work to `$story-studio-niche-adoption`, Visual Style work to `$story-studio-visual-style-adoption`, and Thumbnail Recipe work to `$story-studio-thumbnail-adoption`. Author other supported kinds against their runtime schema without changing this standalone contract.
3. Validate `content-packs/authoring-registry.json`, then reserve the complete batch atomically. The batch coordinator is an authoring role only; it is never a Channel Kit or sellable product. Pass each leaf only its registry-issued identity, receipt, brief, and separate stocking proposal.
4. Require one canonical authoring handoff and one independently buildable candidate archive per pack. Verify schema, originality, compatibility, offline coverage, decoded previews where applicable, deterministic build, and independent review.
5. After every included archive is usable and unblocked, prepare one complete stocking submission that lists separate standalone products. Keep Story authoring, candidate archives, and GenStudio stocking outcomes distinct.

## Registry authority

The sole Story content-identity authority is `content-packs/authoring-registry.json`. First run `npm run content-pack:registry -- validate`. A missing, invalid, unwritable, stale, collided, or unavailable registry is not an authority.

Only the authoring lead reserves a complete batch with `npm run content-pack:registry -- reserve --request <path>`, using the current `expected_revision`, task/branch, proposal reference, and all requested Story records. Record the returned revision and `receipt_ref`. The command's `coordinator` request field identifies that authoring task; it does not authorize or represent a Channel Kit.

A leaf must not derive, renumber, reserve, or repair identities. Before creating source files, write its complete registry-issued record without `receipt_ref` to an expected-identity JSON file and run:

```text
npm run content-pack:registry -- verify-receipt --revision <revision> --receipt <receipt_ref> --expected-identity <path>
```

Only exact success authorizes leaf work. The registry may issue Story `pack_id`, `item_id`, `version`, `publisher_id`, source/dependency facts, and `family`/`sku` stocking proposals. New standalone products have no `bundle_id`. The registry does not create GenStudio product, release, price, account, purchase, entitlement, grant, or wire identities; set live state; publish; sign; or run paid generation.

If the registry gate is unavailable, fail closed with the response in the handoff contract. Do not create identities, sources, manifests, archives, or GenStudio records.

## Merchandising default

For each new standalone pack, request one active product, one published release, direct listing/purchase/delivery, and exactly one published price version of 300 credits with no discount. Submit to GenStudio only after the archive and all applicable reviews exist. This standing owner decision does not authorize Story to mutate GenStudio or change any legacy product, Kit, purchase, grant, or customer data. Never invent GenStudio-returned identities or claim a requested mutation succeeded.

## Boundaries

- Enforce the 52,428,800-byte limit, exact `pack_id@version` dependencies, deterministic local validation, and independent review.
- Analyze reference grammar and record provenance; never copy creator identity, wording, logos, people, assets, or exact composition.
- Production preview bytes come from Studio Hub or owner-supplied originals. This control Mac does not make paid generation requests.
- Never upload, publish, purchase, grant, use production keys, or perform live commerce unless separately authorized through the owning system.
