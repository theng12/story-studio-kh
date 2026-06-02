## Session 09 — Job Queue & Long-Running Operations

**Scope:** the in-process job runner that orchestrates everything expensive: script/intro/chapter LLM calls, image-prompt generation, scene + thumb image generation, AI-video (Veo/fal), TTS and merge, subtitles, video assembly (FFmpeg), and YouTube upload. Files audited: [electron/server/services/job-queue.ts](electron/server/services/job-queue.ts), [electron/server/routes/jobs.ts](electron/server/routes/jobs.ts), [electron/server/routes/pipeline.ts](electron/server/routes/pipeline.ts), every file under [electron/server/generators/](electron/server/generators/), the provider clients under [electron/server/lib/](electron/server/lib/) (kie-client, fal-client, elevenlabs-client, genaipro-veo-client, fal-video-client, kie-video-client, whisper-client, http-retry), plus [electron/main.ts](electron/main.ts) shutdown and [frontend/pages/projects/[slug]/jobs.vue](frontend/pages/projects/[slug]/jobs.vue).

The happy paths work: per-type FIFO queues, child-process tracking via `AsyncLocalStorage`, SIGTERM + 5 s SIGKILL escalation on cancel, persistence under `projects/<slug>/jobs.json` with atomic temp+rename and per-file mutex (Session 08 verified), duplicate-detection at enqueue time, live SSE updates, a pipeline chain hook that auto-steps through `script → image_prompts → images → audio → audio_merge → metadata → video_assembly`, and idempotent skip-when-done on batch reruns. Cancellation cleanly kills spawned FFmpeg.

**One-line verdict:** **the *process-side* controls are solid; the *money-side* and *unattended-operation* controls are not.** Cancelling a long job stops FFmpeg but does **not** abort in-flight provider HTTP (kie.ai image poll, fal/elevenlabs TTS, Veo/AI-video submit, LLM generate) — the job shows "cancelled" while the provider keeps working and keeps billing. A force-quit leaves FFmpeg children orphaned because `before-quit` only closes the HTTP server. `pollForResult` accepts an `isCancelled` hook that no caller wires up. There is no auto-retry — good, that matches Session 04's "no unbounded retry drain" posture — but also no batch-level summary, no OS notification when an overnight run settles, no disk-space precheck before a 10×1 GB video assembly. Two High, five Medium, three Low/informational findings below.

---

### Part A — Cancellation semantics

#### 1. Cancel does not abort provider HTTP — **High finding (H1)**

[job-queue.ts:548-574](electron/server/services/job-queue.ts:548) flips `status='cancelled'` and calls `killChildrenFor(jobId)` (which SIGTERMs every tracked child). Nothing aborts in-flight `fetch()` calls to AI providers. The banner the code writes to `output_lines` at [:569](electron/server/services/job-queue.ts:569) is honest — *"Cancelled by user (in-flight API calls may still complete)"* — but understates the exposure:

- **kie.ai image poll** ([kie-client.ts:155-263](electron/server/lib/kie-client.ts:155)) is a custom loop with `MAX_WAIT = 360_000` (6 minutes) and **no `isCancelled` probe of any kind**. A cancelled scene-image batch continues polling for up to 6 minutes per in-flight image, and the credits you've already paid keep resolving.
- **fal.ai TTS / image / video** ([fal-client.ts:100](electron/server/lib/fal-client.ts:100), [fal-video-client.ts:59](electron/server/lib/fal-video-client.ts:59)) goes through `pollForResult`, which *does* support `isCancelled` at [http-retry.ts:63,134](electron/server/lib/http-retry.ts:63) — but **no caller passes one**. The hook is dead code.
- **ElevenLabs direct TTS** ([elevenlabs-client.ts:42,72](electron/server/lib/elevenlabs-client.ts:42)) declares `opts.signal?: AbortSignal` on the public contract but the hot-path caller at [audio.ts:230-236](electron/server/generators/audio.ts:230) never constructs a controller or passes one. The 180 s timeout runs to completion on cancel.
- **GenAIPro Veo** ([genaipro-veo-client.ts:154](electron/server/lib/genaipro-veo-client.ts:154)) — no signal.
- **kie-video-client** ([kie-video-client.ts:62](electron/server/lib/kie-video-client.ts:62)) — same.
- **LLM (OpenAI / Anthropic) text calls** ([providers/text/openai.ts:32-80](electron/server/providers/text/openai.ts:32), [providers/text/anthropic.ts:27-75](electron/server/providers/text/anthropic.ts:27)) — no abort signal threaded. A long script generation (3–5 minute streaming response) can't be cut short; the streaming loop `for await (const chunk of stream)` never checks `isCancelled`.

