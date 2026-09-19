/**
 * Niche loader — reads built-in + user-custom Niche profiles and resolves
 * the "effective niche" for a given project (base + per-project overrides
 * deep-merged).
 *
 * Layout:
 *   - Built-in niches: ${BUILTIN_NICHES_DIR}/{id}.json — shipped with the
 *     app (electron-builder copies electron/server/niches → resourcesPath/niches).
 *   - User-custom niches: ${PROJECTS_ROOT}/.niches/{id}.json — exportable as
 *     single JSON files, shareable across machines / users.
 *   - Per-project overrides: stored inside project.json as `niche_overrides`
 *     (DeepPartial<Niche>), applied with a deep merge on top of the base.
 *
 * Lookup:
 *   loadNiche('plants')      → built-in
 *   loadNiche('my-custom')   → user library
 *   getEffectiveNicheFor(p)  → null if p.niche_id unset or niche missing,
 *                              else base + project.niche_overrides
 *
 * Caching:
 *   Built-in niches are cached forever (immutable in the bundle).
 *   User-custom niches are cached + invalidated on mtime change so editing
 *   the JSON directly takes effect on the next read.
 *
 * Pattern is intentionally identical to format-loader.ts so the codebase
 * has one shape to maintain for "JSON profile + built-in + user-custom +
 * per-project overrides" loaders. If you're adding the next axis primitive
 * (themes, tone packs, season templates), copy this file again.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { Niche, DeepPartial, ProjectMeta, TopicPack, IdeaAxis, NicheMetadataProfile } from '../models/types.js'
import * as topicPackLoader from './topic-pack-loader.js'
import {
  isQualifiedContentPackId,
  listCatalogEntries,
  listUserForkCatalogEntries,
  resolveCatalogItem,
  resolveUserForkCatalogItem,
  type CatalogEntry,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { registryOptionsForCurrentJob, resolveProjectContentPinsForKinds } from '../content-packs/project-pins.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ── Built-in directory resolution ──────────────────────────────────────────
// Mirrors format-loader's logic so packaged Electron, dev (tsx), and the
// compiled-from-watcher path all resolve correctly.

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

function findRepoNichesDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'niches')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinNichesDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'niches')
  }
  const found = findRepoNichesDir(__dirname)
  if (found) return found
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'niches')
}

export const BUILTIN_NICHES_DIR = resolveBuiltinNichesDir()

function userNichesDir(): string {
  return path.join(pm.projectsRoot(), '.niches')
}

// ── Cache ──────────────────────────────────────────────────────────────────

const builtinCache = new Map<string, Niche>()
const userCache = new Map<string, { mtimeMs: number; niche: Niche }>()

/**
 * Catalog-only migration metadata. The stable file ids intentionally remain
 * unchanged so existing projects, presets, and generated sidecars continue to
 * resolve. New-channel UI uses these names/families instead of exposing the
 * old one-niche-per-subject-library taxonomy.
 */
const FORMULA_CATALOG: Record<string, Pick<Niche,
  'formulaFamily' | 'catalogStatus' | 'successorFormulaId' | 'catalogName' | 'perspectivePolicy' | 'narrativeQualityContract' | 'metadataProfile'
