# Story Studio KH: Independent Audit

**Date:** 2026-09-23
**Scope:** branch `codex/stabilization-takeover` @ `734ccd70`, app version 1.4.219
**Method:** the full quality gates, then seven parallel read-only auditors, then my own re-check of every headline finding against the current source.
**Changes made:** none. The audit changed no code or data. Two things were added: a Graphify graph in `graphify-out/` (git ignores it), and this report. Reproductions ran against scratch copies only; nothing was paid for and nothing touched the network.
**Tools:** a Graphify code graph built fresh for this checkout (24,878 nodes, 54,676 edges), and the Ponytail discipline for every fix proposal: fix the root cause in the shared function, reuse an existing helper, delete rather than add, and leave one check that proves the fix.

**For the fixing session:** check every finding against the current source before editing, and reproduce the failing half first. Line numbers are as of `734ccd70`. The items in §7 are the owner's decisions; don't decide them.

---

## 0. Verdict

DeepSeek did some things well. The Electron window is locked down properly, the `.sspack` importer is excellent, YouTube uploads can't be duplicated, there is no shell injection anywhere, the typecheck is clean, and no test is switched off with `.skip` or `.only`.

The core engine does not live up to the repo's own rules. AGENTS.md sets eight hard rules. The code breaks the three that matter most for money and data:

- **§8, verified completion.** Jobs report success using old files, a pause that isn't really a pause, and a restart check that only asks whether files exist.
- **§6, a zero that means two things.** The low-level file readers turn "this file is corrupt" into "this file is empty" and then write that emptiness back over your data.
- **§4, per-episode state.** Video Assembly presets burn one episode's title into every episode rendered in a batch.

The status file says every work package was "self-accepted" by the same session that wrote it, and I found about 90 defects that the process let through. The main reason the gates stayed green: **74% of frontend test files search the source code as text instead of running it**, so they cannot see behaviour.

**Counts:** 4 security, 16 GenStudio/models, 14 job queue/completion, 16 video/FFmpeg, 14 persistence, 16 frontend, plus test and process findings. **About 26 are high or medium-high severity.**

---

## 1. Gate results (what "green" means here)

| Gate | Result |
|---|---|
| `npm run lint` | exit 0, **0 errors, 1,926 warnings** (1,569 `no-explicit-any`, 172 unused vars, 48 `preserve-caught-error`) |
| `npm run typecheck:electron` | exit 0 |
| `npm --prefix frontend run typecheck` | exit 0, but the frontend runs with `strict: false`, `noImplicitAny: false`, `strictTemplates: false` |
| `npm run test:backend` (release gate) | exit 0: **5,636 tests, 5,635 pass, 0 fail, 1 skipped**; 518/518 files ran to completion (17.5 min); projects root left byte-identical |
| `npm run test:frontend` | exit 0: 1,916 tests, 0 fail, 213/213 files (74% of these files search source text rather than run it; see §5) |
| `npm run test:release` | exit 0: 44 tests, 0 fail |
| `npm run test:content-packs` | exit 0: 368 tests, 366 pass, 2 skipped |
| `check:changelog / typography / security / model-drift` | all exit 0. The **model-drift check passed ("708 source files carry no hardcoded catalogue values")**, yet it misses `'grok-imagine'` (images.ts:318), `'deepseek-v4-flash'` (audio.ts:710), a six-ratio fallback list (image-prompts.vue:1675) and a "$0.005" price (PreviewPromptRow.vue:38) |

**All 7,964 tests pass.** Every defect below exists while these gates pass. AGENTS.md §3 warns that "every gate can be green while the app is visibly broken", and this audit bears that out.

---

## 2. Priority 0: money, data loss, security (fix first)

Each item lists where it is, how confident I am, why it's bad, and the smallest complete fix. **R** = reproduced with a script. **C** = confirmed by reading the current source.

### P0-1. Pause doesn't stop paid image renders (R)
- **Where:** `electron/server/generators/images.ts:1568-1573`
- **What happens:** in `maybeFinish`, `ownerStopped ||` settles the worker pool while other workers are still rendering. The job says "Paused safely", the image slot is released, and a worker sleeping in a backoff (`:1058`, `:1499`) can wake up and submit a new paid request. The repro showed two more paid renders finishing after the pause.
- **Fix:** delete `ownerStopped ||`, and check `jq.isPauseRequested` after every retry sleep.
- **Check:** pause with two images in flight; assert no submission happens after the pause (`images-genstudio-retry.test.ts`).

