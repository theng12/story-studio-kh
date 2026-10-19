/**
 * One process-wide connection cap for every outbound `fetch`.
 *
 * WHY THIS EXISTS (2026-10-19). The production mini held 264 simultaneous TCP
 * connections to the Gateway and helped take it down. Nothing capped anything: a
 * bare `fetch` uses undici's default dispatcher, whose per-origin pool is
 * unbounded (`connections: null`), so every concurrent call opened its own socket
 * and a response body nobody read kept it open. This installs ONE shared Agent
 * whose per-origin pool is small, which makes the number of open sockets a
 * property of the process rather than of how much work happens to be in flight.
 *
 * The cap is per ORIGIN, so it constrains nothing but the endpoint it is aimed
 * at: a streaming upload to YouTube is a different origin and gets its own pool.
 *
 * Calls past the cap QUEUE rather than fail, and the Agent keeps connections
 * alive, so a long download or a streaming artifact read still completes — it
 * just holds one of the eight for as long as it streams. The cap trades
 * worst-case latency under saturation for a bounded socket count.
 *
 * Set at server boot, before anything can fetch. `undici` is a declared
 * dependency because the object installed here is the one Node's bundled
 * undici dispatches through, and a hoisted transitive dependency is not a
 * guarantee that it is present in a packaged build.
 */
import { Agent, setGlobalDispatcher } from 'undici'

/** Sockets this process may hold open to any one origin at a time. */
export const OUTBOUND_CONNECTIONS_PER_ORIGIN = 8

let installed: Agent | null = null

/**
 * Install the cap and return the shared Agent. Idempotent: a second call reuses
 * the first Agent, so it cannot leave the first one's sockets unreferenced.
 */
export function installOutboundConnectionCap(): Agent {
  if (!installed) {
    installed = new Agent({
      connections: OUTBOUND_CONNECTIONS_PER_ORIGIN,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
    })
    setGlobalDispatcher(installed)
  }
  return installed
}
