import { Router } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import pathMod from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as im from '../services/idea-manager.js'
import { hasAnyTextProviderKey } from '../lib/ai-client.js'
import { resolveEpisodePaths, resolveEpisodePathsForRead, resolveEpisodePathsByCode, resolveEpisodeTitleByCode } from '../services/utils.js'
import { episodeIsIntroEligible } from '../lib/episode-creation-facts.js'
import { resolveReadPath, resolveArtifact, matchChapterFile } from '../lib/episode-artifacts.js'
import { hasIntroductionScriptSource } from '../lib/narration-assembly.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { parseMetadataTxt } from '../services/metadata-format.js'
import { validateBody } from '../lib/validate.js'
import { GenerateScriptOnlySchema, GenerateIntroductionOnlySchema, GenerateChapterOnlySchema, TranslateEpisodeSchema } from '../schemas/index.js'
import { metadataFormulaCatalogue } from '../services/metadata-formula-catalogue.js'
import { stripInternalSectionLabels } from '../lib/metadata-label-leak.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { humanizeBackendError, respondWithError } from '../lib/humanize-backend-error.js'
import { inspectYouTubeFinalizationStatus } from '../services/youtube-metadata-finalizer.js'
import { safetyMode } from '../services/safety-checks.js'
import { noThumbnailModelMessage, resolveThumbnailModel } from '../services/thumbnail-presets.js'
import { getDefaultModels } from '../services/app-settings.js'
import {
  freshActionMatch,
  readOperationId,
  readManualGenerationRedoIntent,
  readOptionalOperationId,
  stampFreshGenerationAction,
} from '../lib/fresh-generation-action.js'
import { inspectChunkedScriptCompletion } from '../lib/chunked-narration.js'
import { resolveLiveImagePromptCharCap } from '../services/image-prompt-cap.js'
import type { Job } from '../models/types.js'
import { writeMetadataPackage } from '../services/metadata-completion.js'

export const router = Router()

type ScriptDocumentItem = 'outline' | 'introduction' | `chapter:${number}`

function isScriptDocumentItem(value: unknown): value is ScriptDocumentItem {
  return value === 'outline' || value === 'introduction'
    || (typeof value === 'string' && /^chapter:[1-9]\d*$/.test(value))
}

function scriptEvidenceKey(entry: any): string | null {
  const top = typeof entry?.request_key === 'string' ? entry.request_key.trim() : ''
  const preview = typeof entry?.request?.idempotency_key === 'string' ? entry.request.idempotency_key.trim() : ''
  if (top && preview && top !== preview) return null
  return top || preview || null
}

function scriptEvidenceResolved(entry: any): boolean {
  const id = typeof entry?.id === 'string' ? entry.id : ''
  return !!id && !id.startsWith('pending:') && (entry?.state === 'succeeded' || entry?.state === 'failed')
}

function inspectScriptDocumentSource(source: Readonly<Job>, episodeId: string, item: ScriptDocumentItem) {
  const expectedType = item === 'outline' ? 'outline_only'
    : item === 'introduction' ? 'introduction-only' : 'chapter-only'
  if (source.type !== expectedType || source.episode_id !== episodeId) return null
  const receipts = source.params?.script_document_requests
  if (receipts?.version !== 1 || !Array.isArray(receipts.requests)) return null
  const owners = new Map<string, string>()
  const itemKeys: string[] = []
  for (const value of receipts.requests) {
    const key = typeof value?.request_key === 'string' ? value.request_key.trim() : ''
    const ownerItem = typeof value?.item === 'string' ? value.item : ''
    const ownerEpisode = typeof value?.episode_id === 'string' ? value.episode_id : ''
    if (!key || !ownerItem || ownerEpisode !== episodeId) return null
    const owner = `${ownerEpisode}:${ownerItem}`
    if (owners.has(key) && owners.get(key) !== owner) return null
    owners.set(key, owner)
    if (ownerItem === item && !itemKeys.includes(key)) itemKeys.push(key)
  }
  if (!itemKeys.length) return null
  const chats = (source.genstudio_jobs || []).filter(entry => entry.operation === 'chat.response')
  const taskOwners = new Map<string, string>()
  for (const entry of chats) {
    const key = scriptEvidenceKey(entry)
    if (!key) return null
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id && !id.startsWith('pending:')) {
      if (taskOwners.has(id) && taskOwners.get(id) !== key) return null
      taskOwners.set(id, key)
    }
  }
  const unresolved = chats.filter(entry => {
    const key = scriptEvidenceKey(entry)
    return !!key && itemKeys.includes(key) && !scriptEvidenceResolved(entry)
  })
  if (unresolved.length !== 1) return null
  const requestKey = scriptEvidenceKey(unresolved[0])!
  if (chats.some(entry => entry !== unresolved[0]
    && scriptEvidenceKey(entry) === requestKey && !scriptEvidenceResolved(entry))) return null
  return {
    requestKey,
    requestFingerprint: createHash('sha256').update(requestKey).digest('hex'),
    sourceType: expectedType as 'outline_only' | 'introduction-only' | 'chapter-only',
  }
}

async function findScriptDocumentSource(slug: string, sourceJobId: string): Promise<Job | undefined> {
  return (await jq.findJobs(slug, job => job.job_id === sourceJobId))[0]
}

function cleanScriptClientBody(body: Record<string, any>): Record<string, any> {
  const clean = structuredClone(body)
  delete clean.generation_action
  delete clean.generation_action_fingerprint
  delete clean.script_document_requests
  delete clean.script_document_write
  delete clean.resolved_introduction
  return clean
}

function cleanManualScriptClientBody(body: Record<string, any>): Record<string, any> {
  const clean = cleanScriptClientBody(body)
  delete clean.operation_id
  return clean
}

async function replayAcceptedScriptManualAction(
  slug: string,
  body: Record<string, any>,
  type: 'outline_only' | 'introduction-only' | 'chapter-only',
  episodeId: string,
  item: ScriptDocumentItem,
) {
  const intent = readManualGenerationRedoIntent(body)
  if (!intent) return { intent: null, operationId: null, previous: undefined as Job | undefined, conflict: false }
  const operationId = readOperationId(body, true)!
  const client = stampFreshGenerationAction(cleanManualScriptClientBody(body), operationId)
  const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
  if (!previous) return { intent, operationId, previous, conflict: false, clientFingerprint: client.generation_action_fingerprint }
  const manual = previous.params?.manual_redo
  const conflict = previous.type !== type || previous.episode_id !== episodeId
    || manual?.source_job_id !== intent.source_job_id || manual?.source_item_key !== item
    || manual?.client_request_fingerprint !== client.generation_action_fingerprint
  return { intent, operationId, previous, conflict, clientFingerprint: client.generation_action_fingerprint }
}

