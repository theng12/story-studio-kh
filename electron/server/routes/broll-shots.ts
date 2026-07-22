/**
 * Scripted B-Roll routes — REST surface for the shot plan (broll_plan.json).
 *
 *   GET    /projects/:slug/episodes/:code/broll-plan           — read plan
 *   PUT    /projects/:slug/episodes/:code/broll-plan           — save edited plan
 *   DELETE /projects/:slug/episodes/:code/broll-plan           — remove (revert)
 *   POST   /projects/:slug/episodes/:code/broll-plan/generate  — unavailable boundary
 *   POST   /projects/:slug/episodes/:code/broll-plan/resolve   — unavailable boundary
 *   POST   /projects/:slug/episodes/:code/broll-plan/assemble  — write selection sidecar + queue render
 */
import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import {
  readPlan, writePlan, resolveBrollPlanPath, deletePlanAt, normalizePlan, emptyPlan,
} from '../services/broll-plan.js'
import { planToSelectionSidecar } from '../services/broll-shot-resolver.js'
import { saveSelectionSidecar } from '../services/broll-selection-sidecar.js'
import type { JobType } from '../models/types.js'

export const router = Router()

const BROLL_AUTOMATION_UNAVAILABLE = {
  code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE',
  detail: 'Automatic B-Roll direction, provider search, download, and generation are unavailable until GenStudio KH publishes a qualified typed asset-planning route. Existing local pool clips and resolved plans can still be edited and assembled.',
}

function unavailable(res: any) {
  return res.status(501).json(BROLL_AUTOMATION_UNAVAILABLE)
}

async function resolveTitle(slug: string, code: string): Promise<string> {
  try {
    const ideas = await im.getIdeas(slug, 'accepted')
    return ideas.find(i => i.episode_code === code)?.title || ''
  } catch { return '' }
}

// ── Read / write / delete ────────────────────────────────────────────────────

router.get('/projects/:slug/episodes/:code/broll-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    res.json((await readPlan(req.params.slug, code, paths.episode_dir)) ?? emptyPlan())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read B-Roll plan'))
  }
})

router.put('/projects/:slug/episodes/:code/broll-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    const plan = normalizePlan(req.body)
    const at = await writePlan(req.params.slug, code, paths.episode_dir, plan)
    res.json({ ok: true, path: at, plan })
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to save B-Roll plan' })
  }
})

router.delete('/projects/:slug/episodes/:code/broll-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    await deletePlanAt(await resolveBrollPlanPath(req.params.slug, code, paths.episode_dir))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete B-Roll plan'))
  }
})

// ── Generate (shot director) + optional resolve ──────────────────────────────

router.post('/projects/:slug/episodes/:code/broll-plan/generate', async (req, res) => {
  void req
  return unavailable(res)
})

// ── Resolve (search + download the picks) ────────────────────────────────────

router.post('/projects/:slug/episodes/:code/broll-plan/resolve', async (req, res) => {
  void req
  return unavailable(res)
})

// ── Preview (Phase 3): stream the episode's merged narration audio ───────────

router.get('/projects/:slug/episodes/:code/narration-audio', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    if (!existsSync(paths.merged_audio_dir)) return res.status(404).json({ detail: 'No merged audio — run Audio Assembly first.' })
    let audioPath: string | null = null
    let best = 0
    for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
      if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
      const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
      if (st && st.size > best) { best = st.size; audioPath = path.join(paths.merged_audio_dir, f) }
    }
    if (!audioPath) return res.status(404).json({ detail: 'No merged audio file.' })
    const ext = path.extname(audioPath).toLowerCase()
    const mime = ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg'
    const stat = await fs.stat(audioPath)
    const fsMod = await import('fs')
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Accept-Ranges', 'bytes')
    const m = req.headers.range ? /bytes=(\d+)-(\d*)/.exec(req.headers.range) : null
    if (m) {
      const start = parseInt(m[1]!, 10)
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      fsMod.createReadStream(audioPath, { start, end }).pipe(res)
    } else {
      res.setHeader('Content-Length', String(stat.size))
      fsMod.createReadStream(audioPath).pipe(res)
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve narration audio'))
  }
})

// ── Storyboard (Phase 2): re-query one beat, search alternatives, swap clip ───

router.post('/projects/:slug/episodes/:code/broll-plan/requery-beat', async (req, res) => {
  void req
  return unavailable(res)
})

router.post('/projects/:slug/episodes/:code/broll-plan/search', async (req, res) => {
  void req
  return unavailable(res)
})

router.post('/projects/:slug/episodes/:code/broll-plan/swap-beat', async (req, res) => {
  void req
  return unavailable(res)
})

// ── Assemble: plan → selection sidecar → existing broll_assemble job ──────────

router.post('/projects/:slug/episodes/:code/broll-plan/assemble', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = (await readPlan(slug, code, paths.episode_dir)) ?? emptyPlan()

    const sidecar = await planToSelectionSidecar(plan, code)
    if (!sidecar) {
      return res.status(400).json({ detail: 'No resolved beats to assemble. Run Generate + Resolve so beats have clips first.' })
    }

    const title = await resolveTitle(slug, code)
    await saveSelectionSidecar(slug, code, title, sidecar)

    if (jq.isDuplicate(slug, code, 'broll_assemble' as JobType)) {
      return res.status(409).json({ detail: `B-Roll assembly already queued/running for ${code}` })
    }
    const job = jq.enqueue({
      project_slug: slug,
      type: 'broll_assemble' as JobType,
      episode_id: code,
      title: `Assemble Scripted B-Roll — ${code}`,
      params: { episode_id: code, title, broll_volume: 0 },
    })
    res.status(201).json({ ok: true, job, beats: sidecar.selection.length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Scripted B-Roll assembly failed to queue'))
  }
})
