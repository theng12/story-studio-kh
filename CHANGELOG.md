# Story Studio KH — Changelog

What's new in each release. Newest first.

---

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

## v1.0.811 — 2026-08-09

- **The full production journey is easier to scan without hiding any destination** — the sidebar,
  current-step ribbon, and Production Board now share Story, Media, and Video phase labels. Every
  generator remains one click away, while long workflows and the wide status matrix no longer
  require memorizing an unbroken sixteen-stage list.

- **Dashboard priorities and progress now have distinct visual weight** — progress metrics form a
  compact status strip, while the first verified “Focus now” recommendation receives the strongest
  action treatment. The dashboard remains a progress overview and direct sidebar work stays intact.

- **Episode lists now recover visibly from load failures** — generator selectors keep any cached
  episodes available, explain when a refresh failed, and provide a direct Retry action instead of
  leaving an empty or indefinitely ambiguous selector.

## v1.0.810 — 2026-08-09

- **Production Board status cells now say what they mean to assistive technology** — symbolic
  checkmarks and circles reuse the existing episode, stage, state, and action descriptions as
  accessible names. The row-level import shortcut also names the episode it will receive, while
  the compact visual board remains unchanged.

## v1.0.809 — 2026-08-08

- **What’s New now stays focused on recent customer-visible changes** — the changelog keeps the
  latest five releases instead of carrying hundreds of test-era entries into the app and desktop
  package. Older release history remains available in Git when engineering archaeology is needed.

## v1.0.808 — 2026-08-08

- **Development and packaging dependencies now audit cleanly** — Electron Builder moves to
  26.15.3, bringing its packaging, archive, YAML and HTTP tooling onto patched releases. The
  twelve development-only advisories are resolved without changing Story Studio's production
  dependency set or generation behavior.

- **Retired direct-provider code no longer ships as dormant baggage** — unreachable Fish Audio,
  Pexels, Pixabay and NASA clients, unused endpoint-latency tracking, obsolete provider secrets,
  old research-provider aliases and dead fetch-result styling are removed. FFmpeg ZIP extraction
  now declares JSZip directly instead of keeping an unused DOCX package solely by accident.
  The unreachable Scripted B-Roll provider workflow, its always-unavailable routes and queue lane,
  stale draft specification, and unused UI are also gone. Local B-Roll import, review, provenance,
  normalization and assembly remain intact.

## v1.0.807 — 2026-08-08

- **Voice browsing now follows the selected model** — ElevenLabs models expose only the
  ElevenLabs public library, Fish Audio exposes only Fish Audio, and models without a linked
  public library no longer show unrelated provider tabs. The compatible voice list remains
  scoped by GenStudio's authoritative `model_id` catalogue.

- **Cloned-voice guidance and long libraries are clearer** — cloning-capable models explain that
  compatible copies created in GenStudio appear in that model's voice list. The overlapping
  Previous/Next pager is replaced by one “Load more voices” action when another page exists.
