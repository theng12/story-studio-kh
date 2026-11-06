import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import {
  ContentStoreLocalError,
  loadContentStoreOverview,
} from '../services/content-store.js'
import {
  installOwnedContentStoreRelease,
  readContentStoreInstallOperation,
  restoreContentStoreOwnership,
  startOwnedContentStoreReleaseInstall,
} from '../services/content-store-delivery.js'
import {
  GenStudioContentStoreApiError,
  GenStudioContentStoreLimitError,
  GenStudioContentStoreResponseError,
} from '../lib/genstudio-content-store.js'
import { gatewayConnectionFailure, humanizeBackendError } from '../lib/humanize-backend-error.js'
import { redactSecrets } from '../lib/redact-secrets.js'
import { logLine } from '../services/logger.js'

const MAX_BODY_BYTES = 16 * 1024
const OPAQUE_ID = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)

/**
 * The Mac's Keychain (Electron safeStorage) protects the pack signing keys. When it is
 * unavailable EVERY install fails the same way, and the generic fallback hid that: say it.
 */
export function keychainFailure(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!/safeStorage/i.test(String((error as { message?: unknown })?.message ?? ''))) return null
  return { status: 503, body: {
    code: 'CONTENT_STORE_KEYCHAIN_UNAVAILABLE',
    detail: 'This Mac\'s Keychain is not available, so Content Packs cannot be saved safely.',
  } }
}

export interface ContentStoreRouterOptions {
  /** Test-only seam forwarded to Store delivery compatibility checks. */
  appVersion?: string
}

