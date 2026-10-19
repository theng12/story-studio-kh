/**
 * One process-wide cap on outbound sockets.
 *
 * WHY THIS EXISTS (2026-10-19). The production mini held 264 simultaneous TCP
 * connections to the Gateway and helped take it down. Nothing capped anything: a
 * bare `fetch` uses undici's default dispatcher, whose per-origin pool is
 * unbounded (`connections: null`), so every concurrent call opened its own socket
 * and nothing ever returned one. `lib/outbound-connections.ts` installs one
 * shared Agent at boot; this pins what it enforces.
 *
 * WHAT THIS CANNOT SEE. Whether a bare `fetch` routes through the installed
 * dispatcher is the RUNTIME's decision, not this app's — Electron 43's bundled
 * Node 24 consults the global dispatcher, a plain Node 26 does not — so a test
 * that proved the cap through a bare `fetch` would pass on the machine that
 * ships and fail on the test runner's own Node. The cap is therefore proved
 * against the dispatcher this process installed, which is the same object every
 * bare `fetch` uses on the Mac mini.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, describe, test } from 'node:test'

import { fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import {
  installOutboundConnectionCap,
  OUTBOUND_CONNECTIONS_PER_ORIGIN,
} from '../lib/outbound-connections.js'

const originalDispatcher = getGlobalDispatcher()
after(() => { setGlobalDispatcher(originalDispatcher) })

/** Peak sockets one origin held open while `run` did its work. */
async function peakSockets(run: (url: string) => Promise<void>): Promise<number> {
  let open = 0
  let peak = 0
  const server = createServer((_req, res) => {
    open++
    peak = Math.max(peak, open)
    res.on('close', () => { open-- })
    // Long enough that every permitted socket is open before the first completes.
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok') }, 250)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => resolve()) })
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
  return peak
}

describe('outbound connection cap', () => {
  test('one shared Agent is installed as the process dispatcher, once', () => {
    const first = installOutboundConnectionCap()
    const second = installOutboundConnectionCap()
    assert.equal(second, first, 'a second install must not replace the first Agent')
    assert.equal(getGlobalDispatcher(), first, 'the process dispatcher is not the capped Agent')
  })

  test('concurrent requests to one origin never exceed the cap, and reuse their sockets after', async () => {
    const agent = installOutboundConnectionCap()
    const round = (url: string) => Promise.all(
      Array.from({ length: 24 }, () => undiciFetch(url, { dispatcher: agent })),
    ).then(responses => Promise.all(responses.map(response => response.text())))

    const peak = await peakSockets(async url => {
      await round(url)
      // A second and third round can only stay at the cap if the first round's
      // sockets went back to the pool; a leak would stack 24 more on top of them.
      await round(url)
      await round(url)
    })
    assert.equal(peak, OUTBOUND_CONNECTIONS_PER_ORIGIN,
      `${peak} sockets were held open at once against one origin`)
  })
})
