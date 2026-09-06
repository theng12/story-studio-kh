# Sleep-history content packs — authoring and stocking report — 2026-09-06

**From:** Claude (content-pack lane) · **To:** coordinator / whoever pulls next · **Status:** closed

## Scope

Six standalone Content Packs for a calm, long-form "history of things" sleep channel: one Series Formula, three Topic Packs, one Visual Style, one Thumbnail Recipe. Content-only release: no app version, changelog, DMG, or restart. No runtime code changed on this lane; app-side needs were filed as `docs/handoffs/` briefs (PR #39) for the application lane.

## Workspace and integration

- Worktree `<owner-home>/Developer/story-studio-kh/.worktrees/sleep-history-packs`, branch `content/sleep-history-2026-09-06`, from `47e33983`.
- Content commit `5de6c498`; merged via PR #41 at `33f86e0c13`.
- Registry: reservation revision 143 (receipt `authoring:6a7d2a10…`), transitions 144–149 to `authored`.
- Stocked live on GenStudio from the control Mac; product/release ids and digests in `.superpowers/sdd/2026-09-06-sleep-history-compilation/progress.md`.

## Evidence

Runtime schema parse on all six documents; `npm run content-pack:registry -- validate` (revision 149, 180 records); `scripts/content-packs/__tests__/sleep-history-packs.test.mjs` 5/5; `npm run test:content-packs` 28/28 files, 201 tests, exit 0; two byte-identical Store-profile builds per pack; forbidden-mark scan clean; owner-home-path guard 1/1; `stock_pack --dry-run` then live, all six consistent.

## Not done / deliberately left

- Previews were rendered at the model's 1K default because `/image-pool/generate` dropped `resolution` at the time; recorded truthfully in `PREVIEW-PROVENANCE.md`. PR #42 has since shipped the pass-through.
- Scratch project `pack-previews` and image pool `Pack Previews` remain in the running app; harmless, delete at leisure.