### P0-2. After a restart, chat jobs are marked Done using old files (C)
- **Where:** `job-queue.ts:2977-2986` → `finalizeSettledProviderJob` (`:995-1031`) → auditors in `boot/executors.ts:248-265`
- **What happens:** the auditors only check that output exists. Quit during a metadata, research, image-prompt or scene-plan regeneration, and on boot the provider reports success, the old files pass, and the job is Done. The new output you paid for was never saved, and the pipeline chain carries on.
- **Fix:** also require the existing `hasAuthoritativeCompletionDeclaration(job)` (`job-queue.ts:4196`).
- **Check:** a reloaded running metadata job with stale files that settles as succeeded must end as `error`.

### P0-3. A failed forced re-render reports success (C)
- **Where:** `images.ts:1703-1711`
- **What happens:** the completion check only asks whether `_v1.png` exists. A failed re-render leaves the old file in place, so the job says "All images generated successfully".
- **Fix:** pass `invalid: errors` to the existing `requireJobCompletion` call. This is a one-line change.
- **Check:** an existing Thumb01, plus force, plus a provider failure must end as `error` (`partial-failure.test.ts`).

### P0-4. An error page that isn't JSON skips the whole retry and credits policy (C)
- **Where:** `lib/genstudio-client.ts:3633-3636`
- **What happens:** `JSON.parse` runs before the HTTP status is looked at. When a proxy returns an HTML 502 or 504, the "no retry" rule (`:3805`) is bypassed and the paid POST is sent up to 4 times. 4xx errors are retried. A 402 "out of credits" is never recorded.
- **Fix:** when `!response.ok`, treat a parse failure as `body = {}`, as `readJson` (`:3816`) already does. Keep the error for 2xx responses.
- **Check:** an HTML 502 from `/v1/chat/responses` produces exactly 1 POST followed by the idempotency-key lookup.

### P0-5. Paid work goes to the wrong model without asking (C)
- **Where:**
  - `generators/music-generate.ts:197`: `models.find(...) || models[0]`. A retired music model silently becomes whatever is first in the catalogue. The comment right above says it "must fail here".
  - `generators/images.ts:318`: `req.model || 'grok-imagine'`, a hardcoded paid default that Pipeline's `thumb_images` step (`pipeline.ts:992-1007`) can reach. This breaks §1 and §7.
  - `services/genstudio-default-model.ts:100,110`: matches the raw `id` only, not handle or alias. A valid saved chat model is "healed" to Economy and overwritten, and you're told it was retired.
- **Fix:** use the existing `findGenStudioProduct` (`contracts/genstudio-product-identity.ts`) everywhere. About 12 more call sites still compare `id ===`: `scene-plan.ts:412,430,447`, `contextual-cues.ts:322`, `vision.ts:106`, `pipeline.ts:1268`, `style-preview.ts:103`, `subtitles.ts:252`, `routes/video.ts:1332`, `image-paid-replacement.ts:226`. Throw (`unavailableLegacyModelMessage`) instead of falling back.
- **Check:** an unknown music model id rejects with zero POSTs; a saved chat id equal to a row's `public_model_id` returns `healed:false`.

### P0-6. A half-written `app-settings.json` wipes the whole Library setup (R)
- **Where:** `services/app-settings.ts:95-106,206`
- **What happens:** `readJsonOr(target, {})` treats a corrupt file as empty, and the next setting write saves `{}` plus one key. The repro lost the Library root, the soft-delete list, the server credentials and the GenStudio URL.
- **Fix:** make `readSettingsForWrite` strict: a missing file gives `{}`, any other read or parse error throws. `project-manager.readJson` (`:495`, `JsonCorruptError` at `:471`) already works this way.
- **Check:** with a truncated file, `setAppSetting` rejects and the file's bytes are unchanged.

