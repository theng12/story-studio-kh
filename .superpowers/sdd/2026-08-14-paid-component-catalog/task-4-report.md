# Paid Component Catalog — Task 4 Report

## Status

Completed from review-clean base `82488395f3d0c97ab3267a37fc75295523cc8cd9`.

## Delivered boundary

- Preserved all legacy Hidden Mechanics IDs and the existing user-fork path. Installing the eight component fixtures leaves an HMH project's metadata byte-for-byte unchanged.
- Added an explicit HMH migration preview/apply seam. Its preview names the Formula, selected Topics, Style, and Recipe targets and records their installed exact `pack_id`, version, and archive SHA-256.
- The one-time process-local preview capability is required for apply. Apply rejects another project, stale source selections, altered target IDs, altered versions, and altered archive hashes; it never runs at startup or during discovery.
- Apply changes only the explicit legacy selection to the reviewed signed targets. It retains unrelated current item pins, drops only superseded selection records, and retains only versions still referenced by an item plus the new exact pins.
- Added regressions for immutable same-version bytes, exact retained-version rollback, legacy source resolution, user-fork precedence, stale/tampered previews, and explicit no-mutation behavior.
- Pre-contract remediation revalidates the selected legacy state while the project/config locks are held immediately before mutation, so an edit that lands after preview cannot be overwritten. The publisher now rejects the retired Archival Ledger monolith before signing; its source-only status, component/coordinator build path, source inventory, truthful Formula-only promise, and preview-byte provenance are regression-covered.

## TDD evidence

- RED: the grandfathering suite initially failed because no explicit migration preview/apply API existed.
- GREEN: the mapping and exact-plan guards made the new suite pass. Independent review then found stale/tampered preview weaknesses; new regressions were added and the implementation was tightened until green.
- RED/GREEN follow-up: a deterministic `beforeProjectWrite` concurrent edit initially overwrote a later Topic selection; applying the validation inside the project lock now rejects it. Publisher/source regressions initially admitted the monolith, permitted a hidden ninth component source, and exposed the Formula's whole-channel promise; all now pass with the source contracts above.

## Verification

- Focused migration/runtime suite: 32 passing tests.
- Focused publisher/source suite: 32 passing tests.
- Electron typecheck, lint, production-security, and `git diff --check`: rerun for the remediation commit.

## Deliberately preserved

- No startup rewrite, legacy-file deletion, user-fork mutation, automatic project upgrade, live GenStudio request, commercial price logic, purchase, publication, key/artifact, version/changelog, merge, push, install, or restart.
- The existing Content Store receipt/ownership tests remain the commerce proof for owner-accessible withdrawal/terminal recall delivery. This task does not introduce a new local recall feed or modify generation/commerce runtime behavior.
- Preview provenance records only repository commits, byte hashes, and the documented absence of a separate license grant. It does not claim a license or authorize stocking/publication.
