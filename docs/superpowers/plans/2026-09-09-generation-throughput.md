# Generation throughput and explicit Pipeline model choices

> **For agentic workers:** Use focused subagent-driven development with independent review. The owner approved this complete flow on 2026-09-09; execute without another design approval.

**Goal:** Replenish image work efficiently, explain remote queues, and let Pipeline intentionally override, distribute, or use backups among selected GenStudio products without duplicating accepted work.

**Architecture:** Extend existing image admission, durable job evidence, Pipeline stage parameters, and the shared AI client. GenStudio alone owns provider execution and billing; Story selects explicit customer products and stages independent work. Existing single-product runs and request identities remain unchanged.

**Tech stack:** Vue/Nuxt, TypeScript/Electron/Express, existing Node test harnesses. No new dependencies.

**Spec:** Owner-approved proposal in this conversation, following the read-only audit at Story c49f25cc and GenStudio 47c8adc0. This document is the execution source of truth.

## Constraints and baseline

- Source base c49f25cc; canonical tree has one unrelated untracked Impeccable critique, preserved.
- Existing full verification from v1.4.131 passed 4,957 backend, 1,555 frontend, 36 release tests, and merged content 364 with two optional evidence skips. Run focused regression baselines before each change and full verification for this release.
- Graphify source map already queried; verify actual callers before edits.
- Paid generation, production data changes, upload operations, GenStudio changes/restarts and hosted GitHub compute are out of scope. Use fake provider/synthetic browser fixtures.
- No changes to selected model capability/price facts: resolve catalogue fields for each exact product; no name-based equivalence, inferred provider dispatch, or copied limits.
- User-approved pool policy is explicit selection among separate products, not silent fallback inside one GenStudio product.
- Preserve accepted/uncertain request identities and reconnect them; a different candidate is never selected merely because a response is slow.
- Existing episode and chapter ordering, saved assets, cancellation, account isolation and billing evidence remain intact.
- One test suite at a time; root coordinates. Agents do not commit shared files or edit another agent's ownership without coordination.
- Version/changelog, independent review, full local verification, Actions-disabled push/PR/merge, canonical-main DMG build and launch verification are required.

## Task 1 — Image admission and remote queue evidence (agent: plan_review)

Files: lib/genstudio-admission.ts, lib/genstudio-client.ts; relevant genstudio admission/permit/evidence tests. Agent may own additions to server model/contracts evidence types after notifying root.

- [x] Baseline/reproduce a standard limit of 50 with active>=50, burst ceiling1000 and many waiting image requests. Confirm current permit issuance shrinks to one although staged workers are plentiful.
- [x] Separate the bounded permit-request budget from remaining standard execution slots. Derive it only from published/account limits; actual permit responses remain authoritative. Do not launch an unbounded permit storm or reserve fleet nodes. Honor account submission pace, queue bounds and Retry-After.
- [x] Ensure a waiting/429 permit request does not monopolize replenishment; maintain cancellation and idempotent permit sequences. Keep unknown capacity conservative. Test slow overview, exhausted remote permit window, independent progress, cancellation, account separation and restart/reconciliation.
- [x] Carry validated nullable queue_position, queue_eta_seconds and queue_reason through GenStudio job parsing, evidence normalization and persistence; clear stale fields when publication disappears/state advances. Distinguish local permit wait from accepted remote queue in the existing onQueueState/evidence flow.
- [x] Focused regression tests and handoff exact exported fields to frontend owner; root schedules test commands.

## Task 2 — Explicit model policy execution (agent: plan_contract)

Files: routes/pipeline.ts; new small shared policy helper only if needed; lib/ai-client.ts and generator contexts as needed; focused Pipeline/routing tests. Do not edit genstudio-client.ts concurrently; request shared interface changes from Task1 owner.

Public request contract: optional `model_policies` object keyed by eligible Pipeline step. Each value `{ mode: 'single' | 'distribute' | 'backup', models: string[] }`. Omitted entries use the preset. Exact IDs accepted through existing GenStudio model normalization. Single requires one model; distribute/backup require >=2 distinct products. Reject unsupported stage keys and malformed/empty policies before mutation.

Eligible writing stages: script-only, introduction-only, research, metadata, image_prompts, scene_plan, contextual_cues. No policy on image/TTS/subtitle/video stages. Scope each task's contract to its real catalogue capabilities; incompatible choices must be explained before submission, never silently truncated/relabelled.

Durable job params: `pipeline_model_policy` records approved mode/models and stable assigned_model per stage/episode. Persist assignments when constructing the chain, including both outline_only and expand_chapters. Per-episode distribution is stable for a batch and survives retry; never reassign accepted work based on later queue order.

