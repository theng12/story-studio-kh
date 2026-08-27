/**
 * Metadata formulas — the ARCHITECTURE of an episode's YouTube write-up.
 *
 * The owner's ask, verbatim: "there's no meta data formulas that we can pick
 * from. it's all build from scratch and a lot of people can't afford to spend
 * time figure that out right? so what can we do? can we have like 5 built in
 * options and then we can sell them in packs of 6 for 300 credits each".
 *
 * So: five built-in formulas ship free, and a pack adds more. A formula owns
 * the ordered sections, each section's instruction, whether the reader sees a
 * heading and exactly what it says, the target length, plus title shaping, tag
 * guidance and tone. NONE of that is prose in this file — every word the model
 * receives comes from a formula document, so the owner can change any of it by
 * editing JSON rather than waiting for a release.
 *
 * Relationship to `metadata_profile` on a series formula: that only picks which
 * of the app's thirteen built-in section TYPES appear, so it can express a
 * different SUBSET of one shape but never a different shape. It stays exactly
 * as it was and remains the default — a channel that has not picked a formula
 * generates precisely what it generated before.
 *
 * Built-ins are first-class here on the owner's explicit instruction ("5 built
 * in options"), unlike the visual style catalogue where signed packs became the
 * only source. They are laid out so that cutover would be a deletion: remove
 * `electron/server/metadata-formulas/` and the `builtIns()` branch below, and
 * pack formulas are all that remain. Nothing else would need to change.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { MetadataFormulaDocumentSchema } from '../content-packs/schemas.js'
import { BUILT_IN_METADATA_FORMULA_IDS } from '../contracts/metadata-formulas.js'
import { listCatalogEntries } from '../content-packs/registry.js'
import type { ContentPackRegistryOptions } from '../content-packs/registry.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import type { Format } from '../models/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export type MetadataFormulaDocument = Extract<ContentPackDocument, { kind: 'metadata-formula' }>

export interface MetadataFormulaEntry {
  id: string
  name: string
  description: string
  /** One line naming the shape — what the picker shows beneath the name. */
  architecture: string
  source: 'built-in' | 'pack'
  packId: string | null
  document: MetadataFormulaDocument
}

/** A section shaped for `buildDescriptionPrompt`. */
export interface MetadataFormulaSectionPlan {
  id: string
  label: string
  type: 'custom'
  enabled: true
  config: { instructions: string }
}

export interface MetadataFormulaPlan {
  formulaId: string
  sections: MetadataFormulaSectionPlan[]
  descriptionMaxChars: number
  titleMode: 'use_idea_title' | 'paraphrase'
  titleCount: number
  titleMaxLength: number
  titleGuidance: string
  tagCount: number
  tagGuidance: string
  toneConstraints: string[]
  /** What the formula wants between sections, as a prompt instruction. */
  separatorRule: string
}

// ── Built-in directory resolution ──────────────────────────────────────────
// Same three cases niche-loader handles: packaged Electron, dev under tsx, and
// the compiled-from-watcher path.

function isPackagedApp(): boolean {
  if (__dirname.includes('.asar')) return true
  if (process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE) {
    try {
      const { app } = require('electron')
      return app?.isPackaged === true
    } catch {
      return false
    }
  }
  return false
}

function findRepoFormulasDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'metadata-formulas')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinFormulasDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'metadata-formulas')
  }
  const found = findRepoFormulasDir(__dirname)
  if (found) return found
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'metadata-formulas')
}

export const BUILTIN_METADATA_FORMULAS_DIR = resolveBuiltinFormulasDir()

let builtinCache: MetadataFormulaEntry[] | null = null

/**
 * The shipped formulas, validated against the very schema a pack must satisfy.
 *
 * Validating them here is deliberate: it is what keeps a built-in and a bought
 * formula the same kind of thing, so the cutover to pack-only stays a deletion.
 * A built-in that fails validation is skipped rather than crashing the app —
 * the remaining formulas still work and the channel default falls back to the
 * pre-formula path.
 */
