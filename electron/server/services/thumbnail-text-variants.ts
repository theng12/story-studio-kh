/**
 * Applied thumbnail-text variants on disk.
 *
 * A variant is a NEW file beside its source artwork, plus a sidecar that records what it was made
 * from. Three rules drive the shape of this module:
 *
 * 1. **The original art is never touched.** A variant is always a new file.
 * 2. **A variant must never look like a newer model output.** The upload path sorts thumbnails by
 *    highest `_v{N}` then lexicographically, so a text variant is named `<stem>_text-<n>.png` — no
 *    `_vN` anywhere — and `versionOf` cannot make it look newer than the artwork it came from
 *    (AGENTS §8: never let a derivative pass as the thing it derives from).
 * 3. **A variant whose source changed is refused, not silently uploaded.** The sidecar records the
 *    source's SHA-256 and byte count; when either differs — or the source is gone — the variant is
 *    `stale` and the upload path refuses it with a message saying the artwork changed.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import type {
  ThumbnailTextSidecar,
  ThumbnailTextStyle,
  ThumbnailTextVariant,
} from '../contracts/thumbnail-text.js'

/** The sidecar suffix. Matched as a suffix, never with `startsWith` (AGENTS §6). */
export const TEXT_SIDECAR_SUFFIX = '.text-layer.json'

/** The infix every text variant carries, so it can never be mistaken for model artwork. */
export const TEXT_VARIANT_INFIX = '_text-'

export function sidecarPathFor(variantPath: string): string {
  return `${variantPath}${TEXT_SIDECAR_SUFFIX}`
}

/** True when a filename is one of this feature's variants (by suffix, on the sidecar). */
export function isTextVariantFile(filename: string): boolean {
  return new RegExp(`\\${TEXT_VARIANT_INFIX}\\d+\\.(png|jpe?g)$`, 'i').test(filename)
}

/**
 * The next free `<stem>_text-<n>.png` in `dir`.
 *
 * Numbered rather than versioned on purpose: the picker and the uploader sort by `_vN` first, and a
 * derivative must not be able to win that sort. `<n>` continues past whatever is already there so
 * re-applying never overwrites an earlier variant.
 */
