# HANDOFF — Story Studio KH

**Current state — 2026-10-26.** This file is the cold-start briefing. `AGENTS.md` is the rulebook
and `docs/architecture/agents-decisions.md` says why; if this file disagrees with the code, the
code wins and this file gets fixed.

| Thing | State |
|---|---|
| Current release | **1.4.359** — on `main` and installed on the mini. |
| In gate | **1.4.360** — release worktree `release-1.4.360`; ten-step gate C running, evidence `_orchestra/app-closeout-20261021/story-360-gate-c-20261026/gate`. Not released, not installed. |
| Next | Ship 1.4.360 through the whole cycle (prebuild → ten-step gate → land on `main` → rebuild from `main` → publish → force-install on the mini, owner 2026-10-25). |
| Gate | The ten-step `story-final-gate`; runner `_orchestra/app-closeout-20261021/story-final-gate-tools/run-gate.sh`. `ship-story` refuses to publish without its proof. See AGENTS §10. |
| History | Older entries (1.4.356 and back) and the pre-2026-10 working-loop notes are in [`HANDOFF-archive-2026-10.md`](HANDOFF-archive-2026-10.md), kept as a verbatim historical snapshot. |

**NEW-11, 2026-10-26 — the recurrence.** The main checkout's `package.json` was again found in
packaged shape (no `scripts`, no `devDependencies`) after a `dist` build, and was restored with
`git checkout`. The cause is known, not mysterious: `npx asar extract-file <app>.asar package.json`
writes the extracted file into the **current directory**, so run from the repo root it overwrites
the source manifest — see `scripts/release/release-utils.mjs` and
`electron/server/__tests__/source-manifest-integrity.test.ts`. **Suggested guard, not implemented
here:** after every build, fail loudly if `package.json` has lost `scripts` or `devDependencies`
(the existing snapshot/restore only logs, so a recurrence is still silent).

## Working rules that still hold

- **Never `rm`. Every removal moves to `_trash/`** — the owner's words, covering your own cleanup
  as much as his requests; keep the sub-structure and say where it went. `_trash/` itself is the
  owner's and may be emptied at any time.
- **Never rewrite published history.** To delete a branch or ref, record its name and SHA in a note
  under `_trash/` first.
- **Strip `ELECTRON_RUN_AS_NODE`** when launching Electron (dev or packaged); with it set the app
  exits immediately with no output and looks broken.
- **Do not package from a symlinked-`node_modules` worktree** — electron-builder does not follow it
  and the app ships with no runtime dependencies (the v1.4.68 defect).
- **Put `bundled/ffmpeg` on `PATH`** before any run that generates or assembles audio; otherwise
  you get `spawn ffmpeg ENOENT` and assembly blocks with a precise missing-file list.
- **Rebuild and restart after backend edits** — the app runs compiled output, so a source edit alone
  changes nothing you can observe.
- **No wallclock sleeps in tests.** Use `waitFor`; a fixed sleep asserts the scheduler, not the
  product.
- **TTS parts are sized by the model's published character limit, and by nothing else** (owner,
  2026-09-26); the lane's own `deadline_seconds` comes from Studio Hub, and Story adds no internal
  spoken-minutes cap.
- **A window of scenes is ONE response, so the output ceiling sizes it too.** Before adding any
  batch, ask what one response can carry.
- **A provider's `finish_reason` can lie; usage does not.** Treat "usage ≥ the ceiling the request
  asked for" as truncation, whatever the reason says.
- **Gates cannot see geometry, CSS or dev wiring** (AGENTS §3). Episode state must not survive an
  episode change (§4). Provider is display, never dispatch (§2). `pacing` and scene rhythm
  decisions are in §5 — do not "fix" them back.
- **After any packaging run, `git status` must be clean.**
- **`npm run check:changelog` must pass** — runtime version, lockfile and the newest What's New
  entry have to agree. **Typography gate:** no source text below 12px. **Model-drift gate:** no
  hardcoded catalogue values outside annotated exceptions.
