/**
 * Notification-center state (v1.0.196+).
 *
 * One global singleton backing the bell in the top bar. It unifies two
 * feeds the operator used to chase across inline dashboard banners + the
 * /jobs page:
 *
 *   - **Activity**     finished / failed jobs, renders, batch work for the
 *                      CURRENT project. Derived live from `useJobs()` — no
 *                      new transport, just a terminal-state view over the
 *                      same SSE-fed list. An unread high-water mark drives
 *                      the badge; "Mark all read" advances it.
 *
 *   - **Action needed** setup / readiness gaps that risk a wasted render:
 *                      no upload destination, no usable AI model key, a model
 *                      the channel already uses being retired, FFmpeg missing
 *                      (auto-checked here), plus items pages push in
 *                      via `report()` (asset-audit gaps, partial scan, stale
 *                      data). Each is dismissible; a dismissal survives
 *                      client-side navigations but clears on app relaunch
 *                      (sessionStorage), so a still-unfixed blocker resurfaces
 *                      next launch rather than nagging every page.
 *
 * Activity scope is current-project-only by design — `useJobs` already
 * filters its list to the active slug, so the feed follows the project the
 * operator is looking at.
 */

import { ref, readonly, computed } from 'vue'
import { useApi } from './useApi.js'
import { useJobs, type Job } from './useJobs.js'
import { retiringConfiguredModels, type ChannelCatalogRow } from '../utils/genstudio-model-retirement.js'
import { customerSafeJobText, jobRequestIds } from '../utils/job-presentation.js'

export type NotifSeverity = 'blocking' | 'warning' | 'info'
export type NotifTab = 'activity' | 'action'

/** A readiness / setup gap surfaced in the "Action needed" tab. Either
 *  auto-checked here (upload / apikeys / model-retirement / ffmpeg) or pushed
 *  by a page via `report()` (asset-audit, partial-scan, load-error). */
export interface ActionItem {
  /** Stable, unique within a slug. Dismissals + de-dupe key off this. */
  key: string
  severity: NotifSeverity
  title: string
  detail: string
  /** Route to the fix (rendered as a "Fix" link). */
  to?: string
  /** Inline action callback (rendered as a button) — used for page-local
   *  fixes like "Retry" that can't be a plain route. Not persisted. */
  onClick?: () => void | Promise<void>
  /** Label for the onClick button. Defaults to "Retry". */
  actionLabel?: string
  /** Whether the operator can dismiss it. Defaults true. */
  dismissible?: boolean
}

export interface ActivityItem {
  id: string
  /** Friendly job-type label. */
  kind: string
  /** Episode id / job title. */
  title: string
  status: 'done' | 'error'
  /** Finished-at epoch ms (0 if unknown). */
  ts: number
  error?: string | null
}

const JOB_TYPE_LABELS: Record<string, string> = {
  idea_campaign: 'Idea Campaign',
  'script-only': 'Script',
  'introduction-only': 'Introduction',
  'chapter-only': 'Chapter regen',
  outline_only: 'Outline',
  expand_chapters: 'Chapters',
  images: 'Images',
  scene_images: 'Scene Images',
  thumb_images: 'Thumbnails',
  image_prompts: 'Prompts',
  images_repair: 'Image Repair',
  audio: 'Audio',
  audio_merge: 'Audio Assembly',
  video: 'Video',
  video_assembly: 'Video Assembly',
  continuity_render: 'Continuity Render',
  metadata: 'Metadata',
  youtube_upload: 'YouTube Upload',
  youtube_playlist_update: 'Playlist Update',
  subtitles_transcribe: 'Subtitles',
  broll_normalize: 'B-Roll Normalize',
  broll_assemble: 'B-Roll Assembly',
  broll_select: 'B-Roll Selection',
  broll_autotag: 'B-Roll Tagging',
  research_run: 'Research',
  scene_plan_run: 'Scene Plan',
  contextual_cues: 'Contextual Cues',
  scene_image_generate: 'Scene Image',
  scene_clips_batch: 'Motion Clips',
}

