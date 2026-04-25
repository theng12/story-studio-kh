# Session 07 — FFmpeg & File-Path Safety

**Scope:** every `spawn()` call in [electron/server/](electron/server/) that launches `ffmpeg` / `ffprobe` / `xattr` / `which`/`where`, plus the path-construction code that feeds them. Files audited: [ffmpeg-utils.ts](electron/server/lib/ffmpeg-utils.ts), [ffmpeg-validation.ts](electron/server/lib/ffmpeg-validation.ts), [ffprobe-check.ts](electron/server/lib/ffprobe-check.ts), [ffmpeg-manager.ts](electron/server/services/ffmpeg-manager.ts), [generators/audio-merge.ts](electron/server/generators/audio-merge.ts), [generators/video.ts](electron/server/generators/video.ts) — plus the one-liner spawn in [routes/video.ts](electron/server/routes/video.ts) that imports through `ffmpeg-utils`.

The classic FFmpeg security story (shell injection, `system(ffmpeg ...)`) does not apply — every call passes `argv` as an array to `spawn()` with no `shell: true` anywhere in the tree (grep-verified). The hazards that remain are **robustness** concerns: AI- or user-sourced filenames with awkward bytes, partial outputs left on disk, missing watchdogs, and the "silent failure" class that Session 04 §6 ranked as blocker #1.

**One-line verdict:** **the pipeline is well-instrumented but under-bounded.** Stage-validation (`assertValidMedia`) catches broken intermediates, the tiered encode chain recovers from libx265 edge cases, and cancellation via `trackChild` + `SIGTERM` is wired everywhere. Missing: a wall-clock watchdog on the final encode, cleanup of the partial `outputFile` when all recovery tiers fail, defensive `file '...'` quoting against newlines in concat lists, and a persistent stderr log for the 5-line-truncated error tails that make it into `jobs.json`. Two High, four Medium, four Low/informational findings below.

---

## Part A — Argument safety & shell escape

### 1. No shell interpolation anywhere — ✓

Every `spawn()` call passes `argv` as an array: [ffmpeg-utils.ts:15](electron/server/lib/ffmpeg-utils.ts:15), [ffmpeg-utils.ts:53](electron/server/lib/ffmpeg-utils.ts:53), [ffmpeg-validation.ts:51](electron/server/lib/ffmpeg-validation.ts:51), [ffprobe-check.ts:41](electron/server/lib/ffprobe-check.ts:41), [audio-merge.ts:41](electron/server/generators/audio-merge.ts:41), [video.ts:2121](electron/server/generators/video.ts:2121), [ffmpeg-manager.ts:218,253,527,591,663](electron/server/services/ffmpeg-manager.ts:218). No `shell: true`, no string concat into a command line. A `'; rm -rf ~'` filename reaches FFmpeg's `open(2)` as-is and fails with "No such file or directory" — the correct behaviour.

The one extant defensive helper is `unescapeShellPath` at [audio-merge.ts:126](electron/server/generators/audio-merge.ts:126), which strips backslash-escapes the user pastes in from Terminal (`/foo\ bar/\(baz\).mp3`). That's there because `spawn()` sends argv literally — a backslash the shell would consume becomes a real byte in `open()`. It converts `foo\ bar` to `foo bar` before the path is passed along. Correct.

### 2. Path-prefix argument confusion — **Medium finding (M1)**

FFmpeg parses any positional argv element starting with `-` as an option, not a filename. This is the classic "file called `-rf`" gotcha. Examples that could bite under personal use:

- A dragged-in intro video literally named `-intro.mp4` — [video.ts:1117](electron/server/generators/video.ts:1117) passes `-i intro.video_path` with no normalization.
- A scene image at `{episode}/-cover.png` — [video.ts:1512](electron/server/generators/video.ts:1512) passes `-i lastSceneImagePath` similarly.
- An auto-resolved chapter path from disk scan ([audio-merge.ts:254-259](electron/server/generators/audio-merge.ts:254)) that happens to start with `-` after some manual rename.

The attack surface under the personal-use threat model is *robustness*, not "adversary crafts a filename" — but an AI-suggested title or a user-chosen intro name really can start with `-`.