async function builtIns(): Promise<MetadataFormulaEntry[]> {
  if (builtinCache) return builtinCache
  const rows: MetadataFormulaEntry[] = []
  let files: string[] = []
  try {
    files = (await fs.readdir(BUILTIN_METADATA_FORMULAS_DIR)).filter(name => name.endsWith('.json')).sort()
  } catch {
    builtinCache = rows
    return rows
  }
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(BUILTIN_METADATA_FORMULAS_DIR, file), 'utf-8')
      // The document schema, minus the one refinement that exists only for
      // packs: a built-in is allowed to hold a built-in's id. Every field rule
      // a bought formula must satisfy is enforced here identically.
      const parsed = MetadataFormulaDocumentSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) continue
      rows.push(entryFor(parsed.data as MetadataFormulaDocument, 'built-in', null))
    } catch { /* a malformed built-in is skipped, never fatal */ }
  }
  // The schema refuses a pack that claims a built-in id, using the declared
  // list — so a shipped formula missing from that list would be shadowable, and
  // a listed id with no file behind it would be reserved for nothing. Neither
  // is allowed to pass silently.
  const declared = new Set<string>(BUILT_IN_METADATA_FORMULA_IDS)
  const shipped = new Set(rows.map(row => row.id))
  const drift = [
    ...[...shipped].filter(id => !declared.has(id)).map(id => `${id} is shipped but not declared`),
    ...[...declared].filter(id => !shipped.has(id)).map(id => `${id} is declared but not shipped`),
  ]
  if (drift.length && shipped.size) {
    throw new Error(`built-in metadata formulas drifted from BUILT_IN_METADATA_FORMULA_IDS: ${drift.join('; ')}`)
  }
  builtinCache = rows
  return rows
}

/** Test seam: forget the cached built-ins so a fixture directory can be read. */
export function resetMetadataFormulaCache(): void {
  builtinCache = null
}

function entryFor(
  document: MetadataFormulaDocument,
  source: 'built-in' | 'pack',
  packId: string | null,
): MetadataFormulaEntry {
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    architecture: document.architecture,
    source,
    packId,
    document,
  }
}

/**
 * Built-ins first, then pack formulas. A pack may not take an id already in
 * use: the schema refuses a pack claiming a BUILT-IN's id at authoring time,
 * and this refuses any remaining collision again at read time — so neither a
 * pack authored against an older build nor two packs claiming the same id can
 * have the winner decided by discovery order.
 */
export async function metadataFormulaCatalogue(
  options: ContentPackRegistryOptions = {},
): Promise<MetadataFormulaEntry[]> {
  const rows = [...await builtIns()]
  const taken = new Set(rows.map(row => row.id))
  // A pack store that cannot be read must never take metadata generation down
  // with it. Signature verification reaches the OS keychain, which is exactly
  // the kind of thing that fails on a machine mid-recovery — and the five
  // built-ins are enough to keep the Finalizer working while it does.
  let installed: Awaited<ReturnType<typeof listCatalogEntries>> = []
  try {
    installed = await listCatalogEntries('metadata-formula', options)
  } catch { /* built-ins only */ }
  for (const entry of installed) {
    const document = entry.value
    if (document.kind !== 'metadata-formula' || taken.has(document.id)) continue
    taken.add(document.id)
    rows.push(entryFor(document, 'pack', entry.pack?.pack_id ?? null))
  }
  return rows
}

/** One formula by id, from either source. Null for an unknown id — the caller
 *  decides what that means rather than being handed the wrong architecture. */
export async function getMetadataFormula(
  id: string,
  options: ContentPackRegistryOptions = {},
): Promise<MetadataFormulaEntry | null> {
  if (!id) return null
  return (await metadataFormulaCatalogue(options)).find(row => row.id === id) ?? null
}

/**
 * Which formula applies to this run.
 *
 * Override semantics mirror the channel title prefix/suffix rule in
 * routes/ideas.ts: an explicit request field wins even when empty — an empty
 * string means "no formula for this episode even though the channel has one" —
 * and `undefined` falls back to the channel's saved default. When neither names
 * a formula the answer is null and the caller keeps its pre-formula behaviour,
 * which is what makes this change invisible to every existing channel.
 */
