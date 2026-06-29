# Character Unification — One App-Level Library, Assignable Per Project

Status: **implemented (additive foundation + dry-run migration)** · v1.0.481

## Goal

Today there are **two** character systems:

1. **Per-project** — `${PROJECTS_ROOT}/${slug}/characters/{id}/character.json`
   (service `character-manager.ts`, routes `/projects/:slug/characters*`,
   page `projects/[slug]/characters.vue`).
2. **Global library** — `${PROJECTS_ROOT}/.character-library/{id}/character.json`
   (service `character-library.ts`, routes `/character-library*` plus
   `save-to-library` and `import-to/:slug`, page `character-library.vue`).

The global library only ever produced **snapshot copies** — "Save to library"
copied a project character up, "Import from library" copied one down. There was
no notion of a single character that simply *belongs* to several projects.

**Target:** one app-level library where each character can be **assigned**
(tagged) to one or more projects. The per-project Characters page becomes a
filtered view — characters assigned to this project — plus an
"assign existing from library" action. Existing per-project characters keep
working untouched.

## Hard safety requirement

The user prioritised **"no issues" / no data loss** above all. Therefore:

- **Nothing is deleted or destructively rewritten.** The per-project store and
  the library store both keep all their existing data.
- The design is **additive**: a new optional `projects: string[]` field on the
  library record records assignments. Records without it behave exactly as
  before.
- The migration that consolidates per-project characters into the library is
  **copy-only, dry-run-by-default, verified, and reversible** — it never
  touches (let alone deletes) the per-project originals.

## Design — unify at the *read* layer

Every downstream consumer of character data already goes through four
`character-manager` functions:

| Consumer | Function used |
| --- | --- |
| script generator (`episode.ts`) | `resolveCharacters` |
| image-prompt generator (`image-prompts.ts`) | `resolveCharacters` |
| image generator (`images.ts`) | `listCharacters`, `referenceImagePath` |
| audio / voice routing (`audio.ts`) | `listCharacters` |
| continuity render (`continuity-render.ts`) | `getCharacter`, `referenceImagePath` |
| prompt director (`prompt-director.ts`) | `getCharacter` |
| Characters page + picker (frontend) | `GET /projects/:slug/characters` → `listCharacters` |

So we unify **once**, at those functions, and every consumer inherits the
unified view with no per-consumer change:

- `listOwnCharacters(slug, opts)` — the *old* `listCharacters` body, reads
  **only** the per-project folder. Used internally and by the migration so it
  can see the un-merged project characters.
- `listCharacters(slug, opts)` — **unified**: `listOwnCharacters` **plus**
  every library character assigned to `slug` (`projects.includes(slug)`),
  de-duplicated by `id` with the **on-disk project character winning**.
  Library characters are project-scope semantics, so they appear for every
  episode (ignore the `episode_code` filter, same as a `scope:'project'` char).
- `getCharacter(slug, id)` — project file first (unchanged); **falls back** to a
  library character assigned to `slug` when the project file is missing.
- `referenceImagePath(slug, id, filename)` — project path first (unchanged);
  **falls back** to the library folder
  (`${PROJECTS_ROOT}/.character-library/{id}/{filename}`) when the file isn't in
  the project folder. Pure path resolution, sync, no assignment lookup needed.

Dedup-by-id with project-wins means a character that has been *both* migrated
into the library (tagged with the slug) **and** still present on disk shows up
**once** — so running the migration never produces duplicates in any picker or
generator. The two stores can coexist indefinitely.

### Why not flip the per-project store off?

Because reference images for per-project characters live inside the project
folder and travel with it across machines (the cross-machine portability
invariant). Deleting the per-project store, or rewriting every consumer to read
the library exclusively, is the high-blast-radius move the safety requirement
tells us to avoid. The additive read-merge gives the user the unified behaviour
**without** betting any existing data on a migration. The migration becomes an
optional, user-driven consolidation they can run (dry-run first) whenever they
choose.

## Data model

`Character` gains one optional field (backend `models/types.ts` + frontend
`useCharacters.ts`):

