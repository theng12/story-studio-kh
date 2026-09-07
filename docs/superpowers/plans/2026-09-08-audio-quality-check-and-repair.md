# Audio quality check and repair

**Requirements authority:** the approved audio-quality proposal at `<owner-home>/pinokio/_handoffs/2026-09-07_audio-quality-check-and-repair-proposal.md`. Its old implementation embargo is superseded by the owner authorization on 2026-09-08. This is the ordered delivery plan, not a competing product specification.

## Constraints

- Project-scoped audio_quality defaults to off for existing and new projects. It is not a preset field, Pipeline preflight rule, all_done authority, or normal-generation prerequisite.
- Reuse the current catalog/quote/confirm, task manifest, active audio mapping, source-hash freshness, correction report, and job queue. Add no provider, verifier catalog, retry engine, or media framework.
- A selected alternate transcription model must differ by published model id or revision; provider label alone is insufficient.
- Current audio/mapping/assembly/SRT stay unchanged until one action-scoped candidate verifies. Failed, cancelled, or inconclusive work retains prior bytes and map.
- An action is exact-section and exact-provenance scoped and persisted before paid work; restart/replay rejoins its own accepted work and has at most one logical candidate per chapter.
- I2V/Motion is paused. GenStudio/Claude-owned work is external.

## Evidence and design decisions

- Graphify ran once, narrowly, on electron/server/services (169 code files;
  2,879 nodes and 6,362 edges). Its query connected
  inspectSubtitleSourceFreshness, hashSubtitleAudioSources, task-manifest,
  subtitle-recovery, computeEpisodeStatus, and assertSubtitleTimelineComplete.
  The implementation therefore extends those shared boundaries instead of
  adding a parallel completion or retry state.
- Ponytail review chose the existing atomic-store writer, task manifest,
  subtitle correction report, source freshness hash, and job queue. The new
  sidecar only holds facts these stores do not: active TTS provenance and the
  repair action/candidate checkpoint. It stores hashes and mappings, never raw
  narration or a duplicate provider catalog.
- Impeccable context was inspected for the existing AudioChapterSelector. This
  is an Operate-surface refinement, not a new visual world: one compact row
  status and an expandable evidence panel remain in the incumbent Audio and
  confirmation controls. Product/DESIGN briefs are absent, so this scoped
  refinement does not invent them. UI QA will run the detector once after the
  changed targets are complete.

## Shared contract

### Project config

audio_quality is an optional project setting with:

- mode: off | flag_issues | check_and_repair
- alternate_transcription_model: optional string

Server normalization treats absent or invalid configuration as mode off. Safe config exposes it after normalization. The setting is project-scoped only.

### Audio-sections response

Each GET /projects/:slug/episodes/:code/audio-sections row adds optional quality:

- state: not_checked | checking | no_issue_detected | review_needed | repairing | fixed | still_needs_review
- reason and reason_code when known
- transcript_fresh boolean
- provenance: known | legacy | script_changed
- optional review start_sec, end_sec, excerpt
- optional receipt model_id, model_name, voice_id, provider_name

No full raw narration or secrets are duplicated into provenance. A review row
may expose the existing authorised short script and raw-transcript excerpts
around its evidence window; subtitles_stale remains a separate freshness
field.

### Quality action

POST /projects/:slug/episodes/:code/audio-quality/check takes a UUID operation_id, selected sections, and the persisted project mode. Server validates the exact active section set, canonicalizes it, and reuses an audio-quality job/action by operation id plus scope fingerprint. Flag issues reads local evidence only. Check and repair uses the user-selected catalog model. Initial confirmation discloses the advisory TTS amount and an explicit action-local verification-credit ceiling; a truthful transcription quote cannot exist until candidate bytes exist. The server persists that ceiling and source scope before TTS, then may quote/confirm candidate ASR automatically only inside the remaining authorized ceiling. If the live quote is higher, it retains the candidate and reports Needs approval without regenerating TTS. Direct repair additionally requires the caller to confirm the server-returned provenance fingerprint for that action; a changed script cannot silently become a repair source.