async function scriptDocumentRevision(file: string): Promise<'missing' | `sha256:${string}`> {
  try {
    const bytes = await fs.readFile(file)
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function manualScriptParams(input: {
  slug: string
  body: Record<string, any>
  episodeId: string
  item: ScriptDocumentItem
  targetFile: string
  operationId: string
  clientFingerprint: string
  extraParams?: Record<string, any>
}) {
  const intent = readManualGenerationRedoIntent(input.body)!
  const source = await findScriptDocumentSource(input.slug, intent.source_job_id)
  const proof = source && inspectScriptDocumentSource(source, input.episodeId, input.item)
  if (!source || !proof || (source.status !== 'error' && source.status !== 'cancelled')) {
    throw Object.assign(new Error('The stopped source does not prove one unresolved original request for this script item.'), { status: 409 })
  }
  const expectedRevision = await scriptDocumentRevision(input.targetFile)
  const clean = cleanManualScriptClientBody(input.body)
  const params = stampFreshGenerationAction({
    ...clean,
    ...(input.extraParams || {}),
    manual_redo: {
      version: 1,
      intent: 'replace_unresolved',
      source_job_id: source.job_id,
      source_item_key: input.item,
      source_request_fingerprint: proof.requestFingerprint,
      client_request_fingerprint: input.clientFingerprint,
      requested_at: new Date().toISOString(),
    },
    script_document_write: {
      version: 1,
      item: input.item,
      expected_revision: expectedRevision,
      owner_action_id: input.operationId,
    },
  }, input.operationId)
  const criteria: jq.ManualGenerationRedoSourceCriteria = {
    sourceJobId: source.job_id,
    sourceType: proof.sourceType,
    operation: 'chat.response',
    resource: {
      kind: 'custom',
      identity: `${input.episodeId}:${input.item}:${proof.requestFingerprint}`,
      matches: candidate => !!inspectScriptDocumentSource(candidate, input.episodeId, input.item)
        && inspectScriptDocumentSource(candidate, input.episodeId, input.item)?.requestFingerprint === proof.requestFingerprint,
    },
    sourceLabel: `${input.item} script request`,
    evidenceLabel: 'Gateway chat request',
    hasCurrentEvidence: candidate => inspectScriptDocumentSource(candidate, input.episodeId, input.item)?.requestFingerprint === proof.requestFingerprint,
  }
  return { params, criteria }
}

async function prepareExplicitScriptAction(
  slug: string,
  body: Record<string, any>,
  mode: 'required' | 'optional',
): Promise<{ params: Record<string, any>; previous?: any; conflict: boolean }> {
  const clean = cleanScriptClientBody(body)
  const operationId = mode === 'required'
    ? readOperationId(clean, true)
    : readOptionalOperationId(clean)
  if (!operationId) {
    const params = { ...clean }
    delete params.operation_id
    delete params.generation_action
    return { params, conflict: false }
  }
  const params = stampFreshGenerationAction(clean, operationId)
  const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
  return {
    params,
    previous,
    conflict: !!previous && previous.params.generation_action_fingerprint !== params.generation_action_fingerprint,
  }
}

async function withExplicitActionReplay(
  slug: string,
  params: Record<string, any>,
  res: any,
  conflictDetail: string,
  enqueue: () => Promise<any>,
): Promise<any> {
  const operationId = params.generation_action?.id
  if (!operationId) return enqueue()
  return withLock(`fresh-script:${slug}:${operationId}`, async () => {
    const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
    if (previous) {
      if (previous.params.generation_action_fingerprint !== params.generation_action_fingerprint) {
        return res.status(409).json({ detail: conflictDetail })
      }
      return res.status(200).json({ ...previous, reused: true })
    }
    return enqueue()
  })
}

// Legacy `POST /generate/script` and `/generate/script-only` are gone. Scripts
// are written outline-first (`/generate/outline-only` + `/generate/expand-chapters`).

router.get('/projects/:slug/scripts/manual-redo-sources', async (req, res) => {
  const { slug } = req.params
  const episodeId = typeof req.query.episode_id === 'string' ? req.query.episode_id.trim() : ''
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required.' })
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const jobs = await jq.findJobs(slug, job => job.episode_id === episodeId
    && (job.status === 'error' || job.status === 'cancelled')
    && ['outline_only', 'introduction-only', 'chapter-only'].includes(job.type))
  const sources: Array<Record<string, unknown>> = []
  for (const job of jobs) {
    const items = [...new Set<ScriptDocumentItem>((job.params?.script_document_requests?.requests || [])
      .filter((entry: any) => entry?.episode_id === episodeId)
      .map((entry: any) => entry?.item)
      .filter(isScriptDocumentItem))]
    for (const item of items) {
      if (!inspectScriptDocumentSource(job, episodeId, item)) continue
      sources.push({
        source_job_id: job.job_id,
        item_key: item,
        job_type: job.type,
        label: item === 'outline' ? 'Stopped outline attempt'
          : item === 'introduction' ? 'Stopped introduction attempt'
            : `Stopped Chapter ${item.slice('chapter:'.length)} attempt`,
        finished_at: job.finished_at || null,
      })
    }
  }
  res.json({ sources })
})

// ── Outline-first chunked flow (v1.0.72+) ────────────────────────────────
//
// Step 1: POST /generate/outline-only — builds the outline, persists a
// sidecar with outline_approved_at: null. Frontend renders OutlineReviewPanel.
//
// Step 2: GET / PUT  /episodes/:id/outline — read & edit the outline.
// PUT with `approved: true` flips outline_approved_at, unlocking expansion.
//
// Step 3: POST /generate/expand-chapters — runs the multi-batch expansion
// via expandChapters(). Optional `chapters: number[]` filter expands a
// subset; absent = expand all pending. Refuses unless outline is approved.
//
router.post('/projects/:slug/generate/outline-only', validateBody(GenerateScriptOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  let manualReplay
  try {
    manualReplay = await replayAcceptedScriptManualAction(
      slug, req.body, 'outline_only', req.body.episode_id, 'outline',
    )
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual redo request.' })
  }
  if (manualReplay.conflict) {
    return res.status(409).json({ detail: 'This operation_id already belongs to a different outline or source request.' })
  }
  if (manualReplay.previous) return res.status(200).json({ ...manualReplay.previous, reused: true })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No Gateway API Key configured. Add it in Settings → This Mac.' })
  }

  if (manualReplay.intent) {
    try {
      const paths = await resolveEpisodePaths(slug, req.body.episode_id, req.body.title || '')
      const { sidecarPath } = await import('../lib/chunked-narration.js')
      const manual = await manualScriptParams({
        slug,
        body: req.body,
        episodeId: req.body.episode_id,
        item: 'outline',
        targetFile: sidecarPath(paths.script_dir, req.body.episode_id),
        operationId: manualReplay.operationId!,
        clientFingerprint: manualReplay.clientFingerprint!,
        extraParams: { force: true },
      })
      const job = await jq.enqueueManualGenerationRedo({
        project_slug: slug,
        type: 'outline_only',
        episode_id: req.body.episode_id,
        title: req.body.title,
        params: manual.params,
      }, manual.criteria)
      return res.status(201).json(job)
    } catch (error: any) {
      return res.status(error?.status || error?.statusCode || 409).json({
        detail: error?.message || 'Manual outline redo was refused.',
      })
    }
  }

  let action
  try {
    action = await prepareExplicitScriptAction(slug, req.body, req.body.force === true ? 'required' : 'optional')
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  if (action.conflict) return res.status(409).json({ detail: 'This operation_id already belongs to a different outline request.' })
  if (action.previous) return res.status(200).json({ ...action.previous, reused: true })

  return withExplicitActionReplay(slug, action.params, res, 'This operation_id already belongs to a different outline request.', async () => {
    if (jq.isDuplicate(slug, req.body.episode_id, 'outline_only')) {
      return res.status(409).json({ detail: `Outline build already queued/running for ${req.body.episode_id}` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'outline_only',
      episode_id: req.body.episode_id,
      title: req.body.title,
      params: action.params,
    })
    return res.status(201).json(job)
  })
})

router.post('/projects/:slug/generate/expand-chapters', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No Gateway API Key configured. Add it in Settings → This Mac.' })
  }

  const { episode_id, title } = req.body || {}
  if (typeof episode_id !== 'string' || !episode_id) {
    return res.status(400).json({ detail: 'episode_id is required' })
  }

  // Pre-flight: confirm a sidecar exists AND is approved (or auto_approve).
  // Without this check the executor would also throw, but surfacing the
  // condition early gives the frontend a clean 400 to react on (vs a
  // job-error toast after the fact).
  //
  // Probe via readSidecar (full sidecar) instead of a chapter-1 lookup —
  // a hand-edited outline could legitimately drop n=1 (e.g. user reorders
  // and then approves), and the prior chapter-1-only probe would 400 even
  // though the outline is well-formed. readSidecar also gives us
  // total_chapters for the chapters[] range check below.
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { readSidecar } = await import('../lib/chunked-narration.js')
  const paths = await resolveEpisodePaths(slug, episode_id, title || '')
  const sidecar = await readSidecar(paths.script_dir, episode_id)
  if (!sidecar && !req.body.auto_approve) {
    return res.status(400).json({
      detail: 'No outline found. Click Generate Outline first, then approve before expanding.',
    })
  }

  // Validate the optional filter list (`chapters_to_expand`) when present.
  // The OutlineReviewPanel sends an integer array of chapter numbers to
  // partially expand; the executor at episode.ts:1211 reads exactly that
  // field. Earlier versions of this route validated `chapters` (the
  // chapter-COUNT field from the script-form payload, an integer) as if
  // it were the filter array, which always 400'd when the frontend was
  // working as designed — fixed in v1.0.85 by matching the executor's
  // contract.
  //
  // Accept an array of integers in 1..total_chapters, deduped. Reject
  // non-arrays, NaN, out-of-range, and non-integer entries — the
  // executor would silently skip these which is confusing UX (user
  // gets a 201 + no work done). Empty array is allowed (means "expand
  // all pending"); we normalise it to `undefined` so the executor
  // takes the no-filter path.
  if (req.body.chapters_to_expand !== undefined) {
    if (!Array.isArray(req.body.chapters_to_expand)) {
      return res.status(400).json({ detail: '`chapters_to_expand` must be an array of chapter numbers.' })
    }
    if (sidecar) {
      const total = sidecar.total_chapters
      const seen = new Set<number>()
      const cleaned: number[] = []
      for (const raw of req.body.chapters_to_expand) {
        const n = Number(raw)
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > total) {
          return res.status(400).json({
            detail: `Invalid chapter number in \`chapters_to_expand\`: ${raw} (must be an integer 1..${total}).`,
          })
        }
        if (seen.has(n)) continue
        seen.add(n); cleaned.push(n)
      }
      // Replace the request body so the executor sees the cleaned set.
      // Empty after de-dup → drop the field entirely (= expand all pending).
      if (cleaned.length === 0) delete req.body.chapters_to_expand
      else req.body.chapters_to_expand = cleaned
    }
  }

  // 1.4.359 — the channel's "Chapters per request" setting rides this request
  // so an expand run honours the number set NOW (see resolveExpansionBatchSetting
  // in generators/episode.ts). Reject nonsense here rather than letting the
  // executor silently fall back to the format default: a 0 or a typo'd 400 is a
  // caller bug, not a preference.
  if (req.body.chapters_per_request !== undefined) {
    const n = Number(req.body.chapters_per_request)
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return res.status(400).json({
        detail: '`chapters_per_request` must be an integer 0..10 (0 = this format\'s default).',
      })
    }
  }
  if (req.body.chapter_batch_mode !== undefined
    && req.body.chapter_batch_mode !== 'count' && req.body.chapter_batch_mode !== 'length') {
    return res.status(400).json({ detail: '`chapter_batch_mode` must be "count" or "length".' })
  }
  if (req.body.chapter_batch_words !== undefined) {
    const n = Number(req.body.chapter_batch_words)
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      return res.status(400).json({ detail: '`chapter_batch_words` must be an integer 0..100000 words.' })
    }
  }

  // v1.0.786 — the queue job carries the model expansion will ACTUALLY use,
  // which is the caller's current selection. This used to overwrite the body's
  // model with the outline snapshot's, so a stale recorded id reached the
  // executor even when a valid model was selected in the form, and the run
  // dead-ended on "not available — choose a published product". The snapshot
  // is still the fallback for a caller that names no model at all; the
  // executor logs the substitution either way. `job.params.model` stays a real
  // id so the queue's retry-eligibility check keeps working without extra I/O.
  let manualRedoIntent
  try {
    manualRedoIntent = readManualGenerationRedoIntent(req.body)
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual_redo.' })
  }
  if (manualRedoIntent && req.body?.terminal_retry_job_id !== undefined) {
    return res.status(400).json({ detail: 'manual_redo and terminal_retry_job_id cannot be used together.' })
  }

  const selectedModel = typeof req.body?.model === 'string' && req.body.model.trim()
    ? req.body.model.trim()
    : undefined
  const expansionModel = selectedModel || sidecar?.generation_params?.model
  const { terminal_retry_job_id: terminalRetryJobId, ...expansionRequest } = req.body
  delete expansionRequest.manual_redo
  if (manualRedoIntent && !expansionModel) {
    return res.status(400).json({ detail: 'Select a published writing model before starting a separate attempt.' })
  }
  let priorManualAction: Job | undefined
  if (manualRedoIntent) {
    try {
      const operationId = readOperationId(req.body, true)!
      priorManualAction = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
    }
  }
  const priorManualRedo = priorManualAction?.params?.manual_redo
  const replaysPriorManualRedo = priorManualRedo?.version === 1
    && priorManualRedo?.intent === 'replace_unresolved'
    && priorManualRedo?.source_job_id === manualRedoIntent?.source_job_id
    && Array.isArray(priorManualRedo?.target_chapters)
  const missingChapters = manualRedoIntent && !priorManualAction
    ? (await inspectChunkedScriptCompletion(paths.script_dir, episode_id)).missing
    : []
  if (manualRedoIntent && !priorManualAction && missingChapters.length === 0) {
    return res.status(409).json({ detail: `All chapters for ${episode_id} are already on disk.` })
  }
  const manualRedo = replaysPriorManualRedo ? priorManualRedo : manualRedoIntent ? {
    version: 1 as const,
    intent: manualRedoIntent.intent,
    source_job_id: manualRedoIntent.source_job_id,
    requested_at: new Date().toISOString(),
    target_chapters: missingChapters,
    selected_model_id: expansionModel!,
  } : undefined
  const validatedParams = {
    ...expansionRequest,
    ...(expansionModel ? { model: expansionModel } : {}),
    ...(manualRedo ? { manual_redo: manualRedo } : {}),
  }
  const actionRequest = {
    ...validatedParams,
    ...(terminalRetryJobId ? { terminal_retry_job_id: terminalRetryJobId } : {}),
  }

  let action
  try {
    action = await prepareExplicitScriptAction(slug, actionRequest, manualRedo ? 'required' : 'optional')
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  if (action.conflict) return res.status(409).json({ detail: 'This operation_id already belongs to a different chapter expansion.' })
  if (action.previous) return res.status(200).json({ ...action.previous, reused: true })

  return withExplicitActionReplay(slug, action.params, res, 'This operation_id already belongs to a different chapter expansion.', async () => {
    // Keep the paid-work boundary ahead of both normal enqueue and a terminal
    // replacement. enqueue() also defends this invariant atomically, but this
    // route must not begin terminal-retry handling while another expansion owns
    // the episode.
    if (jq.isDuplicate(slug, episode_id, 'expand_chapters') || jq.isDuplicate(slug, episode_id, 'chapter-only')) {
      return res.status(409).json({ detail: `Chapter expansion already queued/running for ${episode_id}` })
    }

    // Full Script-page Resume sends a terminal source reference alongside its
    // current form fields. The queue chooses exact replay while any chat batch
    // is unresolved, and can mint a replacement scope only after all settle.
    // The body itself is never trusted to supply a provider identity.
    if (terminalRetryJobId !== undefined) {
      if (typeof terminalRetryJobId !== 'string' || !terminalRetryJobId) {
        return res.status(400).json({ detail: 'terminal_retry_job_id must be a job ID.' })
      }
      const retryParams = { ...action.params }
      delete retryParams.terminal_retry_job_id
      const job = jq.retryTerminalChapterExpansion(
        slug,
        terminalRetryJobId,
        episode_id,
        retryParams,
      )
      return res.status(201).json(job)
    }

    if (manualRedo) {
      try {
        const job = await jq.enqueue({
          project_slug: slug,
          type: 'expand_chapters',
          episode_id,
          title: title || '',
          params: action.params,
        }, {}, async () => {
          await jq.prepareUnresolvedChapterExpansionRedo(slug, episode_id, manualRedo.source_job_id)
        })
        return res.status(201).json(job)
      } catch (error: any) {
        return res.status(error?.status || error?.statusCode || 409).json({ detail: error?.message || 'Manual redo was refused.' })
      }
    }

    if (jq.hasUnresolvedTerminalChapterExpansion(slug, episode_id)) {
      return res.status(409).json({
        detail: `Writing chapters for ${episode_id} stopped part-way and may still be finishing at the Gateway. `
          + 'Click "Resume writing" at the bottom of the Outline tab to finish that run first, then expand other chapters.',
      })
    }

    try {
      const job = await jq.enqueue({
        project_slug: slug,
        type: 'expand_chapters',
        episode_id,
        title: title || '',
        params: action.params,
      })
      return res.status(201).json(job)
    } catch (error: any) {
      if (error?.status === 409 || error?.statusCode === 409) {
        return res.status(409).json({ detail: error.message })
      }
      throw error
    }
  })
})

