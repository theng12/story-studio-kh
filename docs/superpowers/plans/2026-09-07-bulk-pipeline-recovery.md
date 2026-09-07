# Bulk Pipeline Recovery Implementation Plan

**Goal:** Add one explicit Pipeline repair mode that restores selected missing or unusable outputs through existing durable recovery paths, skips valid output, and continues only selected downstream stages without duplicate provider work or editorial mutation.

## Current implementation status

- [x] Pipeline action contract, selected-stage handling, and subtitle repair implementation are in the shared worktree.
- [x] Focused subtitle recovery and source-readiness regressions are written.
- [x] Shared focused verification passed 172/172 backend tests; Pipeline UI source coverage passed 10/10. Electron and Nuxt typechecks passed in the official gate.
- [x] Independent source review and rendered isolated UI QA are complete.
- [x] Repository-wide release verification passed: 6,572 tests passed, 2 optional tests skipped, across 608 files; lint, typechecks, builds, security check, and built-app startup passed.

## Acceptance matrix

| Situation | Required result | Proof |
| --- | --- | --- |
| Valid output | Repair skips it. Normal Force rerun is a separate mode. | No queue row/provider POST; response says skipped-valid. |
| Available saved provider result | Recover/rejoin by its saved task/key/output identity. | Existing job/manifest/checkpoint remains owner; no new POST. |
| Active request | Join the exact active owner. | Repeated click/HTTP returns the same work. |
| Confirmed failed, expired artifact, or verified missing output | One fresh identity at most per missing item per action, using the one up-front **may use credits** authorization. | Action, original/replacement identities, and outcome survive restart. No per-chapter prompt. |
| Task/key/manifest/result/account ownership is ambiguous | Preserve evidence; do not replace or charge. | Needs-attention/current-account outcome; no POST. |
| Unusable subtitle chapter or internal cue gap | Target only affected chapters, stitch, then prove timeline. | Valid SRT bytes stay unchanged; Scene Plan/Review wait for proof. |
| Cancel/restart | A user cancellation of the current repair stops new submissions at the existing cooperative boundary; reconcile accepted work first after restart. A previously provider-cancelled attempt is a terminal recovery input, not this action’s cancellation. | Same identity/action resumes; boot makes no fresh POST. |
| Double-click, partial HTTP, terminal root replay | Validate same frontend UUID and reuse through action lock/job scan. | Matching slug/episodes/steps fingerprint reuses; mismatch rejects. |
| Only downstream stage selected with failed prerequisite | Do not insert an unselected prerequisite. | Named blocker; no downstream job. Selected sequence may continue only after its selected recovery succeeds. |
| `repair_missing` + `force` | Reject. Repair always skips valid output. | No action/job created. |
| Preset/editorial state | Current preset is used only for an eligible fresh request; recovered identity and approved content do not change. | No preset/config/approval rewrite. |

### Observed focused evidence (not a full matrix run)

- **Valid output and subtitle scope:** `pipeline-bulk-recovery.test.ts` preserved a valid chapter byte-for-byte while repairing only the internally gapped chapter; `paid-image-replacement-integration.test.ts` preserved a decodable `scene.image_path` image. The dedicated test does not exercise every asset type.
- **Saved/active/provider identity:** focused tests recovered a saved subtitle result without a new transcription POST, rejoined accepted image work, and replayed a prepared image identity after restart. They do not make a live provider request.
- **One fresh attempt, restart, and cancellation:** subtitle-recovery tests cover one scoped replacement, persisted pre-confirm identity, a current-action cancellation with no confirmation, and an unavailable old-account task with no new confirmation. Image tests cover terminal image fencing and prepared/restarted replay.
- **Selected downstream truth:** the dedicated queue-chain test proves subtitles → Scene Plan → one missing image and separately proves failed subtitles block an unselected downstream Scene Review step. Normal editor/preset bytes and every cross-page presentation are not asserted by that test.
- **Action replay and force:** `pipeline-step-skip.test.ts` covers valid UUIDs, force rejection, chain stamping, same-action reuse, and changed-settings rejection. It is not a dedicated lost-HTTP-response or terminal-root replay fixture.
- **Observed cross-surface scope:** the owned test pauses Episode A's repair before provider admission, reads Jobs and Scene Review for sibling Episode B, proves A's action/job is absent from B, and replays A without a new POST. It uses one project and one mock connection.
- **Still unexecuted:** the two-account variant of that cross-surface scenario. Existing focused coverage separately proves only that an unavailable old-account subtitle task cannot create a new confirmation; it does not prove two-account UI visibility/isolation.

