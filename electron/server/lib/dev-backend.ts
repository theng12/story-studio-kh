/**
 * Where the dev backend listens, and how the Nuxt dev proxy finds it.
 *
 * ── The bug this module exists to prevent ─────────────────────────────────
 * `npm run dev` used to be three unrelated hardcoded 8000s: the Electron dev
 * branch bound :8000, standalone `tsx` boot defaulted to :8000, and Nuxt's
 * `devProxy` sent `/api` to `http://localhost:8000/api`. On this machine :8000
 * is GenStudio KH's API gateway, which runs permanently — so Story Studio's
 * backend could not have it, and the proxy cheerfully forwarded `/api/projects`
 * into GenStudio, which correctly answered 404. The app loaded and said
 * "Couldn't load your projects", naming neither the port nor the wrong server.
 *
 * It looked fine for the owner only because they run server mode, which binds a
 * fixed port from app-settings.json (8766 today). The proxy default knew
 * nothing about that setting, so it pointed at GenStudio while the backend sat
 * on 8766 — the same silent failure, arrived at from the other direction.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * Nothing knowable is hardcoded. The proxy target is *derived* from wherever
 * the backend actually binds, in the same order the backend decides it, and the
 * one line the dev server prints says which of those branches won.
 *
 * Imported from three places, which is the point — one constant, no drift:
 *   - `electron/main.ts`        → the port Electron's embedded backend binds in dev
 *   - `electron/server/app.ts`  → the port standalone `tsx` boot binds
 *   - `frontend/nuxt.config.ts` → the target Nitro's `/api` devProxy forwards to
 *
 * The Nuxt config runs in plain Node (jiti) at dev-server start, before any
 * Electron or Express machinery exists, so everything here stays free of
 * runtime dependencies: node builtins and `./server-mode.js` only, sync I/O,
 * and no throw path.
 */

import { probeServerModePort } from './server-mode.js'

/**
 * Story Studio's own dev backend port.
 *
 * Not a catalogue value and not negotiable at runtime — it is this app's
 * configuration, so a constant is correct. Chosen to be boring:
 *   - NOT 8000 (GenStudio KH's gateway owns it on the owner's machine), and
 *     not the other habitually-squatted ports — 3000 is Nuxt's own dev server,
 *     5173 Vite, 8080/8888/9000 everything else.
 *   - In the 87xx family so Story Studio's ports stay recognisable next to
 *     server mode's 8765 default, but far enough from 8765/8766 that a dev
 *     backend can never be confused with — or collide with — a server-mode
 *     instance the user is also running.
 *   - Well below macOS's ephemeral range (49152+), so the OS will never hand
 *     it to some unrelated process mid-session.
 *
 * `PORT=… npm run dev` still overrides it for standalone boot, and server mode
 * still wins over it entirely.
 */
export const DEV_BACKEND_PORT = 8791

/** Which branch of the resolution produced the target. */
export type DevApiProxySource = 'env' | 'server-mode' | 'default'

export interface DevApiProxyResolution {
  /** Full target for Nitro's `/api` devProxy, e.g. `http://127.0.0.1:8791/api`. */
  target: string
  source: DevApiProxySource
  /** Human-readable reason, for the startup log. */
  detail: string
  /**
   * Set only when the settings file existed but could not be read/parsed. The
   * resolution still succeeds (dev default); this is what gets shouted about.
   */
  warning?: string
}

/**
 * Resolve where the Nuxt dev server should forward `/api`.
 *
 * Order, most specific first:
 *   1. `STORY_STUDIO_API_PROXY` — the explicit escape hatch. Whatever the
 *      developer put there wins, untouched, including a remote host.
 *   2. Server mode's configured port, when server mode is on. This is the case
 *      that broke silently: the backend binds app-settings.json's port, so the
 *      proxy has to read the same setting rather than guess. Targets loopback
 *      even when the bind is `0.0.0.0` — the dev server and the backend are on
 *      the same machine, and `0.0.0.0` is not a destination address.
 *   3. `DEV_BACKEND_PORT`.
 *
 * Never throws. A missing settings file, an unreadable one, malformed JSON, an
 * absent `server_mode` block, or a nonsense port all land on the dev default —
 * the last two loudly, via `warning`.
 */
export function resolveDevApiProxy(env: NodeJS.ProcessEnv = process.env): DevApiProxyResolution {
  const override = typeof env.STORY_STUDIO_API_PROXY === 'string'
    ? env.STORY_STUDIO_API_PROXY.trim()
    : ''
  if (override) {
    return {
      target: override,
      source: 'env',
      detail: 'STORY_STUDIO_API_PROXY',
    }
  }

  const fallback = devDefaultTarget()

  // Defensive to the point of paranoia: probeServerModePort() already swallows
  // its own I/O and parse errors, but this runs inside the Nuxt config, where
  // an exception takes down the whole dev server before it prints anything.
  let probe: ReturnType<typeof probeServerModePort>
  try {
    probe = probeServerModePort()
  } catch (e) {
    return {
      target: fallback,
      source: 'default',
      detail: `dev default :${DEV_BACKEND_PORT}`,
      warning: `could not read app settings (${(e as Error)?.message || String(e)})`,
    }
  }

  if (probe.status === 'unreadable') {
    return {
      target: fallback,
      source: 'default',
      detail: `dev default :${DEV_BACKEND_PORT}`,
      warning: `could not read ${probe.path} (${probe.error})`,
    }
  }

  if (probe.status === 'enabled') {
    return {
      target: `http://127.0.0.1:${probe.port}/api`,
      source: 'server-mode',
      detail: `server_mode.port ${probe.port} from ${probe.path}`,
    }
  }

  return {
    target: fallback,
    source: 'default',
    detail: `dev default :${DEV_BACKEND_PORT}`,
  }
}

function devDefaultTarget(): string {
  return `http://127.0.0.1:${DEV_BACKEND_PORT}/api`
}

/**
 * The one line the dev server prints at startup.
 *
 * The entire cost of the original bug was that nothing anywhere said where
 * `/api` was going, so a 404 from a completely different product looked like a
 * Story Studio failure. Keep this unconditional.
 */
export function formatDevApiProxyLog(resolution: DevApiProxyResolution): string {
  return `[nuxt.config] dev proxy /api → ${resolution.target}  (source: ${resolution.source} — ${resolution.detail})`
}

/**
 * Warning line for the settings-unreadable case, or null when there is nothing
 * to warn about. Separate from the log line so the caller can send it to
 * stderr: falling back silently is exactly what caused this.
 */
export function formatDevApiProxyWarning(resolution: DevApiProxyResolution): string | null {
  if (!resolution.warning) return null
  return `[nuxt.config] ${resolution.warning}; falling back to the dev backend port ${DEV_BACKEND_PORT}`
}
