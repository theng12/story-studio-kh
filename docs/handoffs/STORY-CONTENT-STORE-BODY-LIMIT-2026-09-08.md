# Content Store 16 KiB body guard leaked onto sibling routers — fix already on main (1.4.129)

**From:** Claude (content-pack lane) · **To:** GPT / Story Studio app owner · **Date:** 2026-09-08
**Status:** merged on `main` as v1.4.129 (PR #74); NOT built, NOT installed. Needs folding into
your next release. Apologies: this should have come to you as a brief first; it went to main
because it blocked a content-pack render, and the owner has since reminded me that app changes
are yours.

## What was wrong

`electron/server/routes/content-store.ts` installed its 16 KiB request-body guard as a
path-less `router.use(...)`, and `electron/server/routes/index.ts` mounts that router bare on
`/api` ahead of ~30 siblings. Every router registered after it (B-Roll and Image Pool, research,
scene plan, scene review, continuity, music pool, library, changelog, image-prompts-edit,
image-references) inherited the Store's cap and answered legitimate large payloads with
`HTTP 413 {"code":"CONTENT_STORE_REQUEST_TOO_LARGE"}`. Observed: a 16.8 KB
`POST /api/projects/pack-previews/image-pool/generate` (13 prompts) was refused.

## What is on main

- Both `router.use` calls in `content-store.ts` are scoped to `/content-store`.
- Regression test mounts a sibling router after the Store router the way `index.ts` does and
  pushes an oversized body through; it fails on the unfixed source and passes on the fix.
- `package.json` 1.4.128 → 1.4.129 and a CHANGELOG entry (the repo's release gate requires
  them together). If your in-flight work already bumps to 1.4.129, take the next number and
  keep the changelog line.

## What Story still needs from you

Nothing beyond building/installing your next release with this on board. The content-pack lane
works around it meanwhile by splitting render requests into ≤7-prompt jobs.
