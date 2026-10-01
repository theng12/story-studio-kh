/**
 * Which music model a request names when it names none.
 *
 * The Music page sends no model id, so the backend and the page both fall back to "the first
 * published row" — and the page prints that row's price beside its name. The gateway's Hub rows
 * come in catalogue order, and the first of them is YuE2, which *sings*: its lane states
 * `lyrics` required and "no instrumental switch", and the Hub refuses a request without lyrics.
 * Story's top-up sends `instrumental: true` and no lyrics, so taking `models[0]` blindly made
 * every default top-up a certain refusal at the Hub (found tracing the seam, 2026-10-01).
 *
 * The fields read here (`requires_lyrics`, `supports_instrumental`) are the ones the gateway
 * publishes from the lane's own contract; an absent field means "not stated" and never rules a
 * model out. This is the one function the page and the generator both call, so the model priced
 * on screen is the model that is charged.
 */
export interface MusicModelCapability {
  requires_lyrics?: boolean | null
  supports_instrumental?: boolean | null
}

export interface MusicRequestNeeds {
  /** The request asks for an instrumental track. */
  instrumental: boolean
  /** The request carries a lyric sheet. */
  hasLyrics: boolean
}

export function musicModelCanServe(model: MusicModelCapability, needs: MusicRequestNeeds): boolean {
  if (model.requires_lyrics === true && !needs.hasLyrics) return false
  if (needs.instrumental && !needs.hasLyrics && model.supports_instrumental === false) return false
  return true
}

/** The first published model that can serve the request, or `undefined` when none can. */
export function pickDefaultMusicModel<T extends { id?: string } & MusicModelCapability>(
  models: readonly T[], needs: MusicRequestNeeds,
): T | undefined {
  return models.find(model => musicModelCanServe(model, needs))
}
