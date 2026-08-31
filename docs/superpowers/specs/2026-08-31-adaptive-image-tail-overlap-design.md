# Adaptive Image Tail Overlap v1.4.91 Design

**Status:** Owner-approved after independent safety review. This is the complete contract for the first release in the adaptive image recovery program.

## Outcome

Story Studio will keep the customer’s explicit scene-image episode count as the normal lane count, choose image work fairly by type and FIFO, and admit at most one temporary extra image episode when a running Continuity Render is provably in its under-filled final provider wave and GenStudio has just confirmed account headroom.

This release changes scheduling only. It contains no paid replacement, settings for paid recovery, provider retry, new scheduler service, price handling, image-pool fan-out, or audio/video behavior.

## Existing Ownership

Baseline: commit `90954df443dd5f48eba3313cee61df17fd0d030b`, Story Studio v1.4.90.

- `electron/server/services/job-queue.ts` owns durable Story jobs, per-type pending arrays, the shared image group, the explicit `image_episode_concurrency`, executor admission, persistence, restart recovery, and SSE.
- `electron/server/generators/continuity-render.ts` already publishes `item_progress`, checkpoints `params.genstudio_recovery.assets`, writes per-output task manifests, and records accepted GenStudio task evidence. Its current progress key is `scene-${scene.scene_index}`, while both durable stores are keyed by `${scene.id}.png`; v1.4.91 must align that identity before the queue can prove a tail.
- `electron/server/generators/image-pool-generate.ts` is intentionally serial. It remains an image-group candidate but must not be given internal fan-out in this release.
- `electron/server/lib/genstudio-admission.ts` and `refreshGenStudioAdmission()` own fresh account capacity, provider queue headroom, rate pacing, and credit holds. Story Studio does not infer provider capacity.

## Explicit Base and One Temporary Overflow

`image_episode_concurrency` remains the customer’s visible base `N`.

```text
normal image-group limit = N
temporary maximum        = N + 1
maximum overflow count   = 1
```

The scheduler never rewrites or silently replaces `N`. A live decrease does not preempt running work; it blocks new admission until active work falls within the applicable limit. A live increase fills through the same fair group pump.

## Eligible Opener and Candidate Types

Only `continuity_render` may open the temporary slot in v1.4.91.

Both existing image-group types may consume a normal or temporary slot:

- `continuity_render`
- `image_pool_generate`

`image_pool_generate` cannot open a tail because its current loop is serial: one item is claimed, submitted, settled, and saved before the next begins. Adding pool fan-out merely to satisfy a scheduler predicate is prohibited. Thumbnail, one-image interactive repair, audio, video, text, and local render lanes are unchanged.

## Authoritative Continuity Tail Predicate

Counts alone never prove a tail. Before any capacity refresh, the queue must derive a complete one-to-one binding from each active Story item to one distinct accepted provider task.

A `continuity_render` job is an eligible tail opener only when every condition below holds from one internally consistent job snapshot.

### Canonical progress identity

Continuity must publish the same stable filename key already used by its checkpoint and task manifest:

```ts
{
  key: `${scene.id}.png`,
  label: `Scene ${scene.scene_index}`,
}
```

`key` is machine identity: it is the exact manifest key and the exact key in `params.genstudio_recovery.assets`. `label` remains the customer-facing scene number. Existing customer-facing scene labels and output-line wording do not change. Do not derive the durable key from `scene_index`, strip the `.png` suffix, parse the label, or add a compatibility lookup from `scene-${scene_index}`.

The minimal generator alignment is to retain each in-flight scene’s canonical filename alongside its numeric scene index, publish that filename as `active[].key`, and continue publishing the numeric index in `label` and `.render_status.json`. Existing checkpoint and manifest calls already use the same `filename`; their storage format does not change.

An old persisted active key such as `scene-1` that does not directly index the real `scene-001.png` checkpoint/manifest fails closed and cannot open overflow. When the existing Continuity recovery path resumes the job, its next progress checkpoint publishes the canonical filename. No migration, filename guess, or index-to-ID compatibility table is added.

### Progress reconciliation

1. `job.status === 'running'` and the job currently occupies the image group.
2. `item_progress` exists with non-negative whole `total`, `completed`, `failed`, `settling`, `cancelled`, `not_submitted`, and positive whole `concurrency`.
3. `item_progress.active.length === item_progress.settling`.
4. Every `item_progress.active[]` entry has a non-empty unique `key` and `state === 'running'`; `waiting_retry` is not settling.
5. `not_submitted === 0`.
6. The exact expected-count identity holds:

```text
total = completed + failed + settling + cancelled + not_submitted
```

7. `settling > 0 && settling < concurrency`. This is the naturally under-filled final wave.

Any missing field, negative/fractional number, duplicate active key, count mismatch, waiting retry, or unsubmitted item fails closed before a network read.

### One-to-one active-item binding

For every active key `K`:

1. Treat `K` as the canonical `${scene.id}.png` filename. Resolve `job.params.genstudio_recovery` and require `version === 1`, `route === 'genstudio'`, and a direct `assets[K]` record with `operation === 'image'`.
2. Resolve the exact expected output from `assets[K].output_path` and the corresponding task-manifest entry. The checkpoint may provide `job_id`; the manifest may provide `task_id`; at least one must provide a real accepted ID.
3. Reject IDs that are empty or start with `pending:`. If both checkpoint and manifest publish IDs, they must be equal.
4. If both publish idempotency keys, they must be equal. The manifest input hash and expected output path must still match the current asset.
5. Resolve exactly one `job.genstudio_jobs` entry with that ID, `operation === 'image.generation'`, and a nonterminal state. Missing, terminal, cancelled, duplicated, or ambiguous evidence fails closed.
6. Add the provider task ID to a set; it must not already be present. Two active keys may never map to the same provider task.

