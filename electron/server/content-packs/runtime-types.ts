import { z } from 'zod'

import { ContentPackManifestSchema } from './schemas.js'

// model-drift-allow: Persisted Content Pack provenance discriminator, not a GenStudio catalog product ID.
export const ContentPackInstallSourceSchema = z.enum(['local-import', 'recovery', 'genstudio-store'])

const BoundedText = (max: number) => z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= max)
export const ContentPackDeliveryAttestationSchema = z.object({
  account_id: BoundedText(256),
  product_id: BoundedText(256),
  entitlement_family: BoundedText(256),
  release_id: BoundedText(256),
  pack_id: BoundedText(256),
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  archive_bytes: z.number().int().min(1).max(50 * 1024 * 1024),
  key_id: BoundedText(256),
  public_key_base64: BoundedText(512),
  receipt_canonical_json: BoundedText(1024 * 1024),
  receipt_signature: BoundedText(16 * 1024),
}).strict()

export const ContentPackInstalledVersionSchema = z.object({
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest'),
  installed_at: z.string().datetime(),
  verified_at: z.string().datetime(),
  source: ContentPackInstallSourceSchema,
  install_path: z.string().min(1).max(4096),
  manifest: ContentPackManifestSchema,
  delivery_attestation: ContentPackDeliveryAttestationSchema.optional(),
  /** Durable before an immutable directory is ever moved or deleted. */
  pending_removal: z.object({
    operation_id: z.string().uuid(),
    started_at: z.string().datetime(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.source === 'genstudio-store') !== (value.delivery_attestation !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'only GenStudio Store versions carry delivery attestation evidence' })
  }
})

export const ContentPackRuntimePackStateSchema = z.object({
  active_version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/).optional(),
  discovery_disabled: z.boolean(),
  versions: z.record(ContentPackInstalledVersionSchema),
}).strict()

const QualifiedPackIdSchema = z.string()
  .min(3)
  .max(160)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)

/** Persisted machine-local state. Keep this strict: unfamiliar state is never trusted. */
export const ContentPackRuntimeStateSchema = z.object({
  schema_version: z.literal(1),
  packs: z.record(QualifiedPackIdSchema, ContentPackRuntimePackStateSchema),
}).strict()

export const ContentPackVersionRefSchema = z.object({
  pack_id: QualifiedPackIdSchema,
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const ContentPackProvenanceSchema = ContentPackVersionRefSchema.extend({
  item_ids: z.array(z.string().min(3).max(200)).min(1).max(1000),
}).strict()

export type ContentPackInstalledVersion = z.infer<typeof ContentPackInstalledVersionSchema>
export type ContentPackDeliveryAttestation = z.infer<typeof ContentPackDeliveryAttestationSchema>
export type ContentPackRuntimeState = z.infer<typeof ContentPackRuntimeStateSchema>
export type ContentPackVersionRef = z.infer<typeof ContentPackVersionRefSchema>
export type ContentPackProvenance = z.infer<typeof ContentPackProvenanceSchema>

export interface ContentPackInstallRequest {
  archiveBytes: Uint8Array
  source: z.infer<typeof ContentPackInstallSourceSchema>
  expectedArchiveSha256?: string
  /** Remote delivery identity; checked against the signed manifest before any activation. */
  expectedPackId?: string
  expectedVersion?: string
  /** Required only for a Store archive; never supplied by sideload or recovery. */
  deliveryAttestation?: ContentPackDeliveryAttestation
}

export interface ContentPackInstallResult {
  pack_id: string
  version: string
  archive_sha256: string
  activated: boolean
  retained_versions: string[]
}

export function emptyContentPackState(): ContentPackRuntimeState {
  return { schema_version: 1, packs: {} }
}
