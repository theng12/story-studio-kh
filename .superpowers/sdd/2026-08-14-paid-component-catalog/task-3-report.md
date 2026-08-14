# Paid Component Catalog — Task 3 Report

## Status

Completed from review-clean base `1578dcd85e8408e9e721994c45d6cf73d506d782` on
`codex/paid-component-catalog`.

## Delivered boundary

- Added the bundle-only coordination source
  `com.storystudio.pack.kit.archival-ledger` with family
  `com.storystudio.family.kit.archival-ledger` and bundle
  `com.storystudio.bundle.archival-ledger`.
- The coordination source has no content or assets. It names the exact eight independently
  signed `1.0.0` Formula, five Topic Pack, Style, and Thumbnail Recipe dependencies; it does
  not reference `com.storystudio.pack.archival-ledger`.
- Expanded the shared bundle-only contract, with regression coverage, to require exactly one
  Formula, at least one Topic Pack, exactly one Style, and exactly one Recipe. The existing
  exact-external-dependency and unused-dependency rules remain in force, so four-component
  Free Starter bundles remain valid while five-topic kits are admitted.
- Repointed the Archival planning regression to the eight independent sources. It reserves
  half the assignments first, then fills the remaining capacity from `usedFingerprints` and
  proves 500 unique assignments: 125 subjects × four siblings, with four independent episode
  object, time/place scope, and mechanism values per subject.
- Added deterministic double-build and ephemeral-key validation of the coordination archive.
  The archive contains only `manifest.json` and `signature.ed25519`; all temporary keys,
  archives, and directories are cleaned up by the test.

## TDD evidence

- RED: the new coordination suite failed because the coordination directory was absent; the
  contract regression failed because bundle-only manifests allowed exactly four components.
- GREEN: the new source and minimum schema change made both regressions pass.

## Review and verification

- Sampled beginning, middle, and end subjects for every Topic Pack lane. Each has 25 subjects,
  there are 125 normalized unique subjects across all five lanes, and every material planning
  axis has at least four values.
- Focused content-pack suites: 4 passing tests.
- Focused contract and campaign-planner suites: 39 passing tests.
- Full backend suite: 2,573 passing tests, 0 failures.
- `npm run lint -- --no-warn-ignored`, `npm run typecheck:electron`, and `git diff --check`
  completed successfully. Lint retains existing repository warnings and reports no errors.

## Deliberately preserved

- The Task 2 filesystem-discovery minor remains deferred because this task consumes but does
  not alter the component inventory.
- No price or Story release-version hardcode, production key, archive artifact, provider/fleet
  operation, live GenStudio request, purchase/publication, version/changelog change, merge,
  push, install, or restart was performed.
