# GenStudio policy audit — standalone 300-credit content products

Date: 2026-08-25  
Scope: read-only review of the latest GenStudio handoffs and the completed ten-recipe candidate batch.  
No product code, source pack, registry, archive, receiver handoff, stock, price, product state, publication, deploy, push, or commit was changed.

## Executive disposition

1. The ten Thumbnail Recipe **archives are complete, usable, review-clean, deterministic, and eligible for a final submission**. All ten files still exist and their current byte counts and SHA-256 values exactly match the candidate handoff.
2. The existing `...thumbnail-expansion-ten-candidates.json` is **not the final standalone-sale submission**. It truthfully proves the artifact batch, but it omits the stocking-intake contract's owner authority and commercial/reachability instructions and explicitly records `price-or-discount-decision` and `publication` as not done.
3. Do **not** resend that candidate pointer as-is. Prepare one superseding submission, once, using the existing ten unchanged archives plus the owner's 2026-08-25 standalone-product ruling: each is independently active, purchasable, and priced at 300 credits; no Channel Kit is created, required, or used for reachability.
4. No GenStudio `product_id`, `release_id`, confirmed family, confirmed SKU, or other GenStudio identity may be supplied by Story. The submission carries the already-reserved Story identities and `proposed` family/SKU values; GenStudio returns its assigned/confirmed values.
5. Separate from this thumbnail batch, GenStudio also returned a substantial **Topic Pack capacity repair**: all sixteen measured Topic Packs fail the owner's 1,000-idea requirement. That work is not satisfied by these ten Thumbnail Recipes and must remain its own authoring/release batch.

## 1. What GenStudio asked Story to do

### A. Standing stocking intake rule

GenStudio asked Story to send only finished, decision-complete work, once:

- existing archive bytes, not a reservation or source scaffold;
- absolute archive path plus independently checkable SHA-256 and byte count;
- keyless `genstudio-store-receipt-v1` delivery build;
- a usable `min_app_version`;
- exact Story identity and proposed entitlement family;
- exact dependencies;
- `component_summary` v1;
- no blocker, pending review, or unresolved owner decision;
- for a Thumbnail Recipe, at least one real preview and every strict recipe field;
- a JSON submission containing owner authority, component records, required final state/reachability, prohibitions, and the exact reply requested.

Evidence: `2026-08-24_to-gpt-storystudio_from-claude-genstudio_stocking-intake-contract.md` lines 19–21, 53–78, 94–101, and 142–153.

### B. Topic Pack capacity repair

The latest content-quality request is not about the ten recipes. GenStudio ran the actual planner and found all sixteen Topic Packs below 1,000 ideas:

- ten profile-based packs currently cap at 10–40 ideas;
- Audience Question Seeder caps at 6;
- the five Archival packs cap at 100;
- requesting more than capacity throws instead of returning a partial campaign.

The corrected capacity rule is:

```text
capacity = subjects * min(max_siblings_per_subject, coherent tuples per subject)
```

For profile packs, a proven 1,000-capacity baseline is at least 50 subjects, at least 20 coherent tuples per subject, and `max_siblings_per_subject: 20`. Raising tuples without siblings does nothing. Non-profile packs likewise need enough subjects and sibling allowance, with their actual planner result proving 1,000. Each repair is a new version under the existing pack ID, not a new product. The handoff records that these Topic Pack products are already on sale at 300 credits, so their releases are free upgrades to existing owners.

Evidence: `2026-08-24_to-gpt-storystudio_from-claude-genstudio_topic-pack-idea-capacity-shortfall.md` lines 102–107 and 121–159.

## 2. What the owner ruling supersedes

Owner ruling, 2026-08-25:

> "i want you to only send genstudio when we have a complete usable content to send to them. we won't be selling in kits for any new assets or packs or whatever. it will now cost 300 credits."

For **new content products**, this supersedes only the old merchandising and reachability policy:

| Prior contract | Superseded result for new products |
| --- | --- |
| A component is sold/reached only through an active Channel Kit. | Each finished content pack is a standalone customer product. |
| Every component submission must name an intended Kit. | `intended_kit` is explicitly not applicable; no Kit may be required or created. |
| Component product remains `draft` and non-purchasable. | Final product must be active and customer-purchasable. |
| Component `credit_price` is 0. | Standalone product `credit_price` is 300. |
| Price lives on the Kit, previously 1,000 credits. | Price lives on each standalone content product at 300 credits. |
| Reachability is only through a Kit that pins the release. | Reachability is the standalone Content Store listing and purchase/delivery path. |

Evidence for the superseded rules: stocking-intake lines 108–137 and 160–168; `...four-draft-components-stocked.md` lines 47–58.

The following completion and integrity rules are **not superseded**:

- finished bytes only;
- exact archive identity, path, bytes, digest, build profile, minimum app version, dependencies, summaries, and previews;
- no blockers/open findings;
- one final submission after owner decisions are resolved;
- GenStudio remains the authority that assigns `product_id`/`release_id`, confirms family/SKU, stores bytes, prices the product, and changes product/release state;
- Story must not invent GenStudio wire identities or claim mutations that have not occurred.

The new ruling is prospective: it says **new** assets/packs. It does not by itself authorize retroactive activation or repricing of the four historical draft components or the psychology recipe already stocked at zero/draft. Those historic records remain evidence, not targets of this submission.