router.get('/projects/:slug/episodes/:episodeId/outline', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const titleParam = (req.query.title as string) || ''
    const paths = await resolveEpisodePathsForRead(slug, episodeId, titleParam)
    const { sidecarPath, readSidecar } = await import('../lib/chunked-narration.js')
    const sidecarFile = sidecarPath(paths.script_dir, episodeId)
    if (!existsSync(sidecarFile)) {
      return res.status(404).json({ detail: 'No outline sidecar for this episode (run outline-only first).' })
    }
    // readSidecar handles v1/v2 → v3 migration in-memory and is the single
    // source of truth for sidecar field semantics. Reading it directly here
    // (instead of re-implementing the migration with `??` fallbacks) avoids
    // the bug where `outline_approved_at: null` (an EXPLICIT draft state on
    // v3 sidecars) was being clobbered by `?? sidecar.outline_completed_at`,
    // which made the frontend think a draft outline was approved — hiding
    // the "✓ Mark approved" button while expand-chapters still rejected
    // with "Outline not approved yet", a dead-end state for the user.
    const sidecar = await readSidecar(paths.script_dir, episodeId)
    if (!sidecar) {
      return res.status(404).json({ detail: 'No outline sidecar for this episode (run outline-only first).' })
    }
    res.json({
      mode: sidecar.mode,
      total_chapters: sidecar.total_chapters,
      outline: sidecar.outline,
      outline_completed_at: sidecar.outline_completed_at,
      outline_approved_at: sidecar.outline_approved_at,
      outline_edited_at: sidecar.outline_edited_at,
      chapters_done: sidecar.chapters_done || [],
      // v3+: snapshot of the form fields used to build the outline. Frontend
      // shows this in OutlineReviewPanel as "Locked at outline build" so
      // the user understands which model + words + pattern + cast the
      // upcoming expand will run against. null on v1/v2 sidecars.
      generation_params: sidecar.generation_params,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not load outline'))
  }
})

router.put('/projects/:slug/episodes/:episodeId/outline', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const titleParam = (req.query.title as string) || ''
    const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
    const { sidecarPath } = await import('../lib/chunked-narration.js')
    const sidecarFile = sidecarPath(paths.script_dir, episodeId)
    if (!existsSync(sidecarFile)) {
      return res.status(404).json({ detail: 'No outline to edit (run outline-only first).' })
    }

    const incoming = req.body?.outline
    const wantApproved = req.body?.approved === true
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ detail: 'Body must include `outline: OutlineEntry[]`.' })
    }

    return withLock(sidecarFile, async () => {
      // Read existing sidecar while holding the same lock as generated promotion.
      const raw = await fs.readFile(sidecarFile, 'utf-8')
      const existing = JSON.parse(raw)
      const totalChapters = existing.total_chapters

    // The outline was rebuilt (or imported) after the page loaded it: these
    // edits belong to the old one and must not overwrite — or approve — the
    // new outline. Optional so older clients keep working.
    const basedOn = req.body?.outline_completed_at
    if (typeof basedOn === 'string' && typeof existing.outline_completed_at === 'string'
        && basedOn !== existing.outline_completed_at) {
      return res.status(409).json({
        detail: `The outline for ${episodeId} was rebuilt after these edits were made, so they were not saved. `
          + 'The new outline is shown now.',
      })
    }

    // Length must match total_chapters: the rest of the chunked machinery
    // (expandChapters' pending-set computation, the OutlineReviewPanel's row
    // ↔ chapter-on-disk pairing, chapters_done invariants) all assume
    // outline.length === total_chapters. A truncated edit would silently
    // strand later chapters.
    if (incoming.length !== totalChapters) {
      return res.status(400).json({
        detail: `Outline must have exactly ${totalChapters} entries (got ${incoming.length}).`,
      })
    }

    // Validate: every entry has a numeric n in 1..total_chapters, no dupes,
    // title is a non-empty string. Other fields are optional and pass-through.
    // Combined with the length check above, unique + in-range n means every
    // chapter number 1..total_chapters is covered exactly once.
    const seen = new Set<number>()
    for (const e of incoming) {
      const n = Number((e as any)?.n)
      if (!Number.isFinite(n) || n < 1 || n > totalChapters) {
        return res.status(400).json({ detail: `Outline entry has invalid n: ${(e as any)?.n}` })
      }
      if (seen.has(n)) {
        return res.status(400).json({ detail: `Duplicate chapter number in outline: ${n}` })
      }
      seen.add(n)
      if (typeof (e as any)?.title !== 'string' || !(e as any).title.trim()) {
        return res.status(400).json({ detail: `Outline entry ${n} is missing title.` })
      }
    }

    const nowIso = new Date().toISOString()
    // Approval-timestamp semantics: `approved: true` means "ensure this is
    // approved", not "stamp approved-at = now". A silent autosave fired
    // mid-edit on an already-approved outline used to bump the timestamp
    // forward on every keystroke (the UI then showed "Approved 0m ago"
    // forever). Preserve the original first-approval timestamp; only
    // populate when transitioning from unapproved → approved.
    const approvedAt = wantApproved
      ? (existing.outline_approved_at ?? nowIso)
      : (existing.outline_approved_at ?? null)
    const updated = {
      ...existing,
      outline: incoming,
      outline_edited_at: nowIso,
      outline_approved_at: approvedAt,
      last_updated: nowIso,
    }
      await writeJsonAtomic(sidecarFile, updated)
      res.json({
        ok: true,
        outline_edited_at: updated.outline_edited_at,
        outline_approved_at: updated.outline_approved_at,
      })
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not save outline'))
  }
})

// ── Bring-your-own content (v1.0.269) ───────────────────────────────────
// Inject a user-supplied full script or outline into an existing episode so
// the rest of the pipeline (Audio → Subtitles → Scene Plan, or Expand Chapters)
// runs on it without going through format-shaped generation.

/** Parse a pasted plain-text outline (one chapter per line) into entries.
 *  Strips common leading markers and splits an optional synopsis after a
 *  dash/colon. */
function parseOutlineText(text: string): Array<{ title: string; synopsis?: string }> {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map((line) => {
    const s = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:chapter|part|section|topic|reason|lesson|bit|beat)\s+\d+\s*[:\-–—.]\s*/i, '')
      .replace(/^\d+\s*[.)\-–—:]\s*/, '')
      .replace(/^[-*•]\s*/, '')
      .trim()
    const m = s.match(/^(.+?)\s*(?:—|–|\s-\s|:)\s+(.+)$/)
    return m ? { title: m[1]!.trim(), synopsis: m[2]!.trim() } : { title: s }
  }).filter(o => o.title)
}

/**
 * Run an imported script/outline write inside the episode's Script subfolder,
 * preferring the EXISTING episode folder over a freshly built path — and, when
 * no folder exists yet, creating one ATOMICALLY.
 *
 * `resolveEpisodePaths` constructs the folder name from the *request* title, so
 * a pasted script whose title differs even slightly from the title the folder
 * was originally created with (a rename that never reached disk, copy-paste
 * drift, or a "✅ " done-marker prefix on the folder) would otherwise land in a
 * brand-new phantom folder right next to the real one — exactly the "it made a
 * new folder instead of using mine" bug, and a mess at bulk-import scale.
 *
 * Fix: match the real folder by `${code} - ` prefix (✅-tolerant) the same way
 * the old image-prompts save did, then find/create the Script subfolder inside it.
 *
 * ── Why a new folder is staged (Production defect, 2026-10-28) ─────────────
 *
 * A failed import for a code this channel did not own used to leave a
 * half-written `Season 000/EP0000 - <Title>` folder behind: nothing in the app
 * listed it (no accepted idea), yet every folder scan found it. Two rules now
 * hold:
 *
 *   1. An import may only CREATE a folder for an episode this channel actually
 *      has — an accepted idea (what the selectors and the Production Board
 *      read). A code that is neither registered nor on disk is refused with a
 *      plain message instead of silently becoming a folder.
 *   2. The new folder is built under `<channel>/.import-staging/…` and renamed
 *      into the season on success, so a partial one is never an episode folder.
 *      On failure the staging folder moves to the channel's own Trash and the
 *      error says where it went — never `rm`.
 */
