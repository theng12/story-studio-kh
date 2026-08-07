import fs from 'fs/promises'
import { existsSync } from 'fs'
import { findIncompleteSubtitleSections } from './subtitle-stitcher.js'
import { stitchedSrtPath } from './subtitle-correction.js'

export interface SubtitleTimelineIntegrity {
  complete: boolean
  missing_sections: string[]
}

export async function readSubtitleTimelineIntegrity(
  subtitlesDir: string,
  episodeCode: string,
): Promise<SubtitleTimelineIntegrity> {
  // Deliberately the RAW stitch, not the corrected transcript: this checks
  // that every audio section produced subtitles at all. Correction happens
  // downstream of that guarantee and cannot substitute for it.
  const stitchedPath = stitchedSrtPath(subtitlesDir, episodeCode)
  const metaPath = `${stitchedPath}.json`
  if (!existsSync(stitchedPath)) {
    return { complete: false, missing_sections: ['stitched subtitle timeline'] }
  }
  if (!existsSync(metaPath)) {
    return { complete: false, missing_sections: ['subtitle timeline verification'] }
  }

  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const missing = Array.from(new Set([
      ...findIncompleteSubtitleSections(meta?.sections),
      ...(Array.isArray(meta?.missing_sections) ? meta.missing_sections : []),
    ]))
    if (meta?.complete === false && !missing.length) missing.push('subtitle timeline verification')
    return { complete: missing.length === 0, missing_sections: missing }
  } catch {
    return { complete: false, missing_sections: ['subtitle timeline verification'] }
  }
}

export async function assertSubtitleTimelineComplete(
  subtitlesDir: string,
  episodeCode: string,
): Promise<void> {
  const integrity = await readSubtitleTimelineIntegrity(subtitlesDir, episodeCode)
  if (integrity.complete) return
  throw new Error(
    `Subtitle timeline is incomplete: ${integrity.missing_sections.join(', ')}. `
    + 'Complete transcription and stitch subtitles again before generating scene images.',
  )
}
