import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'

export type PromptCompletionKind = 'scene' | 'thumbnail'

interface PromptCompletionManifest {
  schema_version: 1
  kind: PromptCompletionKind
  expected: number
  generated_at: string
}

export interface PromptCompletionAudit {
  authoritative: boolean
  complete: boolean
  expected: number
  present: number
  missing: number[]
}

function stem(code: string, kind: PromptCompletionKind): string {
  return `${code}_${kind === 'scene' ? 'Scene' : 'Thumbnail'}_Prompts`
}

export function promptCompletionManifestPath(dir: string, code: string, kind: PromptCompletionKind): string {
  return path.join(dir, `${stem(code, kind)}.completion.json`)
}

export async function writePromptCompletionManifest(
  dir: string,
  code: string,
  kind: PromptCompletionKind,
  expected: number,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(promptCompletionManifestPath(dir, code, kind), {
    schema_version: 1,
    kind,
    expected,
    generated_at: new Date().toISOString(),
  } satisfies PromptCompletionManifest)
}

function uniqueValidNumbers(items: Array<{ number: number; prompt: string }>, expected: number): Set<number> {
  return new Set(items
    .filter(item => Number.isInteger(item.number) && item.number >= 1 && item.number <= expected && item.prompt?.trim())
    .map(item => item.number))
}

/**
 * New prompt runs write an expected-count manifest. When present, completion
 * is re-derived from the actual prompt document so stale or partial files can
 * never be promoted by the Production Board. Legacy documents return
 * `authoritative: false` and retain compatibility until regenerated.
 */
export async function inspectPromptCompletion(
  dir: string,
  code: string,
  kind: PromptCompletionKind,
): Promise<PromptCompletionAudit> {
  const manifestPath = promptCompletionManifestPath(dir, code, kind)
  if (!existsSync(manifestPath)) {
    return { authoritative: false, complete: false, expected: 0, present: 0, missing: [] }
  }
  let manifest: PromptCompletionManifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
  } catch {
    return { authoritative: true, complete: false, expected: 0, present: 0, missing: [] }
  }
  const expected = Number.isInteger(manifest.expected) && manifest.expected > 0 ? manifest.expected : 0
  const candidates = [`${stem(code, kind)}.md`, `${stem(code, kind)}.docx`]
  const promptPath = candidates.map(name => path.join(dir, name)).find(existsSync)
  if (!expected || !promptPath) {
    return { authoritative: true, complete: false, expected, present: 0, missing: Array.from({ length: expected }, (_, i) => i + 1) }
  }
  try {
    const parsed = await parseImagePromptsDocx(promptPath)
    const items = kind === 'scene' ? parsed.scenes : parsed.thumbnails
    const presentNumbers = uniqueValidNumbers(items, expected)
    const missing = Array.from({ length: expected }, (_, i) => i + 1).filter(number => !presentNumbers.has(number))
    return { authoritative: true, complete: missing.length === 0, expected, present: presentNumbers.size, missing }
  } catch {
    return { authoritative: true, complete: false, expected, present: 0, missing: Array.from({ length: expected }, (_, i) => i + 1) }
  }
}

/**
 * Prompt folders written before completion manifests existed. A stray file is
 * not proof: done only when a prompt document in the folder really holds at
 * least one prompt of this kind.
 */
export async function legacyPromptsPresent(dir: string, files: string[], kind: PromptCompletionKind): Promise<boolean> {
  for (const name of files) {
    if (!/\.(md|docx)$/i.test(name)) continue
    try {
      const parsed = await parseImagePromptsDocx(path.join(dir, name))
      const items = kind === 'scene' ? parsed.scenes : parsed.thumbnails
      if (items.some(item => item.prompt?.trim())) return true
    } catch { /* unreadable document is not output */ }
  }
  return false
}
