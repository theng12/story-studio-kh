/**
 * Test bootstrap — loaded via `tsx --import ./__tests__/setup.ts`.
 *
 * Registers happy-dom's `window`, `document`, `navigator`, etc. as Node
 * globals so composables that read from the DOM work without each test
 * having to construct its own Window.
 *
 * Composables that rely on Vue auto-imports still need explicit imports
 * (see `useToast.ts` et al.). Happy-dom only provides the browser surface;
 * Nuxt's runtime is not loaded.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Register once per test process. The registrator is idempotent so repeated
// imports (one per test file) are safe — subsequent calls are no-ops.
if (!(globalThis as any).__happyDomRegistered) {
  GlobalRegistrator.register()
  ;(globalThis as any).__happyDomRegistered = true
}
