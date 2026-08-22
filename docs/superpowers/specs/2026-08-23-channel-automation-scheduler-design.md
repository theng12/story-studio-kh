# Channel Automation Scheduler

**Status:** Owner-approved direction; implementation deferred until the owner pings after GenStudio has finished with this repository.

## Decision

Build a native, per-channel automation profile that submits the existing Pipeline service. The scheduler is orchestration around the current production path, not a second production engine. It must not click the UI, drive Codex automation, or duplicate Pipeline's stage logic.

The first replenishment rule is deliberately narrow:

> On each scheduled check, run only when future scheduled-video coverage for the channel is below the configured target.

When the rule fires, the profile selects eligible accepted ideas and submits the existing Pipeline preflight/run-batch flow. A successful render may claim the next local upload-plan slot. Uploading to YouTube is a separate, explicitly configured final action and is never implied by local slot assignment.

This document records the boundary and safety contract. It is not an implementation plan to execute now.

## Current evidence and seams

### Pipeline is the production entry point

`electron/server/routes/pipeline.ts` already exposes:

- `POST /projects/:slug/pipeline/preflight`, which validates accepted episodes, active presets, prerequisites, local assets, B-Roll pool availability, disk space, and force warnings before returning an estimate (`pipeline.ts:266-387`, `1274-1293`).
- `POST /projects/:slug/pipeline/run-batch`, which repeats preflight and returns without starting anything when it fails (`pipeline.ts:1296-1321`). The route defaults to skip-done behavior; `force: true` is the explicit opt-in to rerun completed work (`pipeline.ts:1300-1303`).
- Per-episode idempotency and duplicate guards, including step-level skip reporting and the queue's atomic enqueue guard (`pipeline.ts:1490-1557`).
- Pipeline chains and deliberate editorial pauses. A contextual-cue step can stop the chain for review rather than silently approving it (`pipeline.ts:1494-1500`, `1558-1559`).

The scheduler therefore supplies an episode list, selected stages/presets, and an explicit force value (false by default); it does not reproduce readiness, preset, cost, or completion logic.

### The queue is durable, but recovery has two different meanings

`electron/server/services/job-queue.ts` writes job state under an atomic lock and retains live jobs plus bounded terminal history (`job-queue.ts:1089-1119`). It persists checkpoints so accepted GenStudio work can reconnect without submitting a duplicate request (`job-queue.ts:1121-1129`).

At load/boot, durable queued jobs rejoin their lane; jobs with authoritative provider evidence are reconciled without a replacement request; checkpointed audio/transcription work may resume with its saved request identity; otherwise a previously running local job is recorded as `Interrupted by app restart` (`job-queue.ts:1133-1250`). The eager boot scan exists so recovery does not depend on opening the Jobs page (`job-queue.ts:1274-1287`).

The scheduler must preserve this distinction:

- **Queued/provider recovery:** accepted work can continue or be reconciled using durable provider identity and idempotency evidence.
- **Local interruption:** no safe provider checkpoint exists; surface the interruption and leave the work repairable rather than silently resubmitting paid work.

Queue insertion is already atomically deduplicated at the serialization point (`job-queue.ts:1980-2036`). A scheduler adds a run-level key and channel lock; it must not bypass the queue's per-episode protections.

### Upload plans and autoschedule currently own local future slots

`electron/server/services/upload-plans.ts` stores plans and the active plan pointer per platform/account (`upload-plans.ts:77-99`). A plan carries a timezone-aware cadence, optional interval/monthly rules, horizon, and upload defaults. Slot computation can resume after the latest future claim (`upload-plans.ts:145-214`, `216-225`). Episode schedule entries are sidecar-backed; imported non-episode entries remain in the legacy map (`upload-plans.ts:385-431`).

