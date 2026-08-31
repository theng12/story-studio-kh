# Adaptive Image Queue Recovery v1.4.91 Design

**Status:** Owner-approved. This document is the authoritative behavior, billing, and delivery contract for implementation.

## Outcome

Story Studio will keep the customer’s explicit scene-image episode count as the normal lane count, but may admit one temporary extra image episode when an active episode is provably in its under-filled final provider wave and GenStudio has just confirmed account headroom. The image group will choose work by per-type round-robin and FIFO, not by guessed duration or a global shortest-job score.

Story Studio will also gain an image-only, machine-level opt-in for one paid replacement of an asset whose original GenStudio task has authoritatively failed. It is off by default, waits 30 minutes after the terminal failure was observed, requires a customer-set additional-credit ceiling for the Story job, resolves the selected image product and price live, and never treats elapsed time as evidence that a provider task stopped.

This batch does not deliver automatic paid replacement for speech, transcription, music, or video. It does not create a second queue, a scheduler framework, a price cache, a provider router, or a replacement Story job.

## Evidence and Existing Ownership

The inspected baseline is commit `90954df443dd5f48eba3313cee61df17fd0d030b` (v1.4.90).

- `electron/server/services/job-queue.ts` already owns the durable Story jobs, per-type FIFO arrays, shared image episode group, explicit `image_episode_concurrency`, pause/restart recovery, duplicate locks, persistence, executor admission, and job SSE updates.
- `electron/server/lib/genstudio-admission.ts` already owns account-wide submission pacing and publishes whether its latest account-capacity read was verified. It exposes `capacity_verified`, `available_paid_slots`, provider queue headroom, submission holds, and refresh time. GenStudio, not Story Studio, remains authoritative for provider execution capacity.
- `electron/server/generators/continuity-render.ts`, `electron/server/generators/images.ts`, and `electron/server/generators/image-pool-generate.ts` already preserve stable output names, task manifests, request scopes, idempotency keys, terminal provider states, partial files, and missing-only execution.
- `electron/server/lib/genstudio-client.ts` already distinguishes same-task recovery from a fresh deterministic scope after terminal failure, records complete credit settlement, and refuses automatic resubmission for uncertain or in-progress requests.
- `electron/server/services/task-manifest.ts` is the per-asset authority for prepared identity, accepted task ID, terminal state, input hash, and retry scope.
- `electron/server/services/app-settings.ts`, `electron/server/routes/app-settings.ts`, and `frontend/components/ThisMacSettings.vue` already provide machine-level operational settings with live application. `frontend/composables/usePresets.ts` auto-applies reusable presets, so a new spending authorization must never enter that path.
- `docs/architecture/security-reliability.md` requires restart recovery to reconnect to accepted provider tasks, permits automatic provider retry only when recovery proves the same task or an exact no-charge outcome, and requires authoritative artifacts for completion.

## Scope

### Image queue scope

Adaptive overlap applies only to the existing `IMAGE_EPISODE_GROUP`:

- `continuity_render`
- `image_pool_generate`

`thumb_images` keeps its separate explicit thumbnail lane. One-image interactive repair types keep their existing independent serial lanes. Audio and video groups remain unchanged.

### Paid replacement scope

Paid replacement is available only to image generators that already implement durable manifest recovery and deterministic terminal retry scopes:

- `continuity_render`
- `image_pool_generate`
- `thumb_images` through `generators/images.ts`

`scene_image_generate`, `composition_generate`, lettering/style previews, and other image surfaces remain manual until they have the same recovery and settlement contract. No audio, transcription, music, or video generator may read or act on the setting in this release.

## Adaptive Tail Overlap

### The explicit base remains the policy

`image_episode_concurrency` remains the customer’s normal lane count. The queue never rewrites, raises, derives, or hides this value. With base `N`, ordinary admission remains at most `N` active image episodes.

Adaptive overlap is one temporary permit, not a new concurrency setting:

```text
normal active limit      = N
temporary maximum       = N + 1
simultaneous overflows   = 1
```