**Two canonical fixes, pick one:**
1. Prefix every input path with `./` when it's relative, or replace a leading `-` with `./-` for absolute paths. Cheap, invisible to users.
2. Standardise on the `--` terminator where FFmpeg supports it (not universal — `-i` requires its value next, so `--` between `-i` and the path doesn't help; the `./` trick does).

Output paths — typically a `path.join(videoDir, ...)` or `path.join(tempDir, ...)` — are safer because the prefix directory is controlled by the app, but the same hardening belongs there for symmetry. The `resolveMergedOutputName` filename ([audio-merge.ts:155-171](electron/server/generators/audio-merge.ts:155)) derives from the episode code and can't start with `-` under the current `episode_id.toUpperCase()` convention, but that's a convention the code doesn't enforce.

→ No fix-task spawned (Medium, robustness).

### 3. Concat-demuxer newline injection — **Medium finding (M2)**

The concat demuxer (`-f concat`) treats each line of its list file as a directive: `file 'path'`, `duration 5`, `exact_stream_id 1`, etc. The quoting convention that Story Studio uses escapes single quotes:

```ts
// audio-merge.ts:116
function escPath(p: string): string {
  return `file '${p.replace(/'/g, "'\\''")}'`
}
```

— matched at [video.ts:1154](electron/server/generators/video.ts:1154), [video.ts:1205](electron/server/generators/video.ts:1205), [video.ts:1264](electron/server/generators/video.ts:1264).

**The escape handles quotes but not newlines.** A filename containing a literal `\n` (valid on macOS/Linux) or `\r` would break out of its `file '...'` envelope and inject a new directive on the next parsed line. Concrete scenario under personal use:

1. User renames a music file to `midnight\nvol 2.mp3` (copy-paste from a text editor accidentally includes a newline, or a script renames in bulk).
2. `escPath` produces: `file 'midnight\nvol 2.mp3'` — which the concat demuxer reads as two directives: `file 'midnight` and `vol 2.mp3'`.
3. Either the list parses with a garbled path (FFmpeg errors) or, in a worse shape, a directive the user didn't intend gets honoured.

This is **not a security finding under the personal-use model** (no adversary planting filenames), but it *is* a silent-failure class that matches Session 04's "worst class for solo ops" criteria (§3 row 7). The fix is narrow: reject any filename containing `\n`, `\r`, or `\0` at the `escPath` seam, with a clear error message pointing at the offending path.

Minor correctness note on the same escape: FFmpeg's concat-demuxer docs specify that the opening single quote must be followed by a backslash to escape *another* single quote, not the full `'\\''` bash idiom. The current implementation works because FFmpeg's parser is lenient, but it's not exactly what the docs call for. Low priority — leave as-is.

→ **Fix-task spawned: "Fix: reject newline/CR/NUL in concat-list filenames"**

### 4. Slug path-traversal via `..` — **Low finding (L1)**

[project-manager.ts:311-314](electron/server/services/project-manager.ts:311):

```ts
export async function getProject(slug: string): Promise<ProjectMeta | null> {
  const metaPath = path.join(PROJECTS_ROOT, slug, 'project.json')
  if (!existsSync(metaPath)) return null
  return await readJson(metaPath)
}
```

A URL-encoded `slug = '..'` resolves to `{PROJECTS_ROOT}/../project.json`. `slugify()` ([project-manager.ts:140](electron/server/services/project-manager.ts:140)) blocks this on *creation* (strips everything except `[\w\s-]`), but `getProject(slug)` and `getProjectDir(slug)` don't re-validate. If a `project.json` happens to sit in the parent of `PROJECTS_ROOT` (unlikely), a request like `GET /projects/../stuff` would pass the existence check and read it.

Under the personal-use threat model there's no adversary and no cross-origin vector, so this reduces to "the UI can only ever populate slug from the projects list, which is slugified at creation". Listed for completeness; fix is a one-liner guard (`if (slug.includes('..') || path.isAbsolute(slug)) return null`).

→ No fix-task spawned (Low).

---

## Part B — Process control & watchdog

### 5. No wall-clock watchdog on any FFmpeg spawn — **High finding (H1)**

None of the spawn sites attach a timeout to the child process:

