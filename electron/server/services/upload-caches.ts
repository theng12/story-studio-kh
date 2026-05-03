/**
 * Shared in-memory caches used by the Upload Center routes.
 *
 * Extracted from `routes/upload.ts` so non-upload code paths (e.g.
 * idea removal in `routes/ideas.ts`) can bust them when underlying
 * state changes. Without this extraction, only upload-route handlers
 * could invalidate the caches — so deleting an idea via the Ideas tab
 * left the missing-video list stale until the 5-minute TTL expired,
 * with no UI signal that "↻ Refresh" wasn't actually doing anything.
 *
 * Both maps are keyed by project slug (queue cache also factors in
 * platform) and time-stamped per-entry. The route handlers gate on
 * the timestamp + `?nocache=1` to decide whether to rebuild.
 */

import type { UploadPlatform } from './upload-store.js'

// ── Queue index cache ─────────────────────────────────────────────────────
// Stage-1 queue scan (sidecars + has-final per episode). Per-platform so a
// future TikTok / Facebook surface doesn't share entries with YouTube.

export interface QueueIndexCacheEntry {
  ts: number
  // The actual item shape lives in routes/upload.ts (QueueIndexItem) — we
  // stash it here as `unknown[]` so this module doesn't pull in the heavy
  // route-level types. Callers cast back to QueueIndexItem[].
  items: unknown[]
}

export const QUEUE_INDEX_TTL_MS = 5 * 60_000

export const queueIndexCache = new Map<string, QueueIndexCacheEntry>()

export function queueCacheKey(slug: string, platform: UploadPlatform | string): string {
  return `${slug}:${platform}`
}

// ── Missing-video cache ───────────────────────────────────────────────────
// Cheap-to-build but I/O-heavy (one sidecar + has-final probe per accepted
// idea), so a per-project cache survives a tab re-open without re-scanning.

export interface MissingVideoCacheEntry {
  ts: number
  episodes: Array<{ episode_code: string; title: string }>
}

export const MISSING_VIDEO_TTL_MS = 5 * 60_000

export const missingVideoCache = new Map<string, MissingVideoCacheEntry>()

// ── Cross-route invalidation ──────────────────────────────────────────────
// Called from idea-state-change routes (remove, dismiss, accept, …) so
// the next missing-video / queue read sees the post-mutation truth
// instead of the pre-mutation cached snapshot.

/**
 * Drop both upload-related caches for a project. Use after any change
 * that could affect "is this episode in the queue / missing-video
 * list?" — accepted-idea creation, episode_code rename, idea removal,
 * dismiss, reset. Cheap (two Map.delete calls); err on the side of
 * over-invalidating.
 */
export function invalidateProjectUploadCaches(slug: string): void {
  missingVideoCache.delete(slug)
  // Queue cache is keyed by slug+platform — wipe every entry whose key
  // starts with the slug. We keep the per-platform fan-out cheap by
  // walking the small map (typically <10 entries on a personal-use box).
  for (const key of queueIndexCache.keys()) {
    if (key.startsWith(`${slug}:`)) queueIndexCache.delete(key)
  }
}
