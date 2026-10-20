/**
 * A closing-tail re-mix and a standalone Audio Assembly of the SAME episode both write
 * `{CODE}_merged_audio*` and its completion record, so they must never overlap.
 *
 * The re-mix claims the episode under the queue's own per-episode admission lock (the one enqueue and
 * media cleanup take): it sees every audio_merge admitted so far, and from then on enqueue and the
 * audio_merge executor refuse for that episode. If an Audio Assembly is already queued or running the
 * claim is refused instead, with a reason the render shows. The queue has no way to hold a render
 * back, so the render fails once and a Retry after the Audio Assembly finishes goes ahead.
 */

const inProgress = new Set<string>()
const key = (slug: string, code: string) => `${slug}:${code.toUpperCase()}`

export const CLOSING_TAIL_REMIX_IN_PROGRESS =
  'A closing-tail re-mix of this episode\'s audio is in progress. Try again when it finishes.'

export function closingTailRemixInProgress(slug: string, code: string): boolean {
  return inProgress.has(key(slug, code))
}

export async function claimClosingTailRemix(
  slug: string,
  code: string,
): Promise<{ release: () => void } | { busy: string }> {
  const jq = await import('./job-queue.js')
  return jq.withEpisodeMediaAdmissionLock(slug, code, async () => {
    if (jq.hasLiveAudioMerge(slug, code)) {
      return {
        busy: `${code.toUpperCase()}: an Audio Assembly of ${code.toUpperCase()} is queued or running, and the closing-tail re-mix `
          + 'would write the same audio files. Nothing was changed. Retry this render when the Audio Assembly has finished.',
      }
    }
    const k = key(slug, code)
    inProgress.add(k)
    return { release: () => { inProgress.delete(k) } }
  })
}