### P0-7. Stop during the final encode starts an encode nobody can stop, and it replaces the good final (C)
- **Where:** `generators/video.ts:5460-5490` (also `:5346`, `:2627`), `job-queue.ts:76,263`
- **What happens:** the last recovery tier has no `shouldRun`. The `watchdog` tag is set and never read. Cancel kills child processes once (`killChildrenFor`), but doesn't refuse new ones. Pressing Stop starts a full-length "no effects" encode that then overwrites your previous good `_final_video.mp4`.
- **Fix:** make `trackChild` kill any process registered for a job that is already cancelled. That one change covers `runFfmpeg`, `runEncode` and audio-merge. Also break the tier loop on a kill signal or the watchdog tag.
- **Check:** tier 1 rejects with SIGTERM on a cancelled job; expect one spawn and no rename (`video-assembly-recovery.test.ts`).

### P0-8. A music video with a still-image background fills the disk (R)
- **Where:** `services/music-render.ts:75-91` (called from `generators/music-video.ts:65`)
- **What happens:** `-stream_loop -1 -i bg.png -c:v copy` stores the PNG itself once per frame. The repro turned 5 seconds of 1080p into **1.17 GB**, so an hour would be hundreds of GB. The output also goes straight to the final path with only a size > 0 check, and usage is recorded before that check.
- **Fix:** for stills, reuse `isStaticImagePath` (`video.ts:3445`), loop with `-loop 1 -framerate 1` and encode with libx264. Write to a temp file, check it with `assertValidMedia`, then rename.
- **Check:** `buildLoopArgs('x.png', …)` does not contain `-c:v copy`.

### P0-9. Presets copy one episode's title into every video (verified) (§4/§5)
- **Where:** `frontend/pages/projects/[slug]/video-assembly.vue:4448,4613` save `title_card: {...titleCard}`, including `text` and `subtitle`; applied back at `:4487,:4653`. `routes/pipeline.ts:1468` passes them through, and `video.ts:2163` burns `req.title_card.text` into the video. Also, `onEpisodeSelected` (`:5810`) does `if (ep?.title) titleCard.text = ep.title` with no else.
- **What happens:** a one-click batch stamps the title of whichever episode was on screen when the preset was saved onto every episode. The auto-applied preset on page open also races with `scanAssets()`.
- **Fix:** leave `text`/`subtitle` out of the shared snapshot, ignore them on apply, and have Pipeline use each episode's own title. Stored presets on disk stay as they are.
- **Check:** a snapshot contains no title text, and a stored `text: "EP A"` does not reach episode B (`pipeline-flatten-bundle.test.ts`).

### P0-10. One failed read wipes a folder's task manifest, so Retry pays again (C)
- **Where:** `services/task-manifest.ts:249-252,157`
- **What happens:** under 50 concurrent workers, one EMFILE or iCloud read error becomes an empty manifest, which is then written back atomically. Every saved task id is lost, so Retry re-submits work that was already paid for.
- **Callers:** `images.ts:777,867,988`, `audio.ts:1213`, `scene-clip.ts:557,573`, `ai-video.ts:340`, `image-pool-generate.ts:271`.
- **Fix:** use the strict read for writes (a missing file still means empty).
- **Check:** make one read throw EMFILE; existing entries survive (`task-manifest-race.test.ts`).

### P0-11. Research review decisions are lost (§9) (found independently by two auditors)
- **Where:** `routes/research.ts:279`, `routes/pipeline.ts:815-819`, `generators/research.ts:203-229`
- **What happens:**
  - All three writers use plain `fs.writeFile` with no lock. Pipeline's auto-complete can overwrite a human's triage with `pipeline-auto`, which §9 explicitly forbids.
  - The generator writes before it checks completion, so an empty regeneration destroys research a human already reviewed.
- **Fix:** `withLock` + `writeJsonAtomic` (`lib/atomic-store.ts:39/193`, as `metadata.ts:627-631` already does), and check `hasResearchEvidence` before writing.
- **Check:** an adapter returning no claims leaves `research.json` byte-identical; a concurrent pipeline auto-complete plus a human save keeps the human review.

### P0-12. Server mode: anything arriving from the Mac itself skips login (R)
- **Where:** `lib/auth-session.ts:178-183`, with the Host guard disabled at `security.ts:59-60` and `app.ts:48`
- **What happens:**
  - A reverse proxy on the Mac (which `auth-session.ts:152` itself recommends) turns every remote user into `__local__`.
  - DNS rebinding from any browser on the Mac can read the Telegram token (`GET /api/app-settings/notifications`), list directories (`POST /api/system/browse-dir`), and repoint the GenStudio URL (`PUT /api/app-settings/genstudio`), which leaks the API key.
