import path from 'path'
import { existsSync } from 'fs'
import * as pools from './broll-pool-manager.js'
import type { SoundDesignCue } from '../models/types.js'
import type { SoundDesignMixCue } from '../lib/sound-design-mixer.js'

/**
 * Where a Gateway-library clip's bytes live, or `null`.
 *
 * The Gateway owns the store (`DATA_DIR/sound-library/<sha256>.<ext>`), keeps
 * the bytes hashed and the licence sidecar beside them, and serves the listing
 * over `/v1/sounds/library`. This module never re-fetches: a clip is added to
 * the library ONCE, when the customer picks it, and from then on this is a
 * local path just like a pool clip. A missing file is a clear error naming the
 * clip, never a silent skip.
 *
 * `STORY_STUDIO_GATEWAY_SOUND_LIBRARY` names the directory explicitly for a
 * setup where the Gateway's data folder is somewhere this app cannot guess
 * (a remote Gateway, a different volume). It is read here and nowhere else.
 */
export function gatewaySoundLibraryDir(): string | null {
  const configured = process.env.STORY_STUDIO_GATEWAY_SOUND_LIBRARY
  if (configured && configured.trim()) return configured.trim()
  return null
}

/**
 * The path for a library clip.
 *
 * Deliberately `startsWith(`${sha256}.`)` and never `startsWith(sha256)`:
 * a bare prefix test would claim any sidecar or any clip whose hash merely
 * begins with these characters (AGENTS.md §6).
 */
export function gatewaySoundClipPath(sha256: string): string | null {
  const dir = gatewaySoundLibraryDir()
  if (!dir || !/^[0-9a-f]{64}$/.test(sha256)) return null
  for (const ext of ['mp3', 'wav', 'ogg', 'flac', 'm4a'] as const) {
    const candidate = path.join(dir, `${sha256}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve only approved cues, and THROW for an approved cue whose sound is
 * genuinely unavailable.
 *
 * This is the one place a sound stops a render, and it is not an editorial
 * call: the reviewer approved this exact clip and the mixer cannot make the
 * sound they approved. Any other gap (a cue nobody approved, a cue turned off,
 * a cue with no pick) never reaches here — `resolveRenderableSoundCues`
 * filtered it out first and said so.
 */
export async function approvedSoundDesignMixCues(cues: SoundDesignCue[]): Promise<SoundDesignMixCue[]> {
  const resolved: SoundDesignMixCue[] = []
  for (const cue of cues) {
    if (cue.status !== 'approved') continue
    const filePath = await clipPathFor(cue)
    if (!filePath) {
      throw new Error(`Approved sound "${cue.label || cue.id}" is unavailable${cue.clip ? ` (${cue.clip})` : ''}. Open Sound & Labels and choose another, or turn it off.`)
    }
    resolved.push({ kind: cue.kind, path: filePath, gain_db: cue.gain_db, start_sec: cue.start_sec, ...(cue.kind === 'bed' ? { end_sec: cue.end_sec } : {}) })
  }
  return resolved
}

async function clipPathFor(cue: SoundDesignCue): Promise<string> {
  if (!cue.clip) return ''
  if (cue.source === 'gateway') return gatewaySoundClipPath(cue.clip) || ''
  if (!cue.pool_id) return ''
  const pool = await pools.getPool(cue.pool_id)
  if (!pool) return ''
  const filePath = path.join(pool.folder_path, cue.clip)
  return existsSync(filePath) ? filePath : ''
}
