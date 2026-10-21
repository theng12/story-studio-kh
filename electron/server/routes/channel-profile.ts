/**
 * The channel's own identity — handle, About text, and the logo/banner art.
 *
 *   GET    /api/projects/:slug/channel-profile
 *   PUT    /api/projects/:slug/channel-profile              { name?, handle?, description? }
 *   POST   /api/projects/:slug/channel-profile/:kind        { filename?, data_base64 }
 *   GET    /api/projects/:slug/channel-profile/asset/:kind
 *   DELETE /api/projects/:slug/channel-profile/:kind
 *
 * Every profile route answers 200 with the SAME flat shape:
 *
 *   { name, handle, description, logo_url, banner_url }
 *
 * `name` is the channel's real name (project.json — the one the app has
 * always used); `handle` and `description` are the channel's own text;
 * `logo_url`/`banner_url` are null until art is uploaded.
 *
 * The art is stored per channel, content-addressed, and the bytes of a
 * replaced or removed image are KEPT on disk — only the reference moves.
 * The kinds are CLOSED: `logo` and `banner`.
 */

import { Router } from 'express'
import { z } from 'zod'

import { validateBody } from '../lib/validate.js'
import * as pm from '../services/project-manager.js'
import {
  ChannelProfileError,
  channelProfileView,
  clearChannelProfileAsset,
  isChannelProfileAssetKind,
  normalizeChannelDescription,
  normalizeChannelHandle,
  normalizeChannelName,
  readChannelProfileAsset,
  resolveChannelDir,
  storeChannelProfileImage,
  writeChannelProfile,
} from '../services/channel-profile.js'

export const router = Router()

/**
 * The channel this request is about, or null when the slug names no channel
 * inside the Library. A slug is one folder name; anything else is refused
 * before a byte is read or written.
 */
function channelSlugOf(req: any): string | null {
  const slug = String(req?.params?.slug ?? '')
  return resolveChannelDir(slug) ? slug : null
}

/**
 * The text a profile can be changed to. The URL fields are NOT writable here
 * — art changes only through the asset routes below.
 */
const ChannelProfileUpdateSchema = z.object({
  name: z.string().max(1000).optional(),
  handle: z.string().max(1000).optional(),
  description: z.string().max(100_000).optional(),
}).strict()

/** The image upload body. `filename` is accepted for the caller's own use. */
const ChannelProfileImageSchema = z.object({
  filename: z.string().max(400).optional(),
  data_base64: z.string().max(20_000_000).optional(),
}).strict()

function statusFor(error: any): number {
  return error instanceof ChannelProfileError ? error.status : 500
}

function detailFor(error: any, fallback: string): string {
  if (error instanceof ChannelProfileError) return error.message
  return error?.message || fallback
}

router.get('/projects/:slug/channel-profile', async (req, res) => {
  try {
    if (!channelSlugOf(req)) return res.status(404).json({ detail: 'Project not found' })
    res.json(await channelProfileView(req.params.slug))
  } catch (error: any) {
    res.status(statusFor(error)).json({ detail: detailFor(error, 'Could not read the channel profile.') })
  }
})

/**
 * Save the channel's text.
 *
 * Every field is validated BEFORE anything is written, so a bad handle can
 * never rename the channel and then fail.
 *
 * The name goes to project.json through `pm.updateProject` — the one
 * authoritative name. The handle and About text go to config.json. Two
 * files, so they cannot be one transaction: the name is written first, and
 * if the config write then fails the error says the name was saved and the
 * text was not.
 */
