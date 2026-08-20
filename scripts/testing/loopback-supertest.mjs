/**
 * Backend-test preload — make supertest bind the address it connects to.
 *
 * Why this exists (v1.4.14). `routes.test.ts` failed about once every 200 runs
 * with statuses no route in this codebase can return: a 401 on
 * `GET /api/ffmpeg/status`, a 401 where a retired route returns 410, and — the
 * one originally reported — `Cannot read properties of undefined (reading
 * 'scene_images')`, which is what a hijacked `POST /ideas/:id/accept` looks
 * like two lines later when `episode_code` came back undefined.
 *
 * The app never saw those requests — its own response logger, which records
 * every non-404 status >= 400, had nothing for them. They were answered by a
 * different server on the same port.
 *
 * supertest's `serverAddress()` calls `app.listen(0)` with no host, which binds
 * the IPv6 wildcard `::` in dual-stack mode, and then connects to
 * `http://127.0.0.1:<port>`. Those are not the same address, and that gap is
 * the bug: while the test server holds `::<port>`, another process can still
 * bind `127.0.0.1:<port>` specifically — the bind succeeds, both listeners
 * coexist, and the more specific one wins every connection addressed to
 * 127.0.0.1. Demonstrated directly: with a dual-stack test server up, a second
 * listener took the same port on the IPv4 loopback and answered the request in
 * its place. On the machine where this was found, the neighbour that keeps
 * claiming IPv4-loopback ports in the ephemeral range is Tailscale's LocalAPI,
 * which answers `401 auth required` to every path — hence the impossible
 * statuses. Ephemeral ports cycle through the whole 49152-65535 range, so any
 * test in any file could draw the short straw, which is why it read as a flaky
 * test rather than as a reply from the wrong server.
 *
 * Binding 127.0.0.1 explicitly closes the gap: the test server now holds the
 * exact address the client dials, so a neighbour's bind on that port fails with
 * EADDRINUSE instead of quietly taking precedence — and, in the other order,
 * the kernel will not hand out a port a neighbour already holds. Verified both
 * ways. The one wrinkle is that `listen(port, host)` resolves the host before
 * binding, so `address()` is null for a tick — and supertest reads the port in
 * its constructor, in the same tick `await` calls `end()`. We therefore build
 * the URL and fire the request when the server reports `listening` instead.
 *
 * Loaded via NODE_OPTIONS from scripts/testing/run-backend-tests.mjs so it
 * covers every backend test file, present and future, without each one having
 * to remember. `supertest-loopback-bind.test.ts` fails if it stops working.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const supertest = require('supertest')
const Test = supertest.Test

if (typeof Test?.prototype?.serverAddress !== 'function' || typeof Test?.prototype?.end !== 'function') {
  throw new Error(
    'loopback-supertest: supertest.Test#serverAddress / #end are missing. '
    + 'supertest changed shape — update this preload before the backend tests can be trusted.',
  )
}

const PATCHED = Symbol.for('story-studio.loopback-supertest')

if (!Test.prototype[PATCHED]) {
  Test.prototype[PATCHED] = true

  const PENDING_PATH = Symbol('story-studio.pendingLoopbackPath')
  const originalServerAddress = Test.prototype.serverAddress
  const originalEnd = Test.prototype.end

  Test.prototype.serverAddress = function serverAddress(app, path) {
    // Already listening (a server the caller bound itself, or a URL string):
    // not ours to re-bind, and upstream's protocol detection still applies.
    if (typeof app?.listen !== 'function' || app.address()) {
      return originalServerAddress.call(this, app, path)
    }
    this._server = app.listen(0, '127.0.0.1')
    this[PENDING_PATH] = path
    return undefined // resolved in end(), once the bind has completed
  }

  Test.prototype.end = function end(fn) {
    const path = this[PENDING_PATH]
    if (path === undefined) return originalEnd.call(this, fn)
    this[PENDING_PATH] = undefined

    const server = this._server
    const send = () => {
      this.url = `http://127.0.0.1:${server.address().port}${path}`
      originalEnd.call(this, fn)
    }
    // `await request(app)...` calls end() in the same tick as the constructor,
    // so the port usually is not known yet — send once the bind lands.
    if (server.address()) send()
    else {
      server.once('listening', send)
      // A bind that fails would otherwise leave the request hanging forever.
      server.once('error', error => { this.assert(error, undefined, fn) })
    }
    return this
  }
}
