# Story Studio KH — what it is

Story Studio KH is a personal-use macOS desktop app for producing long-form YouTube
episodes: ideas and scripts, generated images, narration, subtitles, video assembly,
thumbnails and upload. It also installs signed Content Packs sold through the
GenStudio Content Store.

## What it does

- Turns ideas into scripts with per-chapter structure, then generates scene image
  prompts and stills through the configured model service.
- Generates TTS narration per chapter, merges chapters with music and background
  audio, and runs a subtitle timeline check that warns rather than blocking
  publication.
- Builds a YouTube package with title, description, tags, measured chapters and
  real sources, then assembles the MP4 and uploads it.
- Keeps B-Roll and Image Pool as an independent pipeline: script, audio,
  subtitles, B-Roll selection, assembly, thumbnail and upload.
- Applies format and niche JSON rules per episode: script structure, visual style,
  vocabulary, metadata and reference packs are merged at runtime.
- Reads the live model catalogue on every selection change, so limits, prices,
  options and capability flags follow the chosen model rather than a cached
  constant.
- Runs a job queue with cancellation and history, and keeps the YouTube upload
  center and final-render provenance checks.
- Installs signed Content Packs with signing, delivery attestation and entitlement
  checks; this customer-facing path is live.
- Can run headless in server mode over Tailscale, driven from a remote browser.
  The macOS arm64 build is ad-hoc signed, so a first launch may need its quarantine
  flag cleared.

## How it is built

Electron main process in TypeScript (`electron/`), Express API, generators and
services (`electron/server/`), Nuxt SPA (`frontend/`), installable style and story
packs (`content-packs/`), native helpers (`native/`) and DMG/release scripts
(`packaging/`, `scripts/release/`).

Build all checked release gates and bundles with:

    npm run build

The unsigned smoke DMG is made with `npm run dist`.

## Where it fits

Story Studio sends generation requests only to GenStudio/GatewayKH and reads its
catalogue live; it does not call Studio Hub, sibling studios or upstream providers
directly. It holds no user accounts or billing, but does check Content Store
entitlements. Episodes and jobs stay on this Mac, with optional server mode for
remote control.

## Current version

1.4.415, from the `version` field in `package.json`; the newest entry in
`CHANGELOG.md` is v1.4.415.
