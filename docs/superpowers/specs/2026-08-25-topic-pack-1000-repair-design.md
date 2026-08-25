# Topic Pack 1,000-Idea Repair Design

**Status:** owner-authorized local Story implementation and local commits are permitted. Story must not perform an external GenStudio mutation, upload, publication, stocking, pricing, entitlement, deployment, or push action; those remain GenStudio/owner operations after the complete handoff.

**Groundwork:** `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/owner-decision-groundwork.md`

**Catalog boundary:** `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/catalog-inventory.md`
**Registry mapping:** `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/registry-mapping.md`

## Goal

Author and qualify exactly sixteen same-identity `1.0.1` Topic Pack source successors for GenStudio publication, each providing 1,000 deterministic, structurally unique lifetime idea assignments under Story Studio’s existing parser, adapters, schema, and planner.

## Scope and fixed boundaries

All **16 canonical Content Store Topic Packs** are included. None is skipped:

| # | Canonical pack ID | Item ID | `1.0.1` successor source root |
| ---: | --- | --- | --- |
| 1 | `com.storystudio.pack.topic.ancient-humans-survival` | `com.storystudio.topic.ancient-humans-survival` | `content-packs/free-starters/topic/ancient-humans-survival-v1.0.1` |
| 2 | `com.storystudio.pack.topic.deep-time-earth-systems` | `com.storystudio.topic.deep-time-earth-systems` | `content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1` |
| 3 | `com.storystudio.pack.topic.economics-businesses` | `com.storystudio.topic.economics-businesses` | `content-packs/free-starters/topic/economics-businesses-v1.0.1` |
| 4 | `com.storystudio.pack.topic.everyday-calm` | `com.storystudio.topic.everyday-calm` | `content-packs/free-starters/topic/everyday-calm-v1.0.1` |
| 5 | `com.storystudio.pack.topic.habits-momentum` | `com.storystudio.topic.habits-momentum` | `content-packs/free-starters/topic/habits-momentum-v1.0.1` |
| 6 | `com.storystudio.pack.topic.historical-wars-treaties-world-order` | `com.storystudio.topic.historical-wars-treaties-world-order` | `content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1` |
| 7 | `com.storystudio.pack.topic.human-behavior-social-dynamics` | `com.storystudio.topic.human-behavior-social-dynamics` | `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1` |
| 8 | `com.storystudio.pack.topic.natural-world-animals` | `com.storystudio.topic.natural-world-animals` | `content-packs/free-starters/topic/natural-world-animals-v1.0.1` |
| 9 | `com.storystudio.pack.topic.night-journeys` | `com.storystudio.topic.night-journeys` | `content-packs/free-starters/topic/night-journeys-v1.0.1` |
| 10 | `com.storystudio.pack.topic.pov-historical-occupations` | `com.storystudio.topic.pov-historical-occupations` | `content-packs/free-starters/topic/pov-historical-occupations-v1.0.1` |
| 11 | `com.storystudio.pack.topic.audience-question-seeder` | `com.storystudio.topic.audience-question-seeder` | `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1` |
| 12 | `com.storystudio.pack.topic.archival-ledger.empires-trade-extraction` | `com.storystudio.topic.archival-ledger.empires-trade-extraction` | `content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1` |
| 13 | `com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power` | `com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power` | `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1` |
| 14 | `com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions` | `com.storystudio.topic.archival-ledger.money-debt-financial-institutions` | `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1` |
| 15 | `com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse` | `com.storystudio.topic.archival-ledger.states-revolutions-collapse` | `content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1` |
| 16 | `com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order` | `com.storystudio.topic.archival-ledger.wars-treaties-world-order` | `content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1` |