- **Fix:** skip login only when the peer is loopback **and** the Host is a loopback name **and** there is no `X-Forwarded-For`/`Forwarded` header. Reuse `LOCAL_HOSTS` and `hostnameOf` (`security.ts:26,46`).
- **Check:** peer `127.0.0.1` + `Host: rebind.attacker.example` → 401; peer `127.0.0.1` + `X-Forwarded-For` → 401.
- **Who is affected:** only you, and only if you use server mode.

---

## 3. Priority 1: correctness and reliability

**Job system**
- **P1-1. A failed job-state save leaves a job stuck "running" until restart**, and it blocks new jobs of the same type for that episode (`job-queue.ts:3442-3447,3629`). Catch it, set `error`, emit, and release the slot.
- **P1-2. `readPersistedJobs` swallows every error** in one `catch {}` (`job-queue.ts:3039`), so a single bad row abandons all the rows after it and skips reconcile scheduling. Give each row its own try/catch.
- **P1-3. TTS timeouts are logged as "Cancelled"** because the pattern `/cancell?ed|abort/i` matches Node's "aborted due to timeout" message (`audio.ts:1203`, `http-retry.ts:225`), so the retry is skipped. **(R)** Use `isCancelled()` only, and treat `TimeoutError` as a transport failure.
- **P1-4. Regenerating the script deletes the introduction before it generates** (`episode.ts:765-770`). If the regeneration fails, the paid-for intro is gone. Move the deletes after `requireJobCompletion`.
- **P1-5. A pending pause hides the real error**, such as a 402, behind "Paused safely" (`job-queue.ts:3534`). Log the original message before rethrowing.
- **P1-6. Audio errors name only three sections** and skip `requireJobCompletion` (`audio.ts:1357-1366`). This is the same defect images already fixed.
- **P1-7. The episode folder is renamed while other jobs may be writing to it** (`episode.ts:794`; the comment "the job queue is serialized" is false). Suspected.

**Video and audio**
- **P1-8. When one scene clip fails, the other workers keep rendering all remaining scenes** (`video.ts:3290-3305`). Add a shared `aborted` flag.
- **P1-9. Pictures drift behind the narration:** each clip is rounded up by up to one frame, which adds up to about 5.5 s over 333 scenes at 30 fps (`video.ts:3036,3242-3252`). **(R, per clip)** Use frame counts of `round(end·fps) − round(start·fps)`.
- **P1-10. A failed audio merge in overwrite mode deletes the last good merged audio** (`audio-merge.ts:1023-1078`). Write to `.tmp_`, then rename.
- **P1-11. Promoting the final video to an external folder is a direct `copyFile` onto the final name** (EXDEV), so a torn copy destroys the previous final (`video.ts:2634-2640,1823-1826`, `selfHealFinalPromotion` `:126-130`). Copy to a temp name, then rename, in one helper.
- **P1-12. B-Roll subtitles fail for any path containing an apostrophe** (`broll-assemble.ts:306-310,427-431`). **(R)** Delete the local escaper and use `escapeFilterPath` (`lib/ffmpeg-utils.ts:137`).
- **P1-13. Title and chapter cards containing `%` render blank, and the job still succeeds** (`video.ts:5623-5629`). **(R)** Use `escapeFilterArgValue` plus `expansion=none` (as `lib/contextual-cue-filters.ts:93` does) and delete `escapeDrawtext`.
- **P1-14. Audio merge and AI video use private `findEpisodeDir` copies** without the title hint, so they can pick a different folder from Video Assembly (§4) (`audio-merge.ts:120`, `ai-video.ts:38`). Use `lib/folder-resolver`.
- **P1-15. B-Roll ffmpeg runs are outside cancel and watchdog handling** (`broll-assemble.ts:71,511`, `broll-normalize.ts:93`), and the pool `filename` parameter isn't sanitised (`broll-pools.ts:303`).
- **P1-16. Video Assembly picks the merged audio by directory order**, and the scan also catches `_sound_design_mixed.mp3` (`video.ts:822-835`). This needs an owner decision (§7-1).

