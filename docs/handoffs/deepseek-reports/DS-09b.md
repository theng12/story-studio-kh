# DS-09b — Introduction read failure and Scene Plan delete empty state (E-03, E-10)

## Run identity and scope
- Date / session: 2026-09-22; owner-operated DeepSeek lead session. One writer, no spawned agents.
- Branch `codex/stabilization-takeover`; base `6f3c4e33`; no commits. First packet in the pending **1.4.216** release.
- Candidate IDs: **E-03, E-10**.
- Changed production: `frontend/pages/projects/[slug]/pipeline.vue`, `frontend/pages/projects/[slug]/audio.vue`, `frontend/pages/projects/[slug]/scene-plan.vue`.
- Changed tests: `frontend/__tests__/workspaceReadFailures.test.ts` (two cases added).

## Reproduction and root cause
- **E-03.** Both pages read the channel's `/segments` and encoded any failure as `channelIntroEnabled = false`. In `audio.vue` that silenced the pre-spend warning (`openingMissing`), so a user could start paid narration for an episode the channel wants an opening for and never be told. In `pipeline.vue` the same `false` dropped the `introduction-only` step from a batch via `syncDerivedSteps`, and `stepDisabledReason` told the user "This channel does not open with an Introduction" — a confident claim about a question that was never answered (AGENTS.md §6).
- **E-10.** The "3. Scenes" section is gated on `status?.scene_plan || planning`. `deletePlan()` clears `plan.value` but not the disk-derived `status.scene_plan`, so after a successful delete the section still rendered — heading only, with no `plan`, no `planning`, and no empty state.
- **RED evidence.** Reverting `audio.vue` and `scene-plan.vue` to `HEAD` and running the new tests: **3 pass, 2 fail** (E-03 at the audio assertions, E-10 at the section condition); files then restored byte-identically (sha256 `f36e4778…`, `49c471d7…`).

## Change and proof
- **E-03:** `channelIntroEnabled` is now `ref<boolean | null>(null)` on both pages; the catch sets `null`. `pipeline.vue` only derives the Introduction step when the value is `=== true`; `stepDisabledReason` distinguishes `null` from `false`; `audio.vue` keeps `openingMissing` for a known-true channel and adds `openingCheckUnknown`, which shows a warning with **Retry** and a link to Introduction before any narration spend.
- **E-10:** the plan section is now gated on `plan || planning`, so a stale `status.scene_plan` can no longer keep a heading on screen by itself. The existing no-plan card gained a **Build the plan** button (`planScenes`) so the empty state is actionable.
- Commands:
  - `frontend/` — `../node_modules/.bin/tsx --import ./__tests__/setup.ts --test workspaceReadFailures` (RED): exit **1**, 3 pass / 2 fail. (GREEN): exit **0**, 5/5.
  - Affected regression (18 files: workspaceReadFailures, all audio*, all pipeline*, all scenePlan*, optionalStageHonesty): exit **0**; tests 112, pass 112, fail 0.
  - Root — `npm run test:frontend`: exit **0**; tests 1,895, pass 1,895, fail 0; `211/211 file(s)`, 2,098 marks.
  - Root — `npm run check:changelog` exit **0** (1.4.216); `git diff --check` exit **0**; `npm --prefix frontend run typecheck` exit **2** with the same 11 pre-existing `TS2558` errors in untouched files (`NEW-04`), none in a changed file.
- Self-review: every change adds an explicit state and honest copy; no write or destructive action is triggered by a failed read; the Scene Plan gate now requires the actual plan object. **Self-review only**, not independent review.

## Handoff
- Remaining risks / skipped / unrun:
  - Static source analysis for the pages (not a mounted render); the changed computed/copy are directly asserted.
  - No DMG was built for this packet — it accumulates into **1.4.216** with the next packets.
  - `NEW-08` (external private Content Pack) still leaves the full backend lane red on `topic-pack-anti-padding`; no backend file changed here.
- Blocker/decision needed: none.
- Fixtures/cleanup: no fixtures; reverted files restored byte-identically.
- Status rows: DS-09b `complete`; E-03/E-10 `reproduced-fixed`.
- Commit/push/paid calls/uploads/deployments: **none**.