| Spawn site | File:line | Timeout? |
|---|---|---|
| `runFfmpeg` (generic) | [ffmpeg-utils.ts:15](electron/server/lib/ffmpeg-utils.ts:15) | ✗ |
| `getAudioDuration` | [ffmpeg-utils.ts:53](electron/server/lib/ffmpeg-utils.ts:53) | ✗ |
| `getMediaInfo` (validate) | [ffmpeg-validation.ts:51](electron/server/lib/ffmpeg-validation.ts:51) | ✗ |
| `probeForUpload` | [ffprobe-check.ts:41](electron/server/lib/ffprobe-check.ts:41) | ✗ |
| `runFfmpegWithStderr` (loudnorm) | [audio-merge.ts:41](electron/server/generators/audio-merge.ts:41) | ✗ |
| `runEncode` (final compose) | [video.ts:2121](electron/server/generators/video.ts:2121) | ✗ |
| `getFFmpegStatus` (`-version` / `-filters`) | [ffmpeg-manager.ts:218,253](electron/server/services/ffmpeg-manager.ts:218) | ✗ |
| `verifyBinary` (post-install) | [ffmpeg-manager.ts:591](electron/server/services/ffmpeg-manager.ts:591) | ✗ |

Cancellation via `trackChild(proc)` + SIGTERM works (verified in [ffmpeg-utils.ts:36-38](electron/server/lib/ffmpeg-utils.ts:36) and [video.ts:2167-2170](electron/server/generators/video.ts:2167)) — a user hitting Cancel on a stuck job unwinds cleanly. But nothing kills the child *automatically* on a runaway. Pathological inputs that FFmpeg 8 has been observed to hang on include:

- A title image in CMYK JPEG → `swscale` spins on format conversion.
- An `anullsrc` silence generator with `-t 0` (harmless typo) → infinite-empty-audio generation.
- A badly-muxed MP3 chapter where the encoder's seek table points past EOF → `libmp3lame` retries indefinitely.

This is **Session 04 §6 blocker #1** (`FFmpeg watchdog + partial-output cleanup`), and it's owned by this session. The fix:

1. Per-spawn `timeoutMs` parameter on `runFfmpeg` + `runEncode`. Reasonable defaults: 60 s for prep clips (each scene ≤ 10 s so 6× is generous), 30 min for the final encode (a 3-hour render at realtime, minus the factor of how much faster modern encoders run). Make them tunable via env var (`STORY_STUDIO_FFMPEG_TIMEOUT_MS`) for edge cases.
2. On timeout: `SIGTERM`, wait 5 s, `SIGKILL`. Both go through `proc.kill(...)`.
3. Surface a specific error: `FFmpeg exceeded {mins}-minute wall-clock watchdog — job killed to free the queue. Last stderr: {last-5-lines}`.

This fix also **de-risks Session 04 §3 row 6** ("Provider retry drains wallet overnight") by proxy — an unkillable FFmpeg inside the job-queue running slot pins the queue, and subsequent generate-image jobs can't enter the slot to hit the retry ladder.