**Persistence**
- **P1-17. One invalid `app-secrets.json` blanks the whole channel list** (`project-manager.ts:713`, also `getSafeConfig` `:1189`). **(R)**
- **P1-18. A channel folder renamed in Finder is listed but gives 404 on every page**, because the slug comes from `project.json` while the path comes from the folder name (`project-manager.ts:708` vs `:1610`). Finder duplicates are also dropped at random. **(R)**
- **P1-19. Renumbering an episode has no active-job guard** and swallows failed renames (`episode-renumber.ts:51,251-274`; route `ideas.ts:1179`). Reuse `relevantActiveJobs` (`episode-media-cleanup.ts:291`).
- **P1-20. Episode import accepts the idea before it validates the code or the destination**; a title containing `/` creates nested folders (`episode-import.ts:342,527,555,574`). Use `resolveEpisodePaths` / `formatEpisodeCode` (`utils.ts:29,36,299`) before `addIdeas`.
- **P1-21. Two concurrent soft-deletes lose one**, so a deleted channel comes back (`soft-delete.ts:109,134`). **(R)** Do the read-modify-write under `withLock(appSettingsPath())`.
- **P1-22. Switching Library keeps per-slug caches, watchers and tombstones** from the old Library (`episode-status-cache.ts:83`, `soft-delete.ts:154,196`, `library.ts:218`). Clear them on a `library_root` write.
- **P1-23. The status cache's `invalidate` doesn't clear in-flight computations** (`episode-status-cache.ts:509`, `:338`).
- **P1-24. The folder watcher's episode-code regex is narrower than the codes the app allows** (`episode-folder-watcher.ts:368` vs `contracts/index.ts:40-41`).

**GenStudio**
- **P1-25. The image-permit retry loop has no wait and no cap** (it can run for 4 hours) (`genstudio-client.ts:8032-8063`). Cap it at `NETWORK_RETRY_ATTEMPTS` and wait with `retryDelay`.
- **P1-26. One malformed chat row breaks the whole chat catalogue** (`:4753`, thrown inside `rows.map` `:4816`). Drop the bad row instead.
- **P1-27. Vision analysis copies the file and uploads it before hitting a guaranteed refusal** ("text-only in this release"), leaving orphan files and remote assets (`routes/vision.ts:133-149` vs `genstudio-client.ts:6318`). Return 501 first.

**Frontend**
- **P1-28. Bundles drop the frame effect, the outro and timeline clips**, because the helper copies have drifted (`video-assembly.vue:4553,4582` vs `:4344-4351,4432`). Make one snapshot/apply helper and delete the copies.
- **P1-29. Scene Plan re-applies "reusable guidance" from localStorage on every load** (`scene-plan.vue:1808`). Exclude `custom_instructions` and `reusable_guidance`.
- **P1-30. The B-Roll motion list never loads** because of `${slug}` without `.value`, which gives `/projects/[object Object]/…` (`broll.vue:921`).
- **P1-31. B-Roll subtitle status can show the previous episode's files** (no request token) (`broll.vue:752-765,883`). Copy `subtitleStatusSequence` from `video-assembly.vue:5922-5930`.
- **P1-32. Scene Plan and Image Prompts poll loops outlive the page**, and partial fills are shown as success (`scene-plan.vue:2374-2428,2606-2620`, `image-prompts.vue:2395`).
- **P1-33. Image Prompts makes up six aspect ratios** when the model publishes none (§1) (`image-prompts.vue:1675-1679`). Return `[]` and disable the control, as `scene-review.vue:872` does.
- **P1-34. The Images page calls the retired `/imagestudio/models` endpoint** (404 on every mount) and shows prices stored in project config instead of the live catalogue (§1/§7) (`images.vue:682-731,1074`).

**Security (desktop mode)**
- **P1-35. Websites can send "simple" POSTs to the API**, because there is no Origin check (`security.ts:59`). They can restart the app (`system.ts:528`), pause the queue (`:416`), send the digest (`app-settings.ts:392`), disable a pack, or stop the archive. Reject a foreign `Origin` in `requireAllowedHost`.
- **P1-36. CORS trusts `localhost:3000` in the shipped app**, because `isDev` is always true inside Electron (`app.ts:77-83`). This needs an owner decision (§7-6).
- **P1-37. A project name containing an encoded `%2F` can point outside the Library**, and a permanent delete can follow it (`middleware.ts:28`, `project-manager.ts:1611`, `soft-delete.ts:196-200`). Return 400 when `slug !== path.basename(slug) || slug.startsWith('.')`.

---

