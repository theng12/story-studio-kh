import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import type { ContentPackVerificationPolicy } from './archive.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const QualifiedIdSchema = z.string()
  .min(3)
  .max(160)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)

const KeyEntrySchema = z.object({
  key_id: QualifiedIdSchema,
  publisher_id: QualifiedIdSchema,
  public_key_pem: z.string().min(1).max(8192).regex(/-----BEGIN PUBLIC KEY-----/, 'must be a PEM public key'),
}).strict()
const KeyringResourceSchema = z.object({
  schema_version: z.literal(1),
  keys: z.array(KeyEntrySchema).min(1).max(100),
}).strict()

export interface ContentPackKeyringEntry {
  keyId: string
  publisherId: string
  publicKeyPem: string
}

/**
 * The only constructor tests may use. It deliberately accepts public material
 * only, and never serialises or stores it anywhere.
 */
export function createContentPackKeyring(entries: readonly ContentPackKeyringEntry[]): ContentPackVerificationPolicy {
  const publisherKeys = new Map<string, { publisherId: string; publicKeyPem: string }>()
  for (const entry of entries) {
    const parsed = KeyEntrySchema.parse({
      key_id: entry.keyId,
      publisher_id: entry.publisherId,
      public_key_pem: entry.publicKeyPem,
    })
    if (publisherKeys.has(parsed.key_id)) throw new Error(`duplicate Content Pack publisher key ID: ${parsed.key_id}`)
    publisherKeys.set(parsed.key_id, { publisherId: parsed.publisher_id, publicKeyPem: parsed.public_key_pem })
  }
  return { publisherKeys }
}

/** Resolve the immutable resource path without accepting renderer or network input. */
export function firstPartyContentPackKeyringPath(): string {
  if (process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE) {
    return path.join(process.resourcesPath, 'content-packs', 'first-party-keys.json')
  }
  return path.join(ROOT, 'electron', 'server', 'content-packs', 'first-party-keys.json')
}

/** Read the packaged first-party public-key resource. Missing or malformed keys fail closed. */
export async function getFirstPartyContentPackVerificationPolicy(): Promise<ContentPackVerificationPolicy> {
  const resourcePath = firstPartyContentPackKeyringPath()
  let raw: string
  try {
    raw = await fs.readFile(resourcePath, 'utf8')
  } catch (error) {
    throw new Error(`Content Pack first-party key resource is unavailable: ${resourcePath}`, { cause: error })
  }
  let parsed: z.infer<typeof KeyringResourceSchema>
  try {
    parsed = KeyringResourceSchema.parse(JSON.parse(raw))
  } catch (error) {
    throw new Error(`Content Pack first-party key resource is invalid: ${resourcePath}`, { cause: error })
  }
  return createContentPackKeyring(parsed.keys.map(key => ({
    keyId: key.key_id,
    publisherId: key.publisher_id,
    publicKeyPem: key.public_key_pem,
  })))
}
