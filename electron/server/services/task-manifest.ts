/**
 * Sidecar task-manifest reader/writer.
 *
 * Purpose: when a provider accepts an async generation submit (TTS, image,
 * video), we persist the returned task_id keyed by the expected output
 * filename. The reconciler later uses this for deterministic recovery
 * even if the immediate download/poll step times out or crashes.
 *
 * Storage: `.task-manifest.json` at the ROOT of the asset subfolder
 * (e.g. `{episode}/TN0001 - 07 Audio Assets/.task-manifest.json`).
 *
 * Why the asset subfolder (not the episode root)? Filename keys are unique
 * within a subfolder (e.g. `TN0001_Chapter_03.mp3`), and different asset
 * types have different naming. One manifest per subfolder keeps the schema
 * flat and prevents cross-contamination.
 *
 * Best-effort: every write is wrapped — failures never propagate into the
 * caller's generation flow. A missing sidecar is just a missed chance at
 * deterministic recovery, not a broken generation.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { writeJsonAtomic } from '../lib/atomic-store.js'

const FILENAME = '.task-manifest.json'

export interface TaskManifestEntry {
  provider: string        // 'genaipro' | 'fal' | 'kie' | 'genaipro-veo' | 'elevenlabs'
  task_id: string
  submitted_at: string    // ISO 8601
  input_hash?: string     // sha256 of the input text/prompt, for collision detection
  // Optional provider-specific recovery hints. Filled by callers that know
  // their provider's polling needs more than just `task_id`. Always
  // optional → existing entries (audio prior to image/video recovery)
  // remain valid.
  //
  // poll_path  — kie.ai videos use a non-default sub-path per model
  //              (`/veo/record-info`, `/runway/record-info`, …). Storing
  //              it here means the reconciler doesn't have to re-derive
  //              the right path from the model id at recovery time.
  // result_url — fal.ai's queue API hands back a direct `response_url`
  //              at submit time; storing it lets the reconciler GET the
  //              result without re-resolving a status URL chain. Also
  //              useful as a debugging breadcrumb for any provider.
  poll_path?: string
  result_url?: string
}

interface Manifest {
  schema_version: 1
  tasks: Record<string, TaskManifestEntry>
}

function manifestPath(assetDir: string): string {
  return path.join(assetDir, FILENAME)
}

export async function readManifest(assetDir: string): Promise<Manifest> {
  const p = manifestPath(assetDir)
  if (!existsSync(p)) return { schema_version: 1, tasks: {} }
  try {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Manifest>
    if (parsed?.schema_version === 1 && parsed.tasks && typeof parsed.tasks === 'object') {
      return { schema_version: 1, tasks: parsed.tasks }
    }
  } catch { /* corrupt — start fresh rather than propagate */ }
  return { schema_version: 1, tasks: {} }
}

/**
 * Record a task-id for a given output filename. Never throws — if the
 * manifest can't be written, we log and continue so generation flows
 * aren't disrupted by a sidecar hiccup.
 */
export async function recordTask(
  assetDir: string,
  filename: string,
  entry: TaskManifestEntry,
): Promise<void> {
  try {
    await fs.mkdir(assetDir, { recursive: true })
    const m = await readManifest(assetDir)
    m.tasks[filename] = entry
    await writeJsonAtomic(manifestPath(assetDir), m)
  } catch (e: any) {
    console.warn(`[task-manifest] could not record ${filename}:`, e.message)
  }
}

export function getTaskEntry(manifest: Manifest, filename: string): TaskManifestEntry | null {
  return manifest.tasks[filename] || null
}

export function hashInput(input: string): string {
  // First 16 hex chars is plenty for collision detection within one episode.
  return 'sha256:' + createHash('sha256').update(input).digest('hex').slice(0, 16)
}