- **Content Packs:** one unrecognised kind discards the whole catalogue, on both sides. Local→wire
  kinds: `series-formula→series_formula`, `topic-pack→topic_pack`, `visual-style→visual_style`,
  `thumbnail-recipe→thumbnail_recipe`, **`lettering-style→font_pack`**, `metadata-formula→metadata_formula`.
- **Story Studio talks to exactly one endpoint** — the owner's `gateway-kh` (`http://127.0.0.1:8787`
  default). Never a second address.

---

**Release history — the three latest entries, in full:**

## 1.4.359 — extension requests take the model's published cap; chapters-per-request setting; expansion failures are loud (2026-10-26)

Production (Komsan, Khmer, 2026-10-25): expansion jobs 38ca3df6 / 862fed60 / b2bc6196 / ec973e7a / 71e2f3c3 and the single-chapter 0857b744 all ended `finish_reason: max_tokens`. Root cause 1: `batchOutputTokenEstimate` sized every expansion request from `words × 2.5 + 2,048`, floored at 8,192 — a 2-chapter Khmer batch asked for exactly 8,192 against a product publishing 128,000. Khmer is written without spaces, so a "word" is a clause and tokenises several times heavier than English; no words→tokens ratio can be safe, and AGENTS §1 forbids one. Root cause 2: `expandListicleParallel` swallowed every per-batch error as an output line and `generateExpandChapters` skipped the completion rule entirely for a `chapters_to_expand` run, so a provider failure ended `done` with 0/8 chapter files (AGENTS §8). Fix: `expansionOutputTokenCap` / `expansionRequestOutputBudget` ask for the product's WHOLE published `max_output_tokens` on every expansion request, **including the single-chapter repair**, bounded only by `min(max_output, context_window_tokens − prompt tokens)` from published figures (chars/4 prompt estimate; a prompt that cannot fit throws and says so). Owner, 2026-10-25: "if Haiku is able to churn out more output, why are we even limiting it?" Deleting the estimate also deleted `BUDGET_TOKENS_PER_WORD` / `BUDGET_OVERHEAD_TOKENS` / `BUDGET_FLOOR_TOKENS` / `BUDGET_ROUNDING_STEP` / `SINGLE_CHAPTER_REPAIR_OUTPUT_TOKENS` / `batchSizeForBudget` — grep shows no other callers. The request uses tier `maximum`, never `workload`, because `workload.minimumTokens` is what Studio Hub sizes a job deadline from (a 128k expectation would make every batch a four-hour job). Truncation now splits: finished chapters are kept (the unproven final block never reaches disk), the unfinished ones are halved and re-requested and the log says so; a single chapter that still truncates is named in a failure. The listicle path collects every unwritten chapter and throws through `carryOnWithoutChapters` (default `block`) naming them, with the count written and the "Retry writes only the missing" sentence. `generateExpandChapters` now hard-fails a FILTERED run that lost a chapter it was asked for (`missingRequestedChapters` + `requireJobCompletion`, so `result.complete = false` feeds the queue backstop) while still allowing the unfiltered whole-script rule to stay behind its safety check.

"Chapters per request" (owner, 2026-10-25: "maybe 3 chapters each time. Make that the default but adjustable"): two modes in `ExpansionBatchSetting` — `count` (default: this format's own value, 3 narrative / 8 listicle, i.e. unchanged) and `length` (a USER-SET word budget over the outline's own per-chapter targets; a chapter longer than the budget goes alone). `planExpansionGroups` groups; `policyChapterGroups` now takes planned groups instead of a batch size. UI on the Script Generator (`chapter_batch_mode`, `chapters_per_request` 0 = format default, `chapter_batch_words`, hint "Fewer chapters per request is safer for long or Khmer chapters."), snapshot into `script_presets` (reusable configuration, AGENTS §5), remembered per Mac via `useRememberedForm`, validated in `scripts.ts` (0..10 / 0..100000), sent by `OutlineReviewPanel`, and carried into both Pipeline `expand_chapters` links. The executor reads it from the REQUEST before the outline sidecar, deliberately opposite to every other script field, because it is live configuration rather than episode state. `computeParamsHash` does not include it, so changing it never rebuilds a cached outline.

