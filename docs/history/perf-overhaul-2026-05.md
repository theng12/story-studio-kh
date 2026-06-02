# Episode/Ideas Load Performance Overhaul — CHANGES

This file inventories every change made by the perf overhaul described in
`/build/.claude/plans/i-want-your-help-wiggly-moon.md`.

There is no git in this project, so this file substitutes for a per-phase
commit history. Files are grouped by phase; each entry says what changed
and why.

## Numbers (real project — terranash-sleep-stories, 154 accepted episodes)

| Path | Median wall time | vs baseline |
|---|---|---|
| Baseline (before overhaul) | **11,324 ms** | — |
| Phase 1 only (hoist + memoize) | 11,580 ms | within noise (bottleneck wasn't here) |
| Phase 2 — WARM (in-memory HIT) | **7 ms** | **~1,600× faster** |
| Phase 3 — HYDRATED (cleared in-memory, disk cache present) | 10 ms first / 7 ms onwards | **~1,000× faster on first read after restart** |
| COLD (no caches at all) | 10,200 ms | ~10% faster than baseline (Phase 1 + Phase 5 effects) |

Phase 4 makes navigation between pages reuse the same cached array — first
mount fetches, subsequent mounts serve cached + revalidate in background
(SWR). At 7 ms server time, this is effectively instant either way; the
SWR matters most when the user clicks back-and-forth rapidly.

## Files created

| Path | Purpose |
|---|---|
| `electron/server/services/episode-status-cache.ts` | In-memory LRU + mtime invalidation + disk persistence for episode status |
| `electron/server/__tests__/episode-status-cache.test.ts` | 11 tests covering MISS/HIT/STALE/invalidate/dedup/persistence/hydrate/schema-mismatch |
| `frontend/composables/useEpisodes.ts` | Shared SWR cache for episode lists; deduped fetch, TTL backstop, job-completion invalidation |
| `frontend/__tests__/useEpisodes.test.ts` | 4 tests covering first-mount fetch, SWR, refresh, invalidate |
| `scripts/bench-episode-list.ts` | Benchmark for cold/warm/hydrated paths against the largest project |

## Files modified

### Phase 1 — hot-path quick wins
- `electron/server/lib/docx-parser.ts` — added LRU memoization (key: path + mtime, cap: 200) to `parseImagePromptsDocx`. Avoids repeated mammoth HTML conversions when the same docx is parsed multiple times.
- `electron/server/services/asset-status.ts` — `computeEpisodeStatus(slug, code, ideas?)` accepts an optional ideas array; when omitted, loads it ONCE internally (was 2× before). The route passes ideas to skip the load entirely.
- `electron/server/routes/ideas.ts` — `/projects/:slug/episodes` route loads ideas once at the top and passes through.

### Phase 2 — episode-status-cache (in-memory, mtime-invalidated)
- `electron/server/routes/ideas.ts` — `/projects/:slug/episodes` now goes through `episodeStatusCache.get()`. Honors `?refresh=1` query param to bust the project's cache before computing.

### Phase 3 — persisted status manifest
- `electron/server/services/episode-status-cache.ts` — added `${PROJECTS_ROOT}/${slug}/.cache/episode-status.json` persistence: lazy hydrate-on-demand, debounced 5s flush, atomic writes via existing `atomic-store.ts`. Schema-version mismatch silently drops the file.

### Phase 4 — frontend SWR composable
- `frontend/components/EpisodeSelector.vue` — switched from local `loadEpisodes()` + jobs-watcher to `useEpisodes(slugRef)`. The composable handles refresh, dedup, and auto-invalidation on job-completion.
- `frontend/pages/projects/[slug]/pipeline.vue` — switched the episode list fetcher to `useEpisodes(slug)`. Selection state preserved across cache invalidations.

### Phase 5 — project list parallelization + deferred migration
- `electron/server/services/project-manager.ts` — `listProjects()` rewritten to process every project concurrently via `Promise.all`. Per-project portable-flag migration moved out of the read path into `reconcilePortableFlagsAtStartup()` — runs once on app boot.
- `electron/server/app.ts` — calls `reconcilePortableFlagsAtStartup()` after migrations + executors register.

## Cache invalidation contract

Cache becomes stale and recomputes on any of:

1. **mtime change on a watched folder** — implicit, on every read. Catches file additions / removals from any source (in-app generators, Finder, sync conflicts).
2. **`cache.invalidate(slug, code)`** — explicit per-episode drop. Reserved for future job-completion hooks (not wired yet — mtime check covers correctness today).
3. **`cache.invalidateProject(slug)`** — explicit project-wide drop. Used when ideas list changes.
4. **`?refresh=1` on `/projects/:slug/episodes`** — UI-initiated force-refresh. Calls `invalidateProject` server-side.
5. **Schema-version mismatch on disk hydrate** — disk file dropped, fresh compute on next access.

Cache is **never** invalidated by:
- Time alone (no TTL on backend).
- Process restart (persistence layer rehydrates).
- App-settings changes unrelated to assets.

## Test results

- Backend: 421 / 422 (1 skipped, 0 fail)
  - 11 new cache tests
- Frontend: 93 / 93 (0 fail)
  - 4 new useEpisodes tests
- Combined: occasionally flaky on a pre-existing job-queue cleanup race; not related to this overhaul.

## Restart status

- Electron + `npm run dev` MUST be restarted to pick up all backend changes (per the standing instruction).

## Known follow-ups (NOT done in this overhaul)

1. **Explicit invalidation hooks** — wire `episodeStatusCache.invalidate(slug, code)` into the job executors when they finish writing assets. mtime check catches everything anyway, so this is a small optimization (saves one stale stat round-trip per affected episode after a job completes). Touchpoints: `electron/server/services/job-queue.ts` and the per-type executors under `boot/executors.ts`.
2. **`useEpisodeStatus` composable** — still does its own fetch via `useApi`. Could be refactored to delegate to `useEpisodes`. Low priority — it only fetches once per episode change, and the backend cache makes its fetch ~7 ms.
3. **scripts.vue + ideas.vue** — still fetch `/projects/:slug/episodes` directly inline. Their fetches now hit the warm backend cache (so cheap), but switching to `useEpisodes` would also dedupe across pages.
4. **`.cache/` exclusion from project transfer** — when the project transfer flow lands (audit Session 05), `.cache/episode-status.json` is regenerable and should be excluded. Document at that point.