```ts
/**
 * Unified-library assignment tags. On an app-level library record, lists the
 * project slugs this character is assigned to. Undefined/empty = library-only
 * (not assigned anywhere). Per-project on-disk characters leave this undefined
 * — their folder location *is* their assignment.
 */
projects?: string[]
```

`source` gains a `'library'` value so the unified reader can mark which entries
came from the library (the UI shows "Assigned from library" + an *Unassign*
action instead of *Delete*).

## Services

`character-library.ts` (the app-level library becomes the system of record for
shared characters):

- `assignToProject(id, slug)` — add `slug` to `projects[]` (idempotent).
- `unassignFromProject(id, slug)` — remove `slug` from `projects[]`.
- `setProjects(id, slugs)` — replace the whole assignment set.
- `listForProject(slug)` — library characters where `projects.includes(slug)`.
- `libraryCharacterDir(id)` — exported so callers can resolve reference images.
- `saveToLibrary` now **auto-assigns** the source project (`projects:[slug]`)
  and preserves `projects` on overwrite; `updateLibraryCharacter` preserves
  `projects`. `import-to/:slug` (legacy snapshot copy) is unchanged and still
  available.

## Migration — `character-migration.ts`

One-time, **copy-only**, reversible consolidation of per-project characters into
the library.

- `planMigration()` — **dry run**. For every project, lists its
  `listOwnCharacters`. For each, computes target library id (= character id) and
  a status:
  - `copy` — no library entry with that id yet → will create + assign.
  - `assign-only` — a library entry with that id already exists and is
    byte-identical on the meaningful fields → will just add the slug to its
    `projects[]` (no overwrite).
  - `conflict` — a *different* character already owns that library id → **skipped**
    and reported; the user resolves by renaming.
  Returns counts + the full per-character plan. Writes nothing.
- `runMigration({ confirm: true })` — executes the plan: copies `character.json`
  (tagged `projects:[slug]`, `source:'library'`) + every reference image into
  the library, then **verifies** (re-reads the library record, checks fields +
  that each image file exists). **Never deletes** the project original. Returns a
  per-character verified/failed report. Conflicts are skipped, never overwritten.

Reversibility: because originals are untouched, "undoing" is just deleting the
freshly-created library entries (or unassigning the slug). The migration report
lists exactly which library ids it created, so a revert is mechanical.

Routes: `GET /api/character-migration/plan` (dry run) and
`POST /api/character-migration/run` (requires `{ "confirm": true }`).

## API surface added

- `POST   /api/character-library/:id/assign/:slug`
- `DELETE /api/character-library/:id/assign/:slug`
- `POST   /api/projects/:slug/characters/assign-from-library` `{ libraryId }`
- `GET    /api/character-migration/plan`
- `POST   /api/character-migration/run` `{ confirm: true }`

Existing routes (`save-to-library`, `import-to/:slug`, all CRUD) are unchanged.

## Frontend

- `useCharacterLibrary.ts` — `assignToProject`, `unassignFromProject`,
  `listForProject`.
- `projects/[slug]/characters.vue` — list now includes library-assigned
  characters (they arrive through the existing `GET /projects/:slug/characters`).
  Library-sourced rows show an "Assigned from library" badge and an *Unassign*
  action (instead of *Delete*, which would not touch the library record). New
  **"Assign from library"** button opens a picker of unassigned library
  characters.
- `character-library.vue` — each card shows the projects it's assigned to.

## Test coverage

- `character-library.test.ts` — assignment add/remove/idempotent, `listForProject`,
  `saveToLibrary` auto-assign, `projects` preserved on update.
- `character-manager.test.ts` — unified `listCharacters` merges assigned library
  characters, dedups by id (project wins), `getCharacter`/`referenceImagePath`
  library fallback, `listOwnCharacters` stays project-only.
- `character-migration.test.ts` — dry-run writes nothing, `copy`/`assign-only`/
  `conflict` classification, run copies+verifies+assigns and leaves originals.

## Rollback

Disable the read-merge by reverting `character-manager` to call the old project-only
body — no data migration needed, both stores are intact. The `projects` field and
library entries created by the migration are inert to the old code path.
