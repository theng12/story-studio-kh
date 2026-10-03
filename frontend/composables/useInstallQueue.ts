/**
 * Installing several packs without waiting for each one.
 *
 * The store used to hold a single busy release id, so every other Install
 * button was disabled until the current install returned. With sixty-five
 * packs that means sixty-five deliberate waits. Clicks now go into a queue and
 * are worked one at a time.
 *
 * ONE AT A TIME IS DELIBERATE. Installing writes into the same Content Pack
 * runtime state file and takes a coordination lock; running two at once would
 * either serialise inside that lock anyway or race. What changes here is that
 * the CUSTOMER no longer waits — the queue does.
 */
import { computed, ref } from 'vue'

export type InstallQueueStatus = 'idle' | 'queued' | 'installing' | 'installed' | 'failed'

export interface InstallQueue {
  enqueue: (releaseId: string) => void
  enqueueAll: (releaseIds: readonly string[]) => void
  statusOf: (releaseId: string) => InstallQueueStatus
  isBusy: (releaseId: string) => boolean
  activeReleaseId: import('vue').ComputedRef<string>
  pendingCount: import('vue').ComputedRef<number>
  failedCount: import('vue').ComputedRef<number>
  running: import('vue').ComputedRef<boolean>
  clearFinished: () => void
}

export function useInstallQueue(
  install: (releaseId: string) => Promise<unknown>,
  /** Checked after a failure: true drops everything still waiting (a failure every pack would share). */
  shouldStop?: () => boolean,
): InstallQueue {
  const waiting = ref<string[]>([])
  const active = ref('')
  const finished = ref(new Map<string, 'installed' | 'failed'>())
  let draining = false

  const activeReleaseId = computed(() => active.value)
  const pendingCount = computed(() => waiting.value.length + (active.value ? 1 : 0))
  const failedCount = computed(() => [...finished.value.values()].filter(state => state === 'failed').length)
  const running = computed(() => pendingCount.value > 0)

  function statusOf(releaseId: string): InstallQueueStatus {
    if (active.value === releaseId) return 'installing'
    if (waiting.value.includes(releaseId)) return 'queued'
    return finished.value.get(releaseId) ?? 'idle'
  }

  function isBusy(releaseId: string): boolean {
    const status = statusOf(releaseId)
    return status === 'queued' || status === 'installing'
  }

  function enqueue(releaseId: string): void {
    if (!releaseId) return
    // Already waiting or running: a second click must not queue it twice.
    if (active.value === releaseId || waiting.value.includes(releaseId)) return
    finished.value.delete(releaseId)
    waiting.value = [...waiting.value, releaseId]
    void drain()
  }

  function enqueueAll(releaseIds: readonly string[]): void {
    for (const releaseId of releaseIds) enqueue(releaseId)
  }

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      for (;;) {
        const next = waiting.value[0]
        if (next === undefined) break
        waiting.value = waiting.value.slice(1)
        active.value = next
        try {
          await install(next)
          finished.value = new Map(finished.value).set(next, 'installed')
        } catch {
          // The caller keeps the exact failure (useContentInstallQueue records
          // the reason per release). What the queue owes is to record that this
          // one did not install and to keep going, so one bad pack cannot
          // strand the rest of the batch.
          finished.value = new Map(finished.value).set(next, 'failed')
          if (shouldStop?.()) waiting.value = []
        } finally {
          active.value = ''
        }
      }
    } finally {
      draining = false
    }
  }

  function clearFinished(): void {
    finished.value = new Map()
  }

  return { enqueue, enqueueAll, statusOf, isBusy, activeReleaseId, pendingCount, failedCount, running, clearFinished }
}
