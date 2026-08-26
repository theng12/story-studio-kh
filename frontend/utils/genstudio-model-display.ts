import { genStudioProductAliases } from '../../electron/server/contracts/genstudio-product-identity'

export type GenStudioModelKind = 'chat' | 'image' | 'video' | 'transcription' | 'tts'

export interface GenStudioDisplayCatalogEntry {
  id: string
  display_name: string
  /** Owner-defined public handle, e.g. `gpt-image-2`. */
  customer_handle?: string | null
  public_model_id?: string | null
  legacy_ids?: string[]
}

export interface GenStudioDisplayCatalogs {
  chat?: GenStudioDisplayCatalogEntry[]
  image?: GenStudioDisplayCatalogEntry[]
  video?: GenStudioDisplayCatalogEntry[]
  transcription?: GenStudioDisplayCatalogEntry[]
  tts?: GenStudioDisplayCatalogEntry[]
}

const PREFIX_BY_KIND: Record<GenStudioModelKind, string> = {
  chat: 'genstudio-chat:',
  image: 'genstudio-image:',
  video: 'genstudio-video:',
  transcription: 'genstudio-transcription:',
  tts: 'genstudio-tts:',
}

/**
 * Recognises the gateway suffix Story Studio used to append to every model
 * name (`Claude Fable 5 [GenStudio KH]`, and the older `[GenStudio]`).
 *
 * The suffix is no longer ADDED anywhere: every product in this app comes
 * through the one gateway, so repeating its name on each row said nothing and
 * pushed the actual model name out of the row. The MATCH survives because
 * branded names outlived the code that wrote them — `useGenStudioModelDisplay`
 * persists its label map to localStorage, so a name saved by an older release
 * is still read back on the next launch and has to be healed rather than shown.
 */
const GATEWAY_SUFFIX = /\s*\[\s*GenStudio(?:\s+KH)?\s*\]\s*$/i

/** The catalogue's own name for a model, with any legacy gateway suffix removed. */
export function plainGenStudioModelName(displayName: string): string {
  return displayName.trim().replace(GATEWAY_SUFFIX, '').trim()
}

export function buildGenStudioModelLabelEntries(
  catalogs: GenStudioDisplayCatalogs,
): Array<[string, string]> {
  const labels = new Map<string, string>()
  for (const kind of Object.keys(PREFIX_BY_KIND) as GenStudioModelKind[]) {
    const prefix = PREFIX_BY_KIND[kind]
    for (const model of catalogs[kind] || []) {
      const label = plainGenStudioModelName(model.display_name)
      if (!model.id?.trim() || !label) continue
      // Every identifier the product answers to gets the same label, so a job
      // row still reads "GPT Image 2" when its saved model is the old raw id.
      const ids = genStudioProductAliases(model)
      for (const rawId of ids) {
        const id = rawId?.trim()
        if (!id) continue
        labels.set(id, label)
        labels.set(`${prefix}${id}`, label)
      }
    }
  }
  return [...labels.entries()]
}

export function isGenStudioModelId(modelId: unknown): boolean {
  return typeof modelId === 'string' && /^genstudio(?:-|:)/i.test(modelId.trim())
}
