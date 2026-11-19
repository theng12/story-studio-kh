/**
 * Publications made outside Story — the project's own file, import, and review.
 *
 * A channel that also publishes elsewhere needs those releases to be
 * visible and counted. This module owns exactly three things:
 *
 *   1. `<channel>/external_publications.json` — version 1, written atomically under the file's own
 *      lock. An absent file is an EMPTY list, never an error and never a guess.
 *   2. Import from ONE browser-picked `.csv` or `.json` file. Rows are validated by
 *      `contracts/external-publications.ts`; any refused row writes NOTHING and the caller shows the
 *      row numbers and reasons. Import never verifies a row.
 *   3. A human review action: `verified` or `dismissed`, with who did it and when. Only `verified`
 *      rows with a real date ever count toward coverage.
 *
 * Nothing here talks to YouTube, and nothing here deletes a row.
 */
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  externalCoverage,
  parseExternalPublishedAt,
  validateExternalImport,
  type ExternalImportRefusal,
  type ExternalPublication,
} from '../contracts/external-publications.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import * as pm from './project-manager.js'

export const EXTERNAL_PUBLICATIONS_FILENAME = 'external_publications.json'

export class ExternalPublicationRefusal extends Error {
  readonly statusCode = 400
  readonly expose = true
}

interface StoreFile { version: 1; entries: ExternalPublication[] }

export function externalPublicationsPath(slug: string): string | null {
  const dir = pm.getProjectDir(slug)
  return dir ? path.join(dir, EXTERNAL_PUBLICATIONS_FILENAME) : null
}

export interface ExternalPublicationsRead {
  /** `absent` is an empty list by design; `unreadable` is NOT: coverage says unknown, never zero. */
  status: 'absent' | 'ok' | 'unreadable'
  entries: ExternalPublication[]
  error?: string
}

/** The project's list. A read never creates the file. */
export async function readExternalPublications(slug: string): Promise<ExternalPublicationsRead> {
  const file = externalPublicationsPath(slug)
  if (!file) return { status: 'unreadable', entries: [], error: 'Project not found' }
  if (!existsSync(file)) return { status: 'absent', entries: [] }
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<StoreFile>
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      return { status: 'unreadable', entries: [], error: 'external_publications.json is not in the shape Story Studio writes.' }
    }
    const entries = parsed.entries.filter((entry): entry is ExternalPublication =>
      !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.title === 'string')
    return { status: 'ok', entries }
  } catch (error: any) {
    return { status: 'unreadable', entries: [], error: error?.message || 'external_publications.json could not be read.' }
  }
}

// ── import ─────────────────────────────────────────────────────────────────

/** A quoted, comma-separated CSV — the shape a spreadsheet exports. `""` escapes a quote. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const nonEmpty = rows.filter(cells => cells.some(cell => cell.trim()))
  if (!nonEmpty.length) return []
  const header = nonEmpty[0]!.map(cell => cell.trim().toLowerCase())
  return nonEmpty.slice(1).map(cells => {
    const out: Record<string, string> = {}
    header.forEach((name, index) => { if (name) out[name] = (cells[index] ?? '').trim() })
    return out
  })
}

/**
 * Read the picked file's rows. Only a REGULAR `.csv` or `.json` file is accepted — the path comes
 * from the app's own picker, and this check is what keeps a typed path or a directory out.
 */
export async function readPickedRows(pickedPath: string): Promise<unknown[]> {
  if (typeof pickedPath !== 'string' || !pickedPath.trim()) {
    throw new ExternalPublicationRefusal('Choose a CSV or JSON file to import.')
  }
  const extension = path.extname(pickedPath).toLowerCase()
  if (extension !== '.csv' && extension !== '.json') {
    throw new ExternalPublicationRefusal(`That file is "${extension || 'not a file with an extension'}". Import accepts a .csv or .json file.`)
  }
  const stat = await fs.stat(pickedPath).catch(() => null)
  if (!stat?.isFile()) {
    throw new ExternalPublicationRefusal('That file could not be read. It may have been moved or renamed — choose it again.')
  }
  const text = await fs.readFile(pickedPath, 'utf8')
  if (!text.trim()) return []
  if (extension === '.json') {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      throw new ExternalPublicationRefusal('That JSON file is not valid JSON, so nothing was imported.')
    }
    if (Array.isArray(parsed)) return parsed
    const rows = (parsed as { entries?: unknown; rows?: unknown } | null)?.entries
      ?? (parsed as { rows?: unknown } | null)?.rows
    if (Array.isArray(rows)) return rows
    throw new ExternalPublicationRefusal('That JSON file must be a list of releases, or an object with an "entries" list.')
  }
  return parseCsv(text)
}

export interface ExternalImportResult {
  imported: number
  refusals: ExternalImportRefusal[]
  entries: ExternalPublication[]
}

/**
 * Import the picked file into the project's list.
 *
 * Everything is validated before ONE atomic write, so a refused row leaves the list exactly as it
 * was. Imported rows arrive `unlinked`; `verified` is only ever a human's review action.
 */
