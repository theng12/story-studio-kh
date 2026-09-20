# Defect audit — 2026-09-19

Nine read-only audits covering every surface: 53 route files, 180 services, 27
generators, 105 lib modules, 47 pages, 62 composables, 121 components,
`job-queue.ts`, the YouTube publishing stack, content packs, and the Electron
main/preload boundary. Every finding below was traced to code by the auditor and
re-verified by me before anything was changed.

**Method note worth keeping.** One auditor's server started as a throwaway
in-process Express app to prove how Express 5 decodes `%2F` and `%2e%2e` into
`req.params`, because several findings depend on it. That is the right standard:
none of this was inferred from reading alone, and several audit claims turned
out to be FALSE when checked (see the end of this file).

---

## Fixed and gate-verified

Each of these has a commit and was validated by a full backend gate
(475/475 files, 5373 tests, 0 fail) and, where frontend, the frontend lane
(198/198 files, 1830 tests, 0 fail).

### Data destruction — a single request could have deleted the owner's Library

| Fixed | What was reachable |
|---|---|
| `services/character-library.ts` `libraryDir` validates the id | `DELETE /api/character-library/..` → `fs.rm(<Library root>, {recursive:true})` — every project, 107 GB. `validateId()` existed 11 lines above and `createLibraryCharacter` called it; delete did not. |
| `services/character-manager.ts` `characterDir` validates | `DELETE /api/projects/<slug>/characters/..%2F..` → every project |
| `services/niche-loader.ts` `nicheFilePath` validates | `DELETE /api/niches/..%2F<project>%2Fconfig` → arbitrary `*.json` unlink. The loader's regex ran only on the miss branch. |
| `services/topic-pack-loader.ts` `topicPackFilePath` validates | same, for topic packs |
| `routes/projects.ts` `DELETE /formats/custom/:id` validates | `..%2F..%2Ftmp%2Fvictim` → arbitrary `*.json` unlink. The sibling POST validated the identical id. |
| `services/music-pool.ts` `removeTrack` requires a basename | `DELETE .../music-pool/tracks/..%2F..%2FDocuments%2Fsong.mp3` |
| `services/idea-manager.ts` `deleteEpisodeFolder` requires an exactly-anchored code | `DELETE /episodes/Season%20001` recursively deleted the whole season. `episodeNumber` was NOT usable: it is an unanchored `EP(\d+)`, so `"EP0001 - A Real Episode"` passed it and matched a real folder. |
| `routes/audio.ts` `audio-ingest` validates the chapter slug | `{"slug":"../../../../tmp/pwn"}` wrote a file outside the project |
| `routes/scripts.ts` escapes the code before building a deletion regex | `episodeId = ".*"` matched other episodes' chapters, then `fs.rm`'d them |
| `routes/character-library.ts` reference-image requires a basename | `updateLibraryCharacter` merges `references` verbatim, so the allow-list itself could carry `../../../../etc/hosts` |
| `routes/library.ts` refuses an absurdly broad archive root | `{"source_root":"/"}` walked and hashed the whole disk |

### Path containment — the root cause, fixed once

`services/utils.ts` `resolveEpisodePaths` substituted `{code}` and `{title}` RAW
into the folder template. Both arrive from HTTP and `path.join` normalises `..`
away, so a title of `../../../../tmp/pwn` resolved outside the Library — and
several callers then write, rename or **recursively remove** there. It now
refuses a separator and asserts the result is inside the episodes root.

The same hole one level down: `subfolder_names` is persisted by
`PUT /settings/subfolder-config`, which only required the value to *contain*
`{code}`. A value of `../../../../tmp/escape/{code}` escaped from **inside** the
episode folder. Every resolved subfolder is now contained too.

### Code execution

`routes/system.ts` `reveal-folder` used `shell.openPath`, which **launches** the
target with its default handler — `.app`, `.command`, `.inetloc` was native code
execution from a route whose button says "Reveal in Finder". Now
`showItemInFolder`, which reveals and executes nothing.

### Reporting / behaviour

- `routes/pipeline.ts:2169` — a per-step `break` where every sibling is
  `continue` silently dropped the rest of a repair run's selected steps while
  still answering 201.
