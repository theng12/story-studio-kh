# Channel Characters — One Channel Per Character

Status: **implemented 2026-11-06** (owner correction). This supersedes the earlier
app-level shared-library design where one record was assigned to several projects and
carried per-channel voice profiles.

## Ownership

A character belongs to **exactly one channel**.

- Channel-owned record:
  `${PROJECTS_ROOT}/.character-library/_channels/<channelSlug>/<id>/character.json`
  - `scope: 'project'`
  - `source: 'project'`
  - `projects: [channelSlug]`
  - `speech` is this channel's voice; `channel_profiles` is absent
- Reference images live beside the record in the same channel folder.
- The old flat store `${PROJECTS_ROOT}/.character-library/<id>/` is **legacy and
  read-only forever**. Reads may fall back to it; every write is refused with
  `CharacterLegacyReadOnlyError` (409). It is never rewritten.
- Legacy records still assigned to a channel may appear in that channel's list with
  `source: 'library'` until migration. The UI shows them as **read-only until
  migration** and does not read the global store to fake an editable copy.

## Routes

Channel records use only the project-scoped routes:

- `GET    /api/projects/:slug/characters` — this channel's records plus unmigrated
  legacy fallback rows
- `POST   /api/projects/:slug/characters` — create the channel-owned copy
- `GET    /api/projects/:slug/characters/:id`
- `PUT    /api/projects/:slug/characters/:id`
- `DELETE /api/projects/:slug/characters/:id` — moves the record to `_trash`
- `POST   /api/projects/:slug/characters/:id/reference-image` — upload
- `GET    /api/projects/:slug/characters/:id/reference-image/:filename` — preview
- `DELETE /api/projects/:slug/characters/:id/reference-image/:filename` — moves
  the image to `_trash`

Ordinary GET requests never migrate and never write. The global
`/api/character-library` routes are read-only and refuse all mutations.

## Migration

Migration is explicit, copy-only, verifiable, and reversible:

- `GET  /api/character-library/channel-migration/preview`
- `POST /api/character-library/channel-migration/apply`
- `POST /api/character-library/channel-migration/undo`

It creates one channel namespace copy per legacy assignment. Originals stay untouched
until the user removes them through the normal restorable Trash path.

## Frontend

- The Character Sheet hosts `ChannelCharacterRoster` above the episode gate, so the
  roster works with no episode selected.
- The roster reads only `/projects/:slug/characters`, filters out episode-scope
  records, and keeps its own race fence separate from the episode cast.
- `CharacterRecordEditor` edits the channel record through `useCharacters`:
  - one identity, description and reference-image gallery
  - one channel voice read live from the Gateway through `VoicePicker`
  - staged draft; Cancel/close and dirty-state gating save nothing
  - partial-upload recovery retries the image on the saved record instead of
    creating a duplicate
- There are no channel assignment labels, no multi-channel voice profiles, and no
  global character-library edit path.
- The legacy `/character-library` page only redirects to the channel's Character
  Sheet.

## Read compatibility

Generators still read through `character-manager`:

- `listCharacters` returns the channel's owned records plus any unmigrated legacy
  records assigned to that channel, de-duplicated by id with the channel copy winning.
- `getCharacter` and `referenceImagePath` resolve the channel copy first, then the
  project-local folder, then the legacy flat store.
- Reads never rewrite stored characters, presets, or project data.