`electron/server/services/episode-autoschedule.ts` assigns one finished episode the next free slot from the active plan, but declines already-public or already-scheduled episodes and writes only the local schedule map (`episode-autoschedule.ts:1-14`, `66-120`). The render hook in `electron/server/generators/video.ts` is opt-in through `auto_schedule_on_render`; it logs that nothing was sent to YouTube (`video.ts:118-159`). This is intentionally a local claim, not a YouTube upload or publish operation.

The scheduler should reuse this slot logic and its future-claim rules. It must not reinterpret a local `scheduled_for` value as proof that YouTube has received the video.

### Digest scheduler supplies the timer shape

`electron/server/services/digest-scheduler.ts` uses one interval, a small fire window, persisted last-fired state, an immediate boot tick, and explicit start/stop functions (`digest-scheduler.ts:1-16`, `31-57`, `85-103`). It explicitly requires the app to be running and does not wake a sleeping Mac. Failed work does not advance the persisted fired marker, allowing a later tick to retry (`digest-scheduler.ts:105-149`).

This is the v1 scheduler model: an app-running timer, durable ledger state, and restart/misfire handling. A native macOS wake helper may be considered later, but is outside v1.

## Approved architecture

### Per-channel automation profile

Each channel owns one automation profile. The profile is configuration and policy; it does not contain a copied Pipeline implementation or stale provider catalogue values.

Required fields:

- `enabled`
- timezone and cadence for checks
- target future scheduled-video buffer
- maximum episodes per run
- selected Pipeline stages and saved presets
- maximum credits per run and per day
- approval-stop policy
- final action: `render_only`, `private_upload`, or `scheduled_upload`
- missed-run grace and catch-up policy
- notification routing/preferences

The profile must identify the channel/account and active upload plan it is allowed to use. If that account, plan, preset, or required capability is missing, the run stops before paid work.

### Replenishment check

At each due check:

1. Read the profile and durable schedule ledger.
2. Compute future coverage from local scheduled-video records, using the channel's timezone and active upload plan. Do not count past claims; do not double-count the target episode; parse timestamps as dates.
3. If coverage is at or above target, record a no-op check and send no generation request.
4. If coverage is below target, select at most the configured run limit of eligible accepted ideas and perform the required gates.
5. Submit the existing Pipeline service with `force: false` unless an explicit owner policy eventually authorizes otherwise (the default remains no force).
6. After a verified final video, claim the next local slot using existing autoschedule behavior when the profile allows it.
7. Apply the final action only after the render's exact completion proof and the action-specific gates succeed.
8. Persist the run ledger and notify with a factual result, including skipped, blocked, queued, recovered, completed, and failed counts.

There is one active scheduler run per channel. A second due tick, manual trigger, or restart must observe the same run key and ledger rather than starting a second run.

### Staged rollout boundary

The implementation is staged so the trust boundary is explicit:

1. **Accepted ideas → verified final video + next local slot.** The result is a finished, locally verified video and a local schedule claim. Upload remains manual.
2. **Optional automatic YouTube action.** If explicitly selected and separately authorized, upload as private or YouTube-scheduled. Instant public publishing is never the default and must not be an implicit consequence of enabling the profile.
3. **Later bounded idea replenishment.** Automatic idea generation/acceptance is a later stage with its own bounded controls; it is not part of the first render-and-slot replenishment loop.

## Required safety and correctness gates

Every unattended run must satisfy all of these:

