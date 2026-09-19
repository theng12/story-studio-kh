# Fix plan

Working record for the fixes listed in `2026-09-19-defect-audit.md`. **This file
is the durable memory** — the working context resets between rounds, so a group
is not finished until its box is ticked here.

## The loop, per item

1. **Trace it first.** Read the code and confirm the failure is real. Four audit
   claims were already false when checked; do not fix a claim.
2. **Write the test that fails.** It must fail for the *right* reason — assert a
   consequence (a file still exists, a status is still false), not an error
   string. A rejection assertion passes even when the damage already happened.
3. **Fix it.**
4. **Re-run the test.** Green, and the control case still passes.
5. **Affected suites**, then the **full backend gate** (frontend lane for
   frontend-only work). Never quote a filtered run as green.
6. **Tick the box here**, with the commit.

## Rules that have already earned their place

- Validate the **security property**, never a charset copied from elsewhere. A
  regex that was only ever applied on one branch has unknown coverage.
- `git checkout HEAD -- <file>` restores HEAD, which may *be* the change you are
  reverting. Check the file's content afterwards, not the exit code.
- "Dead state" is a claim about the whole system. Grep for readers before
  clearing a field.
- Prefer the chokepoint (the one path builder ~40 callers share) over per-route
  guards. Per-route is the arrangement that let the traversal class exist.

---

# Group 1 — output integrity

*The app must not report success over missing output, and must not publish the
same episode twice.*

## 1.1 The completion contract (the big one)

`services/job-completion.ts` — the ordinary success path is a **self-declaration**:
`assertJobDidNotDeclareIncomplete` returns immediately unless the executor itself
set `result.complete === false`. Every guarantee depends on each generator
choosing to prove, and these never do: `generateAudioMerge`,
`generateVideoAssembly`, `generateSubtitlesTranscribe`, `generateYoutubeUpload`,
`generateYoutubePlaylistUpdate`, `generateThumbnailRefresh`, `broll_assemble`.

The infrastructure already exists: `registerJobCancellationAuditor`
(`boot/executors.ts:129-198`) computes `complete | repair-required` from disk for
10 job types, and is wired only on the provider-settlement path.

- [ ] Read `job-cancellation-auditors.ts` and `job-completion.ts` fully; write
      down what the success path does today and which types have an auditor.
      **DONE — and the result changes this group's shape. See below.**

### What the enumeration actually found (round 13)

`requireJobCompletion(job, audit)` is the correct mechanism: it sets
`result.complete` and throws with an item-naming message. The queue's success
path (`completeSuccessfulJob`, `job-queue.ts:3252`, with
`assertJobDidNotDeclareIncomplete` at `:3404`) only calls
`assertJobDidNotDeclareIncomplete`, which returns immediately unless
`job.result?.complete === false`. So an executor that audits nothing passes.

**Auditors exist for only 11 of the 40 job types:** `audio`,
`subtitles_transcribe`, `thumb_images`, `scene_image_generate`,
`continuity_render`, `composition_generate`, `image_pool_generate`,
`scene_clip_generate`, `scene_clips_batch`, `scene_plan_run`, `video`.

**Six of the seven types the audit named have NO auditor**, so "run the existing
per-type auditor on the success path" cannot close them — it would close the 11
above and leave the named ones exactly as they are:

| Type | Auditor? | Produces |
|---|---|---|
| `broll_assemble` | ✗ | the assembled video |
| `audio_merge` | ✗ | merged audio |
| `youtube_upload` | ✗ | the upload itself |
| `youtube_playlist_update` | ✗ | playlist membership |
| `youtube_thumbnail_refresh` | ✗ | the pinned thumbnail |
| `music_generate` | ✗ | tracks |
| `music_video` | ✗ | a video |
| `broll_normalize` | ✗ | normalised clips |
| `images_repair` | ✗ | repaired images |
| `image_prompts` | ✗ | prompt docs |
| `metadata` | ✗ | metadata package |
| `contextual_cues` | ✗ | cue timeline |
| `expression_markup` | ✗ | markup |

Text/chat types (`idea_campaign`, `script-only`, `chapter-only`,
`outline_only`, `expand_chapters`, `introduction-only`, `research_run`) audit
themselves through their own `requireJobCompletion` and legitimately declare
nothing in some modes — they must keep today's behaviour.

**So this group is two steps, and the first is still the right first:**

