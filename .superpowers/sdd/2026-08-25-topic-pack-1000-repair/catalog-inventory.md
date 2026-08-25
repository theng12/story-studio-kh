# Topic Pack 1,000-Idea Repair — Catalog Inventory

**Inventory commit:** `40ec920e59c4c77ef2a125f40be6d746cd6b2d08`  
**Inventory date:** 2026-08-25  
**Scope:** read-only catalog/source inventory for the approved capacity repair. No
source, registry, archive, stocking, or product files were changed.

## Outcome

The repair has **16 canonical Topic Pack component identities**, all at version
`1.0.0`, all present in `content-packs/authoring-registry.json` with registry
status `authored`, and all backed by an active committed `pack.json` plus one
strict `topic-pack` content document.

The customer/reachability split is:

- **15 existing stocked and kit-reachable Topic Pack components:** the ten Free
  Starter topics and five Archival Ledger topics. GenStudio's published releases
  are dependency-only component releases; they are reachable through the ten
  active Free Starter Kits and the active Archival Ledger Kit, not as standalone
  purchasable Topic products.
- **1 stocked release that is not customer-facing yet:** Audience Question
  Seeder. GenStudio reports its release as `published` but its product as
  `draft`, with no Channel Kit changed to pin it. It is therefore in the repair
  inventory but is not currently reachable by customers.

No canonical Topic Pack successor at `1.0.1` exists yet. The repair should
preserve these 16 pack/item identities and author the approved same-identity
`1.0.1` successors after a new coordinator reservation.

## Canonical eligible inventory

All rows below have `publisher_id: com.storystudio`, `min_app_version:
{{MIN_APP_VERSION}}`, no declared manifest dependencies (the registry normalizes
that empty closure to `[]`), source manifest `lifecycle: active`, and a matching
registry `stocking_proposal` family/SKU. “Reachable” describes
customer access through an active Channel Kit; “stocked” describes the external
GenStudio release evidence, not the Story registry proposal state.

