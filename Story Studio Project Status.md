# Story Studio Project Status

Updated: **2026-09-22** (takeover revision). Owner: Veng Theng.
Implementation, review and technical acceptance: the owner-operated **DeepSeek lead session**
(a single writer; no spawned agents). The lead session is developer, architect, investigator,
implementer, reviewer, tester and project-status owner. It plans, prioritizes, expands scope when
current-source tracing proves it necessary, verifies, and flows into the next unblocked packet
without waiting for an external assigner.

## Start here

**Takeover in effect (2026-09-21).** The lead session works the stabilization queue directly. There is no
separate orchestrator gate: DS-01 through DS-17b and X-01–X-06 were verified and accepted by the lead
session, DS-12 produced three rendered fixes, and **ACCEPT-01 is closed as self-accepted** (the owner's
item 6 — a full two-episode walkthrough on a disposable Library against the repository's own mock gateway,
zero paid submissions; it found and fixed `NEW-12` and `NEW-14` and reproduced `NEW-13`). Everything in the
objective's queue is therefore either complete or blocked on an owner decision, and the remaining decisions
are named here:

- **Release 1.4.218 (prepared, not landed):** the tree is at 1.4.218 with a What's New entry for the two
  fixes and all record guards passing; `main`/`origin/main` are still at `1c98f069` (1.4.217), and the
  installed app is 1.4.217. Landing, building a DMG and installing it are one owner decision.
- **`X-07`:** one real paid generation needs the model and the hard credit ceiling agreed and written down
  first. Nothing has been called.
- **Open findings:** `NEW-13` (the episode-status cache never watches the external final-video root —
  reproduced, fix direction recorded), `NEW-11` (packaging rewrote the checkout manifest once; now blocked
  by a restore guard in both build scripts, culprit step unidentified), `NEW-08` (external: a private
  Content Pack is registered without its source directory).

Base for the takeover: `6f3c4e3316854b5eb9bf6100f078064254f61445` on `main`.
Working branch: `codex/stabilization-takeover` @ `1f82a38f`; `main` and `origin/main` are at `1c98f069`
and already carry the 1.4.216 and 1.4.217 work. The branch also carries the other effort's content-packs
commit `8051fc28`, deliberately not in `main` because it fails four content-pack guards.
Checkout: `/build/Developer/story-studio-kh`.
Inherited uncommitted work is preserved and recorded, never reset, stashed, rebased or discarded.
**Version is 1.4.218 (prepared, uncommitted):** the two fixes, the acceptance driver and the release guard
are uncommitted on the branch; the 1.4.217 DMG exists at `dist/Story Studio KH 1.4.217-arm64.dmg` and the
installed app is 1.4.217.

**Goal:** stabilize existing behavior, not redesign the app or implement every historical allegation.
**Approach:** reproduce one bounded concern, trace its callers, make the smallest complete repair
only if needed, leave runnable regression evidence, and return the diff for independent review.
**Stack:** Electron, TypeScript/Express backend, Nuxt/Vue frontend, local FFmpeg.
**Requirements:** [AGENTS.md](AGENTS.md), the packet below, and the owner's current instructions.
Workers use the applicable debugging/testing/execution skills inline; this workflow does not spawn agents.

### Current truth versus history

- **Current execution status:** this file. The lead session updates packet/candidate rows, appends
  reports, and records its own technical acceptance explicitly as **self-acceptance**. It does not
  claim independent human or independent-agent review. Integration/public release remain separately
  authorized actions.
- **Candidate evidence:** [89-row audit inventory](docs/audit/2026-09-20-candidate-status.md).
  Keep its stable IDs; do not rewrite historical evidence to make a new result look older.
- **Completed baseline:** [local release acceptance](docs/handoffs/2026-09-21-local-release.md).
  Its final release evidence supersedes older “integration pending” notes in the audit/workflow log.
- **Other allegations:** [candidate appendix](docs/audit/2026-09-20-candidate-appendix.md) and
  [historical FIX-PLAN](docs/audit/FIX-PLAN.md). These are leads, not instructions to blindly implement.
- **Owner bug intake:** [owner-reported bugs](docs/audit/owner-reported-bugs.md). The owner drops
  plain-language reports there at any time; the lead session triages each into an existing candidate,
  a new `NEW-###`, or a `DS-XX` packet, and never deletes a closed entry. Read this file at session
  start alongside the queue below — it is the durable answer to "I found another bug".
- **Reusable worker prompt:** [DeepSeek orientation](docs/handoffs/deepseek-worker-prompt.md).

## Verified baseline — not exhaustive stabilization

- [x] Reviewed repair release **1.4.213** integrated; current main includes the subsequent evidence-only merge.
- [x] Official main-built unsigned arm64 DMG verified; app installed at `/Applications/Story Studio KH.app`.
- [x] Prior completed full lanes: **7,858 tests, 7,855 passed, 0 failed, 3 explicit skips**.
  These are recorded results for that release, not a fresh run on future changes. The original
  combined `npm run verify` failed; corrected lanes/build later passed separately.
- [x] Owner chose fresh setup, then a Library for **development/testing on this Mac**.
  Real channel data is not on this computer; no old-data migration is required.
- [ ] Complete the remaining stabilization acceptance below. No “all bugs fixed” claim is justified.

The historical inventory has **25 source-confirmed, 24 focused-green, 30 open, 2 partial,
1 duplicate, 3 dormant and 4 retracted** rows (89 total). “Open” is an unverified concern,
not a confirmed defect. Source inspection, focused tests, rendered checks and full release gates
prove different things. Do not add these categories together as a count of bugs fixed.

## Working contract

1. **One writer and one test lane.** The lead session works one packet at a time and continues to the
   next unblocked packet without asking. No concurrent sessions editing shared files. A new session
   resumes existing work rather than restarting it. No recursive delegation or spawned agents. One
   suite runs at a time across this computer.
2. **No speculative repairs.** Read the historical allegation and current callers. Reproduce with
   a failing behavior assertion, not a fixture/setup failure. If the contract already passes,
   return `not-reproduced` with positive controls and evidence; no token patch is required.
3. **Skills:** use Ponytail and Graphify; use Impeccable for UI/visual work and applicable Superpowers
   debugging, tests and verification skills. Read their actual instructions. Missing tools/skills
   must be reported, not pretended. Direct inspection is the Graphify fallback.
4. **Safe fixtures:** use `mktemp -d` or a uniquely named test project in the selected dev Library.
   Resolve and record its actual path first. Never infer a Library path from the repository path.
   Do not wipe the Library, checkout, presets, or unrelated data. Delete only exact fixtures created
   by this run, after workers/timers have stopped; retain evidence when cleanup cannot be proved safe.
5. **Local mocks first.** No paid generation, real uploads, purchases, public publication, deployment,
   secret extraction or authentication/ownership bypass. Use local fake providers and signed test
   fixtures. Missing external authority is a blocker for that check, not permission to invent success.
6. **Preserve contracts.** Live catalogue authority; provider display never dispatch; per-episode
   ownership; deliberate preset exceptions; explicit unknown/error states; authoritative completion;
   recovery without duplicate paid work; no retired features. Read AGENTS.md, not just this summary.
7. **Scope boundaries:** listed source files are the packet's initial edit allowance, plus directly
   corresponding tests, its report, and its status rows. Read other files freely. If a root-cause
   fix requires another production file or a contract/product change, report the exact expansion
   needed before editing it. Do not fix adjacent findings; record new `NEW-###` entries for triage.
8. **No commits/pushes/merges/releases by the worker.** Leave a reviewable diff. Do not enable GitHub
   Actions. Do not build/install a DMG or restart the user's installed app as an incidental test.
   An isolated test/dev instance is permitted; identify its backend and version before testing.
9. **Release metadata:** documentation/test-only evidence does not require an app release. If the
   packet changes shipped runtime behavior, include a patch version bump in both package files
   and a matching newest-first CHANGELOG entry in the same pending change set. For DS-01, if the
   assigned base is unchanged, reserve **1.4.214**. If already changed, report the conflict; do not
   independently invent another version. Later assignments reserve their own version. Do not
   regenerate unrelated lockfile dependencies. Run `npm run check:changelog`.
10. **Self-review before self-acceptance.** A packet is accepted only after the lead session runs a
    separate review pass over its own complete diff, reproduces the RED half of a red-green cycle where
    a repair is claimed, and records the result as **self-review/self-acceptance**, never as
    independent review. Failed or skipped checks stay visible. "Fixed" is not claimed for a blocked or
    partially verified issue.

### Graph navigation on this Mac

An existing code-only graph lives in
`/build/.codex/worktrees/story-studio-kh-recovery/story-studio-kh/graphify-out/`.
The CLI is `/build/.local/share/uv/tools/graphifyy/bin/graphify`.
Query from that worktree if available; check `.graphify_python` first. Its source locations are
navigation leads, **not proof about this checkout**. Verify every lead against current source.
At preparation, a 500-token-budget query for cancellation/recovery found `cancellationControlFor`,
`classifyJobControls`, `loadPersistedJobs` and their tests; no paid model extraction was used.
The CLI reported a skill/package version mismatch; no installation change was made.
Keep graphs out of Git and exclude credentials, Library data, transfers and backups. Update a
code-only graph after structural changes when available; never trigger paid extraction or a large
visualization just to satisfy this checklist. No structural code change occurs in this handoff.

## Status and evidence protocol

Packet states: `queued` → `investigating` → `implementing` → `verifying` → `complete`.
Other states: `blocked`, `changes-requested`, `deferred`, `not-reproduced`. A packet can return to
`in-progress` after review.
Per-issue outcomes: `reproduced-fixed`, `already-correct`, `not-reproduced`, `partial`, `blocked`,
`duplicate`, `deferred-owner-decision`.

- At start, record session, date, base SHA, initial dirty files, exact owned files and test-lane use.
- Update after meaningful progress and **before ending the session**, even if blocked.
- Use `complete` only when the packet's proof is complete; otherwise use `blocked` or leave an exact
  resume point. Do not call an interrupted test a failure or a pass.
- Link `docs/handoffs/deepseek-reports/DS-XX.md` from the packet row. Create that report with the
  template below. Later attempts append dated sections; preserve earlier RED/failure/review evidence.
- **The lead session checks the acceptance box** after a separate self-review pass over its own diff
  and records accepted base/diff, independent-style checks and disposition. `accepted` may mean a
  well-proved non-bug; it does not necessarily mean code changed. This is recorded as self-acceptance,
  never as independent human or independent-agent review.
- Do not auto-close other IDs because one shared test passed. List the IDs each assertion actually proves.
- When blocked, name the smallest missing input, scope expansion, environment capability or product
  decision, say what is still safe to do, and do not repeat risky retries.

## Packet queue

Packets are worked in reproduced-severity and dependency order, keeping integrity and
duplicate-charge risks first. Each scope card is a bounded investigation/repair brief, not a
preselected implementation; the lead session may expand production-file scope when current-source
tracing proves the root cause requires it, recording the reason and revised owned files before
editing. Split a packet when reproduction shows it is too large. The lead session continues to the
next unblocked packet without asking whether to proceed.

| Accepted | Packet | Scope | State | Session / report |
|---|---|---|---|---|
| [x] | DS-01 | H-16: missing-key cancellation/reconciliation | complete | DeepSeek lead; `DS-01.md` |
| [x] | DS-02 | H-17: restart and duplicate paid-work admission | complete | DeepSeek lead; `DS-02.md` |
| [x] | DS-03 | S-04: cross-episode audio model ownership | complete | DeepSeek lead; `DS-03.md` |
| [x] | DS-04 | S-06: episode-switch failure/race matrix | complete | DeepSeek lead; `DS-04.md` |
| [x] | DS-05 | Q-02: skipped Pipeline step preserves persisted state | complete | DeepSeek lead; `DS-05.md` |
| [x] | DS-06 | H-13: caption-mode degradation honesty | complete | DeepSeek lead; `DS-06.md` |
| [x] | DS-07 | Q-04, E-11: reconnect and queue-state uncertainty | complete | DeepSeek lead; `DS-07.md` |
| [x] | DS-08 | Q-06–Q-10, F-11: Jobs admission, labels, links and empty states | complete | DeepSeek lead; `DS-08.md` |
| [x] | DS-09 | E-01, E-02, E-06: workspace read failures (subset) | complete | DeepSeek lead; `DS-09.md` |
| [x] | DS-09b | E-03, E-10: Introduction read failure + Scene Plan delete empty state | complete | DeepSeek lead; `DS-09b.md` |
| [x] | DS-10 | E-04, E-05, E-07–E-09: media read/loading failures | complete | DeepSeek lead; `DS-10.md` |
| [x] | DS-11 | F-04, F-05: Settings status/hydration | complete | DeepSeek lead; `DS-11.md` |
| [x] | DS-12 | F-12–F-15: geometry, CSS and keyboard reachability | **complete — rendered harness built, three layout defects fixed and re-measured; F-12 remains fixture-blocked** | DeepSeek lead; `DS-12.md` |
| [x] | DS-13 | Q-03: measure persistence/SSE cost before optimization | complete | DeepSeek lead; `DS-13.md` |
| [x] | DS-14 | M-08: model-drift guard fixture coverage | complete | DeepSeek lead; `DS-14.md` |
| [x] | DS-15 | X-01: active audio versus script freshness investigation | complete | DeepSeek lead; `DS-15.md` |
| [x] | DS-16 | X-02–X-05: reconcile historical leftovers and evidence limits | complete | DeepSeek lead; `DS-16.md` |
| [x] | DS-17 | NEW-05, NEW-06, NEW-07: Content Store copy, gateway default, provider display | complete | DeepSeek lead; `DS-17.md` |
| [x] | WIRE-01 | Gateway ask 1: `font_pack`/`lettering-style` delivery→prompt bridge | complete | DeepSeek lead; `WIRE-01-font-pack-bridge.md` |
| [x] | WIRE-02 | Gateway ask 2: `metadata_formula` wire kind (owner-accepted) | complete | DeepSeek lead; `WIRE-02-metadata-formula-kind.md` |
| [x] | WIRE-03 | Free-form "custom" lettering text reaches the prompt | complete | DeepSeek lead; `WIRE-03-custom-lettering-text.md` |
| [x] | SMALL-01 | NEW-01, NEW-02, NEW-03, NEW-04, NEW-10: the small-fix list | complete | DeepSeek lead; `DS-17b-small-fixes.md` |
| [x] | PING-01 | Ping gateway-kh when the 1.4.216 DMG exists (their step 1–4 hold) | complete | DeepSeek lead; `_handoffs/2026-09-22_story-ping-1.4.216-dmg.md` |
| [x] | ACCEPT-01 | Cross-workflow dev-Library acceptance | **complete (self-acceptance) — all in-scope legs exercised on a disposable Library with fake provider outputs; the only unexercised items are external by construction (real paid generation `X-07`, real upload, signed/notarized distribution `RELEASE-01`). Found and fixed `NEW-12` + `NEW-14`; reproduced `NEW-13`** | DeepSeek lead; `ACCEPT-01.md` |
| [ ] | RELEASE-01 | Review, full gates, integration, main-built installer | queued | DeepSeek lead; commit/publish externally gated — **work committed `498c19cc` and pushed to `origin/codex/stabilization-takeover` (2026-09-22); integration into `main` and the main-built installer still open** |

### DS-01 — missing-key reconciliation (H-16) — **accepted (self-acceptance)**

**Deliverable:** a reproducible missing-credential lifecycle result, minimal repair, focused
regression evidence and a report. Not a general queue rewrite.

**Owned production files (as worked):** `electron/server/services/job-queue.ts`.
**Owned test files (as worked):** new `electron/server/__tests__/job-cancellation-missing-key.test.ts`
(the shared temp data dir in `job-cancellation-reconciliation.test.ts` made a missing-key case there
order-dependent).
**Release metadata:** `package.json` / `package-lock.json` → **1.4.214** and a matching newest-first
`CHANGELOG.md` entry.

**Disposition:** `reproduced-fixed`. The keyless branch appended the same waiting line and rewrote
`jobs.json` once per 5s tick indefinitely. The repair reuses the function's own last-8 dedupe idiom
so the unchanged fact is stated once and no write happens while nothing changes; the 5s cadence is
deliberately preserved because it is how a later key save is noticed. No claim is consumed, no
generation is sent, and the duplicate lock is unchanged.

**Evidence (lead-session verification on `codex/stabilization-takeover`):**
- GREEN `node scripts/testing/run-backend-tests.mjs --only job-cancellation-missing-key --only job-cancellation-reconciliation` → exit **0**; tests 35, pass 35, fail 0, skip 0; `2/2 file(s) completed, 35 test(s) + 0 suite(s) = 35 marks`; PARTIAL RUN banner present (not the release gate).
- RED independently reproduced by the lead session: temporarily reverting only the dedupe guard → exit **1**; `AssertionError: the same waiting fact was restated 4 times / 4 !== 1`; then the guard was restored byte-identically (sha256 `b9e0082c…`). This independently confirms the test catches the defect.
- Prior worker evidence (self-review only): `npm run check:changelog` exit 0; `npm run typecheck:electron` exit 0; `git diff --check` exit 0. Not rerun by the lead session.
- Full report: [`docs/handoffs/deepseek-reports/DS-01.md`](docs/handoffs/deepseek-reports/DS-01.md).

**Recorded follow-up:** `NEW-01` — while the key is missing, the primary Jobs cancellation control
still renders generic "Checking cancellation…" copy without naming the missing key; the actionable
wording exists only in `output_lines`. Route to the Jobs presentation packet (DS-08).

**Non-claims:** real-timer observation (3 × 5s), not a fake clock; no full backend lane, no build,
no live provider call. `job-cancellation-reconciler.ts` was listed as owned but required no change.

### DS-02 — restart lifecycle and duplicate paid-work admission (H-17) — **accepted (self-acceptance)**

**Objective:** prove whether a crash-interrupted `scene_plan_run` / `metadata` / `image_prompts` /
`research_run` becomes an honest recovery state, whether durable provider evidence survives a real
boot reload, and whether duplicate work can be admitted.

**Disposition:** `reproduced-fixed`. The stale half of the historical claim was disproven: a
restarted job carrying *unsettled* durable provider evidence is already routed to read-only
reconciliation (no generation POST, duplicate lock retained) rather than failed. The reproduced
defect was downstream: `finalizeSettledProviderJob` had no terminal path when the provider settled
but the job's type has no registered completion auditor, so `metadata` / `image_prompts` /
`research_run` stayed `running` forever with no reconcile timer and no Retry. The repair fails
loudly with an honest repair/Retry error, retains the provider evidence, and sets
`provider_settled`/`repair_required`; the live-executor boundary is untouched.

**Evidence (lead-session verification on `codex/stabilization-takeover`):**
- RED `node scripts/testing/run-backend-tests.mjs --only job-restart-paid-evidence` → exit **1**; tests 6, pass 3, fail 3 (exactly the three unregistered types); both controls passed.
- GREEN same command → exit **0**; tests 6, pass 6, fail 0.
- Affected regression (`--only job-queue --only job-cancel --only job-control --only job-evidence-placeholder-recovery`, bundled ffmpeg on PATH) → exit **0**; tests 238, pass 238, fail 0; `14/14 files, 238 tests + 32 suites = 270 marks`. PARTIAL RUN (not the release gate).
- `npm run typecheck:electron` exit 0; `npm run check:changelog` exit 0; `git diff --check` exit 0.
- Full report: [`docs/handoffs/deepseek-reports/DS-02.md`](docs/handoffs/deepseek-reports/DS-02.md).

**Recorded follow-ups:** `NEW-02` — several text job types still have no completion auditor, so a
settled provider task becomes an honest error rather than a verified done (bounded, needs per-type
output contracts). `NEW-03` — backend tests on this Mac need `bundled/ffmpeg` on PATH or
ffmpeg-dependent tests fail with `ENOENT` (pre-existing, confirmed by reverting only this fix).

**Non-claims:** no full backend/frontend/release gate, no build, no live provider call.

