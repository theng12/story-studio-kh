# Generation Guards and Cancellation Design

**Status:** Owner-approved design checkpoint; implementation pending

**Date:** 2026-08-11

**Scope:** Story Studio KH generation, regeneration, queue controls, provider reconciliation, and Jobs-page explanations

## Outcome

Story Studio will keep its existing financial and output-correctness guards, make every engaged guard understandable, and separate five actions that are currently blurred together:

1. cancel work that has not been submitted,
2. stop proven local-only work,
3. pause new submissions while accepted provider work settles,
4. return later while Story continues authoritative reconciliation, and
5. remove terminal history.

Story must never claim that provider work stopped, a reservation was released, or a charge was prevented until GenStudio reports that fact. Unknown state remains fail-closed and recoverable; it never becomes permission for a fresh paid submission.

## Protected Guards

The following controls remain product requirements:

- One active job per protected project/episode/operation target.
- Durable request evidence written before provider submission.
- Exact idempotency replay for unresolved work; fresh identity only after a confirmed terminal failure.
- Existing-output preservation and missing-only generation or repair.
- Verified completion before downstream stages are considered ready.
- Live GenStudio catalog, capability, language, voice, route, account-capacity, and credit checks.
- Audio, subtitle, image, scene-timeline, assembly, publishing, and pipeline dependency prerequisites.
- Local staging limits and GenStudio-authoritative admission.
- Pipeline ordering and stop-on-failed-prerequisite behavior.

These guards may gain clearer copy and structured status, but they must not be weakened to make a stuck job disappear.

## Current State

### Already shipped

- Chat generation can recover a saved idempotency key through GenStudio 0.93.1's read-only lookup.
- Known recovery keys use lookup rather than a replacement POST.
- Missing, unknown, transport-failed, and ambiguous lookup outcomes remain unresolved and cannot mint a fresh paid identity.
- Confirmed terminal failures can be retried with a new scoped identity.
- Repair, Retry, Pause, and existing-output behavior already preserve substantial paid-work evidence.

### Unsafe or misleading behavior to replace

- `cancelJob()` currently marks queued, paused, and running work locally cancelled; for running work it does so before any remote cancellation result is known.
- The same backend operation removes terminal history, so cancellation and housekeeping share one endpoint and one method.
- Some GenStudio image, video, TTS, and transcription clients attempt remote cancellation after local cancellation, but their response or failure is suppressed and not persisted as authoritative state.
- Chat has no GenStudio cancellation endpoint; stopping Story polling does not cancel Chat generation.
- The Jobs page claims that selected provider tasks “will also be cancelled,” including Scene Plan chat work for which no remote cancellation API exists.
- `scene_image_generate` currently disables cancellation propagation with `isCancelled: () => false`.
- Terminal history is labelled “Dismiss,” which does not clearly distinguish it from cancelling work.
- Disabled actions and duplicate locks are not explained consistently at the point where the user encounters them.

## Approaches Considered

### A. Keep the generic Cancel/Stop behavior

Rejected. It is simple but cannot truthfully describe whether provider work stopped or whether money was released. It also makes terminal deletion look like cancellation.

### B. Conservative Story-owned controls with GenStudio-authoritative evidence

Selected for implementation. Story proves local-only work positively, cancels remote-capable work only before submission or when a published GenStudio cancellation contract proves it is still cancellable, and otherwise pauses new submissions while monitoring settlement.

This approach works immediately for queued work, local processes, chat reconciliation, and truthful Jobs UX. It can adopt GenStudio cancellation routes incrementally per modality without inventing a universal provider guarantee.

### C. Promise universal remote provider cancellation

Rejected until GenStudio publishes a uniform contract. GenStudio 0.93.1 has cancellation endpoints for TTS, images, transcription, and video, but not Chat or Music. The existing endpoints also differ: some reject once execution starts, while video may only confirm that cancellation was requested. Story cannot turn those differences into a stronger promise.

## Control Authority

A single server-side control classifier will determine which actions are valid. The frontend will render this result; it will not maintain modality lists such as `REMOTE_CANCELLABLE_TYPES`.

The classifier must return enough structured information to render and enforce the same decision at both the API and UI boundaries:

```ts
type JobControl = {
  action:
    | 'cancel-before-submit'
    | 'stop-local'
    | 'request-remote-cancel'
    | 'pause-submissions'
    | 'return-later'
    | 'clear-history'
    | 'none'
  enabled: boolean
  label: string
  reason: string
  financial_effect:
    | 'no-provider-request'
    | 'local-only'
    | 'remote-result-required'
    | 'provider-work-may-settle'
    | 'history-only'
    | 'none'
}
```

The implementation may use a small set of controls rather than exactly one object when necessary, but there must be one server-owned classification path and no separate frontend truth table.

## State Rules

### Queued and not submitted

- A queued Story job with no accepted provider evidence may be cancelled.
- Cancellation removes it from the local queue and marks it terminal.
- Customer copy: **“Cancelled before submission. This operation sent no provider request.”**
- No remote cancellation request is needed.

### Proven local-only execution

