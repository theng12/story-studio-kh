# Task 1 — Repair Throughput defaults and custom editing

## Status

DONE_WITH_CONCERNS

## Implementation

- Changed the scene-image episode concurrency default from `3` to `2` in the backend settings authority. Missing values therefore now resolve to `2`; a stored `3` is still returned unchanged.
- Updated every frontend fresh/fallback/recommended path to `2`, added `2 — recommended`, and retained `3` as a non-recommended named preset for saved settings.
- Made Custom an explicit per-field selection state. Selecting it exposes the numeric editor even when the current value equals a named preset; selecting a named preset, saving, or using recommended clears that editing state.
- Added field-owned numeric metadata and bound every custom numeric control to it. Scene-image concurrency uses `min=1`, `max=50`, and `step=1`, matching the established backend contract.
- Preserved the existing save route, server validation, error presentation, and response-normalization behavior.

## Files changed

- `electron/server/services/app-settings.ts`
- `electron/server/__tests__/image-episode-concurrency.test.ts`
- `frontend/components/ThisMacSettings.vue`
- `frontend/__tests__/settingsWorkspace.test.ts`

## TDD evidence

Production changes were made only after these focused tests were added and observed failing.

### RED

```sh
cd frontend && ../node_modules/.bin/tsx --import ./__tests__/setup.ts --test ./__tests__/settingsWorkspace.test.ts
```

Result: 12 passed, 1 failed. The new test failed because the scene-image field contained `3 — recommended` and no `2 — recommended` preset.

```sh
node scripts/testing/run-backend-tests.mjs --only image-episode-concurrency
```

Result: 21 passed, 1 failed. The new default/persistence test failed with `3 !== 2`.

### GREEN — pristine focused checks

```sh
cd frontend && ../node_modules/.bin/tsx --import ./__tests__/setup.ts --test ./__tests__/settingsWorkspace.test.ts
```

Result: 13 passed, 0 failed.

```sh
cd electron && ../node_modules/.bin/tsx --test --test-name-pattern='fresh or missing|custom scene-image settings' server/__tests__/image-episode-concurrency.test.ts
```

Result: 2 passed, 0 failed; no warnings or errors.

### Additional verification

```sh
node scripts/testing/run-backend-tests.mjs --only image-episode-concurrency
```

Result: 22 passed, 0 failed; harness confirmed 1/1 selected file completed. This selected run is explicitly not the release gate.

```sh
npm run typecheck
```

Result: Electron and frontend type checks passed.

```sh
npm run lint
```

Result: 0 errors and 1,758 pre-existing warnings.

## Self-review

- Scope: only the requested settings default/editing flow and direct tests changed; no version or changelog file changed.
- Correctness: fresh/missing values use `2`; an explicit stored `3` remains `3`; custom `2`, `1`, and `50` round-trip; `0` and `51` retain the established backend rejection.
- Accessibility: custom fields retain their field-specific accessible labels and now use native numeric input semantics and exposed min/max/step bounds.
- Simplicity: reused the existing data-driven throughput fields and save route; no new API or validation layer was introduced.

## Concerns

- The full selected backend file passed, but its pre-existing restart-order test logged an asynchronous cleanup race (`ENOENT` while renaming `jobs.json`) after reporting success. The two new backend tests were rerun alone with pristine output.
- Repository lint has 1,758 existing warnings (0 errors); this task introduced no lint error.
