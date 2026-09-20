# Independent review — cancelled-job lifetime repair

## Review boundary

[MEASURED] Starting repository HEAD: `08aa6ee02735788cfc036c8a9ae7d3d17f6eab0f`.

[MEASURED] Reviewed the current diff and source paths in:

- `electron/server/services/job-queue.ts`
- `electron/server/__tests__/job-cancel.test.ts`
- direct routing/admission paths for `finishMissingImagesInPlace` and deterministic episode-recovery IDs
- the three history retirement paths: `retryTerminalJob`, `removeTerminalJob`, and `clearFinished`
- `runJob` lifetime, awaited checkpoints, paid-image-wait handling, and `finally`

[REPORTED] Older inherited commits and unrelated application/release changes were outside this review. The reviewer did not run tests or builds. Root-provided logs reported a deliberately red focused run (`finish-images-red.log`, 1/82 failed) and a focused green run (`focused-complete.log`, 82 tests, 0 failures); those were not independently executed by this reviewer. The full release gate result was not stated as complete in the review input.

## Findings addressed

[MEASURED] The repair tracks admitted workers in `activeRunJobIds` at `job-queue.ts:443` and `:3380`, removes the ID only in `runJob` `finally` at `:3631`, and clears the cancellation flag there only when the row is absent at `:3632-3635`.

[MEASURED] All ordinary history retirement paths now retain `cancelled` while the worker is active:

- `retryTerminalJob`: `job-queue.ts:5425`
- `removeTerminalJob`: `job-queue.ts:5858`
- `clearFinished`: `job-queue.ts:5908`

[MEASURED] The normal late-return/late-throw paths check row presence after awaited work before mutating or re-emitting the retired row:

- startup persistence checkpoints: `job-queue.ts:3386-3389` and `:3407-3409`
- executor return and paid-wait persistence: `:3451` and `:3461-3468`
- executor catch: `:3491-3494`
- final checkpoint: `:3582-3591`

[MEASURED] Deterministic ID reuse is blocked in `enqueuePrepared` at `job-queue.ts:4735-4740`, which covers `enqueueEpisodeRecoveryOnce` at `:4900`. The added test covers rejection while the old worker is active and reuse after its lane is released at `job-cancel.test.ts:1195-1277`.

[MEASURED] The previously identified Finish missing images hole is addressed. After the authoritative terminal-status check, `finishMissingImagesInPlace` rejects an active worker at `job-queue.ts:4999-5006`, before `mutateAuthoritativeJob` at `:5021`. The added held-worker test exercises force-abandon, rejection with the flag preserved, worker release, and successful in-place requeue at `job-cancel.test.ts:1279-1346`.

## Remaining actionable findings

[MEASURED] No remaining actionable finding was found in the reviewed current diff, conditional on the guard and tests above remaining unchanged.

[REPORTED] The guard is placed before the awaited authoritative mutation. If the old worker exits between the guard and mutation, its `finally` has completed and its cancellation lifetime is over; the in-place requeue may then clear the flag safely. If the worker remains active, the request is rejected before row mutation and before the historical unconditional `cancelled.delete` at `job-queue.ts:5091`.

## Limits

[MEASURED] This artifact records source review only. It does not approve or assess the older ~70 commits, unrelated dirty files, the full backend release gate, packaging, or deployment. No new test/build command was run by the reviewer.

[MEASURED] Orchestrator rechecked the above line references after the final guard insertion and corrected offsets only.
