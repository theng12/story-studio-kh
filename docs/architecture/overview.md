# Story Studio KH — Architecture

The mental map of this codebase. Read this first when debugging or planning a change. Last reviewed: 2026-05-21 (v1.0.114); "What this app is" corrected 2026-09-02 (v1.4.95).

---

## What this app is

A personal-use desktop content-production pipeline for a single operator producing long-form YouTube content across multiple channels (sleep stories, prayer, devotional, listicles, etc.). It runs as an Electron app on a Mac mini M4 and can optionally expose itself headless over Tailscale ("server mode") so the same backend can be driven from a remote browser.

**Not:** a SaaS. Not multi-tenant. Story Studio itself holds no accounts or billing. It is no longer purely personal-use, though: it installs signed Content Packs that customers buy through GenStudio's Content Store, and the signing, delivery-attestation and entitlement code under `electron/server/content-store/` and `electron/server/content-packs/` is live and customer-facing — not scaffolding, not slated for removal.

---

## The three big pieces

```
┌─────────────────────────────────────────────────────────────────────┐
│  Electron main process    (electron/main.ts)                        │
│  - Owns the BrowserWindow + the HTTP server port                    │
│  - Single-instance lock, navigation lockdown, crash recovery         │
│  - In production: serves the SPA static files + Express API         │
│  - In dev: loads localhost:3000 (Nuxt dev), backend on :8791        │
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

The format JSON declares one live `visualSource`: `timestamp-driven`, `continuity-chain`, or `narrated-scenes`. This field gates the active narration-timed scene workflow. B-Roll and Image Pool remain available as independent route, asset, preset, and assembly workflows; they are not format values.

### Pipeline A: Active narration-timed scene workflows

```
ideas (titles+loglines+themes)
  → script (intro + chapters)
  → image-prompts (one per scene)
  → images (AI-generated stills via GenStudio KH)
  → audio (TTS narration per chapter via GenStudio KH)
  → audio-merge (chapters → single track + music + bg)
  → subtitles (timeline verification; warning-only for publishing)
  → YouTube Finalizer (one title/description/tags package + measured chapters + real sources)
  → video assembly (stills + audio + transitions → mp4)
  → thumbnail (template-driven, separate from scenes)
  → youtube upload
```

Frontend: `/projects/:slug/{ideas,scripts,image-prompts,images,audio,audio-merge,video-assembly,metadata,upload}`

### Pipeline B: B-Roll and Image Pool workflows (independent of Format)

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

The `broll.vue` route preserves pool selection and final assembly independently of the active format scene workflow.

---

## Format + Niche merge model

This is the second-most-important fact. Niches don't run their own pipeline — they OVERRIDE / EXTEND format behaviour at runtime via `applyNicheToFormat()` in `electron/server/services/format-loader.ts`.

```
Format JSON (e.g. continuity-chain.json)
  ├─ idea: { systemPrompt, vocab pools, title shape rules }
  ├─ script: { defaultChapterCount, pacingArc, narratorStyles, ... }
  ├─ imagePrompts: { visualStyle, sceneCount, characterReferenceMode }
  ├─ metadata: { titleRules, tagRules, descriptionTemplate }
  ├─ visualSource: 'timestamp-driven' | 'continuity-chain' | 'narrated-scenes'
  └─ productionStandardsAddendum
         │
         │  applyNicheToFormat(format, niche)
         │  merges niche overrides into format clone
         ▼
Niche JSON (e.g. prayer.json)
  ├─ vocabulary (mood/theme/genre/keyword pools → merged into format vocab)
  ├─ visualStyleSheet (appended when the active workflow uses image prompts)
  ├─ scriptContext (injected into script generator system prompt)
  ├─ audienceHint, titleShapeRules, themeShapeRules
  ├─ scriptStructure (chapter overrides, e.g. devotionals = 3 chapters)
  ├─ metadataDescription (description template override)
  ├─ recencyAvoidance (cross-episode dedup: scripture refs, key phrases)
  └─ referenceImages (style packs)