- `frontend/pages/projects/[slug]/jobs.vue` — `overflow: hidden` on `.job-card`
  clipped the "More actions" `<details>` it contained, so Cancel / Stop local /
  Pause submissions / Clear history **could not be clicked**.
- `frontend/pages/projects/[slug]/video-assembly.vue` — the picker dialogs used
  `modal-overlay` / `modal-content` and the page defined neither;
  `.modal-content` has **no rule anywhere in the app**, so "+ Add Overlay" and
  "Pick media" never opened a dialog.
- `frontend/pages/projects/[slug]/video-assembly.vue` — the render-blocker
  sentence printed `[object Object]` (arrays interpolated as counts).
- `frontend/assets/css/main.css` — `.btn-ghost` existed only inside
  `ConfirmDialog`'s scoped block, so 52 files / 113 buttons rendered with no
  border and no hover.
- `frontend/pages/projects/[slug]/pipeline.vue` — `forceRerun` was never reset,
  so one forced run left every later batch (including another channel) charging
  for a full regeneration.
- `frontend/pages/projects/[slug]/subtitles.vue` — deleting one SRT adopted the
  narrower DELETE response, wiping the quality/garbled markers from every
  remaining file until a reload.

Tests: `electron/server/__tests__/path-traversal-containment.test.ts` (15) plus
updates to `character-library-route-registration.test.ts`. Every traversal test
asserts a **sentinel file outside the target directory still exists** — a
rejection assertion passes even when the rejection happens after the `fs.rm`.

---

## OPEN — critical

