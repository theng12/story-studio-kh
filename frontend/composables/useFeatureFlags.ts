/**
 * App-wide feature flags. Kept dead-simple on purpose: a module-scoped
 * frozen object that code reads synchronously. No reactivity, no remote
 * fetch — flips happen at build time or by editing this file.
 *
 * When a flag flips from false → true, also delete any "paused" banners
 * / "coming soon" badges that gate on the same flag.
 */

export const FEATURE_FLAGS = Object.freeze({
  /**
   * Multi-machine cloud sync (manifest polling + reload-from-cloud toasts).
   * Off while the feature is hardened: new projects can't pick cloud mode,
   * and `useManifestSync` short-circuits so existing portable projects
   * don't poll either. The underlying code is intentionally kept so this
   * can be flipped back on once the bugs are fixed.
   */
  CLOUD_SYNC_ENABLED: false,
})

export function useFeatureFlags() {
  return FEATURE_FLAGS
}