Also 1.4.359, the gate itself: the backend watchdog (`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS`, default 90 min) is now marginal — 1.4.358 needed 5,352 s of 5,400 and the first 1.4.359 run was killed at 850/854 files; the accepted run (c488c165: 8817 tests, 8812 pass, 0 fail, 5 skipped, exit 0) took 7,534 s with the watchdog raised to 3 h. Raise the default or split the slow YouTube files before the next release. Final-composition tests need `bundled/ffmpeg` (untracked) — a fresh worktree must symlink it from the main checkout or those tests fail for the environment, not the code. Routes that `sendFile` from the app data dir pass `dotfiles: 'allow'` because the harness lives under `.test-work`; each path is server-resolved (no request-supplied path reaches them).

Also 1.4.359: a scoped chapter-only write now merges into `chapters_done`. KOM3 Chapter 7 was written in 1.4.357 with all eight files on disk while the sidecar stayed [1,2,3,4,5,6,8]; `recordVerifiedChapter` re-reads the sidecar and applies the same two proofs `validChapterNumbersForOutline` applies (file non-empty, written for THIS outline) before merging, and returns a reason instead of marking when either fails. Deleted prose: the `quote_language_reservation` / "GenStudio holds credits for the requested ceiling" note is gone from `chunked-narration.ts`; a read-only audit found zero call sites for that mechanism in story-studio-kh, gateway-kh or studio-hub-kh, and every chat row in the captured catalogue publishes 0 credits per million tokens. `output-token-budget.ts` carried the same claim in its CREDIT IMPLICATIONS block; it is removed too, replaced by a note recording what the audit found.

