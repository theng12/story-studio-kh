/**
 * Fixed loopback listener for the update hold. Contract:
 * _orchestra/youtube-stack/update-hold/CONTRACT.md, section "The endpoint has
 * to be findable" - the Launcher reads the hold URL from the signed feed's
 * holdURL, a fixed string, so the hold must answer on a fixed port even
 * though the app's main API server picks a random port at launch. This
 * module mounts the SAME handlers as routes/system.ts: one hold
 * implementation, one pause state, two listeners.
 *
 * Both methods also require the Launcher's 0600 hold token (server/hold-auth.ts),
 * because a fixed loopback port is reachable by anything on this Mac.
 *
 * Fail open: if 8647 is taken, Story still runs and does its work; it logs
 * one plain line and just cannot be held while it runs.
 */

import express from 'express'
import http from 'http'
import { maintenanceHoldPost, maintenanceHoldDelete } from './routes/system.js'
import { maintenanceHoldOtherMethod } from './hold-auth.js'

export const HOLD_ENDPOINT_PORT = 8647

export const HOLD_ENDPOINT_URL = `http://127.0.0.1:${HOLD_ENDPOINT_PORT}/api/maintenance/hold`

export function startHoldEndpoint(): http.Server {
  const app = express()
  app.disable('x-powered-by')
  app.post('/api/maintenance/hold', maintenanceHoldPost)
  app.delete('/api/maintenance/hold', maintenanceHoldDelete)
  app.all('/api/maintenance/hold', maintenanceHoldOtherMethod)
  const server = app.listen(HOLD_ENDPOINT_PORT, '127.0.0.1')
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.log(`[update-hold] hold endpoint could not be opened on 127.0.0.1:${HOLD_ENDPOINT_PORT} (${e.code || e.message}); Story keeps running and doing its work - it just cannot be held while it runs`)
    server.close()
  })
  return server
}
