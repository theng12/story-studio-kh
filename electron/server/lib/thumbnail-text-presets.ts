/**
 * Built-in thumbnail-text looks.
 *
 * Shipped as a JSON resource so a new look is a data change, not a code change — the same rule the
 * font manifest follows. The styles name only things a preset is allowed to carry (AGENTS §5): a
 * reusable LOOK. The headline words and the chosen artwork are never part of a preset.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import type { ThumbnailTextPreset, ThumbnailTextStyle } from '../contracts/thumbnail-text.js'

export interface BuiltinPresetFile {
  presets: Array<{ id: string, name: string, style: ThumbnailTextStyle }>
}

/** Source layout: `electron/server/thumbnail-text/builtin-presets.json`. */
const SOURCE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../thumbnail-text/builtin-presets.json')

/**
 * The built-in presets file.
 *
 * Packaged: `Contents/Resources/thumbnail-text/builtin-presets.json` (electron-builder copies
 * `electron/server/thumbnail-text` there). In dev: the source file beside the server code, so
 * `npm run dev` and the DMG ship the same looks.
 */
export function presetsFilePath(): string {
  const override = process.env.STORY_STUDIO_RESOURCES_DIR
  if (override) {
    const packaged = path.join(override, 'thumbnail-text', 'builtin-presets.json')
    if (existsSync(packaged)) return packaged
  }
  const fromResources = process.resourcesPath
    ? path.join(process.resourcesPath, 'thumbnail-text', 'builtin-presets.json')
    : ''
  if (fromResources && existsSync(fromResources)) return fromResources
  return SOURCE_FILE
}

let cached: ThumbnailTextPreset[] | null = null
let cachedFrom: string | null = null

/**
 * Every built-in look, marked `builtin: true`.
 *
 * A malformed entry is skipped rather than shipped, because a preset the renderer cannot read would
 * fail at Apply with a confusing refusal — the customer never chose a broken look.
 */
export async function listBuiltinPresets(): Promise<ThumbnailTextPreset[]> {
  const file = presetsFilePath()
  if (cached && cachedFrom === file) return cached
  const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as BuiltinPresetFile
  const presets = (parsed.presets ?? [])
    .filter(entry => !!entry && typeof entry.id === 'string' && typeof entry.name === 'string' && !!entry.style)
    .map(entry => ({ id: entry.id, name: entry.name, builtin: true, style: entry.style }))
  cached = presets
  cachedFrom = file
  return presets
}

export function clearPresetCache(): void {
  cached = null
  cachedFrom = null
}