export function createContentStoreRouter(options: ContentStoreRouterOptions = {}): Router {
const router = Router()

// Scoped to `/content-store` on purpose. This router is mounted bare on `/api`
// alongside ~30 others, so a path-less `router.use` here runs for EVERY `/api`
// request that reaches this point in the mount order — every router registered
// after it in routes/index.ts (b-roll, research, scene plan, scene review,
// continuity, music pool, library, changelog, …) silently inherited this 16 KiB
// cap and answered oversized-but-legitimate payloads with a Content Store error
// that had nothing to do with them. Found 2026-09-08 when a 16.9 KiB
// `POST /api/projects/:slug/image-pool/generate` (13 preview prompts) was
// refused with CONTENT_STORE_REQUEST_TOO_LARGE.
router.use('/content-store', (req, res, next) => {
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

router.use('/content-store', express.json({ limit: MAX_BODY_BYTES }))

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function emptyBody(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Request body must be empty' }])
  }
}

type ContentStoreFailure = { status: number; body: Record<string, unknown> }

function upstreamFailure(error: GenStudioContentStoreApiError, requiredScope: 'content:read' | 'content:purchase'): ContentStoreFailure {
  if (error.status === 401) {
    return { status: 401, body: {
      code: 'CONTENT_STORE_SCOPE_REQUIRED', detail: `The active GenStudio key was not accepted for required ${requiredScope} access.`,
    } }
  }
  const safeRefusals: Record<string, string> = {
    already_owned: 'This content is already available to this GenStudio account.',
    archive_unavailable: 'The Content Pack archive is not available right now.',
    bundle_closure_missing: 'This Content Store bundle has no pinned component closure and cannot be purchased.',
    bundle_component_unavailable: 'A pinned component of this Content Store bundle is no longer available.',
    discount_misconfigured: 'GenStudio cannot safely quote this Content Store discount right now.',
    entitlement_revoked: 'GenStudio reports that this content entitlement is revoked.',
    not_entitled: 'This Content Pack is not available to this GenStudio account.',
    product_unavailable: 'This Content Store product is not available.',
    quote_rejected: 'GenStudio rejected the saved Content Store quote.',
    release_recalled: 'GenStudio stopped serving this exact Content Pack release.',
    release_unavailable: 'This Content Pack release is not available.',
    signing_unavailable: 'GenStudio cannot sign Content Store evidence right now.',
  }
  const safeDetail = error.code ? safeRefusals[error.code] : undefined
  if (!safeDetail) {
    return { status: 502, body: {
      code: 'CONTENT_STORE_UPSTREAM_REFUSED',
      detail: 'GenStudio refused this Content Store request without a recognized public reason.',
    } }
  }
  const recall = error.status === 410 && error.code === 'release_recalled' ? {
    recall_reason: typeof error.refusal.recall_reason === 'string' ? error.refusal.recall_reason : null,
    recalled_at: typeof error.refusal.recalled_at === 'string' ? error.refusal.recalled_at : null,
    terminal: true,
  } : {}
  return { status: error.status, body: { code: error.code, detail: safeDetail, ...recall } }
}

function localFailure(error: ContentStoreLocalError): ContentStoreFailure {
  if (error.code === 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN') {
    return { status: 502, body: { code: error.code, detail: error.message, status: 'uncertain' } }
  }
  if (error.code === 'CONTENT_PURCHASE_NOT_SENT') {
    return { status: 502, body: { code: error.code, detail: error.message, status: 'quoted' } }
  }
  return { status: error.status, body: {
    code: error.code,
    detail: error.message,
    ...(error.code === 'release_recalled' ? { terminal: true } : {}),
    ...(error.attempt ? { attempt: error.attempt } : {}),
  } }
}

function projectFailure(
  error: unknown,
  fallback: string,
  requiredScope: 'content:read' | 'content:purchase',
): ContentStoreFailure {
  const keychain = keychainFailure(error)
  if (keychain) return keychain
  if (error instanceof GenStudioContentStoreApiError) {
    return upstreamFailure(error, requiredScope)
  }
  if (error instanceof ContentStoreLocalError) {
    return localFailure(error)
  }
  if (error instanceof z.ZodError) {
    return { status: 400, body: { code: 'CONTENT_STORE_REQUEST_INVALID', detail: 'Content Store request fields are invalid.' } }
  }
  // A read that never reached the Gateway: say so, instead of the generic "Failed to load the
  // Content Store." A purchase whose outcome is uncertain never gets here (it is mapped earlier).
  const offline = gatewayConnectionFailure(error)
  if (offline) return { status: 503, body: { code: 'GATEWAY_UNREACHABLE', ...offline } }
  // A size refusal is the one unexpected failure whose cause is fully safe to
  // repeat: it names a limit and an endpoint, and nothing else. It used to fall
  // through to the generic fallback below, which is why the 2026-08-25 outage
  // presented as "Content Store is unavailable" with every count at zero and no
  // hint anywhere the user could see.
  if (error instanceof GenStudioContentStoreLimitError) {
    logLine('error', 'Content Store payload exceeded a Story Studio parsing limit', {
      fallback,
      raw: redactSecrets(error.message),
    })
    return { status: 502, body: { code: error.code, detail: error.message } }
  }
  // The Gateway ANSWERED, but not with a response this build can read. It used
  // to fall through to the generic 500, so a Gateway that published one field
  // this build refuses read to the customer as "the install failed" with no
  // reason at all. The validator's detail describes the RESPONSE (endpoint and
  // field path), never a local path or a secret, so it can be said out loud —
  // in the same words the Studio Library's per-section answer already uses.
  if (error instanceof GenStudioContentStoreResponseError) {
    logLine('error', 'GenStudio answered a Content Store request with an unreadable response', {
      fallback,
      raw: redactSecrets(error.message),
    })
    return { status: 502, body: {
      code: error.code,
      detail: `The Gateway answered, but not with a Studio Library response: ${error.message}`,
    } }
  }
  // The commerce journal and client carry paths and signed evidence internally,
  // so the RESPONSE stays the generic fallback -- none of that reaches the
  // renderer. The log is a different audience: it is local, redacted below, and
  // it is the only place the cause can be recovered from afterwards.
  //
  // Logging the synthetic fallback instead made every unexpected Content Store
  // failure indistinguishable -- a request timeout, an unreadable state file
  // and an outright bug all wrote the same "Failed to load the Content Store"
  // line with a stack pointing at this function. Diagnosing the install outage
  // that motivated this change meant guessing, because the evidence had been
  // thrown away at the moment it was produced.
  logLine('error', 'Content Store failure surfaced as a generic 500', {
    fallback,
    raw: redactSecrets(String((error as { message?: unknown })?.message ?? error ?? '')),
    name: String((error as { name?: unknown })?.name ?? ''),
    code: (error as { code?: unknown })?.code,
    stack: redactSecrets(String((error as { stack?: unknown })?.stack ?? '')),
  })
  return { status: 500, body: { ...humanizeBackendError(new Error(fallback), fallback) } }
}

function handleFailure(
  res: Response,
  error: unknown,
  fallback: string,
  requiredScope: 'content:read' | 'content:purchase',
): void {
  const projected = projectFailure(error, fallback, requiredScope)
  res.status(projected.status).json(projected.body)
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
    // `?overview=0`: the install queue asks for the install alone and refreshes
    // the overview once for the whole batch.
    const overview = firstParam(req.query.overview as string | string[] | undefined) !== '0'
    if (firstParam(req.query.async as string | string[] | undefined) === '1') {
      res.status(202).json({ operation: startOwnedContentStoreReleaseInstall(
        OPAQUE_ID.parse(firstParam(req.params.releaseId)), options,
        { presentFailure: error => {
          const failure = projectFailure(error, 'Failed to install the owned Content Pack.', 'content:read').body
          return {
            // A failure this app could not classify was NOT a refusal. Labelling
            // it CONTENT_STORE_UPSTREAM_REFUSED told the customer GenStudio had
            // said no when nothing was ever refused (2026-10-30), and it hid the
            // difference between "the Gateway said no" and "this build broke".
            code: typeof failure.code === 'string' ? failure.code : 'CONTENT_STORE_INSTALL_FAILED',
            detail: typeof failure.detail === 'string' ? failure.detail : 'This Content Pack could not be installed.',
          }
        } },
      ) })
      return
    }
    res.json(await installOwnedContentStoreRelease(OPAQUE_ID.parse(firstParam(req.params.releaseId)), options, { overview }))
  } catch (error) {
    handleFailure(res, error, 'Failed to install the owned Content Pack.', 'content:read')
  }
})

router.get('/content-store/installs/:operationId', (req, res) => {
  try {
    const operation = readContentStoreInstallOperation(OPAQUE_ID.parse(firstParam(req.params.operationId)))
    if (!operation) {
      res.status(404).json({ code: 'CONTENT_STORE_INSTALL_NOT_FOUND', detail: 'This Content Store install is no longer available to monitor.' })
      return
    }
    res.json({ operation })
  } catch (error) {
    handleFailure(res, error, 'Failed to read Content Store install progress.', 'content:read')
  }
})

router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if ((error as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ code: 'CONTENT_STORE_REQUEST_TOO_LARGE', detail: 'Content Store request body exceeds 16 KiB.' })
    return
  }
  next(error)
})

return router
}

export const router = createContentStoreRouter()