async function withEpisodeScriptDir<T>(
  slug: string,
  episodeId: string,
  title: string,
  run: (scriptDir: string) => Promise<T>,
): Promise<T> {
  const paths = await resolveEpisodePaths(slug, episodeId, title)
  const computedEpisodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = pathMod.dirname(computedEpisodeDir)
  const scriptFolderName = pathMod.basename(paths.script_dir)

  const actualDir = await resolveEpisodeDir(seasonDir, episodeId)
  if (actualDir) {
    if (actualDir !== computedEpisodeDir) {
      console.log(
        `[script-import] episode ${slug}/${episodeId}: request title yielded ` +
        `"${pathMod.basename(computedEpisodeDir)}" but on-disk folder is ` +
        `"${pathMod.basename(actualDir)}". Writing into the existing folder.`,
      )
    }
    // Find/create the Script subfolder inside the real episode dir (✅-tolerant,
    // never duplicates a "✅ "-marked subfolder).
    return run(await resolveSubfolder(actualDir, scriptFolderName, true))
  }

  // No folder for this code. Decide whether this channel owns the episode at all.
  const registered = (await im.getIdeas(slug)).some(idea => (
    idea.status === 'accepted'
    && (idea.episode_code || '').toUpperCase() === episodeId.toUpperCase()
  ))
  if (!registered) {
    const numberPart = Number(episodeId.replace(/^[A-Za-z]+/, ''))
    const detail = Number.isFinite(numberPart) && numberPart < 1
      ? `${episodeId} has no episode number, so it names no episode in this channel.`
      : `${episodeId} is not an episode in this channel.`
    throw Object.assign(new Error(
      `${detail} Accept the idea first (Ideas → Accept), then import into the code it was given.`,
    ), { statusCode: 400, expose: true, code: 'EPISODE_NOT_REGISTERED' })
  }

  console.warn(
    `[script-import] episode ${slug}/${episodeId}: no existing folder under ${seasonDir} ` +
    `matches "${episodeId} - " prefix — creating "${pathMod.basename(computedEpisodeDir)}" once the import succeeds.`,
  )
  const projectDir = pm.getProjectDir(slug)!
  const stagingRoot = pathMod.join(projectDir, '.import-staging', `${episodeId}-${randomUUID().slice(0, 8)}`)
  const stagingScriptDir = pathMod.join(stagingRoot, scriptFolderName)
  await fs.mkdir(stagingScriptDir, { recursive: true })

  try {
    const result = await run(stagingScriptDir)
    await fs.mkdir(seasonDir, { recursive: true })
    await fs.rename(stagingRoot, computedEpisodeDir)
    return result
  } catch (error) {
    // The staging folder is not an episode folder, but it still holds the
    // partial work — keep it restorable and say exactly where it went.
    let trashed = ''
    try {
      trashed = moveToTrashSync(
        stagingRoot,
        pathMod.join(trashRootFor(projectDir, projectDir, slug), 'import-failures', pathMod.basename(stagingRoot)),
        'episode-import',
      )
    } catch { /* reported below — losing the cleanup must not mask the cause */ }
    const cause = error instanceof Error ? error.message : String(error)
    const status = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500
    throw Object.assign(new Error(
      trashed
        ? `${cause} Nothing was left behind: the partial episode folder was moved to ${trashed}.`
        : `${cause} A partial episode folder was left at ${stagingRoot} (moving it to the Trash failed).`,
    ), { statusCode: status, expose: true })
  }
}

/** A queued, running or paused writer owns this episode's script files; an
 *  import would be overwritten by it, or overwrite what it is writing. */
function importBlockedByActiveWriter(slug: string, episodeId: string): string {
  const active = ['introduction-only', 'chapter-only', 'expand_chapters', 'outline_only']
    .some(type => jq.isDuplicate(slug, episodeId, type))
  return active
    ? `${episodeId} is still writing its script. Wait for that job to finish (or cancel it in Jobs), then import again.`
    : ''
}

// POST import-script — paste a finished script; written as per-chapter files +
// the unified narration so Audio/Subtitles/Scene Plan run on it directly.
router.post('/projects/:slug/episodes/:episodeId/import-script', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    const title = typeof req.body?.title === 'string' ? req.body.title : ''
    if (!text.trim()) return res.status(400).json({ detail: 'Paste your script in `text`.' })
    const busy = importBlockedByActiveWriter(slug, episodeId)
    if (busy) return res.status(409).json({ detail: busy })

    const { splitNarrationIntoChapters, writeChapterFiles, assembleUnifiedNarration } =
      await import('../lib/narration-assembly.js')

    // Everything below runs inside the episode's Script folder. When the folder
    // has to be created, withEpisodeScriptDir builds it in staging and renames
    // it only after this callback resolves — see its doc comment.
    const asm = await withEpisodeScriptDir(slug, episodeId, title, async (scriptDir) => {
      let parts = splitNarrationIntoChapters(text)
      if (!parts.chapters.length) {
        // No `## Chapter N:` headings → import the whole thing as one chapter.
        parts = { chapters: [{ number: 1, title: title || 'Script', text: text.trim() }], ...(parts.intro ? { intro: parts.intro } : {}) }
      }

      // Move prior script artifacts for this episode into Story's Trash
      // (never hard-deleted) so a re-import is clean.
      //
      // The code is ESCAPED before it is used as a pattern. It arrives as a route
      // param, and an unescaped `.*` turns `^${code}_Chapter_` into a pattern that
      // matches every episode's chapters in this folder — and the loop below
      // moves each match away. `scene-review.ts` already escapes at its own
      // pattern sites; this block was the copy that did not.
      const codePattern = episodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const projectDir = pm.getProjectDir(slug)!
      const narrationPath = pathMod.join(scriptDir, `${episodeId}_Script_Narration.md`)
      return withLock(narrationPath, async () => {
        const entries = await fs.readdir(scriptDir).catch(() => [] as string[])
        for (const f of entries) {
          if (
            new RegExp(`^${codePattern}_Chapter_\\d+\\.(md|docx)$`).test(f) ||
            new RegExp(`^${codePattern}_Introduction\\.(md|docx)$`).test(f) ||
            new RegExp(`^${codePattern}_Script_Narration\\.(md|docx)$`).test(f) ||
            f === `${episodeId}_Script_Narration.intro.json` ||
            f === `${episodeId}_chunked-progress.json`
          ) {
            const file = pathMod.join(scriptDir, f)
            const rel = pathMod.relative(projectDir, file)
            moveToTrashSync(file, pathMod.join(trashRootFor(projectDir, projectDir, slug),
              rel.startsWith('..') || pathMod.isAbsolute(rel) ? pathMod.join(episodeId, f) : rel), 'script')
          }
        }

        await writeChapterFiles(scriptDir, episodeId, title || episodeId, parts)
        const assembled = await assembleUnifiedNarration(scriptDir, episodeId, title || episodeId)
        if (assembled.introduction_present) {
          await writeJsonAtomic(pathMod.join(scriptDir, `${episodeId}_Script_Narration.intro.json`), { imported_at: new Date().toISOString() })
        }
        return assembled
      })
    })

    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
    res.json({ ok: true, chapters: asm.chapter_numbers.length, introduction: asm.introduction_present })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to import script')
  }
})

// POST import-outline — paste an outline (structured or one chapter per line);
// written as an APPROVED sidecar so "Expand Chapters" runs on it.
router.post('/projects/:slug/episodes/:episodeId/import-outline', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const title = typeof req.body?.title === 'string' ? req.body.title : ''
    let outline: Array<{ title: string; synopsis?: string }> = []
    if (Array.isArray(req.body?.outline)) {
      outline = req.body.outline
        .map((o: any) => ({ title: String(o?.title || '').trim(), synopsis: o?.synopsis ? String(o.synopsis).trim() : undefined }))
        .filter((o: any) => o.title)
    } else if (typeof req.body?.text === 'string') {
      outline = parseOutlineText(req.body.text)
    }
    if (!outline.length) return res.status(400).json({ detail: 'Provide `outline[]` or `text` (one chapter per line).' })
    const busy = importBlockedByActiveWriter(slug, episodeId)
    if (busy) return res.status(409).json({ detail: busy })

    const fmt = await getEffectiveFormat(slug).catch(() => null as any)
    const mode = fmt?.id === 'listicle' ? 'listicle' : 'narrative'
    const { writeImportedOutline } = await import('../lib/chunked-narration.js')
    // Same staging rule as import-script: a folder this channel does not own is
    // refused, and a folder being created is renamed into place only on success.
    const sidecar = await withEpisodeScriptDir(slug, episodeId, title, scriptDir =>
      writeImportedOutline(scriptDir, episodeId, outline, { mode }))

    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
    res.json({ ok: true, chapters: sidecar.total_chapters })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to import outline')
  }
})

// Regenerate ONE chapter (per-chapter refactor). Requires existing
// chapter source files OR a legacy unified narration we can migrate
// from on first use. Other chapters on disk are preserved; the unified
// narration_docx is re-assembled afterward so audio / subtitles / video
// all see the new content.
router.post('/projects/:slug/generate/chapter-only', validateBody(GenerateChapterOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const requestedChapter = Number(req.body.chapter_number)
  const item = `chapter:${requestedChapter}` as ScriptDocumentItem
  let manualReplay
  try {
    manualReplay = await replayAcceptedScriptManualAction(
      slug, req.body, 'chapter-only', req.body.episode_id, item,
    )
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual redo request.' })
  }
  if (manualReplay.conflict) {
    return res.status(409).json({ detail: 'This operation_id already belongs to a different chapter or source request.' })
  }
  if (manualReplay.previous) return res.status(200).json({ ...manualReplay.previous, reused: true })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No Gateway API Key configured. Add it in Settings → This Mac.' })
  }

  const sameChapter = (params: any) => Number(params?.chapter_number) === requestedChapter
  if (manualReplay.intent) {
    try {
      const paths = await resolveEpisodePathsForRead(slug, req.body.episode_id, req.body.title || '')
      const { chapterFilePath, ensureChapterFilesMigrated } = await import('../lib/narration-assembly.js')
      const manual = await withLock(paths.narration_docx, async () => {
        await ensureChapterFilesMigrated(paths.script_dir, req.body.episode_id, req.body.title || req.body.episode_id)
        return manualScriptParams({
          slug,
          body: req.body,
          episodeId: req.body.episode_id,
          item,
          targetFile: chapterFilePath(paths.script_dir, req.body.episode_id, requestedChapter),
          operationId: manualReplay.operationId!,
          clientFingerprint: manualReplay.clientFingerprint!,
        })
      })
      const job = await jq.enqueueManualGenerationRedo({
        project_slug: slug,
        type: 'chapter-only',
        episode_id: req.body.episode_id,
        title: req.body.title,
        params: manual.params,
        dedupeParams: sameChapter,
      }, manual.criteria)
      return res.status(201).json(job)
    } catch (error: any) {
      return res.status(error?.status || error?.statusCode || 409).json({
        detail: error?.message || 'Manual chapter redo was refused.',
      })
    }
  }

  let action
  try {
    action = await prepareExplicitScriptAction(slug, req.body, 'required')
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  if (action.conflict) return res.status(409).json({ detail: 'This operation_id already belongs to a different chapter request.' })
  if (action.previous) return res.status(200).json({ ...action.previous, reused: true })

  // Dedupe per (episode, chapter) — two clicks on the SAME chapter's
  // regenerate button shouldn't enqueue twice, but the user can queue
  // multiple DIFFERENT chapters in a row (they run back-to-back). The
  // narrowed predicate compares params.chapter_number so two clicks on
  // ch.5 dedupe while ch.5 + ch.7 both enqueue.
  return withExplicitActionReplay(slug, action.params, res, 'This operation_id already belongs to a different chapter request.', async () => {
    if (jq.isDuplicate(slug, req.body.episode_id, 'expand_chapters')) {
      return res.status(409).json({ detail: `Chapter expansion already queued/running for ${req.body.episode_id}` })
    }
    if (jq.isDuplicate(slug, req.body.episode_id, 'chapter-only', sameChapter)) {
      return res.status(409).json({
        detail: `Chapter ${requestedChapter} regen is already queued for ${req.body.episode_id}`,
      })
    }
    try {
      const job = await jq.enqueue({
        project_slug: slug,
        type: 'chapter-only',
        episode_id: req.body.episode_id,
        title: req.body.title,
        params: action.params,
        dedupeParams: sameChapter,
      })
      return res.status(201).json(job)
    } catch (error: any) {
      if (error?.status === 409 || error?.statusCode === 409) {
        return res.status(409).json({ detail: error.message })
      }
      throw error
    }
  })
})

