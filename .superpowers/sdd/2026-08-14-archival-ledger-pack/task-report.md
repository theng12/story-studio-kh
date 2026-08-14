# Archival Ledger Content Pack — Task Report

## Scope delivered

- Added the self-contained `content-packs/archival-ledger/` source for version `1.0.0`.
- The source contains one Series Formula, five 25-subject Topic Packs, the archival documentary reconstruction visual style, the archival map investigation thumbnail recipe, and four self-contained WebP previews.
- The Formula keeps the HMH effective ideation and script prompt fields, script shape, Topic Pack subject inventories, Topic Pack axes, style text, and thumbnail recipe controls under a source-level behavioral golden.
- The generic signed-pack adapter and Idea Campaign planner now retain pack-owned episode objects, time/place scopes, mechanisms, evidence lenses, and sibling limits. The planner makes each capped sibling independently distinct in its episode object, time/place scope, and mechanism; the local Archival Ledger regression selects 500 assignments across 125 unique subjects and proves four distinct values for every one of those dimensions per subject, including after partial earlier-campaign reservations.
- Replaced the duplicate infrastructure-lane `the Suez Canal` with `the Erie Canal`; the trade/extraction lane retains `the Suez Canal`, leaving 125 distinct subjects.
- Added the Formula YouTube tag hint and the exact archival-map `composition_rules` as signed fields. The adapter and thumbnail prompt regression prove those records retain the legacy metadata and byte-normalized effective thumbnail directive behavior. The signed recipe deliberately omits extra `headline_guidance`, because its legacy source had none and the title-band instruction already belongs to the legacy composition rules.
- Runtime code changed in this branch: Content Pack schemas/adapters retain the signed metadata and composition fields, and the generic idea planner consumes the signed Topic Pack planning dimensions. These runtime changes must ship together with the pack.
- `pack.json` deliberately contains the release parameter `{{MIN_APP_VERSION}}` instead of a guessed released version. The publisher refuses to build this source unless the final integrator explicitly supplies `--min-app-version`; the archive regression proves its manifest receives exactly that supplied release value.
- `pack.json` contains no dependencies, price/credit data, purchase information, URLs, or showcase/video entries. Launch price and empty showcase slots remain GenStudio catalog metadata; no media was generated or uploaded.
- No production archive, production signing key, public-key trust resource, version/changelog, user data, install state, purchase, or live catalog state was changed. The only generated archive/key pair remains an ephemeral test fixture and is deleted by test cleanup.

## Tests and validation

- RED: `node --test scripts/content-packs/__tests__/archival-ledger-pack.test.mjs` failed before source creation because `content-packs/archival-ledger/pack.json` did not exist.
- GREEN: the same command passed all three tests: source/500+ contract, HMH behavioral golden, and deterministic build plus public-key verification.
- RED for the follow-up review: the planner regression showed one time/place scope per Archival Ledger subject, the signed thumbnail directive had extra headline rules, and the source test rejected the hard-coded `1.0.840` floor. GREEN: 71 focused runtime tests now pass across Content Pack contracts/adapters/migration goldens, registry/project pins, planner, and thumbnail prompt generation; 19 publisher/source tests pass. Both Electron and frontend typechecks pass after temporarily linking this isolated worktree to the repository's existing ignored dependency trees (no package or lockfile change).
- The build test generated an Ed25519 key pair in a temporary directory, produced two byte-identical archives, verified one through the publisher validator, and removed the temporary directory through the test cleanup hook. No `.sspack` or key was retained in this worktree.

## Paid-catalog integration boundary

This reviewed monolith is source material only. `com.storystudio.pack.archival-ledger` must never
be signed, trusted, stocked, purchased, installed, or entered in the paid release registry. The
paid-catalog plan consumes its documents and previews by splitting them into eight independent
component sources, then coordinates those components through the separate
`com.storystudio.pack.kit.archival-ledger` bundle-only source.

The source retains the unresolved `{{MIN_APP_VERSION}}` release parameter so deterministic tests
can prove final substitution without guessing a Story Studio version. No production archive or
trust-key record is authorized for this monolithic identity.

## Traceability concern

The requested handoffs `2026-08-14_to-gpt-storystudio_from-claude-genstudio_author-the-first-packs.md`, `..._ledger-price-ruled-2000.md`, and `..._170-live-field-names.md` were not present in the repository or the accessible `/build/Developer` tree. This source follows the owner-approved proposal, including the parent-supplied 2,000-credit catalog-only rule, and current HMH production assets; those missing handoffs should be attached before GenStudio catalog entry or production signing review.
