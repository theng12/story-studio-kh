/**
 * Thumbnail scoring — the shape of one episode's scores and the rules that
 * read them.
 *
 * The owner approved this design (2026-11-01):
 *
 *   - **Stage 1, rules.** Throw out clear failures using what can be MEASURED
 *     LOCALLY: the wrong size or ratio, a near-blank picture, muddy contrast.
 *     A local rule never claims to read spelling — only a model can see that.
 *   - **Stage 2, model score.** A free vision-capable chat product on the
 *     Gateway looks at the survivors and scores each for clarity, curiosity
 *     and match with the title, with a short reason. It also reports
 *     misspelled or cut-off text, because only it can see that.
 *   - The highest score wins automatically; the page shows every candidate's
 *     score and reason, and the owner can overrule.
 *
 * Rules this module pins:
 *
 *   - **A typed state, never a zero.** `scored | rejected_by_rule | not_scored`.
 *     A missing score and a score of 0 are different facts (AGENTS §6), so a
 *     candidate that could not be measured carries `not_scored` with a reason
 *     and NO number.
 *   - **A score is bound to the file's CONTENT HASH.** A regenerated or edited
 *     file changes its hash, so its old score is stale and is not used.
 *   - **One record per episode.** The record lives beside that episode's
 *     thumbnails and is keyed by content hash, so one episode's record can
 *     never reach another (§4).
 *   - **Khmer channels skip every text check.** Their thumbnails are plain:
 *     no painted text, no overlay (owner, 2026-10-30). A spelling check on a
 *     picture that has no text is a check of nothing.
 *
 * Zero-dependency on purpose: the frontend runtime imports this module too, so
 * both sides agree on the states and on which candidate wins.
 */

/** The per-episode record's schema version. Bumped when the shape changes. */
export const THUMBNAIL_SCORE_SCHEMA = 1

/** The record's filename, inside the episode's own folder. */
export const THUMBNAIL_SCORE_FILENAME = 'thumbnail_scores.json'

/**
 * The three states one candidate can be in.
 *
 * - `scored`            a model looked at it and gave it a number and a reason.
 * - `rejected_by_rule`  a LOCAL rule threw it out before any model call.
 * - `not_scored`        it was not measured — no model, a provider failure, an
 *   unreadable answer, a Khmer channel's text check, or a stale hash. It
 *   carries a reason and NO score.
 */
export type ThumbnailScoreState = 'scored' | 'rejected_by_rule' | 'not_scored'

/** One candidate's score. */
export interface ThumbnailScore {
  state: ThumbnailScoreState
  /**
   * The model's score, 0–100. Present only for `scored`.
   *
   * ABSENT is not the same as 0: 0 is a real judgement, and a candidate that
   * was never measured carries no number at all (§6).
   */
  score?: number
  /** The model's own reason, in one short sentence. Present for `scored`. */
  reason?: string
  /**
   * What the model read as misspelled or cut off, if anything.
   *
   * Only a model can see this. A local rule never fills it in.
   */
  text_issue?: string
  /** Why this candidate is not scored, or why a rule rejected it. */
  reason_code?: string
  /** The file's content hash at the moment it was scored. */
  sha256?: string
  /** When the score was made. */
  scored_at?: string
  /** The model that gave the score, for the record. */
  model_id?: string
  model_name?: string
  /** The provider the catalogue published for that model (§2 — display only). */
  provider_name?: string
}

/** One candidate's entry in the episode's record, keyed by file name. */
export interface ThumbnailScoreEntry extends ThumbnailScore {
  filename: string
}

/** The whole episode record. */
export interface ThumbnailScoreRecord {
  schema: number
  episode_code: string
  scored_at: string
  /** The candidates, by file name. */
  candidates: Record<string, ThumbnailScoreEntry>
  /**
   * The pick the scores produced, and why — the log the owner asked for so
   * the scores can later be compared with real click-through.
   */
  pick?: {
    filename: string
    /**
     * The score that chose it.
     *
     * ABSENT when the winner was NOT chosen by a score — a human pin, or the
     * newest-version fallback. A missing score is not a 0 (§6).
     */
    score?: number
    reason: string
    at: string
    /** Why this filename won. Never 'the newest version' when a score chose it. */
    basis: 'score' | 'manual_pin' | 'newest_version'
  }
}

/**
 * The local rule that threw a candidate out.
 *
 * `aspect`      the picture's size or ratio is not what a thumbnail must be.
 * `blank`       the picture is effectively one colour — near-blank.
 * `contrast`    the picture is too flat to read.
 * `unreadable`  the file cannot be read as an image at all.
 */
export type ThumbnailRuleRejection = 'aspect' | 'blank' | 'contrast' | 'unreadable'

/** The plain sentence each rejection gets. Read by a person, not a machine. */
export const THUMBNAIL_RULE_REJECTION_TEXT: Record<ThumbnailRuleRejection, string> = {
  aspect: 'the picture is not a wide 16:9 thumbnail',
  blank: 'the picture is almost blank',
  contrast: 'the picture is too flat to read',
  unreadable: 'the file could not be read as an image',
}

/** The rule thresholds, in one place so a change is visible. */
export const THUMBNAIL_RULE_LIMITS = {
  /** How far from 16:9 a thumbnail may be before the rule rejects it. */
  aspect_tolerance: 0.02,
  /** Below this per-channel standard deviation the picture counts as flat. */
  min_stdev: 6,
  /** Below this per-channel standard deviation the picture counts as blank. */
  blank_stdev: 1,
  /** The smallest edge, in pixels, a thumbnail may have. */
  min_width: 320,
  min_height: 180,
} as const

/** The score band a model is asked for, and the one Story Studio accepts. */
export const THUMBNAIL_SCORE_MIN = 0
export const THUMBNAIL_SCORE_MAX = 100

/**
 * Read one score, whatever shape it arrived in.
 *
 * A number that is not a number, or is outside 0–100, is NOT a score: the
 * candidate becomes `not_scored` with a reason. It never becomes a 0 (§6).
 */
export function normalizeThumbnailScore(raw: unknown): { score: number } | { error: string } {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { error: 'The model did not give a number for this picture.' }
  }
  if (raw < THUMBNAIL_SCORE_MIN || raw > THUMBNAIL_SCORE_MAX) {
    return { error: `The model gave a score outside 0–100 (${raw}).` }
  }
  return { score: raw }
}

/**
 * The score bands the model is asked for, in plain words.
 *
 * The rubric lives in the service, not here: this module is about the shape of
 * the answer, and the frontend never shows the rubric.
 */
export const THUMBNAIL_SCORE_BANDS = [
  { band: 'poor', min: 0, max: 39, words: 'unclear, dull, or nothing like the title' },
  { band: 'fair', min: 40, max: 69, words: 'readable but not especially inviting' },
  { band: 'good', min: 70, max: 89, words: 'clear and worth a click' },
  { band: 'excellent', min: 90, max: 100, words: 'clear, curiosity-making and exactly on the title' },
] as const

/** The band a score falls in, for the page's label. */
export function thumbnailScoreBand(score: number): string {
  for (const entry of THUMBNAIL_SCORE_BANDS) {
    if (score >= entry.min && score <= entry.max) return entry.band
  }
  return 'poor'
}