// Generate introduction only (requires script to exist)
router.post('/projects/:slug/generate/introduction-only', validateBody(GenerateIntroductionOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  // Future-only gate for the Scripts page's automatic post-outline tail. The
  // page cannot know an episode's creation snapshot; the frozen fact decides.
  // Manual generation (no `automatic`) always stays available.
  if (req.body.automatic === true) {
    const paths = await resolveEpisodePathsByCode(slug, req.body.episode_id).catch(() => null)
    if (!paths || !await episodeIsIntroEligible(paths.episode_dir)) {
      return res.status(200).json({
        skipped: true,
        reason: 'Automatic introductions only apply to episodes created after they were enabled. ' +
          'Generate one from the Introduction page if you want it.',
      })
    }
  }

  let manualReplay
  try {
    manualReplay = await replayAcceptedScriptManualAction(
      slug, req.body, 'introduction-only', req.body.episode_id, 'introduction',
    )
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual redo request.' })
  }
  if (manualReplay.conflict) {
    return res.status(409).json({ detail: 'This operation_id already belongs to a different introduction or source request.' })
  }
  if (manualReplay.previous) return res.status(200).json({ ...manualReplay.previous, reused: true })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No Gateway API Key configured. Add it in Settings → This Mac.' })
  }

  // The caller names an episode; the server works out the rest.
  //
  // Nothing about HOW the opening is written travels with the request. Its
  // recipe — beats, wording, length, host, and now the model — is read from
  // the channel, so the Introduction page's button, the Script page's chained
  // run and an unattended batch all write from identical instructions. A batch
  // and a button producing different openings is exactly the defect this
  // shape exists to make impossible.
  //
  // The title is still resolved here rather than asked for, because the app
  // already knows an accepted episode's title and a caller that supplied one
  // could supply a different one.
  let title = typeof req.body.title === 'string' ? req.body.title.trim() : ''
  if (!title) {
    try {
      const { getIdeas } = await import('../services/idea-manager.js')
      const wanted = String(req.body.episode_id).toUpperCase()
      const idea = (await getIdeas(slug)).find(i => (i.episode_code || '').toUpperCase() === wanted)
      title = idea?.title || ''
    } catch { /* an unnamed episode still resolves by code below */ }
  }

  // Three sources, in this order, and the order is the whole design:
  //
  //   1. The channel's own choice, made on the Introduction page. An explicit
  //      saved answer, so it wins — including over the model the Script page
  //      sends along with a chained opening, which is not a deliberate
  //      override but a leftover from when the opening had no setting.
  //   2. A model named in this request.
  //   3. The Script Generator's saved model — the behaviour every channel had
  //      before the picker existed, and what a blank choice still means.
  //
  // And if none of those answer: refuse. Never substitute a catalogue default.
  // An invented model is indistinguishable to the reader from one he chose,
  // and it would write the opening on a different product from its own
  // chapters — the defect fixed in v1.4.68.
  const { getSegmentModel } = await import('../services/channel-segments.js')
  const { INTRODUCTION_SEGMENT_ID } = await import('../lib/episode-segments.js')
  const { normalizeChannelSegments, beatLinesForPrompt: runBeatLines } = await import('../lib/episode-segments.js')
  const runRecipe = req.body.introduction_recipe
    ? normalizeChannelSegments({ introduction: { recipe: req.body.introduction_recipe } }).introduction.recipe : null
  let model = runRecipe ? runRecipe.model : await getSegmentModel(slug, INTRODUCTION_SEGMENT_ID)
  if (!model) model = typeof req.body.model === 'string' ? req.body.model.trim() : ''
  if (!model) {
    const { resolveScriptSideChatModel } = await import('./pipeline.js')
    model = resolveScriptSideChatModel(config as Record<string, unknown>) || ''
    if (!model) {
      return res.status(400).json({
        detail: 'This channel\'s opening follows the Script Generator\'s language model, and no saved '
          + 'script preset carries one. Either choose a model for the opening on the Introduction page, '
          + 'or open Script Generator, choose a model under Main settings and save the script preset. '
          + 'No model was substituted.',
      })
    }
  }

  let runIntroduction: Record<string, unknown> | undefined
  if (runRecipe) {
    const format = await getEffectiveFormat(slug, { episodeId: req.body.episode_id })
    const requestedStyle = req.body.style || format.script.defaultNarratorStyleId
    const style = requestedStyle === 'auto'
      ? await (await import('../generators/episode.js')).automaticNarratorStyleForEpisode(format, slug, req.body.episode_id)
      : requestedStyle
    runIntroduction = { version: 1, title, model, style,
      ...(typeof req.body.custom_style_text === 'string' ? { custom_style_text: req.body.custom_style_text } : {}),
      recipe: { host_name: runRecipe.host_name, word_target: runRecipe.word_target,
        custom_opening: runRecipe.custom_opening_line, beats: runBeatLines(runRecipe) } }
  }

  if (manualReplay.intent) {
    try {
      const paths = await resolveEpisodePathsForRead(slug, req.body.episode_id, title)
      if (!await hasIntroductionScriptSource(paths.script_dir, req.body.episode_id)) {
        return res.status(400).json({ detail: 'Generate a script first. This episode has no chapters for an introduction.' })
      }
      const format = await getEffectiveFormat(slug, { episodeId: req.body.episode_id })
      const requestedStyle = req.body.style || format.script.defaultNarratorStyleId
      const resolvedStyle = requestedStyle === 'auto'
        ? await (await import('../generators/episode.js')).automaticNarratorStyleForEpisode(
            format, slug, req.body.episode_id,
          )
        : requestedStyle
      const { getChannelSegments } = await import('../services/channel-segments.js')
      const { beatLinesForPrompt, INTRODUCTION_SEGMENT_ID } = await import('../lib/episode-segments.js')
      const recipe = (await getChannelSegments(slug, req.body.episode_id))[INTRODUCTION_SEGMENT_ID].recipe
      const resolvedIntroduction = {
        version: 1,
        title,
        model,
        style: resolvedStyle,
        ...(typeof req.body.custom_style_text === 'string' ? { custom_style_text: req.body.custom_style_text } : {}),
        recipe: {
          host_name: req.body.host_name || recipe.host_name || '',
          word_target: req.body.word_target || recipe.word_target,
          custom_opening: req.body.custom_opening || recipe.custom_opening_line || '',
          beats: Array.isArray(req.body.beats) && req.body.beats.length ? [...req.body.beats] : beatLinesForPrompt(recipe),
        },
      }
      const { ensureChapterFilesMigrated, introductionFilePath } = await import('../lib/narration-assembly.js')
      const manual = await withLock(paths.narration_docx, async () => {
        await ensureChapterFilesMigrated(paths.script_dir, req.body.episode_id, title || req.body.episode_id)
        return manualScriptParams({
          slug,
          body: req.body,
          episodeId: req.body.episode_id,
          item: 'introduction',
          targetFile: introductionFilePath(paths.script_dir, req.body.episode_id),
          operationId: manualReplay.operationId!,
          clientFingerprint: manualReplay.clientFingerprint!,
          extraParams: { title, model, resolved_introduction: runIntroduction || resolvedIntroduction },
        })
      })
      const job = await jq.enqueueManualGenerationRedo({
        project_slug: slug,
        type: 'introduction-only',
        episode_id: req.body.episode_id,
        title,
        params: manual.params,
      }, manual.criteria)
      return res.status(201).json(job)
    } catch (error: any) {
      return res.status(error?.status || error?.statusCode || 409).json({
        detail: error?.message || 'Manual introduction redo was refused.',
      })
    }
  }

  let action
  try {
    action = await prepareExplicitScriptAction(slug, { ...req.body, title, model }, 'optional')
    // Client snapshots are validated above; only this route may attach the resolved job contract.
    if (runIntroduction) action.params.resolved_introduction = runIntroduction
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  if (action.conflict) return res.status(409).json({ detail: 'This operation_id already belongs to a different introduction request.' })
  if (action.previous) return res.status(200).json({ ...action.previous, reused: true })

  return withExplicitActionReplay(slug, action.params, res, 'This operation_id already belongs to a different introduction request.', async () => {
    if (jq.isDuplicate(slug, req.body.episode_id, 'introduction-only')) {
      return res.status(409).json({ detail: `Introduction generation already queued/running for ${req.body.episode_id}` })
    }
    const scriptWriter = ['chapter-only', 'expand_chapters']
      .find(type => jq.isDuplicate(slug, req.body.episode_id, type))
    if (scriptWriter) {
      return res.status(409).json({ detail: 'Wait for this episode’s script job to finish. Resume or cancel it in Jobs if paused.' })
    }
    const paths = await resolveEpisodePathsForRead(slug, req.body.episode_id, title)
    if (!await hasIntroductionScriptSource(paths.script_dir, req.body.episode_id)) {
      return res.status(400).json({ detail: 'Generate a script first. This episode has no chapters for an introduction.' })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'introduction-only',
      episode_id: req.body.episode_id,
      title,
      params: action.params,
    })
    return res.status(201).json(job)
  })
})

// ── Get script content for preview ──

router.put('/projects/:slug/episodes/:episodeId/introduction-content', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof body.text !== 'string' || !body.text.trim()) {
    return res.status(400).json({ detail: 'Provide the introduction as non-empty `text`.' })
  }

  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })

    const activeWriter = ['introduction-only', 'chapter-only', 'expand_chapters']
      .find(type => jq.isDuplicate(slug, episodeId, type))
    if (activeWriter) {
      return res.status(409).json({
        detail: 'A queued, running, or paused narration job owns this episode. '
          + 'Wait for it to finish, or resume/cancel it if paused, then save again.',
      })
    }

    const title = await resolveEpisodeTitleByCode(slug, episodeId)
    if (!title) return res.status(404).json({ detail: 'Episode not found' })
    const paths = await resolveEpisodePathsForRead(slug, episodeId, title)
    if (!existsSync(paths.script_dir) || !existsSync(resolveReadPath(paths.narration_docx))) {
      return res.status(404).json({ detail: 'No saved narration exists for this episode.' })
    }
    const {
      assembleUnifiedNarration,
      ensureChapterFilesMigrated,
      writeChapterFiles,
    } = await import('../lib/narration-assembly.js')

    const result = await withLock(paths.narration_docx, async () => {
      await ensureChapterFilesMigrated(paths.script_dir, episodeId, title || episodeId)
      await writeChapterFiles(
        paths.script_dir,
        episodeId,
        title || episodeId,
        { chapters: [], intro: { text: body.text } },
        { normalizeSpokenProse: false },
      )
      await assembleUnifiedNarration(paths.script_dir, episodeId, title || episodeId)

      const { parseNarrationDocx } = await import('../lib/docx-parser.js')
      const narrationPath = resolveReadPath(paths.narration_docx)
      const sections = await parseNarrationDocx(narrationPath)
      const introduction = sections.find(section => section.slug === 'Introduction')
      if (!introduction) throw new Error('The saved introduction could not be read back.')
      const stat = await fs.stat(narrationPath)

      const { episodeStatusCache } = await import('../services/episode-status-cache.js')
      episodeStatusCache.invalidate(slug, episodeId)
      return {
        ok: true,
        introduction: {
          content: introduction.text,
          modifiedAt: stat.mtime.toISOString(),
          wordCount: introduction.text.split(/\s+/).filter(Boolean).length,
        },
      }
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not save the introduction'))
  }
})