- Local FFmpeg, audio merge, B-roll normalization/assembly, and other positively proven local-only processes may be stopped immediately.
- Story terminates tracked child processes and requires cooperative cancellation checks where no child exists.
- Customer copy: **“Local processing stopped. This operation sent no provider generation request.”**
- The local-only list must be derived from a shared server proof, not inferred from an absent provider ID or duplicated in the UI.

### Remote-capable job before dispatch

- Story may request remote cancellation only when it has a checkpointed GenStudio job ID and the published modality contract says the job is still cancellable.
- Story persists the cancellation request and the returned result separately from local queue state.
- Story persists the raw published cancellation/status fields used for the decision, including `cancelled`, `cancellation_requested`, failure code, and only the settlement fields actually published by that endpoint.
- The job becomes locally `cancelled` only when GenStudio confirms terminal cancellation. Refund/release copy is shown only when an authoritative settlement endpoint reports a release; missing, absent, or zero-valued fields are not converted into refund language.
- A 409, timeout, unknown result, or “cancellation requested” response is not terminal cancellation.

### Remote cancellation requested but not terminal

- A remote cancellation request creates a persisted, nonterminal control substate such as `cancellation_requested` / `reconciling`; it does not rewrite the Story job to `cancelled`.
- The job retains its active duplicate lock and cannot be retried, freshly submitted, or cleared from history while the outcome is pending.
- Story continues authoritative status polling. After restart, persisted cancellation evidence restores that reconciliation instead of converting the job to an interrupted terminal error.
- The reconciliation controller does not need to hold a normal generation worker slot while it only polls, but it must retain ownership of the job and its duplicate lock until terminal settlement.
- If GenStudio completes or fails the job between Story's control classification and the cancellation request, Story adopts that terminal truth and preserves its outputs/evidence. It does not overwrite the result as locally cancelled or infer released credits.

### Accepted, dispatched, running, or uncertain remote work

- Story must not offer a control labelled Cancel when cancellation is no longer proven available.
- A modality whose published contract accepts post-dispatch cancellation requests may expose **Request cancellation**, clearly described as a request rather than a terminal result. In GenStudio 0.93.1 this exception applies to Video; it does not establish a universal provider-stop guarantee.
- Batch work may offer **Pause new submissions**. Already accepted items continue to authoritative settlement and are checkpointed.
- The user may leave the page; Story continues monitoring or resumes reconciliation on return/restart.
- Customer copy: **“Provider work has already started and can no longer be cancelled here. Story will preserve completed output and reconcile the final charge.”**
- If only a cancellation request was accepted, copy must say **“Cancellation requested”**, not “Cancelled,” until a terminal response arrives.

### Chat and other modalities without cancellation APIs

- Chat/Music work can be cancelled locally only before provider submission.
- After accepted or ambiguous submission, Story offers Pause new submissions / Return later and uses read-only reconciliation where published.
- It never aborts polling and then represents the remote work as cancelled.

### Terminal jobs

- Terminal jobs expose **Remove** (single row) and **Clear finished** (bulk).
- Removal changes history only; it does not delete outputs, reverse charges, or cancel provider work.
- Customer copy: **“Remove this finished job from history. Generated files and billing records are unchanged.”**

## API Semantics

The overloaded DELETE behavior will be separated:

- `POST /projects/:slug/jobs/:jobId/cancel` — active cancellation request, permitted only by the server control classifier.
- `DELETE /projects/:slug/jobs/:jobId` — terminal history removal only.
- Existing Pause and Resume routes remain explicit.

Rejected cancellation returns HTTP 409 with a stable code, the current control, and a user-safe reason. Examples:

- `PROVIDER_WORK_ALREADY_STARTED`
- `CANCELLATION_STATUS_UNKNOWN`
- `REMOTE_CANCELLATION_NOT_SUPPORTED`
- `JOB_NOT_AT_SAFE_LOCAL_STOP`

No compatibility layer is required unless an actual non-Story caller of the overloaded DELETE endpoint is found during implementation. The frontend and tests must migrate in the same release.

## Reconciliation and Retry

- Chat's idempotency-key lookup remains the reference design for resolving an interrupted or ambiguous submission without creating another paid request.
- Saved provider IDs are polled; saved idempotency keys are looked up only through published read-only endpoints.
- Unknown lookup results retain the original identity and block fresh submission.
- Confirmed failure can permit a new identity; mixed or nonterminal evidence forces exact replay or remains blocked.
- Cancellation request state participates in reconciliation and cannot erase accepted task evidence.
- Retry continues to preserve completed outputs and generate only missing items.

## Visible Guard Explanations

Every disabled primary generation action or blocked queue control must expose its authoritative reason beside the action, not only in a toast or hidden tooltip. Reuse the server/composable state already driving the button.

Required message patterns:

- **Duplicate:** “Another image batch is already running for this episode.”
- **Reconciliation:** “Checking whether the previous request was accepted. A new paid request is blocked until this is resolved.”
- **Post-dispatch without a published request-cancellation action:** “Provider work has already started and can no longer be cancelled here.”
- **Video request-cancellation available:** “Provider work has started. You may request cancellation, but Story will keep reconciling until GenStudio confirms the final result.”
- **Missing-only retry:** “Completed images will be preserved. Retry generates only missing scenes.”
- **Prerequisite:** Name the missing asset, approval, model capability, language, or upstream stage and link to the place where it can be resolved when practical.

