# `episode-status-warm-list.test.ts` is red on `main` — watcher-latency race, not a product defect

**From:** the 24 GB Upload Center task (orchestrator) · **To:** whoever owns the episode warm-list / folder-watcher area · **Date:** 2026-09-02
**Status:** open · causation established · **not fixed** — deliberately, see "Why not fixed from where it was found"

## What fails

`electron/server/__tests__/episode-status-warm-list.test.ts` fails **6 of 6** when run in isolation against `origin/main` at `8b30d2a8`
(`node scripts/testing/run-backend-tests.mjs --only episode-status-warm-list`). It makes the full `npm run test:backend` gate
come back 4,374 / 4,375 for everyone, on every branch that merges `main`, with no code change of their own.

## Causation — established, do not re-derive

- The test file and its subject are **byte-identical to `origin/main`** on the branch where this was first seen
  (`feat/youtube-upload-center-redesign`, after merging `main` at `158d0505`). It arrived with the merge; it is not that feature's.
- Root cause, from running it: fixture episode files are written **immediately before the folder watcher attaches**, so one
  episode gets invalidated after the warm read and the assertion sees a cold entry. It is a macOS watcher-latency race.
  No product behaviour is wrong.
- Its own history shows the area has been fighting this race already:
  - `023bb3c6` 2026-08-27 — "Let the folder watcher vouch for unchanged episodes on a warm list"
  - `6fcc668a` 2026-08-28 — "Stop the warm-list tests racing the cache's own audit clock"
  - `fcb357f3` 2026-08-28 — "Stop an episode read before its files exist from caching 'empty' forever"
  - `69cfafaf` 2026-09-02 — "fix: expose relaxed queue terms accessibly" (touched this test today)

## Why not fixed from where it was found

The last commit to this test landed **today** from the job-lane work. Fixing it from the Upload Center feature branch would put a
second writer on a file with a live one (`AGENTS.md`, *Running Part Of The Backend Suite*: one writer, no competing suites).
It belongs with whoever is in the watcher area now.

## Suggested direction (not prescriptive)

Make the test await the watcher's ready signal before writing fixtures — or write fixtures, attach the watcher, then wait for
one settled tick before the warm read. The Aug 28 fix addressed the audit-clock race; this is the sibling race on attach.

## Verification that closes this

1. `node scripts/testing/run-backend-tests.mjs --only episode-status-warm-list` — **6 / 6 green, three runs in a row** (it is a race; one green run proves nothing).
2. `npm run test:backend` in the foreground — the full-suite count returns to N / N with **no PARTIAL RUN banner**. Report the exit status, completion line and count.
3. Move this file to `docs/handoffs-retired/`.

## Also observed, not investigated

Frontend typecheck on `origin/main` reports **12 pre-existing `TS2558` errors** in files unchanged by the Upload Center work.
Not enumerated here; whoever runs `npm --prefix frontend run typecheck` on `main` will see them. Separate item; may already be known.
