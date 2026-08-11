# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.0.818 — 2026-08-11

- **Approved episode direction now survives the complete script workflow** — outline edits keep
  their generation snapshot, chapter expansion and regeneration reuse the saved guidance, and
  affected v1.0.817 sidecars preserve any recoverable snapshot.

- **Manual chapter recovery is safe and usable** — fully settled failures can receive one fresh
  retry identity, while pending or mixed provider evidence reattaches with the original model and
  request identity. Partial chapter progress refreshes after every terminal outcome.

## v1.0.817 — 2026-08-11

- **Production release qualification is now deterministic** — the selected-model TTS fan-out check
  uses an in-process submission barrier instead of a timing window, while preserving the serialized
  pre-submit durability writes that protect recovery and prevent duplicate paid work. Production
  runtime behavior is unchanged.

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