The following **15 runtime-only topic JSONs are excluded** from this same-identity repair and retained for a separate future Content Pack conversion wave: `electron/server/topic-packs/ancient-humans-environments.json`, `ancient-humans-social-life.json`, `ancient-humans-technology.json`, `deep-time-deep-ocean.json`, `deep-time-human-origins.json`, `deep-time-prehistoric-life.json`, `deep-time-speculative-earth.json`, `economics-ancient-civilizations.json`, `natural-world-fungi.json`, `natural-world-insects.json`, `natural-world-plants.json`, `pastoral-daily-reflection.json`, `pastoral-expository-teaching.json`, `pov-criminal-hierarchies.json`, and `pov-law-enforcement.json`. They have no canonical `pack.json`, `pack_id`, `item_id`, versioned registry row, or Store evidence; this work does not infer identities for them.

Audience Question Seeder is included even though its existing GenStudio release is published under a **draft, non-customer-facing, non-kit-pinned product**. This repair preserves its existing commerce disposition; it does not retroactively activate, merchandise, price, stock, pin into a Kit, or otherwise make that product reachable.

## Required source shape

Every successor has a new `pack.json` and one strict `topic-pack` JSON document. Its predecessor remains byte-identical. Every successor preserves predecessor `pack_id`, `item_id`, `publisher_id`, entitlement family, SKU, `min_app_version: "{{MIN_APP_VERSION}}"`, `min_app_version_status: "release-bound"`, compatibility declarations, lifecycle, and empty dependency closure. It advances only source version to `1.0.1`, source path, Topic corpus, and a truthful source manifest changelog.

The repair’s exact minimum is **50 subjects × 20 material siblings = 1,000**. It is a lifetime capacity claim, not a promise of 1,000 additional assignments after earlier reservations. Any request for headroom is a separate owner decision (the documented `60 × 20` alternative), not an implicit expansion.

### Profile-pack rule (10)

The ten Free Starter packs remain profile-based. Each has exactly 50 declared subjects, exactly one `coverage_profiles` entry per subject, 20 complete coherent tuples per profile, and `max_siblings_per_subject: 20`.

Each tuple contains the atomic `episode_object`, `time_place_scope`, `mechanism`, and `evidence_lens` that the current planner selects together. Within each subject, all 20 episode objects and all 20 mechanisms are unique. Across profile subjects, complete tuples and core `episode_object|mechanism` pairs are unique except an explicitly documented, reviewed reuse already permitted by the source test. Generic axis substitution, coverage-group conversion, Formula-axis multiplication, and title-only rewording are prohibited.

### Independent-axis rule (6)

Audience Question Seeder and all five Archival Ledger packs remain independent-axis packs. Each has exactly 50 unique subjects, `max_siblings_per_subject: 20`, and at least 20 distinct, universally coherent values in each material axis: `episode_objects`, `time_place_scopes`, and `mechanisms`.

Every value must be coherent with every subject in its pack, proven by a reviewed per-subject material-axis matrix. If an intended value is not universal, it must move to a narrower reviewed existing-schema coverage group/profile; it must never be retained as a vague supposedly universal string. Evidence lenses are not part of the structural capacity calculation, although each source must retain truthful evidence posture and exclusions.

## Fixed implementation boundaries

No Formula source, `electron/server/content-packs/schemas.ts`, `electron/server/content-packs/legacy-adapters.ts`, `electron/server/services/idea-campaign-planner.ts`, Kit source, app version, desktop package lock, or desktop `CHANGELOG.md` change belongs to this plan. No Kit successors are created: current Kits retain their exact pinned component releases until a separate Kit release decision. Source-only Content Pack archives are independent of the desktop binary; no app package or changelog bump is part of this work.

Existing products retain their current commerce state. Story’s authoring registry records only Story pack/item/family/SKU proposal facts; it must not acquire GenStudio product/release/account/price/quote/purchase/grant/publication data. There is no partial GenStudio handoff: either all sixteen candidates pass every gate and one complete receiver handoff is produced, or no GenStudio handoff is produced.

## One atomic identity reservation