>> = {
  'ancient-humans': { formulaFamily: 'Evidence & systems', catalogName: 'How Did Ancient Humans…?', perspectivePolicy: 'Third-person, evidence-led narration. Never role-play ancient people as the viewer.', narrativeQualityContract: { openingPolicy: 'Open on a specific survival problem, material trace, or surprising constraint — not an immersive invitation.', forbiddenPatterns: ['Imagine you are an ancient human', 'You find yourself', 'Watch what happens next', 'generic prehistoric danger bait'], requiredHabits: ['Separate evidence from inference.', 'Use concrete tools, environments, trade-offs, and dates where useful.', 'Let uncertainty remain uncertainty.'], closingPolicy: 'Close on what the evidence changes about our understanding, not a teaser.' } },
  'business-economics': { formulaFamily: 'Evidence & systems', catalogName: 'The Economics of…', perspectivePolicy: 'Third-person analytical explainer. Address the business, system, or decision — not a generic viewer avatar.', narrativeQualityContract: { openingPolicy: 'Open with the economic tension, cost, constraint, or surprising unit of the chosen business.', forbiddenPatterns: ['Imagine you own', 'So you want to own', 'Watch what happens next', 'This changes everything', 'generic entrepreneurial hype'], requiredHabits: ['Name the mechanism behind revenue, costs, risk, and trade-offs.', 'Use specific representative numbers or clearly labeled examples.', 'Build to an implication instead of repeating the premise.'], closingPolicy: 'End with the decisive trade-off or operating insight.' } },
  'history-narration': { formulaFamily: 'Evidence & systems', catalogName: 'History, Explained', perspectivePolicy: 'Third-person source-led documentary narration.', narrativeQualityContract: { openingPolicy: 'Open on a dated event, decision, material detail, or historical contradiction.', forbiddenPatterns: ['Imagine you are there', 'You would not believe', 'Watch what happens next', 'history’s best kept secret'], requiredHabits: ['Distinguish evidence, testimony, and interpretation.', 'Use names, places, causes, and consequences precisely.', 'Avoid present-day moralising where it replaces explanation.'], closingPolicy: 'Conclude with the historical consequence or remaining uncertainty.' } },
  'listicle-explainer': { formulaFamily: 'Evidence & systems', catalogName: 'Counted Explainer', perspectivePolicy: 'Third-person clear explainer; the numbered structure is visible but never mechanical.', narrativeQualityContract: { openingPolicy: 'Open with the organizing question and why its answer matters.', forbiddenPatterns: ['Number one will shock you', 'Wait until number', 'Watch what happens next', 'generic listicle suspense'], requiredHabits: ['Give each section a distinct reason for existing.', 'Vary entry and exit rhythm between sections.', 'Use transitions that explain relationships rather than counting.'], closingPolicy: 'Synthesize the pattern across the sections.' } },
  animals: { formulaFamily: 'Living world', catalogName: 'Natural World, Explained', perspectivePolicy: 'Third-person natural-history narration; never invent animal thoughts or dialogue.', narrativeQualityContract: { openingPolicy: 'Open with one observable biological behavior, adaptation, or environmental pressure.', forbiddenPatterns: ['Imagine being this animal', 'This animal does not want you to know', 'Watch what happens next', 'fake animal motives'], requiredHabits: ['Put biology before jokes.', 'Describe behavior as observation, not human intention.', 'Use ecological cause and effect.'], closingPolicy: 'End with the adaptation’s real consequence in its ecosystem.' } },
  fungi: { formulaFamily: 'Living world', catalogStatus: 'legacy', successorFormulaId: 'animals' },
  insects: { formulaFamily: 'Living world', catalogStatus: 'legacy', successorFormulaId: 'animals' },
  plants: { formulaFamily: 'Living world', catalogStatus: 'legacy', successorFormulaId: 'animals' },
  'pov-life': { formulaFamily: 'Immersive paths', catalogName: 'POV: Your Life As…', perspectivePolicy: 'Second-person immersive, grounded in period-appropriate daily decisions.', narrativeQualityContract: { openingPolicy: 'Begin inside a specific concrete moment, not a generic “you wake up” template.', forbiddenPatterns: ['Imagine this', 'You find yourself', 'Watch what happens next', 'generic sensory checklist'], requiredHabits: ['Anchor each scene in a real task, constraint, or social role.', 'Let the viewer infer stakes through action.', 'Use historically or institutionally plausible details.'], closingPolicy: 'End on a lived consequence rather than a cliffhanger.' } },
  'pov-hustle': { formulaFamily: 'Immersive paths', catalogName: 'Build Under Constraints', perspectivePolicy: 'Second-person practical simulation, never a hype monologue.', narrativeQualityContract: { openingPolicy: 'Start with the constraint, resource limit, or decision the viewer must work through.', forbiddenPatterns: ['Imagine this', 'You are about to', 'Watch what happens next', 'get rich quick'], requiredHabits: ['Show trade-offs and consequences.', 'Keep advice specific and falsifiable.', 'Avoid invented urgency.'], closingPolicy: 'End with the most useful decision rule.' } },
  psychology: { formulaFamily: 'Mind & ideas', catalogName: 'Human Behavior, Explained', perspectivePolicy: 'Warm third-person explainer with sparing “we” only where genuinely shared.', narrativeQualityContract: { openingPolicy: 'Open with a recognizable behavior or tension, not a diagnosis or bait question.', forbiddenPatterns: ['Have you ever wondered why', 'This is why you do', 'Watch what happens next', 'pseudo-clinical certainty'], requiredHabits: ['Separate research from speculation.', 'Use examples without diagnosing the viewer.', 'Offer nuance and agency.'], closingPolicy: 'Close with a practical reflection, not a manipulation tactic.' } },
  'dark-psychology': { formulaFamily: 'Mind & ideas', catalogStatus: 'legacy', successorFormulaId: 'psychology' },
  philosophy: { formulaFamily: 'Mind & ideas', catalogName: 'Philosophy for a Real Problem', perspectivePolicy: 'Conversational guide voice: thoughtful “we” and “you” only when earned by the argument.', narrativeQualityContract: { openingPolicy: 'Open with a real tension, decision, or paradox rather than a quote-card cliché.', forbiddenPatterns: ['Imagine this', 'Ancient wisdom says', 'Watch what happens next', 'fake profundity'], requiredHabits: ['Define terms before leaning on them.', 'Develop one argument at a time.', 'Use a genuine unresolved question only when it belongs to the topic.'], closingPolicy: 'End with a question or implication that follows from the argument.' } },
  motivation: { formulaFamily: 'Mind & ideas', catalogName: 'Practical Motivation', perspectivePolicy: 'Direct second-person practical coaching without hype.', narrativeQualityContract: { openingPolicy: 'Open with a concrete obstacle, behavior, or decision.', forbiddenPatterns: ['Wake up and grind', 'You are unstoppable', 'Watch what happens next', 'empty urgency'], requiredHabits: ['Give specific actionable reasoning.', 'Acknowledge friction and limits.', 'Earn encouragement through evidence and clarity.'], closingPolicy: 'End with one proportionate next action.' } },
  mindfulness: { formulaFamily: 'Mind & ideas', catalogName: 'Guided Mindfulness', perspectivePolicy: 'Gentle second-person guidance with calm, unforced language.', narrativeQualityContract: { openingPolicy: 'Begin with a simple grounded invitation, not a dramatic hook.', forbiddenPatterns: ['Imagine this', 'Transform your life today', 'Watch what happens next', 'spiritual grandiosity'], requiredHabits: ['Use spacious, sensory, concrete guidance.', 'Avoid diagnostic or therapeutic claims.', 'Leave room for silence and choice.'], closingPolicy: 'Close softly without a CTA or cliffhanger.' } },
  devotional: { formulaFamily: 'Faith', catalogName: 'Pastoral Scripture', perspectivePolicy: 'Pastoral teacher voice, speaking respectfully and plainly to the listener.', narrativeQualityContract: { openingPolicy: 'Open with the passage, its human situation, or a sincere pastoral concern.', forbiddenPatterns: ['God wants you to hear this', 'Stop scrolling', 'Watch what happens next', 'guaranteed blessing claims'], requiredHabits: ['Keep scripture and interpretation distinct.', 'Use warm, modest application.', 'Avoid coercive fear or prosperity claims.'], closingPolicy: 'End with a grounded reflection or blessing.' } },
  preaching: { formulaFamily: 'Faith', catalogStatus: 'legacy', successorFormulaId: 'devotional' },
  prayer: { formulaFamily: 'Faith', catalogName: 'Prayer', perspectivePolicy: 'Reflection and blessing address the listener; the prayer body addresses God directly.', narrativeQualityContract: { openingPolicy: 'Open quietly with the listener’s real concern or a scripture-rooted reflection.', forbiddenPatterns: ['God told me to tell you', 'Claim this now', 'Watch what happens next', 'guaranteed outcome claims'], requiredHabits: ['Keep the prayer body directly addressed to God.', 'Use specific compassionate language.', 'Never turn the prayer into hype or manipulation.'], closingPolicy: 'End as a benediction, not a subscription ask.' } },
  sleep: { formulaFamily: 'Calm stories', catalogName: 'Sleep Story', perspectivePolicy: 'Use the Formula-selected sleep narrator; never a high-energy host.', narrativeQualityContract: { openingPolicy: 'Begin gently and directly; no hook, challenge, teaser, or urgency.', forbiddenPatterns: ['Imagine this', 'Watch what happens next', 'cliffhanger', 'subscribe reminder', 'sudden danger bait'], requiredHabits: ['Keep sensory detail soft and low-stakes.', 'Use long, settled transitions.', 'Let scenes resolve rather than escalate.'], closingPolicy: 'Drift toward rest with no final reveal or CTA.' } },
}

