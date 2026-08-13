import { createPublicKey } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import type { ContentPackVerificationPolicy } from './archive.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
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

export interface ContentPackKeyringPathOptions {
  packaged?: boolean
  resourcesPath?: string
  sourceContentPackRoot?: string
}

function isPackagedApp(): boolean {
  if (!process.resourcesPath || process.env.ELECTRON_RUN_AS_NODE) return false
  try {
    const { app } = require('electron')
    return app?.isPackaged === true
  } catch {
    return false
  }
}

function canonicalEd25519PublicKeyPem(publicKeyPem: string): string {
  if (/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(publicKeyPem)) {
    throw new Error('Content Pack publisher key must not contain private key material')
  }
  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey(publicKeyPem)
  } catch (error) {
    throw new Error('Content Pack publisher key must be a valid public key PEM', { cause: error })
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Content Pack publisher key must be an Ed25519 public key')
  const canonical = key.export({ type: 'spki', format: 'pem' }).toString()
  if (publicKeyPem.replace(/\r\n/g, '\n') !== canonical) {
    throw new Error('Content Pack publisher key must be canonical PEM without trailing material')
  }
  return canonical
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
    if (!parsed.key_id.startsWith(`${parsed.publisher_id}.`)) {
      throw new Error('Content Pack publisher key ID must be within the publisher namespace')
    }
    if (publisherKeys.has(parsed.key_id)) throw new Error(`duplicate Content Pack publisher key ID: ${parsed.key_id}`)
    publisherKeys.set(parsed.key_id, { publisherId: parsed.publisher_id, publicKeyPem: canonicalEd25519PublicKeyPem(parsed.public_key_pem) })
  }
  return { publisherKeys }
}

/** Resolve the immutable resource path without accepting renderer or network input. */
export function resolveFirstPartyContentPackKeyringPath(options: ContentPackKeyringPathOptions = {}): string {
  const packaged = options.packaged ?? isPackagedApp()
  const sourceContentPackRoot = options.sourceContentPackRoot ?? path.join(ROOT, 'electron', 'server', 'content-packs')
  if (!packaged) return path.join(sourceContentPackRoot, 'first-party-keys.json')
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath) throw new Error('packaged Content Pack key resource is unavailable')
  return path.join(resourcesPath, 'content-packs', 'first-party-keys.json')
}

export function firstPartyContentPackKeyringPath(): string {
  return resolveFirstPartyContentPackKeyringPath()
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