export async function resolveActiveMetadataFormula(input: {
  requestedId?: unknown
  config?: { metadata_formula_id?: unknown } | null
  options?: ContentPackRegistryOptions
}): Promise<MetadataFormulaEntry | null> {
  const { requestedId, config, options = {} } = input
  let id: string | null = null
  if (typeof requestedId === 'string') {
    id = requestedId.trim()
  } else if (typeof config?.metadata_formula_id === 'string') {
    id = config.metadata_formula_id.trim()
  }
  if (!id) return null
  return getMetadataFormula(id, options)
}

function humanize(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, ch => ch.toUpperCase())
}

/**
 * Turn a formula into the section plan the description prompt consumes.
 *
 * This is the seam the generator calls. The header decision becomes an explicit
 * directive in the section's own instruction — a section that renders a heading
 * is told the exact line to print, and a section that does not is told in as
 * many words that its name is an internal key and must never appear in the
 * description. Section ids and labels are instructions to the model, never
 * viewer-facing text, and the directive says so at every single section rather
 * than relying on one global rule the model may drop.
 */
export function metadataFormulaPlan(entry: MetadataFormulaEntry): MetadataFormulaPlan {
  const doc = entry.document
  const sections = doc.description_plan.sections.map(section => {
    const parts = [section.instruction.trim()]
    if (section.header.render && section.header.text) {
      parts.push(`Begin this section with this exact line, alone on its line: ${JSON.stringify(section.header.text)}. Then write the body beneath it.`)
    } else {
      parts.push('Do not print any heading, label, or section name for this section. Output its body text only — the name of this section is an internal instruction key and must never appear in the description.')
    }
    if (section.target_chars) {
      parts.push(`Aim for roughly ${section.target_chars} characters.`)
    }
    return {
      id: `metadata-formula:${section.id}`,
      label: humanize(section.id),
      type: 'custom' as const,
      enabled: true as const,
      config: { instructions: parts.join(' ') },
    }
  })
  return {
    formulaId: doc.id,
    sections,
    descriptionMaxChars: doc.description_plan.max_chars,
    titleMode: doc.title_plan.mode,
    titleCount: doc.title_plan.count,
    titleMaxLength: doc.title_plan.max_length,
    titleGuidance: doc.title_plan.guidance,
    tagCount: doc.tag_plan.count,
    tagGuidance: doc.tag_plan.guidance,
    toneConstraints: [...doc.tone.constraints],
    separatorRule: separatorRuleFor(doc.description_plan.separator),
  }
}

/** The owner picks what goes between sections; this states his choice as a rule. */
function separatorRuleFor(separator: 'rule' | 'blank-line' | 'none'): string {
  if (separator === 'rule') return 'Separate major sections with a horizontal rule line.'
  if (separator === 'blank-line') return 'Separate sections with a single blank line. Do not use rule or separator characters anywhere.'
  return 'Do not use separator lines, rule characters, or dividers anywhere.'
}

/**
 * Overlay the formula's voice onto the Format the description prompt reads.
 *
 * `buildDescriptionPrompt` already surfaces `metadata.descriptionShape` at the
 * TOP of the prompt as rules the model must follow — exactly where a formula's
 * tone belongs. Reusing that mechanism means the shared prompt builder needs no
 * change at all, so this composes with anyone else editing prompt wording.
 */
export function withMetadataFormulaShape(
  format: Format | null | undefined,
  plan: MetadataFormulaPlan,
  architecture: string,
): Format | null | undefined {
  const existing = format?.metadata?.descriptionShape
  // The channel's own voice survives. A formula decides the SHAPE of the
  // write-up, not who the channel sounds like, so the niche's voiceGuidance is
  // kept and the formula's rules are appended after the niche's rather than
  // replacing them. A prayer channel that picks a chapters-first formula still
  // sounds like a prayer channel.
  const shape = {
    ...(existing ?? {}),
    voiceGuidance: existing?.voiceGuidance || architecture,
    descriptionShapeRules: [...(existing?.descriptionShapeRules ?? []), ...plan.toneConstraints],
    separatorRule: plan.separatorRule,
  }
  if (!format) return { metadata: { descriptionShape: shape } } as unknown as Format
  return {
    ...format,
    metadata: { ...format.metadata, descriptionShape: shape },
  }
}
