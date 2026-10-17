import fs from 'fs/promises'
import path from 'path'
import { sniffImageMediaType } from './genstudio-client.js'

/**
 * The media types a preview or an upload may name, by file extension.
 *
 * Only a fallback: the bytes decide the type whenever they state one (see
 * `imageMediaTypeForBytes`). GIF is here because the canonical byte sniffer does
 * not know it; every other entry matches `sniffImageMediaType`.
 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The type a file's NAME claims, or '' for an extension that is not an image. */
export function imageMediaTypeForFilename(filename: string): string {
  return IMAGE_MEDIA_TYPES[path.extname(filename).toLowerCase()] ?? ''
}

/**
 * The type the BYTES are, falling back to the name only when they state nothing
 * this app recognises (GIF).
 *
 * Scene images are legitimately JPEG bytes under `{scene_id}.png`: the gateway
 * relays the provider's own format (an older node ignores `output_format`), and
 * the owner's "smaller files" choice re-encodes PNG to JPEG in place under the
 * same name. `stillDecoderArgs` and `videoSourceMediaType` already read the
 * bytes for exactly this reason. A reader that trusts the name instead serves
 * `image/png` for JPEG bytes and declares the wrong type to a model — the
 * production report of 2026-10-17, where scene images named `.png` began
 * `ff d8 ff e0`.
 *
 * Nothing is rewritten, renamed or migrated here: the truth is reported where
 * the app speaks about the format.
 */
export function imageMediaTypeForBytes(bytes: Uint8Array, filename: string): string {
  const sniffed = bytes.length >= 12 ? sniffImageMediaType(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) : null
  return sniffed ?? imageMediaTypeForFilename(filename)
}

/** `imageMediaTypeForBytes` for a path: reads the header only, never the whole file. */
export async function imageMediaTypeForFile(filePath: string): Promise<string> {
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const header = Buffer.alloc(24)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (bytesRead >= 12) {
        const sniffed = sniffImageMediaType(header.subarray(0, bytesRead))
        if (sniffed) return sniffed
      }
    } finally {
      await handle.close().catch(() => {})
    }
  } catch { /* unreadable now is the caller's own refusal to make */ }
  return imageMediaTypeForFilename(filePath)
}
