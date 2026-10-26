# HANDOFF — Story Studio KH

## Unreleased — Facebook, Instagram and TikTok posting, strictly opt-in (feat/social-posting-20261027, from main fdf821f9)

Owner decision 2026-10-27: build posting to Facebook (Page video), Instagram (Reels) and TikTok (Direct Post).
**Strictly opt-in.** A channel connects accounts and ticks which platforms it posts to; every upload shows those
ticked and posts to nothing unticked. The owner has no accounts yet, so the feature is built, tested against
recorded responses only, and deliberately unused.

**Shape.** `contracts/social-publishing.ts` (platforms, error codes, receipt types) ·
`services/social-connection-store.ts` (applications + accounts registry, mirroring the YouTube one) ·
`services/app-secrets-store.ts` `social` bucket (encrypted, redacted, strict parse; a plaintext bucket is
refused rather than rewritten) · `lib/social-oauth.ts` (loopback flow per provider) ·
`services/social-connect.ts` (connect + credential resolution, TikTok refresh with rotation persisted) ·
`lib/social-publish/{types,meta,tiktok}.ts` (one adapter per platform behind a single fetch seam) ·
`services/social-publish-sidecar.ts` (`social_publish.json`, one receipt per platform) ·
`generators/social-publish.ts` (the job) · `routes/social-publishing.ts` ·
`components/SocialPublishingSettings.vue` + the review dialog's tick box on `upload/publish.vue`.
Job type `social_publish`, one queue lane. Channel keys `social_accounts` and `social_platforms` live in
**config.json** (publishing settings, beside the YouTube category), not project.json.

**Completion contract (§8).** Done means every ticked platform has a receipt with the platform's own post id.
A partial run fails loudly, names the platforms, keeps the receipts that exist, and says Retry posts only the
missing ones. A platform answering without an id is a failure. Specs (aspect, duration, size) are checked
BEFORE any byte is sent, so a 16:9 render is refused in words rather than failing at the provider.
**Never double-posts:** the receipt names the exact source revision (`sha256:…`); a retry skips a platform
whose receipt matches the file. A re-rendered episode is a different file, so it posts again — that is a new
post the owner asked for, not a duplicate.

**Owner setup checklist (nothing works until this is done, and nothing posts until he ticks it):**
1. **Meta app** — developers.facebook.com → Create app → add **Facebook Login** and the **Instagram Graph API**.
   In Facebook Login → Settings add the Valid OAuth Redirect URI `http://127.0.0.1:41234/callback` (exact
   match; Meta requires HTTPS for most apps and may refuse this loopback URI — if so, register the HTTPS URI
   of a small relay and change the saved redirect URI here; the app does not assume loopback is accepted).
   Permissions to request: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish`. Paste the client ID and secret into Settings → Connections →
   Facebook/Instagram.
2. **Instagram account type** — must be a **professional (Business or Creator)** account linked to a Facebook
   Page. A personal account cannot publish via the API.
3. **Meta App Review** — `pages_manage_posts` and `instagram_content_publish` need Advanced Access for accounts
   that are not the app's own testers. Until then only accounts with a role on the app can post.
4. **TikTok app** — developers.tiktok.com → Create app → add **Login Kit** and the **Content Posting API**, turn
   on **Direct Post**, and request the **`video.publish`** scope. Register the redirect URI
   `http://127.0.0.1:*/callback` (TikTok's desktop Login Kit allows a wildcard port on loopback). Paste the
   client key and secret into Settings → Connections → TikTok.
5. **TikTok audit** — until the client passes TikTok's audit, every post is restricted to **private viewing**
   (`SELF_ONLY`). The job says so in its log when the creator-info call offers only that level.
6. **Per channel** — Settings → Connections: connect the accounts. Settings → Publishing → *Where this channel
   posts*: tick the platforms. Then each upload's review dialog pre-ticks them and you can still untick.

**Rate limits the owner will meet (published by the providers, not invented here):** Facebook 30 API-published
Reels per Page per rolling 24 h; Instagram 100 API-published posts per 24 h; TikTok 30 status polls per minute
per token.

**Not done / open.** No real network call has ever been made to any of these platforms; every test uses
`__tests__/fixtures/fake-social.ts`, which FAILS on an unqueued request rather than falling through to `fetch`.
Nothing has been verified against a live account, so the first real connection is the first real test — expect
one round of provider-specific corrections. The `social_publish.json` sidecar is not yet in the backup
classifier's special cases (it is not media, so it lands in `records` — correct, but unasserted). Per-platform
caption editing is carried by the API (`captions` in the publish body) but the page does not yet expose fields
for it; the episode's YouTube title and description are the default. Facebook Pages also need the `CREATE_CONTENT`
task on the Page, which the account list does not verify.