- [ ] **(1a)** Run the existing auditor on the ordinary success path for the 11
      types that have one. Apply only when the executor declared nothing
      (`result.complete === undefined`) — a declared `true` means the executor
      already audited, and a declared `false` already throws. Behaviour changes
      only for a job whose executor audited nothing AND whose auditor finds a
      problem.

      **ATTEMPTED AND REVERTED (round 13).** Commit `a8d15229` added
      `assertAuditedCompletionOnSuccess` and the full gate failed immediately,
      in `remote cancellation checkpoints`:

        ✖ simultaneous final provider updates run the auditor and terminal
          transition once
        ✖ provider success during a live executor waits for local output before
          auditing or releasing the lock

      **Why it was wrong.** The PROVIDER-SETTLEMENT path already audits
      (`job-queue.ts:955`), and is stricter than I assumed: for a type with no
      auditor it refuses to finish at all — *"Provider work settled, but no
      output auditor is registered. Keeping this job running until output can be
      verified."* My addition ran the auditor a SECOND time on the same job, and
      those tests pin "the auditor and terminal transition run ONCE".

      **The correct target.** The hole is not "the success path audits nothing"
      — it is narrower: **the path where no provider settlement audit ran**, i.e.
      local-only completions and types the settlement path never reaches. The
      fix must be scoped to that path, not applied blanket at
      `completeSuccessfulJob`. Do not re-derive this from the audit report; the
      report's recommendation ("run the existing auditor on the success path")
      was based on the premise that it was wired to only one path, and the
      stronger truth is that the settlement path is already the audit.

      **Next attempt, in order:** (i) find what marks a job as already audited by
      the settlement path; (ii) scope the new check to jobs that lack that mark;
      (iii) write the test as "the auditor runs ONCE when both paths could fire",
      which is the test that was missing from the first attempt and is the whole
      reason the gate caught it.

      **SOLVED (round 14) — here is the exact shape, do not re-derive it.**

      `completeSuccessfulJob` (`job-queue.ts:3252`) is **shared**, and that is the
      whole reason the first attempt failed. Its callers:

        :979   the PROVIDER-SETTLEMENT path, AFTER it has already audited (:955)
        :3467  the ordinary/local completion path

      My check went at :3404, inside that shared function, so every settled job
      was audited twice. Two other completion sites exist and were not involved:
      `enqueueOrRun` (:4564, the direct executor runner used by routes and
      tests) and the settlement path itself.

      **The scoping fix is a marker, not an inference.** The settlement path's
      SUCCESS branch (:985) sets nothing on the job before calling
      `completeSuccessfulJob` — only its repair branch sets `provider_settled`.
      So:

        1. In the success branch, before `await completeSuccessfulJob(job)` at
           :985, record that the output was audited:
           `job.result = { ...(job.result || {}), provider_settled: 'succeeded', output_audited: 'provider-settlement' }`
        2. In the new check, skip when `job.result?.output_audited` is set.
           Everything else keeps the limits already written above (only when
           `result.complete === undefined`; only for types with an auditor).

      Do NOT scope it by "has provider evidence" — that is an inference about
      which path ran, and this state machine has now punished two of those.

      **Write these two tests FIRST**, because the first attempt had neither and
      the gate is what found it:
        - a job that settled with provider work and passed the settlement audit
          runs the auditor EXACTLY ONCE (spy on the auditor, assert one call)
        - a locally-completed job whose executor declared nothing and whose
          auditor says `repair-required` does NOT end `done`
- [ ] **(1b)** Write auditors for the 13 artifact-producing types above, starting
      with the four that cost or lose the most: `broll_assemble` (truncated
      video), `audio_merge` (transcription on a stale mix), `youtube_upload`
      (claims success over a failed upload), `music_generate` (unmeasurable
      tracks counted complete).
- [ ] Decide the shape: run the per-type auditor on the ordinary success path
      and require a positive `result.completion` declaration with `expected > 0`
      for artifact-producing types. **Enumerate every registered job type and
      say for each whether it produces artifacts** — this must not fail a type
      that legitimately declares nothing (e.g. a pure provider-poll type).
- [ ] Implement, with a test per shape: an executor that declares nothing is
      failed; one that declares complete passes; one whose artifacts are missing
      fails and NAMES them; a legitimately declaration-free type still passes.
- [ ] Full gate.

## 1.2 The named instances of 1.1