## Approved contract and boundaries

```ts
POST /projects/:slug/pipeline/run-batch
{
  episode_ids: string[]
  steps: BatchStep[]
  repair_missing: true
  action_id: UUID // generated by frontend
}

// persisted by server, never a second repair boolean
params.pipeline_repair = { action_id: string }
```

- Validate the frontend UUID. Derive one stable fingerprint from slug, selected episode IDs, and selected stages. The same action lock scans persisted work, including partial HTTP and terminal roots, before creating work.
- Reject `repair_missing: true` with `force: true`. Existing normal `force` remains unchanged outside repair mode.
- Reuse the job queue, episode status, manifests/checkpoints, subtitle ledger, and Scene Review’s manual Finish owner. Do not add a recovery framework, route alias, scheduler, queue, global auto-retry, compatibility layer, or client-side recovery classifier.
- For images, call the current missing-only Scene Review seam with the same action ID and `manual_image_finish: { action_id, replace_uncertain: false }`; target only missing decodable-image IDs. Keep existing manual Finish UI and its cancellation/terminal behavior authoritative.
- For subtitles, reuse the existing invalid/missing/gap derivation and section recovery ledger. The action authorizes one fresh identity per affected item only through the existing ordinary live admission path. This plan does **not** assume a manual-Finish automatic credit ceiling because current code does not prove one.
- Selected stages only: repair does not synthesize a predecessor stage. A selected downstream stage blocks if inputs are invalid and its necessary stage was not selected.
- Preserve valid artifacts, scripts, scene plan/cue approval, content-pack provenance, project config, and preset bytes. No live production, account, purchase, provider, upload, or paid QA.

## Existing interfaces and owners

| Owner | Existing seam | Scope |
| --- | --- | --- |
| Pipeline worker | `electron/server/routes/pipeline.ts`, `frontend/pages/projects/[slug]/pipeline.vue`, `electron/server/routes/scene-review.ts`, `electron/server/generators/continuity-render.ts` | Request/action/fingerprint, selected-stage status, Pipeline control, missing-only image recovery. |
| Subtitles worker | `electron/server/services/subtitle-recovery.ts`, `electron/server/services/asset-status.ts`, `electron/server/services/scene-timeline-integrity.ts`, `electron/server/lib/subtitle-autostitch.ts` | Invalid/missing/gapped chapter scope, ledger identity, stitch/timeline gate, additive types only if required. |
| Integration worker/root | `electron/server/services/job-queue.ts`, `electron/server/services/episode-recovery.ts`, existing test files below | Cross-surface/restart evidence; preserve existing queue and manual-Finish boundaries unless a proved additive projection is required. |

Existing test surfaces to extend: `electron/server/__tests__/pipeline-integration.test.ts`, `pipeline-step-skip.test.ts`, `pipeline-targeted-prerequisites.test.ts`, `episode-recovery.test.ts`, `job-queue-genstudio-resume.test.ts`, `paid-image-replacement-integration.test.ts`, `subtitle-recovery-engine.test.ts`, `frontend/__tests__/pipelineStageSelection.test.ts`, `sceneReviewFinishMissing.test.ts`, and `jobsRetryAllManualFinish.test.ts`.

---

## Batch 1 — Pipeline action, selected-stage gate, and missing images

**Owner:** Pipeline worker

**Files:** `electron/server/routes/pipeline.ts`, `frontend/pages/projects/[slug]/pipeline.vue`, and only the existing Scene Review/continuity files needed to reuse missing-only Finish.

