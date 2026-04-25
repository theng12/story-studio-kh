/**
 * Debug endpoints — exposed in both dev and packaged builds for support.
 * Returns runtime diagnostics (Node version, FFmpeg path, providers, jobs, paths).
 */

import { Router } from 'express'
import os from 'os'
import { getFFmpegStatus } from '../services/ffmpeg-manager.js'
import { getLogDir } from '../services/logger.js'
import { getQueueStats } from '../services/job-queue.js'
import { registry } from '../providers/registry.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/debug/info', async (_req, res) => {
  try {
    const ffmpeg = await getFFmpegStatus().catch(() => ({ available: false, path: null }))

    res.json({
      node: process.version,
      electron: (process.versions as any).electron || null,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      memory_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      ffmpeg,
      providers: {
        text: registry.listTextProviders().map(p => p.meta.id),
        image: registry.listImageProviders().map(p => p.meta.id),
        audio: registry.listAudioProviders().map(p => p.meta.id),
      },
      jobs: getQueueStats(),
      paths: {
        userData: process.env.STORY_STUDIO_DATA_DIR || null,
        logs: getLogDir(),
        cwd: process.cwd(),
      },
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Debug info unavailable'))
  }
})
