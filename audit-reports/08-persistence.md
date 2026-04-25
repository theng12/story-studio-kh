# Session 08 — Persistence & Data Safety

**Scope:** file-based JSON persistence layer. The app has no database — every piece of user state (projects, ideas, config, secrets, jobs, upload sidecars, per-episode metadata) is a JSON file on disk. Desktop-app convention; fine **if** every write is atomic, every read tolerates corruption, and concurrent writers coordinate through a single mutex. Session 04 §4 and §6.6 flagged "atomic-store.ts is per-path mutex, not process-wide; manifest self-heal doesn't fire" as the top debt in this area. This session audits the end-to-end safety of the JSON tier against 13 criteria: atomicity, bypass writers, multi-instance, schema migration, drift reconcile, backup/undo, JSON.parse robustness, disk-full, symlinks/iCloud, cross-platform slug hygiene, concurrent reads mid-write, data-dir env validation, and sync-folder conflicts.

**One-line verdict:** **the "safe tier" is correct; the "rest of the app" is not routed through it.** `lib/atomic-store.ts` does temp+rename with a per-path mutex and is the right primitive. The problem is how many hot-path writers bypass it. `ideas.json` (the central episode-ideas store, touched on every Generate / Accept / Dismiss) uses raw `fs.writeFile` with no lock and no temp-rename at [idea-manager.ts:92](electron/server/services/idea-manager.ts:92) — a SIGKILL or power loss mid-write truncates it, and the reader at [idea-manager.ts:47-85](electron/server/services/idea-manager.ts:47) silently falls back to an empty store, wiping the user's idea backlog on the next restart. Five more non-atomic writers exist in the same shape. `readJson` in `project-manager.ts` returns `{}` on any parse error (not just ENOENT); the next write-back merges into `{}` and silently nukes the project. Single-instance lock is in place (✓). No fsync means a macOS/Windows power-cut can still leave the rename on an empty-file inode even after the call returned. One Critical, five High, five Medium, one Low below.

---

## Part A — Atomicity & bypass of the safe tier

### 1. `lib/atomic-store.ts` is correct, as far as it goes — ✓

[atomic-store.ts:51-68](electron/server/lib/atomic-store.ts:51):

- `writeJsonAtomic` writes to `${filePath}.{pid}.{ts}.{rand}.tmp`, then `rename()` over the dest.
- POSIX guarantees rename-within-same-directory is atomic. NTFS same (Windows' `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`; Node's `fs.rename` uses that).
- Temp file is cleaned up on rename failure ([:60-62](electron/server/lib/atomic-store.ts:60)).
- `mode` re-applied after rename ([:65-67](electron/server/lib/atomic-store.ts:65)).
- `withLock(key, fn)` serialises per-path promises; rejections don't poison the queue ([:25-37](electron/server/lib/atomic-store.ts:25)).
- `readJsonOr(p, fallback)` is a safe read helper for any file that may be missing ([:75-82](electron/server/lib/atomic-store.ts:75)).

`sync-safe.ts::writeAtomic` ([:25-31](electron/server/lib/sync-safe.ts:25)) is a second implementation with the same pattern but without the lock. Used for manifest and cache writes outside userData. (Criterion 1.)

### 2. `ideas.json` — non-atomic write on the app's central data file — **Critical finding**

[idea-manager.ts:91-93](electron/server/services/idea-manager.ts:91):

```ts
async function saveStore(slug: string, store: IdeasStore): Promise<void> {
  await fs.writeFile(ideasPath(slug), JSON.stringify(store, null, 2) + '\n')
}
```

