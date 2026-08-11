# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.0.816 — 2026-08-11

- **Web research evidence is now more transparent** — provider-reported source URLs stay with the run and appear as evidence without incorrectly claiming that a source-less result has no sources. Only safe HTTP(S) links are clickable.

- **GenStudio capacity and job states now fail safely and read clearly** — temporary or malformed capacity data limits submissions to five per minute, while real job states use clear labels.

- **TTS now follows each selected model's published submit concurrency** — missing or invalid values remain serial, while supported providers can process sections faster without inferring capability from the provider name.

## v1.0.815 — 2026-08-11

- **Image Generator episode loading now scales cleanly** — each episode exposes exact planned scene-image counts from the existing status scan, so all-image completion no longer depends on Scene Review approval and the extension no longer needs an episode-by-episode recount.

## v1.0.814 — 2026-08-10

- **The desktop interface now uses the secured Nuxt 4.5 foundation** — the framework, Vue
  tooling, CSS processing, SVG optimization, archive handling, and related build dependencies
  are updated to patched releases. The eight published frontend advisories are cleared without
  changing Story Studio's production workflow or GenStudio contract.

## v1.0.813 — 2026-08-10

- **Story Studio now matches GenStudio's current customer contract** — retired Unlimited
  Relaxed fields, free/paid grouping, badges, and account-access copy are gone. Model menus use
  neutral modality groups and only show provider identity that GenStudio actually publishes.

- **Transcription choices now fail safely before paid work** — languages come from the selected
  live model, Auto-detect appears only when explicitly published, and stale or unsupported
  choices cannot be enqueued. A missing provider remains unknown instead of being relabelled as
  GenStudio KH.

- **Pricing, research evidence, and job outcomes are more truthful** — TTS pricing follows the
  selected model and GenStudio quotes rather than voice rows; searched runs without structured
  sources remain successful without being called model knowledge; transient diagnostic codes no
  longer look terminal; and exact image content refusals offer a manual Reword path.

## v1.0.812 — 2026-08-10

- **Evidence-led historical documentaries are now a complete reusable channel system** — the new
  Hidden Mechanics of History Formula combines five distinct Topic Packs with causal-reconstruction
  structure, 30–45 minute pacing, source-aware writing rules, and enough planned variation for more
  than 1,000 non-duplicate episode concepts. Ancient Civilizations remains available as an optional
  compatible lane.

- **Archival history now has coordinated scene and thumbnail identities** — Archival Documentary
  Reconstruction joins the visual-style library with an original preview, while Archival Map
  Investigation adds three browsable thumbnail examples, AI-rendered episode titles, and safeguards
  against unsupported conspiracy, scapegoating, and sole-cause claims.

- **Video Assembly can create an aged archive-film finish without a missing overlay asset** — the new
  built-in effect procedurally adds restrained archival grading, grain, dust, scratches, flicker, and
  gate weave. It persists through presets and Pipeline jobs while remaining independently selectable
  from color grading, vignette, and the existing film-grain control.