Fix these individually **only** where 1.1 does not cover them — 1.1 is the class,
these are the specific lies a user can hit today.

- [ ] `generators/broll-assemble.ts:409` — no audit at all, encodes `-shortest`,
      so a coverage-short selection truncates narration mid-sentence while the
      board shows green.
- [ ] `services/audio-workflow-readiness.ts:50` — any audio file with size > 0 is
      "merged audio ready", unblocking paid transcription on a superseded take.
- [ ] `services/scene-timeline-integrity.ts:148` — called without
      `max_cue_gap_sec` it returns before the sha256 / cue-count check, so a
      truncated `_stitched.srt` beside an intact `.json` passes.
- [ ] `services/subtitle-completion.ts:295` — one whole-track SRT claims full
      coverage without parsing a cue. Same at `episode-recovery.ts:150` (one cue
      certifies the episode) and `generators/subtitles.ts:294`.
- [ ] `services/manifest-audit.ts:362` — swallowed stage errors become
      `{expected: 0, missing: []}`, so "could not measure" reads as "nothing
      expected".
- [ ] `generators/video.ts:5061` + `broll-assemble.ts:246` — requested
      word-mode captions silently degrade; `declareJobDegraded` never called.
- [ ] `generators/audio.ts:756` + `:1267` — a stale mp3 is skipped and audited by
      presence, so edited narration ships the old audio.
- [ ] `generators/episode.ts:1521` — `outline_only` marks the over-delivering
      outline the v1.4.36 ruling embraces as invalid; paid work binned, Retry
      replays the same failure forever.
- [ ] `generators/scene-plan.ts:871-1016` + `routes/pipeline.ts:1183` — a
      Pipeline `scene_plan_run` has no `stage`, defaults to `timeline`, and
      **whole-file replaces** `scene_plan.json`, wiping paid prompts and
      re-requesting all of them.
- [ ] `generators/metadata.ts:595` vs `lib/upload-metadata.ts:115` — v2 written,
      v1 read by the upload, so the old metadata publishes.
- [ ] `generators/music-generate.ts:246` — an unmeasurable track is counted
      complete.
- [ ] `services/job-completion.ts:68` — `audit.expected >= 0` makes `0/0`
      complete (vacuous truth) for future callers.

## 1.3 Duplicate upload across projects

- [ ] `video-claims.json` has one reader and one writer, both inside
      `acceptYouTubeOperation` — i.e. **after** YouTube accepted the bytes.
      Admission (`routes/youtube-upload-center.ts:2218`) asks only
      `remoteVideoFor`, which is project-scoped. Two projects sharing an episode
      code on the same channel can both upload; the conflict is then downgraded
      to a warning (`generators/youtube-upload.ts:511`).
      **Fix at admission**, and let a `completeYouTubeOperation` conflict fail
      the job loudly. Needs a design decision on where the cross-project claim
      is read — the claims store keys on `(channel, video)` and does not carry
      the episode code.

---

# Group 2 — data integrity: episode state leaking

AGENTS.md §4, the repo's most expensive class. Each is "a value belonging to
episode A reaching episode B". Two were fixed (`metadata.vue` titles,
`pipeline.vue` force-re-run).

- [ ] `scene-plan.vue:1690` — "Custom instructions" (labelled per-episode) never
      reset, persisted per-project, snapshotted into presets.
- [ ] `scripts.vue:870` — `manual_guidance` + `character_ids` survive and ride in
      the script preset; plus the per-run `force` flag.
- [ ] `services/audio-reconciler.ts:157` — `|| audioJobs[0]` takes **another
      episode's** TTS model to predict this episode's chunk split.
- [ ] `image-prompts.vue:1398` — episode-scoped cast ids persist in a
      project-only blob and are submitted for the new episode.
- [ ] `broll.vue:922` — selection / narration target not cleared.
- [ ] `scene-review.vue:1035` — lightbox + checked batch survive.
- [ ] `images.vue:1411` — integrity status + Browse grid not blanked.
- [ ] `research.vue:1207` — stale research durable on a failed read, and PUT to
      the new episode.
- [ ] `character-sheet.vue:534`, `motion-review.vue:886`, `metadata.vue:279` —
      replaced only on a *successful* load, never blanked.
- [ ] The ownership-by-prefix matcher, four copies:
      `asset-status.ts:366` + `:383`, `folder-resolver.ts:132`,
      `manifest-audit.ts:127`, `audio-merge.ts:119`. Must match
      `code` or `` `${code} - ` ``, never a bare `startsWith`.

