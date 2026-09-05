# Story targeted preflight implementation — 2026-09-05

## Scope

Closed the one concrete portable-handoff acceptance gap on Story Studio `main`
at `72a5aa1da35213c4d4f29da1630f18245a17584f`: a targeted `scene_plan` or
`scene_review` Pipeline request could bypass prerequisite preflight, create a
job, and only then fail at the runtime guard.

No recovery DAG, subtitle paid-replacement engine, provider integration,
customer/runtime data, deployment, or unrelated single-step behavior changed.
The older no-spending-toggle prohibition remains superseded by the accepted
1.4.102 optional paid subtitle replacement setting, default Off.

## Workspace and commits

- Source checkout: `/build/Developer/story-studio-kh`
- Isolated worktree: `/build/Developer/story-studio-kh/.worktrees/story-preflight-handoff`
- Branch: `codex/story-preflight-handoff`
- Start head: `72a5aa1da35213c4d4f29da1630f18245a17584f`
- Implementation commit: `c3f2effc29136ecd7e6b99e3e1aaabefd471c6ca`
- Application version: `1.4.103`

## Evidence and implementation

The source checkout was clean at the required head. The only Story runtime log
was `logs/server-2026-08-19.log`; it contained no evidence for this request-path
gap. No competing Story test process was running. No existing
`graphify-out/graph.json` was available to query, so the focused source trace
was used instead of building a new whole-repository graph.

`preflightBatch()` already builds its prerequisite facts from
`computeEpisodeStatus()`. That shared status authority derives Subtitles from
the saved audio-section and stitched-timeline evidence, and derives Scene Plan
from the canonical `scene_plan.json` plus prompt, subtitle, and coverage
integrity. The defect was the later blanket single-step bypass. The fix keeps
that targeted regeneration behavior for every existing unrelated step while
allowing the existing prerequisite map to check `scene_plan -> subtitles` and
`scene_review -> scene_plan` before `run-batch` reaches enqueue.

The regression file exercises the HTTP route with real temporary project and
episode artifacts and no registered executors. It covers:

- targeted Scene Plan with no stitched timeline: named `subtitles` rejection,
  HTTP 400, and unchanged job count;
- targeted Scene Plan with a sidecar that names missing `Chapter_02`: the same
  pre-enqueue rejection;
- targeted Scene Plan with a verified complete stitched timeline: one
  `scene_plan_run` job accepted;
- targeted Scene Review with no Scene Plan: named `scene_plan` rejection,
  HTTP 400, and unchanged job count;
- targeted Scene Review with an authoritative complete Scene Plan: one
  `continuity_render` job accepted.

## TDD and verification

Baseline before edits:

- `node scripts/testing/run-backend-tests.mjs --only pipeline-step-skip`
- exit 0; 25 tests, 4 suites, 25 passed, 0 failed; coverage 1/1 file.
- The file emitted two post-test queue-isolation diagnostics after its passing
  assertions. They reproduced unchanged in later combined runs and are not
  caused by the new test file.

Red proof before the production change:

- `node scripts/testing/run-backend-tests.mjs --only pipeline-targeted-prerequisites`
- exit 1; 5 tests, 2 passed, 3 failed.
- Each intended invalid request returned HTTP 201 with an enqueued
  `scene_plan_run` or `continuity_render` job. Both valid cases passed.

Fresh focused verification after the final implementation:

- `node scripts/testing/run-backend-tests.mjs --only pipeline-targeted-prerequisites --only pipeline-step-skip`
- exit 0; 30 tests, 4 suites, 30 passed, 0 failed; coverage 2/2 files and 34
  total marks. The same two baseline `pipeline-step-skip` post-test diagnostics
  appeared.
- `node scripts/testing/run-backend-tests.mjs --only pipeline-targeted-prerequisites`
- exit 0; 5 tests, 5 passed, 0 failed; coverage 1/1 file; clean output.
- `npm run typecheck:electron`
- exit 0.
- `npm run check:changelog`
- exit 0; package, lockfile, and newest What's New entry agree on `v1.4.103`.
- `npx eslint --no-ignore electron/server/__tests__/pipeline-targeted-prerequisites.test.ts`
- exit 0; no findings.
- `npx eslint electron/server/routes/pipeline.ts`
- exit 0; 0 errors and 50 pre-existing warnings.
- `git diff --cached --check`
- exit 0 before the implementation commit.

The complete release suite, push, pull request, merge, and release artifact were
deliberately not run or created. The coordinator requested inspection of this
focused report and an independent review before those lifecycle steps.

## Exit checklist

- Applicable root and repository `AGENTS.md` instructions were re-read.
- Logs were inspected before diagnosis.
- Work remained in the ignored isolated worktree from the exact requested head.
- The existing prerequisite and artifact authorities were reused; no second
  checker or abstraction was added.
- Red and green behavior were observed at the customer-facing route boundary.
- Required patch version and newest-first changelog entry were added.
- Focused tests, typecheck, lint, changelog, and whitespace checks are recorded
  above with exit status and counts.
- No Pinokio launcher file was touched, so launcher destination, example-lock,
  URL-capture, and Pinokio API syntax rules were not applicable.
- No provider call, paid work, customer data mutation, deployment, publish,
  push, merge, or full release suite occurred.

## Review request

Independently verify that excluding only `metadata`, `scene_plan`, and
`scene_review` from the single-step bypass preserves every other targeted
workflow, and that the test artifacts exercise the same status authorities used
by production. If accepted, the coordinator can run the remaining required
release gate and repository integration lifecycle.
