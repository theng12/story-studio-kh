/**
 * How far a job's bar has got — and the ONLY thing allowed to decide it.
 *
 * Owner, 2026-11-16: "a job must not show high progress while almost nothing
 * succeeded." Production HMH0113 (18 chapters, 0 completed, 17 failed, one
 * still running) showed **running 94%**, and later **100%** with 0 of 18 done.
 * The bar had been counting SETTLED work — `completed + failed` — so every
 * failure moved it forward and a batch that produced nothing ran to the end.
 * A bar is a claim about work that exists; a failure is not that work.
 *
 * So progress is completions over the planned total, and nothing else. Failed,
 * held and cancelled items are facts the row states on its own line
 * (`item_progress.failed` etc.); they are deliberately NOT folded in here, and
 * no formula at a call site may add them back.
 *
 * One exception, and it is not a fudge: a total of zero means there was
 * nothing to do (a re-render whose only target was already on disk). That is
 * finished work, so it reads 100 — the same convention `generators/audio.ts`
 * has always used — rather than an indeterminate bar over an empty batch.
 */
export function completedPercent(completed: number, total: number): number {
  if (!(total > 0)) return 100
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
}