- Reuse the same Pipeline preflight, idempotency, skip-done, prerequisite, preset, disk, and duplicate protections. No parallel “automation preflight” that can drift from Pipeline.
- Do not use `force` by default. A rerun must not silently regenerate completed work or repeat provider cost.
- Resolve live catalogue data and current cost estimates at the point of the run. Before unattended paid work, require an owner-approved spend cap and prove the estimated run/day cost is within both caps. A missing, stale, or unavailable estimate fails closed.
- Require exact completion proofs for every selected stage and the final video. A local file existing is not enough when the current generator has a stronger verifier.
- Use a deterministic dedupe run key derived from channel/profile, cadence occurrence, selected episodes/stages, and relevant policy revision. Persist it before submission and make repeats idempotent.
- Allow only one active run per channel. A run that is queued, running, paused for approval, or reconciling owns the channel lock.
- Do not partially start a run after failed preflight, failed spend approval, or failed required account/plan checks.
- Maintain a durable schedule ledger: due occurrence, observed coverage, selected episodes, run key, preflight result, spend estimate/approval, submitted jobs, slot claims, final action, completion proofs, errors, and notification outcome.
- Handle sleep, restart, and misfires deterministically. v1 requires the app to be running; a missed occurrence may be caught up only within the configured grace and only once per ledger occurrence. Outside grace, record it as missed rather than unexpectedly launching a stale batch.
- Keep provider recovery distinct from local interruption. Reconcile accepted provider tasks by durable identity; never issue a blind replacement request after restart.
- Notify on blocked preflight, spend-cap refusal, approval stop, provider recovery, local interruption, slot assignment, upload action, and terminal completion/failure. Notifications are observability, not a substitute for the ledger.
- Treat approval-stop as a real boundary. If a selected stage requires editorial approval, pause before the next stage and require an explicit resume path; do not infer approval from unattended execution.

## Final-action contract

The final action is a profile choice with a conservative default:

- `render_only`: verify the local final video and optionally assign a local upload-plan slot; no YouTube network mutation.
- `private_upload`: submit the existing YouTube upload path with private privacy and wait for exact upload completion evidence.
- `scheduled_upload`: submit the existing YouTube upload path with a validated future `publishAt` from the local plan and retain the remote video id/status evidence.

No final action may turn a local slot claim into public visibility. `scheduled_upload` is not `public_now`; public publishing requires a separate, explicit product decision and is not a v1 default.

## Non-goals

- No UI clicking, browser automation, Codex automation, or simulated operator actions.
- No duplicate rendering, generation, upload, cost-estimation, or provider-recovery engine.
- No automatic instant-public YouTube publishing.
- No automatic idea replenishment in the first stage.
- No assumption that a local schedule ledger or sidecar means YouTube is synchronized.
- No machine wake, background daemon, or guarantee that a run happens while the app is closed in v1.
- No bypass around Pipeline preflight, queue dedupe, approval pauses, exact completion proofs, or owner-approved spend caps.
- No force reruns, broad catch-up, or unbounded backlog draining by default.
- No cross-channel shared lock or policy: each channel's profile, account, plan, caps, and ledger remain isolated.

## Open implementation questions (deferred, not blocking this direction)

These questions should be answered during implementation after the GenStudio work is complete; they do not request a decision now:

- Where should profile and ledger records live: project config, a dedicated automation file, or a small scheduler store with migrations?
- What exact coverage metric is authoritative: count of future local claims, count of verified private/scheduled remote videos, or a staged combination?
- How should eligibility rank accepted ideas when more candidates exist than the target buffer: episode order, accepted timestamp, explicit priority, or another existing catalog order?
- Which Pipeline stages/presets are serializable as profile references, and how should deleted or drifted presets fail preflight?
- How will the live GenStudio estimate expose per-run and per-day credit projections, and what approval evidence must be persisted for audit?
- What upload endpoint/service should own `private_upload` and `scheduled_upload` orchestration while preserving current YouTube quota and recovery semantics?
- What is the exact approval-stop/resume representation across a multi-episode Pipeline chain?
- How should DST transitions, timezone changes, clock rollback, and overlapping cadence occurrences map to ledger keys?
- What notification channels and retry policy are appropriate for scheduler state versus digest notifications?
- What is the smallest useful macOS wake helper contract for a later version, and how should it report that the app was not running?

## Implementation handoff boundary

Do not implement this scheduler from this document yet. The owner will explicitly ping after GenStudio has finished with the repository. At that point, implementation should begin by re-reading the current Pipeline, queue, upload-plan, autoschedule, and digest-scheduler code because their contracts—not this design's paraphrase—remain authoritative.
