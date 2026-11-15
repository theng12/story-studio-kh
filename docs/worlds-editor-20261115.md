# Scene worlds editor — branch record (1.4.403)

Branch `work/worlds-editor-20261115`, cut from the 1.4.402 tip. 402 stays parked and untouched;
this branch is rebased deliberately when 402 ships.

## Review answers

1. **Merge test execution.** `electron/server/__tests__/music-worlds-merge.test.ts` (7 cases) is
   written and typechecked, **not executed**. It needs a lane; no lane was taken. It is not reported
   as done until it runs.
2. **Empty-list fallback, stated on the page.** Removing every world deletes `musicFormat.worlds`
   and the page then says: "No worlds are saved. Until you add one, each song's scene idea falls back
   to this formula's register labels (…); nothing is lost, and the list stays empty." The theme chips
   below it are labelled "(register labels — no worlds are saved)" so the fallback is visible, not a
   silent disappearance.
3. **Overlap of `worlds` and `worlds_remove`.** An id present in both is **refused**
   (`World "x" is both edited and removed in this patch; do one or the other.`), never resolved by
   order, so a merge can never silently drop a world. Covered by a test.
4. **Id-from-name.** Only an **id-less** entry gets an id derived from its name. An entry with an id
   edits that world in place — renaming it keeps the id and its position (covered by a test), so a
   rename never creates a second world. The UI sends the existing id for every loaded world, so
   renaming in the page is always in place.

## What changed

- `contracts/song-formula.ts`: `MusicWorldPatchSchema`, `worlds` + `worlds_remove` on
  `MusicFormatPatchSchema`, `mergeMusicWorlds`, `worldIdFromName`.
- `content-packs/schemas.ts`: `MusicWorldSchema` exported for final validation.
- `routes/niches.ts`: merge into `musicFormat.worlds`, validate each merged world, delete the list
  when it becomes empty.
- `pages/projects/[slug]/music-formula.vue`: per-world name, register, sight, scenes, music; add,
  remove, scene-theme toggle, and the visible fallback text.