# Group 3 — honesty: numbers that lie

- [ ] `lib/opening-duration.ts:104` — `fallback_sec || 0` makes 0 mean both
      "nothing precedes the scenes" and "the probe returned nothing"; plan and
      render disagree by construction. **Editorial — the fix shifts timelines,
      so it needs the owner's yes.**
- [ ] `storage-audit.ts:105` + `episode-media-cleanup.ts:307` +
      `asset-status.ts:1019` — `_final_video_v2.mp4` invisible, so Settings shows
      "0 B" and the space cannot be reclaimed. Use the repo's own
      `MERGED_AUDIO_FILENAME` shape.
- [ ] `music-library.ts:132` — unmeasured tracks understate "usable minutes".
- [ ] `subtitle-completion.ts:189` — a failed `stat` becomes mtime 0 = "not
      stale".
- [ ] `sound-design.ts:70` — `Math.max(0, ...[])` manufactures a 0 timeline.
- [ ] `soft-delete.ts:157` — the `-1` "unknown size" sentinel is unreachable;
      an unreadable folder reports 0 B.
- [ ] `lib/thumbnail-prepare.ts:38` — `meta.width || 0` passes an unmeasurable
      width through the too-wide check.
- [ ] `lib/broll-indexer.ts:74` — ffprobe `'N/A'` is truthy, so a good
      `format.duration` is never read; the clip is dropped as "too short" with a
      warning blaming the preset.

# Group 4 — the long tail

- [ ] Model dynamism: `motion-review.vue:743` (always 16:9),
      `genstudio-client.ts:7315` (invented default ratio), `images.vue:1124`
      (hardcoded ratio list), `images.vue:728` (retired cap map),
      `images.vue:90` (stale caps+PRICES table), `genstudio-client.ts:144`
      (unshown 100 MiB ceiling), `chunked-narration.ts:184` (frozen 8192).
- [ ] Misleading empty states (a failed read told as a confident wrong answer):
      `scene-review.vue:1214`, `research.vue:650`, `pipeline.vue:1250` **and**
      `audio.vue:1665` (both suppress the pre-spend opening warning),
      `subtitles.vue:56`, `AudioChapterSelector.vue:732`, `pipeline.vue:431`,
      `video-assembly.vue:3285`/`:3337`/`:201`/`:2034`, `scene-plan.vue:583`,
      `jobs.vue:1667`.
- [ ] `now-safe` frontend: `scene-plan.vue:1151` (Style Bible silently truncated
      — §1), `scene-plan.vue:39` (nonexistent prop), `settings.vue:2204`
      (FFmpeg status never fetched), `settings.vue:4676` vs `:4766` (category
      blanked), `projectSettingsSave.ts:23` (**AI-disclosure compliance**),
      `scripts.vue:216`, `settings.vue:724` (Sync Folders missing),
      `scene-review.vue:418`, `research.vue:36`, `jobs.vue` label maps,
      `ContentPurchaseDialog.vue:262`, `settings.vue:5310`, and the geometry
      clipping list.
- [ ] Queue: `job-queue.ts:441` (unpruned `cancelled`), `:684` (5s timer
      forever), `:2911` (crash-interrupted paid work mislabelled), `:1659`
      (clone per frame), `routes/pipeline.ts:2202`, `useJobs.ts` (never
      retries SSE), `jobs.vue:1956`/`:2675`/`:2205`/`:2240`/`:2844`/`:3203`.
- [ ] YouTube: previous-channel tombstone dead end,
      `youtubeArchiveProofForFile` mtime-only MOVE, archive proof ignores
      channel, `/schedule` publish-then-record, `upload-plans.ts:533` DST,
      legacy plan-apply unpublish, `storage-audit.ts:821` same-size copy proof.
- [ ] Content packs: `state.ts:99` (silent empty reset),
      `installer.ts:617` (orphan version unreconcilable),
      `content-store-delivery.ts:527` (damaged copy unrepairable), `:640`
      (staging activated on boot), `lifecycle.ts:308` (prune deletes rollback
      target), `content-store-install-state.ts:121` (wrong version).
