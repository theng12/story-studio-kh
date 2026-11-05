/**
 * The AI disclosure an episode can truthfully carry.
 *
 * Names only the processes the episode's OWN records prove (see the callers in
 * generators/metadata.ts). It never claims human review: Story Studio cannot
 * prove a person reviewed anything. An empty result means "no proven AI step",
 * and the caller leaves the section out rather than fall back to a guess.
 */

import fs from 'fs/promises'
import path from 'path'
import { readManifestStrict } from '../services/task-manifest.js'

// Submission records alone do not prove that an output was produced.
export async function hasCompletedAiMedia(dir: string | null, operation: 'tts' | 'image', activeFiles?: string[]): Promise<boolean> {
  if (!dir) return false
  let manifest
  try {
    manifest = await readManifestStrict(dir)
  } catch (error: any) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  for (const [file, task] of Object.entries(manifest.tasks)) {
    if (path.basename(file) !== file || task.operation !== operation || task.last_state !== 'succeeded') continue
    if (activeFiles && !activeFiles.includes(file)) continue
    try {
      const stat = await fs.stat(path.join(dir, file))
      if (stat.isFile() && stat.size > 0) return true
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return false
}

/** The sentence older presets and the built-in default carried. Never emitted now. */
export const LEGACY_NEUTRAL_AI_DISCLOSURE = 'Created with the help of AI tools and reviewed before publishing.'

export interface EpisodeAiProcesses {
  /** An active narration file has a succeeded TTS task record. */
  narration_voiced_by_ai: boolean
  /** A usable image file has a succeeded image task record. */
  images_generated_by_ai: boolean
}

const SENTENCES: Record<'en' | 'km', { voice: string; images: string }> = {
  en: {
    voice: 'The narration voice was generated with AI.',
    images: 'The images were generated with AI tools.',
  },
  km: {
    voice: 'សំឡេងអានរឿងត្រូវបានបង្កើតដោយ AI។',
    images: 'រូបភាពត្រូវបានបង្កើតដោយឧបករណ៍ AI។',
  },
}

/** Disclosure text for the channel language. English for any language without wording. */
export function aiDisclosureText(processes: EpisodeAiProcesses, language: string): string {
  const s = SENTENCES[language === 'km' ? 'km' : 'en']
  return [
    processes.narration_voiced_by_ai ? s.voice : '',
    processes.images_generated_by_ai ? s.images : '',
  ].filter(Boolean).join(' ')
}
