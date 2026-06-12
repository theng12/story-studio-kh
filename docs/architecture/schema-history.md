# Schema history & live back-compat shims

A ledger of the data-shape migrations and **back-compat shims that are still
load-bearing** — the code paths that quietly convert old on-disk data to the
current shape at read time. `models/types.ts` carries ~100 version-stamped
comments; this doc is the checkable index of the ones that still matter, so a
refactor can tell "safe to remove" from "a real project still depends on this."

> Rule of thumb: **never remove a field from `types.ts`** — only deprecate it.
> Old `project.json` / `ideas.json` / sidecar files in the wild still carry
> fields written by earlier versions, and the readers below tolerate them.

Last reviewed: 2026-06-12 (v1.0.339).

---

## Live shims (still load-bearing — do NOT delete without a data migration)

| # | Shim | Where | What it converts | Safe to remove when |
|---|------|-------|------------------|---------------------|
| 1 | **LEGACY_FORMAT_REMAP** | `services/format-loader.ts` | Deleted format ids → current ones at load: `narrative` / `narrated-scenes` / `sleep-story` → `scenes` (chapter); `narration-synced` / `timestamp-driven` → `scenes` (sentence); `broll-narration` / `broll` → `stock-footage` | No project.json on disk references a legacy `format_id` (would need a one-time on-disk rewrite + verification across all real projects + any old backups that might be re-imported) |
| 2 | **`.docx` → `.md` artifact resolution** | `lib/episode-artifacts.ts` (`resolveReadPath`/`toMdPath`) | Text artifacts are written as `.md` since v1.0.228; readers prefer `.md` and fall back to legacy `.docx`. EVERY script/prompt/metadata reader must route through this. | All episodes have been re-generated as `.md` (legacy `.docx` files no longer exist anywhere) |
| 3 | **Portable manifest v1 → v2** | `services/manifest.ts` | `.story-studio-project.json` v1 carried presets/standards/channel-url; v2 is slim (structural + `project_id` + `last_edited`). Reader accepts sv 1 or 2; writer always emits v2. | Every project folder's marker has been rewritten as v2 (happens on next metadata change) |
| 4 | **`sceneAlignment` default** | `services/format-loader.ts`, `models/types.ts` | Formats created before the field default to `'chapter'`; legacy `narration-synced` remaps to `'sentence'` via shim #1 | All format JSONs explicitly set `sceneAlignment` |
| 5 | **`ideas.json` auto-heal** | `services/idea-manager.ts` (`applyAutoHeal`) | Reconciles `recycled_numbers` vs accepted-episode numbers on every read; removes recycled entries already taken. Guards against duplicate episode codes when writes bypass `mutateStore` (e.g. `upload-orphans.adoptOne`). | All writers go through `mutateStore` (no external `ideas.json` mutation paths) |
| 6 | **SubfolderNames merge w/ defaults** | `services/utils.ts` (`resolveSubfolderNames`) | `subtitles` key (added v1.0.10) and any missing keys are filled from `DEFAULT_SUBFOLDER_NAMES`, so older `project.json` without the full 10-key set don't crash readers | Every project.json carries all subfolder keys |
| 7 | **"✅ " done-marker prefix tolerance** | `lib/folder-resolver.ts` (`cleanName`) | Users mark a step done by prefixing a subfolder with "✅ "; all episode-dir + subfolder lookups strip it when matching so writers don't create unprefixed duplicates. Consolidated here in v1.0.338 (was duplicated in video/audio resolvers). | Never (it's a live user feature, not a migration) |
| 8 | **`marked_done` / `status_overrides`** | `services/idea-manager.ts`, `services/asset-status.ts` | Per-episode manual completion overrides on `StoredIdea`; merged on top of file-detected status. `marked_done` short-circuits to all-true (YouTube imports / legacy episodes). | Never (live feature) |
| 9 | **`portable` flag ignored** | `services/project-manager.ts` | Legacy multi-machine-vs-local distinction; silently dropped on next save. Reading tolerates its presence. | All project.json have been re-saved without it |
| 10 | **Upload sidecar `DeletedReason` permissive read** | `services/upload-sidecar.ts` | Older sidecars carry arbitrary `deleted_reason` strings; typed as `string` on read (not the closed union) so old files validate. Write side enforces the union. | All upload sidecars rewritten under the typed union |

---

## One-shot migrations (already run; not load-bearing at read time)

These ran once (at boot or via a script) and rewrote data in place. They're
idempotent and gated by a marker, so they don't convert on every read — listed
for completeness / archaeology.

| Migration | Where | Notes |
|-----------|-------|-------|
| `02 Description` → `02 Metadata` folder rename | `boot/migrations.ts`, `services/folder-migration.ts` | Gated by `migrations.json` marker; idempotent re-scan. |
| App secrets → nested provider store | `boot/migrate-app-secrets.ts` (v1.0.240+) | Moved flat keys into `app-secrets-store`. |
| iCloud project normalization | `scripts/archive/normalize-icloud-project.ts` | 2026-05-04 one-shot; archived. |
| `format_id` rewrite on the 5 real projects | (manual, task D.2) | LEGACY_FORMAT_REMAP (#1) is the safety net for any that reappear. |

---

## How to use this when refactoring

1. Touching `types.ts`? Check the table — if a field appears in a "live shim"
   row, it's read from real on-disk data. Deprecate, don't delete.
2. Removing a shim? Its "Safe to remove when" column is the precondition. Most
   require a verified on-disk rewrite across **all** real projects *and* a
   guard against old backups being re-imported.
3. Adding a new shim? Add a row here with the code ref so the next person knows
   it's load-bearing rather than dead.
