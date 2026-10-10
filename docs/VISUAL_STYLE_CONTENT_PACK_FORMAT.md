# Story Studio KH Visual Style Content Pack Format

Reusable looks are standalone, independently purchasable Visual Style Content Packs. The visible Style Library contains the signed styles published by the Content Pack runtime, followed by any user style pack styles (below). There is no static built-in catalog and no offline fallback.

## Source of truth

- Product source: `content-packs/<collection>/style/<slug>/`
- Manifest: `pack.json`
- Runtime document: `content/visual-style.json`
- Preview: `assets/<slug>.webp`
- Frontend consumer: `frontend/composables/useVisualStyleCatalog.ts`
- Authoring workflow: `developer-migration/codex-skills/story-studio-visual-style-adoption/SKILL.md`

Do not add style records or previews under `frontend/`. The backend publishes installed and entitled styles through `/api/visual-styles`; all Style Library surfaces consume that response.

## Runtime document

Use a registry-issued qualified id and the Content Pack schema. A style document includes a concise name and description, one broad category, useful search tags, a content-independent `style_bible`, a conflict-focused `negative_prompt`, compatible formula ids when known, and a pack-relative preview asset.

`category` is a concise, author-defined classification validated by the signed Content Pack schema. Existing examples include `Digital`, `Explainer`, `Illustration`, `Realistic`, `Natural world`, and `Editorial psychology`; that list is not exhaustive. Use tags for narrower media, moods, or techniques.

## Prompt rules

The `style_bible` describes repeatable rendering traits: medium, edges and shapes, palette, lighting, texture, subject design, framing, and atmosphere. Keep named characters, channel names, episode subjects, exact captions, model ids, provider syntax, and copied compositions out of it. The negative prompt should reject genuinely conflicting traits without suppressing valid scene content.

## Preview rules

- Use an original 16:9 example generated from the exact style direction, without important text, logos, or watermarks.
- Store a 1672x941 WebP over 20 KB in the pack's `assets/` directory.
- Record provenance, rights, SHA-256, decoding result, dimensions, and file size.
- The preview must be present and declared by `preview_assets`; missing or undecodable bytes block release.
- This control Mac verifies preview handoffs but does not perform production image generation.

## Add a style safely

1. Use `story-studio-visual-style-adoption` and `story-studio-content-pack-authoring`.
2. Compare the proposed contract with existing signed Visual Style sources; extend an existing style when the contract is not meaningfully distinct.
3. Reserve the standalone identity in the authoring registry. Do not create a kit, bundle, shared entitlement, or dependency for mere compatibility.
4. Author the manifest, runtime document, pack-local preview, and provenance record.
5. Validate schema, asset decoding, contract uniqueness, deterministic build, signed installation, `/api/visual-styles` publication, search behavior, and render-time positive/negative prompt persistence.
6. Update version and changelog only when shipping an app release.

Existing projects may retain `builtin-*` identifiers in project-local `style_presets`. That compatibility data remains renderable but must never be reintroduced into the visible library.

## User style packs (v1.4.277)

A user style pack is the owner's own looks, shared by every project on one Mac. It is unsigned, has no preview images, and is never sold, pinned or synced.

- Import or replace: `POST /api/user-style-packs` with the pack JSON; list: `GET /api/user-style-packs`. Stored as `<content-pack runtime root>/user-style-packs/<pack_id>.json`.
- Format (`UserStylePackSchema` in `electron/server/content-packs/schemas.ts`): `{ "user_pack_format": 1, "pack_id", "name", "version", "description"?, "styles": [...] }`. Each style is a `visual-style` document without `preview_assets`, with an optional `negative_prompt`, and an id that starts with `<pack_id>.`. Ids in the `com.storystudio.` namespace are refused.
- `/api/visual-styles` lists these styles after the signed ones with `preview_image: ""`. Picking one copies its text into the project's `style_presets`, exactly like a custom style, so rendering never depends on the pack file.
