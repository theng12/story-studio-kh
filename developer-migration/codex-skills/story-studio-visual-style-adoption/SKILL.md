---
name: story-studio-visual-style-adoption
description: Use when a user asks to match, recreate, add, ship, audit, or wire a visual or art style into Story Studio KH as a standalone Visual Style Content Pack.
---

# Story Studio Visual Style Adoption

Turn one reusable visual language into one independently purchasable Visual Style Content Pack. Story Studio has no ordinary built-in style lane: the visible Style Library contains only signed styles published by the Content Pack runtime.

## Workflow

1. Read the repository `AGENTS.md`, `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`, and `$story-studio-content-pack-authoring`; inspect `git status` and preserve unrelated work.
2. Inspect every supplied reference. Describe medium, line quality, shape language, palette, lighting, composition, subject grammar, environments, text treatment, and recurring motifs.
3. Compare the proposed contract with existing signed Visual Style documents under `content-packs/**/style/**/content/visual-style.json`. Visual similarity is acceptable when the new rendering contract is visibly and distinctly differentiated. Reject only indistinguishable duplicates or mere renames; do not treat similarity alone as a correction request. Preserve originality, composition-copy, identity, safety, and commercial gates.
4. Consume only the parent workflow's registry-issued Story identity, reservation revision/receipt, brief, and separate family/SKU stocking proposal. Never invent or renumber identities.
5. Define a concise name and description, one broad category, at least three useful search tags, a content-independent `style_bible`, a provider-friendly `negative_prompt`, and compatibility metadata supported by evidence.
6. Obtain one original 16:9 preview only from owner-supplied original bytes or a Studio Hub production-preview handoff. This control Mac must not invoke production image generation.
7. Save the verified 1672x941 WebP over 20 KB in the pack's `assets/` directory and declare it in `content/visual-style.json`. Record provenance, rights, SHA-256, decoding result, dimensions, and file size; do not invent missing evidence.
8. Author exactly one standalone pack. Do not create a Channel Kit, `bundle_id`, coordinator product, shared entitlement, or dependency merely because another Formula, Topic Pack, or Thumbnail Recipe is compatible.
9. Do not add a static frontend style record or preview. `frontend/composables/useVisualStyleCatalog.ts` must remain a consumer of `/api/visual-styles`, with no built-in or offline fallback.
10. Verify schema, uniqueness, deterministic build, signed installation, catalog publication, search behavior, preview serving, and render-time persistence of both `style_bible` and `negative_prompt`.
11. Require independent visual and contract review. A style whose kind and schema are already supported is a content-only release: no app version, application changelog, DMG, or restart. Require an app release only when the style needs new Story runtime behavior, then name that behavior and its released minimum version.

## Canonical handoff

Return exactly one Visual Style handoff:

```text
status: authored-for-review
component: visual-style
release_classification: content-only | requires-app-release, with existing released runtime/minimum-floor evidence
reservation: registry location/revision + receipt reference
identity: exact registry-issued Story values only; bundle_id absent
stocking_proposal: family/SKU plus proposed|reserved|confirmed status and confirmation reference when confirmed
source: source root and declared content/assets
intent: reusable rendering contract
compatibility: compatible standalone packs and reasons; never bundle membership
dependencies: [] or exact technically required pack_id@version dependencies
originality_provenance: reference inventory, transformations, exclusions, asset origin/license
evidence:
  schema: passed | not_applicable | blocked
  coverage_uniqueness: passed | not_applicable | blocked
  golden_prompt_parity: passed | not_applicable | blocked
  decoded_previews: passed | not_applicable | blocked
  tests: passed | not_applicable | blocked
  deterministic_build: passed | not_applicable | blocked
review_requests: schema, originality/provenance, compatibility, prompt-equivalence/style-bible parity, independent visual, safety, copy, commercial-boundary
blocked_by: [] or explicit blockers
```

Every evidence field needs a concrete reference when passed, a reason when not applicable, or the missing gate when blocked. Candidate archives may use ephemeral test keys only. Do not populate live GenStudio fields, upload, publish, price, or stock anything without separate authority.

## Quality rules

- Prefer medium and rendering language before mood adjectives.
- Keep episode content, exact wording, named characters, and copied compositions out of a reusable style bible.
- Keep Visual Style and Thumbnail Recipe behavior separate.
- Never replace an existing preview unless the user explicitly requests a revision.
- Preserve project-local legacy `builtin-*` presets for old-project rendering, but never expose them as Style Library inventory.