const DEFAULT_NARRATIVE_QUALITY: NonNullable<Niche['narrativeQualityContract']> = {
  openingPolicy: 'Open with a specific fact, moment, problem, image, or decision native to this episode. Do not use a stock audience-address hook.',
  forbiddenPatterns: [
    'Imagine this',
    'Imagine you are',
    'You will not believe',
    'Watch what happens next',
    'generic rhetorical-question hooks',
    'artificial cliffhangers between ordinary sections',
  ],
  requiredHabits: [
    'Use concrete nouns, verbs, evidence, and causal links.',
    'Vary sentence length and section openings.',
    'Prefer a precise claim over inflated importance language.',
  ],
  closingPolicy: 'Close the actual thought; do not manufacture suspense for the next episode.',
}

const METADATA_PROFILES: Record<'evidence' | 'immersive' | 'reflective' | 'calm' | 'faith', NicheMetadataProfile> = {
  evidence: {
    id: 'evidence-youtube', label: 'Evidence-led video package',
    description: 'A direct episode summary with sources when research exists, a concise CTA, disclosure, and focused hashtags.',
    descriptionSectionIds: ['hook', 'sources', 'cta', 'ai-disclosure', 'hashtags'], titleMode: 'use_idea_title', descriptionMaxChars: 4000, titleMaxLength: 100, tagCount: 15,
  },
  immersive: {
    id: 'immersive-youtube', label: 'Immersive video package',
    description: 'A concise premise-led summary with a light CTA, disclosure, and focused hashtags.',
    descriptionSectionIds: ['hook', 'cta', 'ai-disclosure', 'hashtags'], titleMode: 'use_idea_title', descriptionMaxChars: 3500, titleMaxLength: 100, tagCount: 15,
  },
  reflective: {
    id: 'reflective-youtube', label: 'Reflective video package',
    description: 'A clear, non-hyped summary with a modest CTA, disclosure, and focused hashtags.',
    descriptionSectionIds: ['hook', 'cta', 'ai-disclosure', 'hashtags'], titleMode: 'use_idea_title', descriptionMaxChars: 3500, titleMaxLength: 100, tagCount: 15,
  },
  calm: {
    id: 'calm-youtube', label: 'Calm story package',
    description: 'A quiet story summary and minimal discoverability details; no urgency or sales language.',
    descriptionSectionIds: ['hook', 'hashtags'], titleMode: 'use_idea_title', descriptionMaxChars: 2500, titleMaxLength: 100, tagCount: 12,
  },
  faith: {
    id: 'pastoral-youtube', label: 'Pastoral video package',
    description: 'A respectful episode summary and restrained discoverability details, without pressure language.',
    descriptionSectionIds: ['hook', 'hashtags'], titleMode: 'use_idea_title', descriptionMaxChars: 3000, titleMaxLength: 100, tagCount: 15,
  },
}

