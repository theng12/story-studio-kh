/**
 * The one read behind the global Publishing Overview.
 *
 * It composes ONLY local readers — the same stores the Upload Center's own
 * routes read — and never talks to YouTube. Rendering this page costs no
 * quota; the only provider call in the whole feature is the explicit,
 * read-only refresh the page offers, which reuses POST /youtube/sync.
 *
 * It performs no migration write: the channel's plan is read WITHOUT
 * `readChannelSchedule` (which would run the v1.4.249 plan migration). Two
 * self-healing writers do sit on this path, both locked and idempotent, and
 * neither is a migration: the shared operation-index reader repairing its own
 * index (`listYouTubeOperations`), and the connection registry finishing an
 * interrupted transaction (`getProjectYouTubeAssignment` →
 * `recoverPendingRegistryTransaction`).
 *
 * The three facts it keeps apart (see contracts/publishing-overview.ts):
 *
 *   confirmed — publicationCacheView().schedules: private videos YouTube
 *               itself reports with a publishAt. This is COVERAGE.
 *   planned   — the channel's cadence slots (computeSlots) and the locally
 *               chosen date on an episode (readItemSchedule). INTENT. A local
 *               plan never clears a confirmed gap.
 *   readiness — the channel-counts rule (episodeStepJobStates) plus the same
 *               rendered-video check the Upload route admits with, and the SAME
 *               `remoteVideoFor` remote-evidence predicate /youtube/publishable
 *               asks (operation record, reconcile link, legacy sidecar).
 *
 * Everything degrades per channel and per fact: an unreadable store is
 * `unknown`, never a zero. A channel with no usable cadence says
 * `plan_set: false` ("Publishing plan not set") instead of guessing a rhythm,
 * and a cadence that could not be READ says `plan_set: null` + `plan_error`
 * instead of claiming there is none. A readiness sweep that could not read an
 * episode reports `ready_to_publish: null` with `ready_unknown`; an unreadable
 * episode list makes every count over it null rather than 0; a failed YouTube
 * evidence read makes `ready_to_publish` null and suppresses the publish
 * suggestion, because "finished and NOT already on YouTube" cannot be decided.
 * `readiness.error` says which read failed.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import * as pm from './project-manager.js'
import * as jq from './job-queue.js'
import { getIdeas } from './idea-manager.js'
import type { StoredIdea } from './idea-manager.js'
import { readCadence } from './publish-cadence.js'
import { listPlans, getActivePlanId, computeSlots, readItemSchedule, localDayKeyInTz, type UploadSchedule } from './upload-plans.js'
import {
  PUBLICATION_CACHE_TTL_MS,
  readYouTubePublicationCache,
  publicationCacheView,
  legacyUploadsFor,
} from './youtube-publication-cache.js'
import { readYouTubeProjectPublishingState } from './youtube-project-publishing-store.js'
import { listYouTubeOperations } from './youtube-operation-store.js'
import { remoteVideoFor } from './youtube-remote-video.js'
import { readYouTubeConnectionRegistry, getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { resolveYouTubeCredential } from './youtube-credential.js'
import { createProjectFactsCache, projectDirFor, resolveEpisodePaths, type ProjectFactsCache } from './utils.js'
import { findYouTubeSourceVideoPath } from './youtube-source-video.js'
import { episodeStepJobStates, STEP_JOB_TYPES } from '../contracts/episode-step-jobs.js'
import type {
  PublishingFreshness,
  PublishingOverviewAssignment,
  PublishingOverviewCalendarEntry,
  PublishingOverviewChannel,
  PublishingOverviewConfirmedSchedule,
  PublishingOverviewPlannedSlot,
  PublishingOverviewResponse,
} from '../contracts/publishing-overview.js'

/** How many expected slots ahead a channel's cadence is walked. */
export const PLANNED_SLOT_HORIZON = 12

/** Per-channel render sweep batch — the same bound the Publish page uses. */
const READINESS_BATCH = 32

type Registry = Awaited<ReturnType<typeof readYouTubeConnectionRegistry>>

