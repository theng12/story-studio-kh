/**
 * GenStudio-only image-edit boundary.
 *
 * GenStudio currently exposes qualified text-to-image generation, but it does
 * not yet expose an image-edit contract. Keep these legacy Story Studio routes
 * mounted so older clients receive a clear, deterministic response instead of
 * falling through to a direct cloud provider.
 */
import { Router } from 'express'

export const router = Router()

export const IMAGE_EDIT_UNAVAILABLE_DETAIL =
  'Image editing is temporarily unavailable. It will return after Gateway exposes and qualifies a secure image-edit API.'

function unavailablePayload() {
  return {
    available: false,
    detail: IMAGE_EDIT_UNAVAILABLE_DETAIL,
    models: [],
    default: null,
  }
}

router.get('/projects/:slug/image-edit/caps', (_req, res) => {
  res.status(503).json(unavailablePayload())
})

router.post('/projects/:slug/edit-image', (_req, res) => {
  res.status(503).json(unavailablePayload())
})
