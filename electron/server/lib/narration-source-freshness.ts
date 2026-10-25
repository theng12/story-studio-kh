import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'

/** Sidecar marker written atomically by the scoped PUT route. */
interface TextEditMarker {
  edited_at: string
  sha256: string
}

const MARKER_EXT = '.text-edit.json'

/** Write the marker next to the chapter source, replacing any previous one. */
export async function writeTextEditMarker(
  scriptDir: string,
  code: string,
  slug: string,
  sha256: string,
): Promise<void> {
  const markerPath = path.join(scriptDir, `${code}_${slug}${MARKER_EXT}`)
  const tmpPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`
  const payload: TextEditMarker = { edited_at: new Date().toISOString(), sha256 }
  await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8')
  await fs.rename(tmpPath, markerPath)
}

/** Carry chapter-source staleness through audio derivatives without rewriting any artifact. */
export async function staleNarrationSections(
  episodeDir: string,
  code: string,
  sections: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>,
  input: { audioDir: string } | { derivedPath: string },
  /** The resolved Script folder, when the caller knows it. Falls back to the default name. */
  scriptDir?: string,
): Promise<string[]> {
  const stale: string[] = []
  if (!sections.length) return stale
  const dirs = [scriptDir, path.join(episodeDir, DEFAULT_SUBFOLDER_NAMES.script.replace('{code}', code.toUpperCase()))]
    .filter((dir): dir is string => !!dir)

  for (const section of sections) {
    if (typeof section.slug !== 'string' || !/^(?:Chapter_\d+|Introduction)$/.test(section.slug)) continue
    const stem = `${code}_${section.slug}`
    const markerRaw = (await Promise.all(dirs.map(dir =>
      fs.readFile(path.join(dir, `${stem}${MARKER_EXT}`), 'utf8').catch(() => null),
    ))).find(raw => raw !== null) ?? null
    if (!markerRaw) continue // No explicit edit — behave exactly as before 1.4.357.

    let marker: TextEditMarker
    try {
      marker = JSON.parse(markerRaw)
    } catch {
      continue // Corrupt marker is ignored; no staleness.
    }
    if (!marker.edited_at || !marker.sha256) continue

    const names = Array.isArray(section.source_files)
      ? section.source_files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file)
      : []
    if (!names.length && typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file) names.push(section.source_file)
    if (!names.length) names.push(`${stem}.mp3`)

    const inputs = 'derivedPath' in input ? [input.derivedPath] : names.map(name => path.join(input.audioDir, name))
    const inputStats = await Promise.all(inputs.map(file => fs.stat(file).catch(() => null)))
    const existing = inputStats.filter(stat => stat !== null)
    if (!existing.length) continue

    const editedAtMs = new Date(marker.edited_at).getTime()
    if (isNaN(editedAtMs)) continue
    if (existing.every(stat => stat.mtimeMs < editedAtMs)) stale.push(section.slug)
  }
  return stale
}