# Story Studio KH — Architecture

The mental map of this codebase. Read this first when debugging or planning a change. Last reviewed: 2026-05-21 (v1.0.114).

---

## What this app is

A personal-use desktop content-production pipeline for a single operator (`theng12`) producing long-form YouTube content across multiple channels (sleep stories, prayer, devotional, listicles, etc.). It runs as an Electron app on a Mac mini M4 and can optionally expose itself headless over Tailscale ("server mode") so the same backend can be driven from a remote browser.

**Not:** a SaaS. Not multi-tenant. No paying customers. The license/DRM scaffolding is dead code (see [project_personal_use](memory) — slated for removal).

---

## The three big pieces

```
┌─────────────────────────────────────────────────────────────────────┐
│  Electron main process    (electron/main.ts)                        │
│  - Owns the BrowserWindow + the HTTP server port                    │
│  - Single-instance lock, navigation lockdown, crash recovery         │
│  - In production: serves the SPA static files + Express API         │
│  - In dev: loads localhost:3000 (Nuxt dev), backend on :8000        │
└────────────────────────┬────────────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         │                               │
┌────────▼────────────────┐    ┌─────────▼─────────────────────────┐
│  Express API backend    │    │  Nuxt SPA frontend                │
│  electron/server/       │    │  frontend/                        │
│  - Routes (REST)        │    │  - Pages (project-scoped + app)   │
│  - Generators (jobs)    │    │  - Composables (useApi, etc.)     │
│  - Services (provider   │    │  - Components                      │
│    clients, file I/O)   │    │  - Layouts (default, dashboard)   │
│  - Job queue + executor │    │                                    │
└─────────────────────────┘    └────────────────────────────────────┘
```

---

## The two big pipelines

The format JSON declares `visualSource: 'scene-images' | 'broll'`. This single field gates which pipeline runs. **This is THE most important architectural fact in the app.**

### Pipeline A: Scene-images (sleep-story, adventure, documentary, listicle, bound-explainer, kids-fairytale, comedy, educational, true-crime)

```
ideas (titles+loglines+themes)
  → script (intro + chapters)
  → image-prompts (one per scene)     ← format declares scenes per chapter
  → images (AI-generated stills via Fal/Stability/etc.)
  → audio (TTS narration per chapter via ElevenLabs / GenAIPro)
  → audio-merge (chapters → single track + music + bg)
  → subtitles (timeline verification; warning-only for publishing)
  → YouTube Finalizer (one title/description/tags package + measured chapters + real sources)
  → video assembly (stills + audio + transitions → mp4)
  → thumbnail (template-driven, separate from scenes)
  → youtube upload
```

Frontend: `/projects/:slug/{ideas,scripts,image-prompts,images,audio,audio-merge,video-assembly,metadata,upload}`

### Pipeline B: B-Roll narration (broll-narration format used by prayer, devotional, preaching, mindfulness, motivation, philosophy)

```
ideas
  → script (single long-form narration, defaultChapterCount: 1)
  → audio (TTS)
  → audio-merge
  → subtitles
  → YouTube Finalizer
  → broll picker (selects clips from an app-level pool)
  → broll-assemble (concatenates clips + narration + music → mp4)
  → thumbnail
  → youtube upload
```

Frontend: `/projects/:slug/{ideas,scripts,audio,audio-merge,broll,metadata,upload}`

**No image-prompts, no images, no scene-based video assembly.** The `broll.vue` page does BOTH selection AND final video output in one place.

---

## Format + Niche merge model

This is the second-most-important fact. Niches don't run their own pipeline — they OVERRIDE / EXTEND format behaviour at runtime via `applyNicheToFormat()` in `electron/server/services/format-loader.ts`.