## 1.4.360 — Sketch Draw v2, channel Formula/search/recency, refused-render restart and Cancel (2026-10-26, prepared on release/1.4.360 from main 16648a51)

Three merges, no squash: `feat/sketch-draw-v2-20261026` (b0c9f74d + 33b1e98a; owner approved it as-is — "perfect, i love it"; five reveal types, deterministic Mix, channel-wide setting with per-scene override, staleness compares the type this scene resolves to so older clips stay fresh), `feat/channel-search-formula-recent-20261026` (307d6ab8; `formula_name`/`formula_id` stamped on GET /projects from ONE catalogue lookup, search folds the name/ids Khmer-safe, `services/channel-recency.ts` walks episodes with a 10 s UNKNOWN bound and a 60 s cache), and `fix/refused-render-restart-20261026` (14dc367f; a refused render that finished locally is done across a restart). `feat/render-display-20261026` and `feat/ref-to-image-20261026` are deliberately NOT in this release.

Bug A — Cancel on a refused `video_assembly` row never cancelled. A refused receipt keeps `gateway_job_id: null`: the Gateway accepted nothing and the row is this Mac's own render. But `classifyProviderJobControl` treated EVERY marker row as a remote wait, so the control was `request-remote-cancel` with no targets; `requestJobCancellation` then skipped its final-render branch (`hasFinalRenderFence` is false for a refused row) and `queueRemoteCancellationTargets(job, [])` wrote the row `running` with no cancellation recorded. `listFinalRenderReconcileCandidates` reads every running marker row → `resumeRefusedFinalRenderLocally` → queued → pump → the episode rendered again. Fix, at the shared predicates: `isRefusedFinalRenderReceipt` lives in `lib/final-render-remote-wait.ts` and `isRefusedFinalRender` uses it; a refused row now takes the ordinary LOCAL controls (`stop-local` while it waits/runs, finished rules once it ends), `requestJobCancellation` refuses the receipt-writing remote path even under a transient hold, and `stopLocalJob` drops a queued refused row from the lane, clears its stale fence, SIGTERMs any child and announces the stop. Receipt, accepted final, its folder and the work folder are untouched; no render starts.

Bug B — a refused row a re-render ended in `error` with `FINAL_RENDER_ACCEPTED_FINAL_CONFLICT` ("Local fallback preserved the accepted final video; its new render remains in the work folder."; production: seven Wonder rows + MANU0001) now settles `done` when the row's own evidence says its earlier completion is the one true answer — the same rule 14dc367f uses: `result.complete === true` + `result.completion.complete === true`, no remote terminal digest, and the exact `<CODE>_final_video.<single ext>` present, regular, non-symlink and non-empty in `output_dir`. Applied both when the conflict is recorded (`runJob`'s failure branch) and in the boot scan; the row's log announces it, no file is moved. An incomplete result, a missing published final, an unreadable folder or a different failure stays `error` (never a guess). The conflict message is now one shared constant (`FINAL_RENDER_ACCEPTED_FINAL_CONFLICT`).

Open / notes: the Bug B settle marks the row done but, like 14dc367f's boot settle, does not advance a captured `pipeline_chain`; no production row in this class carries one. The mini's existing 7 Wonder rows + MANU0001 repair themselves on the first boot after this build is installed (they need the install, not another render). No full gate was run from this branch (the orchestrator runs it): focused only — `final-render-sealed-transport` 49/49 exit 0 (new tests proven failing-first: 47 pass / 2 fail against da1c0640), `job-control` + `video-assembly-remote-wait-state` 17/17, `job-cancel` 98/98, `final-render` 215/215, `job-queue` 156/156, `sketch-` 83/83, `channel-formula-recents` 13/13, frontend merged-feature tests 69/69, `npm run typecheck` exit 0. A fresh worktree needs `node_modules`, `frontend/node_modules` and `bundled/ffmpeg` symlinked from the main checkout (ffmpeg is untracked).
**Current state — 2026-10-26.** This file is the cold-start briefing. `AGENTS.md` is the rulebook
and `docs/architecture/agents-decisions.md` says why; if this file disagrees with the code, the
code wins and this file gets fixed.

| Thing | State |
|---|---|
| Current release | **1.4.359** — on `main` and installed on the mini. |
| In gate | **1.4.360** — release worktree `release-1.4.360`; ten-step gate C running, evidence `_orchestra/app-closeout-20261021/story-360-gate-c-20261026/gate`. Not released, not installed. |
| Next | Ship 1.4.360 through the whole cycle (prebuild → ten-step gate → land on `main` → rebuild from `main` → publish → the mini installs through its normal guarded updater on its next check-in; force-install retired by the owner 2026-10-26). |
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