- [x] Write red tests for per-run override without modifying preset, deterministic distribution, malformed/unsupported input and catalogue incompatibility; run focused baseline.
- [x] Apply the assigned exact model in stage params and preserve policy through downstream chain creation, chapter repair, and ordinary job retry. Reuse existing Pipeline chain machinery.
- [x] Implement explicit backup execution at the narrow shared language boundary, with bounded candidate count and durable per-logical-request chosen candidate/evidence. Switch only for provably unaccepted or settled terminal failures permitted by the approved retry policy; do not infer safety from generic network/5xx/timeout text. Automatic backup initially only uncharged/released failures; charged/uncertain work stays reviewable and explicit regeneration remains available.
- [x] Revalidate exact candidate limits/output/vision/structured requirements before each fresh request. Keep inputs/required output intact or explain incompatibility and try another authorized candidate. Never substitute an arbitrary default into an explicit policy.
- [x] Preserve request identity when recovering an accepted primary/backup, and persist the actual selected product with result diagnostics. Bound attempts; no repeated fallback after restart.
- [x] Extend eligible writing stages using their real CallAi job contexts. Cover slow/429 provider, refusal, terminal paid/unknown state, accepted-but-response-lost, partial chapters, cancellation and restart; ensure unrelated work continues.

## Task 3 — Pipeline and Jobs UI (agent: plan_editor_ui)

Files: frontend Pipeline page, existing model picker, job evidence display components/utilities and focused UI tests. Own frontend only; coordinate evidence types with Task1, policy contract with Task2.

- [x] Read incumbent UI and Impeccable context/operate/craft-floor. Preserve the app's visual identity and use existing controls/components.
- [x] Each eligible stage retains its preset picker; add compact expandable 'Models for this run' controls: preset default / choose model, plus single/distribute/backup. Existing live ModelSelector chooses each exact product. Allow add/remove/reorder candidates for backups and show each published price/provider/limits through existing picker details.
- [x] Post the exact model_policies contract only for enabled selections; reset unsafe episode/project state, retain expected drafts and label temporary overrides clearly. Run summary explains distribution across episodes, backup credit behavior, and actual selected product. Do not change presets when choosing per-run models.
- [x] Show queued provider position and approximate ETA only when published and current; distinguish local waiting, admission waiting, provider queue and generation. Missing/zero values, multiple requests and terminal states must read honestly. Link existing job details instead of exposing implementation jargon.
- [x] Focused component tests for form payloads, project switching, candidate removal/reorder, invalid selection, queue field clearing, keyboard controls. Root coordinates commands and final desktop/narrow visual QA.

## Task 4 — Integration, review and release (root)

- [x] Review each task's source/test evidence and independently review shared recovery boundaries. Resolve interface mismatches and validate explicit-policy preservation across every eligible generator.
- [x] Run controlled synthetic concurrency/restart scenarios with no paid calls. Compare permit issuance before/after under the same simulated capacity, prove accepted task reuse and no duplicate paid submissions.
- [x] One batched desktop/narrow UI inspection; fix confirmed defects and one confirmation pass. No production settings or plans modified.
- [x] Bump app to next available version and add accurate changelog. Mark completed tasks and findings here.
- [x] Full npm run verify, independent whole-branch review, fix material findings, relevant reruns. Record exact counts/skips and production-data isolation evidence.
- [ ] Confirm GitHub Actions disabled, commit/push/create PR/merge when clean and mergeable; sync canonical main, build npm run dist:smoke and verify artifact startup/version.
- [ ] Save completion handoff, installer path and remaining measured limitations. No promise of permanent full fleet utilization or zero provider failures.

## Execution notes

2026-09-09: Approved scope captured. Separate worktree generation-throughput created; dependencies reused through local symlinks for verification only. Packaging will be from canonical main. No new product actions or paid calls authorized by QA.

Dispatch ledger: plan_review owns admission/client/evidence, plan_contract owns Pipeline/AI policy execution, plan_editor_ui owns frontend. All started from c49f25cc in the shared isolated branch. Completion proof is focused tests per ownership, followed by independent review and full official verification. Root owns integration/release and synthetic browser QA.

Initial Task1 baseline: admission+image-permit focused run reported 54/55 passing, with one literal hash expectation differing in the isolated environment. Investigate and preserve identity assertions rather than treating this as green. Root review additionally identified timer earliest-deadline, retry backoff/pacing, and requeued cancellation cases for regression coverage.

Browser QA will use a standalone synthetic API at loopback port 8888 with no production forwarding. Its requests are captured locally so per-run payloads can be inspected without generation charges or changes to presets/projects.

Root visual QA (synthetic only): desktop 1440 and narrow 390 rendered Pipeline. Fixed initial expanded-card grid stretch and checkbox alignment. Confirmed no horizontal overflow (document.scrollWidth matched 1440/390), candidate buttons remained reachable, selected-model picker showed independent provider/rates, duplicate candidates blocked submission, and interacting with policy controls did not toggle stages. Synthetic preflight and run both carried `model_policies.script-only={mode:distribute,models:[genstudio-chat:alpha,genstudio-chat:beta]}`; no preset/config writes occurred. Jobs SSE fixture placed newest request at array index 0 with parent local position 99 and older remote position 8: UI correctly displayed latest remote position 2 / ETA 2 minutes, then cleared both when same request entered running with null queue fields.

