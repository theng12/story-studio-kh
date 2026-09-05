/**
 * Matching unlinked episodes to unlinked YouTube videos, with the evidence
 * that justified each suggestion (spec section 13).
 *
 * The rule that shapes everything here: **only exact evidence links itself.**
 * A stored upload receipt or a stored video ID is a fact Story Studio wrote
 * down at the time. An episode code in a title, a similar title, a nearby
 * publication date - those are inferences, and an inference that links itself
 * is a wrong link nobody agreed to.
 *
 * Pure on purpose: every rank and every refusal is testable without a provider.
 */

/**
 * Spec section 13 also lists a rank 8, "sequence and neighbouring episodes".
 * It is deliberately NOT implemented: it needs an ordering over both sides that
 * this data does not carry, it is the weakest evidence in the list, and it can
 * never auto-link. Declaring it without producing it would be a rank that reads
 * as available and never fires. Its absence costs a suggestion, never a wrong
 * link. Recorded in the phase plan as a deliberate gap.
 */
export type MatchEvidence =
  /** 1. The episode already records this exact video id. */
  | 'stored_video_id'
  /** 2. A Story Studio upload receipt names this video. */
  | 'upload_receipt'
  /** 3. The video title contains this episode code, and only this one. */
  | 'unique_episode_code'
  /** 4. Titles are identical once normalized. */
  | 'exact_title'
  /** 5. Titles are strongly similar. */
  | 'strong_title_similarity'
  /** 6. Published close to when this episode was scheduled. */
  | 'publication_proximity'
  /** 7. Durations are close. */
  | 'duration_similarity'

/** Ranks 1-2 are recorded facts. Everything below is an inference. */
const EXACT_EVIDENCE: ReadonlySet<MatchEvidence> = new Set(['stored_video_id', 'upload_receipt'])

export const EVIDENCE_RANK: Record<MatchEvidence, number> = {
  stored_video_id: 1,
  upload_receipt: 2,
  unique_episode_code: 3,
  exact_title: 4,
  strong_title_similarity: 5,
  publication_proximity: 6,
  duration_similarity: 7,
}

const EVIDENCE_REASON: Record<MatchEvidence, string> = {
  stored_video_id: 'Story Studio already recorded this exact video for this episode.',
  upload_receipt: 'A Story Studio upload receipt names this video.',
  unique_episode_code: 'The video title contains this episode code, and no other episode claims it.',
  exact_title: 'The titles are identical.',
  strong_title_similarity: 'The titles are very similar.',
  publication_proximity: 'It was published close to when this episode was scheduled.',
  duration_similarity: 'The video is about the same length as this episode.',
}

export interface LocalEpisode {
  episode_code: string
  title?: string
  /** A video id Story Studio already recorded for this episode, if any. */
  recorded_video_id?: string
  /** A video id from a durable upload receipt, if any. */
  receipt_video_id?: string
  scheduled_for?: string | null
  duration_seconds?: number
}

export interface RemoteVideo {
  video_id: string
  title?: string
  published_at?: string
  duration_seconds?: number
}

/** Spec section 13's named states for a suggestion, derived from its rank. */
export type MatchState = 'exact_match_available' | 'probable_match' | 'needs_review' | 'possible_duplicate'

export interface MatchCandidate {
  episode_code: string
  video_id: string
  evidence: MatchEvidence
  rank: number
  reason: string
  /** The spec's own vocabulary, so the screen is not the only place it exists. */
  state: MatchState
  /** True ONLY for recorded facts. An inference never links itself. */
  auto_linkable: boolean
}

function stateForRank(rank: number): MatchState {
  if (rank <= 2) return 'exact_match_available'
  if (rank <= 5) return 'probable_match'
  return 'needs_review'
}

export interface ReconcileAnalysis {
  candidates: MatchCandidate[]
  /** Episodes with no candidate at all. */
  local_only: string[]
  /** Videos no episode claims. */
  youtube_only: string[]
  /** Episodes and videos contested by more than one counterpart. */
  duplicates: Array<{ kind: 'episode' | 'video'; id: string; competing: string[] }>
}

/**
 * Compare titles on structure, not on a flattened form.
 *
 * Lower-casing and collapsing whitespace is fine; joining, truncating or
 * stripping to a prefix is not - that is the normalisation that hides a real
 * difference, which this feature has now produced seven times.
 */
function normalizeTitle(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Word overlap, both directions, so a long title cannot swallow a short one. */
function titleSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTitle(a).split(' ').filter(Boolean))
  const right = new Set(normalizeTitle(b).split(' ').filter(Boolean))
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / Math.max(left.size, right.size)
}

