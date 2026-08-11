/**
 * Research phase routes for the timestamp-driven pipeline (v1.0.142+).
 *
 *   GET    /api/research/sources                              — adapter status (configured + display info)
 *   GET    /api/projects/:slug/research/:episodeId            — read existing research.json
 *   POST   /api/projects/:slug/research/:episodeId/run        — queue a research_run job
 *   PUT    /api/projects/:slug/research/:episodeId            — replace the research.json (user-edited claims/status)
 *   DELETE /api/projects/:slug/research/:episodeId            — remove the sidecar
 *
 * v1.0.761 — there is NO research-level verify endpoint. Whether research
 * counts as reviewed is DERIVED from the per-claim triage saved through PUT
 * (see lib/research-verification.ts). The retired POST …/verify recorded a
 * second, separate attestation that duplicated the claim decisions and whose
 * wording ("checked against the cited sources") was untrue for an llm-only
 * adapter that returns no citations. Do not reintroduce it.
 */

import { Router } from 'express'
import fs from 'fs/promises'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  GENSTUDIO_RESEARCH_PROVIDER,
  RESEARCH_ADAPTERS,
  normalizeResearchMode,
  normalizeResearchSourceProvider,
  providerForResearchMode,
} from '../services/research/index.js'
import {
  WEB_MODE_CATALOG_UNAVAILABLE_REASON,
  describeWebResearchAvailability,
  normalizeDomainList,
} from '../services/research/web-capability.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { listChatModels } from '../lib/genstudio-client.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { sanitizeResearchOutputUrls } from '../services/research/urls.js'
import {
  readResearchReview,
  readResearchTriage,
  withResearchReviewRecord,
} from '../lib/research-verification.js'
import type {
  JobType,
  ResearchClaim,
  ResearchOutput,
  ResearchReviewRecord,
  ResearchSourceProvider,
} from '../models/types.js'

export const router = Router()

// ── GET /research/sources ─────────────────────────────────────────────
// Compatibility endpoint retained for older Story Studio clients. Research
// now has one execution route only: the customer's GenStudio LLM catalog.
router.get('/research/sources', async (_req, res) => {
  try {
    const results = await Promise.all(
      Object.entries(RESEARCH_ADAPTERS).map(async ([id, adapter]) => ({
        id: id as ResearchSourceProvider,
        display_name: adapter.displayName,
        helper_text: adapter.helperText,
        configured: await adapter.isConfigured(),
      })),
    )
    res.json({ sources: results })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list research sources'))
  }
})

// ── GET /research/web-models ──────────────────────────────────────────
// Which published GenStudio products may be used for "Search the web"
// research, filtered by CAPABILITY ONLY (see services/research/web-capability
// .ts for the six published conditions). Never filtered by provider or model
// name.
//
// An empty list is a NORMAL answer, not an error, so it returns 200 with
// `available: false` and a plain reason. That was the state at launch, when no
// product was research-qualified; qualified products are published now and web
// mode turned itself on here with no code change, exactly as designed. Neither
// answer is assumed ahead of the read.
router.get('/research/web-models', async (_req, res) => {
  try {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey.trim()) {
      return res.json({
        available: false,
        configured: false,
        reason: 'Connect GenStudio in Settings to see which models can search the web.',
        models: [],
      })
    }
    try {
      const catalog = await listChatModels(apiKey)
      return res.json({ configured: true, ...describeWebResearchAvailability(catalog) })
    } catch {
      // An unreachable catalogue is NOT "nothing qualifies". Saying so would
      // be a guess about GenStudio's inventory made from a network failure.
      return res.json({
        available: false,
        configured: true,
        reason: WEB_MODE_CATALOG_UNAVAILABLE_REASON,
        models: [],
      })
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to check web research availability'))
  }
})

// ── GET /projects/:slug/research/:episodeId ───────────────────────────
// Read existing research.json sidecar. Returns 404 with a sentinel
// `{ exists: false }` body so the frontend can render the empty-state
// without a try/catch + showError dance.
router.get('/projects/:slug/research/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    // Title hint isn't necessary for path resolution — pass empty.
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    try {
      const raw = await fs.readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw) as ResearchOutput
      res.json({ exists: true, research: parsed, sidecar_path: sidecarPath })
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return res.json({ exists: false, sidecar_path: sidecarPath })
      }
      throw e
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read research sidecar'))
  }
})