One coordinator validates `content-packs/authoring-registry.json`, then reserves all 16 exact `topic-pack` records in one CAS request using the live registry revision. The request’s `records[]` retain current identity/family/SKU/dependency fields, set `version: "1.0.1"`, point to the exact successor root above, and set `status: "reserved"`. The registry returns one revision and one `authoring:<sha256>` receipt.

Before any leaf source is authored, the coordinator creates a complete expected-identity JSON file for each record (the receipt-issued record minus `receipt_ref`) and runs `verify-receipt` against the one returned revision/receipt for all sixteen. Collision, stale revision, receipt mismatch, registry lock, changed identity, or absent predecessor fails the complete batch; individual reservation repair is forbidden.

Leaf authors never mutate the registry. Once every leaf and all integrated gates are clean, the coordinator serializes sixteen exact `reserved -> authored` transitions, validating the registry after each transition.

## Candidate and handoff contract

Every successor is built twice from the source using `genstudio-store-receipt-v1`, `min_app_version: 1.0.843`, and distinct fresh output paths. Each candidate must have identical bytes and SHA-256 across both builds, validate under the same delivery profile, remain at or below **52,428,800 bytes**, preserve receipt-issued identity, contain no publisher signature/key, and contain no URL, provider/model, price, credential, or executable content. The Topic repair staging contract receives both candidate paths, verifies both independently against the same receipt-bound identity, and records their equal byte count and digest before retaining one archive.

Only after all 16 are authored and validate may the coordinator build temporary candidates under `/build/Developer/_handoffs/candidates/topic-pack-1000-repair-2026-08-25/`, then atomically stage the complete retained artifact set under `/build/Developer/_handoffs/artifacts/topic-pack-1000-repair-2026-08-25/`. The staging contract copies every semantic review and independent-pack universal matrix into that retained artifact root, verifies its declared SHA-256 and binding to the exact successor content-document SHA-256, and rejects missing or extra evidence. The ledger and one receiver handoff contain every archive’s absolute path, SHA-256, byte count, delivery profile, min app version, receipt ref, two-build equality proof, and retained review-evidence paths and hashes.

The complete receiver handoff asks GenStudio to add and publish all sixteen `1.0.1` releases under the same existing products and identities, preserving present prices, commerce, and Kit disposition. It requires GenStudio to return exact product/release/entitlement/reachability evidence and to confirm how same-family owners receive upgrades. It does not request new products, repricing, activation, Kit mutation, or publication of Audience Question Seeder’s draft product. Story supplies evidence only and never performs the requested GenStudio mutation.

## Acceptance evidence

- Strict source parse through `parseContentPackDocument()`, identity preservation, predecessor byte identity, and one exact registry receipt.
- Production conversion via `contentPackDocumentToNiche()` / `contentPackDocumentToTopicPack()` and real `planIdeaAssignments()`.
- Per pack: exact 1,000 assignments; 1,000 unique fingerprints and idea keys; deterministic equal-seed replay; a no-overlap 500 + 500 reservation split; no repeat of same-subject episode object or mechanism; safe exhaustion behavior.
- Profile packs: every planned structural tuple is one exact authored tuple for that subject.
- Independent packs: all assigned material values are declared and distinct per subject; a separately hashed review artifact binds the exact source corpus to its per-subject×axis semantic-universality verdicts.
- A per-leaf semantic review/report covers coherence, exclusions, evidence posture, compatibility, originality, safety, factual basis, and copy for all 16 sources.
- `scripts/content-packs/__tests__/free-starter-inventory.test.mjs` first repairs its stale count/successor expectation to include the existing `human-behavior-explained-v1.0.1` Formula, then records all ten Free Starter Topic successors in the final inventory.
- All focused and broad backend, typecheck, lint, security, model-drift, registry, archive, and source-contract gates listed in the execution plan finish with zero failures. No unrelated baseline failure is waived.
