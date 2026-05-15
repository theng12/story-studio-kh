/**
 * useMachineLabel — singleton handle for "which Mac is this?".
 *
 * v1.0.93+ presets are tagged with the machine they were saved on so the
 * preset picker on Audio Merge + Video Assembly can filter to "this device"
 * by default. Every `usePresets()` instance needs the current device label,
 * so we cache it module-level: first caller kicks off one HTTP fetch,
 * everyone else reads from the shared ref.
 *
 * The label comes from `getMachineLabel()` on the backend — which is just
 * `os.hostname()` with an 'unknown' fallback. Same string the portable
 * manifest writes for "last edited on <machine>", so the UI is consistent
 * across surfaces.
 *
 * Usage:
 *   const { machineLabel, isLoading } = useMachineLabel()
 *   // machineLabel is a Ref<string> — '' until the fetch lands, then the
 *   // hostname. Don't gate UI on isLoading; it's <100ms in practice.
 */
import { ref, computed } from 'vue'
import { useApi } from './useApi.js'

// Module-level state — shared across every caller. Vue's reactivity tracks
// changes via .value, so consumers can `watch(machineLabel, ...)` if they
// need to react to the first-load transition. Cleared only on page reload.
const cachedLabel = ref<string>('')
const isLoading = ref<boolean>(false)
let inFlight: Promise<void> | null = null

function fetchOnce(): Promise<void> {
  if (cachedLabel.value) return Promise.resolve()
  if (inFlight) return inFlight
  isLoading.value = true
  const { get } = useApi()
  inFlight = get<{ machine_label: string }>(`/system/machine-label`)
    .then(r => {
      cachedLabel.value = r?.machine_label || 'unknown'
    })
    .catch(() => {
      // Backend offline / endpoint missing — fall back to a sentinel string
      // so the picker doesn't crash. Same behaviour as manifest.ts on host
      // resolution failure.
      cachedLabel.value = 'unknown'
    })
    .finally(() => {
      isLoading.value = false
      inFlight = null
    })
  return inFlight
}

export function useMachineLabel() {
  // Kick off the fetch on first use without awaiting — callers read the
  // ref reactively. When the ref hasn't populated yet (e.g. during SSR
  // hydration or the first 50ms after mount) callers see an empty string
  // and should treat that as "device unknown for now" rather than a real
  // label. The cross-device comparison logic in usePresets handles this
  // by deferring the filter until the label is non-empty.
  void fetchOnce()
  return {
    machineLabel: computed(() => cachedLabel.value),
    isLoading: computed(() => isLoading.value),
    /** Explicit refresh — exposed for tests / debug. Production callers
     *  shouldn't need this; the hostname doesn't change while the app is
     *  running. */
    refresh: () => {
      cachedLabel.value = ''
      inFlight = null
      return fetchOnce()
    },
  }
}
