import { Router } from 'express'

import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import type { VerifiedContentPack } from '../content-packs/archive.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getGenStudioUrl } from '../services/app-settings.js'
import { routeOptions } from './content-pack-route-support.js'

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
 *
 * The SAME router also lists a pack's preview pictures (`/previews/:packId/:version`)
 * because it is the same boundary: one place that decides which pack identity
 * Story will read media for, behind the one `/api` session gate, with the same
 * path-safety shapes below. A preview listing is a LOCAL read of an already
 * installed, already verified pack — see `listPackPreviews`.
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

export interface PackPreviewPicture {
  src: string
  alt: string
}

/**
 * Why there are no pictures — two different answers that must never collapse
 * into one (AGENTS.md §6).
 *
 * `not-installed` — the pack is not on this Mac (or is being removed), so its
 * previews cannot be read here at all. `unreadable` — it IS installed and Story
 * could not verify it, which is a fault worth reporting rather than a pack that
 * simply is not here.
 */
export type PackPreviewUnavailableReason = 'not-installed' | 'unreadable'

export interface PackPreviewListing {
  available: boolean
  reason: PackPreviewUnavailableReason | null
  pictures: PackPreviewPicture[]
}

/**
 * The three a visual style pack ships with, in archive order: the card image,
 * a quiet wide scene with no figure, and the hardest legal case (AGENTS.md §7).
 */
const THREE_PREVIEW_ROLES = ['Hero', 'Quiet wide scene', 'Hardest legal case']

/**
 * `preview_assets` is read off the document rather than off a list of kinds.
 *
 * The archive verifier already proved that every raster a document references
 * is declared and every declared raster is referenced
 * (`archive.ts` `referencedRasterPaths`), so on a VERIFIED document a present
 * `preview_assets` is exactly its previews. A kind list here would be a second
 * copy of that switch, free to drift from it.
 */
function previewPaths(document: ContentPackDocument): readonly string[] {
  const paths = (document as { preview_assets?: unknown }).preview_assets
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
}

function previewAlt(document: ContentPackDocument, position: number, total: number): string {
  const name = (document as { name?: unknown }).name
  const label = typeof name === 'string' && name.trim() ? name.trim() : document.id
  // The three roles are what those three ARE, so naming them beats "preview 2".
  // A pack that ships some other count has no documented roles, and a role
  // invented for it would be a claim about a picture nobody wrote down.
  if (total === THREE_PREVIEW_ROLES.length) return `${label} — ${THREE_PREVIEW_ROLES[position]}`
  return `${label} — preview ${position + 1} of ${total}`
}

/**
 * The previews of a pack Story has already verified, as same-origin URLs.
 *
 * The URLs point at the EXISTING `/api/content-packs/:packId/:version/assets/:assetId`
 * route, which re-verifies the pack closure and the file's own SHA-256 before it
 * serves a byte. Nothing here reads a filesystem path from the request: the only
 * client input is `packId` and `version`, validated by the shapes above, and the
 * file names come from the signed manifest.
 */
function listPackPreviews(packId: string, version: string, verified: VerifiedContentPack): PackPreviewListing {
  const files = new Map(verified.manifest.files.map(file => [file.path, file]))
  const pictures: PackPreviewPicture[] = []
  for (const document of [...verified.documents.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const paths = previewPaths(document)
    paths.forEach((relativePath, position) => {
      const file = files.get(relativePath)
      // A reference the verifier somehow did not resolve is skipped, never
      // guessed: a picture that is not this pack's is worse than one missing.
      if (!file || file.mime === 'application/json') return
      pictures.push({
        src: `/api/content-packs/${encodeURIComponent(packId)}/${encodeURIComponent(version)}/assets/${file.sha256}`,
        alt: previewAlt(document, position, paths.length),
      })
    })
  }
  return { available: true, reason: null, pictures }
}

/**
 * The three preview pictures of an installed pack, or an honest reason there
 * are none.
 *
 * For a pack that is NOT installed this is deliberately a LOCAL answer and
 * makes no Gateway call. The Gateway catalogue publishes only `cover` and
 * `hero: null` per product (`gateway-kh/repository/gateway/content_delivery.py`
 * `products()`), so a shelf pack's previews are not on the wire at all — there
 * is nothing to fetch, and fetching the whole archive to look inside it is not
 * a price worth paying for a picture wall. The page says
 * "Previews appear after installing" for that answer.
 */
router.get('/content-store/previews/:packId/:version', async (req, res) => {
  const packId = firstParam(req.params.packId)
  const version = firstParam(req.params.version)
  if (!PACK_ID.test(packId) || !VERSION.test(version)) {
    fail(res, 400, 'CONTENT_STORE_PREVIEW_INVALID', 'Invalid pack identity for preview pictures.')
    return
  }
  try {
    const options = routeOptions(req)
    const paths = options.paths ?? getContentPackRuntimePaths()
    const state = await readContentPackState(paths)
    const installed = state.packs[packId]?.versions[version]
    if (!installed || installed.pending_removal) {
      res.json({ available: false, reason: 'not-installed', pictures: [] } satisfies PackPreviewListing)
      return
    }
    const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
    const verified = await verifyInstalledContentPackClosure(state, packId, version, policy, options.appVersion)
    res.json(listPackPreviews(packId, version, verified))
  } catch {
    // Kept apart from `not-installed` on purpose (AGENTS.md §6): "not here" and
    // "here but unreadable" must not produce the same value.
    res.json({ available: false, reason: 'unreadable', pictures: [] } satisfies PackPreviewListing)
  }
})