router.get('/projects/:slug/episodes/:episodeId/script-content', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const paths = await resolveEpisodePathsForRead(slug, episodeId, titleQuery)
    const result: any = { script: null, introduction: null,
      introduction_ready: await hasIntroductionScriptSource(paths.script_dir, episodeId) }

    const narrationPath = resolveReadPath(paths.narration_docx)
    if (existsSync(narrationPath)) {
      // Single source of truth: introduction (when present) lives INSIDE
      // the narration file as an "Introduction" section, not in a sibling
      // file. We split here so each preview panel gets only its slice
      // while the underlying file stays unified for the audio /
      // subtitles / video pipelines.
      const { parseNarrationDocx } = await import('../lib/docx-parser.js')
      const sections = await parseNarrationDocx(narrationPath)
      const stat = await fs.stat(narrationPath)

      const introSection = sections.find(s => s.slug === 'Introduction')
      const chapterSections = sections.filter(s => s.slug !== 'Introduction')
      // Re-emit chapters as headed text so the preview reads like the
      // original docx layout instead of a flat blob.
      const chapterContent = chapterSections.length
        ? chapterSections.map(s => `${s.label}\n\n${s.text}`).join('\n\n')
        : ''
      result.script = {
        content: chapterContent,
        modifiedAt: stat.mtime.toISOString(),
        wordCount: chapterContent.split(/\s+/).filter(Boolean).length,
      }
      if (introSection) {
        result.introduction = {
          content: introSection.text,
          modifiedAt: stat.mtime.toISOString(),
          wordCount: introSection.text.split(/\s+/).filter(Boolean).length,
        }
      }
    }

    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not load script content'))
  }
})

// ── Per-chapter listing for the scripts.vue Chapters panel ──
//
// One row per chapter source file on disk. Triggers eager-migration if
// the episode has only the legacy unified narration (no per-chapter
// files yet) so the new UI works against pre-refactor projects without
// the user having to do anything.
//
// `audio_stale` compares chapter source mtime against the corresponding
// audio chunk file's mtime. Read-only — no auto-deletion. The selector
// surfaces it as a "⚠ stale" pill so the user can choose to regenerate
// audio when ready.
router.get('/projects/:slug/episodes/:episodeId/chapter-list', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const paths = await resolveEpisodePathsForRead(slug, episodeId, titleQuery)

    const { ensureChapterFilesMigrated } =
      await import('../lib/narration-assembly.js')
    await withLock(paths.narration_docx, () =>
      ensureChapterFilesMigrated(paths.script_dir, episodeId, titleQuery))

    let entries: string[] = []
    try { entries = await fs.readdir(paths.script_dir) } catch { /* missing dir */ }

    // v1.0.249 — enumerate BOTH new `.md` and legacy `.docx` chapter files
    // (matchChapterFile accepts either). The old regex was `.docx`-only, so
    // new-format episodes showed "No chapters yet". De-dupe in case a partially
    // migrated dir has both extensions for the same chapter number.
    const numbers = Array.from(new Set(
      entries
        .map(n => matchChapterFile(n, episodeId))
        .filter((x): x is number => x !== null),
    )).sort((a, b) => a - b)

    // Audio chunk presence is per-section. The reconciler builds chunk
    // filenames as `{CODE}_Chapter_NN.mp3` (single chunk) or
    // `{CODE}_Chapter_NN_part{N}.mp3` (multi). We compare the chapter
    // source mtime against ANY matching audio chunk on disk — if every
    // chunk is older than the source, the audio is stale.
    let audioEntries: string[] = []
    try {
      const audioDir = paths.audio_dir
      if (existsSync(audioDir)) audioEntries = await fs.readdir(audioDir)
    } catch { /* no audio dir yet */ }

    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const { narrationStaleness } = await import('../services/narration-staleness.js')

    const chapters: Array<{
      number: number
      title: string
      present: boolean
      word_count: number
      character_count: number
      modified_at: string | null
      /** The shared narration freshness answer, with the basis it was reached on. */
      audio_staleness: Awaited<ReturnType<typeof narrationStaleness>>
    }> = []
    for (const num of numbers) {
      // Prefer the new `.md`, fall back to legacy `.docx`.
      const filePath = resolveArtifact(paths.script_dir, `${episodeId}_Chapter_${String(num).padStart(2, '0')}`)
      let title = `Chapter ${String(num).padStart(2, '0')}`
      let wordCount = 0
      let characterCount = 0
      let modifiedAt: string | null = null
      try {
        if (!filePath) throw new Error('chapter file not found')
        const stat = await fs.stat(filePath)
        modifiedAt = stat.mtime.toISOString()
        // Single mammoth parse per chapter — parseNarrationDocx now exposes
        // the descriptive title (the part AFTER "Chapter NN:") on the section
        // it returns. Previously we paid a second mammoth.convertToHtml call
        // per chapter just to recover the heading; for a 50-chapter listicle
        // that doubled the parse cost on every /chapter-list refresh, and
        // the route is hit on every job-completion tick during active work.
        const sections = await parseNarrationDocx(filePath)
        const sec = sections[0]
        if (sec) {
          const body = sec.text || ''
          wordCount = body.split(/\s+/).filter(Boolean).length
          // Character count over the body (whitespace included). Useful
          // for content-volume comparisons against TTS billing meters,
          // which charge per-character not per-word.
          characterCount = body.length
          if (sec.title) title = sec.title
        }
      } catch { /* unreadable file → present:false below */ }

      // Is this chapter's narration still the narration for the text on disk?
      // ONE rule, shared with the Audio page — see services/narration-staleness.ts.
      // Comparing mtimes marked every chapter stale when a re-import rewrote
      // identical text (MANU0002, 2026-10-25); audio narrated before the text
      // record exists keeps the mtime fallback and reports it as legacy.
      const slug = `Chapter_${String(num).padStart(2, '0')}`
      const chunkRe = new RegExp(`^${episodeId}_${slug}(?:_part\\d+)?\\.mp3$`)
      const audioStaleness = await narrationStaleness({
        episodeCode: episodeId,
        slug,
        scriptDir: paths.script_dir,
        episodeDir: paths.episode_dir,
        audioFilePaths: audioEntries.filter(n => chunkRe.test(n))
          .map(n => pathMod.join(paths.audio_dir, n)),
      })

      chapters.push({
        number: num,
        title,
        present: !!modifiedAt,
        word_count: wordCount,
        character_count: characterCount,
        modified_at: modifiedAt,
        audio_staleness: audioStaleness,
      })
    }

    res.json({ chapters })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list chapters'))
  }
})

// Per-chapter content read — drives the inline preview rows in
// ChapterListPanel. Returns the chapter's heading title + plain-text body
// + word_count + modified_at, lazy-loaded one chapter at a time so opening
// the panel doesn't pay for parsing N docx files up front.
//
async function readChapterContent(filePath: string, n: number) {
  const { parseNarrationDocx } = await import('../lib/docx-parser.js')
  const sections = await parseNarrationDocx(filePath)
  const content = (sections[0]?.text || '').trim()
  return {
    number: n,
    title: sections[0]?.title || `Chapter ${String(n).padStart(2, '0')}`,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    word_count: content.split(/\s+/).filter(Boolean).length,
    character_count: content.length,
    modified_at: (await fs.stat(filePath)).mtime.toISOString(),
  }
}

