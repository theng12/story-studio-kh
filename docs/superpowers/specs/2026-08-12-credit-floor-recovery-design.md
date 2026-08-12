# Credit-Floor Recovery Design

**Status:** Owner approved

**Date:** 2026-08-12

## Outcome

An HTTP 402 from GenStudio means the account cannot fund that request. Story
Studio must treat it as a recoverable account gate, not as malformed model
output and not as an unresolved provider submission.

After the first 402 for an API key, Story Studio will:

- preserve every accepted or completed provider job and every verified local
  output;
- reject not-yet-submitted requests waiting behind that key;
- stop batch workers from taking new items;
- persist the rejected request as a definitive pre-dispatch failure using its
  existing idempotency key;
- end the Story job with a clear insufficient-credit error and a missing-only
  Retry instruction; and
- allow a new key immediately, or the same key after a fresh account read
  proves its balance increased.

No rejected 402 request is described as dispatched, charged, pending, or in
need of provider reconciliation. Already accepted jobs remain GenStudio-owned
and settle normally.

## Approaches Considered

### Generator-only guards

Rejected as incomplete. Fixing Scene Plan stops its repair loop but leaves
image, audio, subtitle, video, and parallel text batches submitting the rest of
their work after the account has already refused one request.

### Admission-only hold

Rejected as incomplete. It prevents extra network POSTs, but generators that
swallow per-item errors would still walk every remaining item, create noisy
failure records, and misreport 402 as a content defect.

### Shared admission hold plus typed generator stop

Selected. The admission boundary stops queued network work once, while each
batch boundary treats the typed 402 as fatal for that run. This preserves the
existing partial-output and missing-only contracts without creating a second
queue or weakening provider reconciliation.

## Credit Hold

The existing `GenStudioAdmissionPool` owns the hold because every paid
submission already crosses it. Holds are keyed by the API key in memory and
never persist or log the secret.

On 402, the pool records the authoritative balance most recently read for that
key and rejects all waiting submissions for the same key. Submissions already
inside `fetch()` are not aborted; their GenStudio responses remain
authoritative.

Before admitting later work for a held key, the pool refreshes
`/v1/account/overview` read-only:

- a higher `credit_balance` clears the hold;
- the same or lower balance retains it; and
- an unavailable or malformed overview retains it fail-closed.

A different API key has a different hold identity and can proceed immediately.
Successful provider responses do not silently clear a 402 hold because they
may belong to requests accepted before the floor was reached.

## Error and Evidence Contract

`GenStudioApiError` status 402 remains the public error. A shared exact helper
identifies it; message matching is forbidden.

Before any charged POST, Story already writes a redacted request preview under
`pending:<idempotency-key>`. If that POST receives 402, the same entry becomes:

- `state: failed`;
- `dispatch_state: pre_dispatch`;
- `queue_state: waiting_credits`; and
- the published error code when one exists.

It keeps the request preview and idempotency key. It has no fabricated provider
job ID, settlement, or charge. Because it is terminal pre-dispatch evidence,
restart, history removal, and manual missing-only Retry do not wait for a
provider lookup that can never exist.

## Generator Semantics

Single-request and fail-fast sequential generators already stop when 402 is
thrown and retain that behavior.

Every generator that catches item or batch errors must rethrow the typed 402
and stop assigning new items. Requests already accepted or in flight may
finish and checkpoint. This applies to parallel listicle batches, images,
scene images, continuity images, image pools, audio chunks, transcription
sections, AI Video, and scene clips.

Scene Plan keeps its two bounded content-repair attempts for settled responses
that are genuinely incomplete, malformed, or fail durable output audit. It
must rethrow 402 before classifying missing prompts, so no repair pack or later
pack is submitted after the credit floor.

The generic Job Queue remains manual-only for provider jobs. This change does
not add whole-job automatic retry.

## Restart Completion

Register an output auditor for `scene_plan_run` visual and motion stages. It
uses the authoritative `scene_plan.json`, the job's requested target scene IDs
when present, and otherwise the plan's complete stable scene-ID set. Timeline
jobs remain deterministic local work.

After restart, provider reconciliation may adopt or settle saved chat evidence,
but the Story job reaches Done only when the requested prompt fields pass this
auditor. Missing output becomes terminal repair-required Error with missing-only
Retry guidance; it never remains Running indefinitely.

## User Experience

The Jobs page and existing request evidence label remain **Waiting for
credits**. The terminal job error says that completed outputs were preserved,
no additional provider requests will be submitted for this run, and Retry is
appropriate after adding credits or changing the key.

No new modal, setting, dependency, or automatic key switch is introduced.

## Verification

Behavior tests must prove:

1. first 402 rejects same-key admission waiters with zero extra POSTs;
2. a different key is unaffected;
3. the same key remains held at an unchanged/lower balance and releases after
   an increased authoritative balance;
4. pre-dispatch evidence becomes terminal and keeps its idempotency key;
5. Scene Plan performs zero repairs and submits zero later packs after 402;
6. representative text, image, TTS, transcription, and video batch workers stop
   taking new items after 402 while preserving completed outputs;
7. provider jobs accepted before the floor still reconcile and settle;
8. Scene Plan restart reconciliation audits once and reaches Done or a
   repair-required Error; and
9. manual Retry remains missing-only and never repeats completed assets.

No live or paid generation is needed for automated verification.
