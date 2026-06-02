/**
 * Boot the theme system as early as possible in the client lifecycle.
 *
 * v1.0.147+ — a `.client.ts` Nuxt plugin runs after Vite's bundle loads
 * but BEFORE the root app component mounts, so the data-theme attribute
 * is in place before the first render commits. Combined with the
 * synchronous inline pre-script in nuxt.config.ts (which stamps an
 * estimated theme *even earlier*, before the JS bundle has parsed),
 * the user never sees the wrong theme flash.
 *
 * The plugin's only job is to delegate to `_initTheme()` in
 * `composables/useTheme.ts`, which:
 *   1. Reads the persisted mode from localStorage (default 'system').
 *   2. Resolves it against `prefers-color-scheme` when 'system'.
 *   3. Stamps `<html data-theme>` + `color-scheme`.
 *   4. Attaches the matchMedia listener so OS appearance changes flip
 *      the app live for system-mode users.
 */
import { _initTheme } from '~/composables/useTheme'

export default defineNuxtPlugin(() => {
  _initTheme()
})
