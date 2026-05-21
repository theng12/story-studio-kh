# Story Studio KH — Pipeline Audit

A living list of every place in the codebase that makes format/niche-specific decisions. When you fix a bug that turns out to be "this code assumed sleep-story", log it here so the next person (or future you) sees the pattern and finishes the audit.

Last reviewed: 2026-05-21 (v1.0.114).

For the big picture see [ARCHITECTURE.md](ARCHITECTURE.md). For schema details see [FORMAT_CONTRACT.md](FORMAT_CONTRACT.md).

---

## Status key

| Symbol | Meaning |
|---|---|
| ✅ | Format-aware. Reads the relevant flag and branches correctly |
| ⚠️ | Partially format-aware. Some cases handled, others missing — see notes |
| ❌ | Format-unaware. Assumes a specific format/pipeline. Bug waiting to happen |
| 🔵 | Format-agnostic by design. No branching needed |

---

## Sidebar + page-mount gates

| Location | Status | Notes |
|---|---|---|
| `frontend/layouts/dashboard.vue` — "Scene Prompts" entry | ✅ | Hidden when `isBroll` |
| `frontend/layouts/dashboard.vue` — "Scene Generator" entry | ✅ | Hidden when `isBroll` |
| `frontend/layouts/dashboard.vue` — "Thumbnail Prompts" entry | 🔵 | Both pipelines need thumbnails |
| `frontend/layouts/dashboard.vue` — "Thumbnail Generator" entry | 🔵 | Same |
| `frontend/layouts/dashboard.vue` — "Video Generator" entry | ✅ | v1.0.114 — hidden when `isBroll` |
| `frontend/layouts/dashboard.vue` — "Video Assembly" entry | ✅ | v1.0.114 — hidden when `isBroll` |
| `frontend/layouts/dashboard.vue` — "B-Roll Video" entry | ✅ | v1.0.114 (renamed from "B-Roll Picker") — shown only when `isBroll` |
| `frontend/layouts/dashboard.vue` — "Audio Generator" / "Audio Assembly" | 🔵 | Both pipelines need audio |
| `frontend/layouts/dashboard.vue` — Upload Center entries | 🔵 | Both pipelines publish |

---

## Frontend pages (project-scoped)

| Page | Status | Notes |
|---|---|---|
| `index.vue` (dashboard) | 🔵 | |
| `ideas.vue` | 🔵 | Renders niche/format vocab via API |
| `scripts.vue` | ✅ | Format mismatch banner (v1.0.108) catches chapter count mismatches |
| `image-prompts.vue` | ⚠️ | Loads fine for broll projects but renders no useful UI. Hidden from sidebar for broll — but URL-typing reaches it. **No wrong-pipeline banner here yet.** |
| `images.vue` | ⚠️ | Same as image-prompts. Sidebar-gated but no in-page banner |
| `audio.vue` | 🔵 | Both pipelines |
| `audio-merge.vue` | 🔵 | |
| `metadata.vue` | 🔵 | |
| `video.vue` (Video Generator) | ✅ | v1.0.114 — wrong-pipeline banner for `visualSource === 'broll'` |
| `video-assembly.vue` | ✅ | v1.0.114 — wrong-pipeline banner |
| `broll.vue` | ✅ | Only useful for broll formats; gracefully handles "no pool subscribed" empty state |
| `characters.vue` | 🔵 | Both pipelines may use characters |
| `assets.vue` | 🔵 | |
| `presets.vue` | 🔵 | |
| `settings.vue` | 🔵 | |
| `jobs.vue` | 🔵 | Job type drives behaviour, not format |
| `pipeline.vue` | ⚠️ | Pipeline batch executor. Does it skip image-prompts/scenes steps for broll projects? **NEEDS REVIEW** |
| `upload.vue` | 🔵 | |
| `thumbnail-templates.vue` | 🔵 | |

---

## Backend generators (`electron/server/generators/`)

