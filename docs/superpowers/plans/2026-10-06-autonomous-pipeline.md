# Autonomous Pipeline repair plan

> **For agentic workers:** Use subagent-driven development with root-owned test execution, independent review and integration. Workers do not commit or publish.

**Goal:** Start large episode batches promptly and finish recoverable scene-prompt/image gaps without repeated manual repair.

**Architecture:** Keep the existing Story → Gateway → Hub boundary. Reuse request-scoped project facts and completion receipts, preserve durable provider identities, and repair only missing artifacts.

**Tech stack:** Existing TypeScript/Express/Nuxt code and Node test fixtures; no dependencies.

**Spec:** Owner's October 6 request and the bounded design explained in chat; screenshots/status log for TN0294 confirm Story 1.4.254, 34/339 images saved, 174 prepared-request mismatches and a ten-minute stall hold. Source base dcea61ad.

## Global constraints

- No live generation, paid provider calls, production mutations or app restart during diagnosis and isolated verification.
- Story calls only the Gateway. Keep model limits and capabilities live and authoritative.
- Preserve valid prompts/images and project presets; never repair by rewriting customer data blindly.
- A required incomplete stage cannot report success or advance dependent stages.
- Pause/cancel and unresolved provider acceptance must never turn into duplicate submission.
- Keep Start's fresh validation; optimize repeated work inside a request rather than trusting an old dialog result.
- All removals go to project `_trash`; graph/build artifacts stay outside Git.
- One test suite at a time, run by root. Final application release is committed/pushed to main with versioned DMG in main's dist.

## Review focus

- Configuration or episode state changed between opening the dialog and pressing Start remains freshly validated.
- Large mixed batches preserve eligibility, blockers, episode ordering and optional-step semantics.
- Token-truncated prompt output preserves only complete, valid, requested rows; malformed/foreign IDs never count.
- An accepted or uncertain provider request is recovered by its durable identity before any replacement.
- Manual pause/cancel remains authoritative while autonomous progress and retry continue.

### Task 1: Bulk startup

**Own:** `electron/server/routes/pipeline.ts` and focused bulk-cost test.

- [ ] Write failing operation-count/behavior fixture for repeated project/status work.
- [ ] Root runs RED; implement request-scoped facts reuse, strict status-cache reads and bounded independent episode work.
- [ ] Reuse unchanged completion evidence only after strict disk/config validation at admission; retain fresh Start preflight and all validation.
- [ ] Root runs focused GREEN and reviews caller/eligibility semantics.

### Task 2: Scene prompt completion

**Own:** `electron/server/generators/scene-plan.ts`, `electron/server/__tests__/scene-prompt-auto-repair-generator.test.ts`.

- [ ] Write failing truncated-output and progress-repair cases; root runs RED.
- [ ] Salvage complete valid rows from `GenStudioChatIncompleteError.partialText` through existing parser/checkpointer.
- [ ] Ordinary automatic repair continues through decreasing missing counts, tolerates two consecutive settled no-progress passes, and stops on unresolved requests. Keep existing grouping and explicit paid-repair contracts.
- [ ] Root runs focused GREEN; prove no duplicate complete rows, no unresolved replacement POST, cancellation and final fail-closed audit.

### Task 3: Scene image recovery

**Own after confirmed root cause:** image generator/recovery files and focused tests; retry policy/test only if required. No overlap with Tasks 1–2.

- [ ] Trace prepared-request mismatch against every shared manifest caller and reproduce with a fixture.
- [ ] Root runs RED; fix the source of identity mismatch without weakening saved-payload validation.
- [ ] Verify recoverable free-image failures and automatic holds can continue without losing valid images, duplicating uncertain work or overriding manual pauses.
- [ ] Root runs focused GREEN and reviews manifest ownership/state transitions.

### Integration and release

- [ ] Independent whole-diff review, resolve findings and verify full source gates; run the artifact-dependent release lane after the main build.
- [ ] Update changelog, both version manifests and handoffs with verified behavior and remote-access limitation.
- [ ] Commit/integrate through `land/<version>-into-main`, push main, build/verify DMG from main.
- [ ] Refresh code-only graph and preserve worktree/report history in `_trash` when finished.
- [ ] Verify mini after access is restored; no production install/restart while ongoing work would be interrupted.

Installer-test safety is part of release verification: every installer invocation uses a copied
script in a private temporary project with private source, target and trash. A temporary target
alone does not isolate the owner's archive. Local coordinator records carry release completion
and the separate recovery incident status.