// ── POST /projects/:slug/research/:episodeId/run ──────────────────────
// Queue a research_run job. Returns the job descriptor; the frontend
// then watches /jobs SSE for completion + reads back via the GET above.
router.post('/projects/:slug/research/:episodeId/run', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const body = req.body || {}
  // The MODE is what the user picked; the provider id is derived from it. When
  // a caller sends only `source_provider`, fall back to what that provider
  // means. Absent everything = model-knowledge, the unchanged default.
  const researchMode = body.research_mode == null && typeof body.source_provider === 'string'
    ? undefined
    : normalizeResearchMode(body.research_mode)
  let sourceProvider: ResearchSourceProvider
  try {
    sourceProvider = researchMode
      ? providerForResearchMode(researchMode)
      : normalizeResearchSourceProvider(body.source_provider)
  } catch (e: unknown) {
    return res.status(400).json({
      detail: e instanceof Error ? e.message : 'Unknown research source',
    })
  }
  const mode = researchMode
    ?? (sourceProvider === GENSTUDIO_RESEARCH_PROVIDER ? 'model-knowledge' : 'web-search')
  // Domain filters are only meaningful in web mode. They are normalized here
  // and dropped again inside buildWebSearchBlock unless the SELECTED product
  // publishes `supports_domain_filters` — a filter the provider ignores must
  // never look like it was applied.
  const allowedDomains = mode === 'web-search' ? normalizeDomainList(body.allowed_domains) : []
  const blockedDomains = mode === 'web-search' ? normalizeDomainList(body.blocked_domains) : []
  const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
  const specificQuestions = typeof body.specific_questions === 'string'
    ? body.specific_questions
    : undefined
  const maxSources = typeof body.max_sources === 'number' ? body.max_sources : undefined
  const title = typeof body.title === 'string' ? body.title : ''
  // Optional model from the published GenStudio LLM catalog.
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined

  if (!topic) {
    return res.status(400).json({ detail: 'topic is required' })
  }

  if (jq.isDuplicate(slug, episodeId, 'research_run' as JobType)) {
    return res.status(409).json({ detail: `Research already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'research_run' as JobType,
    episode_id: episodeId,
    title: `Research — ${episodeId}`,
    params: {
      episode_id: episodeId,
      title,
      source_provider: sourceProvider,
      research_mode: mode,
      topic,
      specific_questions: specificQuestions,
      max_sources: maxSources,
      model,
      ...(allowedDomains.length ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains.length ? { blocked_domains: blockedDomains } : {}),
    },
  })
  res.status(201).json(job)
})

// ── PUT /projects/:slug/research/:episodeId ───────────────────────────
// Replace the sidecar. Used by the Research page when the user flips
// claim status (verified / ignored / unreviewed) or edits text in-app
// and clicks Save. Validates the shape minimally — the frontend is
// trusted but we sanity-check schema_version + array fields.
router.put('/projects/:slug/research/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const body = req.body as Partial<ResearchOutput> | undefined
  if (!body || body.schema_version !== 1) {
    return res.status(400).json({ detail: 'Invalid research payload (missing schema_version: 1)' })
  }
  if (!Array.isArray(body.claims) || !Array.isArray(body.citations)) {
    return res.status(400).json({ detail: 'Invalid research payload (claims + citations must be arrays)' })
  }

  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { dir, jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    await fs.mkdir(dir, { recursive: true })

    // v1.0.761 — the per-claim triage IS the research-level state, so saving it
    // is the only "verify" action there is. The client cannot hand us a review
    // record: we derive it here from what the save actually did.
    //
    //   • triage incomplete → no record at all (nothing was finished)
    //   • a claim decision changed by this save → recorded as 'human'
    //   • nothing changed → whatever finished it before is preserved, so a
    //     Pipeline-completed sidecar never gets relabelled as human-reviewed
    //     just because someone opened the page and pressed Save.
    let previous: ResearchOutput | null = null
    try {
      previous = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ResearchOutput
    } catch { /* first save for this episode — no prior decisions to compare */ }

    const triage = readResearchTriage(body)
    let normalized: ResearchOutput = sanitizeResearchOutputUrls({ ...(body as ResearchOutput) })
    delete (normalized as { verification?: unknown }).verification  // retired v1.0.760 block
    delete normalized.review
    if (triage.reviewed) {
      const carried: ResearchReviewRecord | null = readResearchReview(previous)
      normalized = (!carried || claimDecisionsChanged(previous, body as ResearchOutput))
        ? withResearchReviewRecord(normalized, 'human')
        : { ...normalized, review: carried }
    }

    await fs.writeFile(sidecarPath, JSON.stringify(normalized, null, 2), 'utf-8')
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({
      ok: true,
      sidecar_path: sidecarPath,
      review: normalized.review ?? null,
      triage,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save research sidecar'))
  }
})

/** Did this save actually change a Verified / Ignore decision? Claims added or
 *  removed count as a change too — the saved set is not the reviewed set. */
function claimDecisionsChanged(previous: ResearchOutput | null, next: ResearchOutput): boolean {
  if (!previous) return true
  const before = new Map((previous.claims || []).map((c: ResearchClaim) => [c?.id, c?.status]))
  const after = (next.claims || []) as ResearchClaim[]
  if (before.size !== after.length) return true
  return after.some(c => !before.has(c?.id) || before.get(c?.id) !== c?.status)
}

/** Claim decisions rewrite research.json in place; drop the cached episode
 *  status so the Production Board and pending filters see it immediately. */
async function invalidateEpisodeStatus(slug: string, episodeId: string): Promise<void> {
  try {
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
  } catch { /* best-effort — the cache also re-checks research.json's mtime */ }
}

// ── DELETE /projects/:slug/research/:episodeId ────────────────────────
// Drop the sidecar. ENOENT is treated as success — idempotent.
router.delete('/projects/:slug/research/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    try {
      await fs.unlink(sidecarPath)
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete research sidecar'))
  }
})