| File | Status | Notes |
|---|---|---|
| `episode.ts` (orchestrator) | ⚠️ | Need to verify: does it skip image-prompts step for broll formats? **NEEDS REVIEW** |
| `image-prompts.ts` | 🔵 | Pipeline-A only — only invoked for scene-images formats (gated at the orchestrator) |
| `images.ts` | 🔵 | Same |
| `audio.ts` | 🔵 | Both pipelines |
| `audio-merge.ts` | 🔵 | Both pipelines |
| `metadata.ts` | 🔵 | Both pipelines |
| `video.ts` (scene-based assembly) | 🔵 | Pipeline-A only |
| `broll-assemble.ts` | 🔵 | Pipeline-B only |
| `broll-autotag.ts` | 🔵 | |
| `broll-normalize.ts` | 🔵 | |
| `subtitles.ts` | 🔵 | |
| `youtube-upload.ts` | 🔵 | |

---

## Backend routes (`electron/server/routes/`)

| File | Status | Notes |
|---|---|---|
| `video.ts` — `POST /generate/video` | ❌ | Requires `scenes.length > 0`. Correct for scene-images formats; broll callers shouldn't reach here. v1.0.114 banner in `video-assembly.vue` covers the UI; route-level check stays |
| `video.ts` — generator-level validation | ❌ | Same — `if (!req.scenes || req.scenes.length === 0) throw` |
| `broll-project.ts` | 🔵 | All endpoints are broll-pipeline-specific by URL prefix |
| `images.ts` | 🔵 | Image generation. Broll projects don't call this |
| `audio.ts` | 🔵 | Both pipelines |
| `metadata.ts` | 🔵 | |
| `scripts.ts` | 🔵 | |
| `ideas.ts` | 🔵 | |
| `pipeline.ts` | ⚠️ | Bulk pipeline runner. **NEEDS REVIEW** — does the step list skip image-prompts/scenes for broll projects? |

---

## Format-loader / merge model

| Location | Status | Notes |
|---|---|---|
| `electron/server/services/format-loader.ts` — `getEffectiveFormatFor` | ✅ | Resolution chain: project override → niche default → legacy inline → `DEFAULT_FORMAT_ID = 'sleep-story'` |
| Same — `applyNicheToFormat` | ✅ | Merges niche overlays into format clone. v1.0.108 multi-scope recency: `scriptContext` prepended to `script.systemPromptRole`; vocab merged; example topics replaced |
| Same — `DEFAULT_FORMAT_ID = 'sleep-story'` fallback | ⚠️ | Safe for tests / dry-runs. **Should never appear in user-visible code paths** — if a project's format_id resolves to this, the project's resolution chain broke |

---

## Recency tracker (cross-episode dedup)

| Location | Status | Notes |
|---|---|---|
| `electron/server/services/recency-tracker.ts` | ✅ | Scope-aware (v1.0.108) — supports `script`, `titles`, `image_prompts`, `metadata` scopes. Each niche declares which scopes its `recencyAvoidance` rule applies to |
| Backend usage — `generators/script-*.ts` | ✅ | `prependAvoidanceToPrompt(slug, 'script', prompt)` + `recordUsageForScope(slug, episode, 'script', text)` |
| Backend usage — `generators/metadata.ts` | ✅ | Same pattern with scope `'metadata'` |
| Backend usage — `generators/image-prompts.ts` | ✅ | Same pattern with scope `'image_prompts'` |
| Backend usage — titles in metadata | ✅ | Scope `'titles'` |
| Recency log management page | ✅ | `/projects/:slug/recency` (v1.0.108) |

---

## Thumbnail templates

| Location | Status | Notes |
|---|---|---|
| `electron/server/routes/thumbnail-templates.ts` | 🔵 | App-level + per-project library, format-agnostic |
| `ThumbnailTemplatePicker.vue` | ✅ | Respects `niche.defaultThumbnailTemplateId` if set; sorts recommended templates first |
| `ThumbnailTemplateEditor.vue` | 🔵 | Visual editor — format-agnostic; built-ins fork to user library on first save |

---

## Job queue + execution

| Location | Status | Notes |
|---|---|---|
| `electron/server/boot/executors.ts` | 🔵 | Each job type maps to a generator. The mapping is type → generator, not format → generator |
| `frontend/pages/projects/[slug]/jobs.vue` — Repair vs Retry | ✅ | v1.0.114 — split into two buttons. Repair only shown for `audio`, `images`, `scene_images`, `thumb_images`, `video` job types |
| Restart-recovery banner — bulk Repair | ✅ | v1.0.114 — fans out to `repairJobOnly` (safe). Filters out non-repairable job types from the count |