function metadataProfileForFormula(id: string, family?: string): NicheMetadataProfile {
  if (id === 'sleep' || family === 'Calm stories') return METADATA_PROFILES.calm
  if (family === 'Faith') return METADATA_PROFILES.faith
  if (family === 'Evidence & systems' || id === 'animals') return METADATA_PROFILES.evidence
  if (family === 'Immersive paths') return METADATA_PROFILES.immersive
  return METADATA_PROFILES.reflective
}

function decorateCatalogNiche(niche: Niche): Niche {
  const catalog = FORMULA_CATALOG[niche.id]
  return {
    ...niche,
    kind: niche.kind || 'series-formula',
    formulaFamily: niche.formulaFamily || catalog?.formulaFamily || 'Custom',
    catalogStatus: niche.catalogStatus || catalog?.catalogStatus || 'active',
    successorFormulaId: niche.successorFormulaId || catalog?.successorFormulaId,
    catalogName: niche.catalogName || catalog?.catalogName || niche.name,
    perspectivePolicy: niche.perspectivePolicy || catalog?.perspectivePolicy || 'Use the Formula’s established narrator voice consistently.',
    narrativeQualityContract: niche.narrativeQualityContract || catalog?.narrativeQualityContract || DEFAULT_NARRATIVE_QUALITY,
    metadataProfile: niche.metadataProfile || catalog?.metadataProfile || metadataProfileForFormula(niche.id, niche.formulaFamily || catalog?.formulaFamily),
  }
}

