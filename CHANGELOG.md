# Story Studio KH — Changelog

What's new in each release. Newest first.

---

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

## v1.0.806 — 2026-08-08

- **Model choices now use customer-facing names and clear plan groups** — LLM and image pickers
  no longer call the selected product a “GenStudio model.” Image and voice catalogs put models
  available through the Free plan first, followed by Paid-plan-only models, using GenStudio’s
  published Unlimited Relaxed eligibility instead of model-name rules.

- **Provider identity is easier to scan without becoming routing logic** — the shared picker shows
  each published provider as a compact line below the model name. Voice providers appear now;
  image and LLM creators will appear automatically when GenStudio publishes that field, and Story
  Studio never guesses a company from a product name.

## v1.0.805 — 2026-08-08

- **The keyboard skip link stays out of sight until it is needed** — its shared accessibility
  styling now applies to both application layouts, fixing the stray “Skip to main content” text
  above the macOS window controls while preserving keyboard focus behavior.
