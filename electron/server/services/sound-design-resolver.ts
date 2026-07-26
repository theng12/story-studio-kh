import path from 'path'
import { existsSync } from 'fs'
import * as pools from './broll-pool-manager.js'
import type { SoundDesignCue } from '../models/types.js'
import type { SoundDesignMixCue } from '../lib/sound-design-mixer.js'

/** Resolve only approved local-library cues. Missing source files are retained as a clear final-render error. */
export async function approvedSoundDesignMixCues(cues: SoundDesignCue[]): Promise<SoundDesignMixCue[]> {
  const resolved: SoundDesignMixCue[] = []
  for (const cue of cues) {
    if (cue.status !== 'approved') continue
    if (!cue.pool_id || !cue.clip) throw new Error(`Approved Sound Design cue ${cue.id} has no local-library clip.`)
    const pool = await pools.getPool(cue.pool_id)
    const filePath = pool ? path.join(pool.folder_path, cue.clip) : ''
    if (!filePath || !existsSync(filePath)) throw new Error(`Approved Sound Design clip is unavailable: ${cue.clip}.`)
    resolved.push({ kind: cue.kind, path: filePath, gain_db: cue.gain_db, start_sec: cue.start_sec, ...(cue.kind === 'bed' ? { end_sec: cue.end_sec } : {}) })
  }
  return resolved
}