→ **Fix-task spawned: "Fix: add FFmpeg watchdog timeout + partial-output cleanup"** (combined with finding #6 below — they share the same fix seam).

### 6. Partial output file not cleaned up on failure — **High finding (H2, combined with H1)**

[video.ts:782](electron/server/generators/video.ts:782):

```ts
const outputFile = path.join(videoDir, `${code}_video_${timestamp}.${format}`)
```

The final encode writes directly to this path — not into `tempDir`. The rename-to-`_final_video` happens at [video.ts:813-825](electron/server/generators/video.ts:813), which only runs when `runFinalComposition()` returns. If *any* of the following happen, `outputFile` is left on disk as a partial, potentially-playable-but-truncated MP4:

- All three encode tiers fail ([video.ts:2324-2330](electron/server/generators/video.ts:2324)).
- User cancels mid-encode — SIGTERM → `runEncode` rejects → error propagates → `outputFile` remains whatever the child was flushing when killed.
- Wall-clock watchdog kills the child (once finding #5 is fixed).
- Disk fills up between two tier attempts — the earlier tier's partial output stays.

The job-queue `catch` at [job-queue.ts:321-332](electron/server/services/job-queue.ts:321) records the error and moves on without touching the file. `tempDir` cleanup is carefully preserved-on-failure ([video.ts:839-845](electron/server/generators/video.ts:839)) — but `outputFile` isn't in `tempDir`.

Why this is a solo-ops hazard: the next time the user renders, the timestamped filename changes, so the partial file isn't automatically overwritten. It sits in the `_video/` subfolder alongside working renders. A disk-space review three weeks later shows 8 GB of `E0003_video_1745xxxxxxx.mp4` carcasses, none of which are marked as "partial". Worse, a user browsing the folder could mistake one for a good render and upload it.

The **same fix seam as finding #5** handles both:

```ts
// pseudocode
let succeeded = false
try {
  await runFinalComposition({...})
  succeeded = true
} finally {
  if (!succeeded && existsSync(outputFile)) {
    await fs.rm(outputFile, { force: true })
    job.output_lines.push(`Removed partial output: ${path.basename(outputFile)}`)
  }
}
```

Same treatment for the audio-merge output ([audio-merge.ts:419](electron/server/generators/audio-merge.ts:419)) — less dire because the file is smaller, but the same "silent partial" class.

→ **Fix-task combined with H1.**

### 7. stderr kept to last 5 lines; no persistent FFmpeg error log — **Medium finding (M3)**

[ffmpeg-utils.ts:40-42](electron/server/lib/ffmpeg-utils.ts:40):

```ts
const lines = stderr.split('\n').filter(l => l.trim())
const errorLine = lines.slice(-5).join('\n')
reject(new Error(`FFmpeg exited with code ${code}:\n${errorLine}`))
```

— matched at [audio-merge.ts:62-64](electron/server/generators/audio-merge.ts:62) and [video.ts:2173-2175](electron/server/generators/video.ts:2173). The error propagates into `job.output_lines`, which `persistJob` ([job-queue.ts:190](electron/server/services/job-queue.ts:190)) writes to `jobs.json`. `jobs.json` is bounded to `MAX_PERSISTED` entries.

**Problems:**

1. Five lines is often not enough. FFmpeg's last stderr lines are frequently progress counters (`frame=… time=… speed=…`) that push the real error off the window. When the user files a bug "my render failed", the stderr slice looks like `frame= 4321 fps= 29 …` five times over — nothing actionable.
2. Full stderr is never written anywhere persistent. [logger.ts](electron/server/services/logger.ts) writes structured JSON entries but `runFfmpeg` doesn't call `logLine()` — only `ffmpeg-install:*` phases do. A failed encode two days ago is gone unless the user left the app open and can still see it in the job pane.
3. The user can't send you a repro bundle.

**Fix:** on non-zero exit, write the full stderr to `{userData}/logs/ffmpeg-failures/{job_id}.log` (rotated with a simple 30-file cap). Include the argv that was spawned (redacted of absolute paths → just basenames is plenty for support). Thread the filename into the error message: `FFmpeg exited with code 1 — full log: logs/ffmpeg-failures/job-abc.log`.

→ No fix-task spawned (Medium — useful but not a data-loss hazard).

### 8. tempDir inside the user's projects folder — **Medium finding (M4)**

[video.ts:520](electron/server/generators/video.ts:520) and [audio-merge.ts:304](electron/server/generators/audio-merge.ts:304):

```ts
const tempDir = path.join(videoDir, `.tmp_${Date.now()}`)
```

`videoDir` lives inside the user's chosen projects root ([project-manager.ts:689-700](electron/server/services/project-manager.ts:689)), which is often iCloud Drive / Dropbox / OneDrive. Consequences:

1. Every intermediate xfade chunk, premixed WAV, and concat list is iCloud-synced while being written. A 3-hour encode churns through ~1 GB of intermediates; iCloud uploads that traffic, then deletes the lot when the run succeeds. Wastes bandwidth *and* triggers the sync engine during long renders, which has been observed to stall disk I/O on the files FFmpeg is actively writing.
2. Two jobs starting within the same millisecond produce the same `.tmp_<ms>` name — the second one does `mkdir({recursive: true})` on an existing dir and proceeds to clobber the first job's files. Unlikely in practice (job queue serialises per type), but correctness-wise `fs.mkdtemp(path.join(..., '.tmp_'))` is the right primitive.
3. Session 04 §4 calls out `sync-safe.ts` for asset availability (iCloud placeholder detection) but doesn't cover the *intermediate-write* side.

**Fix:** stage intermediates in `os.tmpdir()` (or `{userData}/.encode-scratch/`) and `fs.rename()` the final output into `videoDir` at the end. This also incidentally fixes finding #6 — the only thing that ever lands in `videoDir` is the completed file. `os.tmpdir()` is local, fast, and never iCloud-backed.

→ No fix-task spawned (Medium — nice-to-have; would benefit from bundling with the H1/H2 cleanup fix).

---

## Part C — Output management

### 9. `-y` silent overwrite + rename clobbers `_final_video` — **Low finding (L2)**

Every `runFfmpeg(...)` invocation in the pipeline starts its argv with `-y`. This is correct for intermediates (`tempDir/*.mp4` get overwritten by retries within a run) but the same flag covers the final `outputFile`. After `runFinalComposition` succeeds, [video.ts:817](electron/server/generators/video.ts:817):

```ts
await fs.rename(outputFile, finalPath)
```

— where `finalPath = {videoDir}/{code}_final_video.{format}`. `fs.rename()` on macOS/Linux replaces an existing destination atomically. A previously-rendered, already-uploaded `E0003_final_video.mp4` is silently replaced on every re-render.

Under the personal-use model this is the *intended* behaviour — the operator treats `_final_video` as "current canonical render", and timestamped files in the same folder are the history. But there's no sanity check ("the existing `_final_video` is 2 GB and older than 1 day; you sure?"). The UX is "renders blow away the last render without a whisper."

Fix options:
- Do nothing (today's choice — documented).
- Move the existing `_final_video` to `_final_video_replaced_${originalTimestamp}` instead of deleting it. Cheap safety net.
- Ask the UI layer if there's an uploaded-status flag associated with that file; refuse the rename if so (requires upload-manager plumbing — out of scope).

→ No fix-task spawned (Low, policy question).

### 10. Encoder tier retries reuse the same outputFile — **Low finding (L3, contextual)**

[video.ts:2231-2256](electron/server/generators/video.ts:2231) defines three encode tiers, and each tier's `build()` puts `outputFile` at the end of its argv. `runEncode()` spawns FFmpeg which writes to `outputFile` with `-y` — so each tier silently overwrites the previous tier's partial output. This is correct (the failed tier's output is by definition unusable), but if a tier exits with `code 0` but the output is bad (the `validateEncodedOutput` case at [:2262-2284](electron/server/generators/video.ts:2262)), the bad file sits in `videoDir` until either the next tier writes over it OR all tiers fail and H2 above applies.

The fix overlaps with H2: either (a) encode to `tempDir/final.mp4` and atomic-rename into `videoDir` once validated, or (b) clean up on all-tier-fail in the finally block.

→ Rolled into H1/H2 fix.

---

## Part D — Binary resolution & configuration

### 11. Cross-platform FFmpeg: bundled darwin only — **Low finding (L4, informational)**

[ffmpeg-manager.ts:289-300](electron/server/services/ffmpeg-manager.ts:289) declares `DOWNLOAD_URLS` for `darwin.arm64` and `darwin.x64` only. [:379-386](electron/server/services/ffmpeg-manager.ts:379) throws `"Story Studio KH is macOS-only (platform=<X>, arch=<Y>)"` on any other platform. This matches Session 04 §1 ("N independent macOS installs") — the product is macOS-only by design.

However, the same file carries Windows/Linux branches in `getCommonInstallPaths` ([:68-80](electron/server/services/ffmpeg-manager.ts:68)), `COMMON_BIN_DIRS_BY_PLATFORM` ([:641-657](electron/server/services/ffmpeg-manager.ts:641)), and `findInPath` ([:659-700](electron/server/services/ffmpeg-manager.ts:659)). Those branches exist for devs running the backend under `tsx` on non-Mac machines — they probe Homebrew/LocalAppData/etc. but there's no download fallback. If you later decide to ship Windows, `DOWNLOAD_URLS` needs per-platform ZIPs pinned by SHA-256 (the same pattern as darwin).

Versions bundled ([scripts/fetch-ffmpeg.mjs:59-60](scripts/fetch-ffmpeg.mjs:59)): **ffmpeg 8.1 universal2** (Intel x86_64 from evermeet.cx + arm64 from osxexperts.net, fused via `lipo`). Pinned SHA-256 at [ffmpeg-manager.ts:306-317](electron/server/services/ffmpeg-manager.ts:306) matches the pre-build script — install-time hash mismatch refuses the unzip. Correct.

→ No fix-task; informational.

### 12. `ffmpeg_path` has no UI override; errors don't name the override — **Low finding (L5)**

[ffmpeg-manager.ts:110-157](electron/server/services/ffmpeg-manager.ts:110) checks `getAppSetting('ffmpeg_path')` first — that key is only ever written by the `downloadFFmpeg()` flow ([ffmpeg-manager.ts:509](electron/server/services/ffmpeg-manager.ts:509)). There is **no route** that exposes `setAppSetting('ffmpeg_path', ...)` to the renderer. A user who wants to point at a custom FFmpeg must hand-edit `{userData}/app-settings.json`.

When the configured `ffmpeg_path` exists but fails to run (wrong arch, Gatekeeper-killed, missing shared library), the error surface is a generic `FFmpeg failed to start: <spawn error>` from `runFfmpeg`. The user doesn't see "this came from your `ffmpeg_path` override in app-settings.json" — they just see a spawn failure. Install-time verification (`verifyBinary` + `isBadArchError` at [ffmpeg-manager.ts:589-617](electron/server/services/ffmpeg-manager.ts:589)) gives excellent diagnostics *at install time* but nothing at render time.

Fix is cheap: in `getFFmpegPath`, when the custom path exists but spawning `<path> -version` fails, invalidate the setting and log a structured entry ("user-configured ffmpeg_path no longer works — falling back to bundled"). Today the code silently falls through to bundled/system because `existsSync` is the only gate.

→ No fix-task spawned (Low, UX).

### 13. Env-var args (VIDEO_DEBUG, XFADE_CHUNK_SIZE) — ✓

- `STORY_STUDIO_VIDEO_DEBUG` ([video.ts:528](electron/server/generators/video.ts:528)): boolean gate on whether tempDir is preserved. Never flows into argv. Clean.
- `STORY_STUDIO_XFADE_CHUNK_SIZE` ([video.ts:1356-1362](electron/server/generators/video.ts:1356)): `parseInt(..., 10) || 48`, clamped to `[2, 128]`. Flows into `for (i += XFADE_CHUNK_SIZE)` chunk size and into `path.join(tempDir, scenes_xfaded_${N}.mp4)` as the counter only — no direct argv injection. Clean.

(Criterion 6.)

### 14. Codec/format selection — ✓ (type-restricted)

`codec` is typed `'h264' | 'h265'` ([models/types.ts:712](electron/server/models/types.ts:712)) and flows through `effectiveCodec: 'h264' | 'h265'` ([video.ts:2063](electron/server/generators/video.ts:2063)). `format` has no wide-string escape hatch either — callers either pass `'mp4'` or `'webm'` (the latter flips codec to h264 at [:2063](electron/server/generators/video.ts:2063)). A user picking "something weird" via a mis-typed config would fail the TypeScript check at compile time and a silent fallback to h264 at runtime. No "unusual codec → broken output silently" path found.

(Criterion 8.)

---

## Findings summary

| # | Finding | Severity | Criterion |
|---|---|---|---|
| 1 | No shell interpolation anywhere (argv arrays throughout) | ✓ positive | 1 (escape), 6 (env) |
| 2 | **Path-prefix arg confusion (`-foo.mp4` parsed as flag)** | Medium (M1) | 1 |
| 3 | **Concat-demuxer newline injection via `escPath`** | Medium (M2) | 4 |
| 4 | Slug `..` path-traversal — mitigated by slugify at creation | Low (L1) | 2 |
| 5 | **No wall-clock watchdog on any FFmpeg spawn** | **High (H1)** | 10, 11 |
| 6 | **Partial `outputFile` not cleaned up on all-tier fail / cancel / watchdog kill** | **High (H2)** | 10 |
| 7 | stderr truncated to last 5 lines; no persistent FFmpeg error log | Medium (M3) | 9 |
| 8 | `tempDir` inside user's iCloud-synced projects folder + `Date.now()` collision | Medium (M4) | 5 |
| 9 | `-y` silent overwrite + rename clobbers `_final_video` without warning | Low (L2) | 3 |
| 10 | Encoder tier retries reuse the same `outputFile` | Low (L3, into H2) | 3, 10 |
| 11 | Cross-platform bundling: darwin-only (matches Session 04 product scope) | Low (L4, informational) | 12 |
| 12 | No UI override for `ffmpeg_path`; runtime errors don't name the override | Low (L5) | 7 |
| 13 | Env-var args validated + clamped | ✓ positive | 6 |
| 14 | Codec/format type-restricted | ✓ positive | 8 |

## Fix-tasks spawned

- **Fix: add FFmpeg watchdog timeout + partial-output cleanup** (H1 + H2; one seam, same commit)
- **Fix: reject newline/CR/NUL in concat-list filenames** (M2)

## Cross-references

- Session 04 §6 #1: blocker `FFmpeg watchdog + partial-output cleanup` → closed by H1/H2 fix above.
- Session 04 §3 row 6 ("Provider retry drains wallet overnight"): H1 de-risks by unblocking the queue slot when FFmpeg hangs, letting the consecutive-failure cap in `http-retry.ts` do its job instead of being pinned behind a stuck generator.
- Session 05 (portability): tempDir-in-projects (finding #8) overlaps with portability's "iCloud placeholder detection" story but from the *write* side rather than the *read* side.
- Session 06 H1 (`kie-video-client.ts` retry migration): already landed. No overlap with this session.
