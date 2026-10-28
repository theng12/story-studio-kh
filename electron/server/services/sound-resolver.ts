/**
 * Choosing a sound for a label (v1.4.365) — and the seam for the ranker.
 *
 * The `contextual_cues` job proposes a label AND a sound for it. Today the
 * choice is lexical: a few keywords from the bed/spot description are matched
 * against a clip's filename, tags and (for a Gateway clip) its title. That is
 * honest and cheap and it is not what the owner wants long-term.
 *
 * **P4 — EmbeddingGemma — slots in HERE and nowhere else.** The owner's plan is
 * an embedding ranker: embed the moment ("temple bells at dawn"), embed each
 * candidate's description, take the closest. When that lands, `SoundRanker` is
 * the interface it satisfies, `selectSound` reads it, and no other file on this
 * path changes — the candidates, the licence rules, the credits and the review
 * flow all stay exactly as they are.
 *
 * What this file may NOT become: a model call. Ranking a candidate list is
 * local arithmetic over text; a ranker that needs the network is a P4 decision
 * with its own cost and failure rules, not something to smuggle in here.
 */
import type { SoundDesignCue, SoundDesignCredit, SoundDesignCueKind } from '../models/types.js'

/** One thing that could become a cue's sound. */
export interface SoundCandidate {
  source: 'pool' | 'gateway'
  /** Pool id, or the Gateway clip's sha256. */
  key: string
  /** The filename (pool) or the clip's title (gateway) — what search matches on. */
  label: string
  /** Free-text words a ranker may read. Never shown as a credit. */
  description: string
  /** Where the bytes live, for the mixer. Absent for a gateway clip until kept. */
  local_path?: string
  duration_sec?: number
  /** Credits the clip published. Never synthesised for a pool clip. */
  credit?: SoundDesignCredit
}

/**
 * THE P4 SEAM.
 *
 * A ranker takes the moment and the candidate list and returns a permutation of
 * the SAME candidates (or a subset), best first. It must not invent candidates,
 * must not call the network, and must be cheap enough to run over one batch.
 *
 * Unset today, and `selectSound` falls back to the lexical score below. A ranker
 * that throws is skipped rather than failing the proposal: an optional picking
 * aid must never be able to lose a batch of paid work.
 */
export interface SoundRanker {
  readonly id: string
  rank(moment: string, candidates: readonly SoundCandidate[]): readonly SoundCandidate[]
}

let ranker: SoundRanker | null = null

/** Install (or clear, with `null`) the P4 ranker. */
export function setSoundRanker(next: SoundRanker | null): void {
  ranker = next
}

export function activeSoundRanker(): string | null {
  return ranker?.id ?? null
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those', 'it', 'its',
  'as', 'into', 'over', 'under', 'his', 'her', 'their', 'our', 'he', 'she', 'they', 'we',
  'cue', 'label', 'sound', 'effect', 'fx', 'ambience', 'ambient', 'bed', 'spot',
])

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(word => word.length > 2 && !STOP_WORDS.has(word))
}

function lexicalScore(moment: string, candidate: SoundCandidate): number {
  const wanted = new Set(words(moment))
  if (!wanted.size) return 0
  const haystack = new Set(words(`${candidate.label} ${candidate.description} ${(candidate.credit?.title || '')}`))
  let score = 0
  for (const word of wanted) {
    if (haystack.has(word)) score += 3
    // A prefix match (`bell` → `bells`) is weaker but still real.
    else if ([...haystack].some(other => other.startsWith(word) || word.startsWith(other))) score += 1
  }
  return score
}

/**
 * Pick the best sound for one moment, or `null` when nothing matches.
 *
 * `null` is a real answer and is reported as "no sound found" on the cue. It is
 * deliberately not a default clip: a wrong sound is worse than silence, and the
 * reviewer can always pick one by hand.
 *
 * Kinds are never mixed. A bed is continuous ambience and a spot is a one-off;
 * using one as the other produces a mix nobody asked for.
 */
export function selectSound(
  moment: string,
  kind: SoundDesignCueKind,
  candidates: readonly SoundCandidate[],
): { candidate: SoundCandidate; score: number; ranker: string | null } | null {
  const usable = candidates.filter(candidate => (kind === 'bed' ? candidate.duration_sec !== undefined : true))
  if (!usable.length) return null
  let ranked: readonly SoundCandidate[] = usable
  if (ranker) {
    try {
      ranked = ranker.rank(moment, usable)
    } catch {
      // A picking aid must never lose the proposal — fall through to lexical.
      ranked = usable
    }
  }
  const scored = ranked.map(candidate => ({ candidate, score: lexicalScore(moment, candidate) }))
  scored.sort((a, b) => b.score - a.score || a.candidate.label.localeCompare(b.candidate.label))
  const best = scored[0]
  if (!best || best.score <= 0) return null
  return { ...best, ranker: activeSoundRanker() }
}

/**
 * Fill in a cue's sound from a chosen candidate.
 *
 * One place decides what a cue records, so a pool cue and a Gateway cue cannot
 * develop different shapes: the clip reference, the source, the local path a
 * mixer needs, and — for a gateway clip — the credits that a per-clip credit
 * line is built from.
 */
export function applySound(cue: SoundDesignCue, candidate: SoundCandidate): SoundDesignCue {
  const base: SoundDesignCue = {
    ...cue,
    source: candidate.source,
    clip: candidate.source === 'pool' ? candidate.label : candidate.key,
    ...(candidate.source === 'pool'
      ? { pool_id: candidate.key, credit: undefined }
      : { pool_id: undefined, credit: candidate.credit }),
  }
  // A bed that found a candidate takes that clip's measured length as its
  // window when its own is missing — a bed with no end is not a bed.
  if (cue.kind === 'bed' && candidate.duration_sec && (!cue.end_sec || cue.end_sec <= cue.start_sec)) {
    base.end_sec = Number((cue.start_sec + candidate.duration_sec).toFixed(3))
  }
  return base
}

/**
 * The credit line for a finished episode: one entry per distinct clip that
 * actually made it into the mix.
 *
 * "Per clip", not per cue — two cues using the same temple bell are one credit,
 * and a scene's worth of cues using eight different CC0 files is eight. Sorted
 * so the list is stable between renders of the same episode.
 */
export function soundCreditsFor(cues: readonly SoundDesignCue[]): Array<{ clip: string; kind: SoundDesignCueKind; label: string; credit: SoundDesignCredit }> {
  const seen = new Set<string>()
  const out: Array<{ clip: string; kind: SoundDesignCueKind; label: string; credit: SoundDesignCredit }> = []
  for (const cue of [...cues].sort((a, b) => a.start_sec - b.start_sec)) {
    if (!cue.credit) continue
    const key = `${cue.source || 'pool'}:${cue.clip}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ clip: cue.clip, kind: cue.kind, label: cue.label, credit: cue.credit })
  }
  return out
}

/** Plain-text credit block for the job result and the episode's publish record. */
export function formatSoundCredits(cues: readonly SoundDesignCue[]): string[] {
  return soundCreditsFor(cues).map(({ label, credit }) => {
    const author = credit.author ? ` by ${credit.author}` : ''
    const title = credit.title ? `"${credit.title}"` : label
    const url = credit.source_url ? ` — ${credit.source_url}` : ''
    return `${title}${author} (${credit.licence.toUpperCase()}${credit.licence_version ? ` ${credit.licence_version}` : ''})${url}`
  })
}