### DS-03 — cross-episode audio model ownership (S-04) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed`. `getAudioStatus`'s legacy history borrow used
`audioJobs[0]` — the most recent audio job of *any* episode — so a project whose episodes were voiced
with different models predicted 12 `_partN` filenames for an episode another model renders whole.
The borrow now uses this episode's own job, and falls back to a project-wide model only when the
retained history names exactly one model; conflicting history resolves no model and expects the
section whole (the same honest answer as no history).

**Evidence (lead-session verification on `codex/stabilization-takeover`):**
- RED `node scripts/testing/run-backend-tests.mjs --only audio-tts-model-record` → exit **1**; tests 7, pass 6, fail 1 (cross-model case; own-job and single-model controls passed).
- GREEN same command → exit **0**; tests 7, pass 7, fail 0.
- Affected audio regression (`--only audio- --only task7-audio-readiness --only task14-audio-measurement-boundaries`, bundled ffmpeg on PATH) → exit **0**; tests 117, pass 117, fail 0; `28/28 files, 117 tests + 8 suites = 125 marks`. PARTIAL RUN.
- `npm run typecheck:electron` exit 0; `npm run check:changelog` exit 0; `git diff --check` exit 0.
- Full report: [`docs/handoffs/deepseek-reports/DS-03.md`](docs/handoffs/deepseek-reports/DS-03.md).

**Non-claims:** no full gates, no build, no live provider call. The deliberate single-model legacy
borrow is preserved.

### DS-04 — episode-switch failure and out-of-order-response matrix (S-06) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` (one page) + `already-correct` (six pages). Current source
already blanks the named episode-owned fields for `broll`, `scene-review`, `images`, `research`
(existing static tests), `motion-review` (`resetEpisodeScopedMotionState`) and `metadata` (v1.4.194
watcher). The remaining gap was `character-sheet.vue`: its watcher reset the existence flags but left
`config` (anchors, pacing, references) live until the awaited `loadConfig()` resolved. The repair
blanks `config` synchronously on the episode change; `characters` stays because it is the
channel-level library, not episode state.

**Evidence (lead-session verification):**
- RED (fix temporarily reverted) — `frontend/`: `../node_modules/.bin/tsx --import ./__tests__/setup.ts --test ./__tests__/episodeScopedStateReset.test.ts` → exit **1**; tests 7, pass 6, fail 1.
- GREEN (fix restored byte-identically, sha256 `024a11e0…`) → exit **0**; tests 7, pass 7.
- Related frontend regression (6 files incl. `characterSheetWorkspace`, `motionReview`, `episodeSelectorFocusLoad`, `workflowEpisodeContinuity`, `continuityPresetPacing`) → exit **0**; tests 58, pass 58, fail 0.
- `npm run check:changelog` exit 0; `git diff --check` exit 0.
- **Not green:** `npm --prefix frontend run typecheck` exit **2**, 11 pre-existing errors in files this packet did not modify (`NEW-04`). Static source analysis, not rendered DOM proof.
- Full report: [`docs/handoffs/deepseek-reports/DS-04.md`](docs/handoffs/deepseek-reports/DS-04.md).

### DS-05 — skipped Pipeline step and persisted Character Sheet state (Q-02) — **accepted (self-acceptance)**

**Disposition:** `already-correct` (proved by checks); no production change. The inline
`character_sheet` write happens after the idempotency filter, so an already-complete step leaves
`continuity.json` byte-identical. When a later step aborts the episode (duplicate guard etc.), the
selected character-sheet work still applies, but the response's `character_sheets_applied` count is
rendered in the Pipeline receipt beside the skip reasons — so it is announced, not silent. The
historical "the skip reason never mentions it" wording is stale.

**Evidence:** two cases added to `pipeline-step-skip.test.ts`; `--only pipeline-step-skip` exit **0**,
tests 31, pass 31, fail 0. PARTIAL RUN. Report:
[`docs/handoffs/deepseek-reports/DS-05.md`](docs/handoffs/deepseek-reports/DS-05.md).

**Residual (recorded, not a defect):** the per-episode `skipped[].reason` does not repeat the
character-sheet attribution; only the batch-level count carries it.

### DS-06 — unsupported animated/word caption degradation (H-13) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed`. Both assemblers already fell back from the ASS document to
`force_style` when it could not be built, but only logged the loss; `result.degraded` stayed empty,
so a render missing the requested captions reported a clean `done`. `contracts/subtitle-style.ts`
even exported `requiresAssDocument` "so the legacy force_style fallback knows it is lossy" — with no
callers. Added `assOnlySubtitleFeatures(style)` and wired both fallbacks into `declareJobDegraded`
with the dropped features. Status stays `done`/`complete`; the usable file is kept.

**Evidence:** RED via the wiring guard (declarations temporarily removed, files restored
byte-identically) exit 1, 8/9; GREEN `--only job-degradation --only subtitle-ass` exit 0, 23/23;
affected regression `--only job-degradation --only subtitle --only broll --only video` exit 0,
534/534, `41/41 files`. `typecheck:electron`/`check:changelog`/`git diff --check` exit 0. Report:
[`docs/handoffs/deepseek-reports/DS-06.md`](docs/handoffs/deepseek-reports/DS-06.md).

**Limitation:** the RED is a source-wiring guard plus pure-helper/composition tests, not an
end-to-end render (needs ffmpeg + media). `caption line wrapping` is now declared for every fallback
because `force_style` always ignores it.

### DS-07 — SSE failures, polling fallback and queue-state uncertainty (Q-04, E-11) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` for both. Q-04's concrete gap: the **app-wide** `/jobs/app/stream`
hand-rolled `send`, swallowed a failed snapshot into `console.error`, and subscribed to updates
before reading the snapshot — while both sibling streams use `createBufferedJobStream` +
`sendSnapshotError()`. The route now matches them. The one-way SSE→10s polling fallback is
deliberate, documented, and still converges to fresh state (stale responses are guarded by
`transportEpoch`/`stateRevision`), so no reconnect redesign was imposed. E-11: `queuePaused` is now
`boolean | null`; a failed `/system/queue/status` read clears to unknown, the paused banner requires
a known pause, and the control is disabled with an explicit "queue state could not be read" notice.

**Evidence:** backend focused `--only jobs-stream --only job-restart-paid-evidence --only no-new-wallclock-sleeps` exit **0**, 22/22; frontend focused 5 files exit **0**, 76/76 (one existing toolbar-expression expectation updated to the new intentional expression); `typecheck:electron`, `check:changelog`, `git diff --check` exit 0. Report:
[`docs/handoffs/deepseek-reports/DS-07.md`](docs/handoffs/deepseek-reports/DS-07.md).