```

**Niches never override `visualSource`.** The active narration-timed scene workflow is format-level; B-Roll and Image Pool stay independent operational routes.

---

## Generators (`electron/server/generators/`)

The workflow labels below are not `Format.visualSource` values: active
narration-timed scenes use the three-value union above, while B-Roll and Image
Pool remain independent operational workflows.

| Generator | Workflow | What it does |
|---|---|---|
| `episode.ts` | active scene + independent B-Roll/Image Pool | Orchestrator. Invokes intro/script/metadata/image-prompts in sequence |
| `image-prompts.ts` | active narration-timed scenes | One prompt per scene from format scene-count config |
| `images.ts` | active narration-timed scenes | GenStudio KH image calls; per-scene retries; sidecar manifest |
| `audio.ts` | active scene + independent B-Roll/Image Pool | TTS via GenStudio KH; chunked per-paragraph; sidecar |
| `audio-merge.ts` | active scene + independent B-Roll/Image Pool | Concat chunks + intro + music bed + loudness normalize |
| `metadata.ts` | active scene + independent B-Roll/Image Pool | Late-stage YouTube Finalizer: title, description, tags, measured chapter timestamps, selected real sources, and a warning-only subtitle audit |
| `video.ts` | active narration-timed scenes | ffmpeg concat of stills + audio + transitions |
| `broll-assemble.ts` | independent B-Roll/Image Pool | ffmpeg concat of pool clips + narration + music |
| `broll-autotag.ts` | independent B-Roll/Image Pool prep | Tags pool clips with mood/scene labels via vision model |
| `broll-normalize.ts` | independent B-Roll/Image Pool prep | Pre-renders pool clips to common codec/aspect for fast concat |
| `subtitles.ts` | active scene + independent B-Roll/Image Pool | SRT generation from audio sentence-level timing |
| `youtube-upload.ts` | active scene + independent B-Roll/Image Pool | YouTube Data API publish |

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
├── <slug>/                          (e.g. my-channel/)
│   ├── project.json                 (format_id, niche_id, name, season config, etc.)
│   ├── config.json                  (per-project settings, overrides, api keys → DEPRECATED, app-level now)
│   ├── secrets.json                 (YouTube OAuth tokens only — no API keys)
│   ├── jobs.json                    (job queue state, persistent across restarts)
│   ├── episodes/
│   │   ├── EP0001/
│   │   │   ├── script.json
│   │   │   ├── image_prompts.json
│   │   │   ├── scenes/              (active narration-timed scene workflows)
│   │   │   │   ├── 01.png … 30.png
│   │   │   │   └── manifest.json    (sidecar — task IDs for Repair)
│   │   │   ├── audio/
│   │   │   │   ├── chunks/          (per-paragraph TTS output)
│   │   │   │   ├── manifest.json    (task IDs for audio-repair)
│   │   │   │   └── merged.mp3
│   │   │   ├── broll-selection.json (independent B-Roll/Image Pool workflow)
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

Active AI requests use GenStudio KH as Story Studio's external generation boundary. `electron/server/lib/genstudio-client.ts` owns the public GenStudio API contract; the registered text/image/video adapters live under `electron/server/providers/{text,image,video}/genstudio.ts` and are bootstrapped by `electron/server/boot/providers.ts`. The active workflows cover text, images, image-to-video, TTS, transcription, and music. YouTube publishing remains a separate integration through `electron/server/lib/youtube-client.ts`.

GenStudio owns model inventory, published capabilities, provider routing, and pricing. Story Studio reads the live catalogue through the `list*Models` functions in `genstudio-client.ts`; the app-settings routes expose those modality-specific catalogues. Story Studio does not duplicate local provider model lists or choose a provider for a request.

The GenStudio API key is stored at app scope by `services/app-secrets-store.ts` and resolved with `getApiKey('genstudio')`. Project secrets retain YouTube OAuth tokens; AI provider keys are not project-owned.

---

## What's NOT in this doc

- Per-page UI implementation details — see the page source directly
- GenStudio request/retry/idempotency details — see `electron/server/lib/genstudio-client.ts`
- The visual editor for thumbnail templates — see `ThumbnailTemplateEditor.vue`
- The chunked-narration cache invariants — see `chunked-narration-*.test.ts`

If you find yourself adding more than 3 paragraphs about a single subsystem, that subsystem deserves its own doc.

---

## Where to look next

- **Adding a new format** → [`format-contract.md`](format-contract.md)
- **A bug seems format-related** → [`pipeline-audit.md`](../history/pipeline-audit.md) (lists every place format/niche assumptions live)
- **Understanding a specific generator** → the generator file's top comment
- **The provider API contracts** → service client file headers