- [ ] Settings / misc: `health.ts:110` (`200 []` for "no key"),
      `routes/video.ts:1744` (`?path=` stat oracle — containment not yet
      applied), `app.ts:124`/`:140` (hardcoded `version: '0.1.0'`),
      `routes/debug.ts` (unused, returns absolute paths).
- [ ] Dead code the owner has approved removing: `lib/ttl-cache.ts` + its test;
      the orphaned `endpoint_labels` / `hub_url` / `endpoint_disabled` data
      stays on disk, unread.

---

# Gateway-kh handoff, 2026-09-19 — verified, not assumed

The owner asked me to verify the gateway's note (which claimed no code change was
needed) rather than trust it. Method: read the note, then check every claim
against the live service and our own code.

**Endpoint — confirmed.** `genstudio_url` is `http://127.0.0.1:8000` in the saved
setting AND the code default; `:8000` answers 401 (up); `:8010` refuses the
connection. The note's correction to the earlier note is right.
*(Probe gotcha for next time: the video catalogue is `/v1/videos/models`, plural.
`/v1/video/models` returns `Not Found` — my first probe was wrong, not the
gateway.)*

**Catalogue — confirmed exactly.** chat 66 · image 9 · video 9 · tts 13 ·
music 2 · transcription 3, all `stale=false`, no 402 in any request.

**Nothing disappeared — confirmed against our own last-good cache**, which is the
prior state: image 3→9, video 1→9, tts 12→13, music 1→2, voices 12→13, chat
66→66, transcription 3→3. Voices now resolve for `studio-hub::` models (10 for
the Qwen3 rows; before, an empty list). One row to confirm gateway-side rather
than assert: `studio-hub::mlx-community/OmniVoice-bfloat16` lists 0 voices.

**Field families — four of seven need nothing:**

| Field | Live | Verdict |
|---|---|---|
| video `generates_audio` | `null` ×9 | `boolean \| null` end to end; UI claims audio only on `=== true`. Correct. |
| music `supported_languages` | `[]` ×2 | Nothing reads it for music, so `[]` cannot mean English-only. Correct. |
| music `supports_instrumental` | `null` ×2 | Nullable via `isNullableFlag`/`publishedOrNull`; unused in the UI. Correct. |
| TTS `maximum_input_characters` | 25000 ×11, 40000 ×2 | Never null, so `.toLocaleString()` is safe. Guarantee holds. |
| video `modes`, `variants[].operation` | 6 i2v-only, 3 **also text-to-video** | **Safe.** `STORY_STUDIO_VIDEO_MODE` enforced in `providers/video/genstudio.ts:50` AND `genstudio-client.ts:5122` — both throw on any other operation — and all 9 still publish i2v. Text-to-video cannot reach dispatch. |
| chat `context_window_tokens` / `max_output_tokens` | ctx numeric; `max` null ×4 | 0 means "not published" and consumers fail closed. Correct — but see below. |

- [x] **`returns_citations` null was flattened to `false`** — the one claim in the
      note that was NOT implemented. Type is now `boolean | null` and the parse
      preserves it; the qualification gate still requires `=== true` so an
      unstated capability cannot ENABLE research. **Commit `57494344`**, v1.4.186,
      pinned in `research-web-mode.test.ts` (null survives as null, `false`
      survives as false, both still fail the gate).
- [x] **`audio.vue:725` `.length` hardening** — `?.length`. Every TTS row
      publishes an array today, but the gateway's rule is now "null unless
      stated", and music's list already moved. Same commit.

- [ ] **NEEDS THE OWNER'S NOD.** Four chat rows publish `max_output_tokens: null`
      — `openrouter/free`, `xai-direct::grok-4.3`, `grok-4.6`,
      `grok-build-0.1`. We correctly refuse to invent a ceiling, so selecting one
      FAILS. They remain selectable in the picker. Greying them out with "no
      stated output limit" is a UI change that hides rows, so it waits for a
      decision. **This is new exposure**: xAI is a new lane, so these rows did
      not exist before.

---

# Owner decisions still outstanding

1. **Opening-duration semantics** (Group 3, first item). Reserving 5s instead of
   0 for an unprobeable intro shifts affected timelines. Editorial.
2. **`scene-plan.vue` Style Bible cap** — show a counter and say when a save was
   clipped, or raise the limit?
3. **`images.vue` "View all caps"** — delete the table (it prints copied caps and
   prices as if current), or rebuild it from the live catalogue?

Everything else in this plan is unblocked and I will proceed unless told
otherwise.
