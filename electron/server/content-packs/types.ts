import type { z } from 'zod'
import type {
  ContentPackBundleSchema,
  ContentPackDocumentSchema,
  ContentPackItemKindSchema,
  ContentPackManifestSchema,
} from './schemas.js'

/** Types are derived from the runtime schemas; do not duplicate them by hand. */
export type ContentPackItemKind = z.infer<typeof ContentPackItemKindSchema>
export type ContentPackManifest = z.infer<typeof ContentPackManifestSchema>
export type ContentPackDocument = z.infer<typeof ContentPackDocumentSchema>
export type ContentPackBundle = z.infer<typeof ContentPackBundleSchema>
