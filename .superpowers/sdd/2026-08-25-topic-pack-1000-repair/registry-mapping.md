# Topic Pack 1.0.1 registry mapping

Read-only mapping prepared from `content-packs/authoring-registry.json` at
registry revision **33** (worktree start commit `40ec920e59c4c77ef2a125f40be6d746cd6b2d08`).
No reservation was run and the registry was not changed.

## Reservation shape

The proposed request follows `reservationRequest()` in
`scripts/content-packs/authoring-registry.mjs`: top-level keys are only
`expected_revision`, `coordinator`, `proposal_ref`, and `records`; records omit
`receipt_ref`, use `status: "reserved"`, and carry the exact leaf `item_id`
(never a kit `bundle_id`). Each record retains the release-bound minimum-app
token, `kind: "topic-pack"`, empty dependencies, and proposed Story family/SKU
entries. The coordinator will derive the authoring receipt from the canonical
request after a successful CAS reservation.

Prior accepted successor batches establish the sibling convention: append
`-v1.0.1` to the existing source directory (for example,
`content-packs/free-starters/thumbnail/centered-hero-headline-v1.0.1` in batch
revision 4; the same pattern is used by the revision-17 Formula/Recipe/Style
successor batch). The proposed paths below follow that convention and are
distinct from every current source path.

## Exact identity mapping

All 16 rows preserve `pack_id`, `item_id`, `publisher_id`, family ID, SKU ID,
and `dependencies: []`; only `version`, `source_path`, and reservation status
advance in the proposed successor record.

| # | pack_id / item_id | 1.0.0 source | proposed 1.0.1 sibling source |
|---:|---|---|---|
| 1 | `com.storystudio.pack.topic.ancient-humans-survival` / `com.storystudio.topic.ancient-humans-survival` | `content-packs/free-starters/topic/ancient-humans-survival` | `content-packs/free-starters/topic/ancient-humans-survival-v1.0.1` |
| 2 | `com.storystudio.pack.topic.deep-time-earth-systems` / `com.storystudio.topic.deep-time-earth-systems` | `content-packs/free-starters/topic/deep-time-earth-systems` | `content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1` |
| 3 | `com.storystudio.pack.topic.economics-businesses` / `com.storystudio.topic.economics-businesses` | `content-packs/free-starters/topic/economics-businesses` | `content-packs/free-starters/topic/economics-businesses-v1.0.1` |
| 4 | `com.storystudio.pack.topic.everyday-calm` / `com.storystudio.topic.everyday-calm` | `content-packs/free-starters/topic/everyday-calm` | `content-packs/free-starters/topic/everyday-calm-v1.0.1` |
| 5 | `com.storystudio.pack.topic.habits-momentum` / `com.storystudio.topic.habits-momentum` | `content-packs/free-starters/topic/habits-momentum` | `content-packs/free-starters/topic/habits-momentum-v1.0.1` |
| 6 | `com.storystudio.pack.topic.historical-wars-treaties-world-order` / `com.storystudio.topic.historical-wars-treaties-world-order` | `content-packs/free-starters/topic/historical-wars-treaties-world-order` | `content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1` |
| 7 | `com.storystudio.pack.topic.human-behavior-social-dynamics` / `com.storystudio.topic.human-behavior-social-dynamics` | `content-packs/free-starters/topic/human-behavior-social-dynamics` | `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1` |
| 8 | `com.storystudio.pack.topic.natural-world-animals` / `com.storystudio.topic.natural-world-animals` | `content-packs/free-starters/topic/natural-world-animals` | `content-packs/free-starters/topic/natural-world-animals-v1.0.1` |
| 9 | `com.storystudio.pack.topic.night-journeys` / `com.storystudio.topic.night-journeys` | `content-packs/free-starters/topic/night-journeys` | `content-packs/free-starters/topic/night-journeys-v1.0.1` |
| 10 | `com.storystudio.pack.topic.pov-historical-occupations` / `com.storystudio.topic.pov-historical-occupations` | `content-packs/free-starters/topic/pov-historical-occupations` | `content-packs/free-starters/topic/pov-historical-occupations-v1.0.1` |
| 11 | `com.storystudio.pack.topic.audience-question-seeder` / `com.storystudio.topic.audience-question-seeder` | `content-packs/reusable-primitives/topic/audience-question-seeder` | `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1` |
| 12 | `com.storystudio.pack.topic.archival-ledger.empires-trade-extraction` / `com.storystudio.topic.archival-ledger.empires-trade-extraction` | `content-packs/paid/archival-ledger/topic/empires-trade-extraction` | `content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1` |
| 13 | `com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power` / `com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power` | `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power` | `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1` |
| 14 | `com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions` / `com.storystudio.topic.archival-ledger.money-debt-financial-institutions` | `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions` | `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1` |
| 15 | `com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse` / `com.storystudio.topic.archival-ledger.states-revolutions-collapse` | `content-packs/paid/archival-ledger/topic/states-revolutions-collapse` | `content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1` |
| 16 | `com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order` / `com.storystudio.topic.archival-ledger.wars-treaties-world-order` | `content-packs/paid/archival-ledger/topic/wars-treaties-world-order` | `content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1` |

## Collision and boundary checks

- Current registry revision is 33; the proposed request pins `expected_revision: 33`.
- The current registry has 16 Topic Pack records, all at version 1.0.0; it has no Topic Pack 1.0.1 records.
- All 16 proposed `(pack_id, version)` pairs are new, and all 16 proposed sibling source paths are absent.
- Stable pack/item/family/SKU identities are unique in the current registry and are copied without renaming.
- All records are leaf Topic Packs with `dependencies: []`; no GenStudio product, release, account, quote, purchase, entitlement, price, shelf, or publication fields are present or proposed.
- The five `paid/archival-ledger/...` paths remain below `content-packs/paid/archival-ledger`, not the retired source root `content-packs/archival-ledger`.
- A reservation would append one batch and increment revision once; this report intentionally does not call `reserve`.

Read-only checks performed after writing the proposal: JSON parse, exact 16-record count, current-registry comparison of all stable identity fields, uniqueness/collision checks for pack/version/source paths, and the repository's official registry validation against the unchanged current registry.