**Limitations:** the app-route failure guard is static (ESM exports can't be mocked); E-11's guard is
static source analysis, not a mounted-page render. `NEW-03`/`NEW-04` still apply.

### DS-08 — Jobs admission, labels, links and empty states (Q-06–Q-10, F-11) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` for F-11, Q-06, Q-07, Q-08 and Q-10; Q-09 `not-reproduced`
(latent, unreachable). Four hand-maintained job-type label maps had drifted from the live 33-type
union (useJobs 6 missing, useNotifications 7, EpisodeSelector 20); they are replaced by one
authority in `utils/job-presentation.ts` with a humanizing fallback. Retry no longer offers the
legacy prompt/image modes the backend always 409s (per-row and bulk). The two permanently empty
Scene Images tabs are gone. A filter that hides a nonempty list now says "No matching jobs". The
subtitle Retry tooltip no longer names a Repair button that is not rendered. The unserved
`/jobs/all/:id/finish-missing-images` URL is unreachable today and was documented, not patched.

**Evidence:** focused frontend 7 files exit **0**, 92/92; full frontend lane exit **0**, tests 1,888,
pass 1,888, fail 0, `210/210 file(s), 2,091 marks`; `check:changelog` and `git diff --check` exit 0;
frontend typecheck still the same 11 pre-existing `TS2558` errors, none in a changed file (`NEW-04`).
Report: [`docs/handoffs/deepseek-reports/DS-08.md`](docs/handoffs/deepseek-reports/DS-08.md).

**Found and fixed en route:** `jobsRetryAllManualFinish.test.ts` compiles `jobs.vue` against a
hand-written stub preamble; the label refactor left four names unresolved, which hung the frontend
lane's isolation child. The preamble now binds the real functions; that file passes 11/11 and exits.
No backend file changed, so the DS-07 full-backend result still stands for the backend suite.

### DS-09 — workspace read failures versus empty states (E-01, E-02, E-06) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` for E-01, E-02 and E-06; **packet split** — E-03 and E-10 moved to
DS-09b (below). Scene Review now keeps a read failure distinct from "No scene plan yet" and offers a
retry; Research reports "could not check GenStudio access" instead of claiming the API is
unconfigured; Pipeline reports "could not load accepted ideas" instead of "No accepted ideas yet".
No failed read writes or clears anything on disk, and Research still cannot start a paid run without a
confirmed configuration.

**Evidence:** RED against the three pages at `HEAD` (restored byte-identically afterwards): 0 pass,
3 fail. GREEN `workspaceReadFailures` + all sceneReview*/research*/pipeline*/optionalStageHonesty
(15 files): exit **0**, tests 114, pass 114, fail 0. Full frontend lane exit **0**, tests 1,891, pass
1,891, fail 0, `211/211 file(s), 2,094 marks`. `check:changelog` and `git diff --check` exit 0;
frontend typecheck unchanged at the 11 pre-existing errors (`NEW-04`). Report:
[`docs/handoffs/deepseek-reports/DS-09.md`](docs/handoffs/deepseek-reports/DS-09.md).

**Limitation:** source-analysis checks, not a mounted render.

### DS-09b — Introduction read failure and Scene Plan delete empty state (E-03, E-10) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` for both. `channelIntroEnabled` is tri-state on `pipeline.vue` and
`audio.vue`; a failed `/segments` read now shows an honest "could not check" warning with Retry and a
link to Introduction, keeps the pre-spend warning, and only a **known-true** channel includes the
Introduction step. The Scene Plan section is gated on `plan || planning`, so deleting a plan (which
clears `plan` but not the disk-derived `status.scene_plan`) no longer leaves a heading-only card; the
no-plan card gained a **Build the plan** action.

**Evidence:** RED against `audio.vue`/`scene-plan.vue` at `HEAD` (3 pass / 2 fail), restored
byte-identically; GREEN `workspaceReadFailures` 5/5; affected regression 18 files, 112/112 exit 0;
full frontend lane exit **0**, 1,895 pass, `211/211 file(s)`; `check:changelog` (1.4.216) and
`git diff --check` exit 0; frontend typecheck unchanged at the 11 pre-existing errors (`NEW-04`).
Report: [`docs/handoffs/deepseek-reports/DS-09b.md`](docs/handoffs/deepseek-reports/DS-09b.md).
**Limitation:** source-analysis checks, not a mounted render. No DMG yet — accumulates into 1.4.216.

### DS-10 — media read/loading failures (E-04, E-05, E-07, E-08, E-09) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` for all five. Each is the AGENTS.md §6 shape — "I could not work
out the answer" rendered as "the answer is none", four of them with no way to retry. Step 1 of Video
Assembly now shows a visible failed-asset-check banner with **Retry asset check** (the composable
carries `scanError`) instead of a blank step over a toast; the transition catalogue tracks loading,
failure and empty separately, so a rejected read clears loading and offers **Retry** rather than
sitting on "Loading transitions…" forever; Step 5 tracks the subtitle-status read with loading and
failure branches, and the "No subtitle file for this episode yet" claim is gated on a completed read
for a real episode, with a failed read left explicitly unknown and retryable; the Subtitles page
distinguishes a failed status read from missing chapter audio and offers **Retry**; and the chapter
selector distinguishes a failed scan from "No sections found. Generate the script first." with
**Retry**. A failed read never clears a genuine value, and the render payload still carries no
browser-authored scene list, so a last-valid asset display can never authorize stale input.

**Evidence:** RED established by base-commit absence of every identifier/branch the new tests assert
(all seven `grep -c` at `HEAD` returned 0) plus two behavioural `scanAssets()` cases; GREEN
`videoAssemblyReadFailures` 7/7 exit 0; affected regression 24 files, 251/251 exit 0; full frontend
lane exit **0**, 1,902 pass, `212/212 file(s), 2,105 marks`; `check:changelog` (1.4.216) and
`git diff --check` exit 0; frontend typecheck unchanged at the 11 pre-existing `NEW-04` errors
(the two in `video-assembly.vue` are pre-existing `$fetch<…>` calls, 2 at `HEAD` and 2 now).
Report: [`docs/handoffs/deepseek-reports/DS-10.md`](docs/handoffs/deepseek-reports/DS-10.md).
**Limitation:** source-analysis checks for the page halves (not a mounted render), and RED for this
packet rests on the base-commit absence check rather than a restored byte-identical file swap. No DMG
yet — accumulates into 1.4.216.

### DS-11 — Settings FFmpeg status + competing category writers (F-04, F-05) — **accepted (self-acceptance)**

**Disposition:** `reproduced-fixed` for both. **F-04:** the FFmpeg card lives in the Files &
maintenance tab, but `refreshFfmpegStatus()` was called only from `onMounted`/`#ffmpeg`, never from
the tab watcher, so entering the tab by click rendered an **expanded one-click recovery download**
for a status the app had not read; and the catch wrote `{ installed: false }`, turning a failed check
into "Not installed". Entering the tab now probes `/ffmpeg/status` while the answer is unknown, a
failed check is an explicit unknown with **Retry check**, and both the installer and the manual
fallback require a real status. **F-05:** `category_id` lives on ProjectConfig, but the project-meta
watcher blanked it on every `project` replacement, and `loadProject()` fetches meta and config **in
parallel** — whenever meta resolved after config the hydrated category was wiped and the next
Publishing save persisted that silent clear. The project watcher no longer touches it; the
per-project reset moved to the slug watcher (the only event that means a different project is on
screen) and a same-project refresh now preserves both the saved value and an unsaved deliberate
change.

**Evidence:** RED by restoring `settings.vue` from `HEAD` (tests 4, pass 1, fail 3, exit 1) and
restoring it byte-identically (sha256 `3c5238aa…` before and after); GREEN `settingsProjectLoadRuntime`
4/4 exit 0; affected regression 9 settings files 56/56 and the 8 remaining `settings.vue` readers
124/124, exit 0 both; full frontend lane exit **0**, 1,905 pass, `212/212 file(s), 2,108 marks`;
`check:changelog` (1.4.216) and `git diff --check` exit 0; frontend typecheck unchanged at the 11
pre-existing `NEW-04` errors (none in `settings.vue`).
Report: [`docs/handoffs/deepseek-reports/DS-11.md`](docs/handoffs/deepseek-reports/DS-11.md).
**Limitation:** the runtime harness renders `h('main')`, so the card's template branches are
source-pinned; a mounted screenshot remains for `RELEASE-01`. No DMG yet — accumulates into 1.4.216.

### DS-17 — gateway Content Store copy + gateway default + provider display (NEW-05, NEW-06, NEW-07) — **accepted (self-acceptance)**

Shipped together as **1.4.215** at the owner's request (the provider display was reported urgent).
`NEW-05` and `NEW-06` were recorded for the next build; `NEW-07` was reported while connecting the
owner's video Mac and folded into the same build rather than deferred.

**NEW-07 — the Jobs model row now names the provider (§2).** The gateway publishes `provider_name`
per model and Story Studio's backend already returns it on every catalogue endpoint, but
`GenStudioDisplayCatalogEntry` dropped the field and the Jobs tag showed only the model name.
`buildGenStudioModelProviderEntries` + `useGenStudioModelDisplay.providerName()` now resolve it
(display only — never a dispatch input, never inferred from an id or name, absent when unpublished),
and the tag reads `Model: DeepSeek V4.1 Flash · Token Harbour`.

**NEW-05 — a disconnected Content Store is no longer reported as a bad key/URL.** The key-test probe
recognises the gateway's `503 CONTENT_STORE_NOT_CONNECTED` refusal, skips that probe, and reports
`content_store.read_scope: 'not_connected'`; the UI shows "Content Store not connected on this
gateway" instead of "check the API URL and key". The key still validates for generation.

**NEW-06 — the built-in endpoint moved to `http://127.0.0.1:8787`.** Matches the gateway the owner
moved there on 2026-09-21; the history comment was corrected and the four test files that pin the
default were updated. Saved per-Mac URLs are unchanged.

**Evidence:** backend focused `--only genstudio-voices-route --only genstudio-client-boundary
--only genstudio-content-store-client --only genstudio-content-store-delivery --only
security-host-guard` exit **0**, 143/143; frontend focused 72/72; full frontend lane exit **0**,
1,893 pass, `211/211 file(s)`; `check:changelog` (1.4.215), `typecheck:electron` and
`git diff --check` exit 0; frontend typecheck unchanged at the 11 pre-existing errors (`NEW-04`).
**Not run this turn:** the full backend lane and the full build were run for the release; the
serialized full backend gate is re-run in the release checkpoint. DMG built and verified.

### WIRE-01 — `font_pack` / `lettering-style` delivery→prompt bridge (Gateway ask 1) — **accepted (self-acceptance)**

**Disposition:** `font_pack` confirmed as the wire kind for `lettering-style`, minimum app version
**1.4.216**. The letter's diagnosis was corrected against source: install/activate is archive-manifest
driven and kind-agnostic (it already worked), and `letteringCatalogue()` already listed installed
packs since 1.4.57. The **real** gap was the runtime consumer: the synchronous thumbnail prompt
builders resolved the chosen style id against the hardcoded `FONT_STYLES`/`TEXT_STYLES` maps only, so
a bought pack style silently became the built-in serif — `letteringPhrase()` existed, exported and
never called. `letteringPhraseMaps()` now resolves the installed catalogue once per run and both
builders honour it, with built-in and unknown ids unchanged and an honest job line when the catalogue
cannot be read.

**A second defect found on the same path:** `frontend/content-store/persisted-catalog.ts` kept its own
product-kind list that had never learned `font_pack`; because the reader treats one unrecognised
product as a corrupt document, **the catalogue saved on this Mac was discarded on every load** once it
contained a font pack. The wire kinds now live in one leaf module
(`frontend/content-store/product-kinds.ts`) whose array defines the type.

**Evidence:** RED at `HEAD` for `image-prompts.ts` (4 pass / 3 fail, the three prompt assertions; file
restored byte-identically, sha256 `30070b81…`); GREEN `lettering-pack-bridge` 7/7; affected regression
22 files 219/219 exit 0; RED for the persisted-catalogue reader (16 pass / 1 fail, restored sha256
`5fc32713…`); GREEN `contentStorePersistedCatalog` + `contentStoreLibrary` 31/31; wire coverage for all
seven kinds plus the unknown-kind guard. Reports:
[`WIRE-01-font-pack-bridge.md`](docs/handoffs/deepseek-reports/WIRE-01-font-pack-bridge.md),
[`WIRE-02-metadata-formula-kind.md`](docs/handoffs/deepseek-reports/WIRE-02-metadata-formula-kind.md).
Gateway reply: `_handoffs/2026-09-22_story-response-wire-kind-parity.md`.

### WIRE-02 — `metadata_formula` wire kind (Gateway ask 2) — **accepted, owner-decided**
**Disposition:** the owner ruled that Story sells metadata-formula as a Content Store product; wire
kind **`metadata_formula`**, minimum app version **1.4.216**. The runtime was already built (pack
schema, `metadataFormulaCatalogue()`, `metadataFormulaPlan()` → `buildDescriptionPrompt()`, project
pinning, kind-agnostic install); only the wire kind blocked delivery. It is now on the wire on both
sides, labelled **Metadata Formula** and sorted beside the other formula in the Store.

**Evidence:** `metadata-formula-pack-bridge` 3/3 (signed archive → install → catalogue → description
prompt), all seven kinds parse and keep their spelling with the unknown-kind guard intact, persisted
catalogue round trip covers every kind. No DMG yet — accumulates into 1.4.216.

**Full gates on the finished tree (both WIRE packets, 1.4.216, uncommitted):** full backend
`npm run test:backend` exit **1** — **5,610 tests, 5,605 pass, 4 fail, 1 skip**, `513/513 file(s)`,
6,312 marks. **None of the 4 failures is in a file this work touched.** One is `NEW-08` (external
private Topic Pack source). The other three are also **external**: the Content Pack re-authoring
effort's untracked `content-packs/rebuilt/` (created 01:24–02:09 today, mid-session) now holds
`<slug>-v2` packs, and the repo's cross-pack overlap guards see e.g. `ancient-oceans-deep-sea` and
`ancient-oceans-deep-sea-v2` writing the same subjects twice (`deep-time-cross-pack-overlap`,
`formula-substance-not-rebilled` ×2). All ten new tests passed inside that run. Full frontend lane exit
**0**, 1,915 pass, `213/213 file(s)`, 2,118 marks; `npm run build` exit **0**; `npm run lint` exit 0
with 0 errors (1,925 warnings); `check:changelog` and `git diff --check` exit 0; frontend typecheck
unchanged at the 11 pre-existing `NEW-04` errors.

### DS-14 — model-drift guard fixture coverage (M-08) — **accepted (self-acceptance)**

**Disposition:** `fixed`. The guard is now exercisable on fixtures — it exports
`analyzeModelDriftSource(raw, path)`, `scanForModelDrift({ root, roots })`, `modelDriftRules` and
`modelDriftScanRoots`, with the CLI calling the same function — and seven cases prove it in both
directions: every declared rule must fire on a real violation, the three **historical misses** are
caught by name and file, and every legitimate control stays silent. The refactor is
behaviour-preserving: original and refactored scripts produce byte-identical stdout and exit code.

**Two real defects found, and one live violation exposed:**

1. The coarse pre-filter could hide a whole file. `controls.stability` (a `named-control` violation)
   and published fields such as `max_reference_images` contain none of its trigger words, so a file
   whose only mistake was one of those was never read — and the guard still printed "passed". The
   pre-filter is **removed**; a full scan costs **0.81 s for 708 files**.
2. The documented module-specifier exemption never fired: `from 'pkg'` leaves the opening quote before
   the match, which `\s*$` could not accept, so every quoted specifier was reported as a product id.
   Fixed.
3. Removing the pre-filter immediately surfaced a **live** finding the guard had always hidden:
   `frontend/utils/genstudio-relaxed-queue.ts:55` rendered `$${…}` in a cost string. Investigated:
   it renders **GenStudio's own published cents figure**, not a Story-owned rate, so it carries one
   written `model-drift-allow` justification (exceptions 38 → 39) rather than a rules rewrite.

**Evidence:** RED by restoring the pre-filter in the same code shape (2 fail / 5 pass) and by running
`HEAD`'s guard against the tree with the annotation removed (exit **0** — missed) versus the fixed
guard (exit **1**, naming the file and line); both files restored byte-identically. Green: release lane
exit **0**, **43/43**, `5/5 file(s)` (was 36/4); `check:model-drift` exit 0; frontend lane exit **0**,
1,916 pass, `213/213 file(s)`; `npm run build` exit **0**. Report:
[`DS-14.md`](docs/handoffs/deepseek-reports/DS-14.md).
**Limitation:** the guard is a source grep it always was; these fixtures prove the rules fire, not that
the rules are complete — a mistake shape nobody has thought of yet still passes, which is why the
exception list stays auditable and the fixture set is meant to grow with each new shape.

### DS-16 — historical reconciliation and evidence limits (X-02–X-05) — **accepted (self-acceptance)**

**Disposition:** read-only reconciliation, no production change. All eight appendix blocks are mapped
to current source or released evidence, and the old notes are corrected where they were wrong:

- **Integrated:** FIX-E2 (1.4.212 — an unpublished ceiling returns `null` and the page flag is copy
  only, so Next and the batch controls stay usable), FIX-CONTENT (the reset now writes a durable
  `invalid_state_reset` recovery incident beside the quarantine), FIX-SETTINGS (`?path=` containment is
  applied at every site via `resolveAssetPath` + `isPreviewablePath`; the hardcoded `version: '0.1.0'`
  is gone in favour of `resolveStoryStudioVersion()`; `lib/ttl-cache.ts` and its test are removed), and
  FIX-RECOVERY (1.4.210 queue-cancellation lifetimes).
- **Decided and implemented:** FIX-F as **X-06** (preset-only reusable guidance).
- **Measured, no change:** the FIX-QUEUE "clone per frame" item is the SSE frame cost measured in
  **DS-13** (4.9 KiB → 400.6 KiB per frame at 100 → 10,000 lines, one coalesced write per burst, no
  observed impact). `useJobs` SSE retry and the `jobs.vue` items were closed by **DS-07** and **DS-08**;
  crash-interrupted paid work by **DS-02**.
- **Corrected notes:** `routes/debug.ts` is **not** "unused" — it is mounted (`routes/index.ts:84`) and
  reachable by design, but gated by `requireSession` in server mode and by `requireAllowedHost` plus a
  loopback bind in desktop mode, so it is support surface rather than an exposure (it returns absolute
  paths, which is why the gating matters). Three FIX-QUEUE pointers (`:684`, `:1659`,
  `routes/pipeline.ts:2202`) carry no description and no longer correspond to their lines; the nearest
  current code was inspected and **no work was revived** from a bare pointer.
- **Dormant, deliberately not repaired:** F-03, Y-07, P-05 — each is a reachability question with no
  production caller at this base; a future caller must bring its own proof before behaviour changes.
- **Retractions preserved:** Z-06, M-05, M-06, Y-01, plus the four inherited backlog retractions. None
  was contradicted.
- **No new bounded packet:** the leftovers are dormant-by-reachability, fail-closed by design, an
  unresolvable old pointer, or already measured with no impact.

**X-05 limitations** are recorded with reachability — the `/var` alias skip is a correct
platform-conditional; the final check/unlink race is narrowed by the coordination lock and
`O_NOFOLLOW` and cannot be closed by a path-based API; power-loss behaviour is untestable here without
fault-injecting hardware; multi-file crash transactions are compensated by quarantine-before-reset,
durable recovery incidents and provider-evidence guards. None justifies an architecture change.

Report: [`DS-16.md`](docs/handoffs/deepseek-reports/DS-16.md).
**Limitation:** source and released-changelog evidence only; the ledger's focused-green rows are cited
as release evidence rather than re-executed here, and retained legacy data was left untouched.

### SMALL-01 — the small-fix list (NEW-01, NEW-02, NEW-03, NEW-04, NEW-10) — **accepted (self-acceptance)**

**Disposition:** all five fixed, each with a RED/GREEN pair and a restored file.

- **NEW-04 — frontend typecheck.** Root cause found: Nuxt 4.5.2's generator emits `.nuxt/fetch.d.ts`
  but never the `fetch.mjs` that `.nuxt/types/imports.d.ts` resolves the auto-import through, so the
  global `$fetch` types with no type parameters and `$fetch<T>` is TS2558. Fixed at the 11 call sites
  by turning the type argument into a trailing assertion (type-only; no dependency changed).
  **`npm --prefix frontend run typecheck` is now exit 0** — green for the first time this session.
- **NEW-03 — backend test PATH.** The runner prepends this checkout's `bundled/ffmpeg` when present.
  RED with the runner at `HEAD`: 3 fail / 22 on `spawn ffmpeg ENOENT`; GREEN 62/62 with no manual
  prefix.
- **NEW-01 — the cancellation control names the missing key.** `reconcileCancellationJob` records
  `MISSING_KEY_RECONCILIATION_DETAIL` (write-on-change, so DS-01's bounded growth holds). The first
  attempt introduced a **stale-reason regression** the affected run caught: once a key exists the
  reason made the admission guard refuse a legitimate cancellation, so `requestJobCancellation` now
  drops exactly that reason when a key is configured. `job-cancel` + `job-cancellation-missing-key`
  exit 0, **81/81**.
- **NEW-02 — completion auditors.** `image_prompts`, `metadata` and `research_run` register auditors
  that reuse `inspectPromptCompletion`, `inspectMetadataCompletion` and
  `resolveResearchPaths` + `isResearchComplete`. Both directions pinned per type in
  `text-job-completion-auditors.test.ts` (RED at `HEAD`: 4 fail).
- **NEW-10 — a regenerated row names the chosen style.** The workspace's four lettering fields travel
  with the regenerate request and reach the enforcement clause; omitted means unchanged. RED 2 fail,
  GREEN 11/11.
- Also fixed a round-2 slip this packet's `typecheck:electron` caught: `audio-script-freshness-hash.test.ts`
  declared `let dir` without a type (tests are inside the electron typecheck).

**Gates on the finished tree:** full backend exit **1** — **5,633 tests, 5,628 pass, 4 fail, 1 skip**,
`516/516 file(s)`, 6,344 marks, the same four **external** content-pack failures; full frontend lane
exit **0**, 1,916 pass, `213/213 file(s)`; `npm run build` exit **0**; both typechecks exit **0**;
`check:changelog` and `git diff --check` exit 0. Report:
[`DS-17b-small-fixes.md`](docs/handoffs/deepseek-reports/DS-17b-small-fixes.md).

## Remaining historical candidates — every open/partial row

Each row starts unverified for this workflow. Fill the Outcome / evidence cell when working it;
packet acceptance stays separate. File paths in scope cards are current navigation anchors;
historical line numbers are not authoritative.

| ID | Packet | Required behavior/proof | Outcome / evidence |
|---|---|---|---|
| H-16 | DS-01 | Missing-key waiting is bounded/actionable; credentials restore same-identity reconciliation without duplicate submission. | reproduced-fixed, self-accepted ([DS-01](docs/handoffs/deepseek-reports/DS-01.md)); bounded/log-growth half reproduced+fixed; the "actionable control copy" half recorded as `NEW-01` → DS-08 |
| H-17 | DS-02 | Restart with durable paid evidence preserves recovery semantics and prevents duplicate admission. | reproduced-fixed, self-accepted ([DS-02](docs/handoffs/deepseek-reports/DS-02.md)): settled-but-unverifiable restart rows now fail loudly instead of running forever with no Retry. Unsettled-evidence reconciliation half already correct. Residual `NEW-02` (no auditors for several text types). |
| S-04 | DS-03 | With two episodes/models and no local job match, another episode's model cannot determine this episode's split/selection. | reproduced-fixed, self-accepted ([DS-03](docs/handoffs/deepseek-reports/DS-03.md)): the legacy `audioJobs[0]` borrow predicted another episode's 12 parts; now only this episode's own job or an unambiguous single-model history is used. |
| S-06 | DS-04 | Populated A → failing/empty B → late A response → valid B cannot retain or reintroduce A's episode-owned fields. | reproduced-fixed + already-correct, self-accepted ([DS-04](docs/handoffs/deepseek-reports/DS-04.md)): character-sheet now blanks `config` synchronously; broll/scene-review/images/research/motion-review/metadata already cleared (static coverage extended). Rendered DOM proof remains a limitation; `NEW-04` frontend typecheck pre-existing errors. |
| Q-02 | DS-05 | A skipped step makes no inline Character Sheet change; compare persisted bytes/state before and after the actual route. | already-correct, self-accepted ([DS-05](docs/handoffs/deepseek-reports/DS-05.md)): an already-complete character_sheet step leaves continuity.json byte-identical; an episode aborted after the inline write still reports `character_sheets_applied`, surfaced in the Pipeline receipt. Residual copy-attribution note recorded. |
| H-13 | DS-06 | Unsupported animated/word captions are explicitly refused or reported degraded; never silently presented as the requested successful output. | reproduced-fixed, self-accepted ([DS-06](docs/handoffs/deepseek-reports/DS-06.md)): both assemblers now declare `result.degraded` with the dropped caption features when the `force_style` fallback runs, instead of only logging. Full-render behavioural RED remains a limitation (wiring guard used). |
| Q-04 | DS-07 | Three SSE failures, fallback and recovery converge to fresh state; stale responses cannot undo it; prove teardown/reconnect behavior. | reproduced-fixed + documented fallback, self-accepted ([DS-07](docs/handoffs/deepseek-reports/DS-07.md)): the app-wide stream now buffers behind its snapshot and reports `snapshot-error` like its siblings; the one-way polling fallback is deliberate and already converged (stale responses guarded by epoch/revision). Client rendered checks remain a limitation. |
| E-11 | DS-07 | Queue-status read failure after known pause remains unknown/error, never falsely running. | reproduced-fixed, self-accepted ([DS-07](docs/handoffs/deepseek-reports/DS-07.md)): `queuePaused` is now `boolean \| null`; a failed read clears to unknown, the paused banner requires a known pause, and the control is disabled with an unknown-state notice. Static guard only (no mounted-page render). |
| Q-06 | DS-08 | Per-row and mixed-bulk Retry eligibility agree with backend admission for legacy/current rows. | reproduced-fixed, self-accepted ([DS-08](docs/handoffs/deepseek-reports/DS-08.md)): `retryAdmissionAllowed` mirrors the backend legacy prompt/image mode rules and now gates both `canRetryJob` and `failedJobsForRetryAll`. |
| Q-07 | DS-08 | Every Jobs tab corresponds to a currently supported type/intent; historical rows remain interpretable. | reproduced-fixed: the hard-coded `scene_images` / `scene_images_batch` tabs are removed; the dynamic loop still adds a tab when a historical row of a retired type exists. |
| Q-08 | DS-08 | Nonempty history filtered to zero says no matches, not no jobs ever. | reproduced-fixed: `jobsEmptyState` distinguishes a filter hiding a nonempty set ("No matching jobs") from genuinely empty history ("No jobs yet"). |
| Q-09 | DS-08 | Generated finish-missing-images Retry URL reaches its intended served action/view. | not-reproduced (latent): the only callers are `continuity_render`-gated and no `_app_` job can be one, so the unserved `/jobs/all/:id/finish-missing-images` URL is unreachable today. Documented, not patched. |
| Q-10 | DS-08 | Subtitle retry tooltip names an action the user can actually reach. | reproduced-fixed: `subtitles_transcribe` is not in `REPAIR_ENDPOINTS`, so the tooltip no longer says "Repair first"; it describes the actual Retry behaviour. |
| F-11 | DS-08 | Every current live job type has correct labels in Jobs, toast and episode dropdown; reuse existing presentation utilities. | reproduced-fixed: one authoritative `JOB_TYPE_LABELS` in `utils/job-presentation.ts` now serves all four sites. Pre-fix drift: useJobs 6 missing, useNotifications 7, EpisodeSelector 20 of 33, jobs.vue 0. |
| E-01 | DS-09 | Scene Review 500 is distinct from no plan and offers working retry. | reproduced-fixed, self-accepted ([DS-09](docs/handoffs/deepseek-reports/DS-09.md)): `reviewError` + retry notice; the "No scene plan yet" card requires `!reviewError`. |
| E-02 | DS-09 | Research read failure with valid config is distinct from unconfigured API and recovers. | reproduced-fixed: `sourcesError` is checked before the "not configured" reason; a failed read can never start a paid run. |
| E-03 | DS-09b | Failed introduction read with multiple episodes retains unknown/pre-spend warning, not silent permission to spend. | reproduced-fixed, self-accepted ([DS-09b](docs/handoffs/deepseek-reports/DS-09b.md)): both pages use a tri-state flag; a failed read shows an honest "could not check" warning with Retry and keeps the pre-spend warning, and only a known-true channel includes the Introduction step. |
| E-06 | DS-09 | Failed accepted-ideas read is distinct from zero accepted ideas and retry works. | reproduced-fixed, self-accepted ([DS-09](docs/handoffs/deepseek-reports/DS-09.md)): an `epError` branch with Retry precedes "No accepted ideas yet". |
| E-10 | DS-09b | Deleting a disposable Scene Plan leaves an intentional, actionable empty state, not a heading-only card. | reproduced-fixed, self-accepted ([DS-09b](docs/handoffs/deepseek-reports/DS-09b.md)): the plan section is gated on `plan \|\| planning`, so a stale `status.scene_plan` no longer renders a heading-only card; the no-plan card now offers **Build the plan**. |
| E-04 | DS-10 | Failed chapter-audio read shows error/retry, not “no audio” as if successfully measured. | reproduced-fixed, self-accepted ([DS-10](docs/handoffs/deepseek-reports/DS-10.md)): `statusError` + Retry branch precedes the missing-audio claim on `subtitles.vue`. |
| E-05 | DS-10 | Failed sections read with existing script is not “generate script first.” | reproduced-fixed, self-accepted ([DS-10](docs/handoffs/deepseek-reports/DS-10.md)): `loadError` + Retry branch precedes the empty-script claim in `AudioChapterSelector.vue`. |
| E-07 | DS-10 | Transition inventory rejection clears loading and exposes recovery. | reproduced-fixed, self-accepted ([DS-10](docs/handoffs/deepseek-reports/DS-10.md)): `transitionsCatalogLoading`/`transitionsCatalogError`; `finally` clears loading on both paths and the failure offers Retry. |
| E-08 | DS-10 | Asset-scan failure leaves visible actionable error; last-valid display must not become stale generation input. | reproduced-fixed, self-accepted ([DS-10](docs/handoffs/deepseek-reports/DS-10.md)): `scanError` is rendered in Step 1 with **Retry asset check**; a failed scan still clears `scannedAssets`/`scenes`, and the render payload carries no browser-authored scene list, so a last-valid display cannot authorize stale input. |
| E-09 | DS-10 | Delayed existing-subtitle response shows loading, not a false empty flash. | reproduced-fixed, self-accepted ([DS-10](docs/handoffs/deepseek-reports/DS-10.md)): `subtitlesStatusLoading`/`subtitlesStatusError`; the "No subtitle file…" claim requires a completed read for a real episode and a failed read is unknown + retryable. |
| F-04 | DS-11 | Settings navigation fetches actual FFmpeg status before proposing install/recovery actions. | reproduced-fixed, self-accepted ([DS-11](docs/handoffs/deepseek-reports/DS-11.md)): entering the Files & maintenance tab probes `/ffmpeg/status`, a failed check is an explicit unknown with Retry instead of `{ installed: false }`, and the installer/manual fallback require a real status. |
| F-05 | DS-11 | Hydration and both category watchers preserve the legitimate saved category; deliberate edits still persist. | reproduced-fixed, self-accepted ([DS-11](docs/handoffs/deepseek-reports/DS-11.md)): the project-meta watcher no longer blanks `category_id` (the parallel meta/config fetch raced it and the next save persisted the clear); the per-project reset moved to the slug watcher, and an unsaved deliberate change survives a same-project refresh. |
| F-12 | DS-12 | Long purchase dialogs retain reachable Cancel/Confirm at short/narrow viewports; do not submit a purchase. | **still blocked by the fixture** ([DS-12](docs/handoffs/deepseek-reports/DS-12.md)): the disposable library's Content Store reports `Discover 0 / Owned 0 / Installed 0 / Updates 0` and offers only Retry (no GenStudio scope or key), so `ContentPurchaseDialog`/`ContentBatchPurchaseDialog` cannot be opened at all. No purchase was attempted. The What's New dialog remains the one short-viewport specimen (900×640, renders correctly). |
| F-13 | DS-12 | Named utility classes actually style sibling/teleported consumers in built CSS; verify computed style and specificity. | **verified** ([DS-12](docs/handoffs/deepseek-reports/DS-12.md)): all six are defined globally in `assets/css/main.css` (registered in `nuxt.config.ts`) and appear **unscoped** in the built `entry.*.css`. Consumers with no local rule compute exactly the declared values (`.link-btn` on `scripts.vue`, `.section-kicker` on `pipeline.vue`), and a probe element appended to `document.body` — outside `#__nuxt`, where every teleported dialog lives — computes all six correctly. A scan for other shared-but-scoped-only classes was attempted and abandoned as unparsable without a real template parser; recorded instead of a hand-picked list. |
| F-14 | DS-12 | Settings Save remains reachable and obeys intended sticky behavior at multiple scroll offsets/sections. | **reproduced-fixed, self-accepted** ([DS-12](docs/handoffs/deepseek-reports/DS-12.md)): the Notification center save bar measured its exact natural document offset at every scroll position (1867/1411/955/500/44) — `position: sticky; bottom: 10px` was inert because `.notification-panel { overflow: hidden }` made the panel the bar's own scroll container. Live A/B: `overflow: visible` moves the bar to `833..898` at scrollTop 0. Fixed to `overflow: clip`; the bar is now inside the viewport at all five offsets (833/377/117/117/54). Caveat recorded: the 0%/25% offsets rest on geometry because this harness stopped producing fresh frames below ~y=250; the 50% frame shows the bar painted with its Save button. |
| F-15 | DS-12 | Every named overflow surface has reachable tail/actions using mouse and keyboard at desktop and narrow sizes. | **reproduced-fixed, self-accepted** ([DS-12](docs/handoffs/deepseek-reports/DS-12.md)): both reported consumers were real and are fixed. (a) Scene Plan's "Avoided imagery" control sat at `1313..1533` — 93px past the viewport and 156px past its card, clipped by `main.main-content{overflow-x:hidden}`; the 680px three-column minimum is now a two-column layout inside the card, with the intensity picker spanning the row (a first attempt that only shrank the tracks ellipsised every intensity label to one letter and was rejected). (b) Scene Review's `generate-region` sat at `1150..1453`, 13px past; the tracks may now shrink. Re-measured: **0 unreachable** on both pages at 1600/1400/1280/1100/1024/900 and at 1440×900 / 900×640, no page scroll; Tab traversal reaches the Scene Plan input after 65/66 presses with the field fully in view and accepts typed text, and the Scene Review CTA (now `1088..1391`) is correctly skipped only because it is `disabled` in this empty fixture — its enabled path belongs to ACCEPT-01. |
| NEW-11 | DS-12 / release tooling, found 2026-09-22 during the 1.4.217 build | The packaging path must not leave the checkout's own source files mutated, and a gate should say so. | **mitigated 2026-09-22 — culprit step still unidentified.** After `npm run dist:smoke` exited **0**, the repository-root `package.json` had been rewritten into electron-builder's packaging shape: `scripts` (37 entries) and `devDependencies` (14) gone, `description` re-serialized (`\u2014` → `—`), while `package-lock.json` was untouched. The artifact itself is sound — the `build` step ran before packaging and `verify-desktop-artifact` passed (98-package closure, launch smoke) — but any `npm run …` in that checkout would have failed until the file was restored from `HEAD` (`git checkout -- package.json`). The trimmed file is preserved at `_trash/evidence/package.json.trimmed-by-packaging-1.4.217.json`. No current guard asserts the root manifest is unchanged after packaging; **Mitigation added:** both build scripts (`scripts/release/build-unsigned-dmg.mjs` and `build-public-dmg.mjs`) now snapshot `package.json` + `package-lock.json` with `snapshotSourceManifests()` before electron-builder runs and call `restoreSourceManifests()` in a `finally`, so a rewritten manifest is put back and named in the log ("packaging rewrote package.json; restored the checkout's own copies (NEW-11)") whether the build succeeded or failed. Unit-tested in `scripts/release/__tests__/release-utils.test.mjs` (restores a manifest trimmed to the packaging shape, reports only the changed path, leaves the other file alone, and is a no-op on a second call); release lane green at **44 tests, 5/5 files**. **The culprit step is still unidentified:** a clean `npx electron-builder --dir --publish never` on this checkout — including its `@electron/rebuild` / "installing native dependencies" step — left both manifests byte-identical (`sha256 c5bf4c27…` / `c10ccc30…` before and after), and `scripts/fetch-ffmpeg.mjs` takes its present-binaries fast path without touching the manifest. So the guard prevents the observed harm regardless of which step does it, but no one should claim the writer is fixed. |
| NEW-14 | ACCEPT-01 walkthrough, found 2026-09-22 | A promised repair must be one the named control can actually perform. | **reproduced-fixed, self-accepted** (fix in `routes/jobs.ts`, tests + live run below). With a provider answer that is short but usable (one tag line instead of the requested fifteen), the YouTube finalizer correctly refuses the package ("3/17 required item(s) verified … Missing/invalid: tag 2 … tag 15", partial package kept). Re-running the same route with the same params fails identically: three EP0001 jobs (`e49b81c9`, `61457d82`, `aca65751`) all cite provider job **`mock-chat-001`** with no `operation_id`, because an identical request identity reuses the provider idempotency key and the provider replays the same short answer — correct cost safety, but the terminal message "Retry to generate the missing fields" is not true for the **Jobs Retry** control, which re-runs stored params unchanged (`retryReplacementParams` only special-cases `image_prompts`). The Finalizer page heals because it always stamps a fresh action (`freshMetadataAction` in `metadata.vue`) — proven: a fourth job with a fresh `operation_id` completed 17/17 with 15 tags from the same seeded answers. **Fixed this round:** `retryReplacementParams` mints a fresh language action (`stampFreshGenerationAction` + `randomUUID`) for a `metadata` retry that has no saved action, and marks its own mint `origin: 'retry'` so each later retry mints again; a page-stamped action is still preserved (the pre-existing pinned contract). `job-retry-route-contract.test.ts` gained two cases: a bare retry carries a fresh action (UUID + fingerprint) changing nothing else, and **two consecutive retries carry different action ids** — the second was added because the live loop caught the first version preserving its own mint. Verified live on a fresh gateway: bare attempt `31707af7` → `error` 3/17 (provider `mock-chat-001/002`), Retry #1 `5bfb9976` → `error` 3/17 with **new** provider jobs `003/004` (no replay), Retry #2 `52a0cfab` → **`done` 17/17, 15 tags** (`005/006`); six gateway submissions across three attempts. Focused: `job-retry-route-contract` green, 176 tests across the job-retry/metadata/job-queue files green, `typecheck:electron` exit 0. Application-facing, so it joins `NEW-12` in needing a version bump + changelog line at the next release decision (not bumped; installed app remains 1.4.217). |
| NEW-13 | ACCEPT-01 walkthrough, found 2026-09-22 | A cached completion verdict must be invalidated by the artifact it was computed from — including one outside the project tree. | **reproduced — fix not written.** The episode status cache (`<userData>/cache/<slug>/episode-status.json`) watches 13 paths, all inside the project tree; the **external final-video root** and its `<code>_video_assembly_source.json` stamp are not watched. With the two ACCEPT-01 finals briefly absent from that root the app persisted `video_assembly: false` for both episodes, and restoring the files did not change the verdict — it survived an app restart. A fresh, uncached computation of the same episode returns `video_assembly: true` and `final_video_bytes: 10591` (`scripts/developer/probe-video-assembly-status.ts`), so the assembly path, the stamp and the status rule are correct and only the cache is stale. Owner-facing because his Library root is `~/Documents/Story Studio KH`, so his finals live at the external root: a recompute while that root is unreachable (drive unplugged, Exports archived, cloud eviction) is cached and kept after the final returns. Fix direction: watch the resolved external directory + stamp when an external root is configured, with the cache's existing `watcherTrustedSince` care for a watcher that may not exist yet. Deliberately not changed this round. |
| NEW-12 | ACCEPT-01 walkthrough, found 2026-09-22 | A completion audit must audit the output the job was actually asked to produce. | **reproduced-fixed, self-accepted** ([ACCEPT-01](docs/handoffs/deepseek-reports/ACCEPT-01.md)): Scene Plan's "Build timeline" action posts `{stage:'timeline'}`; the job built a correct cue-aligned plan (`scene_plan.json` with `timeline_built_at` and a timed scene, `visual_prompt: ''` — the step is documented as model-free) and then failed with `scene_plan_run reported success, but re-reading its output found required items missing` after three local attempts, for both episodes. Root cause: `auditScenePlanOutput` folded every non-motion stage into `'visual'` and demanded a `visual_prompt` per scene, which a timeline-only run is deliberately never asked to write. Fixed in `boot/executors.ts`: `stage: 'timeline'` (and only that, repair flags unchanged) is audited on at least one scene with finite forward-running timings plus a recorded `timeline_built_at`; Pipeline runs and the visual stage keep the prompt requirement. New regression test `scene-plan-timeline-audit.test.ts` RED→GREEN (2 cases), `scene-motion-scope-enforcement.test.ts` still green — 11/11 focused. Verified in the live app after recompiling and restarting: both timeline jobs `done`. Application-facing, so it needs a version bump + changelog line at the next release decision (not bumped yet; installed app remains 1.4.217). |
| Q-03 | DS-13 | Measure representative large output serialization/persistence/SSE before claiming a performance defect or optimizing. | **measured — no observed user-impact case, no change.** Synthetic medians (3 passes, M2 Max): 1 job with 100/1,000/10,000 log lines writes 0.01/0.06/0.56 MiB in 6.7/7.5/20.8 ms; a full 750-job × 20-line history writes 0.96 MiB in 36.7 ms; one SSE frame is 4.9/39.2/400.6 KiB per subscriber. A 200-mutation burst coalesces to **1 atomic write**. The owner's real Library (9 projects, read-only) peaks at **592 log lines in one job (~100 KB record), 0.67 MiB `jobs.json`** — far below the synthetic extreme. No caps/caching/truncation proposed; durable evidence untouched. Script: `scripts/developer/measure-job-persistence-cost.ts`. |
| M-08 | DS-14 | Synthetic missed-literal fixtures prove actual checker coverage while legitimate live-catalogue/local-policy cases pass. | **fixed, self-accepted** ([DS-14](docs/handoffs/deepseek-reports/DS-14.md)): 7 fixture cases run the guard's real walk+analyzer from a temp dir; every declared rule must fire while every legitimate control stays silent. Two real defects found: the coarse pre-filter hid whole files (`controls.X`, `max_reference_images` carry no catalogue vocabulary — gate removed, full scan 0.81 s / 708 files), and the documented module-specifier exemption never matched a quoted specifier. Removing the gate surfaced a **live** finding (`genstudio-relaxed-queue.ts:55` rendered a dollar figure) which is GenStudio's own published cents value, so it carries a written `model-drift-allow` (39 exceptions). |

### Scope cards for later dispatch

**DS-02 — restart lifecycle.** Start at `electron/server/services/job-queue.ts`,
`job-control.ts`, `job-cancellation-reconciler.ts`; existing tests
`job-queue-stale-running-persist.test.ts`, `job-evidence-placeholder-recovery.test.ts`,
`job-cancellation-reconciliation.test.ts`. Persist a job, reload through the real boot path with
a fresh module/process, fake accepted/running/succeeded/unknown outcomes, and count generation calls.
Verify duplicate admission before/after settlement, authoritative output auditing, partial output
preservation, visible recovery state and idempotent retry. Do not treat provider success alone as local completion.

**DS-03 — audio ownership.** Start at `electron/server/services/audio-reconciler.ts` and tests
`audio-tts-model-record.test.ts`, `task7-audio-readiness.test.ts`. Use two episode identities and two
catalogue-published request budgets that produce different chunk counts. Vary missing local match,
active selection and durable provenance; assert exact model/files chosen and a legitimate positive
control. Do not conflate this candidate with script freshness (DS-15).

**DS-04 — episode swaps.** Initial pages under `frontend/pages/projects/[slug]/`:
`broll.vue`, `scene-review.vue`, `images.vue`, `research.vue`, `character-sheet.vue`,
`motion-review.vue`, `metadata.vue`. Record each episode-owned field and request; run success,
empty, reject and out-of-order responses after a populated prior episode. Verify replacement/clear
and appropriate notice, including generation payload exclusion of stale IDs. Preserve reusable
settings; do not globally clear every field. Split by page if necessary before implementation.

**DS-05 — Pipeline skip.** Start at `electron/server/routes/pipeline.ts` and
`electron/server/__tests__/pipeline-step-skip.test.ts`. Use the real route with a completed/skipped
step and inline Character Sheet settings; compare all relevant persisted config/continuity records
before/after and fake-provider count. Include a non-skipped positive control. No silent preset mutation.

**DS-06 — captions.** Start at `electron/server/generators/video.ts`, `broll-assemble.ts`,
existing subtitle style/render tests and the degraded-result contract. Fake insufficient word timing
or unsupported requested mode; inspect effective rendered mode and queue result, plus a supported
mode control. Prove the same outcome survives into customer-visible completion. If supported
fallback policy is unclear, report it for a ruling rather than choose silent substitution.

**DS-07 — transport.** Start at `frontend/composables/useJobs.ts`, `useAllJobs.ts`,
`frontend/pages/projects/[slug]/jobs.vue`; tests `useJobs.test.ts`, `allJobsTransport.test.ts`,
`jobsQueueVisibility.test.ts`. Simulate three stream failures, polling, server recovery, stale response,
project switch and unmount. Bound timers/connections and prove final data/queue status with rendered
checks. Do not impose a reconnect redesign if the current fallback is correct and documented.

**DS-08 — Jobs controls/presentation.** Start at `frontend/pages/projects/[slug]/jobs.vue`,
`frontend/utils/job-presentation.ts`, `frontend/composables/useJobs.ts`,
`frontend/components/EpisodeSelector.vue`; backend Jobs route/control definitions are the authority.
Use current-type, legacy-type, rejected-retry, mixed-bulk, filtered-empty and subtitle-failure fixtures.
Follow generated URLs to actual routes. Test that supported retry remains usable. Reuse the existing
label helper; do not add a fifth map. Backend contract changes require rescoping.

**DS-09 — workspace reads.** Pages: `scene-review.vue`, `research.vue`, `introduction.vue`,
`pipeline.vue`, `scene-plan.vue` under `frontend/pages/projects/[slug]/`. For each assigned failure,
render loading → rejection → retry → valid data, plus true-empty controls. Check wording and action
behavior, not source strings alone. Keep optional Research non-blocking; preserve pre-spend uncertainty.

**DS-10 — media reads.** Pages `subtitles.vue`, `audio.vue`, `video-assembly.vue` in the same directory;
`frontend/components/TransitionPicker.vue`. Use delayed successes, thrown reads and valid-empty
responses. Check spinner termination, distinction from absence and recovery; a displayed last-valid
preview must not authorize stale/foreign inputs. Reuse page notice/retry patterns.

**DS-11 — Settings.** Own `frontend/pages/projects/[slug]/settings.vue` and scoped frontend tests.
Enter Settings via navigation with bundled-media status mocked, not merely direct mount. Hydrate
saved category, observe both immediate writes and reload persisted result; also test legitimate
manual category change and empty configuration. No real FFmpeg download or account mutation.

**DS-12 — visual QA.** Start read-only: `ContentPurchaseDialog.vue`, `ContentBatchPurchaseDialog.vue`,
`SubtitleCuePreview.vue`, dashboard layout and the Settings/Scene Plan/Video Assembly/Audio/Scene
Review/Research/Pipeline/Subtitles pages. Check 1440×900 and 900×640, a shorter 800×500 dialog,
long filenames/content, keyboard traversal and multiple scroll offsets. Inspect built specificity
for `.input-sm`, `.btn-icon`, `.link-btn`, `.checkbox-label`, `.section-kicker`, `.card-actions`.
Save before/after screenshots and reachable-action evidence. First report exact failing consumers;
then obtain bounded file ownership before patching shared CSS. DOM assertions do not prove geometry.

**DS-13 — performance.** Initial surface `electron/server/services/job-queue.ts` and
`electron/server/routes/jobs.ts`, tests `job-queue-persistence-retention.test.ts`, `jobs-stream.test.ts`.
Use synthetic histories (e.g. 100, 1,000 and 10,000 lines, recording bytes too), subscriber counts,
and repeated timings; record machine/runtime, CPU or elapsed serialization cost, payload size and
memory delta. Establish an observed user-impact case before proposing caps/caching. Never truncate
durable provider evidence or silently remove useful logs. This is a measurement-first assignment.

**DS-14 — guard coverage.** Own `scripts/check-model-drift.mjs` and its directly corresponding new
or existing script tests. Inspect actual supported entry points before choosing the fixture harness.
Use synthetic files in temporary paths, not planted violations in production. Cover historical
missed forms, live-catalogue positive controls and justified local policy; assert nonzero for real
violations and zero for valid controls. Do not blanket-suppress findings or claim UI correctness.

## Additional work outside the 32 open/partial rows

| ID | Assignment / disposition | Required result | State |
|---|---|---|---|
| X-01 | DS-15, investigation before repair | Trace raw vs transformed script hashes, generation provenance, active selection and no-selector audio-quality paths. Prove changed script invalidates the right freshness decision without falsely invalidating equivalent TTS normalization. Record the exact caller chain and tests before changing the contract. Start at `audio-reconciler.ts`, `audio-quality.ts`, `generators/audio.ts`, `audio-quality-active-check-lifecycle.test.ts`. | **reproduced-fixed, self-accepted** ([DS-15](docs/handoffs/deepseek-reports/DS-15.md)): the recorded script fingerprint hashed the run's TRANSFORMED text (expression tags swapped in, auto-pacing appended) while the check recomputed it by normalizing the script file, so any expression/auto-pace run reported "the script changed" with nothing changed — measured `sha256:4bb06c57…` (recorded) vs `sha256:54e1d39b…` (recomputed). `chapterScriptFingerprint()` is now the single implementation used by both sides, and the generator captures it immediately after parsing, before every transformation. True positives preserved; 204/204 audio/tts regression; RED 2 fail / 5 pass with `audio.ts` at `HEAD`. |
| X-02 | DS-16, historical evidence reconciliation | Map every appendix FIX-E2/F/QUEUE/YOUTUBE/CONTENT/CONTENT-REMAINING/SETTINGS/RECOVERY item to current source/release evidence, this queue, or an explicit remaining disposition. Do not revive integrated work because an old note says pending. Check debug-route reachability and TTL-cache retirement specifically; retained legacy data stays untouched. | **complete, self-accepted** ([DS-16](docs/handoffs/deepseek-reports/DS-16.md)): all eight blocks mapped to current source or release evidence. FIX-E2 integrated (1.4.212: unpublished ceiling returns `null`, the page's flag is copy only), FIX-F decided+implemented (X-06), FIX-CONTENT integrated (durable `invalid_state_reset` recovery incident), FIX-SETTINGS integrated (containment applied at every `?path=` site; version resolved live; `lib/ttl-cache.ts` and its test gone), FIX-RECOVERY integrated (1.4.210). **Debug-route check:** `/api/debug/info` is mounted and reachable by design, but gated by `requireSession` in server mode and by `requireAllowedHost`/loopback in desktop mode — support surface, not an exposure. **TTL-cache check:** removed, orphaned `endpoint_labels`/`hub_url`/`endpoint_disabled` left on disk and read by nothing. Three bare FIX-QUEUE pointers carry no description and no longer correspond to their lines: inspected at the current locations and **no work revived**. |
| X-03 | DS-16, assurance inventory | Review the other 57 historical rows: source-confirmed/focused-green residual proof, all 3 dormant reachability questions, duplicate and 4 retractions. Separate already-satisfied release checks from useful regression follow-up. Retractions stay retracted without new contradicting evidence. Identify any truly uncovered scenario as a new bounded packet, not an automatic repair. | **complete, self-accepted** ([DS-16](docs/handoffs/deepseek-reports/DS-16.md)): 57 = 25 source-confirmed + 24 focused-green + 1 duplicate (H-09 → folded into H-11) + 3 dormant (F-03, Y-07, P-05 — reachability unestablished, **no speculative repair**) + 4 retracted (Z-06, M-05, M-06, Y-01 — preserved as negative evidence, none contradicted). No new bounded packet: everything left is either dormant-by-reachability, fail-closed by design, an unresolvable old pointer, or the two measured cost items from DS-13 with no observed impact. |
| X-04 | DS-16, external evidence | Two Symbolic Psychology checks require `STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT`; locate only owner-provided evidence or explicitly retain skips. Never fabricate or bypass evidence. | **reconciled in DS-16 — skips retained.** The owner elected to keep the two checks as explicit external-evidence skips and keep the honest wording. The evidence is demonstrably absent here: the documented root `~/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23` does not exist and Spotlight finds none of the four required files (`evidence-ledger.json`, `candidate-handoffs.json`, `receiver-handoff.json`, `review-requests.json`). The Content Pack lane stays **366 pass / 2 explicit skips**, and no record may describe them as passed; if the folder is ever recovered, the two checks run with the env var set. |
| X-05 | DS-16, limitations record | Preserve platform-conditional `/var` alias skip, final path-check/unlink race, unproven physical power-loss behavior and multi-file crash-transaction limitations. Determine reachable/testable scenarios before architecture changes. These are limits, not all reproduced defects. | **complete, self-accepted** ([DS-16](docs/handoffs/deepseek-reports/DS-16.md)): each limit stated with its reachability — `/var` alias is a correct platform-conditional skip; the check/unlink race is narrowed by the coordination lock and `O_NOFOLLOW` and cannot be closed by a path-based API; power-loss behaviour is untestable on this Mac without fault-injecting hardware; multi-file crash transactions are compensated by quarantine-before-reset, durable recovery incidents and provider-evidence guards. No architecture change is justified by any of them. |
| X-06 | Owner decision, resolved 2026-09-22 | Reusable/channel Scene Plan guidance persistence: project config versus preset-only. Keep episode instructions separate. No speculative feature until owner decides. | **decided — preset-only, implemented and self-accepted** ([X-06 report](docs/handoffs/deepseek-reports/X-06.md)). A second, clearly labelled **Reusable guidance** box travels in Scene Plan presets and is applied only when the customer applies one; it never writes project config and never applies itself. `custom_instructions` stays excluded from presets (owner decision #9) and is now cleared on an episode change with an announcement (AGENTS.md §4 repair found in the same area). Both boxes are composed into the one guidance input the backend accepts. RED at `HEAD` (19 pass / 3 fail, file restored byte-identically); GREEN 22/22; regression 174/174; full frontend lane exit 0, 1,914 pass, 213/213 files; lint 0 errors; typecheck unchanged. |
| X-07 | Owner decision, resolved 2026-09-22 | Optional external acceptance | Live paid generation, actual YouTube upload and signed/notarized public distribution were not tested. Mock/local acceptance does not prove them. Obtain explicit authority and a bounded spend/destination plan before any such check. | **decided — bounded paid generation only.** The owner authorized **one** real generation on the cheapest published model with a hard credit ceiling, to be agreed and recorded before the call, proving real cost, provider provenance and artifact ownership. A real YouTube upload and signed/notarized public distribution remain **deferred and unauthorized**; both stay recorded as unverified limits. No paid call may run until the model, the ceiling and the proving checks are written down here first. |

DS-16 is a **read-only source/evidence + documentation packet**, not permission to patch the whole
historical backlog. Its output must expand compact ranges into explicit candidate IDs and link
current evidence. The older audit contains time-sensitive notes; this reconciliation prevents
both missed work and unnecessary repeat fixes.

## Cross-workflow acceptance and release — lead session owns preparation and self-acceptance

- [ ] ACCEPT-01: record a disposable Library/project and at least two episodes. Verify fresh setup,
  reload/persistence, episode changes and empty/error recovery in an isolated current-source app.
- [ ] Exercise a representative supported production workflow with fake provider outputs and valid
  local media: ideas/script → audio → subtitles → Scene Plan → scene images/motion where applicable
  → local assembly → upload preparation (no real upload). Include optional Research skipped explicitly.
- [ ] Exercise complete, partial, empty, stale, malformed, provider failure and retry/self-healing;
  expected artifact IDs and usable bytes must agree across generator, Jobs, Pipeline and Board.
- [ ] Exercise restart/cancel/resume and assert valid partial work survives without duplicate paid
  submissions. Verify model-switch catalogue options/limits, not stale saved caps.
- [ ] Capture real rendered geometry/keyboard evidence for changed surfaces; confirm backend identity.
- [ ] Review each worker diff independently; reproduce critical assertions and disposition every
  queued item or explicit deferral. “All known work resolved” requires these dispositions, not just green tests.
- [ ] RELEASE-01: freeze source/version; run serialized lint, both typechecks, **full** backend,
  frontend, release and Content Pack lanes, then production build and applicable dependency audits.
  Record actual commands, exits, summaries, coverage counts and skips. Do not quote a filtered gate as full.
- [ ] Resolve release metadata together; review and integrate through the normal owner-authorized
  workflow. Keep GitHub Actions disabled. This worker plan does not authorize publishing.
- [ ] After integration, build the final local DMG from main with `npm run dist:smoke`; verify
  versioned arm64 filename, package/app.asar version, dependency closure and isolated launch.
  Keep public signing/notarization separate. Report remaining evidence limits alongside the artifact.

### Worker test/report requirements

Only one suite at a time on this machine. The active implementation worker may run its assigned
focused tests and typecheck while iterating; full gates belong to the lead session at a coherent
source freeze. A queue fixture must
wait for its own worker's actual release before removing data, not just wait for a terminal label.

Backend focus: `node scripts/testing/run-backend-tests.mjs --only <test-file-substring>`.
For frontend focus, first inspect the target test/setup; the current runner uses `tsx --test`
with `frontend/__tests__/setup.ts`, not Vitest/Jest. Example from `frontend/`:
`../node_modules/.bin/tsx --import ./__tests__/setup.ts --test ./__tests__/useJobs.test.ts`.
Run Nuxt preparation if the test requires generated aliases. This direct invocation is focused
evidence only; `npm run test:frontend` is the full coverage-checked lane.

For every command record **actual child exit**, total/pass/fail/skip counts and the completion/coverage
line when emitted. Preserve RED and GREEN separately. Zero tests, fixture crashes and truncated
logs are not proving checks. Record non-test commands as N/A counts, with their actual exit.
Do not run auto-format/lint-fix over unrelated code. `git diff --check` must pass.

### Report template — `docs/handoffs/deepseek-reports/DS-XX.md`

Copy this structure and fill it with real values, including explicit “not run”/“none” where true.
Never paste credentials or private provider responses into a report.

```markdown
# DS-XX — packet title

## Run identity and scope
- Date / worker/session:
- Checkout / branch / base SHA / ending HEAD:
- Starting dirty files (including inherited docs):
- Candidate IDs / owned files / actual changed files:
- Packet state / per-ID outcomes:
- Skills and graph used (or unavailable); graph leads verified against source:

## Reproduction and root cause
- Exact steps/fixture and expected versus actual behavior:
- RED command, exit, failing assertion; why this is not a setup failure:
- If not reproduced: positive controls, scenarios tried, and limits:
- Current-source callers and ownership/completion boundary:

## Change and proof
- Minimal change and why existing helpers suffice:
- Per-ID assertions (include valid-path and failure/recovery controls):
- Commands: cwd, command, actual exit, total/pass/fail/skip, completion line:
- Evidence paths / screenshot viewport and action checked:
- Runtime version/changelog change, or why no bump applies:
- Self-review and diff-check result:

## Handoff
- Remaining risks / skipped or unrun checks:
- What the lead session's self-review pass should re-inspect or independently rerun:
- Blocker or exact decision/scope/tool/input needed (or none):
- Fixture paths and cleanup / still-running owned processes:
- Status rows updated; exact resume point if incomplete:
- Commit/push/paid calls/uploads/deployments: none (or explicitly authorized details).
```

## Verification checkpoint — takeover snapshot (DS-01 … DS-07)

Serialized full gates on the `codex/stabilization-takeover` working tree (version 1.4.214, base
`6f3c4e33`). One suite at a time; backend runs used `PATH="$PWD/bundled/ffmpeg:$PATH"` (`NEW-03`).

| Gate | Actual result |
|---|---|
| Full backend `npm run test:backend` | Exit **0**; **5,598 tests, 5,597 pass, 0 fail, 1 explicit skip**, 697 suites, `511/511 file(s)`, 6,295 marks; configured-projects sentinel unchanged |
| Full backend at 1.4.215 (re-run) | Exit **1**; **5,599 tests, 5,597 pass, 1 fail, 1 skip**, `511/511 file(s)`, 6,296 marks. The single failure is **external and unrelated**: `topic-pack-anti-padding.test.ts` ENOENT on `content-packs/private/topic/keeping-food-before-refrigeration/content`. `content-packs/authoring-registry.json` was modified during this session by a **different** effort (revision 289→290, coordinator branch `codex/content-pack-delivery`, "Gateway private Content Pack acceptance") to register a private Topic Pack whose source directory does not exist anywhere on this Mac. The dirty registry was preserved, not reverted (rule: never discard unrelated work). Recorded as `NEW-08`. Every 1.4.215 test passed. |
| Full frontend `npm run test:frontend` | Exit **0**; **1,879 tests, 1,879 pass, 0 fail, 0 skip**, 203 suites, `209/209 file(s)`, 2,082 marks |
| Full release lane `npm run test:release` | Exit **0**; 36 tests, 36 pass, 0 fail, `4/4 file(s)`, 40 marks |
| Full Content Pack lane `npm run test:content-packs` | Exit **0**; 368 tests, 366 pass, 0 fail, **2 explicit external-evidence skips**, `38/38 file(s)`, 368 marks |
| Root lint `npm run lint` | Exit **0**; **0 errors**, 1,926 warnings (baseline 1,925; +1 from two `as any` casts, since removed, so the snapshot warning count is 1,925–1,926 — non-fatal) |
| Production build `npm run build` | Exit **0**; changelog, typography, source+built security, model-drift, release contract, frontend generate and Electron compile all passed |
| Unsigned arm64 DMG `npm run dist:smoke` (later, owner-authorized) | Built and **verified** at 1.4.214: `dist/Story Studio KH 1.4.214-arm64.dmg`, 241,994,062 bytes, sha256 `0012f57d…`; ad-hoc signature, DMG mounts read-only, 98-package closure, launch smoke booted and served `/api/health` + Upload Center in ~1.1s. This is a **worktree build of the uncommitted 1.4.214 change set**, not an integrated main release. It is an owner-requested temp artifact; the installed app was not replaced. |
| Unsigned arm64 DMG **1.4.215** (owner-urgent) | `dist/Story Studio KH 1.4.215-arm64.dmg`, 241,998,873 bytes, sha256 `726fbfe8…`; app `com.storystudio.kh v1.4.215`; ad-hoc signature, read-only mount, 98-package closure, launch smoke served `/api/health` + Upload Center in 2,910 ms. Same temp-artifact caveat as 1.4.214. |
| Unsigned arm64 DMG **1.4.217** (owner-authorized; built from `main`) | `dist/Story Studio KH 1.4.217-arm64.dmg`, 242,032,636 bytes, sha256 `4c46892bbfe077c3956dec531e747b9594c4974227a0ffbcd29822da27a65e20`; app `com.storystudio.kh v1.4.217`; ad-hoc signature (no Developer ID); DMG mounts read-only; 98-package closure in `app.asar`; launch smoke booted the packaged app and served `/api/health` + Upload Center in 2,745 ms. Built **after** the DS-12 fixes landed in `main`, from the `main` checkout rather than a worktree. Installed at the owner's instruction; the superseded 1.4.216 DMG + blockmap moved to `_trash/dist/1.4.216-built-2026-09-22-1359/`. |
| Dependency audits (root all/prod, frontend all/prod) | Exit **0** each; `found 0 vulnerabilities` |
| Electron typecheck `npm run typecheck:electron` | Exit **0**, no diagnostics |
| Frontend typecheck `npm --prefix frontend run typecheck` | **Exit 2 — NOT green**: 11 pre-existing `TS2558` errors on `$fetch<T>()` in files this work never touched (`NEW-04`). `npx nuxi prepare` does not change them; no dependency was modified |
| `npm run check:changelog` / `git diff --check` | Exit **0** each |

The backend suite was re-run on the exact final snapshot after a type-only cast removal in
`audio-reconciler.ts`; the affected focused test (`audio-tts-model-record`) passed 7/7 after that edit.
Filtered runs used during iteration are **PARTIAL** and are not quoted as gates. No commit, push,
merge, publish, deploy, installed-app replacement, live provider call or upload occurred. The one DMG
was built and verified locally at the owner's explicit request as a temporary artifact (see the
`dist:smoke` row above).

### Gateway / Tailscale environment (operational)

- The owner moved the **gateway** to `http://0.0.0.0:8787` (installed `/Applications/gateway-kh.app`,
  uvicorn `gateway.api:app`). Story Studio's built-in default is still
  `http://127.0.0.1:8000`, so a Mac using the default no longer reaches it; set
  **Settings → This Mac → Base URL** to `http://127.0.0.1:8787` locally, or
  `http://100.126.154.54:8787` from another tailnet machine.
- Tailscale HTTP is already supported by `normalizeServiceBaseUrl`: CGNAT `100.64.0.0/10`, `*.ts.net`
  MagicDNS, RFC1918, `169.254/16`, `.local`, plus any HTTPS host. A **bare short hostname**
  (`http://m2-max-32-512:8787`) is deliberately rejected. There is no plan to change that; use the IP
  or the full `.ts.net` name.
- **`ELECTRON_RUN_AS_NODE` gotcha (fixed):** this shell exports `ELECTRON_RUN_AS_NODE=1`; the release
  smoke launcher inherited it, so the packaged app ran as Node and rejected `--user-data-dir`, which
  surfaced as a false "the app exited before its backend started". `scripts/release/smoke-launch-artifact.mjs`
  now deletes that variable before spawning. Release lane re-run after the fix: exit **0**, 36/36.

## Review log

- **2026-09-21 — Astra:** created this execution index from current main, the 89-candidate ledger,
  appendix and completed local release evidence. Queried the existing code-only graph and verified
  cancellation/source/test anchors. No new bugs claimed reproduced, no runtime edits, no workers
  spawned, and no application tests rerun for this documentation-only handoff. DS-01 is next.
- **2026-09-21 — DeepSeek lead (takeover):** owner-directed full takeover of development,
  architecture, investigation, implementation, review, testing and status for this checkout. No
  spawned agents; one writer, one test lane. Recorded inherited dirty state before editing: tracked
  modifications `CHANGELOG.md`, `electron/server/services/job-queue.ts`, `package-lock.json`,
  `package.json`; untracked `Story Studio Project Status.md`, `docs/handoffs/deepseek-worker-prompt.md`,
  `docs/handoffs/deepseek-reports/DS-01.md`, `electron/server/__tests__/job-cancellation-missing-key.test.ts`.
  Created branch `codex/stabilization-takeover` from `6f3c4e33` and preserved the inherited diff.
  Removed the obsolete external-assigner/acceptance gating from this file and the worker prompt;
  historical evidence and dates were preserved rather than rewritten. **DS-01 verified and accepted
  by self-acceptance:** the prior worker's GREEN was rerun in-session (35/35, exit 0) and the RED half
  was independently reproduced by temporarily reverting only the dedupe guard (exit 1, `4 !== 1`),
  then restored byte-identically (sha256 `b9e0082c…`). Base SHA `6f3c4e33`; branch
  `codex/stabilization-takeover`; version 1.4.214 pending; no commits/pushes/publish/paid calls.
  Next packet: DS-02 (H-17), active.
- **2026-09-21 — DeepSeek lead, DS-02 (H-17):** `reproduced-fixed`, self-accepted. Traced the
  restart-recovery caller chain in current source and disproved the stale half of the claim
  (unsettled durable evidence already routes to read-only reconciliation with no generation POST).
  Reproduced a real dead end: `metadata`/`image_prompts`/`research_run` have no registered
  completion auditor, so after a settled provider read `finalizeSettledProviderJob` left the row
  `running` forever — no reconcile timer, no Retry, Abandon as the only exit. RED 3/6 (exactly those
  types; both controls green), then a one-branch repair failing loudly with retained evidence and a
  repair/Retry message. GREEN 6/6 exit 0; affected regression 238/238 exit 0; `typecheck:electron`,
  `check:changelog`, `git diff --check` all exit 0. Found and confirmed a pre-existing environment
  gap: backend tests need `bundled/ffmpeg` on PATH (`NEW-03`). Recorded `NEW-02` (missing auditors
  for several text types). Report: `docs/handoffs/deepseek-reports/DS-02.md`. No commits/pushes.
  Next packet: DS-03 (S-04), active.
- **2026-09-21 — DeepSeek lead, DS-03 (S-04):** `reproduced-fixed`, self-accepted. Traced
  `getAudioStatus`'s model-resolution precedence; the durable per-episode record already fixed the
  general case, but the legacy `audioJobs[0]` borrow still handed the newest job of ANY episode to
  this one. Reproduced with a fake live voice catalogue: two episode models, no local match → 12
  phantom `_partN` files from another episode's small-budget model. RED 1/7 (both controls green),
  then a minimal ownership fix (own job, or a project-wide model only when history is unambiguous).
  GREEN 7/7 exit 0; audio regression 28/28 files, 117/117 exit 0; `typecheck:electron`,
  `check:changelog`, `git diff --check` exit 0. Report: `docs/handoffs/deepseek-reports/DS-03.md`.
  No commits/pushes. Next packet: DS-04 (S-06), active.
- **2026-09-21 — DeepSeek lead, DS-04 (S-06):** `reproduced-fixed` (character-sheet) plus
  `already-correct` for the other six named pages. Current source had already fixed broll,
  scene-review, images, research, motion-review and metadata; the remaining gap was
  `character-sheet.vue` leaving the previous episode's continuity `config` live until the awaited
  reload. Fixed with a synchronous blank and extended `episodeScopedStateReset.test.ts` to the three
  uncovered pages. RED 6/7 (fix reverted) → GREEN 7/7; related frontend regression 58/58 exit 0;
  `check:changelog` and `git diff --check` exit 0. Found `NEW-04`: `npm --prefix frontend run
  typecheck` exits 2 on 11 pre-existing errors in untouched files — recorded, not claimed green.
  Report: `docs/handoffs/deepseek-reports/DS-04.md`. No commits/pushes. Next packet: DS-05 (Q-02).
- **2026-09-21 — DeepSeek lead, DS-08 (Q-06–Q-10, F-11):** `reproduced-fixed` for five concerns,
  `not-reproduced (latent)` for Q-09, self-accepted. Measured the pre-fix label drift against the
  live 33-type union (useJobs 6 missing, useNotifications 7, EpisodeSelector 20, jobs.vue 0) and
  replaced all four maps with one authority in `utils/job-presentation.ts`. Retry admission now
  mirrors the backend's legacy prompt/image mode rules per-row and in bulk; the dead Scene Images
  tabs are removed; a filter that hides a nonempty list says "No matching jobs"; the subtitle Retry
  tooltip no longer names an unrendered Repair control. Q-09's unserved `_app_` finish-missing-images
  URL is unreachable today and was documented, not patched. Also repaired the `jobsRetryAllManualFinish`
  stub preamble that the refactor left unresolved (it hung the lane's isolation child). Focused
  frontend 92/92 exit 0; full frontend lane exit 0, 1,888 pass, 210/210 files; `check:changelog` and
  `git diff --check` exit 0; frontend typecheck unchanged at the 11 pre-existing errors (`NEW-04`).
  No backend file changed. Report: `docs/handoffs/deepseek-reports/DS-08.md`. No commits/pushes.
  Next packet: DS-09 (E-01, E-02, E-03, E-06, E-10).
- **2026-09-21 — DeepSeek lead, DS-09 (E-01, E-02, E-06) + split:** `reproduced-fixed` for three
  read-failure-vs-empty distinctions, self-accepted; **E-03 and E-10 split to DS-09b**. Scene Review
  now sets `reviewError` in the read catch and shows a retry instead of "No scene plan yet";
  Research's `sourcesError` is checked before the "not configured" reason so a failed read never
  sends the user to re-enter a valid key (and `canRun` still refuses a paid run while unknown);
  Pipeline renders a `epError` branch with Retry instead of "No accepted ideas yet". RED against the
  three pages at HEAD: 0/3; restored byte-identically (sha256 `14bdf595…` / `39bf7536…`), GREEN
  `workspaceReadFailures` + 14 affected files 114/114 exit 0; full frontend lane exit 0, 1,891 pass,
  211/211 files; `check:changelog` and `git diff --check` exit 0; frontend typecheck unchanged at the
  11 pre-existing errors (`NEW-04`). Report: `docs/handoffs/deepseek-reports/DS-09.md`.
  No commits/pushes. Next packet: DS-09b (E-03, E-10).
- **2026-09-21 — DeepSeek lead, DS-05 (Q-02):** `already-correct`, self-accepted; no production
  change. Traced the run-batch ordering: the inline `character_sheet` write sits after the
  idempotency filter, so a skipped-as-done step leaves `continuity.json` byte-identical, and an
  episode aborted after the write still reports `character_sheets_applied`, which the Pipeline
  receipt renders beside the skip reasons. Added two regression cases to `pipeline-step-skip.test.ts`;
  `--only pipeline-step-skip` exit 0, 31/31. Report: `docs/handoffs/deepseek-reports/DS-05.md`.
  No commits/pushes. Next packet: DS-06 (H-13).
- **2026-09-21 — DeepSeek lead, DS-06 (H-13):** `reproduced-fixed`, self-accepted. The subtitle
  `force_style` fallback in both assemblers dropped requested word modes/animation/wrapping and only
  logged it; `result.degraded` stayed empty while the job reported `done`. `requiresAssDocument`
  already existed for this decision and had no callers. Added `assOnlySubtitleFeatures(style)` and
  wired both fallbacks into `declareJobDegraded` (status stays done, file kept). RED via the wiring
  guard (exit 1, 8/9; files restored byte-identically); GREEN `--only job-degradation
  --only subtitle-ass` 23/23; subtitle/broll/video regression 41/41 files, 534/534 exit 0;
  `typecheck:electron`, `check:changelog`, `git diff --check` exit 0. Limitation: no end-to-end
  render (needs ffmpeg + media); RED is the source-wiring guard. Report:
  `docs/handoffs/deepseek-reports/DS-06.md`. No commits/pushes. Next packet: DS-07 (Q-04, E-11).
- **2026-09-21 — DeepSeek lead, DS-07 (Q-04, E-11):** `reproduced-fixed` both, self-accepted.
  The app-wide `/jobs/app/stream` was the odd sibling out: hand-rolled `send`, only
  `console.error` on a failed snapshot, and update listeners registered before the snapshot read.
  Converted it to `createBufferedJobStream` + `sendSnapshotError()`, matching
  `/projects/:slug/jobs/stream` and `/jobs/all/stream`. The one-way SSE→polling fallback was left
  intact (documented, converges, stale-safe). E-11: `queuePaused` became `boolean | null`; an
  unreadable queue status now clears to unknown, the paused banner requires a known pause, and the
  control is disabled with an explicit notice. Backend focused 22/22 exit 0; frontend focused 76/76
  exit 0 (one toolbar-expression expectation updated); `typecheck:electron`, `check:changelog`,
  `git diff --check` exit 0. Report: `docs/handoffs/deepseek-reports/DS-07.md`. No commits/pushes.
  Next packet: DS-08 (Q-06–Q-10, F-11).
- **2026-09-21 — DeepSeek lead, checkpoint + full verification:** serialized full gates on the
  takeover snapshot — full backend exit 0 (5,598 tests, 5,597 pass, 1 explicit skip, 511/511 files),
  full frontend exit 0 (1,879 pass, 209/209 files), release lane exit 0 (36/36), Content Pack lane
  exit 0 (368 tests, 366 pass, 2 external-evidence skips), production build exit 0, lint exit 0
  (0 errors), four dependency audits 0 vulnerabilities, Electron typecheck exit 0. **Frontend
  typecheck is NOT green**: 11 pre-existing `TS2558` `$fetch<T>()` errors in untouched files
  (`NEW-04`), recorded rather than worked around. DS-01 … DS-07 are complete and self-accepted.
  Session ends here on context limits, not on a blocker. **Exact resume point:** start DS-08
  (`Q-06`–`Q-10`, `F-11`) from `frontend/pages/projects/[slug]/jobs.vue`,
  `frontend/utils/job-presentation.ts`, `frontend/composables/useJobs.ts`,
  `frontend/components/EpisodeSelector.vue`, with the backend Jobs route/control definitions as the
  authority; the queued scope cards for DS-08 … DS-16 remain in this file. Outstanding follow-ups:
  `NEW-02` (missing completion auditors for several text job types — **closed in SMALL-01, goal round 3**), `NEW-03` (bundled ffmpeg on
  PATH for backend tests — **closed in SMALL-01**), `NEW-04` (frontend typecheck — **closed in SMALL-01**), `NEW-05`/`NEW-06`/`NEW-07` (fixed in
  1.4.215), `NEW-01` (control names the missing key — **closed in SMALL-01**), `NEW-10` (regenerated row names the chosen style — **closed in SMALL-01**), `NEW-08` (external: a private Content Pack is registered without its source directory, and
  as of 2026-09-22 the same effort's untracked `content-packs/rebuilt/` `<slug>-v2` packs also trip
  three cross-pack-overlap guards; all four backend-gate failures are external to Story's own code).
  No commits/pushes/paid calls.
- **2026-09-21 — DeepSeek lead, owner-directed fix-list additions (DS-17):** diagnosed the owner's
  "video computer can't use the gateway over Tailscale" report from their screenshots and gateway
  probes. Confirmed the Tailscale URL (`http://100.126.154.54:8787`) and the `gw-1_…` key are accepted
  (the key-test probe passed `/v1/tts/models` and the job routes; the gateway reports 1,687 models,
  124 publishable) and that the visible **HTTP 503 is the gateway's deliberate
  `CONTENT_STORE_NOT_CONNECTED` stub**, not a key/URL/Tailscale problem. The remaining catalog
  `0/0 · never fetched` is attributed to the stale 1.4.210 install, not the gateway; recommended
  installing the built 1.4.214 DMG. The owner asked for two follow-ups in the next build, recorded as
  **DS-17**: `NEW-05` — a disconnected Content Store must not be reported as "check the API URL and
  key"; `NEW-06` — the built-in `DEFAULT_GENSTUDIO_URL` is stale at `:8000` and should move to
  `:8787`. No runtime change was made for these yet (the 1.4.214 DMG is already built); DS-17
  reserves the next free patch version and its own CHANGELOG entry. No commits/pushes/paid calls.
- **2026-09-21 — DeepSeek lead, owner-requested temp DMG + Tailscale investigation:** checked the
  owner's Tailscale/gateway question against current source. Confirmed Story Studio **already**
  accepts Tailscale HTTP (`100.64.0.0/10`, `*.ts.net`) and that a bare short hostname is deliberately
  rejected — no code change needed for the client. Verified `100.126.154.54:8787` answers `401` (the
  gateway moved to `0.0.0.0:8787`), and recorded the per-Mac Base URL/port facts above. Built the
  owner-authorized unsigned arm64 DMG from the current **uncommitted** 1.4.214 worktree:
  `dist/Story Studio KH 1.4.214-arm64.dmg`, 241,994,062 bytes, sha256 `0012f57d…`, verified (ad-hoc,
  read-only mount, 98-package closure, launch smoke served `/api/health` in ~1.1s). This is a
  worktree temp artifact, not an integrated main release, and the installed app was not replaced.
  Found and fixed a release-tooling environment bug: this shell exports `ELECTRON_RUN_AS_NODE=1`,
  which the smoke launcher inherited, so the packaged app ran as Node, rejected `--user-data-dir`,
  and produced a false "app exited before its backend started". `smoke-launch-artifact.mjs` now strips
  that variable before spawning; verification then passed in the same shell and the release lane
  re-ran green (36/36). No commits/pushes/paid calls.
- **2026-09-21 — DeepSeek lead, DS-17 shipped as 1.4.215:** the owner reported two follow-ups
  (`NEW-05`, `NEW-06`) and then an urgent third from a Jobs screenshot — the model row names the
  model but not the provider (`NEW-07`). Root cause for NEW-07 traced to the frontend dropping
  `provider_name` at display time even though the backend returns it for every catalogue; fixed with
  `buildGenStudioModelProviderEntries` + `useGenStudioModelDisplay.providerName()`, rendered as
  `Model: <name> · <provider>` (display only, absent when unpublished, remembered for old rows).
  NEW-05 now recognises gateway-kh's deliberate `503 CONTENT_STORE_NOT_CONNECTED` and reports
  "not connected" instead of blaming the key/URL; NEW-06 moved the built-in default to
  `http://127.0.0.1:8787` (four default-pinning test files updated, including one regex-escaped
  occurrence a naive replace missed). Focused backend 143/143 exit 0; frontend focused 72/72; full
  frontend lane exit 0, 1,893 pass, 211/211 files; `check:changelog` (1.4.215), `typecheck:electron`
  and `git diff --check` exit 0; frontend typecheck unchanged at the 11 pre-existing errors
  (`NEW-04`). Built and verified `dist/Story Studio KH 1.4.215-arm64.dmg` (241,998,873 bytes,
  sha256 `726fbfe8…`) in one pass — the earlier `ELECTRON_RUN_AS_NODE` launcher fix held, so no
  workaround was needed. Worktree temp artifact; installed app not replaced. Report:
  `docs/handoffs/deepseek-reports/DS-17.md`. No commits/pushes/paid calls.
- **2026-09-21 — DeepSeek lead, DS-17 full backend gate + external content-pack failure:** the
  re-run at 1.4.215 was exit **1** with exactly one failure, `topic-pack-anti-padding` ENOENT on
  `content-packs/private/topic/keeping-food-before-refrigeration/content`. The cause is external:
  `content-packs/authoring-registry.json` was rewritten during this session (revision 289→290,
  coordinator `codex/content-pack-delivery`, task "Gateway private Content Pack acceptance") to
  register a private Topic Pack whose source is not on this Mac. That file was **not** in the
  session-start dirty set and is not touched by any 1.4.215 change; it was preserved rather than
  reverted. All other 5,597 backend tests passed, including every 1.4.215 test. Recorded as
  `NEW-08`; the content-pack delivery effort needs to place the source directory (or the registry
  entry completed) before the full backend gate can be green again. No commits/pushes.
- **2026-09-22 — DeepSeek lead, DS-09b (E-03, E-10):** `reproduced-fixed` both, self-accepted. E-03:
  `pipeline.vue` and `audio.vue` encoded a failed channel-`/segments` read as `channelIntroEnabled =
  false`, which silenced the pre-spend warning, dropped the Introduction step from a batch, and told
  the user the channel had no opening. Both now use a tri-state flag, show an honest "could not check"
  warning with Retry, and include the step only when the channel is known to open with one. E-10:
  `deletePlan` cleared `plan` but left the disk-derived `status.scene_plan` true, so the "3. Scenes"
  section rendered heading-only; the section is now gated on `plan || planning` and the no-plan card
  offers **Build the plan**. RED at HEAD (3 pass / 2 fail, files restored byte-identically); GREEN
  5/5; affected regression 112/112; full frontend lane exit 0, 1,895 pass, 211/211 files;
  `check:changelog` (1.4.216) and `git diff --check` exit 0. Version now **1.4.216** (pending, no DMG
  yet). Report: `docs/handoffs/deepseek-reports/DS-09b.md`. No commits/pushes. Next packet: DS-10.
- **2026-09-22 — DeepSeek lead, DS-10 (E-04, E-05, E-07, E-08, E-09):** `reproduced-fixed` all five,
  self-accepted. All five collapsed "could not read" into "nothing there" (AGENTS.md §6): a failed
  asset scan blanked Step 1 over a toast; a rejected transition-catalogue read sat on "Loading
  transitions…" forever; Step 5 announced "No subtitle file for this episode yet" before and after a
  failed status read; the Subtitles page claimed no chapter audio after a failed read; and the
  chapter selector said "Generate the script first" when it had simply failed to read the sections.
  Each now carries an explicit loading/failed state with an honest message and a Retry, and a failed
  read never clears a genuine value or authorizes stale input. RED by base-commit absence of every
  asserted identifier (all `grep -c` at `HEAD` = 0) plus two behavioural `scanAssets()` cases; GREEN
  7/7; affected regression 24 files, 251/251; full frontend lane exit 0, 1,902 pass, 212/212 files,
  2,105 marks; `check:changelog` (1.4.216) and `git diff --check` exit 0; frontend typecheck
  unchanged at the 11 pre-existing `NEW-04` errors. Report:
  `docs/handoffs/deepseek-reports/DS-10.md`. No commits/pushes. Next packet: DS-11.
- **2026-09-22 — DeepSeek lead, DS-11 (F-04, F-05):** `reproduced-fixed` both, self-accepted. F-04:
  the FFmpeg card's tab never fetched the status, so entering "Files & maintenance" showed an expanded
  recovery download for an unread status, and a failed check was written as `{ installed: false }`
  ("not installed" instead of "could not check"). The tab now probes `/ffmpeg/status`, a failure is an
  explicit unknown with Retry, and the installer and manual fallback require a real status. F-05:
  `category_id` lives on ProjectConfig, but the project-meta watcher blanked it on every `project`
  replacement while `loadProject()` fetches meta and config in parallel — meta landing after config
  wiped the hydrated category and the next Publishing save persisted the silent clear. The reset moved
  to the slug watcher, so a same-project refresh preserves the saved value and an unsaved change, while
  switching projects still blanks and re-hydrates from that project's own config (AGENTS.md §4).
  RED by restoring `settings.vue` from `HEAD` (1 pass / 3 fail, exit 1) then restoring byte-identically
  (sha256 verified); GREEN 4/4; affected regression 56/56 and 124/124 exit 0; full frontend lane exit
  0, 1,905 pass, 212/212 files, 2,108 marks; `check:changelog` (1.4.216) and `git diff --check` exit 0;
  frontend typecheck unchanged at the 11 pre-existing `NEW-04` errors. Report:
  `docs/handoffs/deepseek-reports/DS-11.md`. No commits/pushes. Next packet: DS-12.
- **2026-09-22 — owner decisions walked one at a time (recorded, no code changed):**
  - **X-06 — reusable Scene Plan guidance: decided preset-only.** The owner chose a reusable guidance
    field whose text travels in Scene Plan presets and is applied deliberately to one episode. It must
    never write project config, never apply itself, and stay distinct from the per-episode
    `custom_instructions` (owner decision #9). Implementation queued as its own bounded packet; no
    project-level default and no migration, and existing presets are left untouched.
  - **X-07 — live paid / upload / signed distribution: decided bounded paid generation only.** The
    owner authorized one real generation on the cheapest published model under a hard credit ceiling
    to be agreed and recorded before the call, proving real cost, provider provenance and artifact
    ownership. A real YouTube upload and signed/notarized public distribution are deferred and remain
    **unauthorized**; both stay recorded as unverified limits. No paid call runs until the model, the
    ceiling and the proving checks are written into this record first.
  - **X-04 — external evidence: decided skips retained.** The owner elected to keep the two Symbolic
    Psychology checks as explicit external-evidence skips with honest wording. The documented evidence
    root `~/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23` does not
    exist on this Mac and Spotlight finds none of the four required files, so the lane stays
    **366 pass / 2 explicit skips** and nothing may call them passed. Recoverable later with one
    command if the folder ever turns up.
  - All three owner decisions on the board (X-04, X-06, X-07) are now resolved; nothing in the queue
    remains blocked on an owner ruling. The next owner contact points are the bounded paid-check
    ceiling, the `ACCEPT-01` manual acceptance, and `RELEASE-01` release authorization.
- **2026-09-22 — DeepSeek lead, X-06 implementation (preset-only reusable Scene Plan guidance):**
  complete, self-accepted. `scene-plan.vue` gained a second, clearly labelled **Reusable guidance**
  box whose text is captured by Scene Plan presets and applied only when the customer applies one —
  never written to project config, never applied on its own, and `reusable_guidance` deliberately left
  out of `excludeKeys` because the preset is its only durable home (AGENTS.md §5's two-way trap).
  `custom_instructions` remains excluded (owner decision #9) and, found in the same area, is now
  cleared on an episode change with an announcement instead of silently steering the next episode
  (§4). `frontend/utils/scene-plan-guidance.ts` composes the two boxes into the single guidance input
  the backend already accepts, so no provider contract was widened; every one of the three request
  sites uses it, and a lone box produces the pre-X-06 payload byte-for-byte. RED at `HEAD` (19 pass /
  3 fail, exit 1; `scene-plan.vue` restored byte-identically, sha256 verified); GREEN 22/22;
  regression 174/174; full frontend lane exit 0, 1,914 pass, 213/213 files, 2,117 marks; `npm run
  lint` exit 0 with 0 errors; `npm run build` exit 0; `check:changelog` (1.4.216) and
  `git diff --check` exit 0; typecheck unchanged at the 11 pre-existing `NEW-04` errors. Report:
  `docs/handoffs/deepseek-reports/X-06.md`. No commits/pushes. Next: DS-12.
- **2026-09-22 — DeepSeek lead, DS-13 (Q-03):** measurement complete, **no production change**.
  The audit alleged "job persistence/SSE clone unbounded output"; the assignment was to establish an
  observed user-impact case before proposing caps or caching, so `scripts/developer/
  measure-job-persistence-cost.ts` drives real persistence passes and the real SSE serialization at
  100 / 1,000 / 10,000 log lines, on a full 750-job terminal history, and on a 200-mutation burst.
  Medians of three passes on an M2 Max: 6.7 / 7.5 / 20.8 ms and 0.01 / 0.06 / 0.56 MiB; the full
  history 36.7 ms and 0.96 MiB; one SSE frame 4.9 / 39.2 / 400.6 KiB per subscriber; a 200-mutation
  burst coalesces to **1 atomic write**. A read-only scan of the owner's nine real projects on the
  external Library volume shows the observed maximum is **592 lines in one job (~100 KB record) and
  0.67 MiB `jobs.json`** — an order of magnitude below the point where either cost matters. No caps,
  no caching, no truncation, and no new test (the coalescing and retention invariants are already
  pinned by `job-queue-evidence-coalescing`, `job-cancellation-missing-key` and
  `job-queue-persistence-retention`). A latent threshold (~5,000–10,000 lines in one job) is recorded
  for a future decision instead of acting on it. Report: `docs/handoffs/deepseek-reports/DS-13.md`.
  No commits/pushes. Next: DS-14 (DS-12 deferred to a session with the app on screen).
- **2026-09-22 — DeepSeek lead, WIRE-01 + WIRE-02 (gateway-kh wire-kind parity letter):** both asks
  answered and implemented, self-accepted. **Ask 1** (`lettering-style` ↔ `font_pack`): the letter's
  diagnosis was corrected against source — the wire kind has parsed since 1.4.62, installation is
  archive-manifest driven and kind-agnostic (it already worked), and `letteringCatalogue()` already
  listed installed packs since 1.4.57. The **real** gap was the runtime consumer: the synchronous
  thumbnail prompt builders resolved the chosen style id against the hardcoded
  `FONT_STYLES`/`TEXT_STYLES` maps only, so a bought pack style silently became the built-in serif and
  `letteringPhrase()` sat exported and unused. `letteringPhraseMaps()` now resolves the installed
  catalogue once per run; both builders honour it, built-in and unknown ids are unchanged, and a
  catalogue read failure records an honest job line instead of downgrading a paid style. Proving it
  uncovered a second real defect: `frontend/content-store/persisted-catalog.ts` kept its own
  product-kind list that had never learned `font_pack`, and because its reader treats one unrecognised
  product as a corrupt document, **the catalogue saved on this Mac was discarded on every load** once a
  font pack was in it. The wire kinds now live in one leaf module whose array defines the type.
  **Ask 2** (`metadata_formula`): the owner accepted; the runtime was already built, so the work was
  the wire kind plus the Store label/order/filter. Minimum app version for both kinds: **1.4.216**
  (pending; the reply letter tells the Gateway not to publish before it is released). Evidence: RED at
  `HEAD` for the prompt bridge (4 pass / 3 fail, file restored byte-identically) and for the persisted
  reader (16 pass / 1 fail, restored); GREEN `lettering-pack-bridge` 7/7,
  `metadata-formula-pack-bridge` 3/3, `contentStorePersistedCatalog` + `contentStoreLibrary` 31/31;
  affected regression 219/219; full backend gate **5,605/5,610 pass with all 4 failures external**
  (`NEW-08` plus three cross-pack-overlap guards tripped by the external effort's untracked
  `content-packs/rebuilt/` v2 packs); full frontend lane exit **0**, 1,915 pass, `213/213 file(s)`;
  `npm run build` exit 0; lint 0 errors; `check:changelog` and `git diff --check` exit 0. Reports:
  `docs/handoffs/deepseek-reports/WIRE-01-font-pack-bridge.md`, `WIRE-02-metadata-formula-kind.md`;
  reply letter: `_handoffs/2026-09-22_story-response-wire-kind-parity.md`. No commits/pushes/paid calls.
- **2026-09-22 — gateway-kh verification response, confirmed and recorded:** gateway-kh independently
  re-checked the working tree rather than accepting the answer — `PRODUCT_KINDS`/union carry
  `metadata_formula`; the two kind lists are one leaf module; `letteringPhrase`/`letteringPhraseMaps`
  are imported and called by `generators/image-prompts.ts`; and they **ran
  `lettering-pack-bridge.test.ts` themselves (7 pass / 0 fail)**. They accepted the correction that
  install/activate and the picker already worked and the real gap was the prompt layer. Their
  criterion 4 side publishes exactly `topic_pack 45 · series_formula 19 · visual_style 40 ·
  thumbnail_recipe 36`, matching the spelling table. They are **holding publication**, and the hold is
  load-bearing rather than politeness: the installed app on this Mac is **1.4.213**, where an
  unrecognised `metadata_formula` throws in `parseContentStoreCatalog` and takes the whole catalogue
  down, and a `font_pack` would parse but the persisted-catalogue defect would discard the saved
  catalogue on every load — both fixed in 1.4.216. **The `lettering-style → font_pack` exception is
  noted on both sides**: their mechanical `kind.replace("-", "_")` map would emit `lettering_style`,
  and `lettering-style` is the **only** accepted kind whose wire spelling is not mechanical, so the
  exception is added in the same change that enables the kind. 1.4.216 also completes the free-form
  "custom" lettering text they had listed as ours to schedule, so their acceptance run will include
  it. Acknowledgement written to `_handoffs/2026-09-22_story-ack-gateway-verification-and-ping.md`;
  the ping obligation is recorded as **PING-01** — when the 1.4.216 DMG exists, name the artifact,
  version and digest in `_handoffs/` as the signal for their steps 1–4. No commits/pushes.
- **2026-09-22 — DeepSeek lead, WIRE-03 (free-form "custom" lettering text):** `reproduced-fixed`,
  self-accepted. The Image Prompts page collected `thumb_font_style_custom` /
  `thumb_text_style_custom`, and `resolveFontStyle` / `resolveTextStyle` always accepted a
  `customText` — but the run payload sent only the `custom` id and neither builder passed a second
  argument, so the customer's own description was silently replaced by the built-in serif (font) or
  gold (text) while the form still showed what they typed. The payload now sends each description only
  when `custom` is the chosen id, and both builders pass them through; a blank description still falls
  back and a built-in id still ignores stray text. RED at `HEAD` for `image-prompts.ts` (2 pass / 6
  fail, restored byte-identically) and for `image-prompts.vue` (7 pass / 1 fail, restored); GREEN
  backend 8/8 and frontend 8/8; full backend gate **5,613/5,618 with the same 4 external failures**
  (the concurrent content-pack re-authoring effort's `content-packs/rebuilt/` changed *during* the
  run); full frontend lane exit **0**, 1,916 pass, `213/213 file(s)`; `npm run build` exit 0; lint 0
  errors; `check:changelog` and `git diff --check` exit 0. Report:
  `docs/handoffs/deepseek-reports/WIRE-03-custom-lettering-text.md`. Recorded `NEW-10` (the single-row
  regenerate route passes no style to the enforcement clause) and left it out of scope. No
  commits/pushes.
- **2026-09-22 — 1.4.216 DMG built and verified (owner-authorized temp artifact); PING-01 answered:**
  `npm run dist:smoke` exit **0** in one pass (its own `fetch:ffmpeg`, `build`, `check:release
  --built --package-input`, packaging, then `verify-desktop-artifact`): **`dist/Story Studio KH
  1.4.216-arm64.dmg`**, 242,027,066 bytes, sha256
  `cf3a6f0627556ef39225972910a116797446b6a608059bfa453ff5f21a8d1be6`; bundle
  `com.storystudio.kh v1.4.216` (arm64, `CFBundleShortVersionString` 1.4.216); ad-hoc signature (no
  Developer ID, so Gatekeeper quarantines it — `xattr -dr com.apple.quarantine "/Applications/Story
  Studio KH.app"` on the destination Mac); DMG mounts read-only; 98-package closure in `app.asar`;
  launch smoke booted the packaged app and served `/api/health` + Upload Center on a live port in
  2,399 ms. The three fixes were confirmed **inside the packaged `app.asar`** (`metadata_formula`,
  `letteringPhraseMaps`, `thumb_font_style_custom`, `lettering-style` all present), not merely in the
  source tree. This is a **worktree build of the uncommitted 1.4.216 change set**, not an integrated
  `main` release; the installed app was not replaced and nothing was committed, pushed, published or
  notarized. Ping written to `_handoffs/2026-09-22_story-ping-1.4.216-dmg.md` as the signal for
  gateway-kh's steps 1–4 (both kinds, `min_app_version: "1.4.216"`, plus the `lettering-style →
  font_pack` exception). `RELEASE-01` remains open for integration/commit and any signed release.
- **2026-09-22 — owner-authorized save and backup (commit + push):** at the owner's explicit request the
  session work was committed as **`498c19cc`** — *"fix: read-failure honesty, Settings status, and the
  Content Store wire contract (v1.4.216)"* — **96 files, 6,308 insertions, 337 deletions**, and pushed
  to `origin/codex/stabilization-takeover` (new branch, tracking set; remote head `498c19cc`; `main`
  untouched). The commit contains **only this session's work**: the other effort's in-flight
  `content-packs/rebuilt/` and `content-packs/authoring-registry.json` were deliberately left modified
  and untracked working-tree state, per the rule against sweeping unrelated work into a commit. The
  branch is **not** integrated into `main`, no pull request was opened, and the commit author resolves
  to the machine-local identity `vengtheng@build-mac.local` (git config was not set), which
  is cosmetic and worth correcting before any integration. No signed/notarized release was built.
- **2026-09-22 — DeepSeek lead, DS-14 (M-08, model-drift guard):** `fixed`, self-accepted. The guard is
  now exercisable on fixtures (exports `analyzeModelDriftSource`, `scanForModelDrift`,
  `modelDriftRules`, `modelDriftScanRoots`; the refactor is behaviour-preserving — original and
  refactored scripts print byte-identical output). Two real defects found: the coarse pre-filter could
  hide a whole file (`controls.X` and fields like `max_reference_images` contain none of its trigger
  words — the gate is **removed**, a full scan is 0.81 s for 708 files), and the documented
  module-specifier exemption never matched a quoted specifier. Removing the gate surfaced a **live**
  finding (`frontend/utils/genstudio-relaxed-queue.ts:55` rendered a dollar figure — GenStudio's own
  published cents value), which now carries one written `model-drift-allow` (39 exceptions). RED by
  restoring the pre-filter (2 fail / 5 pass) and by running `HEAD`'s guard with the annotation removed
  (exit 0 — missed) against the fixed guard (exit 1); both files restored byte-identically. Release
  lane exit 0, **43/43**, `5/5 file(s)`; frontend lane exit 0, 1,916 pass; `npm run build` exit 0.
  Report: `docs/handoffs/deepseek-reports/DS-14.md`.
- **2026-09-22 — DeepSeek lead, DS-15 (X-01, audio freshness vs script):** `reproduced-fixed`,
  self-accepted. The recorded script fingerprint hashed the run's **transformed** text (expression
  tags swapped in, auto-pacing appended) while the check recomputed it by normalizing the script file,
  so any expression or auto-pacing run reported "the script changed" with nothing changed — measured
  `sha256:4bb06c57…` (recorded) vs `sha256:54e1d39b…` (recomputed). `chapterScriptFingerprint()` is now
  the single implementation both sides use, and the generator captures it immediately after parsing,
  before every transformation. A real script edit still changes the fingerprint. RED with `audio.ts`
  at `HEAD` (2 fail / 5 pass, restored byte-identically); audio/tts regression **204/204**; full
  backend gate **5,620/5,625 with the same 4 external failures**, `515/515 file(s)`; `npm run build`
  exit 0; changelog bullet added for the user-visible false warning. Report:
  `docs/handoffs/deepseek-reports/DS-15.md`.
- **2026-09-22 — DeepSeek lead, DS-16 (X-02–X-05, historical reconciliation):** complete,
  self-accepted, **read-only — no production file changed**. All eight appendix blocks mapped to
  current source or released evidence: FIX-E2 integrated in 1.4.212 (an unpublished ceiling returns
  `null`; `hasPublishedPromptBudget` is copy only, so Next and the batch controls stay usable);
  FIX-CONTENT integrated (a durable `invalid_state_reset` recovery incident is written beside the
  quarantine); FIX-SETTINGS integrated (`?path=` containment applied at every site; the hardcoded
  `version: '0.1.0'` replaced by `resolveStoryStudioVersion()`; `lib/ttl-cache.ts` and its test
  removed); FIX-RECOVERY integrated (1.4.210); FIX-F decided and implemented as X-06. Two old notes
  corrected: `routes/debug.ts` **is** mounted and reachable (`routes/index.ts:84`) — support surface,
  gated by `requireSession` in server mode and by `requireAllowedHost` plus a loopback bind in desktop
  mode, so not an exposure; and three FIX-QUEUE bare pointers (`:684`, `:1659`,
  `routes/pipeline.ts:2202`) have no description and no longer match their lines, so **no work was
  revived**. The 57 non-open rows reviewed: 25 source-confirmed + 24 focused-green treated as release
  evidence and regression fixtures, H-09 folded into H-11 as its canonical duplicate, F-03/Y-07/P-05
  kept **dormant** (reachability unestablished, no speculative repair), and Z-06/M-05/M-06/Y-01 plus
  the four inherited retractions preserved. No new bounded packet: the leftovers are
  dormant-by-reachability, fail-closed by design, an unresolvable pointer, or measured in DS-13 with no
  observed impact. X-05's four limits are recorded with reachability and no architecture change is
  justified. Report: `docs/handoffs/deepseek-reports/DS-16.md`. No commits/pushes. Next: item 4 of the
  owner's list (small fixes: NEW-10, NEW-01, NEW-02, NEW-03, NEW-04).
- **2026-09-22 — goal re-armed.** The session goal was `disarmed` (the state a compacted/resumed
  session enters, which stops automatic continuation until a human says continue). The owner's
  "work your way through 1–6" is that instruction, so the goal was resumed (`activation: armed`) and
  items 3–6 continue in subsequent rounds.
- **2026-09-22 — DeepSeek lead, SMALL-01 (NEW-01, NEW-02, NEW-03, NEW-04, NEW-10):** all five fixed,
  self-accepted; **both typechecks are green for the first time this session.** NEW-04's root cause is
  Nuxt 4.5.2's missing generated `fetch.mjs`: the auto-import types `$fetch` with no type parameters,
  so the 11 `$fetch<T>` call sites became trailing assertions (type-only, no dependency change) —
  `npm --prefix frontend run typecheck` exit **0**. NEW-03: the backend test runner prepends the
  checkout's `bundled/ffmpeg` (RED at `HEAD`: 3 fail / 22 on `spawn ffmpeg ENOENT`; GREEN 62/62 with no
  manual prefix). NEW-01: the missing-key reason is recorded so the primary cancellation control names
  the key; the first attempt introduced a stale-reason regression the affected run caught (a configured
  key was still refused as missing), fixed in `requestJobCancellation` by dropping exactly that reason
  when a key now exists — `job-cancel` + `job-cancellation-missing-key` **81/81**. NEW-02:
  `image_prompts`, `metadata` and `research_run` register completion auditors reusing their generators'
  own proofs, with **both directions** pinned per type (RED 4 fail at `HEAD`; GREEN 4/4). NEW-10: a
  regenerated thumbnail row carries the workspace's four lettering fields into the enforcement clause
  (RED 2 fail; GREEN 11/11). Also fixed a round-2 slip `typecheck:electron` caught (an untyped `let dir`
  in the audio hash test). Full backend gate **5,628/5,633 with the same 4 external failures**,
  `516/516 file(s)`; frontend lane exit 0, 1,916 pass, `213/213 file(s)`; `npm run build` exit 0.
  Report: `docs/handoffs/deepseek-reports/DS-17b-small-fixes.md`. No commits/pushes. Next: item 5
  (visual checks, needs the app on screen).
- **2026-09-22 — DeepSeek lead, DS-12 first rendered pass (F-12–F-15):** in progress, report-only, no
  patch. Built a real rendered harness this packet previously lacked: the dev app run with a
  **disposable Library** (`/tmp/ssk-qa-data`) and `--remote-debugging-port`, driven over CDP to set
  viewports, measure every element's rect/scroll width (walking ancestors for `overflow-x: auto|scroll`
  so deliberate scrollers are not miscalled) and capture PNGs; fixtures seeded through the app's own
  API with a deliberately over-long project name and episode titles. The owner's installed app ran
  untouched throughout. Coverage: 13 routes × 1440×900 and 900×640; no page-level horizontal scroll
  anywhere. **Two exact failing consumers (F-15), both reproducible and both clipped by
  `main.main-content { overflow-x: hidden }`:** Scene Plan's "Avoided imagery" control at
  `1313..1533` (93px past the viewport, 156px past its card, no scroll ancestor), and Scene Review's
  `div.region.generate-region` CTA/status at `1150..1453` (13px past). The scene-plan finding is not
  mine: a live-DOM A/B hiding the new `.guidance-reusable` field leaves the rect identical, and the
  session diff only mentions `avoid_legible_text` in payload/preset hunks. Settings (F-14) measured
  with zero unreachable elements and no page scroll; F-12's 800×500 purchase dialogs, F-13's built-CSS
  specificity and F-15's keyboard traversal remain. Screenshots under
  `docs/handoffs/deepseek-reports/qa/`; report `docs/handoffs/deepseek-reports/DS-12.md`. QA app and
  Nuxt dev stopped afterwards. No commits/pushes/paid calls. Next: finish DS-12 (dialogs at 800×500,
  built-CSS specificity, keyboard traversal) and fix F-15a/F-15b under bounded ownership.- **2026-09-22 — DeepSeek lead, DS-12 fixes and second rendered pass (F-12–F-15):** complete. Patched the
  two reported consumers plus one more defect the rendered pass exposed, all in page-scoped CSS, then
  re-measured in the live renderer. **F-15a** — `.scene-creative-controls` demanded 680px inside a ~509px
  card, so "Avoided imagery" was laid out past the card and past the 1440px viewport and clipped; it is now
  two columns with the intensity picker spanning the row. A first attempt (shrink the three tracks to
  `minmax(0, …)`) fixed the geometry but squeezed the four intensity labels to one letter each, so it was
  rejected on the rendered result, not the numbers. **F-15b** — the review command bar's
  `minmax(350px,auto) minmax(420px,1fr) auto` tracks needed ~1189px in a ~1136px workspace at 1440, putting
  the CTA 13px past the viewport; the tracks may now shrink (`minmax(0, …)` + `min-width: 0`). **F-14 (new)**
  — the Notification center's `position: sticky; bottom: 10px` save bar was inert: it measured its natural
  document offset at every scroll position (1867/1411/955/500/44) because `.notification-panel
  { overflow: hidden }` made the panel the bar's own scroll container; `overflow: clip` keeps the corner
  clipping without being a scroll container, and the bar is now inside the viewport at all five offsets
  (833/377/117/117/54). **F-13** verified: all six named utilities are global in `assets/css/main.css`,
  unscoped in the built entry CSS, compute their declared values on consumers with no local rule
  (`.link-btn` on scripts, `.section-kicker` on pipeline), and style a probe element appended to
  `document.body` — the DOM position every teleported dialog occupies. **F-12** stays fixture-blocked: the
  Content Store in the disposable library has no scope or catalogue, so the purchase dialogs cannot be
  opened and none was attempted. Re-measured after the fixes: **0 unreachable** elements on both pages at
  1600/1400/1280/1100/1024/900 and at 1440×900 / 900×640 with no page scroll; Tab traversal reaches the
  Scene Plan input after 65/66 presses with the field in view and accepts typed text; the Scene Review CTA
  (now `1088..1391`) is skipped only because it is `disabled` in this empty fixture. Version moved to
  **1.4.217** with a changelog entry. Gates on the final tree: `check:changelog` exit 0, `typecheck` exit 0,
  frontend lane exit 0 (1,916 pass, 213/213 files), `npm run build` exit 0, backend gate 5,633 tests with the
  same 4 external `content-packs/rebuilt/**` failures (absent from `main`). Honest gap recorded: the 0%/25%
  sticky offsets rest on geometry because this harness stopped producing fresh frames below ~y=250 (two
  captures returned a byte-identical PNG). Screenshots `docs/handoffs/deepseek-reports/qa/ds12-*.png`; report
  `docs/handoffs/deepseek-reports/DS-12.md`. QA app and Nuxt dev stopped; installed app untouched. No
  commits/pushes/paid calls. Next: owner's item 6 (two-episode walkthrough) and the 1.4.217 commit/land/DMG
  decision.
- **2026-09-22 — 1.4.217 landed in `main`, DMG built and installed (owner instruction):** the three DS-12
  rendered fixes were cherry-picked onto `land/1.4.217-into-main` from `main` (`f56cd504`) — deliberately
  excluding the other effort's `8051fc28` — then `main` was fast-forwarded to `622f366a` and pushed.
  Release gate on that exact tree: `npm run test:backend` exit **0**, **5,633 tests, 5,632 pass, 0 fail,
  1 skip**, `516/516 file(s)`. `npm run dist:smoke` exit **0** in one pass (its own `fetch:ffmpeg`,
  `build`, `check:release --built --package-input`, packaging, `verify-desktop-artifact`):
  **`dist/Story Studio KH 1.4.217-arm64.dmg`**, 242,032,636 bytes, sha256
  `4c46892bbfe077c3956dec531e747b9594c4974227a0ffbcd29822da27a65e20`; bundle `com.storystudio.kh
  v1.4.217` (arm64); ad-hoc signature; DMG mounts read-only; 98-package closure; launch smoke booted the
  packaged app and served `/api/health` + Upload Center in 2,745 ms. The installed app was then replaced
  at the owner's instruction: the running 1.4.216 instance was quit first, the old bundle **moved** (never
  deleted) to `_trash/app/Story Studio KH 1.4.216.app`, the new bundle copied with `ditto`,
  `com.apple.quarantine` stripped, and the app relaunched **through LaunchServices** so it is owned by
  launchd and outlives this session. Verified after install: `/api/health` answers
  `{"status":"ok","version":"1.4.217","boot_complete":true}`, and the app's own server log shows the real
  Library serving `/projects`, `/app-settings/genstudio/overview` and `/library/notices` at 15:10–15:11
  local. The owner's Library and projects were never touched — the installed app was launched with no QA
  data dir. One environment note for future sessions: this shell exports `ELECTRON_RUN_AS_NODE=1`, which
  makes a **directly** launched packaged Electron app exit immediately with no output; the app itself is
  fine and a Finder/Dock launch is unaffected, and `scripts/release/smoke-launch-artifact.mjs` strips the
  variable. One hazard surfaced during the build and is recorded as **`NEW-11`**: packaging left the
  checkout's root `package.json` rewritten into its trimmed packaging shape (no `scripts`, no
  `devDependencies`), which would have broken every `npm run …` in that tree until it was restored from
  `HEAD`; the artifact was unaffected because the `build` step ran first, and the trimmed file is kept at
  `_trash/evidence/package.json.trimmed-by-packaging-1.4.217.json`. No paid model call and no upload
  occurred anywhere in this packet.
- **2026-09-22 — DeepSeek lead, ACCEPT-01 leg 1 (ideas → script) on a disposable Library:** started the
  owner's last ordered item with **fake provider outputs only** — the repository's own
  `MockGenStudioService` fixture hosted as a real loopback gateway (`scripts/developer/serve-mock-genstudio.ts`)
  and driven by `scripts/developer/accept-01-driver.ts`, which points a running dev app at it and then
  uses the app's own routes. Disposable Library `/tmp/ssk-accept-data` (nothing of the owner's touched;
  the installed 1.4.217 app was never involved). Backend identity proved first: after the URL/key PUT,
  `GET /app-settings/genstudio/overview` returned the mock's own account (`"Angkor Pro"`, 1,000 credits).
  Fresh setup seeded a project and **two episodes** (EP0001, EP0002) through ideas import + accept.
  **Leg 1 complete for both episodes** via the Scripts page's real routes: outline-only → `done` with 3
  slots, outline read back 3 slots, approval 200, expand-chapters → `done` with
  "3/3 chapter file(s) on disk (2 batches)" and a re-assembled `Script_Narration.md` (837 B / 843 B);
  chapter files 244/244/246 B each; 2 chat submissions per episode; **0 credits charged**. Cross-surface
  agreement recorded: `status.script: true` in the episodes status map (which the Production Board
  reads), four `done` script jobs in Jobs, and the byte sizes read from disk. Four **refusals** are kept
  as evidence for the malformed/partial/provider-failure requirement: a bare JSON array outline
  ("requires one JSON object"), invalid JSON, expansion before approval ("Outline is not approved yet"),
  and a partial expansion batch ("did not pass its one-repair completion check; missing 2") — each failed
  the job loudly and the passing run then wrote all three chapters without restarting from zero. Observed
  and recorded as design, not a defect: `pipeline/preflight` on a fresh project refuses every step with
  "No active preset for <step>" plus `missing_voice` for audio, so the remaining legs run either through
  each page's routes or after seeding one preset per step (key map `PRESET_KEYS` in `routes/pipeline.ts`).
  Remaining legs: audio → audio_merge (FFmpeg) → subtitles → scene plan → image prompts → images →
  video assembly → metadata/upload preparation (no upload), then restart/cancel/resume with the mock
  counting submissions, and a model switch. Report `docs/handoffs/deepseek-reports/ACCEPT-01.md`. No
  paid call, no upload, no publish; no commits/pushes in this entry.
- **2026-09-22 — DeepSeek lead, ACCEPT-01 legs 2–3 (audio → assembly → subtitles):** continued the
  walkthrough and made the provider gateway **long-lived** (`serve-mock-genstudio.ts`, now a thin proxy
  with a loopback-only control surface: queue a scenario / clear queued scenarios / read accounting), so
  provider job ids recorded in manifests still resolve across app restarts. A **second, canonical project**
  (`accept-01-walkthrough-v2-2026-09-22`) was seeded for this: the first project's audio manifest pointed
  at ids from short-lived mocks, and the app correctly **refused to re-submit** unverifiable work
  ("mock route not found" while polling the recorded ids) — the right behaviour, but not carryable
  forward. Leg 1 reproduced byte-for-byte on v2. **Leg 2:** TTS `done` for both episodes (3 chapters
  each, `mock-tts-001…006`, `Activated voice model boundary: mock-tts-v1`), chapter mp3s 3,789 B each;
  audio assembly `done` writing `… - 08 Audio Merge Output/<EP>_merged_audio.mp3` (57,095 B,
  `ffprobe` duration 2.3016 s, `mp3`), plus `_merged_audio.completion.json` (253 B) and
  `audio_chapters.json` (3 × 0.1 s, 1 s gaps — agrees with ffprobe). **No duplicate paid submission on
  re-run:** a second audio leg re-used verified files ("Skipping … (exists)") and the gateway's TTS count
  stayed at 6. **Finding:** two-pass loudnorm cannot measure the mock's silent audio — the merge failed
  honestly (`measured_I = -inf`, FFmpeg exit 222), named the retry path, kept verified partial files, and
  succeeded with the request's own `normalize_volume: false`; real TTS is never silent, so it is recorded
  as a fixture-induced edge case with correct local-failure handling. **Leg 3:** subtitles `done` for both
  (quote → confirm → SRT), `<EP>_whisper.srt` 59 B with cue `00:00:00,000 --> 00:00:01,000 Hello from mock
  GenStudio.`, sidecars `.task-manifest.json` 435 B, `.subtitle-recovery.json` ~926 B,
  `audio_sentences.json` 1,888 B. Provider accounting across legs 1–3: **8 chat + 6 TTS + 2 transcription
  submissions, 0 credits charged**. Episode status map (what the Production Board reads) for both:
  `script/audio/merged_audio/subtitles: true`, `all_done: false` (visual + assembly stages outstanding).
  Report `docs/handoffs/deepseek-reports/ACCEPT-01.md`. Note for future dev runs: the dev app needs
  `bundled/ffmpeg` on `PATH` (or the in-app installer) — without it the audio job fails with
  `spawn ffmpeg ENOENT` and the merge is blocked with the exact missing filenames. No paid call, no
  upload, no publish; no commits/pushes in this entry.
- **2026-09-22 — DeepSeek lead, ACCEPT-01 leg 4 (Scene Plan) — and a real defect fixed (`NEW-12`):**
  continued the walkthrough on the canonical v2 project. Per-chapter transcription (the Subtitles page's
  own option) produced 3/3 section transcripts and auto-stitched a 2.3 s timeline; the Scene Plan
  **timeline** stage then exposed the defect: the page's "Build timeline" posts `{stage:'timeline'}`, the
  job wrote a correct model-free plan (`planning_stage`, `timeline_built_at`, `ep0001-scene-0001`
  0→2.301633 s, `visual_prompt: ''`) and **failed with "reported success, but re-reading its output found
  required items missing" after three local attempts**, on both episodes. Root cause: `auditScenePlanOutput`
  folded every non-motion stage into `'visual'` and required a `visual_prompt` per scene, which a
  timeline-only run is deliberately never asked to write — `assertAuditedCompletionOnSuccess` runs that
  same auditor, so a correct timeline always failed its own job. Fixed in `boot/executors.ts`: only an
  explicit `stage: 'timeline'` (repair flags unchanged) is audited on its own proof — at least one scene
  with finite forward-running timings plus a recorded `timeline_built_at` — while Pipeline runs (no
  `stage`) and the explicit visual stage keep the prompt requirement. New test
  `scene-plan-timeline-audit.test.ts` went RED→GREEN (2 cases) and `scene-motion-scope-enforcement.test.ts`
  stays green: **11/11 focused**. Verified live, not only in tests: recompiled the backend, restarted the
  acceptance app, re-ran the same request — both timeline jobs `done`. The visual stage then completed on
  both episodes ("1 adaptive pack(s) · Checkpointed visual-0001: 1/1 prompts verified on disk · Verified
  1/1 visual prompt(s) on disk by stable scene ID"), with the provider answer built from the scene ids the
  app itself had written. Scene Plan status now `scene_plan: true` on both episodes. The fix is
  application-facing, so it needs a version bump + changelog line at the next release decision (not bumped
  yet; the installed app stays 1.4.217). **Full backend gate on this tree:** `npm run test:backend`
  completed **5,635 tests, 4 failed, 517/517 file(s)** — and those four are the same external
  `content-packs/rebuilt/**` failures this branch tip has produced in every run (they are absent from
  `main`); because they fail deterministically, a total of exactly four means the audit fix and its new
  test introduced no other failure. No paid call, no upload, no publish; no commits/pushes in this entry.
- **2026-09-22 — DeepSeek lead, ACCEPT-01 legs 5–6 (images → local assembly) + `NEW-13`:** finished the
  media chain on the canonical v2 project. **Leg 5:** thumbnail prompts first came back short (3 answered
  against **5 required**) and the job failed precisely — "3/5 required item(s) verified. Missing/invalid:
  Thumbnail 4, Thumbnail 5. Verified prompts were saved; Retry requests only the missing thumbnail
  prompts." — then a `fill_gaps: true` run (what the page and the job Retry send) asked for exactly the
  two missing slots and finished `done`; thumbnails rendered 5/5 (68 B each) and the planned scene image
  rendered 1/1 (`mock-image-v1`, `ep0001-scene-0001.png`). **Leg 6:** Scene Review approval
  (`{all:true}` → `{"total_scenes":1,"approved":1,"with_image":1,"all_approved":true}`) then local
  assembly `done` for both episodes — `EP0001_final_video.mp4` / `EP0002_final_video.mp4`, `ffprobe`
  `h264` 1920×1080 + `aac`, 2.333 s, 10,591 B, plus the `<code>_video_assembly_source.json` stamp. No
  provider submission for assembly (local FFmpeg only). **Operational note:** exports resolve to
  `<Library root>/Exports`, and this Mac's Library root is the default `~/Documents/Story Studio KH`, so
  the two finals landed in the owner's Documents; they were **moved (not deleted) to
  `_trash/documents-exports/accept-01-walkthrough-v2-2026-09-22/`**, the owner's Documents is back as it
  was, and the acceptance app's own settings file (`/tmp/ssk-accept-data/app-settings.json`) was verified
  separate from the owner's real one (which holds only `library_root`), so no acceptance run redirected the
  installed app. **`NEW-13` (reproduced, fix not written):** with those finals briefly absent the app
  persisted `video_assembly: false` in `<userData>/cache/<slug>/episode-status.json` and kept it after the
  files were restored, across an app restart; the cache watches 13 paths all inside the project tree and
  **never the external final-video root or its stamp**, while a fresh uncached computation returns
  `video_assembly: true`/`final_video_bytes: 10591` (`scripts/developer/probe-video-assembly-status.ts`).
  The assembly path, stamp and status rule are correct; the cache is stale. Owner-facing because his finals
  live at that external root. Fix direction recorded; deliberately not changed in this round. Report
  `docs/handoffs/deepseek-reports/ACCEPT-01.md`. No paid call, no upload, no publish; no commits/pushes.
- **2026-09-22 — DeepSeek lead, ACCEPT-01 leg 7 (metadata → upload preparation) + `NEW-14` + two blocking
  checks:** the finalizer preflight reports `audio_assembly_ready/subtitle_complete: true`, 3 chapter
  markers and no warnings for both episodes; both metadata packages finalize (`metadata: true` on both) and
  **no upload was attempted**. That leg exposed **`NEW-14`**: three EP0001 metadata jobs (`e49b81c9`,
  61457d82, `aca65751`) all cite the *same* provider job `mock-chat-001` and fail identically at 3/17
  because an identical request identity makes the provider replay the same short answer — the generator and
  its completion audit are right, but the message "Retry to generate the missing fields" is not true for the
  Jobs Retry, which re-runs the stored params unchanged (`retryReplacementParams` only special-cases
  `image_prompts`). A fourth run with a fresh `operation_id` (what the Finalizer page always stamps,
  `freshMetadataAction`) completed **17/17 with 15 tags** from the same seeded answers, so the page's path
  heals and only the identity/message needs fixing. Two blocking checks passed: (a) cancelling a
  deliberately slow five-image batch 3 s in was **refused** with `CANCELLATION_STATUS_UNKNOWN` — "cannot yet
  prove whether every provider request was accepted", control disabled — and the batch then settled with 5
  submissions and all 5 thumbnails, nothing resubmitted (H-16 behaving as designed; a *successful* mid-flight
  cancel remains unexercised because the fixture cannot acknowledge a cancellation it received); (b) moving
  `ep0001-scene-0001.png` out of the episode made assembly refuse with "Video Assembly is blocked: 1 missing
  image(s): #1. Open Scene Plan or Scene Review, repair only the listed items, then retry." — no substitute
  image, no partial video — and the file was restored afterwards. Remaining in ACCEPT-01: the **model switch**
  (blocked on the fixture publishing only one language model). Report
  `docs/handoffs/deepseek-reports/ACCEPT-01.md`. No paid call, no upload, no publish; no commits/pushes.
- **2026-09-22 — DeepSeek lead, `NEW-14` fixed and verified (ACCEPT-01 follow-up):** the walkthrough's
  metadata retry defect is repaired. `retryReplacementParams` now mints a fresh language action for a
  `metadata` retry that carries **no** saved action — the Pipeline/bare-route case — and marks its own mint
  `origin: 'retry'` so each subsequent retry mints again; an action the Finalizer page stamped is still
  preserved, which is the behaviour `job-retry-route-contract.test.ts` already pinned, so the fix stays
  narrow. The first version of the fix preserved its own mint and the live loop caught it: retry #2 replayed
  retry #1's provider answer. Regression cases: a bare retry mints a valid fresh action (UUID + fingerprint)
  and changes nothing else, and two consecutive retries carry different action ids. **Live proof on a fresh
  gateway:** bare attempt `31707af7` → `error` 3/17 (`mock-chat-001/002`); Jobs Retry #1 `5bfb9976` →
  `error` 3/17 with **new** provider jobs `003/004` (asked afresh, no replay); Jobs Retry #2 `52a0cfab` →
  **`done` 17/17, 15 tags** (`005/006`) — six gateway submissions across three attempts, so the "Retry to
  generate the missing fields" promise is now true for the control that makes it. Focused:
  `job-retry-route-contract` green, 176 tests across the job-retry/metadata/job-queue files green,
  `typecheck:electron` exit 0. **Full backend gate on this tree:** `npm run test:backend` completed
  **5,635 tests, 4 failed, 517/517 file(s)** — the same four deterministic external `content-packs/rebuilt/**`
  failures this branch tip always produces (absent from `main`), so the fix and its new assertions added no
  other failure. The fix is application-facing, so
  `NEW-12` and `NEW-14` together need a version bump + changelog line at the next release decision (not
  bumped; installed app remains 1.4.217). Report `docs/handoffs/deepseek-reports/ACCEPT-01.md`. No paid call,
  no upload, no publish; no commits/pushes.
- **2026-09-22 — DeepSeek lead, ACCEPT-01 leg 8 (model switch, AGENTS §1):** the fixture could not
  previously publish a second language product, so `MockGenStudioService` gained an optional `chatModels`
  field (null keeps the single default row — no existing test changed) and the standalone runner gained
  `POST /__control/chat-models`. The three catalogue suites stayed green (101 tests). Live check: the mock
  published `mock-chat-small-v1` (`context_window_tokens: 32000`, `max_output_tokens: 1024`) beside
  `mock-chat-v1` (`128000`/`4096`); a freshly started app reported both rows with those limits at
  `freshness: {stale: false, ageMs: 0}`; a scene-prompt regeneration on the switched model logged
  `Prompt model: genstudio-chat:mock-chat-small-v1`, `Prompt batching: … caps this batch at 2 complete
  instead of the 250-scene default (1,024 output tokens × 0.75 ÷ …)` and `Visual pack output budget: 1,024
  tokens`, and the provider evidence records `model_id: mock-chat-small-v1` with state `succeeded`. The
  derived batch cap and pack budget moved 4,096 → 1,024 with the selection, i.e. they were read from the
  live catalogue in that run rather than carried over — the §1 property the leg exists to prove. Remaining
  in ACCEPT-01: a successful mid-flight cancel (needs fixture support for a provider job that stays running
  after acceptance). Report `docs/handoffs/deepseek-reports/ACCEPT-01.md`. Full backend gate started on this
  tree. No paid call, no upload, no publish; no commits/pushes.
- **2026-09-22 — DeepSeek lead, ACCEPT-01: successful mid-flight cancel (the last in-scope item):** the
  earlier packet recorded only the *refusal* (`CANCELLATION_STATUS_UNKNOWN` when provider acceptance was
  unproven). This run got the other half without any fixture change: an image scenario whose state stays
  `accepted` for several polls is `cancellable` throughout, which is what the app checks before it will
  cancel. Forcing a 5-thumbnail re-render and cancelling 2 s later: the cancel was **admitted**
  (`{"ok":true,…}`); the provider cancelled `mock-image-001/002/003` ("Cancelled before provider
  execution", 7 credits released each); the app logged "Story Studio is reconciling the provider
  cancellation; **no new generation request was sent**" and the gateway's submission count stayed at 5; the
  two uncancelled tasks finished and saved, and the job settled `error` with "Completed with 3 error(s) …
  Provider work settled with mixed completed and cancelled tasks. Repair missing output before Retry." —
  valid work kept, gap named, no false success. ACCEPT-01's in-scope legs are therefore complete (script,
  audio+assembly, subtitles, Scene Plan, thumbnail prompts+images, Scene Review→assembly, metadata/upload
  preparation, model switch, both cancel directions, the missing-image block and the completion-audit
  refusals); the only items left are *external* by construction — real provider output, real speech timing,
  real upload, signed/notarized distribution (`X-07`, `RELEASE-01`). Report
  `docs/handoffs/deepseek-reports/ACCEPT-01.md`. No paid call, no upload, no publish; no commits/pushes.
- **2026-09-22 — DeepSeek lead, version/changelog hygiene for the two fixes (1.4.218 prepared):** the
  two application-facing repairs found by ACCEPT-01 now have a version and a What's New entry, so the tree
  is release-ready without publishing anything. `package.json` + `package-lock.json` are at **1.4.218** and
  the newest `CHANGELOG.md` entry covers both in plain language: Scene Plan's **Build timeline** no longer
  fails its own completion check (a model-free timeline is judged on its timings), and a failed **YouTube
  Finalizer** run can really be repaired by Retry (the retry asks the provider afresh instead of re-sending
  the identical request and replaying the same short answer). Guards after the bump:
  `check:changelog` ok — package, lockfile and newest entry agree on v1.4.218; `check:typography` ok;
  `check:model-drift` ok (708 files, 39 annotated exceptions). The full backend gate had already run on this
  tree before the bump (5,635 tests, the same four external content-pack failures, 517/517 files). The
  installed app remains **1.4.217** and nothing has been committed, pushed, built or published — landing
  1.4.218 in `main` and building/installing a DMG is the owner's next decision, together with the `X-07`
  paid-generation ceiling.
- **2026-09-22 — DeepSeek lead, `NEW-11` mitigated and ACCEPT-01 closed:** both release build scripts now
  snapshot the checkout's two manifests before electron-builder runs and restore them in a `finally`,
  logging which file packaging rewrote (NEW-11) — defence that holds whether the build succeeds or fails,
  with a unit test in the release lane (44 tests green, 5/5 files). The culprit step is **still
  unidentified**: a clean `electron-builder --dir` run, including its `@electron/rebuild` /
  "installing native dependencies" phase, left both manifests byte-identical, and `fetch:ffmpeg` takes its
  present-binaries fast path, so the finding stays open with the guard documented as prevention rather than
  a root-cause fix. **ACCEPT-01 is closed as self-accepted** ([ACCEPT-01.md](docs/handoffs/deepseek-reports/ACCEPT-01.md)):
  legs 1–8 (script, audio + assembly, subtitles, Scene Plan, thumbnail prompts + images, Scene Review →
  Video Assembly, metadata/upload preparation, model switch), both cancellation directions, the
  missing-image block and every completion-audit refusal were exercised against the repository's own mock
  gateway with zero paid submissions, and the record states plainly what that cannot prove — real provider
  output, real speech timing, a real upload and signed/notarized distribution (`X-07`, `RELEASE-01`).
  Version/changelog hygiene is done for the two fixes (1.4.218 prepared; guards pass). What remains is
  owner-gated: land 1.4.218 in `main` and build/install a DMG, and agree the `X-07` credit ceiling before
  any real paid call. No commits/pushes/publish/paid calls.