| Name | `pack_id` | `item_id` | Version | Source root | Registry | Stock/reachability disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Survival Problems | `com.storystudio.pack.topic.ancient-humans-survival` | `com.storystudio.topic.ancient-humans-survival` | `1.0.0` | `content-packs/free-starters/topic/ancient-humans-survival` | authored | Stocked component; reachable through First Humans Kit |
| Earth Systems & Deep Change | `com.storystudio.pack.topic.deep-time-earth-systems` | `com.storystudio.topic.deep-time-earth-systems` | `1.0.0` | `content-packs/free-starters/topic/deep-time-earth-systems` | authored | Stocked component; reachable through Deep Time Kit |
| Businesses & Companies | `com.storystudio.pack.topic.economics-businesses` | `com.storystudio.topic.economics-businesses` | `1.0.0` | `content-packs/free-starters/topic/economics-businesses` | authored | Stocked component; reachable through Business Explained Kit |
| Everyday Calm | `com.storystudio.pack.topic.everyday-calm` | `com.storystudio.topic.everyday-calm` | `1.0.0` | `content-packs/free-starters/topic/everyday-calm` | authored | Stocked component; reachable through Calm Mind Kit |
| Habits & Momentum | `com.storystudio.pack.topic.habits-momentum` | `com.storystudio.topic.habits-momentum` | `1.0.0` | `content-packs/free-starters/topic/habits-momentum` | authored | Stocked component; reachable through Build Momentum Kit |
| Wars, Treaties & World Order (History cut) | `com.storystudio.pack.topic.historical-wars-treaties-world-order` | `com.storystudio.topic.historical-wars-treaties-world-order` | `1.0.0` | `content-packs/free-starters/topic/historical-wars-treaties-world-order` | authored | Stocked component; reachable through History Explained Kit |
| Social Dynamics & Boundaries | `com.storystudio.pack.topic.human-behavior-social-dynamics` | `com.storystudio.topic.human-behavior-social-dynamics` | `1.0.0` | `content-packs/free-starters/topic/human-behavior-social-dynamics` | authored | Stocked component; reachable through Human Behavior Kit |
| Animals | `com.storystudio.pack.topic.natural-world-animals` | `com.storystudio.topic.natural-world-animals` | `1.0.0` | `content-packs/free-starters/topic/natural-world-animals` | authored | Stocked component; reachable through Wild Worlds Kit |
| Night Journeys | `com.storystudio.pack.topic.night-journeys` | `com.storystudio.topic.night-journeys` | `1.0.0` | `content-packs/free-starters/topic/night-journeys` | authored | Stocked component; reachable through Sleep Journeys Kit |
| Historical Occupations | `com.storystudio.pack.topic.pov-historical-occupations` | `com.storystudio.topic.pov-historical-occupations` | `1.0.0` | `content-packs/free-starters/topic/pov-historical-occupations` | authored | Stocked component; reachable through A Life As… Kit |
| Empires, Trade & Extraction | `com.storystudio.pack.topic.archival-ledger.empires-trade-extraction` | `com.storystudio.topic.archival-ledger.empires-trade-extraction` | `1.0.0` | `content-packs/paid/archival-ledger/topic/empires-trade-extraction` | authored | Stocked dependency; reachable through Archival Ledger Kit |
| Infrastructure, Commodities & Corporate Power | `com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power` | `com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power` | `1.0.0` | `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power` | authored | Stocked dependency; reachable through Archival Ledger Kit |
| Money, Debt & Financial Institutions | `com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions` | `com.storystudio.topic.archival-ledger.money-debt-financial-institutions` | `1.0.0` | `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions` | authored | Stocked dependency; reachable through Archival Ledger Kit |
| States, Revolutions & Collapse | `com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse` | `com.storystudio.topic.archival-ledger.states-revolutions-collapse` | `1.0.0` | `content-packs/paid/archival-ledger/topic/states-revolutions-collapse` | authored | Stocked dependency; reachable through Archival Ledger Kit |
| Wars, Treaties & World Order (Archival cut) | `com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order` | `com.storystudio.topic.archival-ledger.wars-treaties-world-order` | `1.0.0` | `content-packs/paid/archival-ledger/topic/wars-treaties-world-order` | authored | Stocked dependency; reachable through Archival Ledger Kit |
| Audience Question Seeder | `com.storystudio.pack.topic.audience-question-seeder` | `com.storystudio.topic.audience-question-seeder` | `1.0.0` | `content-packs/reusable-primitives/topic/audience-question-seeder` | authored | Release stocked/published; product draft and not kit-pinned, so not customer-facing |

The ten Free Starter identities and their exact kit closures are frozen by
`scripts/content-packs/__tests__/free-starter-inventory.test.mjs` and the ten
`content-packs/free-starters/kit/*/pack.json` manifests. The five Archival
identities are independently listed by `content-packs/paid/archival-ledger/registry.mjs`
and pinned by `content-packs/paid/archival-ledger/kit/archival-ledger/pack.json`.

## Registry and stocking evidence

- `content-packs/authoring-registry.json` is revision `33`, has 92 current
  records, and has exactly **16 `topic-pack` records**. A direct query of
  `.records[] | select(.kind == "topic-pack")` shows all 16 above at version
  `1.0.0`, status `authored`, with the exact source roots listed above. Their
  Story family/SKU proposals remain `proposed`; the registry intentionally does
  not carry GenStudio product/release IDs.
- `npm run content-pack:registry -- validate` passed and reported
  `authoring registry revision 33: 92 records`.
- GenStudio's 2026-08-17 published-catalog evidence says 55/55 releases were
  published, 44 were dependency-only rows on non-purchasable draft products,
  and the retired Archival monolith was never stocked. This covers the original
  15 Topic components used by the active kits.
- GenStudio's 2026-08-24 four-component stocking reply records
  `com.storystudio.pack.topic.audience-question-seeder@1.0.0` as product
  `draft`, release `published`, and changes Topic Pack count `15 -> 16`; it
  explicitly says no Channel Kit was created or changed and draft products are
  non-purchasable. This is why Audience Question Seeder is stocked at release
  level but excluded from the customer-facing/reachable count.
