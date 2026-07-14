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
import { beforeEach } from 'node:test'

// Register once per test process. The registrator is idempotent so repeated
// imports (one per test file) are safe — subsequent calls are no-ops.
if (!(globalThis as any).__happyDomRegistered) {
  GlobalRegistrator.register()
  ;(globalThis as any).__happyDomRegistered = true
}

// Pre-resolve the boot-ready gate inside useApi.ts so unit tests don't
// see an unexpected /api/health probe at the head of every captured-
// fetch list. The gate is meaningful in production (waits for backend
// migrations to settle) but is a pure nuisance in tests where every
// $fetch call is mocked anyway. Best-effort: the test suite as a whole
// gets gated only if the import resolves; if it doesn't, the 15 s gate
// timeout is the long-stop.
const apiModule: any = await import('../composables/useApi.js')
apiModule._markBootReadyForTests?.()
beforeEach(() => apiModule._clearApiGetCacheForTests?.())