Also 1.4.359 (other merges): Series Formula mandatory at creation — `formula_choice: 'selected'|'generic'` on project.json, absent = never chose (the prompt is for it; never auto-assign). Legacy bare ids read through `LEGACY_FORMULA_ALIASES` in niche-loader (read-time only; nothing on disk rewritten; legacy file answers with a warning if the store pack is missing). Owner custom Formulas adopted as `com.storystudio.formula.wildlife-under-pressure` / `coffee-jazz-ambient` / `a-world-before-us`; their old ids alias. Studio Library replaces the Content Store page (`/library`; `/content-store` redirects; purchase/quote routes deleted, the journal is still read). Thumbnails default to 3 (one shared default; completion = each episode's recorded count). Channel labels/search/sort; channel style previews exactly three, keyed by style text, settled failures move the retry key deterministically (`base:retry:<n>`). TTS alias follows `legacy_ids`; narration staleness compares chapter text. Intro redesign + episode story context; ideas follow content language; continuity no longer caps style_bible/negative_prompt; render profile v2 accepted and pinned; test harness live work under `.test-work`.

Open: `docs` for the by-length mode's default (1,800 words) was chosen to equal today's approximate 3 × 600 grouping; the owner has not stated a preferred number. The frontend lane run for `scriptWorkspace` was still in progress at handoff.

## 1.4.358 — remote-render refusal goes local, Sketch Draw stall bound, starting rhythm, auto-approve default (2026-10-25; includes the unreleased 1.4.357 below)

Remote render root cause (WI0005/7/8/9/10/11/12 + MANU0001 parked): the Gateway profile `retained-classic-no-font-candidate-v1` publishes execution_bounds working_fps [24] / canvas 1920x1080 only; Story sent 30 fps packets without checking, the Gateway answered 409 RENDER_PROFILE_MISMATCH, Story filed it as send_unknown, the by-key lookup 404'd, and lookup_not_found could never leave. Fix: `privateFinalRenderBoundsViolation` preflight in `preparePrivateFinalRenderDescriptor` (live bounds, §1) keeps such videos local with a reason; `FinalRenderHttpError.code` + `isDefiniteFinalRenderRefusal` → new phase `refused` (events `post_refused`, `lookup_refused`), validator and job-queue mirror updated; lookup_not_found + http-class post_unknown + RENDER_NOT_FOUND ≥ `FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS` after the first absence → refused; network-class stays held. The reconciler resumes refused rows locally on the same job id (`resumeRefusedFinalRenderLocally`); `publishLocalFinalVideo` publishes exclusively so a fallback never replaces an accepted final. `runningJobsThatWouldNotResume` no longer counts durable ID-null parked holds (they blocked the updater drain). Remote stays OFF on the mini (owner) until the profile is widened beyond 24 fps and a real 30 fps proof passes. Sketch Draw: helper checks AVAssetWriter status every wait (fail fast with its error), backstops 300 s/frame and 180 s finish (worst healthy wait measured 38.9 s under 8 concurrent VideoToolbox encodes), batch retries a timed-out scene once. Continuity: an episode's first save (whole-config without pacing, or motion-scope creating the file) writes `readProjectStartingPacing`. Auto-approve: `autoApproveOn(value) = value !== false` everywhere a generated scene image's approval is decided (owner: everything generated is approved).

Thumbnail text style `'none'` (Manu, 2026-10-25): `resolveTextStyle` maps any unknown treatment id to `TEXT_STYLES.gold`, so `thumb_text_style:'none'` produced "Render the exact title … golden glow". Now `thumbnailPromptClauseTexts` skips the title clause for a `'none'` text style, and `generateImagePrompts` maps it to headline `'none'` over a recipe default. The real no-text switch is still `thumb_headline_mode:'none'`. Auto-approve default-on also changed what tests must seed: a test that needs a scene left unapproved must save a Scene Review preset with `auto_approve_generated:false` (`liveSceneAutoApprove` reads the channel's live setting and now approves when none is saved).

## 1.4.357 — thumbnail text layer, scoped chapter edit, honest subtitle/render/music messages (2026-10-25)

Text layer (owner's Khmer thumbnail ask): contract `contracts/thumbnail-text.ts`; renderer `lib/thumbnail-text-render.ts` (sharp + fontconfig from `bundled/fonts`, `fonts.json` hashes verified; Battambang hash typo fixed, all 5 fonts byte-identical to upstream Google Fonts); routes `routes/thumbnail-text.ts` (fonts, builtin presets, preview = PNG + `X-Thumbnail-Text-Report`, apply, variants, suggestions); bare source filename inside this episode's own thumbnail folder (§4); variants carry a sidecar and go stale by source SHA-256, never mtime; `upload-metadata.ts` refuses a stale pinned variant; suggestions use the active Thumbnail Prompts preset's model and refuse plainly without one (§1); presets keys `thumbnail_text_presets`/`thumbnail_text_last_preset` are look-only (§5); `thumbnail_text_layer_enabled` per channel. Scoped chapter edit (production, MANU0002 Ch04/05): `PUT …/chapters/:n/content {text, expected_sha256}` (GET returns `sha256`), old files to `_trash` via `manualPromotion`, writes one chapter, rebuilds combined narration, writes `${code}_${slug}.text-edit.json`; ONLY a marked chapter makes its merged audio (`script-changed:`), subtitles and stitched timeline stale — no marker = exactly the pre-1.4.357 rule (an independent review caught that a plain mtime rule would have blocked finished episodes); resolved Script folder threaded through every caller. Subtitles: `subtitle_method_reason` on script-timed results; Khmer stays script-timed by default — whisper-large-v3-turbo publishes km but returned unusable Khmer on 2026-10-25 (cause open: model vs VoxCPM2 audio; owner to approve one known-good human clip test). `preparePrivateFinalRenderDescriptor` logs the switch-off case (§7). Scene Plan refuses a music episode first thing, non-retryable. Open: 8 remote assemblies parked on the mini because the Gateway refuses the create (cause logged from Gateway 0.2.199); Sketch Draw helper 600 s timeout in batches (hypothesis: VideoToolbox contention).