1. Extend the existing run-batch parser for `repair_missing` plus frontend `action_id`; reject malformed UUIDs, client `pipeline_repair`, unknown repair authority fields, and repair with force.
2. Before enqueue, validate/action-lock the fingerprint and scan jobs for the same durable action. A matching action reuses work whether the prior request ended before response, is active, or has a terminal root; a mismatched replay rejects.
3. In repair mode, replace ordinary done/force selection with server status classification: valid output skips, active work joins, recoverable saved evidence reuses, and only a proven missing/known-terminal case reaches the current replacement path. Route image targets through `enqueueMissingScenes` semantics: missing-only, decodable-image check, existing bulk-owner join, manual marker with the action UUID, and `replace_uncertain: false`.
4. Keep selected-stage scope. A selected downstream stage with invalid prerequisite becomes a named blocker unless the required upstream stage was selected and its existing chain completes successfully. Do not auto-add Audio, Subtitles, Scene Plan, or Scene Review merely because another was checked.
5. Add one Pipeline repair action in the existing confirmation/result area. It states “skips saved valid outputs” and “may use credits for proven missing output,” sends the UUID once, disables repeat submission, and renders enqueue/reuse/skip/blocker facts returned now. Do not claim async recovery/replacement has already completed; Jobs/Scene Review retain artifact-result status.

**Acceptance evidence:** Extend the existing Pipeline/Scene Review tests for valid skip, force rejection, UUID/fingerprint duplicate handling, partial HTTP/terminal-root action reuse, active image join, missing-only decodable IDs, selected-downstream blocker, selected ordered continuation, and unchanged approval/preset bytes.

## Batch 2 — Subtitle candidates, recovery, and timeline gate

**Owner:** Subtitles worker

**Files:** `electron/server/services/subtitle-recovery.ts`, `asset-status.ts`, `scene-timeline-integrity.ts`, `subtitle-autostitch.ts`, and only required shared types.

1. Derive candidates from the existing authoritative chapter status and `blocking_cue_gaps`: missing, unreadable, or internally gapped sections only. Do not select from filename guesses or regenerate healthy chapters.
2. Bind the validated repair action to the current subtitle ledger/recovery identity without allowing a request body to expand its section set. Rejoin saved accepted work first; retain current task/key/account checks and current cancellation behavior.
3. Permit one fresh identity per affected section only after the existing recovery code proves the saved result cannot be recovered and ordinary live admission allows it. If result/account/task/key evidence is ambiguous, persist Needs attention and do not POST. Do not add a separate confirmation or unproven automatic ceiling.
4. After the targeted work, use the existing stitch and written-timeline verification. Continue selected downstream stages only if that proof passes; otherwise return a precise Subtitles blocker.

**Acceptance evidence:** Extend existing subtitle/episode tests for valid SRT preservation, missing/corrupt/gap targeting, saved-task recovery, one fresh attempt per action, ambiguous account block, cancellation/restart identity persistence, failed stitch blocker, and no unselected downstream job.

## Batch 3 — Durable cross-surface recovery review

**Owner:** Integration worker, coordinated by root

**Files:** existing queue/episode-recovery interfaces only if a focused test proves an additive projection is required; otherwise no implementation change. Extend existing queue, recovery, and frontend tests listed above.

1. **Partially observed:** an isolated same-project A/B fixture pauses A before provider submission, then reads Jobs and Scene Review for B and replays A without a second POST. The planned two-account/accepted-task/restart variant remains unexecuted.
2. Assert A’s action, identity, and status never appear under B. Original-account work may only reconcile/rejoin saved evidence; new work requires the current eligible catalog. Ambiguity blocks rather than choosing an account.
3. Assert the same UUID/fingerprint after restart produces no second POST or replacement identity, valid output remains byte-identical, and the existing manual Scene Review Finish remains separate from generic Retry.
4. Review the implementation for scope: no hidden prerequisite insertion, queue rewrite, generic retry, automatic approval, preset/project mutation, output regeneration, or unproven pricing semantics.

## Release verification

Root owns test-lane selection, independent review, merge, version/changelog, and release gates. Before any completion claim, run the focused existing test surfaces changed by the workers, then the repository-required verification/build/release checks from the current release workflow. Use isolated mocked provider/account fixtures for the matrix; do not make live paid calls. Record remaining unsupported or ambiguous cases as blockers rather than widening recovery.

## Plan review notes

- Current `enqueueMissingScenes` already deduplicates active bulk scene work and fingerprints `manual_image_finish`; this plan extends that seam instead of predicting a new settlement/cancellation policy.
- The main product risk was downstream-only selection with failed prerequisites. The approved chosen behavior is a named blocker, not implicit recovery; this keeps operator selection truthful and avoids unrequested work.
- The response is limited to synchronous enqueue/reuse/skip/blocker facts. Recovery, recovered artifacts, and replacement outcomes remain asynchronous and are shown by existing Jobs/Scene Review state.
