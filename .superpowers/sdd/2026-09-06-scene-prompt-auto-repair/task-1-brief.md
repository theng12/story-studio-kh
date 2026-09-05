# Scene prompt auto-repair

- Base/head: `1af346dca00e7faaabbabb16b2ca69a1ffe0c84f` (`main`, Story Studio 1.4.107)
- Worktree: `/build/Developer/story-studio-kh/.worktrees/story-scene-prompt-auto-repair`
- Branch: `codex/story-scene-prompt-auto-repair`
- Scope: add an explicit paid repair action for terminal `scene_plan_run` jobs with an existing authoritative Scene Plan containing missing or duplicate visual prompts.

## Applicable AGENTS snapshot

- GenStudio owns live model limits, capability and pricing; Story Studio must not copy or invent limits.
- Authoritative completion audits must preserve valid partial output and name missing/invalid items.
- Filtered backend tests are iteration evidence only; `npm run test:backend` remains the release gate.
- Application releases must align `package.json`, `package-lock.json`, and newest-first `CHANGELOG.md`, then build the final DMG from merged `main`.
- UI changes require source-derived desktop/mobile/focus inspection.

## Approved behavior

- The button is explicit consent to new billable GenStudio requests and is separate from free retrieval and ordinary whole-job Retry.
- The server derives the episode, model and repair scope from the saved terminal job and current `scene_plan.json`; it never accepts scene IDs from the request.
- Verified prompts remain byte-for-byte untouched. Every missing/duplicate prompt is requested alone, including large tails.
- The explicit mode completes one full repair pass, audits durable output, and continues only while the missing count improves. A full no-progress pass stops truthfully.
- Insufficient credit/auth/nonretryable errors stop. An unresolved or uncertain accepted request blocks all later submissions.
- Pause is cooperative between requests: an accepted request settles, then no new request starts.
- Timeline/setup failures with no repairable existing plan retain ordinary Retry.

## Verification plan

- Route tests: eligibility, empty-body contract, params sanitization/provenance, unsettled-evidence denial, no usable plan/no gaps.
- Generator tests: >7 single-scene requests, valid prompt preservation, progress/no-progress continuation, unresolved submission fence, pause between accepted requests.
- Frontend tests and actual render: paid copy, both repair and ordinary Retry, disabled/busy state, keyboard focus, 390px layout.
- Independent source/UI review, release metadata, official full local verify, normal PR merge, merged-main `dist:smoke`.

No live provider request, paid action, installed-app restart, or GitHub-hosted compute is authorized.

## Implemented checkpoint

- The saved Capi rows for EP0180 and EP0227 are stage-omitted Pipeline Scene Plan jobs with a saved text model and `pipeline_chain`; that exact structured shape is eligible. Explicit timeline, deterministic-timeline, motion and scene-replan jobs remain on ordinary Retry.
- Each explicit repair action mints its request identity from its durable replacement job ID. Restart/recovery within that action replays safely; another explicit click after settled failure creates fresh authorized work.
- A retained successful chat request is recovered by its exact saved idempotency key and scene-pack contract before any replacement is submitted. Only prompts still missing in the fresh disk audit are checkpointed; settled unusable output may then receive a new single-scene request. Missing recovery evidence, a still-running request, or `LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN` stops without a new POST.
- The button and Retry-all exclude failed explicit-repair jobs from an ordinary unlabeled replay. The credits-labelled action remains available.
- Saved prompt continuity settings remain intact. Wider target/writer controls are replaced by server-owned missing-visual-prompt scope, with the episode pinned to the original job identity.
- Source-derived Jobs captures: `/build/pinokio/_handoffs/story-scene-prompt-auto-repair-ui/jobs-desktop.png`, `jobs-mobile.png`, and `jobs-mobile-focus.png`. At 390 px, `clientWidth === scrollWidth === 390`, all row actions wrap into view, and the focused paid action reports an active 2 px solid focus outline.

## Focused verification

- Generator/route integration: 23/23 pass, including settled `LANGUAGE_STRUCTURED_OUTPUT_INVALID` recovery, >2 improving passes, no-progress stop, uncertainty/auth/checkpoint fences, pause, per-action idempotency, accepted-timeout fencing, exact-key completed-output recovery, newest-first overlap, missing-lookup refusal, and provider settlement during the asynchronous disk audit.
- Related backend set: 38/38 tests plus 2 suites passed before the final isolated per-action-identity correction; configured project root byte-identical.
- Jobs frontend: 33/33 pass.
- Full Electron/frontend typecheck: exit 0.
- Targeted ESLint: exit 0 (warnings only); `check:changelog` and `git diff --check`: exit 0.
- The first official verify attempt on the pre-recovery snapshot was intentionally interrupted during backend tests after independent review found the exact-key recovery blocker. Its durable log is retained at `/build/pinokio/_handoffs/logs/2026-09-06_story-1.4.108-full-verify.log`; it is superseded evidence, not a pass or failure verdict.

The repository-required full `npm run verify`, independent final review, merge, and merged-main package smoke remain release gates.
