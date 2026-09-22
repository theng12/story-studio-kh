# ACCEPT-01 — cross-workflow acceptance on a disposable Library — **complete (self-acceptance)**

**Status: closed 2026-09-22.** Legs 1–8 ran end to end on the canonical project against the repository's own
mock gateway (zero paid submissions): ideas → script → audio → audio assembly → subtitles → Scene Plan →
thumbnail prompts → thumbnails → scene images → Scene Review approval → local Video Assembly →
metadata/upload preparation, plus the model switch, both cancellation directions, the missing-image block
and every completion-audit refusal. Two defects were found and fixed on the way (`NEW-12`, `NEW-14`); one
further finding (`NEW-13`) is reproduced with its fix direction recorded. What this packet **cannot** prove
is stated in "Honest limits" below and is exactly the external set: real provider output, real speech
timing, a real upload, and signed/notarized distribution (`X-07`, `RELEASE-01`).

## What this packet is
The owner's item 6: run the app for real on a disposable Library with **fake provider outputs** and
prove that a representative supported workflow produces artifacts whose expected IDs and usable bytes
agree across the generator, Jobs, Pipeline and Production Board — including complete, partial, empty,
malformed and provider-failure outcomes, restart/cancel/resume, and no duplicate paid submissions.

**No real provider call, no upload, no publish.** The gateway is the repository's own in-process mock
GenStudio fixture, hosted as a real HTTP server on loopback.

## Harness (all disposable)
| Piece | Detail |
|---|---|
| Library | `/tmp/ssk-accept-data` (`STORY_STUDIO_DATA_DIR` + `--user-data-dir`), created empty for this packet |
| App | dev app from this checkout (`electron .` + Nuxt dev on :3000), backend on `http://127.0.0.1:8791`, version **1.4.217** |
| Gateway | `scripts/developer/serve-mock-genstudio.ts` — the `MockGenStudioService` fixture as a standalone server (`--port`), or hosted in-process by the driver. Control routes: queue a scenario, clear queued answers, publish an alternate language catalogue, read accounting |
| Driver | `scripts/developer/accept-01-driver.ts` (`npx tsx … --leg script\|audio\|subtitles`) — points the app at the gateway, drives the app's own routes, then reports jobs + on-disk bytes |
| Gateway lifetime | **long-lived** (`serve-mock-genstudio.ts --port 8799`, attached with `ACCEPT_MOCK_URL`). Provider job ids written into project manifests must still resolve after an app restart, which is the property the restart/resume leg exists to observe; an in-process per-run mock cannot show it |
| Evidence check | every artifact below was read from disk with its byte size; every job status came from `GET /projects/:slug/jobs` |

The mock publishes `mock-chat-v1`, `mock-tts-v1`, `mock-image-v1` and transcription/video/music models
with `MOCK_GENSTUDIO_FULL_KEY`, an account with 1,000 credits, and per-run scenario queues.

**Backend identity confirmed before any workflow work:** after `PUT /app-settings/genstudio {url}` and
`PUT /app-settings/api-keys/genstudio`, `GET /app-settings/genstudio/overview` returned the mock's own
account (`"Angkor Pro"`, 1,000 credits) — the app was demonstrably talking to the mock and to nothing
else. Story Studio still talks to exactly one endpoint.

## Seeded state (fresh setup)
- Project `ACCEPT-01 Walkthrough 2026-09-22` → slug `accept-01-walkthrough-2026-09-22`, prefix `EP`,
  4 digits, from `POST /projects`.
- Two ideas imported through `POST /projects/:slug/ideas/import-paste`, then accepted through
  `POST /ideas/:ideaId/accept` → **EP0001** "The Ledger of a Vanishing Harbour",
  **EP0002** "The Cartographer of Sleeping Streets", each with its own
  `episodes/Season 001/<code> - <title>/` folder and `episode_info.json` (510 B / 505 B).

