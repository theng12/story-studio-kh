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
import * as store from './upload-store.js'
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
}

/**
 * Build the preview: call YouTube, map each remote video to its best
 * local candidate. No writes — just returns the computed match table.
 */
export async function buildReconcilePreview(slug: string, accountId: string): Promise<ReconcilePreview> {
  const [remoteList, ideas] = await Promise.all([
    listRecentUploads(slug, accountId, { maxPages: 8 }),  // up to 400 videos
    im.getIdeas(slug, 'accepted'),
  ])
  const episodes: LocalEpisode[] = ideas
    .filter(i => i.episode_code)
    .map(i => ({ episode_code: i.episode_code!, title: i.title || '' }))

  // Already-linked set so the UI can pre-filter.
  const already_linked: string[] = []
  for (const ep of episodes) {
    const sidecar = await readSidecar(slug, ep.episode_code, ep.title, 'youtube')
    if (sidecar?.video_id) already_linked.push(ep.episode_code)
  }

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
}

export interface ConfirmResult {
  written: string[]
  errors: Array<{ episode_code: string; error: string }>
}

/**
 * Commit confirmed matches to sidecars. Each link writes (or merges with)
 * an existing `{episode}/youtube_upload.json` so subsequent Queue renders
 * and Upload actions treat the video as already-uploaded. Existing sidecar
 * fields we don't know (privacy_status etc.) are preserved.
 */
export async function confirmReconcile(slug: string, accountId: string, links: ConfirmLink[]): Promise<ConfirmResult> {
  const result: ConfirmResult = { written: [], errors: [] }
  const account = (await store.listAccounts(slug, 'youtube')).find(a => a.id === accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const ideas = await im.getIdeas(slug, 'accepted')
  for (const link of links) {
    try {
      const idea = ideas.find(i => (i.episode_code || '') === link.episode_code)
      if (!idea) { result.errors.push({ episode_code: link.episode_code, error: 'Accepted idea not found' }); continue }
      const existing = await readSidecar(slug, link.episode_code, idea.title || '', 'youtube')
      const sidecar: UploadSidecar = {
        platform: 'youtube',
        video_id: link.video_id,
        account_id: accountId,
        channel_id: account.remote_id,
        uploaded_at: existing?.uploaded_at || link.published_at || new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        scheduled_for: existing?.scheduled_for ?? null,
        privacy_status: existing?.privacy_status || 'public',
        title: link.remote_title || existing?.title || idea.title || link.episode_code,
        description: existing?.description || '',
        tags: existing?.tags || [],
        thumbnail_set: existing?.thumbnail_set || false,
      }
      await writeSidecar(slug, link.episode_code, idea.title || '', sidecar)
      result.written.push(link.episode_code)
    } catch (e: any) {
      result.errors.push({ episode_code: link.episode_code, error: e?.message || 'Write failed' })
    }
  }
  return result
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
