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

- [x] **(1a) DONE — commit pending, v1.4.187.** `assertAuditedCompletionOnSuccess`
      in `job-queue.ts`, called from the local completion inside the shared
      `completeSuccessfulJob`, skipping jobs the settlement path owns.
      The predicate that finally worked, found by the SECOND test rather than by
      reasoning: **skip when the job has recorded provider work**
      (`genstudio_jobs.length > 0`). The executor returns BEFORE settlement
      audits — `provider success during a live executor waits for local output
      before auditing` pins that ordering — so without the skip the local pass
      audited first and settlement audited again: two audits, which the gate
      caught as `2 !== 1`.
      That is a fact about the JOB, not an inference about which path ran. Two
      earlier attempts failed on inferred predicates; this one is checkable.
      Tests: the new local-completion failure case, plus the three existing
      once-only/settlement tests still green.

- [ ] **(1a-original-note, superseded)** Run the existing auditor on the
      ordinary success path for the 11 types that have one. Apply only when the executor declared nothing
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
- [~] **(1b) IN PROGRESS — `broll_assemble` DONE (v1.4.188).** Auditor
      `auditBrollAssemblyOutput` in `boot/executors.ts`, registered beside the
      other 11. Decided from the SELECTION SIDECAR alone — `-shortest`
      guarantees a short selection becomes a short video, so measuring coverage
      is sufficient and avoids re-deriving the output path (which may sit under
      an external root) and ffprobing it. Threshold reuses `COVERAGE_FAIL_SEC`
      (2s) so a frame-level trim cannot fail a good render, and a **legacy
      sidecar with no `target_duration` returns `complete`** — failing it would
      invent a requirement that never existed.
      Tests: `broll-assembly-audit.test.ts`, 6 cases. `--only broll --only
      job-cancel` is 73 pass / 0 fail.
      NOTE: registering an auditor also changes the SETTLEMENT path, which
      previously held any type with no auditor ("keeping this job running until
      output can be verified"). `broll_assemble` is now audited there instead of
      held — checked, and nothing broke.
      **1.1b IS MUCH SMALLER THAN THE AUDIT CLAIMED — verified, not assumed.**

      The audit said "seven executors never call `requireJobCompletion`" and
      named `generateAudioMerge`, `generateVideoAssembly`,
      `generateSubtitlesTranscribe`, `generateYoutubeUpload`,
      `generateYoutubePlaylistUpdate`, `generateThumbnailRefresh` and
      `broll_assemble`. Counting the calls in each file contradicts most of that:

      | file | `requireJobCompletion` |
      |---|---|
      | `broll-assemble.ts` | **0** — the real one, now FIXED |
      | `broll-normalize.ts` | **0** |
      | `subtitles.ts` | **0** |
      | `audio-merge.ts` | 2 |
      | `youtube-upload.ts` | 3 |
      | `youtube-playlist-update.ts` | 3 |
      | `youtube-thumbnail-refresh.ts` | 3 |
      | `music-generate.ts` | 2 |
      | `music-video.ts` | 2 |
      | `image-prompts.ts` | 2 |
      | `metadata.ts` | 2 |
      | `contextual-cues.ts` | 2 |
      | `video.ts` | 2 |
      | `images.ts` | 5 |

      So FOUR of the seven the audit named DO declare completion. The audit said
      its method was "grep over electron/server/generators/*.ts", which should
      have found them — the claim looks simply wrong, and it is the second
      enumeration in this group to change the plan's shape.

      **A count is a SCREEN, not proof.** It shows a file declares completion
      somewhere; whether the declaration covers the whole success path (rather
      than one branch) needs per-file reading before any of them is called clean.
      That is the next step, not this table.

      **`subtitles_transcribe` is NOT silent either — third correction.**
      `generators/subtitles.ts` throws in 30+ places and computes completion from
      Audio Assembly's authoritative section manifest via
      `inspectSubtitleCompletion(..., { require_per_section: true })`, tracking
      `scopeComplete` / `episodeComplete`, failed slugs and stale sections. It
      explicitly documents "never trust 'the worker returned'". It needs no auditor.

      Its REAL gap is narrow and CONFIRMED — the merged-transcript skip at
      `subtitles.ts:294`:

        if (!effectiveForce && await fileExistsWithContent(outPath)) {
          const existing = normalizeSrtOrVtt(await fs.readFile(outPath, 'utf-8'))
          if (existing.cues > 0) { … result = { …, complete: true }; return }
        }

      Three problems, in order of harm:
        1. **No staleness check.** The per-chapter path at `:540` consults
           `staleSections`; this one does not. Re-run Audio, then Retry
           transcription, and the existing SRT is blessed as current.
        2. **`cues > 0` is not coverage.** One cue over a 40-minute episode passes.
        3. **It short-circuits BEFORE the stitch**, so a run that failed at
           `:113` ("Subtitle stitch did not complete … Retry the local subtitle
           stitch before Scene Plan") is "repaired" by Retry taking this skip path
           — the Retry cannot repair the failure its own error named.
      **FIXED (v1.4.189) for problems 1 and 2.** The decision is extracted as
      `existingTranscriptIsCurrent()` in `subtitles.ts` — testable without driving
      the generator — and now consults `inspectSubtitleSourceFreshness`, the same
      authority the per-chapter path uses. `cues > 0` remains as the floor.
      4 tests in `subtitle-transcript-skip.test.ts`, driving the freshness
      authority's legacy mtime branch: audio older than the transcript → skip;
      audio NEWER → regenerate and name the changed sections; no cues → no skip;
      unreadable → no skip. `--only subtitle` is 352 pass / 0 fail.
      The key case WOULD have failed before: the old predicate had no staleness
      input at all, so it returned skip for that exact fixture.

      **Problem 3, the stitch — DESIGN WORKED OUT (round 25), not yet applied.**

      The shape, verified by reading the flow:

        :110  requireWrittenSubtitleStitch(outcome)  throws
              "Subtitle stitch did not complete: … Retry the local subtitle stitch
               before Scene Plan."
        :294  the skip path returns EARLY — before the stitch
        :884  ensureStitchedSubtitle({ episodeDir, subtitlesDir, mergedAudioDir,
                                     audioDir, episodeCode })
              returns status 'stitched' | 'fresh' | … — **'fresh' already means
              "the existing stitch is current"**, so that function owns the
              freshness decision.
        :895  if the status is neither, requireWrittenSubtitleStitch throws

      So a job that fails the stitch is told to "Retry the local subtitle stitch",
      and Retry then takes the :294 skip path and returns before ever reaching
      :884. **Retry cannot perform the repair its own error names.**

      THE FIX: route the skip path through `ensureStitchedSubtitle` too, then
      `requireWrittenSubtitleStitch`. It is the same call the full path makes,
      it returns 'fresh' when nothing needs doing, and it makes a Retry actually
      stitch. Do NOT simply refuse to skip when the stitch is absent — falling
      through would RE-TRANSCRIBE, which costs money to repair a local file.

      STATUS (round 27) — **DONE, v1.4.191.**

      The wiring is applied: the skip path resolves its own episode paths and
      awaits `stitchAndVerifyTranscript` before returning.

      The fixture that was blocking this turned out to be cheap, because the
      skip path makes **no provider calls** — it needs disk state only. The
      existing `createScopedSubtitleFixture` in `subtitles-retranscribe.test.ts`
      already satisfies `requireAudioAssemblyReady` (chapter audio + a
      `duration_s > 0` timeline manifest + merged audio), so the new tests reuse
      it with `per_chapter: false`, which is the one lever no prior test pulled.

      Two tests, appended to `subtitles-retranscribe.test.ts`:
      (1) a current whole-track transcript with per-chapter SRTs present and no
      stitched file → `${code}_stitched.srt` exists after the run, `skipped` is
      still true, and `providerSubmissionCount('transcription') === 0`;
      (2) a second run does not rebuild a current stitch (mtime unchanged).

      Making the transcript count as current needed the audio byte identity, so
      the fixture writes `.subtitle-recovery.json` with a real
      `hashSubtitleAudioSources` result per chapter. That is deliberate — a
      fixture that skips because freshness was never consulted would not test
      the branch it claims to.

      PROVEN, not assumed: both tests **failed before the wiring with `ENOENT`
      on the stitched file** — the defect reproduced exactly — and pass after.
      `--only subtitle` is 354/354 (31 suites).

      **One case this deliberately does NOT decide.** `ensureStitchedSubtitle`
      returns `'not-applicable'` when no per-chapter transcript matches any audio
      section, and `requireWrittenSubtitleStitch` treats that as a failure. So an
      episode carrying ONLY a whole-track transcript now fails loudly where it
      previously reported `skipped, complete: true`. That is the honest answer if
      the stitched timeline is genuinely required, and a regression if a
      whole-track transcript is a legitimate finished state. `inspectSubtitleSourceFreshness`
      comments that "an intentional whole-track has no per-section source to
      stale", which suggests the latter — so this is an OWNER DECISION, recorded
      below rather than guessed at.

      **`broll_normalize` ALSO shrinks — it already fails loudly.** `normalizeBroll`
      throws for a missing pool/filename, an offline pool ("plug in the SSD"),
      a missing source clip, and — the one that matters — a missing or EMPTY
      output: `if (!stat.isFile() || stat.size <= 0) throw new Error('Normalized
      clip is empty')`. So it proves non-emptiness; it does not need an auditor to
      stop reporting done over a MISSING file.

      Its only real gap is narrower than the audit implied: a non-empty but
      UNPLAYABLE encode would pass, and it declares nothing structurally. The repo
      already has `assertPlayableSceneClip` (used by the scene-clip auditors) if
      that is judged worth adding. NOT a group-1 correctness hole.

      **CONCLUSION FOR 1.1b: there is no remaining "reports done over missing
      output" generator among the types the audit named.** All three it called
      silent either proved their output already (`broll_normalize`), proved it
      through a manifest (`subtitles`), or are now fixed (`broll_assemble`). The
      audit's central claim for this group was overstated; the enumeration found
      the real gap, which was one skip path in `subtitles.ts`.

      WHAT REMAINS IN 1.1b is therefore only the per-file judgement pass over the
      eleven types that DO declare completion — is each declaration covering its
      whole success path, or only one branch? That is the check that could still
      find a real hole, and it is reading work, not auditor writing.

      **PER-FILE PASS DONE (round 23) — result below.**

      Every `requireJobCompletion` in the eleven, by the shape of its numbers:

      | file | declaration | verdict |
      |---|---|---|
      | `audio-merge.ts:1134` | `finalBytes > 0 && finalDuration > 0` | real |
      | `music-generate.ts:308` | `planned.length - failures.length` | real |
      | `metadata.ts:658` | `expected - missing.length` | real, but self-referential (below) |
      | `image-prompts.ts:680` | `count - missing.length` | real |
      | `youtube-upload.ts:499` | `expected: 1, completed: 0` | **false alarm** — inside `if (identityErrors.length)`, always throws with `invalid` |
      | `youtube-upload.ts:570` | `sidecarErrors.length ? 0 : 1` | real |
      | `youtube-playlist-update.ts:91` | `expected: 0, completed: 0` | deliberate opt-out (0/0 passes by design) |
      | `youtube-playlist-update.ts:193` | `checkpointErrors.length ? 0 : 1` | real |
      | `youtube-thumbnail-refresh.ts:235` | **`expected: 1, completed: 1`** | **TAUTOLOGY — NOT in the audit** |
      | `youtube-thumbnail-refresh.ts:335` | `targets.length` / `durable.size` | real |
      | `music-video.ts:150` | `stat?.isFile() && stat.size > 0` | real |
      | `video.ts:187` | `valid ? 1 : 0` | real |
      | `images.ts:1677` | `expectedItems.length - missing.length` | real |
      | `contextual-cues.ts:578` | **`expected: 1, completed: 1`** | **TAUTOLOGY — the audit flagged this one** |

      - [ ] **FIX `contextual-cues.ts:578`.** `{ expected: 1, completed: 1 }` asserts
            nothing. The surrounding code validates with
            `validateContextualCueTimeline` and writes the timeline, so the artifact
            exists — but the declaration must come from READING IT BACK, per §8
            ("a generator returning without throwing is not evidence"). The audit's
            case: `parseCandidates` returning `[]` for every batch saves a 0-cue
            timeline that is then certified as a verified proposal. Decide whether
            0 cues is a legitimate outcome for this product before choosing between
            `completed: written.length ? 1 : 0` (fails an empty proposal) and
            recording the count while passing. **That is a product question, not a
            mechanical one** — ask rather than guess.
      - [x] **FIXED `youtube-thumbnail-refresh.ts:235` (v1.4.190).** The tautology
            is replaced by `thumbnailUpdateWasRecorded()`, which READS THE
            OPERATION RECORD BACK and requires a `thumbnail_update` action in state
            `succeeded`. Extracted so it is testable without uploading to YouTube.
            4 tests in `thumbnail-update-recorded.test.ts`: succeeded action →
            recorded; no action → NOT; a `failed` action → NOT; unknown operation →
            NOT and does not throw. `--only youtube --only thumbnail` is 610 pass /
            0 fail.
            My first version of the test failed 3 of 4 for a SETUP reason, not a
            predicate one: each test created a new project and re-assigned the same
            channel, which 409s ("already assigned to another project"). The project
            is now created once and each test gets a fresh operation.
      - [ ] `metadata.ts:658` — `completed: expected - missing.length` where the
            audit notes the expected counts come from the same in-memory arrays
            being checked (self-referential). Lower priority: the numbers are
            computed, just not independently sourced.
      **Not yet located:** `images_repair`, `expression_markup` — neither is a
      `generators/*.ts` file, so they are handled elsewhere; find them before
      concluding anything.

      `hasUsableMergedAudio` (`services/audio-workflow-readiness.ts:50`) is a
      SEPARATE finding and still open: it accepts ANY audio file with size > 0 in
      the merge folder, rather than the expected
      `_merged_audio(_v\d+)?.mp3` that `lib/intro-lead-in.ts:161` already matches.
      It is what gates paid transcription, so a superseded take reads as ready.
      That belongs to group 1, not to 1.1b.

- [ ] **(1b-original-note)** Write auditors for the 13 artifact-producing types above, starting
      with the four that cost or lose the most: `broll_assemble` (truncated
      video), `audio_merge` (transcription on a stale mix), `youtube_upload`
      (claims success over a failed upload), `music_generate` (unmeasurable
      tracks counted complete).

      **1.1a IS DONE AND GATE-VERIFIED (v1.4.187, commit `ebaf4e97`).** Full gate
      5383/5383, 476/476 files, 0 fail. Read the design notes below before
      starting 1.1b — an auditor written to the wrong contract will fail the
      once-only tests.

      **THE AUDITOR CONTRACT** (from `auditScenePlanOutput`, the cleanest
      example, `boot/executors.ts`):

        export async function auditX(job: any): Promise<'complete' | 'repair-required'> {
          const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
          … read the authoritative artifacts off disk, name what is missing …
        }

      Registered with `registerJobCancellationAuditor(type, auditX)` in
      `boot/executors.ts`, inside the same block as the existing 11. It takes
      `job: any` and must RE-DERIVE everything from disk — it may not trust
      anything on the job except `project_slug`, `episode_id`, `title` and
      `params`. It returns a verdict; it throws only on programmer error
      (`registerJobCancellationAuditor` converts a throw into
      `repair-required`).

      **Do NOT add a completion call to the generator.** 1.1a already runs the
      auditor on the local completion path for any type that has one. Registering
      the auditor is the whole fix — that is the point of having centralised it.

      **`broll_assemble` — the design, worked out and ready to write:**
        - the selection sidecar (`services/broll-selection-sidecar.ts`
          `getSelectionSidecar(project_slug, episode_id, title)`) carries
          `target_duration: number` — the narration length the selection must
          cover — and `selection[]`, each with its own `target_duration`.
        - the assembled file is the one the generator writes at
          `broll-assemble.ts:165` (`outPath`) and renames into at `:467`.
        - VERDICT: `repair-required` when the summed selection is materially short
          of `target_duration` (the generator encodes `-shortest`, so the video
          ends at the last clip while narration continues — the failure is a
          video that cuts off mid-sentence), or when the assembled file is
          missing/zero-length/undecodable.
        - ALSO fix the generator's own reporting: `broll-assemble.ts:409-471` has
          no `requireJobCompletion` at all, so even with the auditor the job's own
          declaration is silent. Prefer the auditor alone if the generator's
          params make a positive declaration awkward — 1.1a covers it either way.
        - Tests, written FIRST: a short selection must be `repair-required`; a
          complete one `complete`; a legacy sidecar with no `target_duration`
          must not be failed for missing data it never carried.
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

- [ ] **ROUND 29 — TRACED. The plan's own prescription is WRONG; do not apply
      it.** Two separate questions were bundled here, and they have different
      answers.

      **What is true.** `video-claims.json` is the only cross-project store
      (`services/youtube-operation-store.ts:177`, global under userDataDir),
      keyed `(channel_id, video_id)` with an owner of
      `(project_slug, operation_id)` — **it carries no episode code**. Everything
      admission asks (`routes/youtube-upload-center.ts:2218`) goes through
      `remoteVideoFor`, whose every branch reads *this* project's operation
      records and *this* project's publishing state. So project B cannot see
      project A's upload of the same episode code. That part of the finding is
      correct.

      **"Let `completeYouTubeOperation` conflict fail the job loudly" is
      wrong, and would be a regression.** That call sits in
      `generators/youtube-upload.ts:506-520`, *after* YouTube has accepted the
      bytes and returned a permanent video id. The existing comment says exactly
      why the failure is downgraded to a warning: the video is already uploaded,
      so failing the job invites a retry that **uploads it a second time** —
      spending quota to duplicate a video that is already live. AGENTS.md §8
      demands the opposite: preserve valid partial output and make Retry repair
      *without repeating completed work*. The warning is the correct behaviour,
      and a loud failure here would be a worse defect than the one it claims to
      fix.

      **The real fix needs a decision, because it changes what users may do.**
      Admission cannot ask "has any project already uploaded this channel +
      episode code?" while the claim has no episode code. Adding one (schema v2
      plus a v1 migration that reads old claims as "episode unknown") makes the
      question answerable — but the answer then **refuses to upload an episode
      code that another project has already used on that channel**. Two
      different series legitimately sharing one channel, each with its own
      "Episode 1", would be blocked. That is a product decision, not a code
      decision → recorded below as an owner decision.

      Until it is answered, **the safe change is not to change this**, and the
      existing warning must stay a warning.

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

      **ROUND 29 — CONFIRMED as a §4 leak, but NOT a clear-cut fix; both
      available answers have a real cost, so this is an owner decision.**

      The defect is real and I traced the damage: the borrowed model is turned
      into `requestBudget` via `resolveTtsRequestBudget`, and `requestBudget`
      decides how the section is split (`splitGenStudioApiRequests`) and
      therefore **which `_partN.mp3` filenames this episode is expected to
      have**. So the failure mode is a wrong number, not a crash: episode A
      generates under a model with a 3,000-character boundary, the customer
      switches to a model with a 6,000 boundary, episode B's own job has aged
      out, B borrows A's model id, predicts `_part1/_part2` for a section that
      the new model renders as one file — and B reports missing parts that were
      never supposed to exist. Nothing announces it.

      I did **not** simply delete `|| audioJobs[0]`, because the honest
      replacement is a regression. There is **no per-episode record of the TTS
      model** — I looked; `audio_chapters.json` does not carry one and the audio
      generator persists no model field, so "resolve it from this episode's own
      artifacts" is not available. The only two options are:

      (a) **Borrow (today).** May be wrong after a model change, and is wrong
          silently.
      (b) **Blank it.** Falls into the `requestBudget === undefined` path at
          `:182-193`, which expects the section as **one request**. That is
          honest, but for an episode whose files genuinely are `_part1/_part2`
          it predicts the wrong filenames and reports **false missing parts** —
          trading a silent wrong number for a loud wrong answer.

      Neither is derivable, which is exactly the condition AGENTS.md §4 gives
      for escalating rather than ruling from the code. The design that would
      actually settle it is to make the model derivable — record the TTS model
      id (and the boundary it implied) in the episode's own audio sidecar at
      generation time, then resolve from that, falling back to (b) only when the
      sidecar predates the change. That is the recommendation, and it is a
      schema addition plus a migration, so it wants the owner's go-ahead →
      recorded below.
- [ ] `image-prompts.vue:1398` — episode-scoped cast ids persist in a
      project-only blob and are submitted for the new episode.
- [x] **DONE, v1.4.195.** `broll.vue:922` — the `form.episode_id` watcher cleared
      the in-flight upload path and the whisper flag but not `manualSelection`
      (an ordered list of `{filename, target_duration}` chosen for one episode)
      nor `narrationTargetSec` (that episode's measured narration length). A new
      episode opened with the previous episode's clips queued and would have
      assembled them. Now cleared, with the pool filter too.
- [x] **DONE, v1.4.195.** `scene-review.vue:1035` — the `[slug, episodeId]`
      watcher reset the render limit and the in-flight ids but left `previewScene`
      (a whole `ReviewScene` from the episode being left) and `selectedIds` (a Set
      of its scene ids). The lightbox URL is rebuilt from the CURRENT episodeId
      with the OLD scene id, so it either 404s or shows another episode's image,
      and a batch action would name scenes outside the open episode. Both now
      cleared in the watcher.

      Tests: `frontend/__tests__/episodeScopedStateReset.test.ts` (2, new file),
      one per page, following the lane's static-analysis convention.
      **Proven red:** reverting both watcher additions fails exactly these two
      and leaves the other 1,832 green. Frontend lane 1,834/1,834, 199/199 files.
      Stated limit: static analysis proves the reset is wired, not that the DOM
      clears — that needs a screenshot (AGENTS.md §3).
- [ ] `images.vue:1411` — integrity status + Browse grid not blanked.
- [ ] `research.vue:1207` — stale research durable on a failed read, and PUT to
      the new episode.
- [x] **2 of 3 DONE, v1.4.194.** `character-sheet.vue:534` was already correct
      (its watcher blanks `masterExists`/`compositionExists` and bumps the
      version counters). The other two were real:

      - `motion-review.vue:886` — `loadReview` replaced `scenes`, `stats`,
        `motionScope`, `motionSceneIds`, `motionCrossingSceneIds` only on
        success, so an episode change showed the previous episode's scenes for
        the whole load and permanently after a failure. It also bumped
        `cacheBuster` only on success, so every `.../image/${scene.id}?t=` URL
        kept resolving to the PREVIOUS episode's cached thumbnails at the
        previous episode's ids — the audit did not mention that part. Fixed with
        `resetEpisodeScopedMotionState()`, called from the `episodeId` watcher;
        `loadReview`'s empty-episode branch now calls it too instead of
        duplicating it.
      - `metadata.vue:279` — `finalizationStatus` was replaced only on success,
        and `finalizerGateReason` answers from it, so the YouTube Finalizer
        reported the previous episode's readiness between the change and the new
        load, and indefinitely after a failed one. Now blanked in the
        `[slug, episodeId]` watcher, with `finalizationLoadSequence++` so a
        response already in flight for the closed episode is discarded (the
        loader already guards on that sequence, so this is the missing half).

      Tests: one each in `motionReview.test.ts` and
      `youtubeFinalizerWorkflow.test.ts`, following the lane's convention of
      static analysis over the `.vue` source. **Proven red:** reverting each
      watcher fails its own test with the expected assertion and leaves the rest
      green. Frontend lane 1,832/1,832, 198/198 files.
- [x] **DONE, v1.4.192.** The ownership-by-prefix matcher. There were **FIVE**
      sites, not four — the plan's list was wrong twice: `folder-resolver.ts`
      does exist (at `electron/server/lib/folder-resolver.ts:132`, missed by a
      first grep because it reads `codeUpper`, not `code`), and
      `asset-status.ts:660` was listed as a sixth but is an exact-equality match
      and not in this class.

      All five now call one exported predicate,
      `episodeDirNameMatchesCode(dirName, code)` in `services/asset-status.ts`
      (exact code, or `code + " - "`, after `stripDecorativePrefix`):
      `asset-status.ts` index `:393` and search `:409`,
      `manifest-audit.ts:126`, `audio-merge.ts:127`, `folder-resolver.ts:133`.

      **A SIXTH, worse site was found while sweeping:**
      `services/episode-media-cleanup.ts:369` — and it was the only one on a
      destructive path. That gate decides whether a media root may be
      ENUMERATED FOR DELETION; a bare prefix there meant `EP0001`'s cleanup
      could accept an `EP00012 - ...` ancestor. It is now on the same predicate.
      **Caveat, stated plainly:** I could not build a test that reaches the
      collision, and my first attempt proved the premise wrong in a useful way —
      the guard's owner segment is the *app-generated* episode folder, so it
      always carries the real code and the mismatch is unreachable by
      construction. **This change is therefore defensive hardening, not a fix
      for a reachable data-loss bug**, and I have not claimed otherwise. It can
      only make the guard stricter, so it cannot cause a deletion.

      Tests: `electron/server/__tests__/episode-dir-prefix-ownership.test.ts`
      (6). Three cover the rule; three drive the two `asset-status` sites
      end-to-end — the uncached `search` and the cached in-memory tree index —
      with a fixture whose ONLY folder is `EP00012 - Impostor`. **Proven red:**
      against the old bare-prefix rule exactly the 3 collision tests fail, at
      both sites, while the "a real folder is still found" tests keep passing.
      The other three sites share the same predicate, so they are covered by
      construction rather than by their own fixtures — recorded as a known
      limit, not glossed.

      The misleading comment at `services/utils.ts:118-130` was rewritten in the
      same change: it described the rule as a prefix test and cited the
      `EP0001`/`EP00012` example as the reason the index must stay ordered. The
      ordered-not-Map argument still holds (first hit in traversal order decides
      *which* folder wins when a project holds duplicates), so that part was kept.

      **ROUND 27 — SETTLED BY MEASUREMENT.** Reading 1 was right, but only
      incidentally, and the strict rule is safe to apply mechanically.

      Enumerated every episode folder in the live library
      (`find <projects> -maxdepth 5 -type d -name 'EP*'`, 4,971 distinct names):

      - **4,971 of 4,971 contain ` - `** — the count of names *without* it is
        exactly 0. So `code` or `` `${code} - ` `` matches every real folder;
        reading 2's worry (a hand-renamed folder with no separator) is not
        present in the data.
      - **All 4,971 code prefixes are 6 characters** (`EP` + 4 digits) — one
        distinct length, `uniq -c` = 4971/6.
      - Duplicate code prefixes (EP0001 in several projects) are expected and
        irrelevant: matching is always scoped to one project, and within a
        project `episode_digits` is uniform, so a 6-char code can never be a
        strict prefix of another 6-char code. **The `EP0001`/`EP00012` collision
        the utils.ts comment warns about cannot occur once all codes are the
        same width — it is currently prevented by the data, not by the code.**

      That is the argument for changing it: the prefix test is safe today only
      because every project happens to use fixed-width codes. It is one
      `episode_digits` change away from matching the wrong episode, and the
      strict rule costs nothing now.

      **When applying:** fix ALL copies in one change (a partial fix is worse
      than none — it looks done), accept exact `code` as well as
      `` `${code} - ` ``, and **rewrite the `utils.ts:118-127` comment in the same
      commit**, because it currently instructs a future reader to preserve the
      exact behaviour being removed. Then re-run the same `find` as the
      regression check: every distinct folder name must satisfy the new
      predicate. `storage-audit.ts:114` stays as it is — `isPerSceneClipName`
      matches `{code}_Scene01` file names and needs the bare prefix.

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
- [x] **DONE, v1.4.193.** `subtitle-completion.ts:189` — a failed `stat` became
      mtime 0 = "not stale". **The finding was right and understated: there were
      TWO routes, not one.** The reported one was the legacy mtime branch
      (`stat?.mtimeMs || 0`, where a missing file yields 0, which is never newer
      than the SRT). The second is the byte-identity branch directly above it:
      `if (currentHash && savedHash !== currentHash)` — `hashSubtitleAudioSources`
      returns `null` for "I could not read the audio", and `null && …` is falsy,
      so an unreadable source was folded into "the bytes are unchanged".
      **Both made a deleted narration file read as a CURRENT transcript.**

      Fixed both: an unmeasurable hash is stale, and a failed `stat` on any
      source file is stale. Tests in `subtitle-transcript-skip.test.ts` (now 6),
      one per branch. **Proven red:** with the old expressions restored, both
      fail; the other four keep passing. `--only subtitle` 356/356.
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
4. **Is a whole-track-only subtitle state legitimate?** (raised round 27.)
   `ensureStitchedSubtitle` reports `not-applicable` when no per-chapter
   transcript matches an audio section, and the completion contract treats that
   as failure. So an episode whose ONLY transcript is `${code}_whisper.srt` now
   fails loudly instead of reporting `skipped, complete: true`. If the merged
   transcript is a legitimate finished state that never needs `_stitched.srt`,
   this is a regression and the check needs to accept it; if Scene Plan always
   needs the stitched timeline, the new failure is correct. Our own
   `inspectSubtitleSourceFreshness` comment ("an intentional whole-track has no
   per-section source to stale") hints the former, which is why I am not ruling
   on it from the code.
5. **`ttl-cache.ts`** — delete the module and its test?
6. **Four chat models publish `max_output_tokens: null`** — grey them out, or
   leave selectable and fail at submit?

7. **Cross-project duplicate upload** (Group 1.3, round 29). Should an upload be
   refused when *another project* has already used this episode code on the same
   YouTube channel? Saying yes is the plan's finding, and needs an `episode_code`
   field added to `video-claims.json` (schema v2 + migration). Saying yes also
   blocks two different series that legitimately share one channel and both have
   an "Episode 1". I have deliberately NOT changed this, and I have deliberately
   NOT made the post-upload bookkeeping conflict fail loudly — see 1.3 for why
   that would invite a second upload of a video that is already live.
8. **The reconciler's borrowed TTS model** (Group 2, round 29). Today the audio
   reconciler takes the project's most recent audio job's model when this
   episode has no job of its own, which can predict the wrong `_partN` filenames
   after a model change. The honest alternatives are "borrow" (silently wrong
   after a model change) or "blank" (loudly wrong for genuinely multi-part
   episodes), and neither is derivable because no per-episode record of the TTS
   model exists. My recommendation is to add that record to the episode's own
   audio sidecar and resolve from it — a schema addition plus migration. Your
   call.

Everything else in this plan is unblocked and I will proceed unless told
otherwise.