Bare `fs.writeFile` — no temp+rename, no `withLock`. Called from **nine** public APIs: `addIdeas` ([:126](electron/server/services/idea-manager.ts:126)), `updateIdea` ([:149, :287](electron/server/services/idea-manager.ts:149)), `acceptIdea` ([:193, :222-225](electron/server/services/idea-manager.ts:193)), `dismissIdea` ([:251](electron/server/services/idea-manager.ts:251)), `renameIdea` ([:280](electron/server/services/idea-manager.ts:280)), `acceptOrDismissIdea` ([:336](electron/server/services/idea-manager.ts:336)), `importIdeasFromCsv` ([:402](electron/server/services/idea-manager.ts:402)), plus an auto-heal write from inside the reader itself at [:79](electron/server/services/idea-manager.ts:79) (triggered whenever `loadStore` detects gaps in accepted episode numbers — **every read can become a write**).

A tenth and worse bypass path: [episode-import.ts:257-274](electron/server/services/episode-import.ts:257) deliberately "reach[es] into the idea-manager path" to do its own `fs.readFile` → `JSON.parse` → mutate → `fs.writeFile` of `ideas.json` without going through `idea-manager` at all:

```ts
// 258
const ideasStore = JSON.parse(await fs.readFile(ideasJsonPath, 'utf-8'))
// ...
// 274
await fs.writeFile(ideasJsonPath, JSON.stringify(ideasStore, null, 2) + '\n')
```

No lock, no atomic rename, and racing with every `idea-manager` caller.

**Failure mode chain:**

1. Any non-atomic writer is interrupted mid-write (SIGKILL, OS crash, laptop lid slammed, disk full mid-`write()` syscall). `ideas.json` is truncated on disk.
2. Next app start: `loadStore` ([idea-manager.ts:44-88](electron/server/services/idea-manager.ts:44)) calls `JSON.parse` on the truncated content, throws, hits the `catch` at [:85](electron/server/services/idea-manager.ts:85).
3. `catch` silently returns `{ ideas: [], next_episode_number: 1, recycled_numbers: [] }`.
4. First write after restart (e.g. a new `addIdeas` call) flushes this empty store back to disk as the new canonical state.
5. User's idea backlog is **gone**, with no log line they'd notice and no backup.

Cross-machine transfer via iCloud/Dropbox-hosted data dir makes this even worse: the sync daemon can snapshot a mid-write state on another machine.

For an app whose entire left-sidebar is the ideas list, this is a data-loss path on the hottest write in the codebase. `acceptIdea` in particular is called during episode creation — the exact moment users would be most upset to lose state.

→ **Fix task spawned: "Fix: route ideas.json writes through writeJsonAtomic + withLock"**

### 3. Four more direct-`fs.writeFile` bypasses — **High finding**

Same pattern, lower hot-path but same correctness hole:

| File written | Site | Called from |
|---|---|---|
| `sessions.json` | [session-tracker.ts:60-62](electron/server/services/session-tracker.ts:60) | every `trackGeneration()` — fires concurrently with any generator job |
| `episode_info.json` (adopted) | [upload-orphans.ts:171](electron/server/services/upload-orphans.ts:171) | YouTube orphan adoption flow |
| `episode_info.json` (imported) | [episode-import.ts:337](electron/server/services/episode-import.ts:337) | folder-import flow |
| `{episode}_Metadata.json` | [routes/scripts.ts:765](electron/server/routes/scripts.ts:765), [routes/metadata.ts:191](electron/server/routes/metadata.ts:191) | Metadata Generator save — the file Session 07's snippetFromMeta reads back |

The metadata case is the loudest tail-risk: the LLM-generated metadata is the one Session 07 sanitizes before upload. A truncated `_Metadata.json` would (a) lose the description bytes the operator spent tokens to generate, (b) fall through to the `.txt` parse path at [upload-metadata.ts:63-76](electron/server/lib/upload-metadata.ts:63) which won't find what it expects, (c) silently fall through to the idea title fallback at [:101-103](electron/server/lib/upload-metadata.ts:101), and (d) upload to YouTube with the raw idea title as the video title. No error surfaced.

→ **Fix task spawned: "Fix: non-atomic writes for sessions.json, episode_info.json, _Metadata.json"**

