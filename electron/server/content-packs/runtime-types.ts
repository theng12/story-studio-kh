import { z } from 'zod'

import { ContentPackManifestSchema } from './schemas.js'

export const ContentPackInstallSourceSchema = z.enum(['local-import', 'recovery'])

export const ContentPackInstalledVersionSchema = z.object({
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest'),
  installed_at: z.string().datetime(),
  verified_at: z.string().datetime(),
  source: ContentPackInstallSourceSchema,
  install_path: z.string().min(1).max(4096),
  manifest: ContentPackManifestSchema,
}).strict()

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

export type ContentPackInstalledVersion = z.infer<typeof ContentPackInstalledVersionSchema>
export type ContentPackRuntimeState = z.infer<typeof ContentPackRuntimeStateSchema>
export type ContentPackVersionRef = z.infer<typeof ContentPackVersionRefSchema>

export interface ContentPackInstallRequest {
  archiveBytes: Uint8Array
  source: z.infer<typeof ContentPackInstallSourceSchema>
  expectedArchiveSha256?: string
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