Pipeline keeps its ordinary step list, preflight, all-done calculation, and
run-batch defaults unchanged. After saved Subtitle output, its explicit
post-Subtitle action may submit selected episode IDs and selected chapter slugs
to the same per-episode `audio-quality/check` endpoint with `analysis_only`.
It is available only for a project that opted in, performs no provider work,
and does not require navigating through each episode’s Audio page. It links a
review-needed result to Audio for candidate selection and confirmation; it does
not infer a TTS model or voice from historical provenance or silently borrow a
preset. It is never a new Pipeline job stage.

## Ordered tasks

1. Add config types/schema/safe-config normalization and a small episode-local quality store for provenance, reports, and action checkpoints. Persist normalized-text hashes, active source map/hash, TTS model/voice/controls, and returned receipt at successful active-audio production. Legacy work remains reviewable.
2. Build local chapter evidence from source freshness, saved subtitle hashes, ChapterCorrectionReport, current narration normalization, and active parts. Flag only no issue, script changed, or review needed; it performs no provider work.
3. Add a separate alternate-ASR check for a selected **active** chapter before candidate repair: it reads exact staged active bytes, keeps raw evidence outside active subtitles, and persists quote/task/receipt/checkpoint through existing recovery boundaries. This is implemented. The codebase has no trustworthy cue-to-script-span locator, so it deliberately quotes and labels a whole-chapter fallback with the full script hash rather than claiming a precise passage. A same-model or ambiguous result remains review needed; candidate-ASR verification is separate.
4. Stage one action-scoped candidate per chapter with existing explicit fresh-action identity. Verify candidate source map and ASR evidence before atomically changing active audio_chapters mapping.
5. On promotion rebuild episode audio and install the already byte-verified candidate raw SRT for only that chapter, then re-stitch. It must not buy a duplicate transcription of the identical promoted bytes. Existing freshness gates leave downstream timing outputs for ordinary review; no image/video regeneration. If no prior Audio Assembly parameters are durable, retain candidate_ready with a visible Audio Assembly refresh path rather than inventing a mix.
6. UI owns Settings/Audio/Subtitles presentation and confirmation. QA owns mocked route-to-queue-to-provider integration and rendered review. No live or paid calls.
7. Run focused backend red/green, independent review, affected aggregate, documented release gate, then normal version/PR/merge/canonical smoke workflow after source freeze.

## Consolidated follow-up slices

After the quality core is independently reviewed, include these still-open,
owner-authorized items as bounded fixes rather than a shared framework:

1. Account-and-base-URL-scoped last-good GenStudio catalogue display cache for
   a 30–60 second provider restart. It displays its stale timestamp and Retry;
   fresh catalogue authority is still required before any spend.
2. QA and fix only if reproduced for the previously proposed missing-Finish
   cancel/restart/project-switch boundary.
3. QA and fix only if reproduced for Content Pack successor to Ideas duplicate,
   pin/reopen, and failed-update boundaries.
4. QA and fix only if reproduced for two-account/model-change behavior while
   queued or recovering work exists. The prior v1.4.122 report explicitly did
   not cover it. This is now closed by an owner-enforcing mock: a restarted
   accepted subtitle task under another account receives TaskUnavailable,
   preserves its original task/key, and submits nothing; returning to the
   original account recovers that same task. GenStudio publishes no stable
   account principal, so no raw-key fingerprint is persisted.

## Consolidation status

Already shipped and not reimplemented here: final-video restart (v1.4.112);
Introduction cleanup/editor (v1.4.114); Settings, Store, account repair, and
hidden-episode controls (v1.4.120); chapter actions/source freshness
(v1.4.123); and explicit fresh regeneration (v1.4.124). The active scope is
therefore quality workflow, last-good catalogue display cache, and the three
bounded reproduce-then-fix QA cases above. The new I2V duration brief remains
deferred.

