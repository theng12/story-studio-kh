import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { writeAtomic } from '../lib/sync-safe.js'
import { formatMetadataTxt } from './metadata-format.js'

interface MetadataCompletionManifest {
  schema_version: 1
  output_filename: string
  expected_titles: number
  expected_tags: number
  generated_at: string
}

export interface MetadataCompletionAudit {
  authoritative: boolean
  complete: boolean
  missing: string[]
}

export function metadataCompletionManifestPath(dir: string, code: string): string {
  return path.join(dir, `${code}_Metadata.completion.json`)
}

async function writeMetadataCompletionManifestUnlocked(
  dir: string,
  code: string,
  outputFilename: string,
  expectedTitles: number,
  expectedTags: number,
): Promise<void> {
  await writeJsonAtomic(metadataCompletionManifestPath(dir, code), {
    schema_version: 1,
    output_filename: outputFilename,
    expected_titles: expectedTitles,
    expected_tags: expectedTags,
    generated_at: new Date().toISOString(),
  } satisfies MetadataCompletionManifest)
}

export async function writeMetadataCompletionManifest(
  dir: string,
  code: string,
  outputFilename: string,
  expectedTitles: number,
  expectedTags: number,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const manifestPath = metadataCompletionManifestPath(dir, code)
  await withLock(manifestPath, () => writeMetadataCompletionManifestUnlocked(
    dir, code, outputFilename, expectedTitles, expectedTags,
  ))
}

interface MetadataPackageDocument {
  title: string
  description: string
  tags: string[]
  [key: string]: unknown
}

interface MetadataPackageOptions {
  dir: string
  code: string
  mode: 'new' | { overwrite: number }
  build: (context: {
    version: number
    previous: Record<string, unknown> | null
  }) => MetadataPackageDocument | Promise<MetadataPackageDocument>
  completion?: {
    expectedTitles: number
    expectedTags: number
  }
}

export interface MetadataPackageWriteResult {
  version: number
  json: string
  txt: string
}

function metadataFilenames(code: string, version: number): { json: string; txt: string } {
  const suffix = version <= 1 ? '' : `_v${version}`
  return {
    json: `${code}_Metadata${suffix}.json`,
    txt: `${code}_Metadata${suffix}.txt`,
  }
}

function nextMetadataVersion(files: string[], code: string): number {
  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escapedCode}_Metadata(?:_v(\\d+))?\\.(?:json|txt)$`)
  let maximum = 0
  for (const file of files) {
    const match = file.match(pattern)
    if (!match) continue
    maximum = Math.max(maximum, match[1] ? Number.parseInt(match[1], 10) : 1)
  }
  return maximum + 1
}

async function readPreviousMetadata(file: string): Promise<Record<string, unknown> | null> {
  let source: string
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(source)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** Allocate and publish one JSON/TXT metadata package under an episode lock. */
export async function writeMetadataPackage(options: MetadataPackageOptions): Promise<MetadataPackageWriteResult> {
  await fs.mkdir(options.dir, { recursive: true })
  const manifestPath = metadataCompletionManifestPath(options.dir, options.code)
  return withLock(manifestPath, async () => {
    const version = options.mode === 'new'
      ? nextMetadataVersion(await fs.readdir(options.dir), options.code)
      : options.mode.overwrite
    const { json, txt } = metadataFilenames(options.code, version)
    const jsonPath = path.join(options.dir, json)
    const previous = options.mode === 'new' ? null : await readPreviousMetadata(jsonPath)
    const document = {
      ...await options.build({ version, previous }),
      version,
    }

    // Publish the human-readable sidecar before the authoritative JSON. If a
    // new attempt stops between them, the orphan TXT reserves this version and
    // a later attempt cannot overwrite it.
    await writeAtomic(path.join(options.dir, txt), formatMetadataTxt(document))
    await writeJsonAtomic(jsonPath, document)
    if (options.completion) {
      await writeMetadataCompletionManifestUnlocked(
        options.dir,
        options.code,
        json,
        options.completion.expectedTitles,
        options.completion.expectedTags,
      )
    }
    return { version, json, txt }
  })
}

export async function inspectMetadataCompletion(dir: string, code: string): Promise<MetadataCompletionAudit> {
  const manifestPath = metadataCompletionManifestPath(dir, code)
  if (!existsSync(manifestPath)) return { authoritative: false, complete: false, missing: [] }
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as MetadataCompletionManifest
    const outputPath = path.join(dir, manifest.output_filename)
    const metadata = JSON.parse(await fs.readFile(outputPath, 'utf-8'))
    const titles = Array.isArray(metadata.title_options) ? metadata.title_options.filter((value: unknown) => typeof value === 'string' && value.trim()) : []
    const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((value: unknown) => typeof value === 'string' && value.trim()) : []
    const missing: string[] = []
    if (typeof metadata.description !== 'string' || !metadata.description.trim()) missing.push('description')
    for (let index = titles.length; index < manifest.expected_titles; index++) missing.push(`title option ${index + 1}`)
    for (let index = tags.length; index < manifest.expected_tags; index++) missing.push(`tag ${index + 1}`)
    return { authoritative: true, complete: missing.length === 0, missing }
  } catch {
    return { authoritative: true, complete: false, missing: ['metadata output'] }
  }
}

/**
 * Metadata folders written before completion manifests existed. A stray file
 * is not proof: done only when a saved package has a real description (JSON),
 * or a metadata/description text file has real text in it.
 */
export async function legacyMetadataPresent(dir: string, files: string[]): Promise<boolean> {
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      if (/\.json$/i.test(name) && !/\.completion\.json$/i.test(name)) {
        const data = JSON.parse(await fs.readFile(file, 'utf-8'))
        if (typeof data?.description === 'string' && data.description.trim()) return true
      } else if (/\.(txt|md)$/i.test(name) && /metadata|description/i.test(name)) {
        if ((await fs.readFile(file, 'utf-8')).trim()) return true
      }
    } catch { /* unreadable file is not output */ }
  }
  return false
}