After all keys resolve, require:

```text
mapped active keys = distinct accepted task IDs = settling = active.length
```

No orphan, count-only, filename-guessed, or “newest task” fallback is allowed. Manifest/checkpoint disagreement is a safety failure, not permission to choose one.

## Fresh Capacity Gate

Only after the local tail predicate passes may Story Studio perform one fresh capacity read through `refreshGenStudioAdmission(apiKey)`. When it returns, the queue re-evaluates the complete tail predicate and current queue state because progress may have changed during the await.

The returned snapshot must simultaneously prove:

- `capacity_verified === true`;
- `limitSource === 'account-overview'`;
- `available_paid_slots > 0`;
- `queue_near_capacity === false`;
- `submissions_blocked === false`;
- `retry_after_ms === 0`;
- the global queue is running;
- the image group is exactly at base, not already above it;
- at least one pending image-group candidate remains.

Fallback, stale/unreachable/malformed capacity, missing API key, provider queue pressure, credit/rate hold, changed tail evidence, or concurrent overflow admission means no overflow. Existing progress, evidence, enqueue, or slot-release events may check again; no interval or polling daemon is added.

The temporary slot starts only a Story executor. Every eventual provider POST still passes through `GenStudioAdmissionPool`.

## Fair Group Selection

Use one ephemeral round-robin cursor over the two existing image-group types. On each visit, take at most one eligible head item, then advance the cursor. Within each type:

1. already-started recovery/reconciliation jobs form a completion-biased FIFO;
2. never-started jobs form a fresh FIFO behind them.

Recovery is prioritized because it already owns provider/output identity, but no job is ranked by remaining items, percentage, age, model, price, predicted duration, or expected finish time. This is not global SRTF. A type that continually receives work cannot consume the full group budget before the other type is offered a turn.

The cursor is not durable; it contains no customer fact. Durable pending order and `started_at` are sufficient to reconstruct the two FIFO classes after restart.

## Safety Invariants

- The explicit base remains visible and authoritative.
- Active image-group jobs never exceed base + 1.
- Only a fully bound Continuity final wave may open overflow.
- Continuity publishes canonical `${scene.id}.png` active keys while preserving `Scene ${scene.scene_index}` labels.
- `image_pool_generate` may consume overflow but cannot open it and remains serial.
- Progress arithmetic and exact active-key/provider-task mapping pass before capacity refresh.
- Capacity must be freshly verified and rechecked after await.
- Fairness is per-type round-robin plus recovery/fresh FIFO; no SRTF or estimator exists.
- Active tail work is never preempted, cancelled, slowed, or assigned a replacement identity.
- Provider admission, settlement, artifacts, duplicate locks, pause/cancel, and completion auditors remain unchanged.

## Tests and Acceptance

| Scenario | Required result |
|---|---|
| Base has room | Admit normally up to base |
| Base full; Continuity has full wave | No overflow |
| Current Continuity shape: active `scene-1`, checkpoint/manifest `scene-001.png` | Direct lookup fails; no capacity refresh or overflow |
| Aligned Continuity shape: active `scene-001.png`, label `Scene 1`, matching durable stores | Direct mapping may continue to provider-state proof; customer label is unchanged |
| Counts suggest tail but active key is absent/duplicated | No capacity refresh; no overflow |
| Active key lacks checkpoint/manifest binding | No capacity refresh; no overflow |
| Checkpoint and manifest task/key disagree | No capacity refresh; no overflow |
| Two active keys map to one task | No capacity refresh; no overflow |
| Mapped task is pending, terminal, cancelled, or ambiguous | No capacity refresh; no overflow |
| Exact final wave plus fresh verified headroom | Admit one candidate; peak base + 1 |
| Two simultaneous tail events | One capacity refresh flight; at most one overflow |
| Capacity changes while refresh is pending | Recheck; stale eligibility cannot admit |
| Pool job runs serially at its tail | It cannot open overflow |
| Continuity opens slot while Pool is next fairly | Pool may consume the one overflow |
| Both types stay queued | Round-robin opportunity; FIFO within recovery/fresh classes |
| Base decreases below current active | No preemption; no new start until safe |
| Global pause during refresh | No overflow |

## Release and Delivery

Release independently as **v1.4.91**:

- bump `package.json` and both root version surfaces in `package-lock.json`;
- add newest-first `CHANGELOG.md` copy describing fair image scheduling and one verified Continuity tail overlap without promising a guaranteed speedup;
- add no dependency;
- run focused RED/GREEN tests and the complete unfiltered `npm run verify` gate;
- obtain independent concurrency/safety review and resolve every finding;
- push the verified branch, create/update a PR, and merge only with clean checks/review/mergeability;
- synchronize main;
- run `npm run dist:smoke` from the main repository root and verify the arm64 DMG plus bundled `app.asar` are v1.4.91.

Do not publish, sign/notarize a public build, install, tag, or touch customer jobs.

## Non-goals

- No paid-image setting or replacement behavior.
- No image-pool fan-out.
- No adaptive thumbnails, audio, video, text, or local lanes.
- No second queue, priority queue, scheduler service, database, dependency, SRTF, or duration model.
- No provider routing, worker selection, capacity guess, retry change, or output mutation.