**Arbitrary file read via `?path=`.** `services/path-resolver.ts:68` returns a
non-`${VAR}` path unchanged, and the only gate is the file extension:
`routes/video.ts:467` (preview-audio), `:531` (preview-media), `:579`
(preview-image), `routes/audio-merge.ts:110`. `GET
/api/projects/<slug>/video-editor/preview-media?path=/Users/<any>/private.mp4`
streams any file with a matching extension. The in-code comment ("this backend
binds localhost, so the risk surface is the UI itself") is false in server mode,
which binds `0.0.0.0`.

**BLOCKED ON THE OWNER.** Containing it requires choosing the allowed roots, and
that changes what can be previewed. Options: (a) Library + project tree +
configured media root; (b) an opaque token for paths the app itself issued;
(c) leave it.

**`routes/vision.ts:104`** — `source_path` from the body is `fs.readFile`'d,
copied into the project and **uploaded to GenStudio**. Any local image can be
read and exfiltrated. Same decision class as `?path=`.

---

## OPEN — high

- **`routes/health.ts:110`** — `GET /api/models` returns `200 []` when no API key
  is configured, so every LLM picker renders "no models" instead of "add a key".
  Sibling routes correctly 400. (The only bare-200-empty-body found.)
- **`services/soft-delete.ts:157,164`** — `tallyDirSize` swallows every error and
  returns 0, so the declared `-1` "unknown" sentinel is unreachable and an
  unreadable hidden project reports **0 B**.
- **`lib/folder-resolver.ts:132`** — `findEpisodeDir` matches a bare
  `startsWith(code)` with no separator, and `routes/video.ts:344` passes no
  title hint. With per-project `episode_digits`, `'EP10 - Other'.startsWith('EP1')`
  is true, so the Video Editor can be handed another episode's
  `audio_chapters.json`. Four copies of this matcher exist: `asset-status.ts:366`
  and `:383`, `folder-resolver.ts:132`, `manifest-audit.ts:127`,
  `audio-merge.ts:119` (the loosest — it does not even strip the `✅ ` prefix).
- **`lib/broll-indexer.ts:74`** — `parseFloat(stream.duration || fmt.duration || '0')`:
  ffprobe's `'N/A'` is truthy, so a good `format.duration` is never consulted and
  the clip becomes duration 0, then is silently dropped as "too short" by
  `broll-selector.ts:124` — with a warning blaming the preset or an empty pool.
- **`generators/episode.ts:1521`** — `outline_only` audits against
  `params.totalChapters` while `buildOutline` keeps the extra chapters the
  v1.4.36 owner ruling embraces, so an over-delivering outline is marked
  `invalid: ['extra outline chapters']`, the paid work is binned, and
  `MANUAL_ONLY` Retry replays the same cached failure forever.
- **`generators/scene-plan.ts:871-1016` + `routes/pipeline.ts:1183`** — a
  Pipeline `scene_plan_run` carries no `stage`, so `stage` defaults to
  `'timeline'`, which rebuilds every scene with `visual_prompt: ''` and
  **whole-file replaces** `scene_plan.json` — discarding every approved,
  already-paid prompt and re-requesting all of them. Reachable exactly when the
  plan is *partially* done.
- **`generators/metadata.ts:595` vs `lib/upload-metadata.ts:115`** — a second
  metadata run writes `_Metadata_v2.json` and the board audits v2, but the
  Upload Center reads the fixed v1 path, so the upload publishes the old
  title/description/tags.
- **`generators/broll-assemble.ts:409`** — the assembler has no completion audit
  and encodes with `-shortest`, so a coverage-short selection produces a video
  that cuts off mid-sentence while the board shows the final-video cell green.
- **`services/scene-timeline-integrity.ts:148`** — called without
  `max_cue_gap_sec` it returns before the sha256 / cue-count check, so a
  truncated `_stitched.srt` beside an intact `.json` gates paid scene generation
  and Pipeline skips Subtitles as done.
- **`services/audio-workflow-readiness.ts:50`** — any audio file with size > 0 is
  "merged audio ready", unblocking paid transcription on a superseded take.
- **`services/subtitle-completion.ts:295`** — a single whole-track SRT with
  size > 0 returns `complete: true` with `completed_sections: expected`,
  fabricating full coverage without parsing one cue. Same shape at
  `episode-recovery.ts:150` (one cue certifies the episode) and
  `generators/subtitles.ts:294` (staleness never checked, and Retry returns the
  skip path so it cannot repair the stitch failure its own error named).
- **`services/manifest-audit.ts:362`** — per-stage errors are swallowed into
  `notStarted(...)` = `{expected: 0, missing: []}`, so "could not measure" reads
  as "nothing expected" and the banner says assets are intact.
- **`generators/video.ts:5061` + `broll-assemble.ts:246`** — requested
  word-mode/animated captions silently degrade to coarse static anchors and
  `declareJobDegraded` is never called, so `result.degraded` is empty.
- **`generators/audio.ts:756` + `:1267`** — an existing non-empty mp3 is skipped
  with no comparison to the current script, and the audit is filename-presence +
  size, so editing a chapter and re-running ships the old narration while the
  manifest records the new script's hash.
- **`services/job-completion.ts` on the ordinary success path** — the queue's
  completion check is a **self-declaration**: `assertJobDidNotDeclareIncomplete`
  returns immediately unless the executor itself set `result.complete === false`.
  Every guarantee therefore depends on each generator choosing to prove.
  `generateAudioMerge`, `generateVideoAssembly`, `generateSubtitlesTranscribe`,
  `generateYoutubeUpload`, `generateYoutubePlaylistUpdate`,
  `generateThumbnailRefresh` and `broll_assemble` contain no
  `requireJobCompletion` at all. The infrastructure for a real fix exists and is
  wired only on the provider-settlement path: `registerJobCancellationAuditor`
  (`boot/executors.ts:129-198`) computes `complete | repair-required` from disk
  for 10 job types. Running it on the ordinary success path closes the whole
  class rather than ~20 instances.
- **`services/job-queue.ts:684`** — when the GenStudio key is unavailable,
  `reconcileCancellationJob` returns early, the `finally` re-arms a 5-second
  timer, and `requiresCancellationReconciliation` is true for ANY job holding
  `remote_cancellations` + a recorded provider task — so the job stays `running`
  and the timer fires every 5s for the life of the process with no backoff,
  attempt cap or terminal escape.
- **`services/job-queue.ts:2911`** — a crash-interrupted `scene_plan_run` /
  `metadata` / `image_prompts` / `research_run` becomes
  `error: 'Interrupted by app restart'`; only `audio` / `subtitles_transcribe`
  (needing a `story-*` asset key), `continuity_render` / `image_pool_generate`
  and video assembly are re-dispatched. The message conceals that paid provider
  work may already exist, and Retry is refused until an opportunistic re-check
  settles it.

---

## OPEN — medium and low

**Queue / pipeline**
- `job-queue.ts:441` — the `cancelled` Set is never pruned (`removeTerminalJob`
  and `clearFinished` delete from `jobs` only). Ids are 8-char UUID slices, so a
  collision would terminalise a brand-new job as cancelled before its first
  provider call.
- `routes/pipeline.ts:2202` — a per-step skip `continue`s out after the
  inline character-sheet write has already happened, and the skip reason never
  mentions it.
- `job-queue.ts:1659` — `safeJob()` (every persist) and `serializeJob()` (every
  SSE frame) each `structuredClone` the job, and `output_lines` is unbounded.
- `frontend/composables/useJobs.ts` — once fallen back to polling, nothing ever
  retries SSE; one burst of 3 errors leaves the page on 10s polling for the
  session. `routes/jobs.ts:556` also never emits the `snapshot-error` event its
  siblings emit.
- `frontend/pages/projects/[slug]/jobs.vue:1956` — a `paused`
  `dispatch_status` is reported as "needs attention".
- `jobs.vue:2675` — Retry is offered on legacy rows the backend always 409s
  (`image_prompts` / `images` with a non-thumbnails `mode`), and the bulk retry
  applies no admission filter at all.
- `jobs.vue:2205` — two permanently-empty filter tabs (`scene_images`,
  `scene_images_batch`); neither type exists any more.
- `jobs.vue:2240` — the empty state says "No jobs yet" when a status or batch
  filter emptied the list.
- `jobs.vue:2844` — `jobQueuePath()` can build an `_app_` URL the backend does
  not serve (`finish-missing-images`). Latent.
- `jobs.vue:3203` — the Retry tooltip for subtitles points at a Repair button
  the page never renders.

**Frontend — misleading empty and error states**

In every case a failed read is rendered as a confident, specific, wrong answer:
- `scene-review.vue:1214` → "No scene plan yet" (on a 500, the whole control
  deck and grid vanish and the user is told to redo work that exists).
- `research.vue:650` → "GenStudio API not configured" (sends the user to
  re-enter a valid key; only a reload recovers).
- `pipeline.vue:1250` **and** `audio.vue:1665` → "this channel has no
  Introduction", which **suppresses the pre-spend warning** ("Four episodes were
  voiced with no opening", per that code's own comment).
- `subtitles.vue:56` → "No chapter audio found", Transcribe disabled.
- `AudioChapterSelector.vue:732` → "No sections found. Generate the script
  first."
- `pipeline.vue:431` → "No accepted ideas yet."
- `video-assembly.vue:3285` / `:3337` → permanent "Loading transitions…" and the
  picker never mounts.
- `video-assembly.vue:201` → a failed asset scan blanks Step 1 entirely.
- `video-assembly.vue:2034` → "No subtitle file for this episode yet" renders
  from the initial `null`, so it flashes on every load.
- `scene-plan.vue:583` → deleting the plan leaves a heading-only card.
- `jobs.vue:1667` → `queuePaused` is a two-valued ref fed by a `catch` that
  keeps the last value, so "unknown" reads as "running".

**Frontend — episode state surviving a change (AGENTS.md §4)**

All twelve traced by the auditor, and the two worst are fields that were never
*classified* as episode-specific:
- `scene-plan.vue:1690` — "Custom instructions" (labelled per-episode) is never
  reset, is persisted under a project-only key and is snapshotted into presets.
- `scripts.vue:870` — `manual_guidance` and `character_ids` survive and ride in
  the script preset, plus the per-run `force` flag.
- `metadata.vue:1029` — `if (v.title_options.length) … }` with **no else**;
  EP0001's title variants are saved as EP0002's.
- `services/audio-reconciler.ts:157` — `|| audioJobs[0]` takes **another
  episode's** TTS model to predict this episode's chunk split.
- `image-prompts.vue:1398` — episode-scoped cast ids persist in a project-only
  blob and are sent for the new episode.
- `broll.vue:922`, `scene-review.vue:1035`, `images.vue:1411`,
  `research.vue:1207`, `character-sheet.vue:534`, `motion-review.vue:886`,
  `metadata.vue:279` — replaced only on a *successful* load, never blanked.

**Frontend — other confirmed**
- `scene-plan.vue:1151` — the Style Bible is `.slice(0, 2000)` with a "Saved"
  toast and no counter. §1: a limit that is enforced must be shown.
- `scene-plan.vue:39` — `:loading-label` is bound to a prop that does not exist
  (`TopActionBar` expects `generateLoadingLabel`), so the busy affordance never
  appears.
- `video-assembly.vue:2929` — `needsChoice` from the output-option picker is not
  enforced, and an informational notice is routed to `showError`.
- `settings.vue:2204` — FFmpeg status is never fetched when the tab is opened
  from the nav, so a bundled install is offered "Install recovery copy", which
  really downloads.
- `settings.vue:4676` vs `:4766` — two `immediate` watchers write
  `category_id`; the second blanks what the first hydrated.
- `utils/projectSettingsSave.ts:23` — "Use app default" sends `undefined`, which
  `JSON.stringify` drops, so the key is never cleared and the app still says
  "saved". This is an **AI-disclosure compliance** field.
- `scripts.vue:216` — `v-if="false && formatContext"` makes the format-envelope
  and out-of-range warnings permanently unreachable, with ~200 lines of dead CSS.
- `settings.vue:724` — the page says to press "Sync Folders"; no such control
  exists and `POST /projects/:slug/sync-folders` is unreachable from the UI.
- `scene-review.vue:418` — the 🎬 badge's tooltip promises a preview; the handler
  writes a ref nothing reads.
- `research.vue:36` — `result?.claims.length` is unguarded; a `research.json`
  without `claims` blanks the page.
- `composables/useJobs.ts:34`, `components/EpisodeSelector.vue:473`,
  `jobs.vue:2028` — four hand-maintained job-type label maps have drifted;
  `useJobs.ts` is missing 6 live types, `EpisodeSelector.vue` 20 of 30, so toasts
  and the episode dropdown render raw slugs.
- `ContentPurchaseDialog.vue:262` — `overflow: hidden` with no inner scroller
  clips the Cancel / "Confirm up to N credits" footer.
- `.input-sm`, `.btn-icon`, `.link-btn`, `.checkbox-label`, `.section-kicker`,
  `.card-actions` — same shape as `.btn-ghost`: defined only inside one
  component's scoped block.
- `settings.vue:5310` — a `position: sticky` save bar inside `overflow: hidden`
  can never stick.
- Geometry, all clip with no scrollbar because `layouts/dashboard.vue:540` sets
  `overflow-x: hidden`: `subtitles.vue:1121` (long SRT filename pushes the view
  and delete buttons out), `SubtitleCuePreview.vue:75` (pushes the close button
  out), `settings.vue:5759` (folder-template grid), `scene-plan.vue:3423`,
  `video-assembly.vue:6449`, `audio.vue:2212`, `scene-review.vue:2011`,
  `research.vue:1881`, `pipeline.vue:1972`.

**Zero-means-two-things (§6)**
- `lib/opening-duration.ts:104` — `return clip.fallback_sec || 0` makes 0 mean
  both "nothing precedes the scenes" and "the probe returned nothing". The plan's
  intro bucket has no fallback while the renderer's has `fallback_sec: 5`, so the
  two disagree by construction for one input; `scene-plan.ts:994` writes
  `opening_source: 'measured'` unconditionally and `video.ts:2030` then sets
  `hide_during_intro = false`. `__tests__/opening-duration.test.ts:61-69` pins the
  divergence. **Editorial — the fix shifts timelines.**
- `services/storage-audit.ts:105` + `episode-media-cleanup.ts:307` +
  `asset-status.ts:1019` — `startsWith(\`${code}_final_video.\`)` rejects
  `_final_video_v2.mp4`, which the app itself writes (`upload-queue.ts:305`). The
  same file IS recognised at `storage-audit.ts:792`, a half-applied fix. Result:
  Settings shows "Final videos: 0 B" and the space cannot be reclaimed. The
  correct matcher already exists in this repo: `MERGED_AUDIO_FILENAME`
  (`lib/intro-lead-in.ts:161`).
- `services/music-library.ts:132` — `available_seconds` sums `duration_sec || 0`,
  so unmeasured tracks silently understate "X min usable" at the point the user
  decides whether to buy more music.
- `services/subtitle-completion.ts:189` — a failed `stat` becomes `mtimeMs = 0`,
  i.e. the oldest value, so "could not check" resolves to "not stale".
- `services/sound-design.ts:70` — `Math.max(0, ...[])` manufactures a 0-length
  timeline on an empty plan, and every cue is then rejected as "outside the
  episode timeline".
- `lib/thumbnail-prepare.ts:38` — `meta.width || 0` means an unmeasurable width
  passes the "too wide" check.

**Model dynamism (§1/§2)**
- `motion-review.vue:743` + `:384` — the only two statements of aspect ratio are
  the literal `'16:9'`; the selected video model's published `aspect_ratios` is
  parsed and discarded, and `scene-clip.ts:362` reduces whatever arrives to a
  landscape/portrait binary. Every i2v clip is landscape on every model.
- `lib/genstudio-client.ts:7315` — the image parser substitutes
  `default_aspect_ratio: '16:9'` when none is published, and
  `scene-review.vue:839` then clamps onto a frame the model never named.
- `images.vue:1124` — a six-entry hardcoded ratio list is offered when a model
  publishes none, and the clamp is skipped in exactly that case.
- `images.vue:728` — the per-row character badge reads
  `config.image_models[].prompt_char_cap`, a retired map, instead of the live
  `max_prompt_characters` already on the page — so a cap enforced at
  `routes/image-preview.ts:172` is never shown.
- `images.vue:90` — the "View all caps" modal prints persisted caps **and
  prices** from project config under copy implying they are current.
- `lib/genstudio-client.ts:144` — a 100 MiB transcription ceiling is enforced and
  never shown.
- `lib/chunked-narration.ts:184` — `SINGLE_CHAPTER_REPAIR_OUTPUT_TOKENS = 8_192`
  clamps down to the published ceiling but can never rise with it.
- The model-drift guard could not see the last two: its rules need a
  `PUBLISHED_LIMIT_FIELDS` name plus a numeric literal, a `?? number` default, or
  a `Number.isInteger(...) ? published : CONSTANT` ternary. A literal inside a
  `typeof … === 'string' ? trimmed : '16:9'` ternary and a bare `const X = 8_192`
  match none of those.

**YouTube**
- Cross-project duplicate upload: `video-claims.json` has exactly one reader and
  one writer, both inside `acceptYouTubeOperation` — i.e. only AFTER YouTube has
  accepted the bytes — while upload admission
  (`routes/youtube-upload-center.ts:2218`) asks only `remoteVideoFor`, which is
  project-scoped. Two projects sharing an episode code (`EP0001`–`EP0006` exist
  in seven channels) on the same channel can both upload, and project B's
  conflict is then downgraded to a job warning at
  `generators/youtube-upload.ts:511`. Unrecoverable: a second public video.
- A sidecar tombstoned `manual` on a channel the project has since left is a
  permanent refusal — `youtube-remote-video.ts:395` requires
  `sidecar.channel_id === channelId`, and the new "Forget upload" route
  (`:2085`) requires the same channel, so the only escape is a legacy route with
  no frontend caller. The episode can never be published again.
- `youtubeArchiveProofForFile` (a MOVE) accepts a reconcile link or legacy
  sidecar on an mtime test alone, with no content hash, where the deletion path
  correctly demands a `sha256:` `ready_operation`
  (`youtube-remote-video.ts:253` vs `:219`).
- The same helper returns `ready_operations[0].video_id` ignoring channel, so
  the archive breadcrumb can misattribute a video.
- `routes/youtube-upload-center.ts:2916` — `/episodes/:code/schedule` PATCHes
  YouTube first and writes the local receipt after, across four non-transactional
  writes with an `expected_revision` read earlier in the request.
- `services/upload-plans.ts:533` — `addDays` adds a fixed 24h, which stalls on
  sub-hour DST zones (reproduced on Australia/Lord_Howe). The failure is safe —
  it refuses rather than publishing at a wrong time.
- `routes/upload.ts:1594` — the legacy plan-apply PATCHes without
  `requirePrivacyStatus` and can set a live public video back to private. Its
  preview/apply routes have no frontend caller.
- `services/storage-audit.ts:821` — a same-size destination file is taken as a
  completed copy for non-final media, then the source is deleted.

**Content packs**
- `content-packs/state.ts:99` — one malformed record quarantines and rewrites
  `state.json` as empty with **no log and no reconciliation against `installed/`**,
  so every pack silently disappears from every catalogue and the Store.
- `content-packs/installer.ts:617` vs `state.ts:155` — a crash between the
  version-directory rename and the state checkpoint leaves an orphan no pass ever
  reconciles, permanently blocking re-install of that version.
- `services/content-store-delivery.ts:527` — `alreadyInstalled` calls the throwing
  closure verifier with no try/catch, so a damaged local copy can never be
  repaired by installing again.
- `content-store-delivery.ts:640` vs `recovery.ts:202` — boot adoption silently
  activates every retained-but-inactive pack, so a half-delivered bundle goes
  partially live after a restart.
- `content-packs/lifecycle.ts:308` — `pruneUnpinnedContentPackVersions` deletes
  the version rolled back FROM, and deletes **every** version when no active
  version exists. No production caller today.
- `content-store-install-state.ts:121` — reports `pack.active_version` for an
  exact-hash match that is a different version.

**Electron / settings / IPC — verified CLEAN**
No `ipcMain`/`ipcRenderer` handler exists anywhere; `preload.cjs` exposes only
`{ isElectron: true }`; `webPreferences` is fully hardened
(`contextIsolation`, `sandbox`, `nodeIntegration: false`, no `webSecurity: false`)
with working navigation guards. Pack asset paths cannot escape the pack
directory. Failed pack installs cannot commit half-state. `writeJsonAtomic` is
correct. App-settings writes are all atomic. No credential reaches any response
body, log line or error message.

**Not defects, but worth knowing**
- `electron/migrations.json` is entirely dead — no reader or writer.
- `lib/ttl-cache.ts` (108 lines) is imported only by its own test; the
  `/voicestudio/models` and `/macos/voices` probes it served no longer exist.
- `app-settings.json`'s `endpoint_labels` and `hub_url` have no readers.
- `routes/debug.ts` `/api/debug/info` has no frontend caller and returns absolute
  paths.
- `app.ts:73` `isDev` is effectively always true, so the packaged app gets the
  dev CORS allowlist (the safe branch — no exposure).
- `GET /api/health` and `/api/server-info` hardcode `version: '0.1.0'` while
  package.json is 1.4.x.
- `EpisodeStatus.video` / `.images` are never derived; the `pipeline.ts:761`
  comment claiming `video` means "every clip present" is stale documentation.

---

## Audit claims I verified as FALSE

Recorded so nobody fixes them twice. This matters as much as the true findings —
a plausible claim that is wrong costs a real fix's worth of time.

1. **"`humanize-backend-error` logs `raw`/`stack` unredacted, the only place in
   the error path that skips `redactSecrets`."** False. `logLine` passes its
   whole meta object through `redactSensitiveValue`, which recurses into objects,
   arrays and strings and calls `redactSecrets` on each string.
2. **"`startFallbackPolling` bumps `transportEpoch` before `refreshFull`, so the
   fallback's own first GET is discarded."** False, and the auditor retracted it
   himself: `refreshFull` captures the epoch at its own entry, after
   `stopTransport()` has already incremented it. The independent half — that SSE
   is never retried after a fallback — stands.
3. **"An archive `source_root` outside the Library should be refused."** My own
   inference, disproved by the gate: the feature exists to sweep a folder the
   owner chose, which may be an external drive.
4. **"`preflightSummary` is stale state that `closeConfirm` should clear."** My
   own inference, disproved by five tests: it is the submission receipt.

## The three mistakes I made while fixing

Kept because the pattern is the useful part.

1. I reused the loader's own id regex for validation, on the reasoning that it
   was the repo's rule. It had only ever run on the loader's **miss** branch, so
   it had never been applied to every real id — and it rejected `user:<uuid>`,
   the shape legacy Content Pack forks actually use. The full gate caught it.
2. I "reverted" a change with `git checkout HEAD -- <file>` when HEAD *was* the
   commit containing it. The revert was a silent no-op and the next gate tested
   the same bad code. Checking the file's content, not the checkout's exit code,
   caught it.
3. I cleared a field as stale state without checking what else depended on it;
   five tests failed.

**The rule that would have prevented all three:** a validator, a revert, and a
"dead" state field are each claims about the whole system, and each is cheap to
check and expensive to assume.