export async function nextVariantPath(dir: string, sourceFilename: string): Promise<{ filename: string, fullPath: string }> {
  const stem = path.basename(sourceFilename).replace(/\.[^.]+$/, '')
  const existing = existsSync(dir) ? await fs.readdir(dir) : []
  const pattern = new RegExp(`^${escapeRegex(stem)}\\${TEXT_VARIANT_INFIX}(\\d+)\\.png$`, 'i')
  let highest = 0
  for (const name of existing) {
    const match = name.match(pattern)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  const filename = `${stem}${TEXT_VARIANT_INFIX}${highest + 1}.png`
  return { filename, fullPath: path.join(dir, filename) }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function sha256OfFile(file: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

/**
 * Describe the source for the sidecar: its hash and size, resolved fresh.
 *
 * A missing source is a refusal rather than a zero (AGENTS §6), so the caller learns the artwork is
 * gone instead of recording a hash for a file nobody has.
 */
export async function sourceIdentity(sourcePath: string): Promise<{ sha256: string, bytes: number }> {
  const bytes = await fs.readFile(sourcePath)
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}

export function buildSidecar(input: {
  sourceFilename: string
  sourceSha256: string
  sourceBytes: number
  text: string
  style: ThumbnailTextStyle
  fontSha256: string
  appVersion: string
}): ThumbnailTextSidecar {
  return {
    schema: 1,
    source_filename: input.sourceFilename,
    source_sha256: input.sourceSha256,
    source_bytes: input.sourceBytes,
    text: input.text,
    style: input.style,
    font_sha256: input.fontSha256,
    rendered_at: new Date().toISOString(),
    app_version: input.appVersion,
  }
}

export async function writeSidecar(variantPath: string, sidecar: ThumbnailTextSidecar): Promise<void> {
  await fs.writeFile(
    sidecarPathFor(variantPath),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    { mode: 0o644 },
  )
}

/**
 * Read a variant's sidecar.
 *
 * A missing or unreadable sidecar is reported as such, never treated as "no staleness": a variant
 * nobody can account for must not reach YouTube.
 */
export async function readSidecar(variantPath: string): Promise<
  { ok: true, sidecar: ThumbnailTextSidecar } | { ok: false, reason: string }
> {
  const file = sidecarPathFor(variantPath)
  if (!existsSync(file)) {
    return { ok: false, reason: 'its record of the artwork it was made from is missing' }
  }
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as ThumbnailTextSidecar
    if (!parsed || typeof parsed !== 'object' || typeof parsed.source_filename !== 'string' || typeof parsed.source_sha256 !== 'string') {
      return { ok: false, reason: 'its record of the artwork it was made from is unreadable' }
    }
    return { ok: true, sidecar: parsed }
  } catch {
    return { ok: false, reason: 'its record of the artwork it was made from could not be read' }
  }
}

/**
 * Is this variant still faithful to the artwork it was made from?
 *
 * Compares the recorded SHA-256 AND size against the source on disk right now. Any difference — or
 * a missing source — is stale. The comparison is by content, not by mtime, so a rebuilt file that
 * happens to be identical is correctly NOT stale.
 */
export async function variantStaleness(
  variantPath: string,
  dir: string,
): Promise<{ stale: boolean, reason: string | null }> {
  const record = await readSidecar(variantPath)
  if (!record.ok) {
    return { stale: true, reason: `This text layer cannot be used: ${record.reason}. Apply the text again.` }
  }
  const sourcePath = path.join(dir, record.sidecar.source_filename)
  if (!existsSync(sourcePath)) {
    return {
      stale: true,
      reason: `The artwork this text was applied to (${record.sidecar.source_filename}) is gone. `
        + 'Choose the artwork again and re-apply the text.',
    }
  }
  let identity: { sha256: string, bytes: number }
  try {
    identity = await sourceIdentity(sourcePath)
  } catch {
    return {
      stale: true,
      reason: `The artwork this text was applied to (${record.sidecar.source_filename}) could not be read. Re-apply the text.`,
    }
  }
  if (identity.sha256 !== record.sidecar.source_sha256 || identity.bytes !== record.sidecar.source_bytes) {
    return {
      stale: true,
      reason: `The artwork changed since this text was applied (${record.sidecar.source_filename}). `
        + 'The text is no longer part of the picture the customer sees — re-apply it to the current artwork.',
    }
  }
  return { stale: false, reason: null }
}

/** Every text variant in a thumbnail folder, with staleness resolved fresh. */
export async function listVariants(dir: string): Promise<ThumbnailTextVariant[]> {
  if (!existsSync(dir)) return []
  const entries = await fs.readdir(dir)
  const variants: ThumbnailTextVariant[] = []
  for (const filename of entries.filter(name => isTextVariantFile(name)).sort()) {
    const fullPath = path.join(dir, filename)
    const record = await readSidecar(fullPath)
    const staleness = await variantStaleness(fullPath, dir)
    variants.push({
      filename,
      source_filename: record.ok ? record.sidecar.source_filename : '',
      text: record.ok ? record.sidecar.text : '',
      stale: staleness.stale,
      stale_reason: staleness.reason,
    })
  }
  return variants
}

/**
 * Refuse an upload that would push a stale (or unaccountable) text layer.
 *
 * Called by the upload resolution path BEFORE a variant is offered or sent, so a stale text layer
 * cannot reach YouTube by being the auto-picked file (AGENTS §8).
 */
export async function assertVariantUploadable(filename: string, dir: string): Promise<string | null> {
  if (!isTextVariantFile(filename)) return null
  const fullPath = path.join(dir, filename)
  if (!existsSync(fullPath)) {
    return `Thumbnail "${filename}" is a text layer that is no longer on disk. Choose another thumbnail, or apply the text again.`
  }
  const staleness = await variantStaleness(fullPath, dir)
  return staleness.stale ? `${staleness.reason} Nothing was uploaded.` : null
}