export async function importExternalPublications(slug: string, pickedPath: string): Promise<ExternalImportResult> {
  const file = externalPublicationsPath(slug)
  if (!file) throw new ExternalPublicationRefusal('Project not found.')
  const rows = await readPickedRows(pickedPath)
  if (!rows.length) {
    throw new ExternalPublicationRefusal('That file has no release rows in it, so nothing was imported.')
  }
  const current = await readExternalPublications(slug)
  if (current.status === 'unreadable') {
    throw new ExternalPublicationRefusal(
      `This channel's ${EXTERNAL_PUBLICATIONS_FILENAME} could not be read (${current.error}), so nothing was imported. `
      + 'Repair or move that file, then import again.',
    )
  }
  const result = validateExternalImport(rows, current.entries)
  if (result.refusals.length) {
    return { imported: 0, refusals: result.refusals, entries: current.entries }
  }
  const next: StoreFile = { version: 1, entries: [...current.entries, ...result.entries] }
  await withLock(file, async () => {
    await writeJsonAtomic(file, next)
  })
  return { imported: result.entries.length, refusals: [], entries: next.entries }
}

// ── review ─────────────────────────────────────────────────────────────────

/** The local days that already carry this channel's own coverage, for the double-count guard. */
async function localCoverageDays(slug: string): Promise<Set<string>> {
  const { readItemSchedule } = await import('./upload-plans.js')
  const schedule = await readItemSchedule(slug).catch(() => ({} as Record<string, string>))
  const days = new Set<string>()
  for (const iso of Object.values(schedule)) {
    if (!iso) continue
    days.add(iso.slice(0, 10))
  }
  return days
}

/**
 * Verify or dismiss one imported row. `verified` is a human review action with the reviewer's name.
 *
 * Verifying is refused when the row would be a SECOND coverage mark for something this channel
 * already covers: the same episode code, the same video, or the same local day already covered by
 * this channel's own schedule. Dismissing is always allowed.
 */
export async function setExternalPublicationState(
  slug: string,
  id: string,
  state: 'verified' | 'dismissed',
  reviewer: string,
): Promise<ExternalPublication> {
  const file = externalPublicationsPath(slug)
  if (!file) throw new ExternalPublicationRefusal('Project not found.')
  if (state !== 'verified' && state !== 'dismissed') {
    throw new ExternalPublicationRefusal('An entry is either verified or dismissed.')
  }
  const read = await readExternalPublications(slug)
  if (read.status === 'unreadable') throw new ExternalPublicationRefusal(`This channel's list could not be read (${read.error}).`)
  const index = read.entries.findIndex(entry => entry.id === id)
  if (index < 0) throw new ExternalPublicationRefusal('That release is not in this channel’s list. Reload the page and try again.')
  if (state === 'verified') {
    const entry = read.entries[index]!
    if (!parseExternalPublishedAt(entry.published_at)) {
      throw new ExternalPublicationRefusal(`"${entry.title}" has no real date ("${entry.published_at}"), so it cannot count as coverage. Fix it and import again.`)
    }
    const localDays = await localCoverageDays(slug)
    const day = entry.published_at.slice(0, 10)
    const alreadyVerified = read.entries.find(other => other.id !== entry.id && other.state === 'verified'
      && (other.published_at.slice(0, 10) === day
        || (!!entry.episode_code && other.episode_code === entry.episode_code)
        || (!!entry.video_id && other.video_id === entry.video_id)))
    if (alreadyVerified) {
      throw new ExternalPublicationRefusal(
        `"${alreadyVerified.title}" is already verified for ${entry.episode_code || entry.video_id || day}, so this one cannot be a second coverage mark. `
        + 'Dismiss it if it is a duplicate.',
      )
    }
    if (localDays.has(day)) {
      throw new ExternalPublicationRefusal(
        `${day} is already covered by this channel's own schedule in Story Studio, so this release would count the day twice. `
        + 'Dismiss it, or change its date if it really is a different release.',
      )
    }
  }
  const current = read.entries[index]!
  const nextEntry: ExternalPublication = {
    ...current,
    state,
    verified_at: state === 'verified' ? new Date().toISOString() : null,
    verified_by: state === 'verified' ? (reviewer || 'owner') : null,
  }
  const next = read.entries.map((entry, i) => (i === index ? nextEntry : entry))
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, entries: next } satisfies StoreFile)
  })
  return nextEntry
}

/** Verified coverage for a channel, plus the local-day overlaps it refuses to double-count. */
export async function externalCoverageFor(slug: string, localDays: ReadonlySet<string>): Promise<{
  status: ExternalPublicationsRead['status']
  error?: string
  entries: ExternalPublication[]
  verified: number
  days: string[]
  overlappingLocal: string[]
}> {
  const read = await readExternalPublications(slug)
  const coverage = externalCoverage(read.entries, localDays)
  return {
    status: read.status,
    ...(read.error ? { error: read.error } : {}),
    entries: read.entries,
    ...coverage,
  }
}