Changing the base while work is active does not cancel or preempt jobs. If active work is already above the new base, no new image episode starts until active work falls within the applicable limit.

### Settling-only eligibility

A running image episode opens an overlap opportunity only when all of the following are true:

1. Its `item_progress` is present and internally consistent.
2. No item remains unclaimed or waiting for a local/provider retry: `not_submitted === 0`, no active item is `waiting_retry`, and no prepared/pending idempotency-only evidence remains.
3. Every unfinished asset maps to one real, durable, accepted `image.generation` task ID with nonterminal provider evidence. Unknown, uncertain, or unmapped work is not settling proof.
4. The number of unfinished accepted tasks is positive and smaller than the episode’s published `item_progress.concurrency`. This is the natural under-filled final wave; no fixed “eight images” or guessed duration threshold is introduced.
5. Completed, failed, cancelled, settling, and expected counts reconcile exactly. A malformed or stale progress snapshot fails closed.

The active episode keeps its lane and continues polling, downloading, validating, and saving output. It is never preempted. An episode with many accepted tasks still filling its configured fan-out is not a tail and opens no overlap.

### Authoritative capacity check

Tail evidence is necessary but not sufficient. Before consuming the one overflow permit, Story Studio performs a fresh GenStudio account-capacity read through the existing admission boundary and requires all of these facts from that same live snapshot:

- `capacity_verified === true` and `limitSource === 'account-overview'`;
- `available_paid_slots > 0`;
- the provider queue is not near `max_queued_jobs`;
- submissions are not blocked and no retry hold is active;
- the queue is not globally paused and the candidate still exists when the read returns.

A cached fallback, stale read, missing API key, network failure, malformed capacity, credit hold, or provider queue near capacity means no overlap. The next existing progress, settlement, enqueue, or slot-release event may check again; there is no polling daemon.

The overflow only admits a Story executor. Every request it later stages still passes through `GenStudioAdmissionPool`, so account submission rate, credit holds, provider queue limits, and actual execution capacity remain authoritative.

### Fair selection without SRTF

The image group uses one round-robin cursor over its existing type set. Each visit may take one eligible head item from that type, then advances the cursor. Within a type:

1. same-job recovery/reconciliation records that already started are completion-biased ahead of never-started work;
2. recovery records remain FIFO among themselves;
3. never-started records remain FIFO among themselves.

This is a two-class FIFO, not shortest-remaining-time-first. The queue never compares scene counts, percentages, historical durations, model names, credit price, expected finish time, or job age across types. A long job cannot be repeatedly jumped by newly arrived “short” jobs, and a busy type cannot consume every freed group slot before the other type is considered.

Boot recovery preserves the same class ordering: reclaimable work that already owned provider identities rejoins its type’s recovery class; fresh queued work keeps persisted enqueue order. The cursor itself is ephemeral because it carries no customer or billing fact.

## Image-Only Paid Replacement

### Machine setting and immutable job snapshot

Add these machine-level app settings:

```ts
interface PaidImageReplacementSetting {
  enabled: boolean                 // default false
  additional_credit_ceiling: number | null
}
```

The ceiling is a positive whole number of credits. It has no default. Enabling is invalid unless a ceiling is supplied. The fixed wait is 30 minutes and the maximum is one paid replacement per asset; neither is another user-facing knob in this release.

When an eligible image job is enqueued, the server snapshots the authorization outside `params`:

```ts
interface PaidImageReplacementPolicySnapshot {
  enabled: boolean
  wait_minutes: 30
  max_replacements_per_asset: 1
  additional_credit_ceiling: number | null
  snapshotted_at: string
}
```

The snapshot makes the authorization auditable and prevents a later preset or request payload from manufacturing it. A current machine setting of Off is also a veto at replacement time: turning the feature off prevents a waiting replacement from submitting. Raising a ceiling later does not retroactively enlarge an existing job’s snapshot; the customer starts a new job for the new budget.