```
Format JSON (e.g. broll-narration.json)
  ├─ idea: { systemPrompt, vocab pools, title shape rules }
  ├─ script: { defaultChapterCount, pacingArc, narratorStyles, ... }
  ├─ imagePrompts: { visualStyle, sceneCount, characterReferenceMode }
  ├─ metadata: { titleRules, tagRules, descriptionTemplate }
  ├─ visualSource: 'scene-images' | 'broll'
  └─ productionStandardsAddendum
         │
         │  applyNicheToFormat(format, niche)
         │  merges niche overrides into format clone
         ▼
Niche JSON (e.g. prayer.json)
  ├─ vocabulary (mood/theme/genre/keyword pools → merged into format vocab)
  ├─ visualStyleSheet (appended to image prompts — irrelevant for broll)
  ├─ scriptContext (injected into script generator system prompt)
  ├─ audienceHint, titleShapeRules, themeShapeRules
  ├─ scriptStructure (chapter overrides, e.g. devotionals = 3 chapters)
  ├─ metadataDescription (description template override)
  ├─ recencyAvoidance (cross-episode dedup: scripture refs, key phrases)
  └─ referenceImages (style packs)
```

**Niches never override `visualSource`.** Pipeline choice is format-level, niches plug into whichever pipeline the format already declares.

---

## Generators (`electron/server/generators/`)

| Generator | Pipeline | What it does |
|---|---|---|
| `episode.ts` | both | Orchestrator. Invokes intro/script/metadata/image-prompts in sequence |
| `image-prompts.ts` | scene-images | One prompt per scene from format scene-count config |
| `images.ts` | scene-images | Fal/Stability calls; per-scene retries; sidecar manifest |
| `audio.ts` | **both** | TTS via ElevenLabs/GenAIPro; chunked per-paragraph; sidecar |
| `audio-merge.ts` | **both** | Concat chunks + intro + music bed + loudness normalize |
| `metadata.ts` | **both** | Late-stage YouTube Finalizer: title, description, tags, measured chapter timestamps, selected real sources, and a warning-only subtitle audit |
| `video.ts` | scene-images | ffmpeg concat of stills + audio + transitions |
| `broll-assemble.ts` | broll | ffmpeg concat of pool clips + narration + music |
| `broll-autotag.ts` | broll (prep) | Tags pool clips with mood/scene labels via vision model |
| `broll-normalize.ts` | broll (prep) | Pre-renders pool clips to common codec/aspect for fast concat |
| `subtitles.ts` | **both** | SRT generation from audio sentence-level timing |
| `youtube-upload.ts` | **both** | YouTube Data API publish |

Generators are wired to the job queue via `electron/server/boot/executors.ts`. Each generator is per-chunk idempotent: re-running skips chunks already on disk (the foundation of the Repair flow).

---

## Job queue

`electron/server/services/job-queue.ts` — in-process FIFO queue with per-type executors. Persistent (jobs.json sidecar) so the queue survives app restarts. Each job has:

- `type` (script-only, image_prompts, audio, audio_merge, video, broll_assemble, etc.)
- `episode_id` (which episode this targets)
- `status` (queued / running / done / error / cancelled)
- `params` (the original generator input — used by Retry)

**Repair vs Retry split (v1.0.114):**
- Repair button → polls provider for in-flight completed work (free); never resubmits
- Retry button → deletes the failed job and resubmits the original generator (charges)

The split exists because the combined "Repair & Retry" used to dupe-submit when Repair failed mid-flight.

---

## Project storage

Each project lives as a folder under `PROJECTS_ROOT` (configured in app-settings.json → `projects_root_override`, defaults to userData). Layout:

```
PROJECTS_ROOT/
├── <slug>/                          (e.g. abiding-faith/)
│   ├── project.json                 (format_id, niche_id, name, season config, etc.)
│   ├── config.json                  (per-project settings, overrides, api keys → DEPRECATED, app-level now)
│   ├── secrets.json                 (YouTube OAuth tokens only — no API keys)
│   ├── jobs.json                    (job queue state, persistent across restarts)
│   ├── episodes/
│   │   ├── EP0001/
│   │   │   ├── script.json
│   │   │   ├── image_prompts.json
│   │   │   ├── scenes/              (scene-images formats only)
│   │   │   │   ├── 01.png … 30.png
│   │   │   │   └── manifest.json    (sidecar — task IDs for Repair)
│   │   │   ├── audio/
│   │   │   │   ├── chunks/          (per-paragraph TTS output)
│   │   │   │   ├── manifest.json    (task IDs for audio-repair)
│   │   │   │   └── merged.mp3
│   │   │   ├── broll-selection.json (broll formats only)
│   │   │   ├── thumbnails/          (generated thumbs)
│   │   │   ├── final.mp4
│   │   │   └── metadata.json
│   └── ...
├── .thumbnail-templates/            (user-custom thumbnail layouts)
└── .recency-log/                    (per-project cross-episode dedup state)
```

App-level state lives separately at `~/Library/Application Support/Story Studio KH/`:
- `app-settings.json` — provider API keys, FFmpeg path, projects-root override, server-mode config, voice presets, broll pool registrations
- `app-secrets.json` — encrypted API keys
- `last-session.json` — last opened project (for "Restore on launch")
- `logs/server-YYYY-MM-DD.log` — daily request log + structured events

---

## Server mode vs desktop mode

Single boolean flag in `app-settings.json → server_mode.enabled` (or `STORY_STUDIO_SERVER_MODE=1` env var) flips the binding behaviour at boot:

| Mode | Binds | Auth | Frontend |
|---|---|---|---|
| Desktop (default) | 127.0.0.1:random-port | Loopback bypass (no login) | Loaded in Electron BrowserWindow |
| Server | 0.0.0.0:8765 (configurable) | Username + password + session cookie | Loaded from remote browser over Tailscale |

The frontend distinguishes them via `frontend/composables/useServerMode.ts:isServerMode()` — hostname-based (loopback = desktop). Used to gate:
- Native picker shim (server mode replaces OS folder/file dialogs with the in-app FileBrowserModal)
- Server-mode banner (shows "Signed in as X" + Sign Out)
- Login redirect on 401

`electron/server/lib/auth-session.ts` has the scrypt password hashing + HMAC-signed session cookie logic. Single user, single session-secret per credential change.

---

## Provider integrations

Located in `electron/server/services/` and `electron/server/lib/`:

| Provider | What for | Where |
|---|---|---|
| Anthropic (Claude) | Text generation (script, metadata, ideas) | `lib/ai-client.ts`, model picker |
| OpenAI (GPT) | Same | Same |
| GenAIPro | TTS narration | `services/genaipro-client.ts` |
| ElevenLabs | TTS narration | `services/elevenlabs-client.ts` |
| Fal.ai | Image generation | `services/fal-client.ts` |
| Stability | Image generation | `services/stability-client.ts` |
| YouTube Data API | Publish | `services/youtube-client.ts` |
| Local Ollama (potential) | LLM (proposed, not integrated) | n/a |

API keys live in `app-settings.json → providers` (encrypted in app-secrets.json). The model picker is per-task: scripts can use a different model than metadata, etc.

---

## What's NOT in this doc

- Per-page UI implementation details — see the page source directly
- Provider-specific quirks (e.g. how ElevenLabs voice cloning is set up) — see the service client
- The visual editor for thumbnail templates — see `ThumbnailTemplateEditor.vue`
- The chunked-narration cache invariants — see `chunked-narration-*.test.ts`

If you find yourself adding more than 3 paragraphs about a single subsystem, that subsystem deserves its own doc.

---

## Where to look next

- **Adding a new format** → [`format-contract.md`](format-contract.md)
- **A bug seems format-related** → [`pipeline-audit.md`](../history/pipeline-audit.md) (lists every place format/niche assumptions live)
- **Understanding a specific generator** → the generator file's top comment
- **The provider API contracts** → service client file headers