Generators themselves *do* poll `isCancelled` at safe points between provider calls ([audio.ts:171,188,226,282](electron/server/generators/audio.ts:171), [ai-video.ts:198,214,280](electron/server/generators/ai-video.ts:198), [images.ts:296](electron/server/generators/images.ts:296), [episode.ts:339,350](electron/server/generators/episode.ts:339)), so the *next* request is skipped — but whatever is already in flight runs to completion and gets billed.

**The gold-standard reference exists in-tree**: [generators/subtitles.ts:66-89](electron/server/generators/subtitles.ts:66) creates an `AbortController`, fires `controller.abort()` from a 500 ms `setInterval` whenever `jq.isCancelled(job.job_id)` flips, passes `signal` to [whisper-client](electron/server/lib/whisper-client.ts), and clears the watcher in `finally`. This exact pattern should be applied to every provider client — especially the kie.ai image poll, which is the longest single in-flight call in the app.

**Why this matters for solo ops:** a panic-cancel on a runaway 50-image batch (e.g., wrong preset, wrong resolution) will show "cancelled" in the UI in under a second while the kie.ai poller continues fetching for ~6 minutes per image and every completed image is a billed credit. The user believes they stopped the bleed; they did not.

→ **Fix-task spawned: "Fix: thread AbortController through provider clients for job cancellation"**

#### 2. `http-retry`'s `isCancelled` hook is dead code — **Medium finding (M1)**