async function loadNicheFile(filePath: string): Promise<Niche> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Niche JSON parse failed at ${filePath}: ${e.message}`)
  }
  validateNicheShape(parsed, filePath)
  // Every legacy Niche is a valid Series Formula. The default keeps all
  // existing project files working without a destructive migration.
  return decorateCatalogNiche(parsed as Niche)
}

function validateNicheShape(n: any, filePath: string): void {
  const missing: string[] = []
  if (typeof n?.id !== 'string' || !n.id) missing.push('id')
  if (typeof n?.name !== 'string' || !n.name) missing.push('name')
  if (typeof n?.description !== 'string') missing.push('description')
  if (n?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (!Array.isArray(n?.exampleTopics)) missing.push('exampleTopics (array)')
  if (missing.length) {
    throw new Error(`Niche at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a niche by id. User-custom first (shadows built-ins by id), then
 * built-in library. Returns null if not found.
 */
export async function loadNiche(id: string, registryOptions: ContentPackRegistryOptions = {}): Promise<Niche | null> {
  if (!id) return null
  const userFork = await resolveUserForkCatalogItem(id, 'series-formula', registryOptions)
  if (userFork) return userFork.value as Niche
  if (isQualifiedContentPackId(id)) {
    const effectiveOptions = await registryOptionsForCurrentJob(['series-formula'], registryOptions)
    const signed = await resolveCatalogItem(id, undefined, effectiveOptions)
    if (signed?.value.kind === 'series-formula') return contentPackDocumentToNiche(signed.value)
  }
  return loadLegacyNiche(id).then(result => result?.document ?? null)
}

/** Explicit compatibility resolver used by non-destructive fork-on-edit. */
export async function loadLegacyNiche(id: string): Promise<{ document: Niche; source: 'legacy-builtin' | 'legacy-user-fork' } | null> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) return null
  const userPath = path.join(userNichesDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return { document: cached.niche, source: 'legacy-user-fork' }
    const n = await loadNicheFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, niche: n })
    return { document: n, source: 'legacy-user-fork' }
  }
  if (builtinCache.has(id)) return { document: builtinCache.get(id)!, source: 'legacy-builtin' }
  const builtinPath = path.join(BUILTIN_NICHES_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const n = await loadNicheFile(builtinPath)
  builtinCache.set(id, n)
  return { document: n, source: 'legacy-builtin' }
}

/**
 * List every available niche (built-in + user-custom), sorted by name.
 * Malformed JSONs are skipped with a console warning rather than failing
 * the list — the user can fix the bad file without losing the others.
 */