// Body-only replacement: heading identity stays on disk, and CAS covers exactly
// the prose returned by GET (not the Markdown/legacy Word container).
router.put('/projects/:slug/episodes/:episodeId/chapters/:chapterNumber/content', async (req, res) => {
  const { slug, episodeId, chapterNumber } = req.params
  const n = Number(chapterNumber)
  if (!Number.isSafeInteger(n) || n < 1) {
    return res.status(400).json({ detail: `Invalid chapter number: ${chapterNumber}` })
  }
  const { text, expected_sha256 } = req.body || {}
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ detail: 'Provide the chapter body as non-empty `text`.' })
  }
  if (typeof expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected_sha256)) {
    return res.status(400).json({ detail: 'Provide `expected_sha256` from the chapter content GET response.' })
  }
  if (/^\s*#{1,2}\s/m.test(text)
    || /^\s*(?:Chapter|Reason|Topic|Section|Part|Lesson|Bit|Beat)\s+\d+\s*[:\-–—]/im.test(text)
    || /^\s*\*\*(?:[IVXLCDM]+\.?|[^\n]*narration[^\n]*)\*\*\s*$/im.test(text)) {
    return res.status(400).json({ detail: 'Edit the chapter body only. Keep its heading, number, and title unchanged.' })
  }
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const title = await resolveEpisodeTitleByCode(slug, episodeId)
    if (!title) return res.status(404).json({ detail: 'Episode not found' })
    const paths = await resolveEpisodePathsForRead(slug, episodeId, title)
    const result = await withLock(paths.narration_docx, async () => {
      const { selectNarrationSections } = await import('../services/tts-request-plan.js')
      const section = { slug: `Chapter_${String(n).padStart(2, '0')}`, label: `Chapter ${String(n).padStart(2, '0')}`, text: '' }
      if (['introduction-only', 'chapter-only', 'expand_chapters', 'outline_only'].some(type => jq.isDuplicate(slug, episodeId, type))) {
        return { status: 409, body: { detail: 'A queued, running, or paused script job owns this episode. Finish or cancel it before editing chapter text.' } }
      }
      if (jq.isDuplicate(slug, episodeId, 'audio', params =>
        selectNarrationSections([section], String(params.sections || 'all')).length > 0)
        || jq.isDuplicate(slug, episodeId, 'audio_merge')) {
        return { status: 409, body: { detail: `Audio for Chapter ${n} is queued, running, or paused. Finish or cancel the audio job before editing its text.` } }
      }
      const { chapterFilePath, writeChapterFiles, assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
      const target = chapterFilePath(paths.script_dir, episodeId, n)
      const file = resolveReadPath(target)
      if (!existsSync(file)) return { status: 404, body: { detail: `Chapter ${n} is not on disk yet. Expand it from the outline panel first.` } }
      const revision = `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}` as const
      const current = await readChapterContent(file, n)
      if (current.sha256 !== expected_sha256) {
        return { status: 409, body: { detail: 'This chapter changed since you opened it. Reload its text, then apply your edit again.' } }
      }
      const { narrationDocxToMarkdown } = await import('../lib/docx-parser.js')
      const markdown = /\.md$/i.test(file) ? await fs.readFile(file, 'utf8') : await narrationDocxToMarkdown(file)
      const headings = markdown.split('\n').filter(line => /^\s*#{1,2}\s/.test(line))
      const heading = headings[0]
      const match = heading?.match(/^##\s+(?:Chapter|Reason|Topic|Section|Part|Lesson|Bit|Beat)\s+(\d+)\s*[:\-–—]\s*(.+)$/i)
      if (headings.length !== 1 || !match || Number(match[1]) !== n) {
        return { status: 409, body: { detail: `Chapter ${n} has an invalid heading. Restore its original heading before editing its text.` } }
      }
      if (text.trim() === current.content) {
        const { parseNarrationDocx } = await import('../lib/docx-parser.js')
        const combined = existsSync(resolveReadPath(paths.narration_docx))
          ? await parseNarrationDocx(resolveReadPath(paths.narration_docx)) : []
        // A retry after a failed assembly must repair the derivative before succeeding.
        if (combined.find(value => value.slug === section.slug)?.text !== current.content) {
          await assembleUnifiedNarration(paths.script_dir, episodeId, title)
          const repaired = await parseNarrationDocx(paths.narration_docx)
          if (repaired.find(value => value.slug === section.slug)?.text !== current.content) {
            throw new Error('Combined narration could not be repaired. The chapter was kept; reload and retry.')
          }
          const { episodeStatusCache } = await import('../services/episode-status-cache.js')
          episodeStatusCache.invalidate(slug, episodeId)
        }
        return { status: 200, body: { ok: true, chapter: current } }
      }
      const projectDir = pm.getProjectDir(slug)!
      const archiveFiles = [target, target.replace(/\.md$/, '.docx'),
        paths.narration_docx, paths.narration_docx.replace(/\.md$/, '.docx')]
      await writeChapterFiles(paths.script_dir, episodeId, title, {
        chapters: [{ number: n, title: current.title, heading, text: text.trim() }],
      }, { manualPromotion: { expectedRevision: revision, sourcePath: file, ownerActionId: randomUUID(), projectDir, projectSlug: slug, archiveFiles } })
      await assembleUnifiedNarration(paths.script_dir, episodeId, title)
      const saved = await readChapterContent(target, n)
      const { parseNarrationDocx } = await import('../lib/docx-parser.js')
      const combined = await parseNarrationDocx(paths.narration_docx)
      if (!saved.content || combined.find(value => value.slug === section.slug)?.text !== saved.content) {
        throw new Error('Chapter text was saved but combined narration could not be verified. Reload and retry; the previous files are preserved in Trash.')
      }
      const { episodeStatusCache } = await import('../services/episode-status-cache.js')
      episodeStatusCache.invalidate(slug, episodeId)
      const { writeTextEditMarker } = await import('../lib/narration-source-freshness.js')
      await writeTextEditMarker(paths.script_dir, episodeId, section.slug, createHash('sha256').update(text.trim()).digest('hex'))
      return { status: 200, body: { ok: true, chapter: saved } }
    })
    return res.status(result.status).json(result.body)
  } catch (e: any) {
    if (e?.code === 'SCRIPT_REVISION_CONFLICT') {
      return res.status(409).json({ detail: 'This chapter changed while saving. Reload its text, then apply your edit again.' })
    }
    return res.status(500).json(humanizeBackendError(e, `Could not save chapter ${n}`))
  }
})
router.get('/projects/:slug/episodes/:episodeId/chapters/:chapterNumber/content', async (req, res) => {
  const { slug, episodeId, chapterNumber } = req.params
  const n = Number(chapterNumber)
  if (!Number.isSafeInteger(n) || n < 1) {
    return res.status(400).json({ detail: `Invalid chapter number: ${chapterNumber}` })
  }
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const title = await resolveEpisodeTitleByCode(slug, episodeId)
    if (!title) return res.status(404).json({ detail: 'Episode not found' })
    const paths = await resolveEpisodePathsForRead(slug, episodeId, title)
    // v1.0.249 — resolve the chapter file in either format: new `.md` first,
    // legacy `.docx` fallback. Previously this only looked for `.md`, so the
    // inline preview 404'd on whichever format the episode didn't have.
    const filePath = resolveArtifact(paths.script_dir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}`)
    if (!filePath) {
      return res.status(404).json({
        detail: `Chapter ${n} is not on disk yet. Expand it from the outline panel first.`,
      })
    }

    res.json(await readChapterContent(filePath, n))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, `Could not load chapter ${n}`))
  }
})

// ── Generate image prompts with style/ratio controls ──────────────────────
//
// v1.0.87+: this route used to run the LLM call synchronously in the
// request handler and return the parsed prompts. That meant:
//   - The job never appeared in the Jobs panel, so users couldn't see
//     progress, partial output, or errors mid-flight (a 250-scene job
//     can take 1–3 minutes; the old route just hung the request).
//   - The chunked-batch path lived only in the executor, so the route's
//     single LLM call hit output-token caps at 50+ scenes and silently
//     produced 5 instead of 250.
//
// Now the route enqueues an `image_prompts` job and returns `{ job }`.
// The executor in `generators/image-prompts.ts` is the single source of
// truth for thumbnail prompts: it writes the document to disk and reports
// progress + errors via the standard Jobs SSE stream. The frontend
// watches the returned job_id via useJobs and refreshes the
// PromptReviewPanel when the job lands in `done`.
//
// The legacy sync return shape (`{ scenes, thumbnails, style_tag,
// aspect_ratio }`) is gone. Callers that depended on it (the inline
// "Current" tab in image-prompts.vue) now read prompts from disk via
// `GET /projects/:slug/episodes/:episodeId/image-prompts` once the job
// completes — same endpoint PromptReviewPanel already uses.
router.post('/projects/:slug/generate/image-prompts', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, title } = req.body
  if (typeof episode_id !== 'string' || !episode_id) {
    return res.status(400).json({ detail: 'episode_id is required' })
  }
  if (req.body?.mode && req.body.mode !== 'thumbnails') {
    return res.status(410).json({ detail: 'Legacy Scene Prompts generation is retired. Generate visual prompts in Scene Plan.' })
  }

  /**
   * WHO WRITES THESE PROMPTS — resolved BEFORE a job row exists (2026-10-25).
   *
   * The Thumbnail Prompts page sends `model: ''` until the customer touches the
   * picker, and four real jobs were admitted that way and failed instantly
   * inside the generator. The job panel then showed a failure, not the one thing
   * the operator needed to know: choose a model. The channel's own saved preset
   * is the authority (AGENTS §7 `thumbnail_prompts_presets` /
   * `thumbnail_prompts_last_preset`), so a run that named no model uses the one
   * that preset names; a run with neither the preset nor the request naming one
   * is refused here, with nothing enqueued and nothing charged (§1: Story Studio
   * never picks a model).
   *
   * The resolved model is folded into the body BEFORE the operation fingerprint
   * is taken, so a replayed operation_id and its original request still agree.
   */
  const model = resolveThumbnailModel(config, 'image_prompts', req.body?.model, (await getDefaultModels()).writing)
    || (typeof config.prompt_model === 'string' ? config.prompt_model.trim() : '')
  if (!model) return res.status(400).json({ detail: noThumbnailModelMessage('image_prompts') })

  let action
  try {
    action = await prepareExplicitScriptAction(slug, { ...req.body, model, mode: req.body.mode || 'thumbnails' }, req.body.force === true ? 'required' : 'optional')
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  if (action.conflict) return res.status(409).json({ detail: 'This operation_id already belongs to a different thumbnail prompt request.' })
  if (action.previous) return res.status(200).json({ ...action.previous, reused: true })

  return withExplicitActionReplay(slug, action.params, res, 'This operation_id already belongs to a different thumbnail prompt request.', async () => {
    if (jq.isDuplicate(slug, episode_id, 'image_prompts')) {
      return res.status(409).json({
        detail: `Image-prompts generation already queued/running for ${episode_id}`,
      })
    }
    // THE CHARACTER CEILING, RESOLVED LIVE.
    //
    // The client sends the SELECTION — 'auto' (follow the selected image model),
    // 'none' (no ceiling), or a whole number the customer chose — together with
    // the image model the prompts are written FOR. The number is resolved here,
    // against the live catalogue, by the same helper the Pipeline uses, so the
    // ceiling follows the model: a model change, a catalogue change, or a
    // different Mac cannot leave the writer working to a figure that is no
    // longer true. A resolved number the client sent earlier is NOT trusted.
    //
    // It is resolved INSIDE the replay guard, after the fingerprint check, so
    // the request that was signed is the request that was admitted.
    //
    // FAILS CLOSED, like the Pipeline step: a selected model the catalogue no
    // longer publishes has no ceiling to resolve, and NOTHING IS STARTED. No
    // fallback model and no fallback number are invented.
    //
    // The JOB carries the SELECTION, not the number resolved here: the executor
    // resolves the ceiling again when the job runs — and again on every retry —
    // so the ceiling a run is written under is the one in force AT THAT MOMENT,
    // not the one that was true when the button was pressed.
    const capRefusal = await resolveLiveImagePromptCharCap({
      intendedImageModel: action.params.intended_image_model,
      setting: action.params.prompt_char_cap,
      label: 'The Thumbnail Prompts selection',
      nothingHappened: 'Nothing was started.',
    })
    if (capRefusal.error) {
      return res.status(400).json({ detail: capRefusal.error })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'image_prompts',
      episode_id,
      title: title || '',
      params: action.params,
    })
    return res.status(201).json(job)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// METADATA GENERATOR — title (SEO) + description + tags
// ══════════════════════════════════════════════════════════════════════════

function checkProvider(_model: string, _config: any): string | null { return null }

// The old page generated title, description, and tags independently before
// narration timing existed. Keep an explicit machine-readable tombstone for
// older clients instead of silently allowing that workflow to bypass the
// one-pass YouTube Finalizer.
router.post([
  '/projects/:slug/generate/metadata/description',
  '/projects/:slug/generate/metadata/seo-titles',
  '/projects/:slug/generate/metadata/tags',
  '/projects/:slug/generate/metadata/all',
], (_req, res) => {
  res.status(410).json({
    code: 'LEGACY_METADATA_ROUTE_RETIRED',
    detail: 'This early metadata route is retired. Run Audio Assembly, then use YouTube Finalizer once the final timing is available.',
  })
})

// ── 1) Description ────────────────────────────────────────────────────────
// All four metadata generators below (description / seo-titles / tags / all)
// run their LLM calls synchronously in the request handler and return the
// generated content for in-page review before save. Per M5 (system audit):
// when these grow long enough to need observability, migrate to the queue
// via `enqueueOrRun(..., { sync: true })` — the seam is in services/job-queue.ts.

/**
 * The metadata formulas this channel can pick from, and which one it is on.
 *
 * Five ship with the app and a Content Pack adds more; the picker treats them
 * identically because they are identical — the same document kind, validated by
 * the same schema. `channel_default_id` is empty for a channel that has never
 * picked one, which is every channel that existed before formulas did.
 */
router.get('/projects/:slug/metadata/formulas', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })
  try {
    const rows = await metadataFormulaCatalogue()
    res.json({
      channel_default_id: typeof config.metadata_formula_id === 'string' ? config.metadata_formula_id : '',
      formulas: rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        architecture: row.architecture,
        source: row.source,
        pack_id: row.packId,
        section_count: row.document.description_plan.sections.length,
        description_max_chars: row.document.description_plan.max_chars,
        title_count: row.document.title_plan.count,
        tag_count: row.document.tag_plan.count,
        /** Header text where a section shows one, so the picker can preview the shape. */
        outline: row.document.description_plan.sections.map(section => ({
          id: section.id,
          header: section.header.render ? section.header.text ?? '' : '',
        })),
      })),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not load metadata formulas'))
  }
})

// ── 4b) Queued "Generate All" — same work as /metadata/all but goes through
//        the job queue so users can navigate away mid-run and come back to
//        find it done. Mirrors the script/audio/video page pattern:
//          POST  → 201 { job_id, ... }
//          poll  → /jobs/:id until status === 'done'
//          GET   /episodes/:id/metadata → load latest version from disk
//
// The synchronous /metadata/all stays for back-compat (the pipeline batch
// runner uses it via the executor directly; per-section regenerate buttons
// also still hit their narrower endpoints). New page wiring should prefer
// this queue endpoint so the EpisodeSelector confirm-on-switch dialog
// fires uniformly.

router.post('/projects/:slug/generate/metadata', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, title, model } = req.body
  if (!episode_id || typeof episode_id !== 'string') {
    return res.status(400).json({ detail: 'episode_id is required' })
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ detail: 'title is required' })
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ detail: 'model is required' })
  }
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  const readiness = await inspectYouTubeFinalizationStatus(slug, episode_id)
  const chapterMarksBlock = await safetyMode(slug, 'chapter_marks') === 'block'
  if (!readiness.audio_assembly_ready && (readiness.music_episode || chapterMarksBlock)) {
    return res.status(409).json({
      code: readiness.music_episode ? 'YOUTUBE_FINALIZER_MUSIC_STITCH_REQUIRED' : 'YOUTUBE_FINALIZER_AUDIO_REQUIRED',
      detail: readiness.music_episode
        ? readiness.warnings[0] || 'Send this music episode to Video Assembly in Episode Builder first, so its chapters come from the stitched tracklist.'
        : 'Run Audio Assembly before YouTube Finalizer so chapter timestamps use the complete measured narration timeline.',
      warnings: readiness.warnings,
    })
  }
  if (readiness.chapter_issue && chapterMarksBlock) {
    return res.status(409).json({ code: 'YOUTUBE_FINALIZER_CHAPTERS_REQUIRED', detail: readiness.chapter_issue, warnings: readiness.warnings })
  }

  let action
  try {
    action = await prepareExplicitScriptAction(slug, req.body, 'optional')
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  if (action.conflict) return res.status(409).json({ detail: 'This operation_id already belongs to a different YouTube finalization request.' })
  if (action.previous) return res.status(200).json({ ...action.previous, reused: true })

  return withExplicitActionReplay(slug, action.params, res, 'This operation_id already belongs to a different YouTube finalization request.', async () => {
    if (jq.isDuplicate(slug, episode_id, 'metadata')) {
      return res.status(409).json({ detail: `YouTube finalization already queued/running for ${episode_id}` })
    }

    const job = await jq.enqueue({
      project_slug: slug,
      type: 'metadata',
      episode_id,
      title: `YouTube Finalizer — ${episode_id}`,
      params: action.params,
    })
    return res.status(201).json(job)
  })
})

