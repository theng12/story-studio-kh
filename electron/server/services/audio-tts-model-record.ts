/**
 * The episode's own TTS model record — owner decision #8, v1.4.208
 *
 * WHY THIS EXISTS. `services/audio-reconciler.ts` predicts which
 * `{code}_{slug}_part{N}.mp3` files an episode should have on disk, so it can
 * name the missing ones. That prediction depends on ONE number: the request
 * boundary the narration was split at, which belongs to the TTS model the
 * episode was generated with. Nothing recorded that model per episode, so when
 * an episode's own job had aged out of the queue's terminal history the
 * reconciler borrowed the PROJECT's most recent audio job's model instead —
 * another episode's model, from another run.
 *
 * The damage is a wrong number rather than a crash. Generate episode A under a
 * model with a 3,000-character boundary, switch to one with 6,000, let B's job
 * age out, and B borrows A's model: the reconciler then predicts `_part1`/
 * `_part2` for a section the new model rendered as a single file and reports
 * parts that were never supposed to exist. Nothing announced it — AGENTS.md §4,
 * an episode-specific value reaching another episode.
 *
 * WHAT REPLACES IT. A fresh episode writes this record into its own directory
 * before the first TTS submission, so the boundary survives a part-way
 * interruption. Once an episode already has active audio, however, that record
 * stays a committed-active pointer: a replacement run keeps its request in the
 * existing task manifest/job checkpoint and moves this record only when the
 * new files are promoted as active. A refused or partial replacement therefore
 * cannot reinterpret still-active prior audio. The reconciler resolves the
 * boundary from this record first, and falls back to the cross-episode borrow
 * only for episodes that predate it. Both the model id AND the boundary it
 * implied are stored: the filenames on disk were produced under that boundary,
 * so a later catalogue change must not silently re-interpret them.
 *
 * Corrupt or missing = "no record", never a guess. A record that carries no
 * usable budget still names its model, and the caller re-resolves that model
 * against the live catalogue.
 */

import fs from 'fs/promises'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'

/** The episode-root sidecar. Sits beside `audio_chapters.json`. */
export const AUDIO_TTS_MODEL_SIDECAR = 'audio_tts_model.json'

export interface AudioTtsModelRecord {
  schema_version: 1
  episode_code: string
  model_id: string
  model_display_name?: string
  provider_name?: string
  /** The model's published `maximum_input_characters` when this was written. */
  published_maximum_input_characters: number
  /** What the generator actually split at — the boundary less the safety margin. */
  request_budget: number
  /** The head-room fraction that produced `request_budget`. */
  safety_margin: number
  recorded_at: string
}

/**
 * Persist the record. Atomic + locked so an interrupted run cannot leave a
 * half-written sidecar that reads as "no record" and silently re-opens the
 * borrow this exists to remove.
 */
export async function writeAudioTtsModelRecord(
  episodeDir: string,
  record: AudioTtsModelRecord,
): Promise<void> {
  const sidecarPath = path.join(episodeDir, AUDIO_TTS_MODEL_SIDECAR)
  await withLock(sidecarPath, () => writeJsonAtomic(sidecarPath, record))
}

/**
 * Read the record, or `null` when there is none (or it is unusable).
 *
 * A non-string `model_id` means the file was hand-edited or written by
 * something that is not this module, so it is treated as absent: the caller
 * then uses the legacy borrow rather than a value it cannot attribute.
 */
export async function readAudioTtsModelRecord(episodeDir: string): Promise<AudioTtsModelRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(episodeDir, AUDIO_TTS_MODEL_SIDECAR), 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.model_id !== 'string' || !raw.model_id.trim()) return null
    return {
      schema_version: 1,
      episode_code: typeof raw.episode_code === 'string' ? raw.episode_code : '',
      model_id: raw.model_id.trim(),
      model_display_name: typeof raw.model_display_name === 'string' ? raw.model_display_name : undefined,
      provider_name: typeof raw.provider_name === 'string' ? raw.provider_name : undefined,
      published_maximum_input_characters: positiveInt(raw.published_maximum_input_characters),
      // 0 means "not usable" — the caller re-resolves the model id instead of
      // treating a missing figure as a boundary of zero.
      request_budget: positiveInt(raw.request_budget),
      safety_margin: Number.isFinite(Number(raw.safety_margin)) ? Number(raw.safety_margin) : 0,
      recorded_at: typeof raw.recorded_at === 'string' ? raw.recorded_at : '',
    }
  } catch {
    return null
  }
}

function positiveInt(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}
