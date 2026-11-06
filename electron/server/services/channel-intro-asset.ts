/**
 * An EXPLICIT channel-owned intro for Audio Assembly (1.4.384).
 *
 * Registration is deliberately NOT here. Choosing a file already adopts it into
 * `<channel>/assets/` through the existing `POST /system/resolve-asset-path`
 * `mode=adopt` route — FilePicker's Browse calls it — and the result is stored
 * as a `${CHANNEL}/…` portable path. No second registry, no config read, and
 * nothing is ever adopted without a person picking it (the Developer approval
 * condition: output changes only after an explicit selection).
 *
 * What lives here is the FREEZE at the job boundary: the chosen bytes are
 * copied once and hashed, so the merge reads exactly what the job was queued
 * with even if the channel asset is edited or removed mid-run. Local and remote
 * consumers of the assembled audio therefore see the same intro bytes.
 */

import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { checkAssetAvailability, writeAtomic } from '../lib/sync-safe.js'
import { getWorkTempRoot, sanitizeWorkTempSegment } from '../lib/work-tempdir.js'
import { isPortablePath, resolveAssetPath, toPortablePath } from './path-resolver.js'

/**
 * The `channel_intro` block of an audio-merge request, as the route freezes it.
 * Volume is LINEAR gain (same unit contract as `AudioMergeIntro.volume`): the
 * host page converts its percent slider exactly once, at the payload boundary.
 */
export interface ChannelIntroSelection {
  /** Absent/false is never a selection — the generator then takes the legacy path. */
  enabled?: boolean
  /** Frozen copy the merge must read. Absent when the source was unavailable at the boundary. */
  file?: string
  /** Absolute source path the person chose, resolved at the boundary. */
  source?: string
  /** The source's own filename — what the completion record should name. */
  name?: string
  sha256?: string
  bytes?: number
  volume?: number
  gap_after?: number
}

/**
 * Freeze one explicitly chosen channel intro at the job boundary.
 *
 * The source must be an ASSET OF THIS CHANNEL — an adopted `${CHANNEL}/…` or
 * `${PROJECT}/…` path (or an absolute path inside this channel, which
 * `toPortablePath` collapses to one). A raw dialog path or another channel's
 * folder is refused with a clear reason: no channel may consume an asset it
 * does not own, and ownership is looked up, never parsed from the string.
 *
 * A source that is missing or empty comes back WITHOUT `file`: nothing is
 * frozen, and the generator's existing `intro_audio` safety mode decides at run
 * time with its own loud reason (Block stops, Warn/Off assemble without it).
 * An unresolvable portable path or a foreign path throws — the route turns
 * that into a 400.
 */
export async function freezeChannelIntro(opts: {
  /** Absolute episodes folder, for expanding `${CHANNEL}/…`. */
  outputRoot: string
  /** Portable or absolute path the person explicitly picked. */
  file: string
  slug: string
  episodeId: string
}): Promise<ChannelIntroSelection> {
  const raw = String(opts.file || '').trim()
  const abs = isPortablePath(raw) ? resolveAssetPath(raw, opts.outputRoot) : path.resolve(raw)
  const stored = toPortablePath(abs, opts.outputRoot)
  if (!stored.startsWith('${CHANNEL}/') && !stored.startsWith('${PROJECT}/')) {
    throw new Error(
      `"${raw}" is not an adopted asset of this channel, so it cannot be frozen for a run. `
      + 'Pick the file again so Story copies it into this channel\'s assets folder.',
    )
  }
  const avail = checkAssetAvailability(abs, 'channel_intro.file')
  if (avail.status !== 'available') {
    return { source: abs, name: path.basename(abs) }
  }
  const bytes = await fs.readFile(abs)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  // Content-addressed: the same bytes land on the same path, so re-freezing an
  // unchanged asset is a no-op write and the identity IS the hash.
  const dir = path.join(
    getWorkTempRoot(),
    sanitizeWorkTempSegment(opts.slug),
    sanitizeWorkTempSegment(opts.episodeId),
    '.intro_freeze',
  )
  await fs.mkdir(dir, { recursive: true })
  const frozen = path.join(dir, `${sha256}${path.extname(abs) || '.mp3'}`)
  // The hash-named file is a CACHE, not proof: a same-size corrupt copy would
  // otherwise be trusted forever. Hash what is already there and rewrite
  // through the atomic primitive when it differs (or the file is gone).
  // shortcut: these few-MB copies are not swept with the .tmp_* run dirs —
  // the queue does not own their lifecycle yet; a stale jingle beats a
  // mid-run swap of the bytes the job was queued with.
  let cached = false
  try {
    const held = await fs.readFile(frozen)
    cached = createHash('sha256').update(held).digest('hex') === sha256
  } catch { /* absent or unreadable — write below */ }
  if (!cached) await writeAtomic(frozen, bytes)
  // source/name are diagnostics only after this point — the merge consumes the
  // frozen copy, and the generator re-verifies its sha256 before use.
  return { file: frozen, source: abs, name: path.basename(abs), sha256, bytes: bytes.length }
}
