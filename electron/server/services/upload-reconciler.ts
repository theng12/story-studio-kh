/**
 * Reconcile channel — match already-uploaded YouTube videos to local
 * episodes so sidecars exist for things you uploaded before Story Studio
 * knew about them. One-time operation per episode (durable via sidecar).
 *
 * Matching strategy (per Q&A answer: "fuzzy match preview, then manual
 * review for all"):
 *   1. Episode-code substring match (strong: `TN0012` appears in the YT title).
 *   2. Dice coefficient on normalized titles (fallback for when the user
 *      didn't include the code).
 *   3. Nothing — user confirms in the review UI.
 *
 * Scores in [0, 1]. 1.0 = exact code hit; 0.5–0.9 = partial title match.
 * Below 0.3 is hidden from the suggested-match column so the user doesn't
 * have to squint past noise.
 */

import * as im from './idea-manager.js'
import { listRecentUploads } from '../lib/youtube-client.js'
import { readSidecar, writeSidecar } from './upload-sidecar.js'
import { describeYouTubeCredential } from './youtube-credential.js'
import type { UploadSidecar } from './upload-sidecar.js'

export interface RemoteVideo {
  videoId: string
  title: string
  publishedAt: string
  privacyStatus?: string
}

export interface LocalEpisode {
  episode_code: string
  title: string
}

export interface MatchSuggestion {
  remote: RemoteVideo
  suggested_episode_code: string | null
  score: number
  reason: 'episode_code' | 'title_similarity' | 'none'
}

export interface ReconcilePreview {
  remote_count: number
  local_count: number
  suggestions: MatchSuggestion[]
  /** Episodes already linked (sidecar with video_id) — for context in the UI. */
  already_linked: string[]
  /**
   * Reverse map of the `already_linked` set: keys are YouTube videoIds,
   * values are the episode codes they're currently bound to. Lets the UI
   * mark a *specific row* in the reconcile table as already-linked
   * (rather than just showing a header count).
   */
  linked_videos: Record<string, string>
}

/**
 * Build the preview: call YouTube, map each remote video to its best
 * local candidate. No writes — just returns the computed match table.
 */
export async function buildReconcilePreview(slug: string, accountId: string): Promise<ReconcilePreview> {
  const [remoteResult, ideas] = await Promise.all([
    listRecentUploads(slug, accountId, { maxPages: 8 }),  // up to 400 videos
    im.getIdeas(slug, 'accepted'),
  ])
  const remoteList = remoteResult.videos
  const episodes: LocalEpisode[] = ideas
    .filter(i => i.episode_code)
    .map(i => ({ episode_code: i.episode_code!, title: i.title || '' }))

  // Read each episode's sidecar so we know which ones are already linked
  // to a YouTube video. Two derived shapes are returned to the UI:
  //   - already_linked: list of episode_codes (kept for backward compat —
  //     used by the Queue-tab banner to filter out already-linked
  //     suggestions before showing the "you can reconcile" prompt).
  //   - linked_videos: reverse map (videoId → episode_code) so the
  //     reconcile table can mark a *specific row* as already-linked.
  //
  // Sidecar reads are I/O-bound; running them sequentially blocks on each
  // file before starting the next. Promise.all parallelises them so a
  // 300-episode project goes from ~300ms (sequential, local SSD) to ~30ms,
  // and is dramatically better on iCloud-backed projects where each read
  // can take 5–10ms each.
  const sidecarPairs = await Promise.all(
    episodes.map(async (ep) => {
      const sidecar = await readSidecar(slug, ep.episode_code, ep.title, 'youtube')
      return { episode_code: ep.episode_code, video_id: sidecar?.video_id }
    }),
  )
  const { already_linked, linked_videos } = deriveLinkedFromSidecars(sidecarPairs)

  const suggestions: MatchSuggestion[] = remoteList.map(remote => {
    const match = bestMatchForRemote(remote, episodes)
    return {
      remote,
      suggested_episode_code: match?.episode?.episode_code || null,
      score: match?.score ?? 0,
      reason: match?.reason || 'none',
    }
  })

  return {
    remote_count: remoteList.length,
    local_count: episodes.length,
    suggestions,
    already_linked,
    linked_videos,
  }
}

interface MatchResult {
  episode: LocalEpisode
  score: number
  reason: 'episode_code' | 'title_similarity'
}