## Implementation status before the release gate

- Tasks 1–6 are implemented and independently reviewed. Focused mocked route,
  queue, boot-recovery, candidate-promotion, active-ASR, catalogue-cache, and
  bounded legacy QA tests are green. The active-ASR route makes one provider
  quote under concurrent same-action replay, holds an over-ceiling quote
  durably, and can resume the same staged action with a larger ceiling.
- Task 7 remains in progress: final frontend type evidence, source freeze,
  unfiltered `npm run verify`, integration, and the required main-checkout
  local release smoke have not yet been claimed.
- There is no held-out labeled bad-TTS/ASR corpus. These mocked tests validate
  mechanics and fences only; they do not qualify detector accuracy or authorize
  automatic TTS replacement. Ambiguous evidence continues to surface Review
  needed, while a user-confirmed fingerprint-scoped candidate repair remains
  available.

## File boundaries

Backend:

- electron/server/models/types.ts
- electron/server/contracts/index.ts
- electron/server/services/project-manager.ts
- electron/server/services/audio-quality.ts (new coordinator)
- electron/server/services/audio-quality-store.ts (new atomic sidecar)
- electron/server/generators/audio.ts
- electron/server/generators/audio-merge.ts only where active mapping publishes
- electron/server/generators/subtitles.ts
- electron/server/services/subtitle-recovery.ts
- electron/server/routes/audio.ts
- electron/server/services/job-queue.ts and electron/server/boot/executors.ts only if existing audio/subtitle executors cannot run this without widening normal behavior
- focused backend tests under electron/server/__tests__/audio-quality*.test.ts

UI: Settings selector; Audio/Subtitles states, cards, confirmation, frontend tests.

QA: mocked integration, restart/promotion/byte-preservation evidence, rendered review.

## Acceptance

- Off preserves ordinary Audio, Subtitles, and Pipeline behavior and identities.
- Flag issues has zero provider calls; it distinguishes fresh/stale/script-changed/legacy/review-needed evidence.
- A selected set of episodes can run the explicit post-Subtitle check without
  changing normal Pipeline execution; the endpoint fans out only its selected
  episodes and exact chapter scope.
- Initial repair confirmation discloses advisory TTS and an explicit action-scoped ASR credit ceiling. The exact ASR quote is created only from staged candidate bytes and is automatically confirmed only within that persisted ceiling; above-ceiling candidates remain staged for approval without duplicate TTS.
- Fresh evidence produces no duplicate ASR.
- Alternate ASR is user-selected and model/revision distinct. The active-audio
  check quotes the exact staged chapter bytes and labels its whole-chapter
  fallback; it does not invent a cue-to-script timestamp. Candidate
  verification separately checks candidate bytes before promotion.
- Click replay, lost response, and restart rejoin one action/candidate. Cancellation or inconclusive verification does not promote.
- Candidate verification precedes atomic active-map promotion; only its subtitle/assembly refresh, and downstream freshness is truthful.
- Candidate ASR opens the staged candidate paths directly and is assessed before
  script-word correction. Promotion fences the current active-map revision,
  action id, and candidate source hashes, then updates the authoritative
  source_file/source_files mapping. The lifecycle fixture reopens playback,
  status, audio merge, and subtitle source resolution so an unselected _vN
  exclusion cannot silently select the old base after promotion.
- Mock integration covers same-action quote/confirm replay, over-ceiling hold
  and resume, candidate promotion/refresh, selected-map preservation across
  restart, accepted remote-task recovery, and cancellation/failure byte
  preservation. It is mechanical coverage, not audio-quality calibration.
- QA reports whether actual labeled audio calibration evidence exists. It is currently unavailable: EP0083 is a subtitle cue-gap report, not labeled bad-TTS/ASR evidence. Synthetic tests prove mechanics only and are never stated as calibration. Unqualified or ambiguous detector evidence stays Review needed; a user may still explicitly authorize a fingerprint-scoped repair of a known bad chapter.
