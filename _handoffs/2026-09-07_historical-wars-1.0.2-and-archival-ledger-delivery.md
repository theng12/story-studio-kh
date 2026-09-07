# Historical Wars & World Order 1.0.2 delivery, and the Archival Ledger state

**Date:** 2026-09-07
**Closes:** Task 31's two content follow-ups in
`2026-09-07_remaining-cross-product-handoff-review.md` (§2 Historical Wars
delivery; "Archival Ledger" under other open follow-ups). Task 20 (0381/0382
downgrades) closed on the GenStudio side in release 1.24.26.

## Historical Wars & World Order → 1.0.2

- **Candidate chosen:** 1.0.2 (registry revision 152, `authored`, receipt
  `authoring:a1a45bb7…`). It is 1.0.1 minus one stale
  `compatible_formula_ids` entry; 1.0.1 was never delivered and is superseded
  by the same identity, so 1.0.2 is the only release to make.
- **One source fix was needed (Story PR #52, merged, no app bump):** the 1.0.2
  changelog named the retired formula by its dotted id, and the pack schema's
  URI guard reads a dotted id as a web reference and refuses the build.
  `ship-pack --dry-run` passes because that guard only runs on the built
  manifest, which is why nobody saw it before. The sentence was reworded with
  the same meaning. Registry unchanged (the receipt covers identity, not
  wording). Content-pack lane after the change: 199 passed, 2 skipped.
- **Built from `main` at `a4d2fc60`** with
  `node scripts/content-packs/ship-pack.mjs content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.2 --out <artifacts>`:
  `topic-historical-wars-treaties-world-order-1.0.2.sspack`, 149,440 bytes,
  sha256 `725e4c5f3d25…`, delivery-attested (keyless) build.
- **Store dry run clean** (`python -m app.tools.stock_pack <artifacts> --dry-run`
  on the control Mac): archive re-hashed and matches; no forbidden marks;
  product `cprod_1ae93e360d554f1c9c17c136131b91c3` reused; would create and
  publish release 1.0.2; the existing 90% discount (to 2026-12-31) is left
  exactly alone by policy.
- **Live stocking is the owner's command.** The assistant session's
  permission layer refused the write to the production store twice, so the
  final step is the one command below, run from `genstudiokh/apps/cloud-api`
  on the control Mac. It is idempotent and prints the release id.

  ```bash
  cd ~/Developer/genstudiokh/apps/cloud-api && STUDIO_DATABASE_URL=postgresql://$(id -un)@127.0.0.1:5432/genstudiokh STUDIO_OBJECT_STORAGE_BACKEND=filesystem STUDIO_OBJECT_STORAGE_LOCAL_PATH=$PWD/.local/objects .venv/bin/python -m app.tools.stock_pack $HOME/Developer/_handoffs/artifacts/historical-wars-1.0.2-2026-09-07
  ```

  After it runs, the Store overview reports 1.0.2 as the current release
  (highest published version wins; 1.0.0 stays published and immutable).
  Boundful stays pinned to 1.0.0 until its owner applies the update in the
  app, per the inventory handoff.

## Archival Ledger

- **The "field-exact quote contract" is not pending any more.** GenStudio's
  `ContentQuoteResponse` (`apps/cloud-api/app/modules/content_store/schemas.py`)
  and Story's `CachedContentQuoteSchema`
  (`electron/server/content-store/types.ts`) match field for field: quote /
  quote_canonical_json, quote_signature, quote_id, key_id, expires_at,
  account_id, product_id, release_id, entitlement_family(ies), bundle_closure,
  base_credit_price, discount_credits, operator_discount (+_credits),
  quoted_credits, balance_before/after, owned_components, sufficient_credits,
  insufficient_reason, shortfall_credits. Story's paid-bundle test exercises
  exactly the Archival Ledger shape (2,000 list, 90% operator discount,
  owned-component deduction) against a mock of that schema. Nothing on either
  side needs a code change.
- **The kit cannot be stocked as a kit.** `ship-pack` refuses
  `com.storystudio.pack.kit.archival-ledger` 1.0.3: "Channel Kit shipping and
  stocking are terminally closed" (Story commit `17b4f990`, 2026-09-01, with
  registry and shipper tests). That ruling post-dates the August proposal's
  2,000-credit bundle price.
- **What can ship today:** the eight authored components build cleanly in a
  dry run (formula 1.0.1, five topic packs 1.0.1, style 1.0.0, thumbnail
  1.0.0). Under the standing policy each would list at 300 credits with the
  90% launch discount for a year, the way the six sleep-history packs did on
  2026-09-06. That is a product-shape and price decision for the owner, not
  something this delivery assumes; the proposal's status line should be
  updated by whoever makes it.