## Canonical run: project `accept-01-walkthrough-v2-2026-09-22`
The first project (`…-2026-09-22`) was an iteration artifact: its audio manifest recorded provider job
ids from short-lived mocks, and the app correctly refused to re-submit work it could not verify
("GenStudio KH request failed: mock route not found" while polling the recorded ids). That refusal is the
behaviour ACCEPT-01 wants to see, but it cannot be carried forward. All legs below therefore ran on
**v2** against the one long-lived gateway, so every recorded provider id resolves for the whole
walkthrough. Leg 1 was re-run there from scratch and reproduced byte-for-byte (chapter files
244/244/246 B; narration 837 B / 843 B).

## Leg 1 — ideas → script (outline → approve → expand) — **complete, both episodes**
Driven through the Scripts page's own routes (not the database): `POST /generate/outline-only` →
`GET /episodes/:code/outline` → `PUT /episodes/:code/outline {outline, approved:true}` →
`POST /generate/expand-chapters`.

| Check | EP0001 | EP0002 |
|---|---|---|
| outline job | `done` — "Outline ready: 3 chapter slots" | `done` — "Outline ready: 3 chapter slots" |
| outline read back | 200, **3 slots** | 200, **3 slots** |
| approval | 200 (approved) | 200 (approved) |
| expansion job | `done` — "wrote 1 chapter(s) (3) · Expansion pass complete: **3/3 chapter file(s) on disk (2 batches)** · Re-assembled: EP0001_Script_Narration.md" | `done` — same, `EP0002_Script_Narration.md` |
| chapter files (bytes) | `Chapter_01.md` 244 B · `Chapter_02.md` 244 B · `Chapter_03.md` 246 B | 244 B · 244 B · 246 B |
| re-assembled narration | `EP0001_Script_Narration.md` **837 B** | `EP0002_Script_Narration.md` **843 B** |
| progress sidecar | `EP0001_chunked-progress.json` 1,413 B | 1,413 B |
| provider submissions | 2 chat submissions | 2 chat submissions |
| credits charged by the mock | **0** | **0** |

Cross-surface agreement for the script step:
- **Generator (Scripts page data)** — `GET /projects/:slug/episodes` reports `status.script: true` for both.
- **Jobs** — the four script jobs above are `done`; history keeps the refused attempts (below) with their
  real error text, not a generic failure.
- **Production Board** — the Board reads the same `status` map, so both episodes show the script stage
  complete (`all_done` is still false, correctly: audio, subtitles, media and assembly are outstanding).
- **Pipeline** — see the preset note below; the pipeline is not the surface this leg ran on.
- **Disk** — the bytes in the table above, read directly from the disposable Library.

## Leg 2 — audio → audio assembly (FFmpeg) — **complete, both episodes**
`POST /generate/audio {model: mock-tts-v1, voice: mock-voice, speed: 1}` then
`POST /generate/audio-merge {normalize_volume: false}`.

| Check | EP0001 | EP0002 |
|---|---|---|
| TTS job | `done` — `GenStudio task: Chapter 0N -> mock-tts-001/002/003`, `Saved: …_Chapter_0N.mp3`, `Activated voice model boundary: mock-tts-v1` | `done` — `mock-tts-004/005/006` |
| chapter audio | 3 × `.mp3`, **3,789 B** each | same |
| merge job | `done` — "Chapters: 3 valid files … Output: `EP0001 - 08 Audio Merge Output/EP0001_merged_audio.mp3` · Duration: 2.3s · Opening recorded: no intro — narration only." | same for EP0002 |
| merged audio | `EP0001_merged_audio.mp3` **57,095 B**, `ffprobe`: `format_name=mp3`, `duration=2.301633` | 57,095 B, identical |
| completion record | `EP0001_merged_audio.completion.json` 253 B | 253 B |
| chapter timings | `audio_chapters.json`: 3 sections × 0.1 s, `gap_duration_s: 1` (3×0.1 + 2×1 = 2.3 s — agrees with ffprobe) | same |
| quality fingerprint | `audio_quality.json` 2,091 B | 2,091 B |
| provider accounting | 3 TTS submissions | 3 TTS submissions |