## 4. Priority 2: lower severity

- **§1, limits enforced but not shown:** video prompts capped at 4,000 characters (`genstudio-client.ts:5160`; the cap isn't read from the catalogue), images at 32,000 (`:7974`), transcription at 100 MiB (`:144,1311,8293`).
- **§6, zero means two things:**
  - chat and transcription `minimum_credits` parse to `0` when absent (`genstudio-client.ts:4827,7308-7313`);
  - `fade_duration: 0` becomes 5 s (`video.ts:1570,4290`);
  - a failed audio probe means "no audio" (`broll-assemble.ts:66-83`);
  - `boot-recovery.ts` counters are never incremented, so they always read 0.
- **Made-up values:**
  - `max_reference_images = 1` is invented (`image-model-resolver.ts:243-245`);
  - scene-clip matches legacy ids by name fragments (`'3'`) (`scene-clip.ts:205-242`);
  - there is a dead `'deepseek-v4-flash'` literal (`audio.ts:710`);
  - there is a fixed token-to-word ratio, and a dead `shouldChunkByBudget` (`chunked-narration.ts:264-269,300,414`).
- **The voice-library list is hardcoded** while the wording claims GenStudio published it (§1/§2) (`genstudio-client.ts:1501-1504`, `app-settings.ts:645-647`).
- **Missing timeouts and waits:** the music download has no timeout (`music-generate.ts:233`); catalogue reads ignore `Retry-After` (`genstudio-client.ts:4033-4052`); video retries re-upload the source with no idempotency key (`:5186-5227`, suspected).
- **Temp-file names can collide:** `writeAtomic` builds them from pid and milliseconds only (`sync-safe.ts:38`); `production_standards.txt` is written in place (`project-manager.ts:1592`); an unreadable project `secrets.json` is treated as empty and overwritten (`secrets-store.ts:104-140`).
- **Folder handling:** a case-only title change never renames the folder on APFS (`episode-folder-title-sync.ts:100`, `episode-renumber.ts:107`) **(R)**.
- **Leaks and final-video proof:**
  - subtitle temp files leak on failure (`subtitles.ts:797-799`);
  - the final-video check doesn't verify there's an audio stream (`video.ts:5495-5520,184`);
  - the AI-video check is size > 0 only, so an interrupted download is later skipped as "exists".
- **Audio mixing:** `amix` lowers narration by 1/N as layers are added (`video.ts:4492`, `audio-merge.ts:1431`, `broll-assemble.ts:473`); this needs an owner decision (§7-2).
- **Stale previews:** preview caches are keyed by path only, and `preview-audio` doesn't clamp the end of a range request (`routes/video.ts:521-528,717-727,810-815`).
- **Plaintext Telegram token:** stored unencrypted and returned in full to the page (`job-notifier.ts:269`, `app-settings.ts:248`); this needs an owner decision (§7-5).
- **Hardcoded character:** the scene-planner prompt assumes a male guide ("he", "no boy") whatever the project's character is (`scene-planner.ts:257-290`).
- **Frontend odds and ends:**
  - a hardcoded "~$0.005" tooltip (`PreviewPromptRow.vue:38`);
  - the scripts-page `reloader` interval isn't cleared (`scripts.vue:747`);
  - a keystroke-per-save on the ideas page (`ideas.vue:1840-1849`);
  - a silent `catch {}` on the custom-styles save (`scripts.vue:1418-1428`);
  - the pause toast doesn't check the result (`jobs.vue:1753`);
  - dead Animate code reads the retired `config.video_models` (`scene-review.vue:889-940`);
  - a `v-if="false"` cap preview (`image-prompts.vue:871,904,1096-1112`).

---

## 5. Why these bugs happen (root causes)

1. **The same thing is written many times, and the copies drift apart.** Most defects are in the copy that fell behind:
   - worker pools: 4 (images, audio, subtitles, image-pool)
   - ffmpeg spawn wrappers: 6
   - filter escapers: 3 (only one is tested against real ffmpeg)
   - GenStudio wait loops: 6; catalogue parsers: 7
   - "is it complete?" rules: 3 (generator `requireJobCompletion`, boot auditors, Pipeline `isStepAlreadyDone`)
   - episode-code parsers, folder resolvers and preset snapshot helpers: several each
   - small helpers: `isRecord` ×7, `formatBytes` ×7 (`useFormat.ts:11` already exports it), `formatCredits` ×5, `formatDuration` ×6, `slugify` with two different algorithms
2. **The file readers break the repo's own §6 rule.** `readJsonOr` (`atomic-store.ts:243`), `readManifest`, `readPersistedJobs` and `secrets-store` turn "corrupt" into "empty", and the write paths then save that emptiness.
3. **Completion is proven by files existing.** That breaks §8 inside the very generators that claim to follow it.
4. **Cancel means "kill whatever is running once"**, not "refuse to start anything more".
5. **The biggest files are the least stable.**

   | File | Lines | Commits | `fix` commits |
   |---|---|---|---|
   | `genstudio-client.ts` | 8,664 | 134 | 63 |
   | `job-queue.ts` | 5,990 | 168 | 82 |
   | `video-assembly.vue` | 6,884 | — | — |
   | `settings.vue` | 6,502 | 134 | — |
   | `types.ts` | 4,730 | 225 | 28 |

   23 files are over 2,000 lines. The Graphify graph also shows an import cycle: `scene-image.ts → scene-plan.ts → video.ts → scene-image.ts`.
6. **The tests read code instead of running it.**
   - 158 of 213 frontend test files (74%) regex-match `.vue`/`.ts` text; 66 of them run no product code at all.
   - There are about 6,200 `assert.match` calls, of which at least 1,550 search source text.
   - `jobsControls.test.ts` has 182 regexes over `jobs.vue`; that test file was changed in 17 fix commits.
   - A few tests can't fail: `asset-importer.test.ts:287-301` and `upload-resume-sidecar.test.ts:191` end in `assert.ok(true)`.
   - There are 165 fixed `setTimeout` sleeps across 49 files.
   - Test files are never linted (`eslint.config.mjs:6`) or type-checked.
   - The frontend has no lint at all.
7. **Process.**
   - Every package was "self-accepted" by the session that wrote it.
   - There were 887 version bumps in 150 days (about 5.9 a day), four DMGs on 2026-09-22 alone, and 14 of the 23 commits since the takeover are docs-only.
   - `a8d15229` bumped the version and changed the completion audit, then had to be reverted 11 minutes later (`e7bd7cd2`) because "the full gate failed immediately".
   - The Upload Center needed five "restore" commits in two days.
   - The 180 KB status file points to a Graphify graph that no longer exists, and claims DMGs are "preserved under `_trash/`" when that folder is empty.
   - 57 exported functions have no references at all.
   - `.superpowers/` (350 files, about 74 MB) is tracked in git.

---

## 6. Proposed fix plan (Ponytail: smallest complete change, root cause first)

### Phase A: stop the bleeding (money, data, security)
Do the twelve P0 items as separate small packets, each with its one regression test from §2 (write the test first and watch it fail). Most are 1–10 line diffs in a shared function:
- `maybeFinish`
- `requireJobCompletion` + `invalid: errors`
- `hasAuthoritativeCompletionDeclaration`
- the `readJson` status order in the GenStudio client
- `findGenStudioProduct` everywhere, with no fallback
- strict read-for-write in `app-settings`
- `trackChild` refusing processes after a cancel
- the still-image loop
- leaving title text out of the preset snapshot
- the strict manifest read
- `withLock` + `writeJsonAtomic` for research
- the loopback + Host + XFF check

**One application release, not twelve.**

### Phase B: one of each (deletion over addition)
Consolidate onto helpers that already exist:
- **Reads:** one strict read-for-write; delete lenient reads from every write path.
- **Writes:** every JSON file that holds a decision goes through `withLock` + `writeJsonAtomic`.
- **ffmpeg:** one spawn wrapper (`runFfmpeg` with `trackChild` and a watchdog); delete the other five.
- **Escaping:** one escaper (`escapeFilterArgValue`/`escapeFilterPath`); delete `escapeDrawtext` and the B-Roll escaper.
- **Workers:** one worker pool, with the fixed pause and cancel semantics.
- **Completion:** one rule shared by the generator, the boot auditor and Pipeline, as §8 already demands.
- **Model lookup:** `findGenStudioProduct` only, backed by a lint rule banning `models.find(m => m.id ===`.
- **Folders:** one episode-folder resolver and one episode-code parser (`episodeDirNameMatchesCode` + `formatEpisodeCode`).
- **Presets:** snapshot/apply in `utils/video-assembly-presets.ts`, with the page copies deleted.
- **Helpers:** delete the duplicate `isRecord`, `formatBytes` and `formatCredits` copies and the 57 unreferenced exports (into `_trash/`, per the working rules).

### Phase C: make the gates see behaviour
- Whenever a fix touches a page, replace that page's text-matching tests with one mounted test. `happy-dom` and `@vue/compiler-sfc` are already installed, and 63 test files already use the pattern (e.g. `audioDeepLink.test.ts`).
- Lint `electron/server/__tests__`.
- Turn on `noImplicitAny` for the frontend, one page at a time, starting with `jobs.vue` and `scene-plan.vue`.
- Replace fixed test sleeps with waits on the job's own events.
- Extend `check:model-drift` so it catches the literals listed in §1.

### Phase D: split the god files (move-only commits, no behaviour change)
- **`genstudio-client.ts`** → `genstudio/transport.ts`, `catalog/*.ts` (shared field readers), `jobs/*.ts` and `errors.ts`, and move paid replacement out to `services/`. One `pollSettled` and one `downloadArtifact` remove about 400 lines.
- **`job-queue.ts`** → persistence / reconciliation / lanes.
- **`video-assembly.vue`** → one component per wizard step.
- **Break the import cycle:** `scene-image → scene-plan → video`.

### Phase E: process
- **Independent review.** A package is accepted by a reviewer who didn't write it (another model or you), never "self-accepted".
- **One version bump per shipped release**, not one per fix.
- **Paste the release gate's completion line** into every version-bump commit.
- **Cut `Story Studio Project Status.md` to current state, under 300 lines**, and move the history to `docs/history/`.
- **Make AGENTS.md point to things that exist:** `graphify-out/graph.json` in this checkout (rebuild with `graphify update .`), and the Claude (`~/.claude/skills/`) and Codex (`~/.codex/skills/`) install paths for Ponytail and Graphify.
- **Stop tracking scratch material:** move `.superpowers/` and `task-1c-report.md` to `_trash/` and gitignore them.

---

## 7. Decisions only the owner can make (don't decide these in code)

1. **Merged audio:** which file should Video Assembly render, the base file or the latest saved version (`_v2`)? The comment in `intro-lead-in.ts:228` says "base wins" deliberately.
2. **Narration loudness:** adding `normalize=0` to `amix` makes narration louder whenever music or sound layers are on.
3. **Voice library:** GenStudio doesn't publish the list. Keep the hardcoded list with corrected wording, or ask gateway-kh to publish it?
4. **Reference images:** should "supports reference images" with no published maximum mean 1, or should the control be disabled?
5. **Telegram token:** hide it in Settings (write-only, like the API keys)?
6. **CORS:** delete the `cors()` block entirely? Only if no browser extension relies on it (`app.ts:52`).
7. **Slugs:** `slugify` has two algorithms. Pick one, or leave both, since existing slugs on disk depend on them.
8. **`_trash/`:** it's almost empty, and its README lists about 10 items that are gone. One tracked file (`_trash/format-niche-refactor-plan.md`) shows as deleted.
9. **Server mode:** is it actually used? If not, P0-12 drops to low priority.

---

## 8. Credit where it's due (checked and sound)

- **Electron window:** `contextIsolation`, `sandbox`, no `nodeIntegration`, no IPC handlers; navigation and new windows are denied; `openExternal` accepts http/https only.
- **Desktop network:** listens on `127.0.0.1` on a random port, with a Host guard against DNS rebinding.
- **`.sspack` import:** a strict custom ZIP parser (rejects `..`, absolute paths, ZIP64 and encryption; caps sizes; checks SHA-256 per file and an Ed25519-signed manifest), and the installer checks each folder it creates so it can't be redirected through a symlink.
- **YouTube:** OAuth uses PKCE S256, and resumable uploads carry durable operation records that prevent duplicates.
- **Commands:** `spawn`/`execFile` with argument arrays everywhere; no string exec.
- **Safe-write helpers:** `writeJsonAtomic` and `withLock` exist and are the second- and third-most-connected helpers in the code graph. The design is right; it just isn't applied everywhere.
- **Test hygiene:** no `.skip` or `.only`, no real network calls in tests, a fake home directory, and a runner that checks every file completed.