The two setting keys are excluded structurally from every project config, generator preset, pipeline preset, and `usePresets` payload. Existing stored presets are not rewritten.

### Authoritative terminal gate

A timer never authorizes replacement. An asset enters the 30-minute wait only after Story Studio has persisted all of the following:

- the original real task ID and idempotency key;
- `state === 'failed'` from GenStudio’s control/status response;
- a retryable infrastructure/fleet failure code on the existing exact allow-list;
- finite `reserved_credits`, `settled_credits`, and `released_credits` with `reserved_credits === settled_credits + released_credits`;
- the terminal observation timestamp and stable expected output/input hash;
- proof that the output is still missing or unusable under the existing image auditor.

The wait becomes eligible at exactly `terminal_observed_at + 30 minutes`. Submission-uncertain, `request_in_progress`, accepted/running/reconciling, unreachable, missing settlement, imbalanced settlement, user cancellation, content refusal, validation failure, authentication/authorization, insufficient credit, unavailable product, and non-retryable failure never enter the paid wait.

An exact zero-settlement/full-release failure remains on the existing immediate safe-retry path and neither waits nor consumes the additional-credit ceiling. A succeeded task is reclaimed and audited; this feature does not buy a replacement for an expired or temporarily unavailable succeeded artifact.

### Durable attempt record

Reuse the existing job and manifest rather than creating a replacement Story job. Each eligible asset records one attempt:

```ts
interface PaidImageReplacementAttempt {
  asset_key: string
  original_task_id: string
  original_idempotency_key: string
  failure_code: string
  reserved_credits: number
  settled_credits: number
  released_credits: number
  terminal_observed_at: string
  eligible_at: string
  state: 'waiting' | 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
  quoted_credits?: number
  price_version?: string
  replacement_scope?: string
  replacement_task_id?: string
  actual_settled_credits?: number
  reason?: string
}
```

The job stores the policy snapshot and bounded attempt list for queue ownership, ceiling accounting, Jobs-page audit, restart, and SSE. The corresponding manifest entry stores the replacement scope/task binding beside the output identity. Existing `genstudio_jobs` remains the authority for provider states and actual settlement.

The attempt list is bounded by the job’s expected assets and one record per `asset_key`; it is not an event log. Customer-facing `output_lines` state why the replacement is waiting, committed, blocked, submitted, or settled without exposing internal IDs. Technical details retain IDs and settlement evidence.

### Live quote and credit ceiling

At the eligible time, immediately before commitment:

1. re-read the original provider task and settlement through the existing read-only recovery path;
2. re-audit the expected file and skip replacement if a usable artifact now exists;
3. force a live refresh of the GenStudio image catalogue for the selected model and exact output/reference option;
4. require a current available, chargeable product with a published exact `credits_per_image` and non-empty `price_version`;
5. refresh account capacity/balance through the existing admission boundary;
6. require the published credit figure to fit both the snapshotted job ceiling and the current account balance.

For this release, “live quote” means the exact per-image credit figure and price version returned by the forced live GenStudio image catalogue refresh for the request that will be sent. A stale-catalog fallback, missing option price, missing price version, changed/removed model, unverified balance, or unaffordable request blocks the replacement. Story Studio never invents or caches a price.

The ceiling calculation is conservative:

```text
committed additional credits = sum(quoted_credits for committed/submitted/terminal replacement attempts)
new commitment allowed       = committed + live quoted credits <= snapshotted ceiling
```

Once a replacement is committed, its quote continues to count against the ceiling even if GenStudio later releases some or all of its reservation. This avoids concurrent overspend and recovery-time budget reuse. Actual settlement is displayed separately.

### Idempotent submission and restart

The commitment record, quote, price version, prior terminal evidence, and deterministic `replacement_scope` must be persisted before POST. The scope is derived from the original terminal task ID through the existing image retry-scope mechanism; wall clock time is never part of identity.

Repeated timers, duplicate progress events, app restart, or a lost submit response rebuild the same replacement idempotency key. They recover that key/task and never mint another. `max_replacements_per_asset: 1` is enforced from the durable attempt record, not an in-memory counter.