---

## Server-mode flow

| Location | Status | Notes |
|---|---|---|
| `frontend/composables/useServerMode.ts` — `isServerMode()` | ✅ | Hostname-based since v1.0.110 (was meta-tag, broke for per-route HTML) |
| `useApi.ts` — 401 redirect handler | ✅ | v1.0.112 — trailing-slash tolerant + re-entrancy guard |
| `app.vue` — WNM auto-popup gate | ✅ | v1.0.112 — defers until `initServerMode()` resolves + `isAuthenticated` |
| `frontend/components/ServerModeBanner.vue` — visibility | ✅ | v1.0.112 — trailing-slash tolerant |
| `electron/main.ts` — index serving | ✅ | v1.0.111 — `readFileSync` (ASAR-safe), no transform; v1.0.112 disabled static `redirect:` |
| Credentials form — lockout | ✅ | v1.0.109 — removed; Confirm Password field replaces typo defense |

---

## Known gaps (TODO)

These are the ⚠️ entries above, in priority order. Tackle when surfacing as bugs OR when bored.

1. **`pipeline.ts` (frontend) + `pipeline.ts` (backend route)** — verify the batch step list skips `image_prompts` and `images` steps for broll formats. If it doesn't, a "Generate everything" bulk run on a broll project would either fail silently or waste time
2. **`episode.ts` orchestrator** — same question. The orchestrator invokes the generator chain; needs explicit branching on `visualSource`
3. **`image-prompts.vue` page** — broll projects shouldn't render this page meaningfully. Add a wrong-pipeline banner (mirror the one in video.vue)
4. **`images.vue` page** — same — wrong-pipeline banner for broll projects
5. **`DEFAULT_FORMAT_ID = 'sleep-story'` audit** — grep for this constant; verify every reader has a comment explaining why falling through to it is safe in their specific context

---

## When you find a new format-aware code location

Add a row to the appropriate table above. Use the status key. Include:
- File path + (optionally) line numbers
- Brief note on what it does
- If ⚠️ or ❌, link the bug or describe what's missing

This file is **only useful if it stays current**. The goal isn't exhaustive cataloging — it's that the next time you fix a bug like "broll requires scenes", you check this list first and either confirm it was the last gap OR finish the audit while the context is fresh.

---

## History of audited bugs

Brief log of bugs whose fix involved adding format/niche awareness somewhere. New entries at the top.

| Version | Bug | Fix | File touched |
|---|---|---|---|
| v1.0.114 | B-Roll project shows Video Assembly / Video Generator in sidebar (dead-end with "At least 1 scene required") | Hide both entries when `isBroll`; rename "B-Roll Picker" to "B-Roll Video"; add wrong-pipeline banners on `/video` + `/video-assembly` | `dashboard.vue`, `video.vue`, `video-assembly.vue` |
| v1.0.114 | Jobs page "Repair & Retry" combined button caused duplicate provider submissions when repair failed mid-flight | Split into two buttons (Repair + Retry); add `repairJobOnly` function; bulk-recovery banner uses safe path | `jobs.vue` |
| v1.0.108 | Niche `exampleTopics` not appearing in idea generation; recency tracker only scanned scripts | `applyNicheToFormat` now replaces format's `exampleIdeas` with niche's `exampleTopics`; recency-tracker became scope-aware (script/titles/image_prompts/metadata) | `format-loader.ts`, `recency-tracker.ts` |
| v1.0.106 | Niche-level chapter count mismatch not surfaced in script editor | Added mismatch banner above outline-review panel | `scripts.vue` |
| v1.0.107 | Electron desktop window saw "remote browser" code paths (meta-tag check fired for loopback) | Added `window.electron.isElectron` marker via preload | `useServerMode.ts`, `preload.cjs` |
| v1.0.93+ | Listicle projects opened video-assembly with sleep-story 10s/scene defaults | `applyVideoFormatDefaultsIfNoPreset` reads `script.videoDefaults.{secondsPerScene,transitionType,transitionDurationSec}` | `video-assembly.vue` |
| v1.0.93+ | Sidebar showed Scene Prompts / Scene Generator for broll projects | Hide both when `isBroll` (format `visualSource === 'broll'`) | `dashboard.vue` |
