/**
 * The queue behind "Generate previews for all styles without one", and behind
 * the three images one style needs.
 *
 * One entry at a time, on purpose: every entry is a paid image render, and a
 * burst of them would spend the credits of every style in the library before the
 * owner could stop it. So the runner awaits each entry in turn, reports progress
 * for each, and reads `isCancelled` BETWEEN entries — a stop takes effect after
 * the render already in flight, never in the middle of one.
 *
 * Kept out of the modal so the sequencing itself can be tested: the component
 * supplies the state, this decides what order anything happens in.
 */

export interface PreviewQueueEntry {
  /** The thing being generated: a style's id, or one of its slots. */
  key: string
  /** What the progress line calls it. */
  label: string
}

export interface PreviewQueueProgress {
  /** 1-based position of the entry being reported. */
  index: number
  total: number
  entry: PreviewQueueEntry
  status: 'running' | 'done' | 'failed'
  error?: string
}

export interface PreviewQueueOutcome {
  completed: string[]
  failed: Array<{ key: string; label: string; error: string }>
  /** True when a stop was asked for and honoured. */
  cancelled: boolean
  /** The entries never started, in order, because the queue was stopped. */
  notStarted: string[]
}

/** The styles the bulk action is for: the owner's own, with no current previews. */
export function userStylesNeedingPreviews<
  T extends { id: string; user_style?: boolean; preview_images?: string[]; preview_stale?: boolean },
>(styles: readonly T[]): T[] {
  return styles.filter(style => style.user_style === true
    && (!style.preview_images?.length || style.preview_stale === true))
}

export async function runPreviewQueue<T extends PreviewQueueEntry>(input: {
  entries: readonly T[]
  generate: (entry: T) => Promise<void>
  isCancelled: () => boolean
  onProgress?: (progress: PreviewQueueProgress) => void
}): Promise<PreviewQueueOutcome> {
  const outcome: PreviewQueueOutcome = { completed: [], failed: [], cancelled: false, notStarted: [] }
  for (const [position, entry] of input.entries.entries()) {
    if (input.isCancelled()) {
      outcome.cancelled = true
      outcome.notStarted.push(...input.entries.slice(position).map(pending => pending.key))
      return outcome
    }
    const index = position + 1
    input.onProgress?.({ index, total: input.entries.length, entry, status: 'running' })
    try {
      await input.generate(entry)
      outcome.completed.push(entry.key)
      input.onProgress?.({ index, total: input.entries.length, entry, status: 'done' })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      outcome.failed.push({ key: entry.key, label: entry.label, error: message })
      input.onProgress?.({ index, total: input.entries.length, entry, status: 'failed', error: message })
    }
  }
  // A stop asked for during the LAST render still counts: the queue is over.
  if (input.isCancelled()) outcome.cancelled = true
  return outcome
}
