import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import {
  ContentStoreLocalError,
  ContentStoreUpstreamRefusal,
  confirmContentStorePurchase,
  createContentStoreQuote,
  loadContentStoreOverview,
} from '../services/content-store.js'
import {
  installOwnedContentStoreRelease,
  restoreContentStoreOwnership,
} from '../services/content-store-delivery.js'
import { GenStudioContentStoreApiError } from '../lib/genstudio-content-store.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

const MAX_BODY_BYTES = 16 * 1024
const OPAQUE_ID = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
const QuoteBodySchema = z.object({
  product_id: OPAQUE_ID,
  release_id: OPAQUE_ID.nullable().default(null),
}).strict()

export const router = Router()

router.use((req, res, next) => {
  const declared = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    res.status(413).json({ code: 'CONTENT_STORE_REQUEST_TOO_LARGE', detail: 'Content Store request body exceeds 16 KiB.' })
    return
  }
  if (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES) {
    res.status(413).json({ code: 'CONTENT_STORE_REQUEST_TOO_LARGE', detail: 'Content Store request body exceeds 16 KiB.' })
    return
  }
  next()
})

router.use(express.json({ limit: MAX_BODY_BYTES }))

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function quoteId(req: Request): string {
  return OPAQUE_ID.parse(firstParam(req.params.quoteId))
}

function emptyBody(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Request body must be empty' }])
  }
}

function upstreamFailure(res: Response, error: GenStudioContentStoreApiError, requiredScope: 'content:read' | 'content:purchase'): void {
  if (error.status === 401) {
    res.status(401).json({
      code: 'CONTENT_STORE_SCOPE_REQUIRED',
      detail: `The active GenStudio key was not accepted for required ${requiredScope} access.`,
    })
    return
  }
  const safeRefusals: Record<string, string> = {
    already_owned: 'This GenStudio account already owns this content.',
    archive_unavailable: 'The owned Content Pack archive is not available right now.',
    entitlement_revoked: 'GenStudio reports that this content entitlement is revoked.',
    insufficient_credits: 'This GenStudio account does not have enough content-spendable credits.',
    not_entitled: 'This GenStudio account does not own the requested Content Pack.',
    product_unavailable: 'This Content Store product is not available.',
    quote_rejected: 'GenStudio rejected the saved Content Store quote.',
    release_recalled: 'GenStudio stopped serving this exact Content Pack release. Ownership remains permanent.',
    release_unavailable: 'This Content Pack release is not available.',
    signing_unavailable: 'GenStudio cannot sign Content Store evidence right now.',
  }
  const safeDetail = error.code ? safeRefusals[error.code] : undefined
  if (!safeDetail) {
    res.status(502).json({
      code: 'CONTENT_STORE_UPSTREAM_REFUSED',
      detail: 'GenStudio refused this Content Store request without a recognized public reason.',
    })
    return
  }
  const credits = error.status === 402 ? {
    required_credits: error.refusal.required_credits,
    available_credits: error.refusal.available_credits,
    shortfall_credits: error.refusal.shortfall_credits,
  } : {}
  const recall = error.status === 410 && error.code === 'release_recalled' ? {
    recall_reason: typeof error.refusal.recall_reason === 'string' ? error.refusal.recall_reason : null,
    recalled_at: typeof error.refusal.recalled_at === 'string' ? error.refusal.recalled_at : null,
    terminal: true,
  } : {}
  res.status(error.status).json({ code: error.code, detail: safeDetail, ...credits, ...recall })
}

function localFailure(res: Response, error: ContentStoreLocalError): void {
  if (error.code === 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN') {
    res.status(502).json({ code: error.code, detail: error.message, status: 'uncertain' })
    return
  }
  if (error.code === 'CONTENT_PURCHASE_NOT_SENT') {
    res.status(502).json({ code: error.code, detail: error.message, status: 'quoted' })
    return
  }
  res.status(error.status).json({
    code: error.code,
    detail: error.message,
    ...(error.code === 'release_recalled' ? { terminal: true } : {}),
    ...(error.attempt ? { attempt: error.attempt } : {}),
  })
}

function handleFailure(
  res: Response,
  error: unknown,
  fallback: string,
  requiredScope: 'content:read' | 'content:purchase',
): void {
  if (error instanceof ContentStoreUpstreamRefusal) {
    res.status(error.status).json({ ...error.refusal, status: error.attempt.status })
    return
  }
  if (error instanceof GenStudioContentStoreApiError) {
    upstreamFailure(res, error, requiredScope)
    return
  }
  if (error instanceof ContentStoreLocalError) {
    localFailure(res, error)
    return
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ code: 'CONTENT_STORE_REQUEST_INVALID', detail: 'Content Store request fields are invalid.' })
    return
  }
  // The commerce journal and client carry paths and signed evidence internally.
  // Do not pass those raw failures into the shared logger/renderer boundary.
  res.status(500).json(humanizeBackendError(new Error(fallback), fallback))
}

router.get('/content-store', async (_req, res) => {
  try {
    res.json(await loadContentStoreOverview())
  } catch (error) {
    handleFailure(res, error, 'Failed to load the Content Store.', 'content:read')
  }
})

router.post('/content-store/restore', async (req, res) => {
  try {
    emptyBody(req.body)
    res.json(await restoreContentStoreOwnership())
  } catch (error) {
    handleFailure(res, error, 'Failed to restore Content Store ownership.', 'content:read')
  }
})

router.post('/content-store/releases/:releaseId/install', async (req, res) => {
  try {
    emptyBody(req.body)
    res.json(await installOwnedContentStoreRelease(OPAQUE_ID.parse(firstParam(req.params.releaseId))))
  } catch (error) {
    handleFailure(res, error, 'Failed to install the owned Content Pack.', 'content:read')
  }
})

router.post('/content-store/quotes', async (req, res) => {
  try {
    const input = QuoteBodySchema.parse(req.body)
    res.status(201).json(await createContentStoreQuote(input))
  } catch (error) {
    handleFailure(res, error, 'Failed to request a Content Store quote.', 'content:read')
  }
})

router.post('/content-store/quotes/:quoteId/purchase', async (req, res) => {
  try {
    emptyBody(req.body)
    res.json(await confirmContentStorePurchase(quoteId(req)))
  } catch (error) {
    handleFailure(res, error, 'Failed to confirm the Content Store purchase.', 'content:purchase')
  }
})

router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if ((error as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ code: 'CONTENT_STORE_REQUEST_TOO_LARGE', detail: 'Content Store request body exceeds 16 KiB.' })
    return
  }
  next(error)
})
