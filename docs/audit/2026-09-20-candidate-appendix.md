# Mechanically extracted audit candidates

Source: docs/audit/2026-09-19-defect-audit.md. Each candidate is [REPORTED] historical audit text; disposition is intentionally omitted. [The JSON source slices](../handoffs/evidence/2026-09-20/audit-candidates.json) preserve the original line endings. Read [current dispositions and proposed repairs](2026-09-20-bug-backlog.md) first: these 89 historical candidates include completed and retracted findings, not 89 confirmed open bugs.

Candidate count: **89**.

| ID | Heading | Source lines | Exact source text |
|---|---|---:|---|
| C-01 | OPEN — critical | 92-104 | [REPORTED] **Arbitrary file read via `?path=`.** `services/path-resolver.ts:68` returns a<br>non-`${VAR}` path unchanged, and the only gate is the file extension:<br>`routes/video.ts:467` (preview-audio), `:531` (preview-media), `:579`<br>(preview-image), `routes/audio-merge.ts:110`. `GET<br>/api/projects/<slug>/video-editor/preview-media?path=/Users/<any>/private.mp4`<br>streams any file with a matching extension. The in-code comment ("this backend<br>binds localhost, so the risk surface is the UI itself") is false in server mode,<br>which binds `0.0.0.0`.<br><br>**BLOCKED ON THE OWNER.** Containing it requires choosing the allowed roots, and<br>that changes what can be previewed. Options: (a) Library + project tree +<br>configured media root; (b) an opaque token for paths the app itself issued;<br>(c) leave it. |
| C-02 | OPEN — critical | 106-108 | [REPORTED] **`routes/vision.ts:104`** — `source_path` from the body is `fs.readFile`'d,<br>copied into the project and **uploaded to GenStudio**. Any local image can be<br>read and exfiltrated. Same decision class as `?path=`. |
| H-01 | OPEN — high | 114-116 | [REPORTED] - **`routes/health.ts:110`** — `GET /api/models` returns `200 []` when no API key<br>  is configured, so every LLM picker renders "no models" instead of "add a key".<br>  Sibling routes correctly 400. (The only bare-200-empty-body found.) |
| H-02 | OPEN — high | 117-119 | [REPORTED] - **`services/soft-delete.ts:157,164`** — `tallyDirSize` swallows every error and<br>  returns 0, so the declared `-1` "unknown" sentinel is unreachable and an<br>  unreadable hidden project reports **0 B**. |
| H-03 | OPEN — high | 120-126 | [REPORTED] - **`lib/folder-resolver.ts:132`** — `findEpisodeDir` matches a bare<br>  `startsWith(code)` with no separator, and `routes/video.ts:344` passes no<br>  title hint. With per-project `episode_digits`, `'EP10 - Other'.startsWith('EP1')`<br>  is true, so the Video Editor can be handed another episode's<br>  `audio_chapters.json`. Four copies of this matcher exist: `asset-status.ts:366`<br>  and `:383`, `folder-resolver.ts:132`, `manifest-audit.ts:127`,<br>  `audio-merge.ts:119` (the loosest — it does not even strip the `✅ ` prefix). |
| H-04 | OPEN — high | 127-130 | [REPORTED] - **`lib/broll-indexer.ts:74`** — `parseFloat(stream.duration \|\| fmt.duration \|\| '0')`:<br>  ffprobe's `'N/A'` is truthy, so a good `format.duration` is never consulted and<br>  the clip becomes duration 0, then is silently dropped as "too short" by<br>  `broll-selector.ts:124` — with a warning blaming the preset or an empty pool. |
| H-05 | OPEN — high | 131-135 | [REPORTED] - **`generators/episode.ts:1521`** — `outline_only` audits against<br>  `params.totalChapters` while `buildOutline` keeps the extra chapters the<br>  v1.4.36 owner ruling embraces, so an over-delivering outline is marked<br>  `invalid: ['extra outline chapters']`, the paid work is binned, and<br>  `MANUAL_ONLY` Retry replays the same cached failure forever. |
| H-06 | OPEN — high | 136-141 | [REPORTED] - **`generators/scene-plan.ts:871-1016` + `routes/pipeline.ts:1183`** — a<br>  Pipeline `scene_plan_run` carries no `stage`, so `stage` defaults to<br>  `'timeline'`, which rebuilds every scene with `visual_prompt: ''` and<br>  **whole-file replaces** `scene_plan.json` — discarding every approved,<br>  already-paid prompt and re-requesting all of them. Reachable exactly when the<br>  plan is *partially* done. |
| H-07 | OPEN — high | 142-145 | [REPORTED] - **`generators/metadata.ts:595` vs `lib/upload-metadata.ts:115`** — a second<br>  metadata run writes `_Metadata_v2.json` and the board audits v2, but the<br>  Upload Center reads the fixed v1 path, so the upload publishes the old<br>  title/description/tags. |
| H-08 | OPEN — high | 146-148 | [REPORTED] - **`generators/broll-assemble.ts:409`** — the assembler has no completion audit<br>  and encodes with `-shortest`, so a coverage-short selection produces a video<br>  that cuts off mid-sentence while the board shows the final-video cell green. |
| H-09 | OPEN — high | 149-152 | [REPORTED] - **`services/scene-timeline-integrity.ts:148`** — called without<br>  `max_cue_gap_sec` it returns before the sha256 / cue-count check, so a<br>  truncated `_stitched.srt` beside an intact `.json` gates paid scene generation<br>  and Pipeline skips Subtitles as done. |
| H-10 | OPEN — high | 153-154 | [REPORTED] - **`services/audio-workflow-readiness.ts:50`** — any audio file with size > 0 is<br>  "merged audio ready", unblocking paid transcription on a superseded take. |
| H-11 | OPEN — high | 155-160 | [REPORTED] - **`services/subtitle-completion.ts:295`** — a single whole-track SRT with<br>  size > 0 returns `complete: true` with `completed_sections: expected`,<br>  fabricating full coverage without parsing one cue. Same shape at<br>  `episode-recovery.ts:150` (one cue certifies the episode) and<br>  `generators/subtitles.ts:294` (staleness never checked, and Retry returns the<br>  skip path so it cannot repair the stitch failure its own error named). |
| H-12 | OPEN — high | 161-163 | [REPORTED] - **`services/manifest-audit.ts:362`** — per-stage errors are swallowed into<br>  `notStarted(...)` = `{expected: 0, missing: []}`, so "could not measure" reads<br>  as "nothing expected" and the banner says assets are intact. |
| H-13 | OPEN — high | 164-166 | [REPORTED] - **`generators/video.ts:5061` + `broll-assemble.ts:246`** — requested<br>  word-mode/animated captions silently degrade to coarse static anchors and<br>  `declareJobDegraded` is never called, so `result.degraded` is empty. |
| H-14 | OPEN — high | 167-170 | [REPORTED] - **`generators/audio.ts:756` + `:1267`** — an existing non-empty mp3 is skipped<br>  with no comparison to the current script, and the audit is filename-presence +<br>  size, so editing a chapter and re-running ships the old narration while the<br>  manifest records the new script's hash. |
| H-15 | OPEN — high | 171-182 | [REPORTED] - **`services/job-completion.ts` on the ordinary success path** — the queue's<br>  completion check is a **self-declaration**: `assertJobDidNotDeclareIncomplete`<br>  returns immediately unless the executor itself set `result.complete === false`.<br>  Every guarantee therefore depends on each generator choosing to prove.<br>  `generateAudioMerge`, `generateVideoAssembly`, `generateSubtitlesTranscribe`,<br>  `generateYoutubeUpload`, `generateYoutubePlaylistUpdate`,<br>  `generateThumbnailRefresh` and `broll_assemble` contain no<br>  `requireJobCompletion` at all. The infrastructure for a real fix exists and is<br>  wired only on the provider-settlement path: `registerJobCancellationAuditor`<br>  (`boot/executors.ts:129-198`) computes `complete \| repair-required` from disk<br>  for 10 job types. Running it on the ordinary success path closes the whole<br>  class rather than ~20 instances. |
| H-16 | OPEN — high | 183-188 | [REPORTED] - **`services/job-queue.ts:684`** — when the GenStudio key is unavailable,<br>  `reconcileCancellationJob` returns early, the `finally` re-arms a 5-second<br>  timer, and `requiresCancellationReconciliation` is true for ANY job holding<br>  `remote_cancellations` + a recorded provider task — so the job stays `running`<br>  and the timer fires every 5s for the life of the process with no backoff,<br>  attempt cap or terminal escape. |
| H-17 | OPEN — high | 189-195 | [REPORTED] - **`services/job-queue.ts:2911`** — a crash-interrupted `scene_plan_run` /<br>  `metadata` / `image_prompts` / `research_run` becomes<br>  `error: 'Interrupted by app restart'`; only `audio` / `subtitles_transcribe`<br>  (needing a `story-*` asset key), `continuity_render` / `image_pool_generate`<br>  and video assembly are re-dispatched. The message conceals that paid provider<br>  work may already exist, and Retry is refused until an opportunistic re-check<br>  settles it. |
| Q-01 | OPEN — medium and low / Queue / pipeline | 202-205 | [REPORTED] - `job-queue.ts:441` — the `cancelled` Set is never pruned (`removeTerminalJob`<br>  and `clearFinished` delete from `jobs` only). Ids are 8-char UUID slices, so a<br>  collision would terminalise a brand-new job as cancelled before its first<br>  provider call. |
| Q-02 | OPEN — medium and low / Queue / pipeline | 206-208 | [REPORTED] - `routes/pipeline.ts:2202` — a per-step skip `continue`s out after the<br>  inline character-sheet write has already happened, and the skip reason never<br>  mentions it. |
| Q-03 | OPEN — medium and low / Queue / pipeline | 209-210 | [REPORTED] - `job-queue.ts:1659` — `safeJob()` (every persist) and `serializeJob()` (every<br>  SSE frame) each `structuredClone` the job, and `output_lines` is unbounded. |
| Q-04 | OPEN — medium and low / Queue / pipeline | 211-214 | [REPORTED] - `frontend/composables/useJobs.ts` — once fallen back to polling, nothing ever<br>  retries SSE; one burst of 3 errors leaves the page on 10s polling for the<br>  session. `routes/jobs.ts:556` also never emits the `snapshot-error` event its<br>  siblings emit. |
| Q-05 | OPEN — medium and low / Queue / pipeline | 215-216 | [REPORTED] - `frontend/pages/projects/[slug]/jobs.vue:1956` — a `paused`<br>  `dispatch_status` is reported as "needs attention". |
| Q-06 | OPEN — medium and low / Queue / pipeline | 217-219 | [REPORTED] - `jobs.vue:2675` — Retry is offered on legacy rows the backend always 409s<br>  (`image_prompts` / `images` with a non-thumbnails `mode`), and the bulk retry<br>  applies no admission filter at all. |
| Q-07 | OPEN — medium and low / Queue / pipeline | 220-221 | [REPORTED] - `jobs.vue:2205` — two permanently-empty filter tabs (`scene_images`,<br>  `scene_images_batch`); neither type exists any more. |
| Q-08 | OPEN — medium and low / Queue / pipeline | 222-223 | [REPORTED] - `jobs.vue:2240` — the empty state says "No jobs yet" when a status or batch<br>  filter emptied the list. |
| Q-09 | OPEN — medium and low / Queue / pipeline | 224-225 | [REPORTED] - `jobs.vue:2844` — `jobQueuePath()` can build an `_app_` URL the backend does<br>  not serve (`finish-missing-images`). Latent. |
| Q-10 | OPEN — medium and low / Queue / pipeline | 226-227 | [REPORTED] - `jobs.vue:3203` — the Retry tooltip for subtitles points at a Repair button<br>  the page never renders. |
| E-01 | OPEN — medium and low / Frontend — misleading empty and error states | 231-233 | [REPORTED] In every case a failed read is rendered as a confident, specific, wrong answer:<br>- `scene-review.vue:1214` → "No scene plan yet" (on a 500, the whole control<br>  deck and grid vanish and the user is told to redo work that exists). |
| E-02 | OPEN — medium and low / Frontend — misleading empty and error states | 234-235 | [REPORTED] - `research.vue:650` → "GenStudio API not configured" (sends the user to<br>  re-enter a valid key; only a reload recovers). |
| E-03 | OPEN — medium and low / Frontend — misleading empty and error states | 236-238 | [REPORTED] - `pipeline.vue:1250` **and** `audio.vue:1665` → "this channel has no<br>  Introduction", which **suppresses the pre-spend warning** ("Four episodes were<br>  voiced with no opening", per that code's own comment). |
| E-04 | OPEN — medium and low / Frontend — misleading empty and error states | 239-239 | [REPORTED] - `subtitles.vue:56` → "No chapter audio found", Transcribe disabled. |
| E-05 | OPEN — medium and low / Frontend — misleading empty and error states | 240-241 | [REPORTED] - `AudioChapterSelector.vue:732` → "No sections found. Generate the script<br>  first." |
| E-06 | OPEN — medium and low / Frontend — misleading empty and error states | 242-242 | [REPORTED] - `pipeline.vue:431` → "No accepted ideas yet." |
| E-07 | OPEN — medium and low / Frontend — misleading empty and error states | 243-244 | [REPORTED] - `video-assembly.vue:3285` / `:3337` → permanent "Loading transitions…" and the<br>  picker never mounts. |
| E-08 | OPEN — medium and low / Frontend — misleading empty and error states | 245-245 | [REPORTED] - `video-assembly.vue:201` → a failed asset scan blanks Step 1 entirely. |
| E-09 | OPEN — medium and low / Frontend — misleading empty and error states | 246-247 | [REPORTED] - `video-assembly.vue:2034` → "No subtitle file for this episode yet" renders<br>  from the initial `null`, so it flashes on every load. |
| E-10 | OPEN — medium and low / Frontend — misleading empty and error states | 248-248 | [REPORTED] - `scene-plan.vue:583` → deleting the plan leaves a heading-only card. |
| E-11 | OPEN — medium and low / Frontend — misleading empty and error states | 249-250 | [REPORTED] - `jobs.vue:1667` → `queuePaused` is a two-valued ref fed by a `catch` that<br>  keeps the last value, so "unknown" reads as "running". |
| S-01 | OPEN — medium and low / Frontend — episode state surviving a change (AGENTS.md §4) | 256-257 | [REPORTED] - `scene-plan.vue:1690` — "Custom instructions" (labelled per-episode) is never<br>  reset, is persisted under a project-only key and is snapshotted into presets. |
| S-02 | OPEN — medium and low / Frontend — episode state surviving a change (AGENTS.md §4) | 258-259 | [REPORTED] - `scripts.vue:870` — `manual_guidance` and `character_ids` survive and ride in<br>  the script preset, plus the per-run `force` flag. |
| S-03 | OPEN — medium and low / Frontend — episode state surviving a change (AGENTS.md §4) | 260-261 | [REPORTED] - `metadata.vue:1029` — `if (v.title_options.length) … }` with **no else**;<br>  EP0001's title variants are saved as EP0002's. |
| S-04 | OPEN — medium and low / Frontend — episode state surviving a change (AGENTS.md §4) | 262-263 | [REPORTED] - `services/audio-reconciler.ts:157` — `\|\| audioJobs[0]` takes **another<br>  episode's** TTS model to predict this episode's chunk split. |
| S-05 | OPEN — medium and low / Frontend — episode state surviving a change (AGENTS.md §4) | 264-265 | [REPORTED] - `image-prompts.vue:1398` — episode-scoped cast ids persist in a project-only<br>  blob and are sent for the new episode. |
| S-06 | OPEN — medium and low / Frontend — episode state surviving a change (AGENTS.md §4) | 266-268 | [REPORTED] - `broll.vue:922`, `scene-review.vue:1035`, `images.vue:1411`,<br>  `research.vue:1207`, `character-sheet.vue:534`, `motion-review.vue:886`,<br>  `metadata.vue:279` — replaced only on a *successful* load, never blanked. |
| F-01 | OPEN — medium and low / Frontend — other confirmed | 271-272 | [REPORTED] - `scene-plan.vue:1151` — the Style Bible is `.slice(0, 2000)` with a "Saved"<br>  toast and no counter. §1: a limit that is enforced must be shown. |
| F-02 | OPEN — medium and low / Frontend — other confirmed | 273-275 | [REPORTED] - `scene-plan.vue:39` — `:loading-label` is bound to a prop that does not exist<br>  (`TopActionBar` expects `generateLoadingLabel`), so the busy affordance never<br>  appears. |
| F-03 | OPEN — medium and low / Frontend — other confirmed | 276-277 | [REPORTED] - `video-assembly.vue:2929` — `needsChoice` from the output-option picker is not<br>  enforced, and an informational notice is routed to `showError`. |
| F-04 | OPEN — medium and low / Frontend — other confirmed | 278-280 | [REPORTED] - `settings.vue:2204` — FFmpeg status is never fetched when the tab is opened<br>  from the nav, so a bundled install is offered "Install recovery copy", which<br>  really downloads. |
| F-05 | OPEN — medium and low / Frontend — other confirmed | 281-282 | [REPORTED] - `settings.vue:4676` vs `:4766` — two `immediate` watchers write<br>  `category_id`; the second blanks what the first hydrated. |
| F-06 | OPEN — medium and low / Frontend — other confirmed | 283-285 | [REPORTED] - `utils/projectSettingsSave.ts:23` — "Use app default" sends `undefined`, which<br>  `JSON.stringify` drops, so the key is never cleared and the app still says<br>  "saved". This is an **AI-disclosure compliance** field. |
| F-07 | OPEN — medium and low / Frontend — other confirmed | 286-287 | [REPORTED] - `scripts.vue:216` — `v-if="false && formatContext"` makes the format-envelope<br>  and out-of-range warnings permanently unreachable, with ~200 lines of dead CSS. |
| F-08 | OPEN — medium and low / Frontend — other confirmed | 288-289 | [REPORTED] - `settings.vue:724` — the page says to press "Sync Folders"; no such control<br>  exists and `POST /projects/:slug/sync-folders` is unreachable from the UI. |
| F-09 | OPEN — medium and low / Frontend — other confirmed | 290-291 | [REPORTED] - `scene-review.vue:418` — the 🎬 badge's tooltip promises a preview; the handler<br>  writes a ref nothing reads. |
| F-10 | OPEN — medium and low / Frontend — other confirmed | 292-293 | [REPORTED] - `research.vue:36` — `result?.claims.length` is unguarded; a `research.json`<br>  without `claims` blanks the page. |
| F-11 | OPEN — medium and low / Frontend — other confirmed | 294-297 | [REPORTED] - `composables/useJobs.ts:34`, `components/EpisodeSelector.vue:473`,<br>  `jobs.vue:2028` — four hand-maintained job-type label maps have drifted;<br>  `useJobs.ts` is missing 6 live types, `EpisodeSelector.vue` 20 of 30, so toasts<br>  and the episode dropdown render raw slugs. |
| F-12 | OPEN — medium and low / Frontend — other confirmed | 298-299 | [REPORTED] - `ContentPurchaseDialog.vue:262` — `overflow: hidden` with no inner scroller<br>  clips the Cancel / "Confirm up to N credits" footer. |
| F-13 | OPEN — medium and low / Frontend — other confirmed | 300-302 | [REPORTED] - `.input-sm`, `.btn-icon`, `.link-btn`, `.checkbox-label`, `.section-kicker`,<br>  `.card-actions` — same shape as `.btn-ghost`: defined only inside one<br>  component's scoped block. |
| F-14 | OPEN — medium and low / Frontend — other confirmed | 303-304 | [REPORTED] - `settings.vue:5310` — a `position: sticky` save bar inside `overflow: hidden`<br>  can never stick. |
| F-15 | OPEN — medium and low / Frontend — other confirmed | 305-310 | [REPORTED] - Geometry, all clip with no scrollbar because `layouts/dashboard.vue:540` sets<br>  `overflow-x: hidden`: `subtitles.vue:1121` (long SRT filename pushes the view<br>  and delete buttons out), `SubtitleCuePreview.vue:75` (pushes the close button<br>  out), `settings.vue:5759` (folder-template grid), `scene-plan.vue:3423`,<br>  `video-assembly.vue:6449`, `audio.vue:2212`, `scene-review.vue:2011`,<br>  `research.vue:1881`, `pipeline.vue:1972`. |
| Z-01 | OPEN — medium and low / Zero-means-two-things (§6) | 313-319 | [REPORTED] - `lib/opening-duration.ts:104` — `return clip.fallback_sec \|\| 0` makes 0 mean<br>  both "nothing precedes the scenes" and "the probe returned nothing". The plan's<br>  intro bucket has no fallback while the renderer's has `fallback_sec: 5`, so the<br>  two disagree by construction for one input; `scene-plan.ts:994` writes<br>  `opening_source: 'measured'` unconditionally and `video.ts:2030` then sets<br>  `hide_during_intro = false`. `__tests__/opening-duration.test.ts:61-69` pins the<br>  divergence. **Editorial — the fix shifts timelines.** |
| Z-02 | OPEN — medium and low / Zero-means-two-things (§6) | 320-326 | [REPORTED] - `services/storage-audit.ts:105` + `episode-media-cleanup.ts:307` +<br>  `asset-status.ts:1019` — `startsWith(\`${code}_final_video.\`)` rejects<br>  `_final_video_v2.mp4`, which the app itself writes (`upload-queue.ts:305`). The<br>  same file IS recognised at `storage-audit.ts:792`, a half-applied fix. Result:<br>  Settings shows "Final videos: 0 B" and the space cannot be reclaimed. The<br>  correct matcher already exists in this repo: `MERGED_AUDIO_FILENAME`<br>  (`lib/intro-lead-in.ts:161`). |
| Z-03 | OPEN — medium and low / Zero-means-two-things (§6) | 327-329 | [REPORTED] - `services/music-library.ts:132` — `available_seconds` sums `duration_sec \|\| 0`,<br>  so unmeasured tracks silently understate "X min usable" at the point the user<br>  decides whether to buy more music. |
| Z-04 | OPEN — medium and low / Zero-means-two-things (§6) | 330-331 | [REPORTED] - `services/subtitle-completion.ts:189` — a failed `stat` becomes `mtimeMs = 0`,<br>  i.e. the oldest value, so "could not check" resolves to "not stale". |
| Z-05 | OPEN — medium and low / Zero-means-two-things (§6) | 332-334 | [REPORTED] - `services/sound-design.ts:70` — `Math.max(0, ...[])` manufactures a 0-length<br>  timeline on an empty plan, and every cue is then rejected as "outside the<br>  episode timeline". |
| Z-06 | OPEN — medium and low / Zero-means-two-things (§6) | 335-336 | [REPORTED] - `lib/thumbnail-prepare.ts:38` — `meta.width \|\| 0` means an unmeasurable width<br>  passes the "too wide" check. |
| M-01 | OPEN — medium and low / Model dynamism (§1/§2) | 339-342 | [REPORTED] - `motion-review.vue:743` + `:384` — the only two statements of aspect ratio are<br>  the literal `'16:9'`; the selected video model's published `aspect_ratios` is<br>  parsed and discarded, and `scene-clip.ts:362` reduces whatever arrives to a<br>  landscape/portrait binary. Every i2v clip is landscape on every model. |
| M-02 | OPEN — medium and low / Model dynamism (§1/§2) | 343-345 | [REPORTED] - `lib/genstudio-client.ts:7315` — the image parser substitutes<br>  `default_aspect_ratio: '16:9'` when none is published, and<br>  `scene-review.vue:839` then clamps onto a frame the model never named. |
| M-03 | OPEN — medium and low / Model dynamism (§1/§2) | 346-347 | [REPORTED] - `images.vue:1124` — a six-entry hardcoded ratio list is offered when a model<br>  publishes none, and the clamp is skipped in exactly that case. |
| M-04 | OPEN — medium and low / Model dynamism (§1/§2) | 348-351 | [REPORTED] - `images.vue:728` — the per-row character badge reads<br>  `config.image_models[].prompt_char_cap`, a retired map, instead of the live<br>  `max_prompt_characters` already on the page — so a cap enforced at<br>  `routes/image-preview.ts:172` is never shown. |
| M-05 | OPEN — medium and low / Model dynamism (§1/§2) | 352-353 | [REPORTED] - `images.vue:90` — the "View all caps" modal prints persisted caps **and<br>  prices** from project config under copy implying they are current. |
| M-06 | OPEN — medium and low / Model dynamism (§1/§2) | 354-355 | [REPORTED] - `lib/genstudio-client.ts:144` — a 100 MiB transcription ceiling is enforced and<br>  never shown. |
| M-07 | OPEN — medium and low / Model dynamism (§1/§2) | 356-357 | [REPORTED] - `lib/chunked-narration.ts:184` — `SINGLE_CHAPTER_REPAIR_OUTPUT_TOKENS = 8_192`<br>  clamps down to the published ceiling but can never rise with it. |
| M-08 | OPEN — medium and low / Model dynamism (§1/§2) | 358-362 | [REPORTED] - The model-drift guard could not see the last two: its rules need a<br>  `PUBLISHED_LIMIT_FIELDS` name plus a numeric literal, a `?? number` default, or<br>  a `Number.isInteger(...) ? published : CONSTANT` ternary. A literal inside a<br>  `typeof … === 'string' ? trimmed : '16:9'` ternary and a bare `const X = 8_192`<br>  match none of those. |
| Y-01 | OPEN — medium and low / YouTube | 365-372 | [REPORTED] - Cross-project duplicate upload: `video-claims.json` has exactly one reader and<br>  one writer, both inside `acceptYouTubeOperation` — i.e. only AFTER YouTube has<br>  accepted the bytes — while upload admission<br>  (`routes/youtube-upload-center.ts:2218`) asks only `remoteVideoFor`, which is<br>  project-scoped. Two projects sharing an episode code (`EP0001`–`EP0006` exist<br>  in seven channels) on the same channel can both upload, and project B's<br>  conflict is then downgraded to a job warning at<br>  `generators/youtube-upload.ts:511`. Unrecoverable: a second public video. |
| Y-02 | OPEN — medium and low / YouTube | 373-377 | [REPORTED] - A sidecar tombstoned `manual` on a channel the project has since left is a<br>  permanent refusal — `youtube-remote-video.ts:395` requires<br>  `sidecar.channel_id === channelId`, and the new "Forget upload" route<br>  (`:2085`) requires the same channel, so the only escape is a legacy route with<br>  no frontend caller. The episode can never be published again. |
| Y-03 | OPEN — medium and low / YouTube | 378-381 | [REPORTED] - `youtubeArchiveProofForFile` (a MOVE) accepts a reconcile link or legacy<br>  sidecar on an mtime test alone, with no content hash, where the deletion path<br>  correctly demands a `sha256:` `ready_operation`<br>  (`youtube-remote-video.ts:253` vs `:219`). |
| Y-04 | OPEN — medium and low / YouTube | 382-383 | [REPORTED] - The same helper returns `ready_operations[0].video_id` ignoring channel, so<br>  the archive breadcrumb can misattribute a video. |
| Y-05 | OPEN — medium and low / YouTube | 384-386 | [REPORTED] - `routes/youtube-upload-center.ts:2916` — `/episodes/:code/schedule` PATCHes<br>  YouTube first and writes the local receipt after, across four non-transactional<br>  writes with an `expected_revision` read earlier in the request. |
| Y-06 | OPEN — medium and low / YouTube | 387-389 | [REPORTED] - `services/upload-plans.ts:533` — `addDays` adds a fixed 24h, which stalls on<br>  sub-hour DST zones (reproduced on Australia/Lord_Howe). The failure is safe —<br>  it refuses rather than publishing at a wrong time. |
| Y-07 | OPEN — medium and low / YouTube | 390-392 | [REPORTED] - `routes/upload.ts:1594` — the legacy plan-apply PATCHes without<br>  `requirePrivacyStatus` and can set a live public video back to private. Its<br>  preview/apply routes have no frontend caller. |
| Y-08 | OPEN — medium and low / YouTube | 393-394 | [REPORTED] - `services/storage-audit.ts:821` — a same-size destination file is taken as a<br>  completed copy for non-final media, then the source is deleted. |
| P-01 | OPEN — medium and low / Content packs | 397-399 | [REPORTED] - `content-packs/state.ts:99` — one malformed record quarantines and rewrites<br>  `state.json` as empty with **no log and no reconciliation against `installed/`**,<br>  so every pack silently disappears from every catalogue and the Store. |
| P-02 | OPEN — medium and low / Content packs | 400-402 | [REPORTED] - `content-packs/installer.ts:617` vs `state.ts:155` — a crash between the<br>  version-directory rename and the state checkpoint leaves an orphan no pass ever<br>  reconciles, permanently blocking re-install of that version. |
| P-03 | OPEN — medium and low / Content packs | 403-405 | [REPORTED] - `services/content-store-delivery.ts:527` — `alreadyInstalled` calls the throwing<br>  closure verifier with no try/catch, so a damaged local copy can never be<br>  repaired by installing again. |
| P-04 | OPEN — medium and low / Content packs | 406-408 | [REPORTED] - `content-store-delivery.ts:640` vs `recovery.ts:202` — boot adoption silently<br>  activates every retained-but-inactive pack, so a half-delivered bundle goes<br>  partially live after a restart. |
| P-05 | OPEN — medium and low / Content packs | 409-411 | [REPORTED] - `content-packs/lifecycle.ts:308` — `pruneUnpinnedContentPackVersions` deletes<br>  the version rolled back FROM, and deletes **every** version when no active<br>  version exists. No production caller today. |
| P-06 | OPEN — medium and low / Content packs | 412-413 | [REPORTED] - `content-store-install-state.ts:121` — reports `pack.active_version` for an<br>  exact-hash match that is a different version. |

## FIX-PLAN additions absent from the original audit

Copied verbatim from docs/audit/FIX-PLAN.md; separate from candidate JSON because these are plan/recovery additions.

### FIX-E2 — docs/audit/FIX-PLAN.md:32-50

~~~text
- **E-2. Decision 6's OTHER site, found while finishing E — and it is reachable.**
  `services/scene-prompt-batching.ts:168` (`normalizeMaxOutputTokens`) throws for
  exactly the same condition v1.4.209 removed from `productCeiling`, and
  `generators/scene-plan.ts:717` feeds it the selected prompt model's
  `max_output_tokens`. So a Pipeline **`scene_plan_run`** with one of the four
  null-ceiling models still fails, even though the model now works everywhere
  else. The Scene Plan PAGE gates itself too: `hasPublishedPromptBudget`
  (`scene-plan.vue:1810`) hides "Next" and disables the batch controls when no
  ceiling is published. [MEASURED] Takeover source inspection found that "All
  pending" remains available after model selection and can reach the backend
  rejection; the earlier claim that both buttons were hidden was incorrect.
  **This needs the owner, because it decides what the app SAYS:** with no
  published ceiling there is no derivable batch maximum, so the honest rule is
  "use this channel's configured batch size and send no token ceiling; GenStudio
  validates". The module already has that shape for model-free runs
  (`SCENE_TIMELINE_ONLY_OUTPUT_BUDGET`), but it removed an 8,192 substitute once
  and calls it "the third instance of the same mistake", so the wording and the
  fallback both want a ruling rather than a guess. Recommendation: adopt the
  configured batch size, say so on the card, and omit `prompt_max_tokens`.
~~~

### FIX-F — docs/audit/FIX-PLAN.md:51-55

~~~text
- **F. Decision 9's channel-specific box** — new UI. Add a second, clearly
  labelled channel-level guidance field on Scene Plan whose text IS in a preset
  (unlike `custom_instructions`); decide with the owner whether it writes to
  `config.json` like `default_style_bible` or rides only in presets; make the
  two boxes visually distinct.
~~~

### FIX-QUEUE — docs/audit/FIX-PLAN.md:1152-1155

~~~text
- [ ] Queue: `:684` (5s timer
      forever), `:2911` (crash-interrupted paid work mislabelled), `:1659`
      (clone per frame), `routes/pipeline.ts:2202`, `useJobs.ts` (never
      retries SSE), `jobs.vue:1956`/`:2675`/`:2205`/`:2240`/`:2844`/`:3203`.
~~~

### FIX-YOUTUBE — docs/audit/FIX-PLAN.md:1156-1159

~~~text
- [ ] YouTube: previous-channel tombstone dead end,
      `youtubeArchiveProofForFile` mtime-only MOVE, archive proof ignores
      channel, `/schedule` publish-then-record, `upload-plans.ts:533` DST,
      legacy plan-apply unpublish, `storage-audit.ts:821` same-size copy proof.
~~~

### FIX-CONTENT — docs/audit/FIX-PLAN.md:1160-1186

~~~text
- [ ] **ROUND 40 — TRACED, NOT FIXED. Second-best next target after the queue.**
      Content packs: `state.ts:99` (silent empty reset). The audit's description
      is accurate but undersells it; here is what the code actually does.

      `readOrResetState` branches four ways:
      `valid` → the state · `missing` → `emptyContentPackState()` (correct — a
      fresh install) · `io-error` → **throws** (correct, and NOT the defect) ·
      anything else → `resetInvalidState`.

      `resetInvalidState` (`:76-98`) is more careful than "silent" suggests: it
      refuses a quarantine root that is not directly below the runtime root,
      refuses a symlinked or non-directory quarantine, and writes the corrupt
      bytes to `state-invalid-<sha256>.json` with `flag: 'wx'` before writing an
      empty state. **The data is preserved.**

      The defect is that nothing is SAID. On the success path there is no log
      line, and `readOrResetState` returns `emptyContentPackState()` with no
      signal to its caller that a reset happened — so the Content Store renders
      an empty library exactly as it would for someone who has never installed
      anything, while the user's actual state sits unread in quarantine. AGENTS.md
      §6: "the answer is none" and "I discarded your state" must not produce the
      same value.

      Fix shape: return a discriminated result (state + `recovered_from` | null)
      and surface it, rather than a bare state that has already forgotten what
      happened. Do NOT stop quarantining — that part is right and should not be
      traded away for a simpler error.
~~~

### FIX-CONTENT-REMAINING — docs/audit/FIX-PLAN.md:1188-1192

~~~text
- [ ] Content packs — remaining:
      `installer.ts:617` (orphan version unreconcilable),
      `content-store-delivery.ts:527` (damaged copy unrepairable), `:640`
      (staging activated on boot), `lifecycle.ts:308` (prune deletes rollback
      target), `content-store-install-state.ts:121` (wrong version).
~~~

### FIX-SETTINGS — docs/audit/FIX-PLAN.md:1207-1213

~~~text
- [ ] Settings / misc — remaining:
      `routes/video.ts:1744` (`?path=` stat oracle — containment not yet
      applied), `app.ts:124`/`:140` (hardcoded `version: '0.1.0'`),
      `routes/debug.ts` (unused, returns absolute paths).
- [ ] Dead code the owner has approved removing: `lib/ttl-cache.ts` + its test;
      the orphaned `endpoint_labels` / `hub_url` / `endpoint_disabled` data
      stays on disk, unread.
~~~

### FIX-RECOVERY — docs/audit/FIX-PLAN.md:1130-1150

~~~text
- [x] **v1.4.210 recovery patch — reviewed and verified locally, not shipped.** Queue cancellation
      flags must live as long as either the history row or its active worker.
      The interrupted patch deleted flags whenever rows were retired, incorrectly
      assuming a terminal status proved the executor had returned.

      [MEASURED] `stopLocalJobUnlocked` and `forceAbandonJobUnlocked` can mark a
      live worker cancelled. The recovered tests first reproduced early flag
      removal for Delete, Clear, Retry, and Abandon + Delete (4 failures out of
      68 tests, runner exit 1). The repair tracks actual `runJob` lifetimes,
      defers flag cleanup until its `finally` when necessary, and prevents late
      worker completion from restoring retired history. Queued rows still shed
      their flags immediately. Provider-evidence guards remain in place.

      [MEASURED] The initial corrected run passed 68/68 (exit 0, two files
      completed). Additional tests cover late rejection, paid-wait results,
      and durable deletion. This focused run is not the release gate. Final
      counts and full-gate status are in the takeover report: the final focused
      run passed 82 tests; the full backend gate passed 5,442 tests across all
      483 files. Frontend, release, corrected content-pack checks, build, and
      isolated v1.4.210 launch also passed. Integration remains pending review
      of the 70 inherited local commits; this is not a shipped release.
~~~

## Explicit omissions

The original audit's Fixed and gate-verified, Electron / settings / IPC — verified CLEAN, Not defects, but worth knowing, and Audit claims I verified as FALSE sections are outside the requested OPEN critical/high/medium through Content packs range. No other omission is known from that source range.

No tests, builds, or product/source edits were run or made.