router.put('/projects/:slug/channel-profile', validateBody(ChannelProfileUpdateSchema), async (req, res) => {
  const slug = channelSlugOf(req)
  if (!slug) return res.status(404).json({ detail: 'Project not found' })
  const body = req.body || {}
  // Declared out here: the catch has to know whether the name went in, and a
  // flag declared inside the try would be out of scope by then.
  let nameSaved = false
  try {
    const name = body.name !== undefined ? normalizeChannelName(body.name) : undefined
    const handle = body.handle !== undefined ? normalizeChannelHandle(body.handle) : undefined
    const description = body.description !== undefined ? normalizeChannelDescription(body.description) : undefined

    if (name !== undefined) {
      const updated = await pm.updateProject(slug, { name })
      if (!updated) return res.status(404).json({ detail: 'Project not found' })
      nameSaved = true
    }
    if (handle !== undefined || description !== undefined) {
      await writeChannelProfile(slug, (current) => ({
        ...current,
        ...(handle !== undefined ? { handle } : {}),
        ...(description !== undefined ? { description } : {}),
      }))
    }
    res.json(await channelProfileView(slug))
  } catch (error: any) {
    const status = statusFor(error)
    // Only say the name was saved when it was. A refused handle fails before
    // anything is written, and claiming otherwise would be a lie.
    const detail = nameSaved
      ? 'The channel name was saved, but the rest of the profile was not. '
        + detailFor(error, 'The configuration could not be written.')
      : detailFor(error, 'Could not save the channel profile.')
    res.status(status).json({ detail })
  }
})

/**
 * Upload one piece of channel art. The bytes are validated by the decoder
 * (format, size, a full decode), then stored content-addressed inside the
 * channel's own `assets/profile` folder. The previous art is not deleted —
 * the reference moves and the old bytes stay on disk.
 */
router.post('/projects/:slug/channel-profile/:kind', validateBody(ChannelProfileImageSchema), async (req, res) => {
  const slug = channelSlugOf(req)
  if (!slug) return res.status(404).json({ detail: 'Project not found' })
  const kind = req.params.kind
  if (!isChannelProfileAssetKind(kind)) {
    return res.status(400).json({ detail: 'The kind must be "logo" or "banner".' })
  }
  try {
    const body = req.body || {}
    await storeChannelProfileImage(slug, kind, body.data_base64)
    res.json(await channelProfileView(slug))
  } catch (error: any) {
    res.status(statusFor(error)).json({ detail: detailFor(error, 'Could not store the image.') })
  }
})

/**
 * Serve one piece of channel art.
 *
 * The URL names the KIND, never a file: the file is found through the
 * channel's own stored reference, which is checked to be a regular file
 * inside the channel's real `assets/profile` folder.
 *
 * The `?v=` digest is a cache buster, not a content address the server
 * resolves — the reference is what is served. So the response revalidates
 * rather than claiming to be immutable, and carries an ETag of the bytes it
 * actually sent.
 */
router.get('/projects/:slug/channel-profile/asset/:kind', async (req, res) => {
  const slug = channelSlugOf(req)
  if (!slug) return res.status(404).json({ detail: 'Project not found' })
  const kind = req.params.kind
  if (!isChannelProfileAssetKind(kind)) {
    return res.status(400).json({ detail: 'The kind must be "logo" or "banner".' })
  }
  try {
    const asset = await readChannelProfileAsset(slug, kind)
    if (!asset) return res.status(404).json({ detail: `This channel has no ${kind} yet.` })
    const etag = `"${asset.etag}"`
    if (req.headers['if-none-match'] === etag) {
      res.set('ETag', etag)
      res.set('Cache-Control', 'private, no-cache, must-revalidate')
      return res.status(304).end()
    }
    res.set('Content-Type', asset.contentType)
    res.set('ETag', etag)
    res.set('Cache-Control', 'private, no-cache, must-revalidate')
    res.send(asset.bytes)
  } catch (error: any) {
    res.status(statusFor(error)).json({ detail: detailFor(error, 'Could not read the image.') })
  }
})

/**
 * Point the profile away from one piece of art. The file stays on disk.
 */
router.delete('/projects/:slug/channel-profile/:kind', async (req, res) => {
  const slug = channelSlugOf(req)
  if (!slug) return res.status(404).json({ detail: 'Project not found' })
  const kind = req.params.kind
  if (!isChannelProfileAssetKind(kind)) {
    return res.status(400).json({ detail: 'The kind must be "logo" or "banner".' })
  }
  try {
    await clearChannelProfileAsset(slug, kind)
    res.json(await channelProfileView(slug))
  } catch (error: any) {
    res.status(statusFor(error)).json({ detail: detailFor(error, 'Could not remove the image.') })
  }
})