**No duplicate paid submissions on re-run (checked, not assumed).** Running the whole audio leg a second
time produced `Skipping EP0001_Chapter_03.mp3 (exists) | Existing audio was already present; active
source selection was left unchanged.` and the gateway's TTS submission count stayed at **6** — the app
reused verified files instead of paying again.

**Finding — two-pass loudnorm cannot measure silence.** The merge defaults for this format turn on
volume normalization, and the mock's audio is silence, so the first merge attempt failed honestly:
`Pass 1: measuring EP0001_Chapter_01.mp3 · Pass 2: applying normalization (I=-infdB)` →
`Local auto-retry exhausted after 3 attempts. Verified partial files remain on disk; manual Retry starts
another free recovery cycle.` → `FFmpeg exited with code 222 … Value -inf for parameter 'measured_I' out
of range`. The app neither claimed success nor deleted the chapter files. The walkthrough then used the
request's own `normalize_volume: false` (a choice the UI offers) and the merge succeeded. A real TTS
provider never returns pure silence, so this is a fixture-induced edge case — but the failure mode is
recorded because it is the only place so far where a *local* tool failure was handled: retried, named,
and left with recoverable partial work.

## Leg 3 — subtitles (transcription) — **complete, both episodes**
`POST /video-editor/subtitles/transcribe/:episodeId {model: mock-whisper-v1, language: en}` — the quote
is requested, confirmed, then the SRT is fetched (`/v1/audio/transcriptions/quotes` →
`…/confirm` → `/v1/transcriptions/<id>/srt`).

| Check | EP0001 | EP0002 |
|---|---|---|
| job | `done` — "Language: en (requested) · Source: `EP0001_merged_audio.mp3` · merged: Subtitle task recovered; verifying its artifact and stitch next. · Wrote 1 cues" | same, `EP0002_merged_audio.mp3` |
| subtitle file | `EP0001 - 09 Subtitles Output/EP0001_whisper.srt` 59 B — `1\n00:00:00,000 --> 00:00:01,000\nHello from mock GenStudio.` | 59 B, same cue |
| sidecars | `.task-manifest.json` 435 B · `.subtitle-recovery.json` 926 B · `audio_sentences.json` 1,888 B | 435 B / 929 B / 1,888 B |
| provider accounting | 1 transcription submission | 1 transcription submission |

Episode status after legs 1–3, read from `GET /projects/:slug/episodes` (the map the Production Board
reads): **EP0001 and EP0002 both `script: true`, `audio: true`, `merged_audio: true`, `subtitles: true`,
`all_done: false`** — `all_done` is correctly false because the visual and assembly stages have not run.

## Leg 4 — Scene Plan (timeline → visual prompts) — **complete, and it found a real defect (fixed)**

`POST /scene-plan/:ep/stitch-subtitles` → `POST /scene-plan/:ep/run {stage:'timeline'}` →
`POST /scene-plan/:ep/run {stage:'visual', model:'mock-chat-v1', use_research:false}`.

| Check | EP0001 | EP0002 |
|---|---|---|
| stitch | 200 — `<EP>_stitched.srt` written from the per-chapter transcripts (2.3 s) | same |
| timeline job | `done` — "Timeline ready: 1 cue-aligned scene(s), starting at 0.0s. No LLM was used." | same |
| plan on disk | `ep0001-scene-0001`, 0 → 2.301633 s, `planning_stage: visual`, `timeline_built_at` set | `ep0002-scene-0001` |
| visual job | `done` — "Processing 1 adaptive pack(s) through GenStudio KH (genstudio-chat:mock-chat-v1) · Checkpointed visual-0001: 1/1 prompts verified on disk · Verified 1/1 visual prompt(s) on disk by stable scene ID" | same |
| visual prompt | written and verified by stable scene ID (`visual_prompt` non-empty in the plan) | same |

The provider answer for the visual stage is built **from the plan the app just wrote** (one row per
scene id, no more and no fewer) — a fake provider must answer the request it actually receives, and the
contract is per-scene (`minItems === maxItems === sceneIds.length`).

