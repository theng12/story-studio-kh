# External Media Root — split storage spec (Level B)

Status: draft / proposed.

**Goal.** Let a project keep its *light* artifacts (scripts, metadata, prompts,
subtitles, sidecars, project.json) in the iCloud-synced project tree, while its
*heavy* media (scene images, thumbnails, audio, merged audio, final video) lives
under a separate **media root** — typically an external SSD — that is **off**
iCloud. This (a) stops episodes' 200–300 scene images (~300 MB+/episode) from
bloating iCloud, and (b) puts the b-roll/image-pool materialized scenes on the
SSD instead of duplicating into iCloud.

> **Note (episodes-folder deletion).** This spec was written while a project
> could store its own `output_root`. It no longer can: a channel's episodes
> always live at `<projectDir>/episodes`, resolved by `resolveOutputRoot()` in
> `services/project-manager.ts`. Read every "`output_root`" below as "the
> channel's episodes folder" — a computed location, never a setting. The media
> root itself is unaffected and remains a real, opt-in choice.

**Hard requirement — fully opt-in.** Default behavior is UNCHANGED: with no
media root configured, every subfolder stays under the episodes folder exactly
as today. A user who ships this app to others, or who wants everything on iCloud,
does nothing and sees no difference. This is supplementary, never required.

---

## 1. Core design

### 1a. Config: an optional `media_root` on the project, expressed as a Named Root
`project.json` gains one optional field:

```jsonc
{
  // ...existing fields...
  "media_root": "${MEDIA}"   // absent (default) = no split; everything under the episodes folder
}
```

Store it as a **Named Root token** (`${MEDIA}`), NOT a raw `/Volumes/...` path.
`project.json` is iCloud-synced and shared across Macs, so a raw path would be
wrong on the other machine. The token resolves per-machine via the EXISTING
Named Roots machinery (`Settings → Named Roots`, `resolveAssetPath()` in
`services/path-resolver.ts`). Each Mac defines `${MEDIA}` → wherever its SSD
mounts (e.g. `/Volumes/StudioSSD/Story Studio Media`).

> Reuses what already exists: `${PROJECT}`/`${NAME}` portable paths, `listNamedRoots()`,
> `resolveAssetPath`/`toPortablePath`. We're adding one project field + a routing
> rule, not a new path system.

### 1b. Heavy vs light split (data-driven, not hardcoded per call site)
Add a single source of truth:

```ts
// services/utils.ts (or a new media-root.ts)
export const HEAVY_SUBFOLDERS = new Set(['images','thumbnails','audio','merged_audio','video'])
// light (stay in iCloud): script, scene_prompts, thumb_prompts, metadata, subtitles
// episode-root sidecars (scene_plan.json, audio_chapters.json, stitched .srt,
//   episode_info.json) also stay light — only the named heavy SUBFOLDERS move.
```

The episode dir layout is **mirrored** under the media root using the same
`folder_template` relative path, so resolution is symmetric:

```
iCloud (episodes):      .../my-channel/episodes/Season 006/EP0110 - Title/EP0110 - 01 Script/
SSD    (media_root):    ${MEDIA}/my-channel/episodes/Season 006/EP0110 - Title/EP0110 - 05 Scene Images/
```

---

## 2. The choke point + surface area

### 2a. Primary seam — `resolveEpisodePaths` (`services/utils.ts:57`)
Today it computes `episodeDir = path.join(outputRoot, episodeRel)` and every
subfolder as `path.join(episodeDir, name)`. Change: when `meta.media_root` is
set, also compute `mediaEpisodeDir = path.join(resolveAssetPath(meta.media_root), episodeRel)`
and base the HEAVY subfolders there:

```ts
const mediaBase = meta.media_root ? path.join(resolveAssetPath(meta.media_root), episodeRel) : episodeDir
const bgDir          = path.join(mediaBase, imagesName)      // heavy
const thumbDir       = path.join(mediaBase, thumbsName)      // heavy
const audioDir       = path.join(mediaBase, audioName)       // heavy
const mergedAudioDir = path.join(mediaBase, mergedAudioName) // heavy
const videoDir       = path.join(mediaBase, videoName)       // heavy
const scriptDir      = path.join(episodeDir, scriptName)     // light (unchanged)
// ...other light dirs unchanged...
```

Every caller that reads `paths.bg_dir / audio_dir / video_dir / …` then "just
works" with zero change.

### 2b. Secondary seam — call sites that bypass `resolveEpisodePaths`
Some code resolves a subfolder directly off the iCloud `episodeDir`:
`resolveSubfolder(episodeDir, names.images)`. These must use the media base for
heavy subfolders. Known sites (audit during build):
- `generators/video.ts` — `scanEpisodeAssets` (reads images), `prepareSceneClips`, final-video write (already honors `external_final_video_root` — fold that into this).
- `routes/broll-project.ts` — `/image-pool/materialize` + `/broll/materialize` (write scene_NNNN into images dir) — the original trigger for this whole thread.
- `generators/images.ts`, `generators/thumbnails*`, `generators/audio.ts`, `generators/audio-merge.ts`, `generators/broll-*` (writes).
- `routes/image-references.ts`, thumbnail/image upload routes.
- `services/asset-status.ts` (`computeEpisodeStatus` checks media presence).
- `generators/youtube-upload.ts` (reads final video — already external-aware).