While waiting, the same Story job remains active but releases its image episode slot, following the existing reconciliation-only pattern. One bounded due timer per waiting job may requeue the same durable job; boot reload reconstructs the timer from `eligible_at`. The due callback does no provider submission. It only returns the same job to the recovery-first FIFO. The executor performs every terminal, artifact, live-price, balance, ceiling, manifest, and idempotency check before POST.

There is no periodic scan or scheduler service. Disabling the setting cancels no accepted provider work, but every not-yet-committed replacement fails closed before submission.

### Artifact and completion behavior

- Never delete or overwrite a usable original or partial artifact to prepare a replacement.
- Audit disk and manifest before every submission; a now-valid file wins and completes the asset without spend.
- Submit only the missing asset, with the same expected filename and input hash.
- A replacement success is not Story success until the existing decoder and expected-versus-present completion audit pass.
- A replacement failure is terminal for automatic replacement. It retains settlement evidence and requires manual review; there is no second automatic paid attempt.
- The Story job ID, project, episode, type, output directory, asset key, and content-pack provenance never change.

## UI and Customer Wording

Add a **Paid image recovery** section to This Mac settings:

> **Automatically buy one replacement for a confirmed failed image**
>
> Off by default. Story Studio reconnects to the original GenStudio task first. After GenStudio confirms that task failed, Story Studio waits 30 minutes, checks the image is still missing, refreshes the current price, and may buy one replacement within your per-Story-job credit limit. Time alone never proves a task stopped.

Controls:

- native Off/On switch;
- **Maximum additional credits per Story job** numeric field, required before On can be saved;
- fixed facts beside the control: `30-minute wait` and `Maximum 1 replacement per image`;
- save response reports the actual stored state and ceiling.

Jobs cards show one compact state when applicable:

- `Waiting for confirmed image replacement · eligible <time>`;
- `Replacement price checked · N credits committed of M maximum`;
- `Replacement blocked · <customer-safe reason>`;
- `Replacement submitted` or `Replacement settled · N credits`.

No copy may say “lost worker”, “safe from duplicate charges”, “free”, or “no credits charged” without the corresponding authoritative evidence. Technical details retain the original and replacement settlement rows.

## State and Failure Matrix

| Original/provider state | Automatic action |
|---|---|
| Accepted/running/reconciling | Recover/poll same task; never replace |
| Submission uncertain or idempotency lookup unresolved | Fail closed; never replace |
| Failed, balanced zero settlement/full release, allow-listed infrastructure code | Existing immediate safe retry; no paid budget |
| Failed, balanced positive settlement, allow-listed infrastructure code, opt-in and budget available | Record wait; after 30 minutes revalidate and commit one paid replacement |
| Failed, settlement missing/imbalanced | Block; no replacement |
| Failed, content/refusal/validation/auth/billing/cancel code | Block; no replacement |
| Succeeded with usable artifact | Complete normally |
| Succeeded but artifact cannot be collected | Preserve evidence; manual recovery in this release |
| Live catalogue/price/capacity/balance unavailable at due time | Block with a visible reason; no POST |
| Replacement fails | Preserve all artifacts/evidence; no second automatic replacement |

## Persistence, Billing, and Safety Invariants

- Base image episode concurrency remains explicit and unchanged.
- The image group never has more than one temporary overflow above base.
- Tail overlap requires an under-filled final wave of accepted durable tasks and a fresh verified account-capacity read.
- Queue choice is per-type round-robin and two-class FIFO; there is no SRTF or duration estimator.
- Recovery work is completion-biased without preempting active work or starving a type.
- Elapsed time alone never authorizes replacement.
- Replacement requires terminal failure, balanced settlement, stable identity/output, live product/price, live account facts, opt-in, and remaining snapshotted ceiling.
- The attempt is committed durably before POST and uses one deterministic fresh scope.
- One asset gets at most one automatic paid replacement.
- Valid partial artifacts are preserved and completion remains audit-based.
- Settings never enter presets or project configuration.
- Audio and video behavior remain byte-for-byte outside this feature.

