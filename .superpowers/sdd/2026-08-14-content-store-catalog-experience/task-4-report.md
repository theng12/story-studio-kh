# Task 4 report — Separate Owned, Installed, and Updates libraries

## Delivered

- Added `incomplete` closure state and bounded public dependency facts to the Content Store account response. The resolver verifies retained archives and their exact closure; it never substitutes a catalog release, infers ownership from bytes, or returns local paths/errors.
- Added distinct Discover, Owned, Installed, and Updates tabs. Installed includes only verified complete local packs; Updates is the explicit-update subset. Owned stays account-derived. No background install, update, purchase, or download work was added.
- Added truthful incomplete-install presentation and retained existing recall proof/copy.

## TDD evidence

1. Added the damaged-retained-pack regression and renderer tab/empty-state assertions.
2. Ran focused tests RED: backend reported `not_installed` where the new contract required `incomplete`; frontend lacked Installed/Updates labels.
3. Implemented the smallest state projection and library views, then reran focused tests GREEN.

## Verification

- `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit electron/server/__tests__/content-store-routes.test.ts electron/server/__tests__/genstudio-content-store-delivery.test.ts electron/server/__tests__/content-pack-delivery-attestation.test.ts` — 63 passing.
- `cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/contentStore.test.ts __tests__/contentStoreProofRendered.test.ts` — 33 passing.
- `npm run typecheck` — passing.
- `npm run lint` — exit 0; 1,721 pre-existing repository warnings, 0 errors.
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.
- `npm run check:security` — recorded with the final verification commands.
- `node .../impeccable/scripts/detect.mjs --json` on changed Content Store UI — `[]`.
- `git diff --check` — clean.

## Self-review

- Current-version substitution: rejected; exact release hash/version is required before `installed_current`/`installed_other_version`.
- Partial closure: rejected from Installed; reported as `incomplete`, with at most 100 `{ packId, version, reason }` entries from verified manifests.
- Automatic side effects: none added; install/update controls remain explicit customer actions.
- Recall: retained in owned account facts and existing product proof; recalled local bytes fail closure rather than becoming installed.
- Ownership: remains from GenStudio account data; local bytes only describe local installation.
- Path leakage: internal verifier errors are not forwarded; public reasons are a fixed bounded vocabulary.

## Scope note

`ContentProductCard.vue` was updated alongside the listed files so an incomplete closure is not described as ready/installed and its bounded public reason is visible where the pack is offered.

## Fix round 1 — reviewer lifecycle findings

- Installed is now a separate signed-local projection. It scans active, receipt-attested local packs under the Content Pack coordination lock and does not use account ownership or a current catalog release as admission criteria. A locally installed withdrawn or other-account pack remains visible, but is plainly not claimed as owned by the active account.
- The snapshot holds the global coordination lock and then the Content Pack state lock across state read and exact closure verification. The speculative `installing_dependencies` value was removed because no durable runtime state made it observable.
- The renderer tracks a monotonic overview generation, so an older refresh cannot overwrite an explicit install response.
- Updates are restricted to owned, compatible, non-recalled current releases. Incompatible owned releases are exposed as unavailable and do not count as updates or get actions.
- Added executable regressions for cross-account local installation, stale refresh versus install, and a mounted local-installed renderer state. Existing lifecycle/delivery suites retain coverage for recalls, exact versions, safe download refusal, and closure integrity.

Task 5's minor mobile polish is explicitly deferred; this round makes no mobile-specific layout change.

## Fix round 2 — residual lifecycle findings

- Installed enumerates every retained, non-recalled, non-pending Store version whose signed archive closure is locally verifiable. Each row includes its exact version and whether it is active; inactive retained versions are labelled Retained rather than being hidden or substituted with a current catalog release.
- `ownedByActiveAccount` now requires a verified signed restore family for the active account. Raw account ownership remains visible as unverified account data but cannot upgrade local bytes to an ownership claim.
- Completed-purchase reconciliation participates in the same monotonic overview generation as refresh, restore, and install. An older refresh cannot replace newly reconciled ownership or balances.
- Card and detail install controls require a compatible, non-recalled, downloadable safe release and an actionable install state. Unavailable, recalled, incompatible, and no-download records keep their bounded explanatory status without an action.
- Added executable regressions for inactive retained local installation, unverified ownership evidence, purchase-refresh ordering, and mounted blocked-action rendering.
