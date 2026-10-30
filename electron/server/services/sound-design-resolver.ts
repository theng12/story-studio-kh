import path from 'path'
import { existsSync } from 'fs'
import * as pools from './broll-pool-manager.js'
import type { SoundDesignCue } from '../models/types.js'
import type { SoundDesignMixCue } from '../lib/sound-design-mixer.js'

/**
 * Where a Gateway-library clip's bytes live on THIS Mac.
 *
 * The Gateway owns the store and serves the clip over
 * `/v1/sounds/library/{sha256}/audio`. The Gateway is usually another machine,
 * so this Mac downloads a clip once, into its own cache, and from then on it is
 * a local path just like a pool clip. The bytes are hashed before use, the
 * filename is matched on what it ENDS with (AGENTS §6), and a clip that cannot
 * be fetched is a loud error naming it — never a silent skip in the mix.
 */
export async function gatewaySoundClipPath(sha256: string, label?: string): Promise<string> {
  const { ensureSoundClipCached } = await import('../lib/gateway-sound-library.js')
  return await ensureSoundClipCached(sha256, label)
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
  if (cue.source === 'gateway') return await gatewaySoundClipPath(cue.clip, cue.label)
  if (!cue.pool_id) return ''
  const pool = await pools.getPool(cue.pool_id)
  if (!pool) return ''
  const filePath = path.join(pool.folder_path, cue.clip)
  return existsSync(filePath) ? filePath : ''
}