## UX and Accessibility Contract

- Use native labeled controls, visible focus, descriptive error text, and an `aria-live` save result.
- Enabling without a valid ceiling must be blocked with an inline explanation; the toggle itself must not trigger a network generation request.
- Settings and Jobs states must remain readable at desktop width, approximately 390 px, and 200% zoom without horizontal page overflow or clipped controls.
- A spending control never receives initial dialog focus.
- Rendered QA must inspect Off, validation failure, On with ceiling, waiting, blocked, committed, and settled states. Source assertions cannot prove geometry.

## Release and Delivery

Release as **v1.4.91**:

- bump `package.json` and both root version surfaces in `package-lock.json`;
- add the newest-first `CHANGELOG.md` entry explaining fair image tail overlap and the optional confirmed-failure replacement in customer language;
- add no production or development dependency;
- run focused RED/GREEN tests during implementation and the complete `npm run verify` release gate;
- perform rendered desktop/narrow/zoom accessibility QA without live paid submissions;
- obtain independent code review, with a separate billing/idempotency review, and resolve every finding;
- push the verified feature branch, create/update its pull request, and merge only when checks, review, and mergeability are clean;
- synchronize the main checkout after merge;
- run `npm run dist:smoke` from the **main repository root**, verify the versioned arm64 DMG and bundled `app.asar` are v1.4.91, and leave the artifact in main’s normal `dist/` directory;
- remove only this merged feature worktree/branch after main sync, DMG verification, and clean-status checks.

Publishing, signing/notarizing a public build, uploading, installing, tagging, activating billing, or changing customer job data is outside this release.

## Non-goals

- No global SRTF, estimated-duration model, priority score, or job-size ranking.
- No more than one overflow and no hidden replacement of the explicit base lane count.
- No adaptive thumbnail, audio, transcription, music, video, local FFmpeg, or LLM lanes.
- No paid replacement for audio/video or image generators without durable recovery parity.
- No replacement Story jobs, new queue service, cron loop, database, dependency, price cache, or compatibility framework.
- No provider routing or worker selection; GenStudio remains the only provider/capacity authority.
- No automatic retry for uncertain, unresolved, nonterminal, unbalanced, refused, invalid, cancelled, or authentication/billing failures.
- No preset migration or rewrite.

## Acceptance Matrix

| Scenario | Required result |
|---|---|
| Base image lanes have capacity | Admit normally up to explicit base |
| Base full; active episode still has a full wave or unsubmitted work | No overflow |
| Base full; one episode has an under-filled final wave of accepted tasks; fresh GenStudio headroom | Admit exactly one overflow |
| Two tails become eligible concurrently | At most one overflow |
| Capacity is stale, fallback, unreachable, held, or near provider queue limit | No overflow |
| Both image types remain queued | Round-robin across types; FIFO within recovery/fresh classes |
| Recovery and fresh work share one type | Recovery FIFO first; no duration/size comparison |
| Setting absent or malformed | Paid image replacement Off |
| Enable without ceiling | 400/inline validation; setting remains Off |
| Image On; audio/video job fails | No paid replacement state or submission |
| Provider task merely exceeds 30 minutes | Same-task recovery only; no replacement |
| Retryable task terminally fails at T | Earliest paid eligibility T + 30 minutes |
| Original artifact appears during wait | Complete from artifact; zero replacement POSTs |
| Balanced zero-settlement failure | Existing immediate safe retry; paid ceiling unchanged |
| Balanced positive-settlement failure, live price fits ceiling | One durable committed replacement scope and at most one POST identity |
| Price/capacity/balance unavailable or price exceeds ceiling | Visible block; zero replacement POSTs |
| Crash before/after commitment or after accepted response | Same attempt/key/task resumes; no second replacement |
| Replacement succeeds but file is missing/malformed | Job is not Done |
| Replacement fails | Evidence preserved; no second automatic paid attempt |