Independent implementation review caught core backup durability gaps (all-stage binding, ordered primary, durable candidate advancement, cancelled/uncertain failure classification). These were fixed and exercised before the final verification run; a model-specific digest alone cannot protect a restart that changes candidate.

2026-09-09 integration: fast-forwarded the isolated branch to main 74d25fb6 (Claude’s content previews/docs only) before release verification. App version 1.4.132 reserved. Root added an actual isolated normal Pipeline → unavailable primary → accepted backup → new Jobs Retry integration test; focused policy/Cues/Scene run passed 145 tests, including this test with provider submission count unchanged at 1 and saved presets unchanged. Image permit focused 33/33 includes queue-full deadline regression. No paid QA calls.

Final review resolutions: exact provider keys persist before POST; read-only recovery bypasses current capability sizing; script groups, Scene Plan request shape and matching Cues progress preserve historical request boundaries. Web recovery skips catalog discovery and replacement POST. The legacy scene-planner writing calls now receive the same explicit policy adapter. Published JSON-object support remains valid with local schema validation. UI labels derived input capacity as an estimate; exact prompt token fit remains GenStudio’s validation (no guessed tokenizer or character conversion added). Independent source review approved these paths. Final focused combined run 92 tests/16 suites across 5 files passed.

## Historical release hold — corrected by Claude on 2026-09-09

Resumed after Claude's reply in `2026-09-09_to-codex_backyard-topic-successors.md`. Merged main `3fb25e55` into this branch as `05754e50`. Independent source/registry/artifact review confirms both immutable 1.0.1 successors are sold, old bytes are preserved, only mechanisms changed, and largest shared affixes are 0.6% / 0.3% under the unchanged 5% bar. The previous content blocker below is resolved; the combined full verifier must still pass before release.

The first full `npm run verify` exited 1 at the backend gate: 439/439 files, 4,986 tests, 4,976 passed and 10 failed; no skipped tests and configured projects root byte-identical. Nine failures were changed caller anchors or refusal-message details in this runtime branch. Their corrected tracing preserves the JSON/prose and bounded-repair assertions; the typed pre-submit refusal again names the live model and remedy. Independent review approved the corrections. Focused recheck of those files plus Pipeline policy/integration passed 63/63 (exit 0).

The remaining failure in that historical run was upstream content, byte-identical to main 74d25fb6: Backyard Creatures 1.0.0 has 32.6% of mechanism values opening with `a chapter on the`, above the existing 5% ceiling. The same read-only measurement finds Backyard Plants 1.0.0 at 36.9%. Both are already stocked; do not change immutable published bytes or weaken the guard. Claude/content must author and release corrected successors through the existing content workflow. Evidence and exact ownership are in `<owner-home>/pinokio/_handoffs/2026-09-09_to-claude_backyard-topic-release-blocker.md`.

That content hold was resolved by the immutable successors described above. Release verification and integration results are recorded below.

Remaining lanes were then run independently because the failed backend gate had prevented them from starting: lint passed with 0 errors / 1,818 warnings; both typechecks passed; frontend passed 1,563/1,563 across 162 files; release passed 36/36 across 4 files; content tooling passed 364 of 366 tests across 38 files, with 2 optional external-evidence checks skipped and no failures. Production build passed, including changelog, typography, security, model-drift and desktop-release checks. The command chain exited 0. Content tooling was repeated with durable log capture after its first console summary was truncated; that repeat also exited 0 with the counts above. This does not override the separate backend authorship failure.

Logs are preserved at `<owner-home>/pinokio/_handoffs/logs/story-generation-throughput-2026-09-09/`. No additional dependencies were introduced. The runtime branch was committed and pushed as draft PR #87 while that hold was open.

## Resumed verification

The combined run after merging corrected content exposed an ordering assumption in an image-permit test: two independent permit arrivals were asserted in a fixed order. Its failing assertion also restored a fetch stub before its pending work drained, contaminating two later fixtures. The test now awaits both required arrivals while the original permit remains unresolved and drains all fixture requests in finally; the normal Promise.all still propagates actual generation failures. Independent review approved this test-only fix. Focused image admission: exit 0, 33/33.

Fresh official verify on the corrected source passed lint (0 errors, 1,818 warnings), both typechecks, all 439 backend files (4,986/4,986, no skips; configured projects root byte-identical), and all 162 frontend files (1,563/1,563, no skips). The release lane then correctly rejected an owner-specific home path in this plan. Replaced it with the required placeholder; application source is unchanged. After this documentation-only correction, the release/content/build command chain exited 0: release 36/36 across 4 files; content 366 passed / 2 optional external-evidence skips (368 total) across 38 files; production build and source/built security, model-drift, typography, changelog and desktop release checks passed. All required lanes are green (6,951 tests passed, 2 optional skips). The original full command exit remains 1 due to the corrected documentation failure; unchanged backend/frontend lanes were not repeated. Final independent review approved the test and documentation diff, with no material unresolved finding.

Repository integration and canonical-main installer evidence will be closed in the external `pinokio/_handoffs/2026-09-09_story-generation-throughput-status.md` receipt after those operations complete. This plan intentionally does not claim an installer exists before packaging.
