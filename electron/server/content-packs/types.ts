import type { z } from 'zod'
import type {
  ContentPackBundleSchema,
  ContentPackDocumentSchema,
  ContentPackItemKindSchema,
  ContentPackManifestSchema,
} from './schemas.js'

/** Types are derived from the runtime schemas; do not duplicate them by hand. */
export type ContentPackItemKind = z.infer<typeof ContentPackItemKindSchema>

/**
 * Kinds a customer may fork into a local editable copy.
 *
 * Visual styles were always excluded because their preview raster lives inside
 * the signed archive and a fork would have nothing to show. The v1.2.1 style
 * and effect kinds are excluded for a different reason: their editable form is
 * already the properties panel next to the picker, which writes a plain
 * document into the project. Forking them would create a second, competing way
 * to own a modified look.
 */
export type UserForkableContentPackItemKind = Exclude<
  ContentPackItemKind,
  'visual-style' | 'subtitle-style' | 'scene-effect' | 'overlay' | 'reveal'
>

export type ContentPackManifest = z.infer<typeof ContentPackManifestSchema>
export type ContentPackDocument = z.infer<typeof ContentPackDocumentSchema>
export type ContentPackBundle = z.infer<typeof ContentPackBundleSchema>