### The defect this leg found: "Build timeline" failed its own completion audit — **reproduced and fixed**
- **Symptom (rendered, not inferred):** the Scene Plan page's "Build timeline" action posts
  `{stage:'timeline'}` (`scene-plan.vue:2326`). The job built a correct plan and then failed:
  `scene_plan_run reported success, but re-reading its output found required items missing or could not
  verify it. Nothing already produced was discarded — Retry repairs only the gaps.`
- **Evidence at HEAD:** `scene_plan.json` written with `planning_stage`, `timeline_built_at`,
  `ep0001-scene-0001` 0 → 2.301633 s, `boundary_reason: deterministic split (cue-aligned)`, and
  `visual_prompt: ''` — the model-free step had done exactly its job. The job still ended `error` after
  three local attempts ("Local auto-retry exhausted after 3 attempts"), for both episodes.
- **Root cause:** `auditScenePlanOutput` folded every non-motion stage into `'visual'`
  (`params.stage === 'motion' ? 'motion' : 'visual'`) and then demanded a non-empty `visual_prompt` for
  every scene. A timeline-only run is documented as deliberately model-free
  (`SCENE_TIMELINE_ONLY_OUTPUT_BUDGET`, "A timeline-only run is deliberately model-free"), so it could
  never satisfy that audit. `assertAuditedCompletionOnSuccess` runs exactly this auditor, so a correct
  timeline always failed the job.
- **Fix:** `boot/executors.ts` now recognises `stage: 'timeline'` (and only that — the repair flags keep
  their old stage) and audits the timeline on its own proof: at least one scene with finite,
  forward-running timings **and** a recorded `timeline_built_at`. Everything else is unchanged, including
  a Pipeline run (no `stage`) and the explicit visual stage, which still require prompts.
- **Regression test:** `electron/server/__tests__/scene-plan-timeline-audit.test.ts` — RED at HEAD
  (`'repair-required'` where `'complete'` is required), GREEN after the fix; the second case pins the
  other direction (no scenes / zero-length scene / missing `timeline_built_at` → still
  `repair-required`), and the existing `scene-motion-scope-enforcement.test.ts` keeps the motion stage
  pinned. Focused run after the fix: **11 tests, 11 pass, 0 fail** (both files).
- **Verified in the live app, not only in the test:** the backend was recompiled and the acceptance app
  restarted, then the same request re-run — `EP0001` and `EP0002` timeline jobs both `done`.
- **Release note:** this is an application-facing fix, so it needs a version bump and a changelog line at
  the next release decision. The tree is not bumped yet; the installed app remains 1.4.217.

## Leg 5 — thumbnail prompts → thumbnails → planned scene images — **complete, both episodes**

| Check | EP0001 | EP0002 |
|---|---|---|
| thumbnail prompts, first attempt | 3 rows answered against **5 required** → job `error`: "Thumbnail prompt generation incomplete: 3/5 required item(s) verified. Missing/invalid: Thumbnail 4, Thumbnail 5. Verified prompts were saved; Retry requests only the missing thumbnail prompts." | same |
| thumbnail prompts, gap-filled | `done` — "Saved thumbnails → `<EP>_Thumbnail_Prompts.md` · Done." The app asked for exactly the two slots still absent (`on disk 1,2,3; asking for 4,5`), which the driver read from the app's own `.completion.json` (`expected: 5`) and prompt file | same |
| thumbnails | `done` — "Thumbnail 4/5 saved · Thumbnail 5/5 saved · All images generated successfully"; `EP0001_Thumb01…05_v1.png`, 68 B each | same for EP0002 |
| planned scene images | `done` — "GenStudio image batch — GenStudio KH / mock-image-v1 · 1/1 scene(s) · missing-only repair (skip recovered) · Scene 1/1 (ep0001-scene-0001) ✓" | `ep0002-scene-0001` ✓ |
| scene image file | `ep0001-scene-0001.png`, 68 B | 68 B |