/** A cadence that can actually produce a slot — the same rule publish-cadence.ts enforces. */
function isUsableSchedule(schedule: UploadSchedule | null | undefined): schedule is UploadSchedule {
  if (!schedule || typeof schedule !== 'object') return false
  if (typeof schedule.time_local !== 'string' || !/^\d{2}:\d{2}$/.test(schedule.time_local)) return false
  if (typeof schedule.timezone !== 'string' || !schedule.timezone) return false
  const hasWeekdays = Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
  const hasMonthly = typeof schedule.monthly_day === 'number' && schedule.monthly_day >= 1 && schedule.monthly_day <= 31
  return hasWeekdays || hasMonthly
}

/**
 * Conservative freshness. `newest_checked_at` alone is not enough: a cache can
 * be partly unchecked, or the channel listing can be stale/partial, and either
 * way the newest single observation hides it. So this reads the WHOLE coverage:
 * the listing state, its staleness, and every observation's staleness and
 * checked-ness. Anything less than "listing complete and fresh AND every live
 * video observed and fresh" is `stale` — never a confident `fresh`.
 */
function freshnessOfCoverage(coverage: any): PublishingFreshness {
  const listingState = coverage?.listing?.state ?? 'never'
  const known = coverage?.known_videos ?? 0
  // Nothing known and never listed: we have never looked. Unknown, not stale.
  if (!known && listingState === 'never') return 'unknown'
  const listingCompleteAndFresh = listingState === 'complete' && coverage?.listing?.stale === false
  const everyVideoObservedFresh = (coverage?.stale_videos ?? 0) === 0 && (coverage?.unchecked_videos ?? 0) === 0
  return listingCompleteAndFresh && everyVideoObservedFresh ? 'fresh' : 'stale'
}

/** Local-day key → how many instants fall on it. Consumed one-per-slot, so one video covers one slot. */
function countByDay(instants: string[], tz: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const iso of instants) {
    const day = localDayKeyInTz(new Date(iso), tz)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return counts
}

/**
 * Can this channel's idea store actually be read?
 *
 * `getIdeas` cannot answer that. Its own reader degrades a corrupt or unreadable
 * `ideas.json` to an EMPTY store (`parseStore` in idea-manager.ts), so "this
 * channel has no accepted episodes" and "this channel's idea store could not be
 * read" arrive here as the same empty list — and every count computed over it
 * then reads as a confident zero (AGENTS §6: a zero that means two things is a
 * defect). One bounded read is the only way to tell them apart without changing
 * a shared reader.
 *
 * Absent is a real answer: a channel that has never had an idea genuinely has
 * none. Present-but-unparseable, or present-and-unreadable, is not.
 */
async function ideaStoreReadable(slug: string, facts: ProjectFactsCache): Promise<boolean> {
  let text: string
  try {
    text = await fs.readFile(path.join(projectDirFor(slug, facts), 'ideas.json'), 'utf-8')
  } catch (e: any) {
    return e?.code === 'ENOENT'
  }
  try {
    JSON.parse(text)
    return true
  } catch { return false }
}