- The standing 2026-08-24 intake contract states that the owner has 16 Topic
  Packs stocked, that components become reachable only through an active Kit
  pinning the exact release, and that component products are kept `draft`.

## Duplicate display names

“Wars, Treaties & World Order” intentionally occurs twice with distinct
identities and distinct source roots:

1. History cut: `com.storystudio.pack.topic.historical-wars-treaties-world-order`
   / `com.storystudio.topic.historical-wars-treaties-world-order`;
2. Archival cut: `com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order`
   / `com.storystudio.topic.archival-ledger.wars-treaties-world-order`.

This is not a duplicate-identity error. The first belongs to History Explained;
the second belongs to Archival Ledger and has a separate namespace and
component closure. The runtime legacy directory has one similarly named JSON
(`electron/server/topic-packs/historical-wars-treaties-world-order.json`), but
runtime filenames are not Story Content Pack identities.

## Excluded records and why

### Retired/source-only Archival monolith

`content-packs/archival-ledger/pack.json` declares
`com.storystudio.pack.archival-ledger@1.0.0` and embeds five historical Topic
documents. It is explicitly source material only, is skipped by registry source
discovery, is absent from `authoring-registry.json`, and must not be signed,
stocked, purchased, or installed. Its embedded Topic documents are not six new
or alternate Topic Pack identities; the eligible replacements are the five
independent `com.storystudio.pack.topic.archival-ledger.*` rows above.

### Runtime-only topic JSONs

`electron/server/topic-packs/` contains 26 operational JSON documents, but only
11 display names correspond to canonical Topic Pack names (12 identities,
because the Wars name has two identities). The following **15 runtime documents
have no `pack.json`, Story `pack_id`/`item_id`/version, registry record, or
stocking evidence**, so they are not additional eligible packs for this repair:

`ancient-humans-environments.json`, `ancient-humans-social-life.json`,
`ancient-humans-technology.json`, `deep-time-deep-ocean.json`,
`deep-time-human-origins.json`, `deep-time-prehistoric-life.json`,
`deep-time-speculative-earth.json`, `economics-ancient-civilizations.json`,
`natural-world-fungi.json`, `natural-world-insects.json`,
`natural-world-plants.json`, `pastoral-daily-reflection.json`,
`pastoral-expository-teaching.json`, `pov-criminal-hierarchies.json`, and
`pov-law-enforcement.json`.

These are legacy/runtime source records, not registry `draft`, `reserved`, or
`retired` Topic Pack records. They must not be assigned Story identities by
inference during the repair.

### Reserved/draft/retired registry records

There are **zero reserved, zero draft, and zero retired `topic-pack` records**
in the current registry: all 16 are `authored`. The registry does not contain a
repair `1.0.1` reservation. “Draft” in GenStudio applies to component products
(not the Story registry lifecycle), and “retired” applies to the excluded
monolith source boundary, not to a canonical Topic Pack row.

## Verification commands and results

Commands run from the worktree at the inventory commit:

```sh
git status --short
git rev-parse HEAD
jq -r '.records[] | select(.kind == "topic-pack") | [.pack_id,.item_id,.version,.status,.source_path] | @tsv' content-packs/authoring-registry.json
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/free-starter-inventory.test.mjs \
  scripts/content-packs/__tests__/free-starter-wave-two.test.mjs \
  scripts/content-packs/__tests__/archival-ledger-components.test.mjs \
  scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs \
  scripts/content-packs/__tests__/authoring-registry.test.mjs \
  scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
```

The registry validation passed. The focused test run passed **63/64** tests:
all registry, Archival component/coordination, Wave 2 Topic, and reusable
primitive checks passed. One unrelated legacy inventory assertion failed because
the current Free Starter tree contains 56 pack manifests while that test still
expects 55 (`free-starter-inventory.test.mjs:230`); this is a pre-existing
source-count mismatch, not a Topic Pack identity or registry validation failure.
