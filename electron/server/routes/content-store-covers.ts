import { Router } from 'express'

import { getApiKey } from '../services/app-secrets-store.js'
import { getGenStudioUrl } from '../services/app-settings.js'

/**
 * Pack cover art, served from the one paired Gateway through Story's own server.
 *
 * WHY IT IS PROXIED AT ALL. The renderer's Content-Security-Policy allows
 * `img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*`
 * (`lib/security.ts`), and each Mac's Gateway lives at its own `http://…:port`.
 * Pointing an `<img>` at the Gateway directly is therefore blocked by CSP and
 * fails as a silent blank image — the "CSS that silently does nothing" shape in
 * AGENTS.md §3. Same-origin bytes have neither problem, and the Gateway address
 * stays the single one this app talks to.
 *
 * The cover is product-level data on the Gateway, not part of a signed archive:
 * an existing released pack can gain a cover without a new version, a new
 * archive or a new hash. A missing cover is a 404, which the card renders as the
 * honest "no preview yet" state — never a stand-in picture.
 */
export const router = Router()

const COVER_MAX_BYTES = 4 * 1024 * 1024
const COVER_TIMEOUT_MS = 10_000
// Pack ids and versions are opaque to this route; it only refuses the shapes a
// path could be built from, so no separator, dot-segment or escape reaches the
// upstream URL.
const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const COVER_MIME = /^image\/(webp|png|jpeg)$/i

/** The one place the Gateway's cover route is named. */
export function gatewayCoverPath(packId: string, version: string): string {
  return `/admin/api/content-library/covers/${encodeURIComponent(packId)}/${encodeURIComponent(version)}`
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function fail(res: import('express').Response, status: number, code: string, detail: string): void {
  res.status(status).json({ code, detail })
}

router.get('/content-store/covers/:packId/:version', async (req, res) => {
  const packId = firstParam(req.params.packId)
  const version = firstParam(req.params.version)
  if (!PACK_ID.test(packId) || !VERSION.test(version)) {
    fail(res, 400, 'CONTENT_STORE_COVER_INVALID', 'Invalid pack identity for a cover image.')
    return
  }

  let base: string
  let key: string
  try {
    base = (await getGenStudioUrl()).trim().replace(/\/+$/, '')
    key = (await getApiKey('genstudio')).trim()
  } catch {
    fail(res, 503, 'CONTENT_STORE_COVER_UNAVAILABLE', 'Story Studio could not read its Gateway address.')
    return
  }
  if (!base || !key) {
    fail(res, 503, 'CONTENT_STORE_COVER_UNAVAILABLE', 'Story Studio has no usable Gateway connection for pack covers.')
    return
  }

  let upstream: Response
  try {
    upstream = await fetch(`${base}${gatewayCoverPath(packId, version)}`, {
      method: 'GET',
      headers: { Accept: 'image/webp,image/png,image/jpeg', Authorization: `Bearer ${key}` },
      // The key is sent to the configured Gateway only; never follow it elsewhere.
      redirect: 'error',
      signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
    })
  } catch {
    fail(res, 502, 'CONTENT_STORE_COVER_UNAVAILABLE', 'The Gateway did not answer for this cover.')
    return
  }

  if (!upstream.ok) {
    // 404 is the ordinary answer for a pack with no cover yet.
    const status = upstream.status === 404 ? 404 : 502
    fail(res, status, 'CONTENT_STORE_COVER_UNAVAILABLE', status === 404
      ? 'This pack has no cover image on the Gateway.'
      : 'The Gateway could not serve this cover image.')
    return
  }

  const mime = (upstream.headers.get('content-type') || '').split(';')[0]!.trim()
  if (!COVER_MIME.test(mime)) {
    fail(res, 502, 'CONTENT_STORE_COVER_INVALID', 'The Gateway sent something that is not a cover image.')
    return
  }
  const declared = Number(upstream.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) {
    fail(res, 502, 'CONTENT_STORE_COVER_INVALID', 'This cover image is larger than Story Studio will read.')
    return
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(await upstream.arrayBuffer())
  } catch {
    fail(res, 502, 'CONTENT_STORE_COVER_UNAVAILABLE', 'The Gateway stopped partway through this cover image.')
    return
  }
  // The declared length can lie, so the real one is checked too.
  if (bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) {
    fail(res, 502, 'CONTENT_STORE_COVER_INVALID', 'This cover image is empty or larger than Story Studio will read.')
    return
  }

  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Length', String(bytes.byteLength))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // A cover can be replaced in place without a new pack version, so this is a
  // short shared cache rather than an immutable one.
  res.setHeader('Cache-Control', 'private, max-age=600')
  res.end(bytes)
})