Two things worth recording from this leg:
- **The partial-output refusal is real and precise.** A short prompt batch failed the job, named the
  missing slots, said the verified prompts were kept, and said Retry asks only for the gaps. The gap-filled
  run then proved that claim: the next request asked for `4,5` only.
- **`fill_gaps` is what makes a retry cheap.** A fresh generate without it asks for all five slots again;
  the page and the job-Retry path both set `fill_gaps: true` (`routes/jobs.ts` `retryReplacementParams`),
  which is why the second attempt could be answered with two rows.

## Leg 6 — Scene Review approval → Video Assembly (local FFmpeg) — **complete, both episodes**

| Check | EP0001 | EP0002 |
|---|---|---|
| scene review approve | `PUT /scene-review/:ep/approve {all:true}` → 200, `{"total_scenes":1,"approved":1,"with_image":1,"all_approved":true}` | same |
| assembly job | `done` — "External final-video root configured → … · Renamed to: `EP0001_final_video.mp4` · Video saved: `EP0001_final_video.mp4`" | `EP0002_final_video.mp4` |
| ffprobe | `h264` 1920×1080 + `aac`, `mov,mp4`, **duration 2.333333 s**, 10,591 B | same |
| provider submissions | none — Final Video Assembly is local-only | none |

**Operational note (recorded, not a defect): the export root is not inside the disposable Library.**
`/library` resolves exports as `<Library root>/Exports`, and the Library root here was the default
`~/Documents/Story Studio KH` — the acceptance app's own settings file held that root even though its
projects lived in `/tmp/ssk-accept-data`. The two final videos therefore landed in the owner's
`Documents`; they were **moved (never deleted) to `_trash/documents-exports/accept-01-walkthrough-v2-2026-09-22/`**
and the owner's Documents left as it was. A future acceptance run should re-point the Library root first
(`PUT /library`, which refuses without an explicit `move` — deliberately). The acceptance app's
app-settings file is `/tmp/ssk-accept-data/app-settings.json`; the owner's real
`~/Library/Application Support/Story Studio KH/app-settings.json` was verified untouched (it holds only
`library_root`, no gateway URL), so no acceptance run ever redirected the installed app.

### Finding — the episode status cache cannot see the external final-video root (`NEW-13`, reproduced; fix not written)
The assembly leg produced a second, separate observation that is **not** an assembly defect. While the two
finals were briefly absent from the export root (this walkthrough moved them out, see the operational note
above), the app computed and **persisted** `video_assembly: false`; restoring the files did not change the
answer, and it survived an app restart. Evidence:

- The persisted cache is `<userData>/cache/<slug>/episode-status.json`; both entries there hold
  `video_assembly: false`, `computedAt: 2026-09-22T15:54:12.998Z`.
- Its `watchedMtimes` for each episode are **13 paths, all inside the project tree** (`episode_dir`, the
  per-stage folders, `scene_plan.json`, `audio_chapters.json`). The external final-video root
  (`<library>/Exports/<slug>/…`) and the `<code>_video_assembly_source.json` stamp beside the final are
  **not watched**.
- A fresh computation of the same episode, same data, same helpers but no cache
  (`scripts/developer/probe-video-assembly-status.ts`) returns **`video_assembly: true`** with
  `final_video_bytes: 10591` — so the status logic and the stamp agree; only the cache is stale.

So the assembly path, the stamp, and the status rule are all correct, and the status *does* heal whenever
anything inside the project tree changes. The gap is narrow but real for the owner: his Library root is
`~/Documents/Story Studio KH`, so his finals live at the external root, and any status recomputation while
that root is unreachable (drive unplugged, `Exports` archived or moved, cloud eviction) is cached and then
kept after the final is back — the Production Board would show Video Assembly unfinished for a finished
episode, or (in the opposite direction) keep claiming it is done after the final is gone.
**Fix direction (not implemented here):** add the resolved external final-video directory and the stamp
file to the watched roots when an external root is configured, with the same care the cache already takes
for a watcher that may not exist yet (`watcherTrustedSince`); a removable volume must not be treated as a
trusted empty folder. Deliberately left unfixed this round rather than changed hastily in a hot,
concurrency-sensitive path.