[http-retry.ts:60](electron/server/lib/http-retry.ts:60) `pollForResult<T>` accepts `opts.isCancelled?: () => boolean` and honours it at the top of each poll iteration ([:63](electron/server/lib/http-retry.ts:63)) and inside `sleepCancellable` at [:130-137](electron/server/lib/http-retry.ts:130). But the three production callers ([fal-client.ts:100](electron/server/lib/fal-client.ts:100), [fal-video-client.ts:59](electron/server/lib/fal-video-client.ts:59), [kie-video-client.ts:72](electron/server/lib/kie-video-client.ts:72)) pass no `isCancelled`, so a fal.ai TTS poll in a cancelled job keeps running the full 8-consecutive-failure budget with exponential backoff. Wiring `isCancelled: () => jq.isCancelled(job.job_id)` at every call site is a one-line-per-caller fix and closes half of H1 for the poll-based clients. (The kie.ai *image* client doesn't use `pollForResult` — it has its own loop and is a separate fix.)

→ Folded into the H1 fix-task (same audit change).

#### 3. Chain-next `DuplicateJobError` is swallowed — **Low finding (L1)**

[job-queue.ts:299-317](electron/server/services/job-queue.ts:299) wraps the chained `enqueue()` in `try/catch` and on throw appends a single `output_lines` entry: `Chain-next failed: ${e.message}`. The parent job still settles as `done`; the downstream chain is silently dropped. Concrete scenario: a user runs the batch pipeline, then manually starts `images` for the same episode mid-script-gen. When script-gen finishes, the chain tries to enqueue `image_prompts → images` and the `images` step throws `DuplicateJobError`. The batch banner at [jobs.vue:397-407](frontend/pages/projects/[slug]/jobs.vue:397) still shows "Pipeline finished." even though the chain broke. Low under personal-use — it's a real edge case — but worth a visible breadcrumb (e.g., `emitUpdate` with a `chain_broken` flag so the SSE stream surfaces it).

→ No fix-task spawned.

#### 4. Stale "running" in `jobs.json` on disk after app restart — **Low (informational)**

[job-queue.ts:228-234](electron/server/services/job-queue.ts:228) mutates `j.status = 'error'` with message *"Interrupted by app restart"* when `loadPersistedJobs` observes a `running`/`queued` job after a fresh start. The mutation is **in-memory only** — no `persistJob(j)` follow-up. On disk, `jobs.json` still says `status: 'running'` until the next write (triggered by a new enqueue or terminal transition). Cosmetic; the UI sees the corrected in-memory state through `getJobs` because the read path goes through `loadPersistedJobs` first. Cost: if the user inspects `jobs.json` manually from a support-bundle copy, the file lies. Nothing burns. Leave informational.

→ No fix-task spawned.

---

### Part B — Process lifecycle & orphaned work

#### 5. Orphan FFmpeg on app crash — **High finding (H2)**

The Electron shutdown handler is exactly two lines:

```ts
// electron/main.ts:287-289
electronApp.on('before-quit', () => {
  if (server) server.close()
})
```

Neither loop reaches `childrenByJob`, SIGTERMs any tracked children, nor awaits server drain. And this path only runs on a *clean* quit:

- **Force-quit (⌘Q held, or Activity Monitor "Force Quit") → SIGKILL to Electron.** Children get their PPID reparented to `launchd` (PID 1 on macOS) and continue running. They keep writing to the episode's output path, consume CPU, and in some FFmpeg configurations hold the output directory locked via `fcntl` advisory locks. On the next app launch, `loadPersistedJobs` marks the now-orphaned job as `error: 'Interrupted by app restart'` — but the FFmpeg child is still happily encoding to the same output file the user sees as "failed."
- **No PID-file persistence anywhere** in the codebase — children aren't written to disk, so even if next-launch code wanted to reap orphans, there's nothing to reap them by.

Concrete scenario for overnight runs: Mac loses power at 3 am mid-video-assembly. Battery dies. On wake, FFmpeg is gone (process tree cleared) but the partial output file is still on disk. The Session 07 audit flagged partial-file cleanup as blocker #1; this finding is its restart-path twin.

**Minimum fix:** promote `before-quit` to iterate `childrenByJob` and `proc.kill('SIGTERM')` each child with a 2-second SIGKILL fallback — same pattern as `killChildrenFor` at [job-queue.ts:57-71](electron/server/services/job-queue.ts:57). This handles clean quit. Force-quit is irreducibly unhandled at the Electron layer.

**Stronger fix (defence-in-depth):** on boot, scan for `ffmpeg` child processes whose parent is `launchd` and whose command line references any path under `PROJECTS_ROOT`. Kill them before any generator can race them. `ps -eo pid,ppid,command` + shell-free parse. Keeps the overnight-crash case from leaving a "silent double-writer" until the next quit.

→ **Fix-task spawned: "Fix: kill tracked FFmpeg children on Electron quit; reap orphans on boot"**

#### 6. ElevenLabs `pipeline()` has no error cleanup — **Medium finding (M2)**

[elevenlabs-client.ts:90-95](electron/server/lib/elevenlabs-client.ts:90):

```ts
export async function generateTtsToFile(text, apiKey, outPath, opts) {
  const resp = await callTts(text, apiKey, opts)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const out = createWriteStream(outPath)
  await pipeline(Readable.fromWeb(resp.body as any), out)
}
```

Every peer client that writes provider bytes to disk cleans up on error: [kie-client.ts:269-284](electron/server/lib/kie-client.ts:269), [fal-client.ts:146-156](electron/server/lib/fal-client.ts:146), [http-retry.ts:158-178](electron/server/lib/http-retry.ts:158), [whisper-client](electron/server/lib/whisper-client.ts). They wrap the `pipeline()` in `try/catch` and `rm` the partial file on throw — because the generator's skip-if-exists guard treats any non-empty MP3 as a valid cache hit. ElevenLabs is the one outlier. A network glitch mid-stream leaves a truncated MP3 at the final path; the retry sees `fileExistsWithContent` (checked at [audio.ts:201](electron/server/generators/audio.ts:201) and only rejects zero-byte files) and happily skips regeneration. Same silent-failure-presented-as-success class Session 04 §3 ranked worst.

→ **Fix-task spawned: "Fix: cleanup partial file on ElevenLabs pipeline() error"**

#### 7. No disk-space precheck — **Medium finding (M3)**

Grep for `statfs`, `diskusage`, `check-disk-space`, `freemem`, `checkFreeSpace` across app source returns only `node_modules` matches. Neither [generators/video.ts](electron/server/generators/video.ts), [generators/audio-merge.ts](electron/server/generators/audio-merge.ts), nor [routes/pipeline.ts](electron/server/routes/pipeline.ts) checks free space before starting. A batch of 20 video assemblies at 1080p / high-quality averages ~500 MB–1 GB each; running on a 50 GB-free disk mid-batch fails halfway, *after* burning hours of FFmpeg encode time on episodes that then can't write. FFmpeg's own ENOSPC error is cryptic (and Session 07 M6 flagged that the stderr tail persisted into `jobs.json` is 5 lines truncated).

The QA checklist ([qa-checklist.md:12](../docs/operations/qa-checklist.md:12)) documents "Confirm at least 5 GB free disk space" as manual operator discipline — but no code enforces it. Node 18+ has `fs.statfs` built in; a pre-start check that sums `(num_episodes × estimated_per_episode_bytes) + 20%` against `statfs` on `PROJECTS_ROOT` would cost one filesystem call per batch submission.

→ **Fix-task spawned: "Fix: precheck free disk space before batch / video assembly"**

#### 8. No auto-retry on failed jobs — **Informational**

On executor throw, [job-queue.ts:321-332](electron/server/services/job-queue.ts:321) stamps `status='error'` and the queue advances. No requeue, no backoff, no cap. This is the right shape for the personal-use threat model and explicitly matches Session 04 §3 row 4 (`provider retry drains wallet overnight`): **not having auto-retry is a feature.** Retries live one layer down, inside the provider clients, capped at 8 consecutive failures with exponential backoff at [http-retry.ts:15](electron/server/lib/http-retry.ts:15) and [kie-client.ts:19](electron/server/lib/kie-client.ts:19). The YouTube chunk upload retries independently with `MAX_RETRIES_PER_CHUNK = 5` at [youtube-client.ts:184](electron/server/lib/youtube-client.ts:184). Confirmed design, no finding.

---

### Part C — Concurrency, ordering, and collision

#### 9. Concurrency within a type is effectively 1 — **Informational**

[job-queue.ts:153-177](electron/server/services/job-queue.ts:153) models each type as `{ pending: [], running: boolean, executor }`. Only one job per type runs at a time across *the entire app* (all projects), because the `queues` Record is module-scoped. With 16 types, the maximum concurrent running jobs is 16 — and in practice, a single pipeline batch uses 4–6 types serially so wall-clock concurrency is 1–2. This matches provider rate limits (ElevenLabs Starter caps at ~3 concurrent requests; kie.ai image rate-limits at the account level) and sidesteps most output-collision concerns.

**Duplicate-detection key** is `(project_slug, episode_id, type)` ([:364-372](electron/server/services/job-queue.ts:364)). Two episodes of the same type coexist in the queue (runs serially); two projects of the same type coexist (runs serially across projects). No collision risk was found in output paths — [audio-merge.ts:335](electron/server/generators/audio-merge.ts:335) uses per-episode temp directories, video outputs under [video.ts](electron/server/generators/video.ts) include the episode code in every filename. **No finding.** If a future change ever raises per-type concurrency past 1, this analysis needs redoing — leave a comment at the queue declaration pointing that out.

#### 10. Pipeline chain hands off only on `done` — **Informational**

Confirmed at [job-queue.ts:295-319](electron/server/services/job-queue.ts:295): chain-next fires only when the executor returned without throw *and* the job wasn't cancelled mid-flight (status transitions `running → done`). Failures halt the chain. Cancellations halt the chain. Duplicate at chain-next is the L1 above. **No finding beyond L1.**

---

### Part D — Unattended / overnight operation

#### 11. No OS notification on job or batch completion — **Medium finding (M4)**

Grep for `Notification|showNotification|new Notification` under [electron/](electron/) and [frontend/](frontend/) returns zero non-vendor matches. Electron's `new Notification()` is never constructed. The web `Notification` API isn't used either. An overnight pipeline batch completes in total silence — the user must walk back to the machine and check the app. For the personal-use deployment model where the operator uses the machine like a render farm overnight, this is the opposite of what the workflow needs.

The primitives are already in place: the queue emits a terminal event for every job at [job-queue.ts:85-97](electron/server/services/job-queue.ts:85), and the renderer already computes a "bulk finished" derived state at [jobs.vue:397-407](frontend/pages/projects/[slug]/jobs.vue:397). An Electron-side listener that subscribes to the same event bus and calls `new Notification({ title: 'Pipeline finished', body: '8 of 10 episodes succeeded. 2 failed — click to review.' })` would close the loop with maybe 40 lines of code. macOS `Notification.isSupported()` returns true by default; no permission prompt beyond the first invocation.

→ **Fix-task spawned: "Fix: OS notification on batch completion"**

#### 12. Batch "what happened while I was away" summary is thin — **Medium finding (M5)**

[jobs.vue:31-47](frontend/pages/projects/[slug]/jobs.vue:31) is the only batch-level surface — a single banner:

> ✅ **Pipeline finished.** Some outputs may need repair — the Assets tab shows what's missing and one-click fixes provider-completed jobs that didn't persist locally. [Open Assets →]

It shows nothing about: how many of the N submitted episodes succeeded, how many failed, the dominant failure reason (rate-limit, timeout, quota exceeded, disk full), wall-clock elapsed, total spend. The `pipeline_batch_id` is stored on every job ([pipeline.ts:443-444](electron/server/routes/pipeline.ts:443)) so an aggregate is one filter-and-reduce away. The renderer has `batchJobs` in scope at [:403](frontend/pages/projects/[slug]/jobs.vue:403) — extending the banner to display `{success}/{total} succeeded, {failed} failed` plus a `<details>` with the failure reasons would be a one-screen UI change. Matches Session 04 §3 row 7's "silent failure presented as success" bullet at the batch granularity.

→ **Fix-task spawned: "Fix: batch completion summary with success/fail counts"**

---

### Part E — Verified safe

- **Duplicate detection is atomic** — `isDuplicate` + `jobs.set` + `queues[type].pending.push` happen in the same synchronous tick at [job-queue.ts:464-499](electron/server/services/job-queue.ts:464). No check-then-act race.
- **Per-path mutex on `jobs.json`** — `withLock` at [:194-215](electron/server/services/job-queue.ts:194) correctly serialises concurrent `persistJob` calls. Write is `writeJsonAtomic` (temp+rename). Matches Session 08 atomic-store tier.
- **Timer leaks** — every `setInterval` in the queue / generator code either `.unref()`s (live-output flush at [:110-114](electron/server/services/job-queue.ts:110)) or clears in `finally` (subtitles cancel watcher at [subtitles.ts:87-89](electron/server/generators/subtitles.ts:87), audio-merge watchdog at [audio-merge.ts:62-70](electron/server/generators/audio-merge.ts:62), video watchdog at [video.ts:2158-2161](electron/server/generators/video.ts:2158)).
- **Stream cleanup** — every `createWriteStream` pairing in provider clients (except M2 above) uses `pipeline()` from `stream/promises` and `rm`s the partial file in `catch`.
- **`jobEvents` listener hygiene** — `setMaxListeners(50)` at [:83](electron/server/services/job-queue.ts:83), explicit `off('update', …)` / `off('cleared', …)` in SSE `req.close` at [jobs.ts:76-80](electron/server/routes/jobs.ts:76).
- **`before-quit` server.close** — HTTP server drains (even if children don't) at [main.ts:287-289](electron/main.ts:287).
- **SIGKILL escalation exists** — 5-second fallback at [:64-70](electron/server/services/job-queue.ts:64) for FFmpeg ignoring SIGTERM (stuck in syscall).

### Part F — Test coverage gaps

[`__tests__/job-queue.test.ts`](electron/server/__tests__/job-queue.test.ts) covers enqueue, dedupe-in-flight, queue stats, cancel-queued, persistence restart-recovery ("Interrupted by app restart"), and account attribution. [`__tests__/job-cancel.test.ts`](electron/server/__tests__/job-cancel.test.ts) covers `trackChild` SIGTERM delivery, cancel-final-status, SSE update emission, `DuplicateJobError` 409, and `isCancelled` Set tracking.

Not covered — each of these corresponds to a finding above:

- H1: provider HTTP abort on cancel (only subtitles has the wiring; no test asserts it).
- M1: `http-retry.pollForResult` honouring `isCancelled` from a real job context.
- L1: chain-next `DuplicateJobError` path.
- H2: FFmpeg orphan reaping on boot.
- 5-second SIGKILL fallback (no test).

---

### Summary table

| # | Severity | Issue | Evidence | Fix-task? |
|---|---|---|---|---|
| 1 | **High** | Cancel doesn't abort provider HTTP (kie poll, LLM stream, fal, ElevenLabs, Veo). Cancelled jobs still burn provider credits for up to 6 minutes. | [job-queue.ts:569](electron/server/services/job-queue.ts:569), [kie-client.ts:155-263](electron/server/lib/kie-client.ts:155), [audio.ts:230-236](electron/server/generators/audio.ts:230), [providers/text/openai.ts:42-57](electron/server/providers/text/openai.ts:42) | **Spawned** |
| 2 | Medium | `pollForResult`'s `isCancelled` hook is declared but no caller wires it. | [http-retry.ts:60-106](electron/server/lib/http-retry.ts:60), [fal-client.ts:100](electron/server/lib/fal-client.ts:100), [kie-video-client.ts:72](electron/server/lib/kie-video-client.ts:72) | (folded into H1) |
| 3 | Low | Chained `DuplicateJobError` swallowed into a single `output_lines` entry; batch banner still shows "finished". | [job-queue.ts:299-317](electron/server/services/job-queue.ts:299) | — |
| 4 | Info | Stale `status: 'running'` persists on disk after restart until next write. | [job-queue.ts:228-234](electron/server/services/job-queue.ts:228) | — |
| 5 | **High** | Orphan FFmpeg on Electron crash/force-quit. `before-quit` closes server but doesn't SIGTERM `childrenByJob`. No boot-time orphan reap. | [main.ts:287-289](electron/main.ts:287), [job-queue.ts:220-240](electron/server/services/job-queue.ts:220) | **Spawned** |
| 6 | Medium | ElevenLabs `generateTtsToFile` `pipeline()` has no error cleanup — leaves partial MP3 that the skip-if-exists guard treats as valid. | [elevenlabs-client.ts:85-95](electron/server/lib/elevenlabs-client.ts:85), [audio.ts:201](electron/server/generators/audio.ts:201) | **Spawned** |
| 7 | Medium | No pre-start disk-space check before batch / video assembly. 20×500 MB batch on a 10 GB-free disk fails halfway, burning hours. | (no code exists); [qa-checklist.md:12](../docs/operations/qa-checklist.md:12) | **Spawned** |
| 8 | Info | No auto-retry on failed jobs (matches Session 04 posture — leave as-is). | [job-queue.ts:321-332](electron/server/services/job-queue.ts:321) | — |
| 9 | Info | Per-type concurrency = 1 globally. No output-collision risk found. | [job-queue.ts:153-177](electron/server/services/job-queue.ts:153) | — |
| 10 | Info | Pipeline chain fires only on `running → done`; cancellations and failures halt the chain (correct). | [job-queue.ts:295-319](electron/server/services/job-queue.ts:295) | — |
| 11 | Medium | No OS notification on job or batch completion. Overnight runs finish silently. | (no matches) | **Spawned** |
| 12 | Medium | Batch "pipeline finished" banner has no success/fail counts or failure reasons. | [jobs.vue:31-47](frontend/pages/projects/[slug]/jobs.vue:31), [pipeline.ts:443-444](electron/server/routes/pipeline.ts:443) | **Spawned** |

**Blocker ranking for a fresh-machine overnight-batch deployment:**

1. H2 (orphan FFmpeg) — silent-double-writer on crash is the highest-cost corruption path.
2. H1 (cancel doesn't abort provider HTTP) — highest-cost money path; directly defeats the user's panic-cancel response.
3. M3 (disk-space precheck) — cheap fix, prevents the most common overnight-batch failure class on a laptop.
4. M4 + M5 (notification + batch summary) — together, they close the "wake up and know what happened" loop that's the whole point of running overnight batches.
5. M2 (ElevenLabs partial cleanup) — narrow but a real silent-failure path on flaky Wi-Fi.
6. L1 (chain-next dup), M1 (folded) — follow-ons to the larger H1 change.