function labelForJob(job: Job): string {
  if (job.type === 'image_prompts' && (job.params as any)?.mode === 'thumbnails') return 'Thumbnail Prompts'
  if (job.type === 'image_prompts' && (job.params as any)?.mode === 'scenes') return 'Scene Prompts'
  const t = job.type
  return JOB_TYPE_LABELS[t] || t.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function tsOf(iso: string | null): number {
  if (!iso) return 0
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : 0
}

export function activityItemForJob(job: Job): ActivityItem {
  return {
    id: job.job_id,
    kind: labelForJob(job),
    title: job.title || job.episode_id || labelForJob(job),
    status: job.status as 'done' | 'error',
    ts: tsOf(job.finished_at),
    error: job.error === null ? null : customerSafeJobText(job.error, jobRequestIds(job)),
  }
}

// ── Module-singleton state ────────────────────────────────────────────────

// Per-slug action items, keyed by item.key. A reactive object keyed by slug
// so each project keeps its own readiness list.
const actionBySlug = ref<Record<string, Record<string, ActionItem>>>({})

// Panel UI state.
const isOpen = ref(false)
const activeTab = ref<NotifTab>('action')

// Avoid overlapping readiness fetches for the same slug.
const _inFlight = new Set<string>()

// ── sessionStorage helpers (survive SPA nav, clear on app relaunch) ─────────

const DISMISS_KEY = 'ss:notif:dismissed'
const SEEN_KEY = 'ss:notif:activitySeen'

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage disabled / quota — dismissals just won't persist this session */
  }
}

// Reactive mirrors of the persisted maps so computed lists recompute on change.
const dismissed = ref<Record<string, string[]>>(readJson(DISMISS_KEY, {}))
const activitySeen = ref<Record<string, number>>(readJson(SEEN_KEY, {}))

function isDismissed(slug: string, key: string): boolean {
  return (dismissed.value[slug] || []).includes(key)
}

// ── Readiness auto-checks ───────────────────────────────────────────────────

function setItem(slug: string, item: ActionItem): void {
  const bucket = { ...(actionBySlug.value[slug] || {}) }
  bucket[item.key] = item
  actionBySlug.value = { ...actionBySlug.value, [slug]: bucket }
}
function removeItem(slug: string, key: string): void {
  const bucket = actionBySlug.value[slug]
  if (!bucket || !(key in bucket)) return
  const next = { ...bucket }
  delete next[key]
  actionBySlug.value = { ...actionBySlug.value, [slug]: next }
}

/**
 * Run the auto setup checks for a slug and reconcile the
 * upload/apikeys/model-retirement/ffmpeg items. Page-pushed items (via report)
 * are left untouched. Fail-quiet: a failed probe leaves that item in its prior
 * state rather than firing a false "missing" alert.
 */
async function refreshReadiness(slug: string): Promise<void> {
  if (!slug || slug === 'undefined' || typeof window === 'undefined') return
  if (_inFlight.has(slug)) return
  _inFlight.add(slug)
  const { get } = useApi()
  try {
    // 1. Upload destinations — a missing channel means a finished render can't
    //    publish. Surfaced as a warning ("before you render").
    try {
      const r = await get<{ accounts: Record<string, any[]> }>(`/projects/${slug}/upload/accounts`)
      const count = Object.values(r?.accounts || {}).reduce((n, arr) => n + (arr?.length || 0), 0)
      if (count === 0) {
        setItem(slug, {
          key: 'upload',
          severity: 'warning',
          title: 'No upload destination connected',
          detail: 'Connect a YouTube channel before you render — otherwise publishing fails after the video is built.',
          to: `/projects/${slug}/upload`,
        })
      } else {
        removeItem(slug, 'upload')
      }
    } catch { /* unknown — leave prior state, no false alarm */ }

    // 2. AI model keys — if NOTHING is usable, every generator fails. Hard blocker.
    //    The same catalogue read also answers check 2b below, so it is fetched
    //    once and both checks share it.
    let catalog: ChannelCatalogRow[] = []
    try {
      const models = await get<Array<{ available: boolean } & ChannelCatalogRow>>(`/models?project=${slug}`)
      if (Array.isArray(models)) catalog = models
      const anyUsable = Array.isArray(models) && models.some(m => m.available)
      if (!anyUsable && Array.isArray(models)) {
        setItem(slug, {
          key: 'apikeys',
          severity: 'blocking',
          title: 'No AI model available',
          detail: 'No API key is configured for any text model, so script/metadata generation will fail. Add a key in Settings → This Mac.',
          to: `/projects/${slug}/settings`,
        })
      } else {
        removeItem(slug, 'apikeys')
      }
    } catch { /* leave prior state */ }

    // 2b. A model this channel is ALREADY configured to use is being retired.
    //
    //     This is where a retirement actually costs something. The picker warns
    //     whoever is choosing a model right now; a channel set up months ago is
    //     nobody's current choice, and its owner has no reason to reopen the
    //     picker before the date passes. GenStudio has published the countdown
    //     on every catalogue row the whole time — the app simply never looked.
    //
    //     A warning rather than a blocker, at every stage of the countdown: the
    //     model still works today, and the fix is to pick another one before it
    //     stops. Once the date has passed the sentence switches to the past
    //     tense on its own and the existing `apikeys` check takes over as the
    //     blocker, because by then the product is simply unavailable.
    try {
      if (catalog.length) {
        const config = await get<Record<string, unknown>>(`/projects/${slug}/settings/config`)
        const retiring = retiringConfiguredModels(config, catalog)
        if (retiring.length) {
          setItem(slug, {
            key: 'model-retirement',
            severity: 'warning',
            // Counted, never pluralised by hand into a wrong sentence.
            title: retiring.length === 1
              ? `${retiring[0].label} is being retired`
              : `${retiring.length} models this channel uses are being retired`,
            // GenStudio's dates, one line each, in the order they fall due,
            // then what to do about them once — not after every line.
            detail: `${retiring.map(model => model.notice).join(' ')} `
              + `Open the stage${retiring.length === 1 ? '' : 's'} using `
              + `${retiring.length === 1 ? 'it' : 'them'} and pick another model.`,
          })
        } else {
          removeItem(slug, 'model-retirement')
        }
      }
    } catch { /* leave prior state */ }

    // 3. FFmpeg — required for every audio/video assembly + render.
    try {
      const f = await get<{ installed: boolean }>(`/ffmpeg/status`)
      if (f && f.installed === false) {
        setItem(slug, {
          key: 'ffmpeg',
          severity: 'blocking',
          title: 'FFmpeg not installed',
          detail: 'Audio and video assembly need FFmpeg. Install it from Settings, or run "brew install ffmpeg".',
          to: `/projects/${slug}/settings`,
        })
      } else {
        removeItem(slug, 'ffmpeg')
      }
    } catch { /* leave prior state */ }
  } finally {
    _inFlight.delete(slug)
  }
}