## 3. Are the ten Thumbnail Recipe candidates complete enough?

### Content/artifact answer: yes

The ten archives are complete usable content:

- 10/10 fixed Story identities are `authored` in registry revision 33;
- 10/10 have strict recipe sources and three reviewed WebP previews;
- 10/10 passed independent specification and quality reviews with no open finding;
- 10/10 were built twice byte-identically with `genstudio-store-receipt-v1`;
- 10/10 validate and contain exactly five files: manifest, Recipe JSON, and three declared WebPs;
- dependencies are `[]` for every recipe;
- all use minimum Story Studio `1.0.843`;
- all archive paths exist now;
- all ten current byte counts and SHA-256 values exactly match the receiver handoff;
- aggregate verification passed registry, 39/39 candidate/registry tests, 12/12 source tests, Electron typecheck, security, model-drift, diff check, and independent archive reopening.

Primary evidence:

- `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/task-11-report.md`
- `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/task-12-verification-report.md`
- `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/final-review.md`
- `<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/release-handoff.json`

### Submission answer: not as the existing JSON

The existing candidate JSON is an accurate staging receipt, but not the new final stocking instruction:

- it has `status: ready-for-owner-stocking`, ten `successful_entries`, and no blocked entries;
- it has no top-level `authority`, `components`, `required_final_product_state`, `required_reachability`, or `required_reply` fields;
- its component entries omit the registry's proposed family/SKU values;
- it explicitly says `price-or-discount-decision` and `publication` were not done;
- its preceding whole-wave review deliberately concluded "draft-only", "non-purchasable", and "Channel Kit" reachability, which the owner has now superseded.

Therefore no recipe rebuild is required, but a **superseding final submission document is required** before GenStudio should mutate anything. The old file should remain immutable evidence and be referenced as superseded, not silently edited.

## 4. Minimal superseding submission contract

The final JSON should retain the known stocking-intake fields and replace only the superseded commercial instructions. This is a semantic submission contract, not an assertion about undocumented GenStudio API enum names.

```json
{
  "schema_version": 1,
  "supersedes": "<owner-home>/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json",
  "authority": {
    "owner_decision_date": "2026-08-25",
    "owner_words": "i want you to only send genstudio when we have a complete usable content to send to them. we won't be selling in kits for any new assets or packs or whatever. it will now cost 300 credits.",
    "scope": "these ten new standalone Thumbnail Recipe products"
  },
  "components": [
    {
      "identity": {
        "pack_id": "<exact existing Story pack_id>",
        "item_id": "<exact existing Story item_id>",
        "version": "1.0.0",
        "publisher_id": "com.storystudio"
      },
      "stocking_proposal": {
        "family": { "id": "<exact registry proposal>", "status": "proposed" },
        "sku": { "id": "<exact registry proposal>", "status": "proposed" }
      },
      "kind": "thumbnail-recipe",
      "archive": {
        "absolute_path": "<exact existing .sspack path>",
        "sha256": "<freshly remeasured exact digest>",
        "bytes": "<freshly remeasured exact integer>",
        "delivery_profile": "genstudio-store-receipt-v1",
        "min_app_version": "1.0.843"
      },
      "dependencies": [],
      "component_summary": {
        "schema_version": 1,
        "kind": "thumbnail-recipe",
        "summary": "<existing exact summary>",
        "slots": { "thumbnail-recipe": 1 }
      }
    }
  ],
  "intended_kit": {
    "status": "not-applicable",
    "reason": "Owner superseded Kit-only distribution for new content products on 2026-08-25."
  },
  "required_final_product_state": "active and customer-purchasable as ten independent standalone content products",
  "required_reachability": "each product is directly listed, purchasable, and deliverable without a Channel Kit",
  "required_credit_price": 300,
  "explicitly_prohibited": [
    "create-or-modify-channel-kit",
    "require-channel-kit-for-reachability",
    "zero-credit-price",
    "leave-product-draft-or-non-purchasable",
    "invent-story-or-genstudio-identities",
    "purchase-or-grant",
    "customer-data-mutation",
    "discount-not-authorized-by-owner",
    "deploy",
    "tag",
    "push"
  ],
  "required_reply": {
    "per_component": [
      "exact Story identity echoed",
      "confirmed entitlement family and SKU",
      "GenStudio-assigned product_id and release_id",
      "declared digest and bytes",
      "server-measured digest and bytes",
      "object-store reread digest and bytes",
      "final product state",
      "final release state",
      "credit_price equals 300",
      "standalone listing and purchase reachability confirmed"
    ],
    "batch": [
      "every mutation performed",
      "every explicitly prohibited mutation confirmed not performed",
      "successful and failed identities with exact errors; never report partial success as full completion"
    ]
  }
}
```

Use all ten exact `successful_entries` from the existing receiver handoff for the archive/identity/summary fields. Add the exact `proposed` family and SKU rows already present in `content-packs/authoring-registry.json`; do not promote them to `confirmed`. Do not add a `product_id` or `release_id` to the request. Those are required reply fields only.

## Exact next action boundary

The owner decision is sufficient for Story to prepare the superseding JSON without changing archive bytes. Sending it to GenStudio would authorize the stated GenStudio stocking/activation/pricing mutations, so that send should occur only from the primary orchestrator under the owner's explicit current instruction. This audit did not send it.