// ── 5) Save / Load metadata ───────────────────────────────────────────────

async function getMetadataDir(slug: string, episode_id: string, title: string): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episode_id, title || '')
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = pathMod.dirname(episodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
  if (actualDir) episodeDir = actualDir
  const names = await resolveSubfolderNames(slug, episode_id)
  return await resolveSubfolder(episodeDir, names.metadata)
}

router.post('/projects/:slug/generate/metadata/save', async (req, res) => {
  const { slug } = req.params
  const { episode_id, title, metadata_title, title_options, description, tags, save_mode, version } = req.body
  try {
    const dir = await getMetadataDir(slug, episode_id, title)

    // Preserve AI-generated title alternatives across saves so a user who
    // overwrites v1 from the metadata page doesn't accidentally wipe the
    // 4 alternates the pipeline saved alongside the picked title. The page
    // round-trips them in the body (loaded → kept → saved); fall back to a
    // single-entry list if the client didn't send them.
    const cleanTitleOptions: string[] = Array.isArray(title_options)
      ? title_options.filter((t: unknown): t is string => typeof t === 'string' && t.trim() !== '')
      : (metadata_title ? [String(metadata_title)] : [])

    const saved = await writeMetadataPackage({
      dir,
      code: episode_id,
      mode: save_mode === 'new' ? 'new' : { overwrite: version || 1 },
      build: ({ version: writeVersion, previous }) => {
        // Manual edits keep the finalizer audit that was recorded by the queued
        // generator. The managed chapter/source text is already inside
        // `description`; preserving this sidecar prevents autosave from erasing
        // the warning/readiness information.
        const priorFinalization = previous?.youtube_finalization
        return {
          title: metadata_title || '',
          title_options: cleanTitleOptions,
          description: description || '',
          tags: Array.isArray(tags) ? tags : [],
          ...(priorFinalization ? { youtube_finalization: priorFinalization } : {}),
          savedAt: new Date().toISOString(),
          version: writeVersion,
        }
      },
    })

    res.json({ ok: true, ...saved })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save metadata'))
  }
})

/**
 * Derive YouTube-format chapter timestamps from the episode's chapter
 * audio durations. Returns a string ready to drop into the metadata
 * description (the "0:00 Intro / 4:32 Chapter 1 / …" block YouTube
 * auto-renders as clickable chapter markers).
 *
 * Kept for older clients. It now uses the same measured Audio Assembly
 * timeline, approved outline titles, lead-in offset, and warning contract as
 * the automatic YouTube Finalizer.
 */
router.get('/projects/:slug/episodes/:episodeId/youtube-finalization-status', async (req, res) => {
  try {
    const status = await inspectYouTubeFinalizationStatus(req.params.slug, req.params.episodeId)
    res.json(status)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to inspect YouTube finalization readiness'))
  }
})

router.get('/projects/:slug/episodes/:episodeId/metadata', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const dir = await getMetadataDir(slug, episodeId, titleQuery)
    if (!existsSync(dir)) return res.json({ versions: [] })

    const files = await fs.readdir(dir)
    const re = new RegExp(`^${episodeId}_Metadata(?:_v(\\d+))?\\.json$`)
    const versions: any[] = []

    // Pre-fetch each matching file's contents in parallel — disk I/O is
    // the bottleneck here and reads are independent. Parsing stays
    // sequential (cheap, and per-file errors are still skipped).
    const jsonMatches = files.map(f => ({ f, m: f.match(re) })).filter(x => x.m) as Array<{ f: string; m: RegExpMatchArray }>
    const jsonContents = await Promise.all(
      jsonMatches.map(({ f }) => fs.readFile(pathMod.join(dir, f), 'utf-8').catch(() => null)),
    )
    for (let i = 0; i < jsonMatches.length; i++) {
      const { m } = jsonMatches[i]
      const text = jsonContents[i]
      if (!text) continue
      const v = m[1] ? parseInt(m[1], 10) : 1
      try {
        const data = JSON.parse(text)
        versions.push({
          version: v,
          title: data.title || '',
          // Pipeline runs save all AI-generated alternatives so the user can
          // later pick a different one without re-generating. May be absent
          // on metadata files saved by older builds — fall back to a single
          // entry derived from the active title.
          title_options: Array.isArray(data.title_options) && data.title_options.length
            ? data.title_options
            : (data.title ? [data.title] : []),
          // v1.4.75 — a package saved before the prompt fix can carry an
          // internal section name the model printed as a heading (`HOOK:`,
          // `SUBSCRIBE / LIKE CTA`). Cleaned on the way to the Metadata page
          // so what he reads, copies and re-saves is what a viewer would see.
          // The file on disk is left alone until he saves.
          description: stripInternalSectionLabels(data.description || ''),
          tags: Array.isArray(data.tags) ? data.tags : [],
          youtube_finalization: data.youtube_finalization || null,
          savedAt: data.savedAt || null,
        })
      } catch {}
    }

    // Fallback: if no .json, parse .txt files
    if (!versions.length) {
      const txtRe = new RegExp(`^${episodeId}_Metadata(?:_v(\\d+))?\\.txt$`)
      const txtMatches = files.map(f => ({ f, m: f.match(txtRe) })).filter(x => x.m) as Array<{ f: string; m: RegExpMatchArray }>
      const txtContents = await Promise.all(
        txtMatches.map(({ f }) => fs.readFile(pathMod.join(dir, f), 'utf-8').catch(() => null)),
      )
      for (let i = 0; i < txtMatches.length; i++) {
        const { m } = txtMatches[i]
        const text = txtContents[i]
        if (!text) continue
        const v = m[1] ? parseInt(m[1], 10) : 1
        try {
          const parsed = parseMetadataTxt(text)
          versions.push({
            version: v,
            ...parsed,
            description: stripInternalSectionLabels(parsed.description || ''),
            savedAt: null,
          })
        } catch {}
      }
    }

    versions.sort((a, b) => a.version - b.version)
    res.json({ versions })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list metadata versions'))
  }
})

router.post('/projects/:slug/episodes/:episodeId/translate', validateBody(TranslateEpisodeSchema), async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    // The translation runs as a queued job (Production Board / Jobs page, Retry,
    // §8 verified completion). The request only validates, binds the target
    // episode, and enqueues — no model call happens inside this request.
    const {
      loadSourceEpisodeScript, resolveTranslationLanguages, resolveTranslationTarget,
    } = await import('../services/translation.js')

    const model = String(req.body.model || '').trim()
    if (!model) {
      return res.status(400).json({ detail: 'Choose a writing model for the translation.' })
    }
    const sourceProject = await pm.getProject(slug)
    if (!sourceProject) return res.status(404).json({ detail: 'Project not found' })
    const targetProject = await pm.getProject(req.body.target_slug)
    if (!targetProject) return res.status(404).json({ detail: 'Target channel not found' })
    resolveTranslationLanguages(sourceProject.content_language, targetProject.content_language)

    const sourceScript = await loadSourceEpisodeScript(slug, episodeId)
    const chapters = Array.isArray(req.body.chapters) && req.body.chapters.length
      ? req.body.chapters as number[]
      : undefined
    if (chapters?.length) {
      const missing = chapters.filter(n => !sourceScript.chapters.some(ch => ch.number === n))
      if (missing.length) {
        return res.status(400).json({
          detail: `Source episode ${episodeId} has no ${missing.length === 1 ? 'Chapter' : 'Chapters'} ${missing.join(', ')} to translate.`,
        })
      }
    }

    const target = await resolveTranslationTarget({
      sourceSlug: slug,
      sourceEpisodeId: episodeId,
      targetSlug: req.body.target_slug,
      model,
      targetEpisodeId: req.body.target_episode_id,
      targetTitle: req.body.target_title,
      chapters,
    }, sourceScript.title)

    const job = await jq.enqueue({
      project_slug: req.body.target_slug,
      type: 'translate_episode',
      episode_id: target.code,
      title: `Translate ${slug}/${episodeId} → ${target.code} — ${target.title}`,
      params: {
        source_slug: slug,
        source_episode_id: episodeId,
        model,
        target_title: req.body.target_title,
        reuse_visuals: req.body.reuse_visuals,
        chapters,
      },
    })

    res.status(202).json({
      job,
      target_slug: req.body.target_slug,
      target_episode_id: target.code,
      target_title: target.title,
    })
  } catch (e: any) {
    const status = e?.statusCode || e?.status || 500
    res.status(status).json(humanizeBackendError(e, 'Failed to start the translation'))
  }
})

// `POST /generate/image-prompts-only` is retired. Thumbnail Prompts uses the
// thumbnail-only `/generate/image-prompts` contract; Scene Plan owns all
// scene visual prompts.