/** An episode code appears in a title as a whole token, not as a substring. */
function titleContainsCode(title: string | undefined, code: string): boolean {
  if (!title || !code) return false
  return new RegExp(`(^|[^A-Za-z0-9])${code}([^A-Za-z0-9]|$)`, 'i').test(title)
}

function bestEvidence(
  episode: LocalEpisode,
  video: RemoteVideo,
  codeClaimants: Map<string, number>,
): MatchEvidence | null {
  if (episode.recorded_video_id && episode.recorded_video_id === video.video_id) return 'stored_video_id'
  if (episode.receipt_video_id && episode.receipt_video_id === video.video_id) return 'upload_receipt'

  // Only unique when exactly one video's title carries this code.
  if (titleContainsCode(video.title, episode.episode_code) && codeClaimants.get(episode.episode_code) === 1) {
    return 'unique_episode_code'
  }

  const localTitle = normalizeTitle(episode.title)
  const remoteTitle = normalizeTitle(video.title)
  if (localTitle && remoteTitle && localTitle === remoteTitle) return 'exact_title'
  if (localTitle && remoteTitle && titleSimilarity(episode.title!, video.title!) >= 0.7) {
    return 'strong_title_similarity'
  }

  if (episode.scheduled_for && video.published_at) {
    const scheduled = Date.parse(episode.scheduled_for)
    const published = Date.parse(video.published_at)
    if (Number.isFinite(scheduled) && Number.isFinite(published)
      && Math.abs(scheduled - published) <= 24 * 60 * 60 * 1000) {
      return 'publication_proximity'
    }
  }

  if (episode.duration_seconds && video.duration_seconds) {
    const ratio = Math.min(episode.duration_seconds, video.duration_seconds)
      / Math.max(episode.duration_seconds, video.duration_seconds)
    if (ratio >= 0.98) return 'duration_similarity'
  }

  return null
}

export function analyzeYouTubeReconcile(input: {
  episodes: LocalEpisode[]
  videos: RemoteVideo[]
}): ReconcileAnalysis {
  // How many videos carry each episode code, so "unique" means what it says.
  const codeClaimants = new Map<string, number>()
  for (const episode of input.episodes) {
    const claimants = input.videos.filter(video => titleContainsCode(video.title, episode.episode_code)).length
    codeClaimants.set(episode.episode_code, claimants)
  }

  const candidates: MatchCandidate[] = []
  for (const episode of input.episodes) {
    for (const video of input.videos) {
      const evidence = bestEvidence(episode, video, codeClaimants)
      if (!evidence) continue
      candidates.push({
        episode_code: episode.episode_code,
        video_id: video.video_id,
        evidence,
        rank: EVIDENCE_RANK[evidence],
        reason: EVIDENCE_REASON[evidence],
        state: stateForRank(EVIDENCE_RANK[evidence]),
        auto_linkable: EXACT_EVIDENCE.has(evidence),
      })
    }
  }

  // Contested on either side means a person decides. Even a recorded fact is
  // suppressed here: if two episodes both claim one video, linking either
  // automatically would be picking a winner nobody chose.
  const byEpisode = new Map<string, string[]>()
  const byVideo = new Map<string, string[]>()
  for (const candidate of candidates) {
    byEpisode.set(candidate.episode_code, [...(byEpisode.get(candidate.episode_code) ?? []), candidate.video_id])
    byVideo.set(candidate.video_id, [...(byVideo.get(candidate.video_id) ?? []), candidate.episode_code])
  }

  const duplicates: ReconcileAnalysis['duplicates'] = []
  for (const [episodeCode, videoIds] of byEpisode) {
    if (videoIds.length > 1) duplicates.push({ kind: 'episode', id: episodeCode, competing: videoIds })
  }
  for (const [videoId, episodeCodes] of byVideo) {
    if (episodeCodes.length > 1) duplicates.push({ kind: 'video', id: videoId, competing: episodeCodes })
  }

  const contestedEpisodes = new Set(duplicates.filter(d => d.kind === 'episode').map(d => d.id))
  const contestedVideos = new Set(duplicates.filter(d => d.kind === 'video').map(d => d.id))
  for (const candidate of candidates) {
    if (contestedEpisodes.has(candidate.episode_code) || contestedVideos.has(candidate.video_id)) {
      candidate.auto_linkable = false
      candidate.state = 'possible_duplicate'
    }
  }

  const matchedEpisodes = new Set(candidates.map(candidate => candidate.episode_code))
  const matchedVideos = new Set(candidates.map(candidate => candidate.video_id))

  return {
    candidates: candidates.sort((a, b) => a.rank - b.rank || a.episode_code.localeCompare(b.episode_code)),
    local_only: input.episodes.map(e => e.episode_code).filter(code => !matchedEpisodes.has(code)),
    youtube_only: input.videos.map(v => v.video_id).filter(id => !matchedVideos.has(id)),
    duplicates,
  }
}