export async function listNicheCatalogEntries(registryOptions: ContentPackRegistryOptions = {}): Promise<Array<CatalogEntry<Niche>>> {
  const seen = new Map<string, CatalogEntry<Niche>>()

  for (const entry of await listCatalogEntries('series-formula', registryOptions)) {
    if (entry.value.kind === 'series-formula') {
      seen.set(entry.value.id, { ...entry, value: contentPackDocumentToNiche(entry.value) })
    }
  }

  for (const entry of await listUserForkCatalogEntries('series-formula', registryOptions)) {
    const niche = entry.value as Niche
    if (!seen.has(niche.id)) seen.set(niche.id, { ...entry, value: niche })
  }

  const userDir = userNichesDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const n = await loadNicheFile(path.join(userDir, name))
        if (!seen.has(n.id)) seen.set(n.id, { value: n, source: 'legacy-user-fork' })
      } catch (e: any) {
        console.warn(`[niche-loader] skipping malformed user niche ${name}: ${e.message}`)
      }
    }
  }

  if (existsSync(BUILTIN_NICHES_DIR)) {
    let entries: string[] = []
    try { entries = await fs.readdir(BUILTIN_NICHES_DIR) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const n = await loadNicheFile(path.join(BUILTIN_NICHES_DIR, name))
        if (!seen.has(n.id)) seen.set(n.id, { value: n, source: 'legacy-builtin' })
      } catch (e: any) {
        console.warn(`[niche-loader] skipping malformed built-in niche ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.value.name.localeCompare(b.value.name))
}

export async function listNiches(registryOptions: ContentPackRegistryOptions = {}): Promise<Niche[]> {
  return (await listNicheCatalogEntries(registryOptions)).map(entry => entry.value)
}

/**
 * Deep-merge `overrides` onto `base`. Arrays in overrides REPLACE the base
 * array — matches format-loader's merge semantics so the user mental model
 * stays consistent ("override = swap out the whole list").
 */
export function mergeNicheOverrides(base: Niche, overrides?: DeepPartial<Niche>): Niche {
  if (!overrides) return base
  return deepMerge(base, overrides) as Niche
}

function uniqueStrings(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const group of groups) {
    for (const value of group || []) {
      const clean = value?.trim()
      const key = clean?.toLowerCase()
      if (!clean || !key || seen.has(key)) continue
      seen.add(key)
      result.push(clean)
    }
  }
  return result
}

function mergeAxes(base: IdeaAxis[] | undefined, packs: TopicPack[]): IdeaAxis[] | undefined {
  const byId = new Map<string, IdeaAxis>()
  for (const axis of base || []) {
    byId.set(axis.id, { ...axis, values: uniqueStrings(axis.values) })
  }
  for (const pack of packs) {
    for (const axis of pack.ideaAxes || []) {
      const prior = byId.get(axis.id)
      byId.set(axis.id, {
        id: axis.id,
        label: prior?.label || axis.label,
        values: uniqueStrings(prior?.values, axis.values),
      })
    }
  }
  return byId.size ? [...byId.values()] : undefined
}

/**
 * Compose a Series Formula with reusable Topic Packs. Formula voice and
 * structure remain dominant; packs supply subjects, vocabulary, examples, and
 * domain constraints. Unknown or incompatible ids are ignored with warnings so
 * deleting a custom pack never bricks an existing project.
 */
export async function composeNicheWithTopicPacks(
  niche: Niche,
  requestedIds?: string[],
  registryOptions: ContentPackRegistryOptions = {},
): Promise<Niche> {
  const ids = requestedIds === undefined
    ? (niche.defaultTopicPackIds || [])
    : requestedIds
  const allow = niche.compatibleTopicPackIds?.length
    ? new Set(niche.compatibleTopicPackIds)
    : null
  const packs: TopicPack[] = []
  for (const id of uniqueStrings(ids)) {
    if (allow && !allow.has(id)) {
      console.warn(`[niche-loader] topic pack '${id}' is not allowed by Series Formula '${niche.id}'`)
      continue
    }
    const pack = await topicPackLoader.loadTopicPack(id, registryOptions)
    if (!pack) {
      console.warn(`[niche-loader] topic pack '${id}' not found for Series Formula '${niche.id}'`)
      continue
    }
    if (!topicPackLoader.isCompatible(pack, niche.id)) {
      console.warn(`[niche-loader] topic pack '${id}' is incompatible with Series Formula '${niche.id}'`)
      continue
    }
    packs.push(pack)
  }
  if (!packs.length) return { ...niche, kind: 'series-formula', activeTopicPacks: [] }

  const packContext = packs
    .map(pack => `${pack.name}: ${pack.promptContext || pack.description}`)
    .join('\n')
  const contextBlock = `ACTIVE TOPIC PACKS — use these as the subject inventory and domain boundary:\n${packContext}`
  const vocabulary = {
    mood: uniqueStrings(niche.vocabulary?.mood, ...packs.map(pack => pack.vocabulary?.mood)),
    theme: uniqueStrings(niche.vocabulary?.theme, ...packs.map(pack => pack.vocabulary?.theme)),
    genre: uniqueStrings(niche.vocabulary?.genre, ...packs.map(pack => pack.vocabulary?.genre)),
    keyword: uniqueStrings(niche.vocabulary?.keyword, ...packs.map(pack => pack.vocabulary?.keyword)),
  }

  return {
    ...niche,
    kind: 'series-formula',
    activeTopicPacks: packs,
    exampleTopics: uniqueStrings(
      niche.exampleTopics,
      ...packs.map(pack => pack.exampleTopics),
      ...packs.map(pack => pack.subjects),
    ),
    ideaAxes: mergeAxes(niche.ideaAxes, packs),
    vocabulary,
    youtubeTagsHint: uniqueStrings(
      niche.youtubeTagsHint,
      ...packs.map(pack => pack.youtubeTagsHint),
    ),
    scriptContext: [niche.scriptContext, contextBlock].filter(Boolean).join('\n\n'),
    ideaGuidanceText: [niche.ideaGuidanceText, contextBlock].filter(Boolean).join('\n\n'),
    ideaSystemPromptRole: [niche.ideaSystemPromptRole, contextBlock].filter(Boolean).join('\n\n'),
    scriptSystemPromptRole: [niche.scriptSystemPromptRole, contextBlock].filter(Boolean).join('\n\n'),
  }
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target
  if (Array.isArray(source)) return source.slice()
  if (typeof source !== 'object') return source
  const out: any = Array.isArray(target) ? target.slice() : { ...(target || {}) }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    if (sv === undefined) continue
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) && target?.[key] && typeof target[key] === 'object') {
      out[key] = deepMerge(target[key], sv)
    } else {
      out[key] = Array.isArray(sv) ? sv.slice() : sv
    }
  }
  return out
}

/**
 * Resolve the effective niche for a project. Returns null when:
 *   - the project has no niche_id, or
 *   - the referenced niche file is missing (we log + fall back to null
 *     rather than throwing — generators must keep working with their
 *     format-only behavior if a niche file gets renamed mid-flight).
 */
export async function getEffectiveNicheFor(
  project: ProjectMeta,
  topicPackIdsOverride?: string[],
  registryOptions: ContentPackRegistryOptions = {},
): Promise<Niche | null> {
  if (!project.niche_id) return null
  const pins = await resolveProjectContentPinsForKinds(project, ['series-formula', 'topic-pack'], registryOptions)
  const pinnedOptions = { ...registryOptions, pins }
  let base: Niche | null = null
  try {
    base = await loadNiche(project.niche_id, pinnedOptions)
  } catch (e: any) {
    console.warn(`[niche-loader] failed loading niche '${project.niche_id}' for project '${project.slug}': ${e.message}`)
    return null
  }
  if (!base) {
    console.warn(`[niche-loader] project '${project.slug}' references niche '${project.niche_id}' but no file found`)
    return null
  }
  const requestedPackIds = topicPackIdsOverride === undefined
    ? project.topic_pack_ids
    : topicPackIdsOverride
  const composed = await composeNicheWithTopicPacks(base, requestedPackIds, pinnedOptions)
  return mergeNicheOverrides(composed, project.niche_overrides)
}

/** Same as getEffectiveNicheFor() but takes a slug. */
export async function getEffectiveNiche(slug: string): Promise<Niche | null> {
  const project = await pm.getProject(slug)
  if (!project) return null
  return getEffectiveNicheFor(project)
}

// ── Mutation helpers (used by the /niches routes) ──────────────────────────

/**
 * A user-niche id must be a safe filename segment.
 *
 * `loadNiche` tested a pattern, but only on its MISS branch — so an id that
 * named an existing file skipped the check entirely. `nicheFilePath` then fed
 * the raw route param into `path.join(userNichesDir(), `${id}.json`)`, and
 * `DELETE /api/niches/..%2F<project>%2Fconfig` unlinked
 * `<projectsRoot>/<project>/config.json`. Validating where the path is built
 * covers the route, the delete and any future caller.
 *
 * The rule is the SECURITY property, deliberately not the loader's own regex.
 * That regex (`^[a-z0-9][a-z0-9._-]{0,127}$`) had never actually been applied
 * to every real id, because legacy Content Pack user forks are named
 * `user:<uuid>` — a colon, which it rejects. Reusing it here broke editing a
 * forked Formula. What actually matters is: no path separator, no NUL, and not
 * a dot-path. A colon is a perfectly ordinary filename character on macOS.
 */
function assertSafeNicheId(id: unknown): string {
  const value = String(id ?? '')
  if (
    !value || value.length > 200 || value !== value.trim()
    || /[/\\\u0000]/.test(value)
    || value.startsWith('.')
  ) {
    throw new Error(`Invalid niche id '${value}'`)
  }
  return value
}

export function nicheFilePath(id: string): string {
  return path.join(userNichesDir(), `${assertSafeNicheId(id)}.json`)
}

export async function ensureNichesDir(): Promise<void> {
  // ensureProjectsRoot() (not projectsRoot()) so the shared test-isolation
  // guard fires before a recursive mkdir can materialise `.niches` inside the
  // developer's real projects folder.
  await fs.mkdir(path.join(pm.ensureProjectsRoot(), '.niches'), { recursive: true })
}

export function invalidateNicheCache(id: string): void {
  userCache.delete(nicheFilePath(id))
  builtinCache.delete(id)
}

/** Test-only — wipe caches so freshly-written niche files take effect. */
export function _clearNicheCaches(): void {
  builtinCache.clear()
  userCache.clear()
}

export { userNichesDir as _userNichesDir }