## Leg 7 — metadata → upload preparation (no upload), plus the blocking checks — **complete**

| Check | EP0001 | EP0002 |
|---|---|---|
| finalizer preflight | 200 — `audio_assembly_ready: true, subtitle_complete: true, subtitle_mode: full-track, chapter_count: 3, source_count: 0, warnings: []` | same |
| metadata job | `done` once a **fresh action id** is stamped — "Generating 15 tag(s)… → 15 tag(s) · Finalized YouTube package: 3 chapter marker(s) · Saved → `<EP>_Metadata.json`" | `done` on the first attempt (fresh episode identity) |
| episode status | `metadata: true` | `metadata: true` |
| upload | **none attempted** — the leg stops at the finalized package and its readiness report | same |

### `NEW-14` — a metadata job can fail on a short provider answer in a way its own Retry cannot repair (**reproduced-fixed**)
Three EP0001 metadata jobs tell the story. The fixture's first answer to a description/tags request is one short line,
so the generator correctly refused the package (`3/17 required item(s) verified … Missing/invalid: tag 2 … tag 15`)
while keeping what it had. Re-running the **same route with the same params** produced the *same* failure, and the
provider evidence shows why:

| job | created | provider job cited | params | result |
|---|---|---|---|---|
| `e49b81c9` | 08:58:22 | **`mock-chat-001`** | no `operation_id`, no fingerprint | `error` 3/17 |
| `61457d82` | 08:58:40 | **`mock-chat-001`** | identical | `error` 3/17 |
| `aca65751` | 08:59:00 | **`mock-chat-001`** | identical | `error` 3/17 |
| `8d60980b` | with a fresh `operation_id` | new provider job | — | **`done` 17/17, 15 tags** |

An identical request identity reuses the provider idempotency key, so the provider replays the same short answer —
which is the correct cost-safety behaviour, but it means the terminal message "Retry to generate the missing fields"
is not true for the **Jobs Retry** control: that path re-runs the stored params unchanged
(`retryReplacementParams` only special-cases `image_prompts`). The Finalizer page *can* heal, because it always
stamps a fresh action (`freshMetadataAction` in `metadata.vue`) — proven by the fourth job above, which completed
with the very same seeded provider answers. **Fix (this round):** `routes/jobs.ts → retryReplacementParams` now mints a fresh language action
(`stampFreshGenerationAction(params, randomUUID())`) for a `metadata` retry that has **no** saved action, and marks
what it minted `origin: 'retry'` so the *next* retry mints again instead of preserving the previous mint. An action
the customer's page stamped is still preserved untouched — the behaviour
`electron/server/__tests__/job-retry-route-contract.test.ts` already pinned, and the reason the fix is deliberately
narrow. Regression cases added to that file: a bare metadata retry carries a fresh action (valid UUID + fingerprint)
and changes nothing else; **two consecutive retries carry different action ids** (the live loop below caught the
first version of this fix preserving its own mint).

Verified live on a freshly started gateway, three attempts on the same bare metadata job:

| step | job | result | provider jobs |
|---|---|---|---|
| A — bare attempt, short answers queued | `31707af7` | `error` 3/17 | `mock-chat-001`, `mock-chat-002` |
| B — Jobs Retry #1, short answers queued | `5bfb9976` | `error` 3/17 (new provider jobs — **no replay**) | `mock-chat-003`, `mock-chat-004` |
| C — Jobs Retry #2, fifteen tags queued | `52a0cfab` | **`done` 17/17**, 15 tags | `mock-chat-005`, `mock-chat-006` |

Six gateway submissions across three attempts: every retry asked the provider afresh, and the first retry whose answer
was usable completed the package. (A and B are absent from the job list afterwards because an admitted retry replaces
its terminal original — the existing "only an admitted retry may replace its terminal original" contract.)

