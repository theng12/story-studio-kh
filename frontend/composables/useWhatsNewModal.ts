/**
 * What's New modal — singleton state, mounted once in app.vue.
 *
 * Two open paths:
 *   1. Auto-show on first launch after upgrade (or first install). Compares
 *      the runtime app version to `last_seen_version` from app-settings;
 *      mismatch → open. Dismiss persists current version so it won't fire
 *      again until the next upgrade.
 *   2. Manual: any caller can `useWhatsNewModal().open()` (e.g. sidebar
 *      "What's new?" button or Help → What's New menu item).
 */

import { ref, readonly } from 'vue'

const _open = ref(false)
const _autoCheckDone = ref(false)

function open() { _open.value = true }
function close() { _open.value = false }

export function useWhatsNewModal() {
  return {
    isOpen: readonly(_open),
    open,
    close,
    /** Internal — used by app.vue's auto-show check to dedupe across HMR. */
    _autoCheckDone,
  }
}
