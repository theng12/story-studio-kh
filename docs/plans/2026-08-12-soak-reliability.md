# Soak reliability: durable contextual cues and truthful scene-image pause

## Problem

The HMH production soak exposed two independent reliability failures.

1. Contextual Cues generated 938 scenes in sequential 50-scene requests, but
   retained successful batches only in memory. A terminal provider
   backpressure response on batch 18 discarded batches 1–17 and made Retry
   repeat already-paid work.
2. A Scene Review image batch admitted 97 of 938 requests before the customer
   tried to pause it. Story exposed provider cancellation as the primary
   control, had no cooperative pause boundary inside the image worker pool,
   reported provider-subset progress as whole-job progress, and rendered
   customer cancellations as failures.

## Approved behavior

### Contextual Cues

- Persist a separate incomplete progress sidecar after every successful batch.
- Resume only batches absent from a matching plan/settings checkpoint.
- Keep the final `contextual_cues.json` completion contract unchanged: partial
  progress is visible and recoverable but never complete or assembly-ready.
- Pace sequential requests from GenStudio's published account submission rate.
- Retry only an exact `LANGUAGE_PROVIDER_BACKPRESSURE` terminal result whose
  published settlement proves zero credits settled and the reservation fully
  released. Use a bounded cooldown and a fresh, deterministic retry scope.
- Keep the conservative 50-scene ceiling until GenStudio publishes a structured
  request item limit. Use the selected model's published output budget instead
  of a hard-coded token limit.

### Scene images

- Expose `Pause new submissions` independently from `Request cancellation`.
- Check a durable pause marker before every new image POST. Accepted work may
  settle and checkpoint; no additional scene is claimed.
- Preserve intentional pause across restart as `Paused — settling accepted
  work`; retain the episode-wide duplicate lock.
- When accepted work settles, remain paused. Resume is explicit and audits
  disk/manifests before submitting only missing scene IDs.
- Report the episode denominator, not only admitted provider jobs: completed,
  active/settling, customer-cancelled, true failures, and not submitted.
- Coalesce reconciliation status instead of appending the same message every
  poll.
- If the render produces no completed output for a bounded interval while
  provider work is active, durably pause further admissions. Never cancel or
  retry dispatched work automatically.

## Safety boundaries

- Never submit replacement paid work for an unknown or dispatched provider
  outcome.
- Never infer a model item limit or provider retry delay that GenStudio did not
  publish.
- Customer cancellation remains a separate, pre-dispatch-only action.
- Every saved image and accepted provider identity survives pause, restart,
  retry, and reconciliation.

## Implementation sequence

1. Add failing service/generator/queue/UI regressions for checkpoint resume,
   bounded backpressure, cooperative pause, restart-paused reconciliation,
   truthful counts, neutral cancellation, and coalesced status.
2. Add the contextual progress sidecar and generator resume/pacing behavior.
3. Add additive job controls and item-progress fields; wire image pause and
   missing-only resume through the existing durable generator.
4. Update Jobs and Contextual Cues UI with concise, accessible states.
5. Send GenStudio a zero-context handoff covering provider-pressure queueing,
   persisted retry timing, stalled-worker visibility, and financial guards.
6. Run focused tests, both typechecks, Impeccable detector, full verification,
   production audits, release metadata/checks, and unsigned package smoke if
   the repository release rules require them.
