/**
 * Transient sidecar for in-progress resumable uploads.
 *
 * Google's resumable-upload sessions are valid for ~7 days. When the app
 * is killed mid-upload (force quit, crash, OS restart) the session URL
 * lives only in `uploadVideo`'s local scope and is lost — the next click
 * burns a fresh 1600 quota units (16% of the default daily 10K) plus
 * re-uploads the whole file from byte 0. Persisting the session URL lets
 * us resume from Google's high-water mark instead.
 *
 * Storage location: `<userData>/projects/<slug>/uploads-in-progress/<episode_code>.json`
 *   — kept off the user's rendering tree (output_root) so the sidecar
 *   doesn't clutter their Finder view of episode folders, and lives
 *   alongside other project state in userData.
 *
 * Lifecycle:
 *   - Written right after `uploadVideo` captures the resumable session URL.
 *   - Read by the upload generator BEFORE the next `uploadVideo` call —
 *     if present and still valid we resume, skipping init + quota charge.
 *   - Deleted on final 200 (success) or permanent 4xx (session unusable).
 *   - Kept on retryable failure / cancellation so a later retry can resume.
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { projectsRoot, getProjectDir } from './project-manager.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { UploadPlatform } from './upload-store.js'

/** 6.5 days, in ms — Google's real TTL is 7d, leave headroom for clock skew + slow retries. */
export const RESUME_SIDECAR_TTL_MS = 6.5 * 24 * 60 * 60 * 1000

export interface UploadResumeSidecar {
  platform: UploadPlatform
  account_id: string
  /** Absolute path to the source video file at init time. */
  file_path: string
  /** Size of the source file at init time — integrity check on resume. */
  file_size: number
  session_url: string
  created_at: string
  /**
   * `true` once the videos.insert quota has been charged — set on init.
   * Resumes consult this so the generator does NOT charge quota a second
   * time for the same Google-side session.
   */
  quota_charged: boolean
}

function resumeDir(slug: string): string {
  // Honour linked-project locations so resume sidecars stick with the
  // project itself, not a phantom default-location dir.
  const dir = getProjectDir(slug) || path.join(projectsRoot(), slug)
  return path.join(dir, 'uploads-in-progress')
}

function resumeSidecarPath(slug: string, episodeCode: string, platform: UploadPlatform): string {
  return path.join(resumeDir(slug), `${episodeCode}.${platform}.json`)
}

export async function readResumeSidecar(
  slug: string,
  episodeCode: string,
  platform: UploadPlatform,
): Promise<UploadResumeSidecar | null> {
  const p = resumeSidecarPath(slug, episodeCode, platform)
  if (!existsSync(p)) return null
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    const data = JSON.parse(raw) as UploadResumeSidecar
    if (!data?.session_url || !data?.created_at || !data?.account_id) return null
    return data
  } catch {
    return null
  }
}

export async function writeResumeSidecar(
  slug: string,
  episodeCode: string,
  sidecar: UploadResumeSidecar,
): Promise<void> {
  const dir = resumeDir(slug)
  await fsp.mkdir(dir, { recursive: true })
  await writeJsonAtomic(resumeSidecarPath(slug, episodeCode, sidecar.platform), sidecar)
}

export async function deleteResumeSidecar(
  slug: string,
  episodeCode: string,
  platform: UploadPlatform,
): Promise<void> {
  const p = resumeSidecarPath(slug, episodeCode, platform)
  if (existsSync(p)) await fsp.rm(p, { force: true })
}

/**
 * Decide whether a sidecar can still be used to resume an upload.
 * Caller passes the current file-on-disk size and the currently-connected
 * account id; we check TTL + integrity here so the generator code stays
 * focused on upload orchestration.
 */
export interface ResumeCheckArgs {
  sidecar: UploadResumeSidecar
  currentFileSize: number
  currentAccountId: string
  now?: number
}

export type ResumeCheckResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'file_size_mismatch' | 'account_mismatch' }

export function isSidecarUsable(args: ResumeCheckArgs): ResumeCheckResult {
  const now = args.now ?? Date.now()
  const createdAt = Date.parse(args.sidecar.created_at)
  if (!Number.isFinite(createdAt) || now - createdAt > RESUME_SIDECAR_TTL_MS) {
    return { ok: false, reason: 'expired' }
  }
  if (args.sidecar.file_size !== args.currentFileSize) {
    return { ok: false, reason: 'file_size_mismatch' }
  }
  if (args.sidecar.account_id !== args.currentAccountId) {
    return { ok: false, reason: 'account_mismatch' }
  }
  return { ok: true }
}

/**
 * Stable short hash of a session URL for log lines. Users won't see the
 * full URL (it contains an upload token), but a short prefix is useful
 * for matching log entries across restarts.
 */
export function sessionUrlHash(sessionUrl: string): string {
  let h = 0
  for (let i = 0; i < sessionUrl.length; i++) {
    h = (h * 31 + sessionUrl.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