### Cancellation — both directions now exercised
A deliberately slow image batch (mock `submitDelayMs: 8000`, five thumbnail renders) was cancelled 3 seconds in.
The app **refused** the cancel: `CANCELLATION_STATUS_UNKNOWN` — "Story Studio cannot yet prove whether every provider
request was accepted", control `return-later`, disabled. The batch then settled normally (5 image submissions, all
5 thumbnails saved, job `done`) and nothing was resubmitted. That is the H-16 contract behaving as designed: it
will not risk stranding or duplicating paid work on an unproven cancellation.

**When acceptance is proven and the provider still offers cancellation, the cancel is admitted and honoured.**
The fixture needed no change after all: an image scenario whose state stays `accepted` for several polls
(`['accepted' × 6, 'succeeded']`) is `cancellable` throughout, which is exactly what the app checks before it will
cancel. Live run (forced 5-thumbnail re-render, fresh `operation_id`):

| Observation | Evidence |
|---|---|
| cancel admitted | `POST …/jobs/52e5b521/cancel` → `{"ok":true,…}`, where the earlier unproven case had returned `CANCELLATION_STATUS_UNKNOWN` with the control disabled |
| provider cancellation honoured | "Thumbnail 1/5: FAILED — GenStudio KH image job `mock-image-001` was cancelled (Cancelled before provider execution.). GenStudio reports 7 credits released" — for `mock-image-001/002/003` |
| no new paid submission | the app's own line "Story Studio is reconciling the provider cancellation; **no new generation request was sent**", and the gateway's image submission count stayed at **5** |
| valid work kept, gap named | the two uncancelled tasks finished and saved ("Thumbnail 4/5 … saved", "Thumbnail 5/5 … saved"); the job settled `error` with "Completed with 3 error(s) … Provider work settled with mixed completed and cancelled tasks. Repair missing output before Retry." |
| provider evidence | `mock-image-001/002/003` `state: accepted, cancelled: true`; `mock-image-004/005` `state: succeeded` |

So the whole cancellation contract now has live evidence in both directions: refused when acceptance is unproven,
honoured when it is, credits released for the cancelled provider tasks, no replacement request sent, and a mixed
outcome reported honestly rather than as a success.

### Missing-image blocking check — confirmed (AGENTS §7)
With `ep0001-scene-0001.png` moved out of the episode's scene-images folder, assembly refused instead of reusing a
different image or finishing a short video:

```
Video Assembly is blocked: 1 missing image(s): #1. Open Scene Plan or Scene Review, repair only the listed items, then retry.
```

The image was restored afterwards (68 B). No alternative image was substituted and no partial video was claimed.

## Leg 8 — model switch (AGENTS §1) — **complete**

The fixture needed to be able to publish a *second* language product before this could prove anything, so
`MockGenStudioService` gained an optional `chatModels` field (null keeps the single default row, so no
existing test changed) and the standalone runner gained `POST /__control/chat-models`. The three
catalogue-related suites stayed green (101 tests).

| Step | Evidence |
|---|---|
| Publish a second product | `mock-chat-small-v1` — `context_window_tokens: 32000`, `max_output_tokens: **1024**` beside `mock-chat-v1` (`128000` / `4096`) |
| The app's live view | `GET /app-settings/genstudio/chat-models` → both rows with those limits, `freshness: {stale: false, ageMs: 0}` |
| Regenerate a scene prompt with the switched model | job output: `Prompt model: genstudio-chat:mock-chat-small-v1`; `Prompt batching: Batch: 2 scenes per request — the selected output allowance caps this batch at 2 complete instead of the 250-scene default (**1,024 output tokens** × 0.75 ÷ …)`; `Visual pack output budget: **1,024 tokens**` |
| Provider evidence | `mock-chat-001` with **`model_id: mock-chat-small-v1`**, state `succeeded`; job `done`; "Verified 1/1 visual prompt(s) on disk by stable scene ID" |

The batch cap and the pack budget are derived from the *selected* model's published `max_output_tokens` and
moved from 4,096 to 1,024 the moment the selection changed — read from the catalogue in that run, not
carried over from the previous model. The prompt that the regenerated answer wrote back is on disk, so the
episode is complete again.