### 4. `readJson` silently returns `{}` on a corrupt file — **High finding**

[project-manager.ts:158-168](electron/server/services/project-manager.ts:158):

```ts
async function readJson(filePath: string): Promise<any> {
  try {
    const text = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(text)
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.error(`[project-manager] Error reading ${filePath}:`, e.message)
    }
    return {}
  }
}
```

ENOENT returning `{}` is correct (new file). **Any other error — including `JSON.parse` on a truncated file — also returns `{}`.** Only a `console.error` distinguishes them, and the caller has no way to know.

Paired with the `readJson` → mutate → `writeJsonAtomic` pattern throughout `project-manager.ts` ([:420-425](electron/server/services/project-manager.ts:420), [:205-210](electron/server/services/project-manager.ts:205), [:655](electron/server/services/project-manager.ts:655), and more), a corrupted `project.json` means the next save merges user updates into `{}` and writes back a project with no `name`, no `output_root`, no `episode_prefix`, no `slug` — **headless project that can't open anything**.

The worst instance is [syncManifest:205-210](electron/server/services/project-manager.ts:205): `project_id` backfill is called on every metadata change. If the initial in-memory `meta` was loaded OK but the on-disk file got corrupted between reads, this `readJson` under the lock returns `{}`, gets `project_id` set on it, and writes the *entire* project.json out as `{ project_id: "…" }`.

Fix shape: make `readJson` throw on parse error, or return a tagged `{ ok, data } | { ok: false, corrupt: true }` so the caller either aborts or invokes a "restore from `.bak`" recovery path. Atomic-store's `readJsonOr` has the same shape bug but it's less load-bearing — callers of `readJsonOr` tend to be reading transient ephemeral state where `{}` is a reasonable fresh-install default.

→ **Fix task spawned: "Fix: readJson corruption fallback silently destroys project.json"**

### 5. `writeJsonAtomic` doesn't fsync — **High finding**

[atomic-store.ts:56-58](electron/server/lib/atomic-store.ts:56):

```ts
await fs.writeFile(tmp, body, opts.mode !== undefined ? { mode: opts.mode } : undefined)
try {
  await fs.rename(tmp, filePath)
```

Missing: an `fsync(tmp_fd)` between the write and the rename; and on POSIX, an `fsync(dir_fd)` after the rename. `fs.writeFile` returns when bytes hit the page cache, not the disk. Power-loss between the resolved `writeFile` and the disk flush can leave the rename reordered relative to the data write, so the new inode points at zero-length content — the file exists, appears fine, `readFile` returns `''`, `JSON.parse` throws.