async function readConfirmed(
  slug: string,
  channelId: string | null,
  assignedChannelId: string | null,
  now: number,
  facts: ProjectFactsCache,
): Promise<PublishingOverviewChannel['confirmed']> {
  const empty: PublishingOverviewChannel['confirmed'] = {
    next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', schedules: [],
  }
  // "No channel assigned" and "assigned but not connected" need different next
  // actions, so they are different answers, not one empty list.
  if (!channelId) return { ...empty, error: assignedChannelId ? 'channel_not_connected' : 'no_channel_assigned' }
  try {
    // The request-scoped facts cache is passed in, so the operation index (the
    // heaviest local read in the feature — tens of MB on a large channel) is
    // read once for the whole channel, not once per reader.
    const [state, cache, records, legacy] = await Promise.all([
      readYouTubeProjectPublishingState(slug, facts),
      readYouTubePublicationCache(slug),
      listYouTubeOperations(slug, facts),
      legacyUploadsFor(slug, channelId, facts).catch(() => undefined),
    ])
    const view = publicationCacheView(state, cache, records, channelId, { now, legacy })
    const schedules: PublishingOverviewConfirmedSchedule[] = view.schedules.map(entry => ({
      video_id: entry.video_id,
      ...(entry.episode_code ? { episode_code: entry.episode_code } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      scheduled_for: entry.scheduled_for!,
      ...(entry.checked_at ? { checked_at: entry.checked_at } : {}),
      stale: !!entry.stale,
    }))
    const nextAt = schedules.find(entry => Date.parse(entry.scheduled_for) >= now)?.scheduled_for ?? null
    const newest = view.coverage.newest_checked_at
    return {
      next_at: nextAt,
      count: schedules.length,
      last_checked_at: newest,
      freshness: freshnessOfCoverage(view.coverage),
      schedules,
    }
  } catch (e: any) {
    return { ...empty, error: e?.message || 'confirmed schedules unreadable' }
  }
}

async function readReadiness(
  slug: string,
  ideas: StoredIdea[],
  ideasUnreadable: boolean,
  channelId: string | null,
  facts: ProjectFactsCache,
): Promise<{
  readiness: PublishingOverviewChannel['readiness']
  readyToPublish: number | null
  readyCodes: string[]
  pendingCodes: string[]
}> {
  const codes = new Set<string>()
  const withCode: Array<{ episode_code: string; title: string }> = []
  for (const idea of ideas) {
    if (!idea.episode_code) continue
    codes.add(idea.episode_code)
    withCode.push({ episode_code: idea.episode_code, title: idea.title || '' })
  }

  // Why a readiness figure is unknown. One string for the UI to show; the
  // figures themselves carry the type.
  const reasons: string[] = []
  if (ideasUnreadable) {
    reasons.push("Story Studio could not read this channel's ideas, so it cannot say how many episodes it has.")
  }

  // Which episodes YouTube already has. This is the SAME question, answered by
  // the SAME predicate, as /youtube/publishable: `remoteVideoFor` reads all
  // three authoritative stores (operation record, reconcile link, legacy
  // sidecar), channel-scoped. Reading only `episode_video_links` counted an
  // episode published through the old page (sidecar only) or by an operation
  // whose link was never written as "not on YouTube yet" — so the overview
  // recommended an upload the Upload Center correctly refuses.
  //
  // The operation index and publishing state are hoisted out of the per-episode
  // sweep for the same reason the Publish page hoists them: the state read
  // takes a lock, and calling it per episode serialises the batch.
  let onYouTube: number | null = null
  const onYouTubeCodes = new Set<string>()
  let publishingState: Awaited<ReturnType<typeof readYouTubeProjectPublishingState>> | null = null
  let records: Awaited<ReturnType<typeof listYouTubeOperations>> = []
  let linksUnreadable = false
  let operationsUnreadable = false
  if (!ideasUnreadable) {
    try {
      publishingState = await readYouTubeProjectPublishingState(slug, facts)
      const links = publishingState.episode_video_links
      for (const code of codes) {
        if (Object.hasOwn(links, code)) onYouTubeCodes.add(code)
      }
      onYouTube = onYouTubeCodes.size
    } catch {
      linksUnreadable = true
      reasons.push("Story Studio could not read which episodes are already on YouTube.")
    }
    try {
      records = await listYouTubeOperations(slug, facts)
    } catch {
      // Same rule as the state read: without the operation records the remote
      // half cannot be decided, so the ready count must be unknown, never a
      // confident number computed over evidence we failed to read.
      operationsUnreadable = true
      reasons.push('Story Studio could not read its YouTube upload records.')
    }
  }
  // Either store missing makes "already on YouTube" undecidable for the sweep.
  const remoteUnreadable = linksUnreadable || operationsUnreadable
  const remoteReadable = !remoteUnreadable && publishingState !== null

  const inProgress = new Set<string>()
  const needsAttention = new Set<string>()
  let stepError: string | undefined
  try {
    const stepJobs = await jq.getJobs(slug, { type: STEP_JOB_TYPES, view: 'stream' })
    for (const [key, state] of episodeStepJobStates(stepJobs)) {
      const code = key.slice(0, key.lastIndexOf(':'))
      if (!codes.has(code)) continue
      ;(state.state === 'active' ? inProgress : needsAttention).add(code)
    }
  } catch (e: any) {
    stepError = e?.message || 'step jobs unreadable'
  }
  if (stepError) reasons.push(stepError)
  // Both figures are filtered by the accepted-episode set, so neither is
  // computable without it — a 0 there would be a confident count over an empty
  // list nobody actually read.
  const stepKnown = !ideasUnreadable && !stepError

  // Ready = a finished, admissible final video and no YouTube copy yet — the
  // exact pair the Upload route admits on (resolveEpisodePaths +
  // findYouTubeSourceVideoPath). The complement (accepted, not on YouTube, no
  // finished video) is what still needs generating.
  //
  // An episode whose read FAILED is neither: it is counted as UNKNOWN, and the
  // whole figure becomes null rather than a smaller, confident-looking number
  // (AGENTS §6 — a count short by its failures means two things at once). This
  // is the same per-row `renderUnknown` the Upload Center's own sweep keeps
  // (routes/youtube-upload-center.ts), so the two screens cannot disagree.
  let readyToPublish: number | null = null
  let readyUnknown = 0
  let readyCodes: string[] = []
  let pendingCodes: string[] = []
  if (!ideasUnreadable) {
    try {
      const ready: string[] = []
      const pending: string[] = []
      const unknown: string[] = []
      for (let i = 0; i < withCode.length; i += READINESS_BATCH) {
        const batch = withCode.slice(i, i + READINESS_BATCH)
        await Promise.all(batch.map(async (idea) => {
          try {
            // ANY authoritative remote evidence means this video is already
            // uploaded and MUST NOT be recommended as a new one. This is the
            // `/youtube/publishable` predicate itself, not a second copy of it.
            // A corrupt per-episode sidecar throws here and lands in `unknown`,
            // exactly as one corrupt row degrades alone on the Publish page.
            if (remoteReadable && await remoteVideoFor(
              slug, idea.episode_code, idea.title, channelId, records, publishingState!, facts,
            )) return
            const paths = await resolveEpisodePaths(slug, idea.episode_code, idea.title, facts)
            const source = await findYouTubeSourceVideoPath(paths, slug, idea.episode_code, idea.title, facts)
            ;(source ? ready : pending).push(idea.episode_code)
          } catch { unknown.push(idea.episode_code) }
        }))
      }
      readyUnknown = unknown.length
      // "Ready to publish" means finished AND not already on YouTube. With the
      // remote evidence unreadable the second half is unknown, so the count is
      // unknown and no publish suggestion may be built from the `ready` list.
      readyToPublish = (readyUnknown || remoteUnreadable) ? null : ready.length
      readyCodes = remoteUnreadable ? [] : ready.sort()
      pendingCodes = pending.sort()
    } catch {
      readyToPublish = null
      // A null count beside "0 unknown" would read as a complete sweep. Every
      // coded episode is unknown when the sweep itself did not finish.
      readyUnknown = withCode.length
    }
  }

  return {
    readiness: {
      // Parity with /projects/:slug/channel-counts: `episodes` is EVERY accepted
      // idea, code or not. The per-code figures below count only coded episodes,
      // so the two are named distinctly rather than silently differing.
      episodes: ideasUnreadable ? null : ideas.length,
      episodes_with_code: ideasUnreadable ? null : withCode.length,
      ready_to_publish: readyToPublish,
      ready_unknown: readyUnknown,
      on_youtube: onYouTube,
      in_progress: stepKnown ? inProgress.size : null,
      needs_attention: stepKnown ? needsAttention.size : null,
      ...(reasons.length ? { error: reasons.join(' ') } : {}),
    },
    readyToPublish,
    readyCodes,
    pendingCodes,
  }
}

/**
 * Up to two finished-unpublished episodes and one still-to-generate, each with an
 * existing route.
 *
 * These come only from episodes the sweep could actually READ, so every
 * suggestion is a fact about that episode. When the sweep was partial the
 * channel's `readiness.ready_unknown` (and `ready_to_publish: null`) says so —
 * the count is never presented as complete, but a concrete episode we did read
 * is still worth pointing at.
 */
function buildRecommendations(
  slug: string,
  readyCodes: string[],
  pendingCodes: string[],
): PublishingOverviewChannel['recommendations'] {
  const out: PublishingOverviewChannel['recommendations'] = []
  for (const code of readyCodes.slice(0, 2)) {
    out.push({
      episode_code: code,
      kind: 'ready_to_publish',
      label: `Publish ${code}`,
      url: `/projects/${slug}/upload/publish?episode_id=${encodeURIComponent(code)}`,
      reason: 'Finished video, not on YouTube yet.',
    })
  }
  for (const code of pendingCodes.slice(0, 1)) {
    out.push({
      episode_code: code,
      kind: 'needs_generation',
      label: `Continue ${code}`,
      url: `/projects/${slug}/board`,
      reason: 'Accepted, no finished video yet.',
    })
  }
  return out
}

/** The primary next step: the first exact-episode recommendation, else the Board. */
function buildNextAction(
  slug: string,
  recommendations: PublishingOverviewChannel['recommendations'],
  needsAttention: number | null,
): PublishingOverviewChannel['next_action'] {
  const first = recommendations[0]
  if (first) {
    return { kind: first.kind, episode_code: first.episode_code, label: first.label, url: first.url }
  }
  // A null count means the step-job read failed: "review failed steps" would be
  // a claim we cannot make, so the Board is the honest fallback.
  if (needsAttention !== null && needsAttention > 0) {
    return { kind: 'needs_attention', episode_code: null, label: 'Review failed steps', url: `/projects/${slug}/board` }
  }
  return { kind: 'none', episode_code: null, label: 'Open the Production Board', url: `/projects/${slug}/board` }
}

/** Build one channel's overview row. Never throws: every fact degrades on its own. */
export async function buildChannelOverview(
  slug: string,
  name: string,
  registry: Registry | null,
  now: number,
): Promise<{ channel: PublishingOverviewChannel; calendar: PublishingOverviewCalendarEntry[] }> {
  // ONE request-scoped facts cache for the whole channel: project.json, the
  // idea store, the publishing state and the operation index are each read once
  // and shared by every reader below.
  const facts = createProjectFactsCache(slug)
  // The assignment is read separately from the credential so "no channel
  // assigned" and "assigned but not connected" stay distinguishable — they need
  // different next actions, and `resolveYouTubeCredential` answers null for both.
  const assignment = await getProjectYouTubeAssignment(slug).catch(() => null)
  const assignedChannelId = assignment?.channel_id ?? null
  const credential = await resolveYouTubeCredential(slug).catch(() => null)
  const channelId = credential?.channelId ?? null
  const channel = channelId
    ? { channel_id: channelId, title: registry?.channels?.[channelId]?.title || channelId }
    : null

  const confirmed = await readConfirmed(slug, channelId, assignedChannelId, now, facts)

  // Read the channel's plan WITHOUT `readChannelSchedule`: that reader performs
  // the v1.4.249 "give an account its one active plan" migration, and merely
  // viewing a global overview must not write a plan nobody asked for. This is
  // the same pair of readers, minus the write.
  //
  // A read that THREW is not the same answer as a plan that is not there, so the
  // failure is carried instead of being folded into "not set" (AGENTS §6).
  let planError: string | undefined
  const cadence = await readCadence(slug).catch((e: any) => {
    planError = e?.message || 'the publishing cadence could not be read'
    return null
  })
  let plan: { name: string; schedule: UploadSchedule } | null = null
  if (credential) {
    try {
      const own = (await listPlans(slug)).filter(p => p.platform === 'youtube' && p.account_id === credential.accountId)
      const activeId = await getActivePlanId(slug, 'youtube', credential.accountId)
      const active = own.find(p => p.id === activeId)
      if (active) plan = { name: active.name, schedule: active.schedule }
    } catch (e: any) {
      planError ||= e?.message || 'the channel\'s upload plans could not be read'
    }
  }
  const usable = isUsableSchedule(plan?.schedule)
    ? plan!.schedule
    : isUsableSchedule(cadence?.schedule)
      ? cadence!.schedule
      : null
  // True / false / unknown. A usable schedule settles it either way; with none,
  // only a clean read may claim "not set".
  const planSet: boolean | null = usable ? true : (planError ? null : false)
  const tz = usable?.timezone || 'UTC'

  const itemSchedule = await readItemSchedule(slug).catch(() => ({} as Record<string, string>))
  const localPlanned = Object.entries(itemSchedule)
    .filter(([, iso]) => !!iso)
    .map(([key, iso]) => ({ code: key, at: iso }))

  // The idea store's own reader turns a corrupt or unreadable ideas.json into an
  // EMPTY store, so "no accepted episodes" and "could not read the episodes"
  // would arrive here as the same list and every count over it would be a
  // confident zero. The probe is what tells them apart.
  let ideasUnreadable = !(await ideaStoreReadable(slug, facts))
  let ideas: StoredIdea[] = []
  if (!ideasUnreadable) {
    try { ideas = await getIdeas(slug, 'accepted', facts) }
    catch { ideasUnreadable = true }
  }
  const acceptedCodes = new Set(ideas.map(idea => idea.episode_code).filter((code): code is string => !!code))
  // With the episode list unknown, an absent episode_code on a planned date
  // means "unknown", not "this key names no episode" — so it is marked, never
  // left to be read as the other one.
  const identityUnknown = (code: string) => ideasUnreadable && !acceptedCodes.has(code)

  const confirmedDaySet = new Set(confirmed.schedules.map(entry => localDayKeyInTz(new Date(entry.scheduled_for), tz)))

  // Two independent day multisets, each consumed one-per-slot: one video covers
  // at most one slot, and a local plan cannot clear a confirmed gap.
  const confirmedByDay = countByDay(confirmed.schedules.map(entry => entry.scheduled_for), tz)
  const plannedByDay = countByDay(localPlanned.map(entry => entry.at), tz)

  const slots: PublishingOverviewPlannedSlot[] = []
  let nextSlotAt: string | null = null
  let lastSlotAt: string | null = null
  let nextUncoveredSlotAt: string | null = null
  let nextUnplannedSlotAt: string | null = null
  if (usable) {
    const computed = computeSlots(usable, PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
    for (const at of computed) {
      const day = localDayKeyInTz(new Date(at), tz)
      const confirmedCount = confirmedByDay.get(day) ?? 0
      const plannedCount = plannedByDay.get(day) ?? 0
      const confirmedHere = confirmedCount > 0
      const plannedHere = plannedCount > 0
      if (confirmedHere) confirmedByDay.set(day, confirmedCount - 1)
      if (plannedHere) plannedByDay.set(day, plannedCount - 1)
      slots.push({ at, confirmed: confirmedHere, planned: plannedHere })
      if (!nextUncoveredSlotAt && !confirmedHere) nextUncoveredSlotAt = at
      if (!nextUnplannedSlotAt && !confirmedHere && !plannedHere) nextUnplannedSlotAt = at
    }
    nextSlotAt = computed[0] ?? null
    lastSlotAt = computed.at(-1) ?? null
  }

  const { readiness, readyToPublish, readyCodes, pendingCodes } = await readReadiness(slug, ideas, ideasUnreadable, channelId, facts)
  const recommendations = buildRecommendations(slug, readyCodes, pendingCodes)

  const lastConfirmedDate = confirmed.schedules
    .map(entry => localDayKeyInTz(new Date(entry.scheduled_for), tz))
    .sort().at(-1) ?? null
  const lastPlannedDate = localPlanned
    .map(entry => localDayKeyInTz(new Date(entry.at), tz))
    .sort().at(-1) ?? null

  const assignments: PublishingOverviewAssignment[] = localPlanned.map(entry => ({
    ...(acceptedCodes.has(entry.code) ? { episode_code: entry.code } : {}),
    ...(identityUnknown(entry.code) ? { identity_unknown: true as const } : {}),
    at: entry.at,
    confirmed: confirmedDaySet.has(localDayKeyInTz(new Date(entry.at), tz)),
  }))

  // The very next expected slot with no confirmed schedule on it is the urgent case.
  // Only a KNOWN plan can be at risk: an unreadable one is not evidence of a gap.
  const atRisk = planSet === true && !!nextSlotAt && nextUncoveredSlotAt === nextSlotAt

  const priority: PublishingOverviewChannel['priority'] = nextUncoveredSlotAt
    ? { reason: 'earliest_uncovered_slot', at: nextUncoveredSlotAt }
    : (readyToPublish ?? 0) > 0
      ? { reason: 'close_to_complete', at: null, detail: `${readyToPublish} finished episode${readyToPublish === 1 ? '' : 's'} waiting for a slot` }
      : { reason: 'none', at: null }

  // Calendar: confirmed events, then locally planned episode events (with
  // identity), then a marker ONLY for cadence slots with nothing on them — so a
  // day never shows two markers for one event, and an empty expected slot is
  // never mistaken for a plan.
  const calendar: PublishingOverviewCalendarEntry[] = []
  for (const entry of confirmed.schedules) {
    calendar.push({
      channel_slug: slug,
      channel_name: name,
      kind: 'confirmed',
      at: entry.scheduled_for,
      ...(entry.episode_code ? { episode_code: entry.episode_code } : {}),
      video_id: entry.video_id,
      ...(entry.title ? { title: entry.title } : {}),
    })
  }
  const emittedPlannedDays = new Set<string>()
  for (const entry of localPlanned) {
    const day = localDayKeyInTz(new Date(entry.at), tz)
    if (confirmedDaySet.has(day)) continue // one event, not two
    if (emittedPlannedDays.has(day)) continue // one marker per day
    emittedPlannedDays.add(day)
    calendar.push({
      channel_slug: slug,
      channel_name: name,
      kind: 'planned',
      at: entry.at,
      ...(acceptedCodes.has(entry.code) ? { episode_code: entry.code } : {}),
      ...(identityUnknown(entry.code) ? { identity_unknown: true as const } : {}),
    })
  }
  for (const slot of slots) {
    const day = localDayKeyInTz(new Date(slot.at), tz)
    if (slot.confirmed || slot.planned) continue
    if (emittedPlannedDays.has(day)) continue
    emittedPlannedDays.add(day)
    calendar.push({ channel_slug: slug, channel_name: name, kind: 'planned', at: slot.at, empty: true })
  }

  return {
    channel: {
      slug,
      name,
      channel,
      plan_set: planSet,
      ...(planSet === null ? { plan_error: planError || 'the publishing plan could not be read' } : {}),
      plan_name: plan?.name ?? null,
      timezone: usable?.timezone ?? null,
      confirmed,
      planned: {
        next_slot_at: nextSlotAt,
        next_uncovered_slot_at: nextUncoveredSlotAt,
        next_unplanned_slot_at: nextUnplannedSlotAt,
        last_slot_at: lastSlotAt,
        slots,
        assignments,
      },
      coverage: {
        last_confirmed_date: lastConfirmedDate,
        last_planned_date: lastPlannedDate,
        next_uncovered_slot: nextUncoveredSlotAt,
        scheduled_video_count: confirmed.count,
        planned_date_count: localPlanned.length,
        ready_video_count: readyToPublish,
        at_risk: atRisk,
      },
      readiness,
      priority,
      recommendations,
      next_action: buildNextAction(slug, recommendations, readiness.needs_attention),
    },
    calendar,
  }
}

function priorityRank(reason: PublishingOverviewChannel['priority']['reason']): number {
  return reason === 'earliest_uncovered_slot' ? 0 : reason === 'close_to_complete' ? 1 : 2
}

/** Every channel at once, in priority order: earliest confirmed gap first, then closest to finished. */
export async function readPublishingOverview(options: { now?: number } = {}): Promise<PublishingOverviewResponse> {
  const now = options.now ?? Date.now()
  const projects = await pm.listProjects()
  const registry = await readYouTubeConnectionRegistry().catch(() => null)

  const channels: PublishingOverviewChannel[] = []
  const calendar: PublishingOverviewCalendarEntry[] = []
  // Channels are independent and the fleet is small (tens, not thousands), so
  // build them together. Every store read is local; the readiness sweep inside
  // each channel is already batched.
  const built = await Promise.all(projects.map(project => buildChannelOverview(project.slug, project.name, registry, now)))
  for (const entry of built) {
    channels.push(entry.channel)
    calendar.push(...entry.calendar)
  }

  channels.sort((a, b) => {
    const ra = priorityRank(a.priority.reason)
    const rb = priorityRank(b.priority.reason)
    if (ra !== rb) return ra - rb
    if (a.priority.reason === 'earliest_uncovered_slot' && a.priority.at && b.priority.at && a.priority.at !== b.priority.at) {
      return a.priority.at < b.priority.at ? -1 : 1
    }
    return (b.coverage.ready_video_count ?? 0) - (a.coverage.ready_video_count ?? 0)
  })
  calendar.sort((a, b) => a.at.localeCompare(b.at))

  return { generated_at: new Date(now).toISOString(), cache_ttl_ms: PUBLICATION_CACHE_TTL_MS, channels, calendar }
}
