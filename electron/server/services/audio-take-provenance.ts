/**
 * Who made this narration take (owner, 2026-10-26 — after a Khmer take came
 * back as gibberish, the question "which engine and voice produced THIS take?"
 * had no answer on the Audio page).
 *
 * WHAT IS SHOWN IS ONLY WHAT WAS RECORDED. Three durable places can answer:
 *
 *   1. the audio folder's `.task-manifest.json` — per PART, written before each
 *      provider submission, now carrying the TTS facts (`tts` below);
 *   2. `audio_quality.json` — per chapter, written when that take became the
 *      active audio; the only per-take record that names the VOICE for older
 *      episodes;
 *   3. `audio_tts_model.json` — the episode's own record of the model its
 *      active audio was made with.
 *
 * Nothing is inferred from a filename, a voice id's shape, or another take's
 * facts (AGENTS.md §2). A take with no record reports `recorded: false` and the
 * page says so; two sources that disagree drop the contested field rather than
 * picking a winner. The episode-level record is used only for the take that is
 * actually active, because that is the only take it describes (AGENTS.md §4:
 * ownership is a fact to look up).
 */

import type { TtsProvenanceFacts } from '../contracts/tts-provenance.js'
import { readAudioTtsModelRecord } from './audio-tts-model-record.js'
import { readAudioQualityProvenance } from './audio-quality-store.js'
import { readManifest } from './task-manifest.js'

/**
 * The recorded TTS facts live in a leaf contracts module (no imports) so this
 * service, the task manifest and the quality store can share the shape without
 * an import cycle (which made TypeScript degrade unrelated types — see that
 * file). Re-exported here because this is where readers expect it.
 */
export type { TtsProvenanceFacts } from '../contracts/tts-provenance.js'

/** What the Audio page shows for one take. `recorded: false` means "nothing says". */
export interface TakeProvenance extends TtsProvenanceFacts {
  recorded: boolean
  /** Which recorded files answered: `task-manifest`, `audio-quality`, `audio_tts_model`. */
  sources: string[]
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const sameFiles = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((file, index) => file === right[index])

function mergeFacts(target: TakeProvenance, source: TtsProvenanceFacts, label: string): void {
  let contributed = false
  for (const [key, value] of Object.entries(source) as Array<[keyof TtsProvenanceFacts, string | undefined]>) {
    if (!value) continue
    const current = target[key]
    if (current === undefined) {
      target[key] = value
      contributed = true
      continue
    }
    // Two sources disagree: neither is more true, so the field is not claimed.
    if (current !== value) delete target[key]
  }
  if (contributed && !target.sources.includes(label)) target.sources.push(label)
}

/**
 * The recorded facts for one take (`files` = its basenames, in playback order).
 * `active` says the take is the one `audio_chapters.json` names, which is the
 * only case where the episode-level `audio_tts_model.json` describes it.
 */
export async function takeProvenance(input: {
  episodeDir: string
  audioDir: string
  section: string
  files: string[]
  active: boolean
}): Promise<TakeProvenance> {
  const result: TakeProvenance = { recorded: false, sources: [] }
  if (!input.files.length) return result

  // 1. Per-part provider records.
  try {
    const tasks = (await readManifest(input.audioDir)).tasks
    const parts = input.files.map(file => tasks[file]).filter(Boolean)
    if (parts.length) {
      const fromManifest: TtsProvenanceFacts = {}
      const seen = new Map<keyof TtsProvenanceFacts, Set<string>>()
      for (const part of parts) {
        const tts = part!.tts ?? {}
        const modelId = text(tts.model_id) ?? text(part!.model_id)
        if (modelId) seen.set('model_id', (seen.get('model_id') ?? new Set()).add(modelId))
        for (const key of ['model_display_name', 'voice_id', 'voice_display_name', 'provider', 'voice_provider',
          'engine_id', 'engine_name', 'model_revision_id', 'model_family', 'voice_revision'] as const) {
          const value = text((tts as Record<string, unknown>)[key])
          if (value) seen.set(key, (seen.get(key) ?? new Set()).add(value))
        }
      }
      for (const [key, values] of seen) {
        // Every part must agree; a split take made under two models cannot be
        // attributed to either.
        if (values.size === 1) fromManifest[key] = [...values][0]!
      }
      mergeFacts(result, fromManifest, 'task-manifest')
    }
  } catch { /* no readable manifest — nothing recorded there */ }

  // 2. The activation record, when it describes exactly these bytes.
  try {
    const quality = await readAudioQualityProvenance(input.episodeDir)
    const key = Object.keys(quality.chapters).find(slug => slug.toLowerCase() === input.section.toLowerCase())
    const chapter = key ? quality.chapters[key] : undefined
    if (chapter?.tts && sameFiles(chapter.source_files, input.files)) {
      mergeFacts(result, chapter.tts, 'audio-quality')
    }
  } catch { /* unreadable — nothing recorded there */ }

  // 3. The episode's own model record, for the ACTIVE take only.
  if (input.active) {
    try {
      const record = await readAudioTtsModelRecord(input.episodeDir)
      if (record) {
        mergeFacts(result, {
          model_id: record.model_id,
          ...(record.model_display_name ? { model_display_name: record.model_display_name } : {}),
          ...(record.provider_name ? { provider: record.provider_name } : {}),
        }, 'audio_tts_model')
      }
    } catch { /* nothing recorded */ }
  }

  result.recorded = !!result.model_id || !!result.voice_id || !!result.engine_name || !!result.provider
  return result
}
