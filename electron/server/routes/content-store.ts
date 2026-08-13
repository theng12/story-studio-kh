import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import {
  ContentStoreLocalError,
  ContentStoreUpstreamRefusal,
  confirmContentStorePurchase,
  createContentStoreQuote,
  loadContentStoreOverview,
} from '../services/content-store.js'
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

function upstreamFailure(res: Response, error: GenStudioContentStoreApiError): void {
  res.status(error.status).json({
    ...(error.code ? { code: error.code } : {}),
    detail: error.detail,
    ...error.refusal,
  })
}

function localFailure(res: Response, error: ContentStoreLocalError): void {
  if (error.code === 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN') {
    res.status(502).json({ code: error.code, detail: error.message, status: 'uncertain' })
    return
  }
  res.status(error.status).json({ code: error.code, detail: error.message, ...(error.attempt ? { attempt: error.attempt } : {}) })
}

function handleFailure(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ContentStoreUpstreamRefusal) {
    res.status(error.status).json({ ...error.refusal, status: error.attempt.status })
    return
  }
  if (error instanceof GenStudioContentStoreApiError) {
    upstreamFailure(res, error)
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
    handleFailure(res, error, 'Failed to load the Content Store.')
  }
})

router.post('/content-store/quotes', async (req, res) => {
  try {
    const input = QuoteBodySchema.parse(req.body)
    res.status(201).json(await createContentStoreQuote(input))
  } catch (error) {
    handleFailure(res, error, 'Failed to request a Content Store quote.')
  }
})

router.post('/content-store/quotes/:quoteId/purchase', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      throw new z.ZodError([{ code: 'custom', path: [], message: 'Purchase body must be empty' }])
    }
    res.json(await confirmContentStorePurchase(quoteId(req)))
  } catch (error) {
    handleFailure(res, error, 'Failed to confirm the Content Store purchase.')
  }
})

router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if ((error as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ code: 'CONTENT_STORE_REQUEST_TOO_LARGE', detail: 'Content Store request body exceeds 16 KiB.' })
    return
  }
  next(error)
})
