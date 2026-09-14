# Shared writing model lineup — accepted implementation plan

## Owner direction

Use one reusable lineup for Pipeline and queued writing generators. Prefer selected free and discounted choices, then continue to selected paid models. Output consistency between models is not a restriction. No mandatory spending cap. Keep generation presets responsible for their existing content settings. Stage-specific model policies still override the shared lineup. Recover accepted or uncertain requests before any replacement.

## Evidence and boundaries

Starting Story commit: `45ba097c`, version 1.4.162. GenStudio inspected at `96e5215f`. The existing Pipeline policy executor already checkpoints candidate selection and acceptance. The catalogue already publishes aliases, retirement successors, effective prices, discounts, availability reasons and some reset timestamps. It does not publish shared quota pool identities or a chat chargeable flag. Supplier-free does not mean zero customer credits.

Relevant AGENTS requirements: live selected-model capabilities and prices; preserve preset boundaries, idempotency and verified completion; one test suite at a time; independent review; local-only verification and builds; Actions disabled before repository integration. No launcher files, paid test calls, customer jobs, or installed-app restart are part of this implementation.

## Implementation

- [x] Persist validated project `llm_lineup: { enabled, models, prefer_savings }` through the existing project config GET/PUT and named preset store. Store choices only, never catalogue prices/limits.
- [x] Add one Pipeline lineup editor using existing model pickers. Explain inherited versus explicit stage selection and paid fallback. Show the inheritance on relevant queued writing pages.
- [x] Snapshot the lineup into new queued writing jobs and chained stages; explicit Pipeline policies win. Cover Ideas, Script/Outline/Chapter expansion/regeneration, Introduction, Research, Thumbnail Prompts, Scene Plan, Contextual Cues and Metadata. Synchronous editing utilities retain their explicit model selection.
- [x] Extend the existing model policy executor, rather than add another fallback engine. Resolve published aliases without changing a saved request's wire identity; honor published successor metadata only for new work. Rank selected models from current effective prices and discounts when a logical request starts; freeze its actual candidate order in its checkpoint.
- [x] Advance only on proven pre-submission refusals or confirmed fully released zero settlements. Record temporary product exhaustion per account; never infer shared Gemini pools from names. Keep accepted/uncertain requests bound to their original recovery key.
- [x] Persist a waiting checkpoint when all usable choices are temporarily unavailable. Release the local worker and retain partial output; wake no earlier than published reset/retry guidance, or use a bounded local availability recheck when no reset is published. Preserve waiting, pause and cancel across restart.
- [ ] Coordinate the language quota code and optional shared-pool metadata with GenStudio via a durable local handoff. Story can operate with product-level availability now; unknown shared pools stay unknown.

## Ownership and proof

Root owns config, queue, route integration, targeted manual adapters, version/changelog and release. `lineup_executor` owns policy/client execution and direct research/narration adapters. `lineup_ui` owns frontend editor and notices. Read-only call-site and contract inventories completed at the starting commits. Agents do not run competing suites.

Focused regression cases: disabled lineup preserves preset model; enabled lineup snapshots without changing prompt/style settings; explicit stage override; alias rename; free/discounted exhaustion advances to selected paid product; accepted/uncertain request never advances; all depleted waits without holding a worker; due wait resumes and survives restart; pause/abandon prevents resume; technical incompatibility remains actionable; project/account isolation; stale UI response cannot save to another project.

- [x] Baseline policy tests: 22 tests across 2 files; partial run only.
- [x] Focused backend/frontend checks, typecheck and rendered UI inspection.
- [x] Independent review of final source and recovery behavior.
- [ ] Full local `npm run verify`, matching version/changelog, GitHub Actions disabled, reviewed PR integration.
- [ ] Canonical main `npm run dist:smoke`, artifact version and launch verification; no automatic installation.

## GenStudio contract request

GenStudio emits `LANGUAGE_PROVIDER_QUOTA_EXHAUSTED` but Story's language-code classifier omits it. Story will recognize the code without treating it alone as proof of a free retry: complete settlement evidence remains required. Please preserve that code and document its settlement/retry semantics.

Optional additive metadata requested from the GenStudio owner session: verified opaque quota pool/scope, retry scope and quota kind, and quota-terminal retry/reset timestamps. Omit unknown values. Publish effective customer chargeability only if it can be authoritative. Existing aliases and `replacement_model_id` are reused. No provider route control is added to Story.

Local coordination: `/build/Developer/_handoffs/STORY-GENSTUDIO-LLM-LINEUP-2026-09-14.md`. The owner named “GenStudio KH — continued” and explicitly corrected the use of GitHub for coordination. Issue 154 was closed. No direct cross-session messaging tool is exposed here; acknowledgement is pending. The handoff identifies the post-retirement contract gap: absent old rows need authoritative aliases or a successor lookup; Story does not invent that mapping.

## Verification checkpoint — 2026-09-14

Owner quit Pinokio and resolved the diagnostic-process exhaustion. No Story or GenStudio process was stopped. Implementation and review fixes are complete in the isolated `codex/llm-lineup` worktree; release version is 1.4.163. The reviewed source is ready for integration; build the final DMG from canonical main after merge.

- Baseline policy tests: 22 passed (partial).
- Latest focused backend corrections: 111 tests across 8 files, 0 failures, exit 0 (`logs/llm-lineup/focused-corrections.log`). Includes queue restart/pause/cancel, child snapshot freezing, quota resets, output contracts, and timing discipline.
- Latest focused frontend: 16 tests, 0 failures, exit 0 (`logs/llm-lineup/frontend-corrections.log`). Mounted editor tests cover save/reload, disabling a retired selection and keeping a depleted saved choice while replacing another. They import the real lineup normalization utility.
- Rendered actual editor template and CSS at 1100px and 390px: no horizontal overflow; enabled ordered and disabled empty states; controls focusable. Existing model/preset child controls were mocked for the layout check. Artifacts: canonical `logs/llm-lineup-ui-visual/`.
- Independent read-only review approved the final runtime diff, including accepted-request recovery, avoiding the older paid replacement path, effective promotion ranking, future-only reset timestamps, and disabled child snapshots across nonwriting pipeline stages. No high or medium blockers remain.
- First full backend sweep completed all 474 files and 5,244 tests, exposing five failures in old call-site anchors, fixed-sleep tests and the added nonwriting leaf snapshot. All five are corrected and covered by the focused run above. This earlier sweep is not a passing release gate.
- Final full `npm run verify` passed, exit 0 (`logs/llm-lineup/verify-final.log`): backend 5,245/5,245 tests across 474/474 files; frontend 1,816/1,816 across 198/198; release 36/36 across 4/4; Content Packs 366 passed, 2 skipped, 0 failed across 38/38 files. Lint had 0 errors (1,904 warnings); both typechecks, changelog, typography, model-drift, production-security, desktop contract and production builds passed. Git diff whitespace check passed. GitHub Actions was confirmed disabled; no hosted compute used. Integration and canonical `npm run dist:smoke` are the final release steps.

Customer project data was byte-identical after the backend runs. No paid generation, live upload, data deletion, installation, deployment or provider changes were used for testing.

## Remaining provider dependency

Fresh shared-lineup jobs follow a published successor during its retirement warning. Story cannot identify a successor once an old catalogue row disappears without a published alias or mapping. Shared quota-pool identities are likewise used only if authoritative metadata becomes available; this version uses account/product holds. The local GenStudio handoff is pending acknowledgement; this does not prevent Story's product-level lineup from working.