function bestMatchForRemote(remote: RemoteVideo, episodes: LocalEpisode[]): MatchResult | null {
  // 1. Episode-code substring search wins outright. Case-insensitive;
  //    bounded by word-ish delimiters so `TN001` doesn't match `TN0012`.
  for (const ep of episodes) {
    const code = ep.episode_code
    if (!code) continue
    // Match as a whole token: preceded by non-alphanum OR start, followed
    // by non-digit OR end. Prevents `TN001` matching inside `TN0012`.
    const re = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(code)}(?:[^0-9]|$)`, 'i')
    if (re.test(remote.title)) {
      return { episode: ep, score: 1.0, reason: 'episode_code' }
    }
  }

  // 2. Fuzzy title match — Dice coefficient on bigrams. Surfaces only
  //    if the best score clears a floor so the suggestion column isn't
  //    dominated by near-random hits.
  let best: MatchResult | null = null
  const normRemote = normalizeTitle(remote.title)
  for (const ep of episodes) {
    const s = diceCoefficient(normRemote, normalizeTitle(ep.title))
    if (!best || s > best.score) best = { episode: ep, score: s, reason: 'title_similarity' }
  }
  if (best && best.score >= 0.3) return best
  return null
}

export interface ConfirmLink {
  episode_code: string
  video_id: string
  /** Optional remote title so the sidecar can carry it without another roundtrip. */
  remote_title?: string
  /** Optional published_at for the sidecar. */
  published_at?: string
  /**
   * When true, also overwrite the episode's title in `ideas.json` with
   * the YouTube remote title. Default false. Only takes effect when
   * `remote_title` is non-empty. Lets the user opt in per-row (a
   * checkbox in the Match Unlinked UI) so manually-titled episodes
   * aren't silently clobbered.
   */
  apply_remote_title?: boolean
}

export interface ConfirmResult {
  written: string[]
  errors: Array<{ episode_code: string; error: string }>
  /** Episode codes whose `ideas.json` title was rewritten via apply_remote_title. */
  titles_synced?: string[]
}

/**
 * Commit confirmed matches to sidecars. Each link writes (or merges with)
 * an existing `{episode}/youtube_upload.json` so subsequent Queue renders
 * and Upload actions treat the video as already-uploaded. Existing sidecar
 * fields we don't know (privacy_status etc.) are preserved.
 *
 * Override semantics: when an episode is being relinked to a NEW video
 * but its current sidecar points at a different `video_id`, the write
 * silently overwrites — the old binding becomes orphan and will surface
 * as "unlinked" on the next reconcile preview. The frontend confirms the
 * override before posting; the backend trusts that confirmation.
 */
export async function confirmReconcile(slug: string, accountId: string, links: ConfirmLink[]): Promise<ConfirmResult> {
  const result: ConfirmResult = { written: [], errors: [], titles_synced: [] }
  const account = await describeYouTubeCredential(slug, accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const ideas = await im.getIdeas(slug, 'accepted')
  for (const link of links) {
    try {
      const idea = ideas.find(i => (i.episode_code || '') === link.episode_code)
      if (!idea) { result.errors.push({ episode_code: link.episode_code, error: 'Accepted idea not found' }); continue }
      const existing = await readSidecar(slug, link.episode_code, idea.title || '', 'youtube')
      // Apply-remote-title: when the user opted in AND we have a remote
      // title, push the YouTube title back into ideas.json so the
      // episode label across the rest of the app matches the live video.
      // Done BEFORE the sidecar write so the write uses the new title
      // (idea.title is read into the sidecar's title field below for
      // any future enrichment).
      const wantTitleSync = !!link.apply_remote_title && typeof link.remote_title === 'string' && link.remote_title.trim() !== ''
      let effectiveTitle = idea.title || ''
      if (wantTitleSync && link.remote_title) {
        const next = link.remote_title.trim()
        if (next && next !== idea.title) {
          await im.updateIdea(slug, idea.id, { title: next })
          effectiveTitle = next
          result.titles_synced!.push(link.episode_code)
        }
      }
      const sidecar: UploadSidecar = {
        platform: 'youtube',
        video_id: link.video_id,
        account_id: accountId,
        channel_id: account.remote_id,
        uploaded_at: existing?.uploaded_at || link.published_at || new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        scheduled_for: existing?.scheduled_for ?? null,
        privacy_status: existing?.privacy_status || 'public',
        title: link.remote_title || existing?.title || effectiveTitle || link.episode_code,
        description: existing?.description || '',
        tags: existing?.tags || [],
        thumbnail_set: existing?.thumbnail_set || false,
      }
      await writeSidecar(slug, link.episode_code, effectiveTitle, sidecar)
      result.written.push(link.episode_code)
    } catch (e: any) {
      result.errors.push({ episode_code: link.episode_code, error: e?.message || 'Write failed' })
    }
  }
  return result
}

/**
 * Pure helper: given (episode_code, video_id) pairs from per-episode
 * sidecars, derive the two link-state shapes the UI consumes. Pulled out
 * of `buildReconcilePreview` so the transform can be unit-tested without
 * having to stub the YouTube API + idea-manager + sidecar reader.
 *
 * Sidecar present but with no video_id is treated as "not linked" — the
 * sidecar may exist for unrelated metadata (privacy_status etc.) without
 * the video having been uploaded yet.
 *
 * Duplicate video_ids across multiple episodes shouldn't happen in
 * practice (sidecar is per-episode, single video_id), but if they do,
 * the *last* episode wins for that video — matches the array-based
 * "most recent confirm wins" semantics elsewhere.
 */
export function deriveLinkedFromSidecars(
  pairs: ReadonlyArray<{ episode_code: string; video_id?: string | null }>,
): { already_linked: string[]; linked_videos: Record<string, string> } {
  const already_linked: string[] = []
  const linked_videos: Record<string, string> = {}
  for (const p of pairs) {
    if (!p.video_id) continue
    already_linked.push(p.episode_code)
    linked_videos[p.video_id] = p.episode_code
  }
  return { already_linked, linked_videos }
}

// ── Scoring helpers ───────────────────────────────────────────────────────

export function normalizeTitle(t: string): string {
  return (t || '')
    .toLowerCase()
    // Strip episode codes so they don't dominate the bigram comparison.
    .replace(/[a-z]+\d{2,5}/g, ' ')
    // Common sleep-story channel fluff that doesn't discriminate between episodes.
    .replace(/sleep story|for relaxation|sleep meditation|relaxing story|bedtime/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigramsA = bigramCounts(a)
  const bigramsB = bigramCounts(b)
  let matches = 0
  let totalA = 0
  for (const c of bigramsA.values()) totalA += c
  let totalB = 0
  for (const c of bigramsB.values()) totalB += c
  for (const [bg, countA] of bigramsA) {
    const countB = bigramsB.get(bg)
    if (countB) matches += Math.min(countA, countB)
  }
  if (totalA + totalB === 0) return 0
  return (2 * matches) / (totalA + totalB)
}

function bigramCounts(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2)
    m.set(bg, (m.get(bg) || 0) + 1)
  }
  return m
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
