# Paid Component Catalog — Task 4 Report

## Status

Completed from review-clean base `82488395f3d0c97ab3267a37fc75295523cc8cd9`.

## Delivered boundary

- Preserved all legacy Hidden Mechanics IDs and the existing user-fork path. Installing the eight component fixtures leaves an HMH project's metadata byte-for-byte unchanged.
- Added an explicit HMH migration preview/apply seam. Its preview names the Formula, selected Topics, Style, and Recipe targets and records their installed exact `pack_id`, version, and archive SHA-256.
- The one-time process-local preview capability is required for apply. Apply rejects another project, stale source selections, altered target IDs, altered versions, and altered archive hashes; it never runs at startup or during discovery.
- Apply changes only the explicit legacy selection to the reviewed signed targets. It retains unrelated current item pins, drops only superseded selection records, and retains only versions still referenced by an item plus the new exact pins.
- Added regressions for immutable same-version bytes, exact retained-version rollback, legacy source resolution, user-fork precedence, stale/tampered previews, and explicit no-mutation behavior.

## TDD evidence

- RED: the grandfathering suite initially failed because no explicit migration preview/apply API existed.
- GREEN: the mapping and exact-plan guards made the new suite pass. Independent review then found stale/tampered preview weaknesses; new regressions were added and the implementation was tightened until green.

## Verification

- Focused migration/runtime suite: 30 passing tests.
- Focused Content Store commerce suite: 33 passing tests, including permanent owner state for recalled versions and terminal `410 release_recalled` delivery refusal.
- Electron typecheck: passed.
- Electron lint: passed.
- `git diff --check`: passed.

## Deliberately preserved

- No startup rewrite, legacy-file deletion, user-fork mutation, automatic project upgrade, live GenStudio request, commercial price logic, purchase, publication, key/artifact, version/changelog, merge, push, install, or restart.
- The existing Content Store receipt/ownership tests remain the commerce proof for owner-accessible withdrawal/terminal recall delivery. This task does not introduce a new local recall feed or modify generation/commerce runtime behavior.
