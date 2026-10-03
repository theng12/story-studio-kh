/**
 * What the opening (intro clip / title image / title card) will do to scene
 * sync in this render — said on the page BEFORE Generate.
 *
 * Dreamlands E2E 2026-10-03: a 5 s title image was on by default, Scene Plan
 * had reserved nothing, and every scene played 5 s after its narration; the
 * only trace was a line in the render log. The renderer now starts the
 * narration after a silent opening the plan did not reserve (title image /
 * card), so that case stays in sync. An intro VIDEO the plan did not reserve
 * still pushes every scene late (its sound lives inside the merged audio), and
 * a plan that reserved an opening this render does not have is refused — both
 * are said here.
 */

export interface OpeningSyncInput {
  /** Scene Plan source only; Image Pool covers the remaining narration by itself. */
  visualSource: 'scene_plan' | 'image_pool' | string | null
  /** Seconds this episode's Scene Plan reserved for the opening (null = not known yet). */
  planReservedSec: number | null
  introVideoOn: boolean
  /** Measured length of the intro clip, when known. */
  introVideoSec: number
  titleImageOn: boolean
  titleImageSec: number
  titleCardOn: boolean
  titleCardSec: number
}

export interface OpeningSyncNote {
  tone: 'info' | 'warning'
  text: string
}

const fmt = (sec: number): string => `${Math.round(sec * 10) / 10} s`

export function describeOpeningSync(input: OpeningSyncInput): OpeningSyncNote | null {
  if (input.visualSource === 'image_pool' || input.planReservedSec == null) return null
  const reserved = Math.max(0, input.planReservedSec)
  // A text card replaces the image when both are on, exactly as the renderer does.
  const titleSec = input.titleCardOn ? input.titleCardSec : input.titleImageOn ? input.titleImageSec : 0
  const anyOpening = input.introVideoOn || titleSec > 0

  if (reserved > 0) {
    if (!anyOpening) {
      return {
        tone: 'warning',
        text: `This episode's Scene Plan keeps the first ${fmt(reserved)} for an opening, but no intro clip or title is on, `
          + 'so the render will stop before it starts. Turn the opening back on, or open Scene Plan and create the timeline again.',
      }
    }
    return null
  }

  if (input.introVideoOn) {
    const lag = input.introVideoSec + titleSec
    return {
      tone: 'warning',
      text: `Scenes will play ${lag > 0 ? fmt(lag) : 'the intro length'} behind the narration: this episode's Scene Plan `
        + 'did not keep room for the intro clip. Open Scene Plan and create the timeline again (it measures the intro), '
        + 'or turn the intro off.',
    }
  }
  if (titleSec > 0) {
    return {
      tone: 'info',
      text: `The ${fmt(titleSec)} title plays first, then the narration and captions start — scenes stay in sync `
        + `with the narration (the video is ${fmt(titleSec)} longer).`,
    }
  }
  return null
}