## Malformed, partial and provider-failure outcomes — refused loudly (ACCEPT-01 requirement, partially met)
The first driver attempts produced four real refusals, all recorded in job history. They are evidence
that §8 (verified completion) holds on the language path rather than a defect list:

| Provider output fed to the app | App's response |
|---|---|
| outline as a bare JSON **array** (`[{n,title,…}]`) | `GenStudio returned JSON, but this workflow requires one JSON object.` — job `error` |
| **invalid JSON** (prose where an outline was required) | `GenStudio returned invalid JSON. The result was rejected locally.` — job `error` |
| expansion requested before approval | `Outline is not approved yet. Review and approve the outline before expanding chapters…` — job `error`, nothing written |
| expansion returning only part of the requested batch | `Narrative batch did not pass its one-repair completion check; missing 2.` — job `error` after one self-healing repair pass |

The partial-expansion case is the important one: a partial batch did **not** mark the step complete, and
the retry path is named in the message ("Resume expansion to repair it"). The passing run then wrote all
three chapters, so valid partial work was preserved and completed rather than restarted from zero.

## Observed behaviour worth recording (not a defect)
`POST /pipeline/preflight` on this **fresh** project refuses **every** step with
`No active preset for <step>. Open the <step> page, apply a preset, then retry.` (plus
`missing_voice` for audio and `missing_prerequisite` for steps whose predecessors have not run).
This is deliberate: the Pipeline will not invent a model or a voice. The consequence for acceptance is
that the remaining legs run either through each page's own routes (as leg 1 did) or after seeding one
preset per step via `PUT /projects/:slug/settings/config`. The preset key map is
`PRESET_KEYS` in `electron/server/routes/pipeline.ts`.

## Remaining legs (resume here)
1. **external acceptance still unproven by construction:** real provider output, real speech timing, real
   upload, signed/notarized distribution (`X-07`, `RELEASE-01`).

## Honest limits so far
- Every provider response in this packet is synthetic; nothing here proves a real provider's output.
- Every image and the final videos are the fixture's own bytes: a 1-pixel PNG and a silent WAV, so the
  rendered video is 2.3 s of a single still. Nothing here proves a real provider's media.

**Evidence, on disk (all read back, not assumed):** thumbnails 68 B each (5 per episode), scene image
68 B, final video 10,591 B / 2.333 s / h264 1920×1080 + aac per episode.
- The mock charges 0 credits for chat and serves silence for speech; token-cost accounting and real
  speech timing are therefore not exercised. Durations recorded here (0.1 s chapters, 2.3 s merge) are
  fixture facts, not performance claims.
- Timing numbers are not recorded as performance claims.
- The app was stopped between driver runs only when noted; the installed 1.4.217 app on this Mac was
  never touched by this packet.

## Resume recipe
```
# 1. Nuxt dev + the app on the disposable Library
(cd frontend && npx nuxt dev --port 3000 &)
env STORY_STUDIO_DATA_DIR=/tmp/ssk-accept-data npx electron . \
    --user-data-dir=/tmp/ssk-accept-data --remote-debugging-port=9334 &   # note: unset ELECTRON_RUN_AS_NODE
# 2. Seed once (project + two episodes) — see the table above
node /tmp/accept-seed.mjs
# 3. One long-lived gateway for the whole walkthrough
npx tsx scripts/developer/serve-mock-genstudio.ts --port 8799 &
# 4. Drive a leg (ACCEPT_MOCK_URL attaches instead of starting a private mock)
ACCEPT_MOCK_URL=http://127.0.0.1:8799 \
ACCEPT_SLUG=accept-01-walkthrough-v2-2026-09-22 \
  npx tsx scripts/developer/accept-01-driver.ts --leg script   # …or audio / subtitles
```
`ACCEPT_APP_URL`, `ACCEPT_LIBRARY`, `ACCEPT_SLUG`, `ACCEPT_EPISODES` and `ACCEPT_CHAT_MODEL` override the
defaults. The driver never writes to the Library directly — every artifact it reports was written by the
app.
