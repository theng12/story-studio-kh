import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { writeJsonAtomic } from '../lib/atomic-store.js'

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

export async function writeMetadataCompletionManifest(
  dir: string,
  code: string,
  outputFilename: string,
  expectedTitles: number,
  expectedTags: number,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(metadataCompletionManifestPath(dir, code), {
    schema_version: 1,
    output_filename: outputFilename,
    expected_titles: expectedTitles,
    expected_tags: expectedTags,
    generated_at: new Date().toISOString(),
  } satisfies MetadataCompletionManifest)
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