Accessibility requirements:

- Reasons must be readable text associated with the action; title attributes alone are insufficient.
- Button labels must describe the action: Cancel before submission, Stop local work, Request cancellation, Pause new submissions, Remove, or Clear finished.
- Status must not rely on color alone.

## Incremental GenStudio Cancellation Adoption

Story may integrate a modality's GenStudio cancellation endpoint only when all of the following are verified from the live/published contract:

1. the endpoint and required scope,
2. the precise pre-dispatch eligibility rule,
3. response states for cancelled, requested, too late, and unknown,
4. authoritative reservation/capture/release settlement fields or a follow-up read path,
5. ownership checks and idempotent repeated-cancel behavior, and
6. a durable accepted-job ID in Story before the request is made.

For GenStudio 0.93.1:

- TTS, Image, and Transcription may be integrated as proven pre-dispatch cancellation requests.
- Video may expose **Request cancellation** after dispatch, but must remain nonterminal and be represented as cancellation requested until terminal evidence confirms the result.
- Chat and Music remain noncancellable after submission.
- The generic video provider must first preserve the accepted GenStudio ID before in-flight cancellation can be targeted safely.

Before any modality is enabled in the control classifier, implementation must inventory every producing job path and prove that it checkpoints the accepted GenStudio ID before the control is exposed. This inventory includes all TTS, Image, Transcription, direct Scene Clip Video, and generic Video paths. A path that learns the ID only after provider completion remains ineligible until its callback/evidence boundary is fixed.

## Testing

### Server behavior matrix

- queued/no evidence → cancel succeeds, zero provider request;
- paused before submit → cancel succeeds, zero provider request;
- running proven local-only → tracked process stops and terminal local state is persisted;
- accepted remote/cancellable → remote request is persisted and terminal state waits for authoritative result;
- accepted remote/too late → 409 or equivalent leaves the Story job reconciling, not cancelled;
- remote cancellation timeout/unknown → no refund/cancel claim and no fresh submission;
- remote cancellation requested → job stays nonterminal across restart, retains its duplicate lock, and resumes status polling without occupying a generation worker slot;
- provider completes/fails during the classify→cancel race → Story adopts the terminal provider result and never overwrites it as cancelled;
- persisted raw cancellation evidence contains only published fields; missing settlement evidence produces no refund/release copy;
- chat accepted/ambiguous → no Cancel action; exact-key lookup/reconciliation remains active;
- terminal job → DELETE removes history only;
- `scene_image_generate` observes the shared cancellation/control signal;
- every enabled remote-cancel job path proves an accepted GenStudio ID is durably checkpointed before its control appears;
- completed assets survive cancellation, repair, retry, and history removal.

### UI behavior

- No hardcoded frontend list decides whether remote work is cancellable.
- Action labels change by authoritative control state.
- Guard reason appears visibly beside disabled generation controls.
- Terminal action says Remove; bulk action remains Clear finished.
- No copy says a provider task “will be cancelled” without a confirmed contract/result.
- Repair and missing-only Retry explanations remain visible.

### Regression and verification

- Focused queue, cancellation, provider-client, reconciliation, and Jobs-page tests.
- Electron and frontend type checks.
- Full repository verification, lint, changelog/release gates, and production build.
- Packaged Electron visual test of Jobs controls and at least one generation page in each guard state.
- Zero paid requests during automated verification; the production soak resumes only after the release is packaged and visually accepted.

## Release Sequence

1. Implement the server-owned control classifier and split active cancel from history removal.
2. Make local-only stopping explicit and complete missing cancellation probes.
3. Persist provider cancellation request/result state and adopt only verified GenStudio modality contracts.
4. Replace frontend modality lists and misleading copy with server controls.
5. Add visible duplicate, reconciliation, post-dispatch, missing-only, and prerequisite explanations.
6. Run independent review focused on paid-work idempotency, settlement truth, and cancellation races.
7. Bump Story Studio to the next release version, update the changelog, run full verification/package checks, commit and push, then resume the soak.

## Non-goals

- No universal “kill provider work” promise.
- No cancellation API invented for Chat or Music.
- No deletion of billing/recovery evidence when a row is removed from the Jobs page.
- No weakening of duplicate, prerequisite, verified-completion, capacity, or credit guards.
- No automatic fresh paid retry for an unknown or unresolved provider outcome.
- No paid generation during implementation or automated tests.

## Acceptance Criteria

The design is complete when a user can always tell:

- whether any provider request was submitted,
- whether work is local or remote,
- whether cancellation is still genuinely available,
- whether cancellation is merely requested or terminally confirmed,
- whether accepted work may still settle and charge,
- why a new generation is blocked,
- what Repair or Retry will preserve and submit, and
- whether an action only clears history.

At no point may Story's local status make a stronger financial or provider-state claim than GenStudio's authoritative evidence.
