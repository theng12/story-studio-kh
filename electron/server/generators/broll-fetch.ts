/**
 * B-Roll fetch executor — downloads one clip from a free / CC
 * stock-footage provider (Pexels, Pixabay) into the target pool,
 * writes a provenance sidecar, and re-runs the pool indexer so the
 * new clip lands in `.story-studio-broll.json` with `tags`,
 * `duration`, etc. populated.
 *
 * Does NOT auto-chain a normalize job — that's deliberate per the
 * v1.0.122 design call. User clicks ⚡ Normalize all (or per-clip
 * Normalize) when they're ready to spend the CPU.
 *
 * Cancel semantics: the executor checks `jq.isCancelled(job_id)`
 * between phases (search-confirm → download → sidecar write →
 * index) and via `AbortSignal` during the download itself. A
 * cancellation mid-download cleans up the temp file so the pool
 * folder stays tidy.
 */
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as bp from '../services/broll-pool-manager.js'
import * as jq from '../services/job-queue.js'
import { getAdapter, type FetchProvider, type FetchResult, type FetchQuality } from '../services/broll-fetchers/index.js'
import {
  writeProvenance,
  suggestFilename,
  recordFromResult,
  hasFetchedClip,
} from '../services/broll-provenance.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import type { Job } from '../models/types.js'

export interface BrollFetchParams {
  pool_id: string
  provider: FetchProvider
  /** Serialised FetchResult — the route layer hands the search-result
   *  object back to the executor so we don't need to re-search for
   *  it. Includes the full `files` array so the executor picks the
   *  quality without another API roundtrip. */
  result: FetchResult
  search_keywords: string[]
  /** Preferred quality — defaults to 'hd' on the route layer. */
  quality?: FetchQuality
}

export async function fetchBroll(job: Job): Promise<void> {
  const { pool_id, provider, result, search_keywords, quality } = job.params as BrollFetchParams
  if (!pool_id || !provider || !result) {
    throw new Error('pool_id, provider, and result are required')
  }

  const pool = await bp.getPool(pool_id)
  if (!pool) throw new Error(`Pool '${pool_id}' not found`)
  if (!existsSync(pool.folder_path)) {
    throw new Error(`Pool folder offline — plug in the SSD at ${pool.folder_path} before fetching.`)
  }

  // Dedupe check (belt-and-suspenders — the route layer also annotates
  // search results with already_have, but a job could have been queued
  // before the user re-scanned). If the clip is already in this pool,
  // succeed silently rather than re-downloading + overwriting.
  if (await hasFetchedClip(pool.folder_path, provider, result.source_id)) {
    job.output_lines.push(`Skipping — already in pool (${provider}#${result.source_id})`)
    return
  }

  // Construct a stable filename. `suggestFilename` derives a slug from
  // the first keyword so the filename is human-scannable in Finder,
  // but the source+id pair in the prefix is what guarantees uniqueness.
  // Extension follows the pool media: audio (SFX) previews are mp3, video
  // clips are mp4. Passing the right ext is what makes the post-fetch scan
  // actually index the file (the audio-pool scan only matches audio exts).
  const media = bp.poolMedia(pool)
  const ext = media === 'audio' ? 'mp3' : 'mp4'
  const filename = suggestFilename(provider, result.source_id, search_keywords, ext)
  const destPath = path.join(pool.folder_path, filename)

  // Don't overwrite an existing file with the same name — extremely
  // unlikely given the source-id prefix, but possible if a user
  // hand-renamed something to match. Fail loud so we don't blow away
  // user data.
  if (existsSync(destPath)) {
    throw new Error(`Filename collision: ${filename} already exists in pool. Rename the existing file and retry.`)
  }

  job.output_lines.push(`Provider: ${provider}`)
  job.output_lines.push(`Source: ${result.source_url}`)
  job.output_lines.push(`License: ${result.license}`)
  job.output_lines.push(`Target: ${filename}`)
  job.output_lines.push(`Quality: ${quality || 'hd'}`)

  const adapter = getAdapter(provider)
  const controller = new AbortController()
  // Surface cancellation by aborting the in-flight fetch.
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    job.output_lines.push(`Downloading…`)
    await adapter.download(result, destPath, { quality: quality ?? 'hd', signal: controller.signal })
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error('Download cancelled')
    }
    throw e
  } finally {
    clearInterval(cancelWatcher)
  }

  // Verify the file actually landed before writing the sidecar — guards
  // against a silent network truncation that didn't error but produced
  // zero bytes.
  const stat = await fs.stat(destPath).catch(() => null)
  if (!stat || stat.size === 0) {
    await fs.unlink(destPath).catch(() => {})
    throw new Error('Download produced no bytes — file removed.')
  }
  job.output_lines.push(`Downloaded ${(stat.size / (1024 * 1024)).toFixed(1)} MB`)

  // Pick the actual file we downloaded so the sidecar records the
  // quality we landed (not just what the provider catalogued).
  const desired = quality ?? 'hd'
  const downloaded = result.files.find(f => f.quality === desired) || result.files[0]
  const sidecar = recordFromResult(
    result,
    filename,
    downloaded?.width ?? result.width,
    downloaded?.height ?? result.height,
    search_keywords,
  )
  await writeProvenance(pool.folder_path, sidecar)
  job.output_lines.push(`Provenance written: .broll-provenance/${filename}.json`)

  // Re-scan so the new clip lands in `.story-studio-broll.json`
  // (filename + duration + dimensions + sha256). Without this the clip
  // is on disk but invisible to the pool's clip list until the user
  // hits "Scan" manually. Pass the pool media so an audio pool scans for
  // audio extensions (a default 'video' scan would skip the mp3).
  job.output_lines.push(`Re-scanning pool…`)
  await scanPoolFolder(pool.folder_path, undefined, media)

  // Apply provider-supplied tags (Freesound returns them) to the freshly
  // indexed clip so fetched SFX land pre-tagged. The scan re-creates the
  // clip with empty tags; setting them after the scan is what sticks.
  // Best-effort — a tag-write failure shouldn't fail an otherwise-good fetch.
  if (Array.isArray(result.tags) && result.tags.length) {
    try {
      await bp.setClipTags(pool.id, filename, result.tags)
      job.output_lines.push(`Tagged: ${result.tags.slice(0, 8).join(', ')}${result.tags.length > 8 ? '…' : ''}`)
    } catch (e: any) {
      job.output_lines.push(`(tagging skipped: ${e?.message || e})`)
    }
  }
  // The scan rebuilds .story-studio-broll.json from disk. Persist that
  // updated index via the pool manager's exposed save helper so any
  // open UI sees the new clip on the next /clips poll.
  // scanPoolFolder returns the result, but the index it writes is the
  // source of truth — no explicit save needed since the indexer
  // writes it inline.
  job.output_lines.push(`Done.`)
}
