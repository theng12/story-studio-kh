/**
 * The app-wide Content Pack install queue.
 *
 * Owner report 2026-09-12: "i don't know if i can click out after placing
 * order or clicking installation. like it should run in the background
 * right?" The queue used to be created inside the Content Store page, so
 * leaving the page dropped every count and status while the requests kept
 * going somewhere nobody could see. This one lives at module scope: it is the
 * same queue from every page, the global strip reads it, and coming back to
 * the Store shows exactly where it is.
 *
 * Each install asks the server for the install alone (`refreshOverview:
 * false`); the overview is re-read once when the queue drains, and every
 * eight installs so a long run still updates the Owned tab as it goes.
 */
import { computed, ref, watch } from 'vue'
import { useInstallQueue, type InstallQueue } from '~/composables/useInstallQueue'
import { useContentStore } from '~/composables/useContentStore'

export interface ContentInstallQueue extends InstallQueue {
  /** Size of the current run: everything queued since the queue was last idle. */
  batchTotal: import('vue').ComputedRef<number>
  /** Installed or failed within the current run. */
  batchDone: import('vue').ComputedRef<number>
  batchInstalled: import('vue').ComputedRef<number>
  batchFailed: import('vue').ComputedRef<number>
  /** Title of the pack being installed right now, when the catalog knows it. */
  activeTitle: import('vue').ComputedRef<string>
  /** True once a run has finished and nothing has been queued since. */
  finished: import('vue').ComputedRef<boolean>
  /** Why a release failed to install, in the Store's own words, or ''. */
  failureOf: (releaseId: string) => string
  /** Every failure of the current run, with the pack's title where known. */
  failures: import('vue').ComputedRef<Array<{ releaseId: string; title: string; detail: string }>>
}

const REFRESH_EVERY = 8

let shared: ContentInstallQueue | null = null

function build(): ContentInstallQueue {
  const store = useContentStore()
  const batch = ref<string[]>([])
  const failureReasons = ref(new Map<string, string>())
  let sinceRefresh = 0

  async function refreshQuietly(): Promise<void> {
    sinceRefresh = 0
    try { await store.refresh({ background: true }) } catch { /* the Store renders the exact boundary */ }
  }

  const queue = useInstallQueue(async (releaseId) => {
    try {
      const installed = await store.installRelease(releaseId, { refreshOverview: false })
      failureReasons.value.delete(releaseId)
      return installed
    } catch (cause) {
      // This queue owns its own Store instance, whose `error` ref no page
      // renders. The reason is kept here, per release, so the card and the
      // strip can say WHY — "signature invalid" and "network gone" are
      // different next steps.
      const known = store.error.value
      const detail = known?.detail || (cause as { message?: string })?.message || 'This Content Pack could not be installed.'
      failureReasons.value = new Map(failureReasons.value).set(releaseId, detail)
      throw cause
    } finally {
      sinceRefresh += 1
      if (sinceRefresh >= REFRESH_EVERY) void refreshQuietly()
    }
  })

  const enqueue = (releaseId: string): void => {
    const before = queue.pendingCount.value
    queue.enqueue(releaseId)
    if (queue.pendingCount.value === before) return
    failureReasons.value.delete(releaseId)
    // A fresh run starts from an idle queue; otherwise the run grows.
    batch.value = before === 0 && batch.value.every(id => queue.statusOf(id) === 'installed' || queue.statusOf(id) === 'failed')
      ? [releaseId]
      : [...batch.value.filter(id => id !== releaseId), releaseId]
  }
  const enqueueAll = (releaseIds: readonly string[]): void => { for (const id of releaseIds) enqueue(id) }

  const statuses = computed(() => batch.value.map(id => queue.statusOf(id)))
  const batchTotal = computed(() => batch.value.length)
  const batchInstalled = computed(() => statuses.value.filter(status => status === 'installed').length)
  const batchFailed = computed(() => statuses.value.filter(status => status === 'failed').length)
  const batchDone = computed(() => batchInstalled.value + batchFailed.value)
  const finished = computed(() => batchTotal.value > 0 && !queue.running.value)
  const activeTitle = computed(() => {
    const releaseId = queue.activeReleaseId.value
    if (!releaseId) return ''
    return store.products.value.find(product => product.currentRelease?.releaseId === releaseId)?.title ?? ''
  })

  // The queue drained: one overview read replaces the per-install rebuilds.
  watch(queue.running, (running, was) => { if (was && !running) void refreshQuietly() })

  const clearFinished = (): void => {
    queue.clearFinished()
    if (!queue.running.value) { batch.value = []; failureReasons.value = new Map() }
  }
  const failureOf = (releaseId: string): string => failureReasons.value.get(releaseId) ?? ''
  const failures = computed(() => batch.value
    .filter(id => queue.statusOf(id) === 'failed')
    .map(id => ({
      releaseId: id,
      title: store.products.value.find(product => product.currentRelease?.releaseId === id)?.title ?? id,
      detail: failureOf(id),
    })))

  return {
    ...queue,
    enqueue,
    enqueueAll,
    clearFinished,
    batchTotal,
    batchDone,
    batchInstalled,
    batchFailed,
    activeTitle,
    finished,
    failureOf,
    failures,
  }
}

export function useContentInstallQueue(): ContentInstallQueue {
  shared ??= build()
  return shared
}

export function _resetContentInstallQueueForTests(): void {
  shared = null
}