Provide one helper so call sites don't re-implement the rule:

```ts
// resolves the correct base dir for a given subfolder KEY, media-aware
export async function resolveEpisodeSubfolderDir(slug, code, key /* 'images'|'audio'|... */): Promise<string>
```

Refactor the bypass sites to call it. This is the bulk of the work — mechanical
but wide.

---

## 3. Portability (cross-machine via the SSD)
- File paths persisted in sidecars (e.g. `scene_plan.json` image paths,
  effects/overlay asset refs, preset fields) must be stored **portably**. Heavy
  media collapses to `${MEDIA}/…`; light/project assets to `${PROJECT}/…`. Use
  the existing `toPortablePath()` on write and `resolveAssetPath()` on read.
- Result workflow: iCloud syncs the light tree (incl. `project.json` carrying
  `media_root: "${MEDIA}"`) to Mac B automatically. Plug the SSD into Mac B,
  ensure `${MEDIA}` is defined there → all media resolves. No path rewriting.
- **Volume-name caveat:** macOS mounts at `/Volumes/<VolumeName>` and appends
  " 1" on name collisions. Because `${MEDIA}` is a per-machine Named Root, the
  user points it at the actual mount on each Mac — this absorbs any naming
  differences. Document it.

---

## 4. Graceful degradation (SSD not plugged in)
Mirror the EXISTING `external_final_video_root` pattern ("only use the external
root when it ACTUALLY EXISTS on THIS machine", `timestamp-video-assemble.ts:165`),
but for media we choose **fail-loud, not silent-fallback** — silently writing
media back into iCloud would split one episode's media across two locations.

- Light operations (scripts, metadata, prompts, ideas) always work — they never
  touch the media root.
- Any media read/write when `media_root` is set but unresolvable/missing →
  clear actionable error: *"Media root ${MEDIA} isn't available — plug in the
  drive or define ${MEDIA} in Settings → Named Roots."* (Same shape as the
  existing pool "plug in the SSD" errors.)
- A cheap preflight on the Video Assembly page (and pipeline batch start) warns
  up front if `${MEDIA}` is unresolvable, before queueing media jobs.

---

## 5. Migration (existing episodes already have media in iCloud)
A one-off, **per-project, reversible** tool — same care as the script importer:
1. **Dry-run** lists every heavy subfolder it would move, total bytes, and any
   collisions/missing.
2. Move heavy subfolders from `<episodes>/…/EP#### - …/{heavy}` → the mirrored
   path under `${MEDIA}`. Copy-then-verify-then-delete (never delete first;
   atomic per folder). Resumable.
3. Rewrite portable paths in sidecars/presets that pointed into the moved
   media (`${PROJECT}/… → ${MEDIA}/…`) via `toPortablePath`.
4. Set `media_root` on the project only after a clean pass.
Offer a reverse (SSD → iCloud) for safety. Surface it in Settings → Storage, not
auto-run.

---

## 6. UI (Settings → Storage, per project)
- A "Media storage" control: **iCloud / project default** (selected, the
  no-op default) vs **External media root** → pick/define a Named Root.
- Inline link to define `${MEDIA}` in Named Roots, with a live "resolves to
  /Volumes/… ✓ / not found ✗ on this Mac" indicator.
- A "Move existing media to the external root…" button → the §5 migration with
  its dry-run preview.
- Copy that frames it as optional/advanced, with the backup caveat (a single
  SSD isn't backed up like iCloud — recommend a second SSD / periodic copy).

---

## 7. Edge cases
- **B-roll/image-pool materialize** now writes scene_NNNN onto the SSD media dir
  automatically (resolves images dir via the media-aware helper) — closes the
  original "it copied into iCloud" complaint.
- **Mixed projects:** some projects split, others not — fine, it's per-project.
- **Marked-done (`✅ `) subfolders:** the media-aware resolver still goes through
  `resolveSubfolder`, so `✅ `-prefix tolerance is preserved.
- **Backup:** documented; out of app scope (suggest second SSD / Time Machine on
  the media volume).
- **No double-write:** when `media_root` is set, heavy media exists ONLY on the
  SSD — never also in iCloud. (Migration deletes the iCloud copies after verify.)

---

## 8. Build order (each shippable; default-off throughout)
1. `media_root` config field + `HEAVY_SUBFOLDERS` + `resolveAssetPath` of the
   token; make `resolveEpisodePaths` media-aware (§2a). With no field set,
   byte-for-byte identical output. + unit tests proving the no-op default.
2. `resolveEpisodeSubfolderDir` helper; refactor the bypass call sites (§2b),
   one generator at a time, each verified.
3. Portable-path storage audit for media sidecars (§3).
4. Graceful-degradation errors + preflight (§4).
5. Settings → Storage UI + Named Root indicator (§6).
6. Migration tool with dry-run (§5).

Steps 1–2 are the core; after them a hand-edited `media_root` already works for a
new/empty project (good for dogfooding before the UI + migration exist).

---

## 9. Testing
- `resolveEpisodePaths`: no `media_root` → identical to today (snapshot). With
  `media_root` → heavy dirs under media base, light dirs unchanged.
- Portable round-trip for `${MEDIA}` paths (resolve→collapse→resolve).
- Degradation: media op with unresolvable `${MEDIA}` throws the actionable error;
  light ops still succeed.
- Migration: dry-run counts match; move is copy-verify-delete; reversible.
