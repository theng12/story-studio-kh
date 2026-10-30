/**
 * Still Posts — the production flow's step states (owner, 2026-10-30).
 *
 * Pure on purpose: the step rail, each step's header, the page's landing choice and the tests all read
 * the same answer from the same facts. A step is never "done" because a folder exists; the facts come
 * from the server's verification (AGENTS §8) and from the jobs the page is watching.
 *
 * The five steps are Channel look → Write → Draw → Review → Publish. They are sidebar entries (the
 * WORKFLOW section) and one page with a `?tab=` per step, the same pattern as Thumbnails.
 */

import { STILL_POST_TAB_LABELS, STILL_POST_TABS, type StillPostTab } from '../composables/useProjectFlow'

export { STILL_POST_TAB_LABELS, STILL_POST_TABS }
export type { StillPostTab }

/** Honest states only: a step is never shown as passed when it has not run. */
export type StillPostStepState = 'not-started' | 'in-progress' | 'running' | 'failed' | 'done'

export const STILL_POST_STATE_LABELS: Record<StillPostStepState, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  running: 'Running',
  failed: 'Failed',
  done: 'Done',
}

export interface StillPostJobFact {
  status: string
  error?: string | null
}

export interface StillPostFlowFacts {
  /** Characters saved for this channel's cast. */
  castCount: number
  postCount: number
  /** Posts whose artwork and finals are verified complete in every chosen frame. */
  completePostCount: number
  /** Complete posts a reviewer has not approved yet — the review board's "needs review" count. */
  needsReviewCount: number
  approvedCount: number
  /** Approved posts that have a receipt on every platform the channel has turned on. */
  publishedCount: number
  socialOn: boolean
  /** The newest write job, whatever its outcome. Null when none has been queued. */
  writeJob: StillPostJobFact | null
  /** The newest draw job, whatever its outcome. Null when none has been queued. */
  drawJob: StillPostJobFact | null
}

export interface StillPostStepStatus {
  tab: StillPostTab
  state: StillPostStepState
  /** One plain sentence: what is done, or what to do next, or why it failed. */
  reason: string
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'paused'])

export function isStillPostTab(value: unknown): value is StillPostTab {
  return typeof value === 'string' && (STILL_POST_TABS as readonly string[]).includes(value)
}

/** The URL of one step. Old `/still-posts` links carry no tab; the page resolves one on arrival. */
export function stillPostTabRoute(slug: string, tab: StillPostTab): string {
  return `/projects/${slug}/still-posts?tab=${tab}`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function isActive(job: StillPostJobFact | null): boolean {
  return !!job && ACTIVE_JOB_STATUSES.has(job.status)
}

function writeStep(facts: StillPostFlowFacts): Omit<StillPostStepStatus, 'tab'> {
  if (isActive(facts.writeJob)) {
    return { state: 'running', reason: 'Writing the batch. Posts appear here as they are written.' }
  }
  if (facts.writeJob?.status === 'error') {
    const why = facts.writeJob.error || 'The writer stopped before it finished.'
    return facts.postCount > 0
      ? { state: 'failed', reason: `The last write failed: ${why} The posts already written are kept.` }
      : { state: 'failed', reason: `The write failed: ${why} Nothing was saved. Change the brief or the model and write again.` }
  }
  if (facts.postCount > 0) {
    return { state: 'done', reason: `${plural(facts.postCount, 'post')} written.` }
  }
  return { state: 'not-started', reason: 'Describe a batch and write it.' }
}

function drawStep(facts: StillPostFlowFacts): Omit<StillPostStepStatus, 'tab'> {
  if (isActive(facts.drawJob)) {
    return { state: 'running', reason: 'Drawing. Each post is lettered and shows up as soon as it is finished.' }
  }
  if (facts.postCount === 0) {
    return { state: 'not-started', reason: 'Write posts first. There is nothing to draw yet.' }
  }
  const missing = facts.postCount - facts.completePostCount
  if (facts.drawJob?.status === 'error' && missing > 0) {
    return {
      state: 'failed',
      reason: `The last drawing stopped: ${facts.drawJob.error || 'the image model did not return an image.'} `
        + `${plural(missing, 'post')} still need drawing. Finished drawings are kept; draw again to finish the rest.`,
    }
  }
  if (missing === 0) {
    return { state: 'done', reason: `All ${plural(facts.postCount, 'post')} drawn in every chosen frame.` }
  }
  if (facts.completePostCount > 0) {
    return { state: 'in-progress', reason: `${facts.completePostCount} of ${facts.postCount} drawn. Draw the rest.` }
  }
  return { state: 'not-started', reason: `${plural(facts.postCount, 'post')} waiting to be drawn.` }
}

function reviewStep(facts: StillPostFlowFacts): Omit<StillPostStepStatus, 'tab'> {
  if (facts.postCount === 0) {
    return { state: 'not-started', reason: 'Nothing to review yet. Write and draw a batch first.' }
  }
  const undrawn = facts.postCount - facts.completePostCount
  if (facts.approvedCount >= facts.postCount) {
    return { state: 'done', reason: `All ${facts.postCount} approved.` }
  }
  if (facts.approvedCount > 0) {
    return {
      state: 'in-progress',
      reason: [`${facts.approvedCount} of ${facts.postCount} approved.`, undrawn > 0 ? `${plural(undrawn, 'post')} still to draw.` : 'Review the rest.'].join(' '),
    }
  }
  if (undrawn > 0) {
    return { state: 'not-started', reason: `${plural(undrawn, 'post')} must be drawn before review.` }
  }
  return { state: 'not-started', reason: 'Review each post and approve it. Only approved posts are published.' }
}

function publishStep(facts: StillPostFlowFacts): Omit<StillPostStepStatus, 'tab'> {
  if (facts.approvedCount === 0) {
    return { state: 'not-started', reason: 'Approve posts in Review first. Only approved posts appear here.' }
  }
  if (!facts.socialOn) {
    return {
      state: 'in-progress',
      reason: `${facts.approvedCount} approved. Nothing is sent: posting is off for this channel, so export and post by hand.`,
    }
  }
  if (facts.publishedCount >= facts.approvedCount) {
    return { state: 'done', reason: `All ${facts.approvedCount} approved posts are posted.` }
  }
  return { state: 'in-progress', reason: `${facts.publishedCount} of ${facts.approvedCount} approved posts posted. Nothing is sent by itself.` }
}

/** The five steps, in order, each with its state and the sentence that says why. */
export function stillPostStepStates(facts: StillPostFlowFacts): StillPostStepStatus[] {
  const lookDone = facts.castCount > 0
  return [
    {
      tab: 'look',
      state: lookDone ? 'done' : 'not-started',
      reason: lookDone
        ? `${plural(facts.castCount, 'character')} in this channel's cast.`
        : 'Choose at least one character for this channel, then save it.',
    },
    { tab: 'write', ...writeStep(facts) },
    { tab: 'draw', ...drawStep(facts) },
    { tab: 'review', ...reviewStep(facts) },
    { tab: 'publish', ...publishStep(facts) },
  ]
}

/** Where a returning person lands: the first step that is not done, or Publish once all are. */
export function landingTab(states: readonly StillPostStepStatus[]): StillPostTab {
  return states.find(entry => entry.state !== 'done')?.tab ?? 'publish'
}

/** The step after this one, for the "Next" button. Null after Publish. */
export function nextStillPostTab(tab: StillPostTab): StillPostTab | null {
  const index = STILL_POST_TABS.indexOf(tab)
  return index >= 0 && index < STILL_POST_TABS.length - 1 ? STILL_POST_TABS[index + 1]! : null
}