// Severity rank for sorting (blocking first).
const SEV_RANK: Record<NotifSeverity, number> = { blocking: 0, warning: 1, info: 2 }

export function useNotifications() {
  const { jobs } = useJobs()

  /** Push (or update) a page-local readiness item for a slug. */
  function report(slug: string, item: ActionItem): void {
    if (!slug) return
    setItem(slug, item)
  }

  /** Remove a previously reported item (e.g. condition cleared). */
  function clear(slug: string, key: string): void {
    removeItem(slug, key)
  }

  /** Active (non-dismissed) action items for a slug, blocking-first. */
  function actionItems(slug: string) {
    return computed<ActionItem[]>(() => {
      const bucket = actionBySlug.value[slug] || {}
      return Object.values(bucket)
        .filter(it => !(it.dismissible !== false && isDismissed(slug, it.key)))
        .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
    })
  }

  /** Terminal (done/error) jobs for the current project, newest first. */
  function activityItems() {
    return computed<ActivityItem[]>(() => {
      return (jobs.value as readonly Job[])
        .filter(j => j.status === 'done' || j.status === 'error')
        .map(activityItemForJob)
        .sort((a, b) => b.ts - a.ts)
    })
  }

  function dismiss(slug: string, key: string): void {
    const list = new Set(dismissed.value[slug] || [])
    list.add(key)
    dismissed.value = { ...dismissed.value, [slug]: [...list] }
    writeJson(DISMISS_KEY, dismissed.value)
  }

  /** Count of action items that warrant a badge (blocking + warning, active). */
  function actionBadge(slug: string) {
    return computed<number>(() =>
      actionItems(slug).value.filter(it => it.severity !== 'info').length,
    )
  }

  /** Count of terminal jobs finished after the last "mark read". */
  function activityBadge(slug: string) {
    return computed<number>(() => {
      const seen = activitySeen.value[slug] || 0
      return activityItems().value.filter(it => it.ts > seen).length
    })
  }

  /** Total badge for the bell. */
  function totalBadge(slug: string) {
    return computed<number>(() => actionBadge(slug).value + activityBadge(slug).value)
  }

  function markActivityRead(slug: string): void {
    const items = activityItems().value
    const maxTs = items.reduce((m, it) => Math.max(m, it.ts), 0)
    activitySeen.value = { ...activitySeen.value, [slug]: Math.max(maxTs, Date.now()) }
    writeJson(SEEN_KEY, activitySeen.value)
  }

  function isActivityUnread(slug: string, ts: number): boolean {
    return ts > (activitySeen.value[slug] || 0)
  }

  function open(tab?: NotifTab): void {
    if (tab) activeTab.value = tab
    isOpen.value = true
  }
  function close(): void {
    isOpen.value = false
  }
  function toggle(slug?: string): void {
    isOpen.value = !isOpen.value
    // When opening, land on whichever tab has something to show.
    if (isOpen.value && slug) {
      activeTab.value = actionBadge(slug).value > 0 ? 'action' : 'activity'
    }
  }

  return {
    // state
    isOpen: readonly(isOpen),
    activeTab,
    // feeds
    actionItems,
    activityItems,
    // badges
    actionBadge,
    activityBadge,
    totalBadge,
    // mutations
    report,
    clear,
    dismiss,
    refreshReadiness,
    markActivityRead,
    isActivityUnread,
    // panel control
    open,
    close,
    toggle,
  }
}