Darwin has an extra wrinkle: `F_FULLFSYNC` is required to bypass the drive's write cache; `fsync` on its own only flushes to the disk's buffer. For a personal-use app, `fsync` without `F_FULLFSYNC` is an acceptable compromise (same as SQLite's default on macOS), but zero fsync is below-bar.

Windows: `fs.rename` via `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` does replace-on-NTFS, but WITH the same caveat — pages are cached until `FlushFileBuffers`. Power-loss can leave the directory entry pointing at an empty file extent on NTFS.

Combined with finding #4: one power-cut → empty project.json → next save → empty project.json gets `{project_id: "…"}` merged → project is dead.

→ **Fix task spawned: "Fix: add fsync to writeJsonAtomic before rename"**

### 6. `folder-migration.ts` rename is not coupled to `project.json` update — **High finding**

[folder-migration.ts:77-82](electron/server/services/folder-migration.ts:77):

```ts
try {
  await fs.writeFile(metaPath, JSON.stringify(updated, null, 2) + '\n')
  console.log(`[migration] ${slug}: project.json subfolder_names.description → metadata`)
} catch (e) {
  console.error(`[migration] ${slug}: failed to update project.json:`, e)
}
```

Sequence per project, during boot migration:

1. Walk episodes, rename every `… - 02 Description` folder to `… - 02 Metadata` ([:104](electron/server/services/folder-migration.ts:104)).
2. After all episodes processed, update `project.json::subfolder_names` ([:78](electron/server/services/folder-migration.ts:78)).

A crash between (1) and (2) leaves disk layout using the new names but `project.json` still says `description`. Subsequent reads via [path-resolver.ts](electron/server/lib/path-resolver.ts) key off `subfolder_names.description` and don't find the folder. The app sees all episodes as having no metadata directory.

Two compounding issues: the write at [:78](electron/server/services/folder-migration.ts:78) is also **bare `fs.writeFile`** (see finding #3), so even with no crash, a disk-full error here leaves a truncated `project.json`. And the boot migration runs inside the main server startup at [server/app.ts:72-73](electron/server/app.ts:72) — a crash here is noticed by the user, but there's no rollback path.

No-op on already-migrated projects: also dangerous. The migration-marker logic is "does target folder exist?" ([:98-101](electron/server/services/folder-migration.ts:98)), not "has this ever run successfully?" — so a partial run that renamed 3 of 5 folders and crashed will, on the next boot, try the remaining 2 and still not update `project.json` if any of the renames throws.

→ **Fix task spawned: "Fix: couple folder-migration rename + project.json update atomically"**

### 7. Slug sanitizer loses on Windows — **High finding**

[project-manager.ts:140-145](electron/server/services/project-manager.ts:140):

```ts
function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'project'
}
```

Does NOT:

- Reject Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`). A project literally named "CON" slugifies to `con`, `uniqueSlug` finds nothing at that path (no project exists), and writes to `%APPDATA%/Story Studio KH/projects/con/` — which Windows refuses to create. Wizard fails opaquely.
- Handle Windows-illegal characters beyond the generic `\w`: `<>:"|?*` plus control chars. `\w` happens to exclude most of these, but combinations like "foo." slugify to "foo" (with a trailing dot dropped — but via a different path: Windows trims trailing dots in paths, so "foo." as a literal slug would create "foo" directory regardless — unless Node on Windows preserves it. Node passes the raw name to `CreateDirectoryW` which strips trailing dots and spaces. So `uniqueSlug` could check-exists-returns-false for "foo.", then create "foo" collision).
- Cap total path length. Windows default `MAX_PATH` is 260 chars. `%APPDATA%\Story Studio KH\projects\{slug}\episodes\{season}\{episode-folder}\02 Metadata\{code}_Metadata.json` is already ~100 chars before the user's project name. A 150-char project name blows the limit.
- Dedupe case-insensitively on APFS/HFS+/NTFS. `uniqueSlug` uses `existsSync(path.join(...))` which on case-insensitive filesystems returns `true` for `Foo` if `foo` exists — good, by accident. But on a case-sensitive Linux mount or ext4, `Foo` and `foo` coexist, then roundtrip to macOS where they collide.

Today, Story Studio is macOS-only (DMG bundle), but Session 04's portability story includes "install on another Mac" and, informally, Windows Intel laptops the operator might use. Even on macOS, a user who names a project "AUX" or includes `/` in the name (stripped silently by `[^\w\s-]` with no warning) gets a surprising slug.

Second related gap: `import-project.ts:225-230` duplicates the same slugify implementation — so fixing one requires fixing both.

→ **Fix task spawned: "Fix: slug sanitizer for cross-platform safety"**

---

## Part B — Multi-instance, recovery, and migrations

### 8. Single-instance lock is in place — ✓

[main.ts:19-31](electron/main.ts:19):

```ts
const gotLock = electronApp.requestSingleInstanceLock()
if (!gotLock) {
  electronApp.quit()
  process.exit(0)
}
electronApp.on('second-instance', () => { /* focus existing window */ })
```

Correct. A second-launch attempt wakes the existing window and exits. Multi-process races on `jobs.json` / `ideas.json` / `secrets.json` can't happen inside the app's own flow. (Criterion 3.)

Single BrowserWindow ([main.ts:55](electron/main.ts:55)); navigation lockdown at [:162-171](electron/main.ts:162) prevents target=_blank spawning a second renderer. Backend Express server binds loopback at [:44](electron/main.ts:44); one instance per app process.

**Residual multi-instance risk:** `STORY_STUDIO_DATA_DIR` can point two different machines — or two different macOS user accounts on the same machine — at the *same* iCloud-synced directory. Electron's lock is per-OS-user; two users both launching the app on the same Mac (fast-user-switched) bypass it. Same for the "accidentally run the dev `npm run dev` alongside the packaged .app" case. Low likelihood for a solo operator; flag as non-blocking.

### 9. Secrets v1 → v2 migration — ✓

[secrets-store.ts:137-155](electron/server/services/secrets-store.ts:137) (`normaliseToV2`): reads v1 flat `{provider_api_key}` shape, wraps each key into a `{accounts: [{id: randomUUID(), label: 'Default', apiKey, isDefault: true}]}` v2 envelope. No data loss.

On read, migration fires in memory ([:287](electron/server/services/secrets-store.ts:287)); rewrite on next access is best-effort ([:296-299](electron/server/services/secrets-store.ts:296)) with a `.catch(() => {})`. If the rewrite fails silently, the next read re-runs the migration — idempotent.

Decrypt failure on foreign-machine restore silently returns `null` ([:250-257](electron/server/services/secrets-store.ts:250)). Documented tradeoff (comment explains it); the app treats the store as empty rather than crashing. Right call.

Foreign-provenance check ([:232-239](electron/server/services/secrets-store.ts:232)) refuses to load tokens minted on another machine — key safety feature for Session 04's channel-binding concern, and it works.

(Criterion 4.)

### 10. Portable-manifest v1 → v2 — ✓

[manifest.ts:90-115](electron/server/services/manifest.ts:90): v1 files are silently normalised by dropping the preset/standards bag (Session 05 update documented this), v2 passes through, malformed returns `null`. Next write rewrites clean v2. No silent data loss because Session 05 explicitly reclassified the dropped fields as per-machine setup.

### 11. No startup reconcile / `.tmp` cleanup — **Medium finding**

[server/app.ts:72-73](electron/server/app.ts:72) runs exactly one boot task: `migrateDescriptionToMetadata`. There is:

- **No `.tmp` cleanup pass.** A crash during `writeJsonAtomic` leaves `${filePath}.{pid}.{ts}.{rand}.tmp` files behind indefinitely. For a personal user over months, these accumulate in userData/projects/\*/. Harmless individually but (a) measurable disk footprint, (b) stale temps in iCloud-synced dirs confuse iCloud's conflict resolution.
- **No asset-reconciler autorun.** Four reconcilers exist ([image-reconciler.ts](electron/server/services/image-reconciler.ts), [audio-reconciler.ts](electron/server/services/audio-reconciler.ts), [video-reconciler.ts](electron/server/services/video-reconciler.ts), [upload-reconciler.ts](electron/server/services/upload-reconciler.ts)); all four are route-invoked on demand. Session 04 §6.6 flagged this and deferred to Session 09. Still true.
- **No integrity check.** On startup, the app doesn't validate that every project's `project.json` is parseable, that `ideas.json` counts match `episodes/` folder counts, or that upload sidecars point at still-existing `video_id`s. Drift accumulates silently.

Fix shape is coupled with finding #4 (`readJson` silent `{}`) and finding #2 (`ideas.json` non-atomic) — if a boot check found corruption, there's nowhere to recover from. A `.bak` snapshot on every successful write (kept for N versions) is the natural pairing.

→ No fix task (Session 09's scope per 04-threat-model §6.6). Included as context.

### 12. `STORY_STUDIO_DATA_DIR` not validated — **Medium finding**

Read at seven sites ([app-settings.ts:25](electron/server/services/app-settings.ts:25), [preview-cache.ts:25](electron/server/services/preview-cache.ts:25), [migration.ts:24](electron/server/services/migration.ts:24), [voices-cache.ts:31](electron/server/services/voices-cache.ts:31), [project-manager.ts:63](electron/server/services/project-manager.ts:63), [named-roots.ts:26](electron/server/services/named-roots.ts:26), [ffmpeg-manager.ts:32](electron/server/services/ffmpeg-manager.ts:32), [logger.ts:18](electron/server/services/logger.ts:18)). In every case it's a raw `path.join(process.env.STORY_STUDIO_DATA_DIR, …)`.

Missing: reject path-traversal (`..`), reject relative paths, check writability at boot (fail fast with a dialog rather than discovering on first write), log the resolved data dir at boot so the operator can see what root is in use. Today the user learns the value only via the debug endpoint ([routes/debug.ts:34](electron/server/routes/debug.ts:34)).

Low exploitability (env var is user-controlled in the first place, no trust boundary) but a validation pass would prevent the "I pointed this at `/Volumes/NoLongerMounted` and the app keeps writing to my home dir" confusion. (Criterion 12.)

→ No fix task (flag only; low-priority polish).

### 13. Delete-project is terminal — **Medium finding**

[project-manager.ts:430-461](electron/server/services/project-manager.ts:430): `fs.rm(projectDir, { recursive: true })`; plus, if `output_root` is an absolute path whose basename matches the project name, `fs.rm(output_root, { recursive: true })`. No trash, no snapshot, no undo window.

The secondary delete of `output_root` has a safety check — basename equality — that's easy to defeat. If the user renamed the output folder on disk, `deleteProject` skips the delete (safer). If they kept the default, the whole folder tree (scripts, images, audio, video, thumbnails, per-episode metadata, sidecars) is unlinked. No confirmation dialog at the server layer — the frontend confirms, but a direct API call to `DELETE /projects/:slug` with no confirmation body succeeds.

For solo ops: "I was looking for Project A but clicked Project B and hit Delete" is plausible. Move-to-trash (`shell.trashItem` in Electron) instead of `fs.rm` is a one-line change that preserves the recovery story. Snapshots of `ideas.json` / `project.json` pre-destructive-op would cover finding #4's recovery gap too.

(Criterion 6.)

→ No fix task (low likelihood, not a correctness bug). Flag for product-policy discussion.

### 14. Sync-folder detection is asset-read-only — **Medium finding**

[sync-safe.ts:46-58](electron/server/lib/sync-safe.ts:46) detects iCloud placeholder files (`.{name}.icloud` siblings, zero-size files). Called from generator boundaries to surface "trigger iCloud download" messages on read.

Missing coverage:

- **Output-root location pre-flight.** Nothing warns the user when the wizard's `output_root` picker points at `~/Library/Mobile Documents/com~apple~CloudDocs/` (iCloud Drive), `~/Dropbox`, `~/OneDrive`, `~/Google Drive`, or `~/iCloud Drive (archived)/`. Grep for these literal path fragments in the codebase: zero hits. The user is free to set up a guaranteed-conflict environment.
- **Sync-conflict filename handling.** iCloud / Dropbox / OneDrive / Google Drive all produce sibling files named `foo (Conflicted copy 2026-04-24).json`, `foo (iOS).json`, `foo 2.json`, etc. when two machines write the same file offline. The app never scans for these — they pile up in the episode folders, visible in Finder but invisible in the app. If the user opens the conflict copy and the app opens the original, they're editing a divergent state.
- **Conflict-handling policy.** No "last writer wins" tagging, no mtime comparison at startup, no lockfile in the data dir to detect "another machine is editing this".

For the "project folder in iCloud so I can see it on both Macs" workflow — which the Session 04 threat model explicitly accommodates — this is the missing piece. Adding a `isInSyncFolder(outputRoot)` check in the wizard and a scan-for-conflict-copies on load would cover the common case.

(Criteria 9, 13.)

→ No fix task (requires UX design; flag for Session 09 pairing with manifest drift-detection).

### 15. `import-project::updateOutputRoot` bare `JSON.parse` inside `withLock` — **Low finding**

[import-project.ts:307-315](electron/server/services/import-project.ts:307):

```ts
await withLock(metaPath, async () => {
  const raw = await fs.readFile(metaPath, 'utf-8')
  const data = JSON.parse(raw)
  data.output_root = newRoot
  await writeJsonAtomic(metaPath, data)
})
```

No try/catch. If `project.json` is corrupted, `JSON.parse` throws; `withLock` releases cleanly (the lock implementation at [atomic-store.ts:28-30](electron/server/lib/atomic-store.ts:28) swallows rejections in the tail chain, so later waiters proceed fine). The real exposure is a loud 500 response to the import UI instead of a recovered state.

Not a deadlock; not data loss (the write doesn't fire); just a worse user experience than `safeReadMeta` at [:296-305](electron/server/services/import-project.ts:296), which handles the same file gracefully and should be reused here.

→ No fix task (drive-by cleanup; include with the finding #4 fix).

---

## Concurrent reads during writes — ✓ by construction

`writeJsonAtomic` writes to a sibling tmp file; `rename` is the only operation visible to readers on the real path. A reader opening the real path while the writer is mid-write sees the *previous* bytes (not a half-write), and after rename sees the *new* bytes. No window exists where `JSON.parse` gets partial content on a file written via the atomic helper. Criterion 11 is satisfied — **as long as** every writer goes through `writeJsonAtomic`. Findings #2 and #3 are exactly the places where this invariant breaks.

---

## Severity summary

| # | Finding | Severity | Fix task |
|---|---|---|---|
| 2 | `ideas.json` non-atomic, 10 writers racing | **Critical** | ✓ spawned |
| 3 | Non-atomic writes for sessions, episode_info, _Metadata.json | **High** | ✓ spawned |
| 4 | `readJson` `{}`-fallback nukes project.json on corruption | **High** | ✓ spawned |
| 5 | `writeJsonAtomic` missing fsync | **High** | ✓ spawned |
| 6 | `folder-migration` rename / project.json update not coupled | **High** | ✓ spawned |
| 7 | Slug sanitizer misses Windows reserved names + length cap | **High** | ✓ spawned |
| 11 | No startup reconcile / `.tmp` cleanup | Medium | — (Session 09) |
| 12 | `STORY_STUDIO_DATA_DIR` not validated | Medium | — (polish) |
| 13 | Delete-project terminal, no trash | Medium | — (product decision) |
| 14 | Sync-folder detection is asset-read-only | Medium | — (Session 09 pair) |
| 15 | `import-project::updateOutputRoot` bare JSON.parse | Low | — (cleanup with #4) |

**Ready for fresh-machine install: no.** Fix Critical + five High first. The Critical alone ("user loses their ideas backlog after a single SIGKILL") is a release-blocker for "I'd put this on another Mac without a support contract."

---

## Cross-references

- Session 04 §4 "Atomicity, mode 0600, iCloud placeholder detection all ✓": **updated** — atomicity is ✓ **only for files routed through `writeJsonAtomic`**. The ledger here shows the bypasses.
- Session 04 §4 "manifest/disk drift detection doesn't self-heal": **still true**, and now coupled with finding #11 (no boot-time integrity check).
- Session 04 §6.6 "Manifest self-heal on drift (Session 09)": this audit widens the scope — self-heal needs integrity checks for `ideas.json`, `project.json`, `sessions.json`, and `_Metadata.json` files, not just the manifest.
- Session 07 §3-4 `snippetFromMeta` metadata sanitization: depends on `_Metadata.json` being readable; finding #3's truncation hazard invalidates the sanitizer's input.
