/**
 * #3 Self-growing Topic Packs (1.4.293, per-channel `idea_upgrades.grow_packs`), with #5's real
 * sources when `real_sources` is on.
 *
 * One run asks the channel's idea helper model for up to 40 NEW subjects that fit as well as the
 * existing ones — chosen only from real Wikipedia articles when the channel has a reference list —
 * checks them, and adds the survivors to the channel's grown pack (services/grown-pack.ts).
 * Add-only; original packs are never touched. A run that adds nothing fails loudly and writes
 * nothing. Automatic runs: only when unused subjects are below the channel's running-low number,
 * at most one a day, and never again after three runs in a row that each added fewer than five
 * (one alert says so instead).
 */
import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import { readIdeaUpgrades, getIdeaUpgrades, normalizeCategories } from './idea-upgrades.js'
import { resolveCampaignNiche } from '../generators/idea-campaign.js'
import { callHelperModel, checkHelperModel, readCoveredMap } from './covered-topics.js'
import { addGrownSubjects, readGrownPack, type GrownEntry, type GrownPack } from './grown-pack.js'
import { getReferencePool, sample, subjectKey, unusedReferenceItems, type ReferenceDeps, type ReferenceItem } from './reference-pool.js'
import { grownSubjectsOutputContract, referenceCategoriesOutputContract } from '../lib/story-output-contracts.js'
import { watchDuplicates } from './idea-similarity.js'
import { embedTexts } from '../lib/embeddings-client.js'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { computeAllIdeaSupply, type IdeaSupply } from './idea-supply.js'
import { topicPackFilePath } from './topic-pack-loader.js'

export const GROW_PER_RUN = 40
const CANDIDATES_SHOWN = 150
const SUBJECT_MATCH_THRESHOLD = 0.9
const RUNS_KEY = 'idea_grow_runs'

export class GrowError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message) }
}

export interface GrowRun { at: string; trigger: 'manual' | 'auto'; added: number; error?: string }
type RunState = Record<string, { runs: GrowRun[]; stop_alerted?: boolean }>

export interface GrowDeps {
  checkModel?: (model: string) => Promise<void>
  callModel?: (model: string, prompt: string, requestIdentity: string) => Promise<string>
  embed?: (texts: string[]) => Promise<number[][]>
  referenceDeps?: ReferenceDeps
  random?: () => number
}

async function readRuns(): Promise<RunState> {
  const raw = await getAppSetting(RUNS_KEY)
  return raw && typeof raw === 'object' ? { ...(raw as RunState) } : {}
}

export async function growRuns(slug: string): Promise<GrowRun[]> {
  return (await readRuns())[slug]?.runs || []
}

async function recordRun(slug: string, run: GrowRun): Promise<void> {
  const state = await readRuns()
  const entry = state[slug] || { runs: [] }
  state[slug] = { runs: [...entry.runs, run].slice(-10), stop_alerted: run.added >= 5 ? false : entry.stop_alerted }
  await setAppSetting(RUNS_KEY, state)
}

function growPrompt(options: { channel: string; formula: string; existing: string[]; covered: string[]; candidates: ReferenceItem[] }): string {
  return `Channel "${options.channel}", Series Formula ${options.formula}.
EXISTING TOPIC PACK SUBJECTS (do not repeat or rename any of these):
${options.existing.join('; ') || '(none)'}
${options.covered.length ? `\nALREADY COVERED BY EPISODES:\n${options.covered.join('; ')}\n` : ''}${options.candidates.length ? `
CANDIDATES FROM WIKIPEDIA — choose ONLY from these, and copy the name exactly as written before the dash:
${options.candidates.map(item => `- ${item.title}${item.description ? ` — ${item.description}` : ''}`).join('\n')}
` : ''}
Propose up to ${GROW_PER_RUN} NEW subjects that fit this channel exactly as well as the existing ones.
- Concrete things (one food, drink, object, place, person or event), not categories.
- Short names (at most 6 words), no numbering.
Return ONLY JSON {"subjects":[{"name":"…","why_it_fits":"…"}]}.`
}

function parseSubjects(raw: string): Array<{ name: string; why: string }> {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('the helper model returned no JSON object')
  const rows = JSON.parse(text.slice(start, end + 1))?.subjects
  if (!Array.isArray(rows)) throw new Error('the helper model returned no subjects list')
  return rows.flatMap((row: any) => typeof row?.name === 'string'
    ? [{ name: row.name.trim().replace(/\s+/g, ' '), why: typeof row.why_it_fits === 'string' ? row.why_it_fits.trim().slice(0, 300) : '' }]
    : [])
}

/** Before the first grow run on this channel: copy `.topic-packs/` to the channel's `_backups/`. */
async function backupTopicPacks(slug: string): Promise<void> {
  const projectDir = pm.getProjectDir(slug)
  const packsDir = path.dirname(topicPackFilePath('x'))
  if (!projectDir || !existsSync(packsDir)) return
  await fs.cp(packsDir, path.join(projectDir, '_backups', `topic-packs-${new Date().toISOString().replace(/[:.]/g, '-')}`), { recursive: true })
}

/**
 * One grow run. Returns what was added; throws a GrowError (with an HTTP-ish status and a plain
 * sentence) when nothing could be added — in which case nothing was written.
 */
export async function growTopicPack(slug: string, options: { trigger: 'manual' | 'auto'; deps?: GrowDeps }): Promise<{ added: GrownEntry[]; notes: string[]; pack: GrownPack }> {
  const deps = options.deps || {}
  const project = await pm.getProject(slug)
  if (!project) throw new GrowError('Project not found', 404)
  const upgrades = readIdeaUpgrades(await pm.getConfig(slug).catch(() => null))
  const { formulaId, niche } = await resolveCampaignNiche(project)
  const packs = niche?.activeTopicPacks || []
  if (!niche || !packs.length) throw new GrowError('Growing subjects is only for channels that use Topic Packs; this channel generates freely from its Series Formula.', 400)

  // Every failure below is recorded as a run, so the automatic check cannot retry it forever.
  const fail = async (message: string, statusCode: number): Promise<never> => {
    await recordRun(slug, { at: new Date().toISOString(), trigger: options.trigger, added: 0, error: message })
    throw new GrowError(message, statusCode)
  }
  if (!upgrades.helper_model) return fail('Choose an idea helper model first (Settings → Channel identity → Idea supply and repeat checks); nothing was added.', 400)
  try {
    await (deps.checkModel || checkHelperModel)(upgrades.helper_model)
  } catch {
    return fail(`Idea helper model "${upgrades.helper_model}" is not available right now; nothing was added.`, 503)
  }

  const grown = await readGrownPack(slug)
  const existing = [...new Set([...packs.flatMap(pack => pack.subjects), ...(grown?.subjects || [])])]
  const rejected = grown?.grown.rejected.map(row => row.subject) || []
  const covered = (await readCoveredMap(slug))?.entries.subjects.map(entry => entry.name) || []
  const taken = new Set([...existing, ...rejected, ...covered].map(subjectKey))
  const notes: string[] = []

  let candidates: ReferenceItem[] = []
  if (upgrades.real_sources) {
    const reference = await getReferencePool(slug, upgrades.reference_categories, { deps: deps.referenceDeps })
    notes.push(`Wikipedia: ${reference.note}`)
    candidates = sample(unusedReferenceItems(reference.pool, [...existing, ...rejected, ...covered]), CANDIDATES_SHOWN, deps.random)
    if (reference.pool && !candidates.length) notes.push('every article in the Wikipedia list is already used or covered, so subjects come from the helper model’s own knowledge')
  }
  const byKey = new Map(candidates.map(item => [subjectKey(item.title), item]))

  let proposals: Array<{ name: string; why: string }>
  try {
    const prompt = growPrompt({
      channel: project.name || slug,
      formula: `"${niche.name}"${niche.description ? `: ${niche.description}` : ''}`,
      existing, covered, candidates,
    })
    const identity = `${slug}:grow-subjects:${Date.now()}`
    const raw = await (deps.callModel || ((model, text, id) => callHelperModel(model, text, id, slug, grownSubjectsOutputContract())))(upgrades.helper_model, prompt, identity)
    proposals = parseSubjects(raw)
  } catch (error) {
    return fail(`The helper model gave no usable answer (${error instanceof Error ? error.message : String(error)}); nothing was added.`, 502)
  }

  const kept: Array<{ name: string; why: string; item?: ReferenceItem }> = []
  let offList = 0
  for (const proposal of proposals) {
    const item = byKey.get(subjectKey(proposal.name))
    const name = item?.title || proposal.name
    if (name.length < 3 || name.length > 60) continue
    if (candidates.length && !item) { offList++; continue }
    const key = subjectKey(name)
    if (!key || taken.has(key)) continue
    taken.add(key)
    kept.push({ name, why: proposal.why, item })
  }
  if (offList) notes.push(`${offList} suggestion${offList === 1 ? ' was' : 's were'} not on the Wikipedia list and left out`)

  let survivors = kept
  if (upgrades.embedding_model && kept.length) {
    const watched = await watchDuplicates(
      kept.map(row => ({ title: row.name })),
      [...existing, ...covered].map(title => ({ title })),
      { embed: deps.embed || (texts => embedTexts(upgrades.embedding_model, texts)), threshold: SUBJECT_MATCH_THRESHOLD },
    )
    if (watched.method === 'meaning') {
      const near = new Set(watched.hits.map(hit => hit.candidate.title))
      survivors = kept.filter(row => !near.has(row.name))
      if (near.size) notes.push(`${near.size} left out as the same thing as an existing subject (meaning ≥ ${SUBJECT_MATCH_THRESHOLD})`)
    } else {
      notes.push(`meaning check unavailable (${watched.fallback_reason}); exact-name check only`)
    }
  }
  survivors = survivors.slice(0, GROW_PER_RUN)
  if (!survivors.length) return fail(`No new subjects passed the checks${notes.length ? ` (${notes.join('; ')})` : ''}; nothing was added.`, 422)

  if (!grown) await backupTopicPacks(slug)
  const at = new Date().toISOString()
  const entries: GrownEntry[] = survivors.map(row => ({
    subject: row.name,
    added_at: at,
    source: row.item ? `wikipedia:${row.item.category}` : 'model',
    ...(row.item ? { source_url: row.item.url } : {}),
    model: upgrades.helper_model,
    ...(row.why ? { why: row.why } : {}),
  }))
  const pack = await addGrownSubjects(slug, { formulaId: formulaId || niche.id, channelName: project.name || slug, entries })
  await recordRun(slug, { at, trigger: options.trigger, added: entries.length })
  return { added: entries, notes, pack }
}

function localYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * The hourly check: grow each opted-in Topic Pack channel whose unused subjects are below its
 * running-low number — once a day at most, and not after three weak runs in a row. Returns the
 * slugs it acted on (grew, failed, or stopped).
 */
export async function runAutoGrow(
  send: (payload: { title: string; body: string }, slug: string) => Promise<void>,
  now = new Date(),
  supplies?: IdeaSupply[],
  deps?: GrowDeps,
): Promise<string[]> {
  const today = localYmd(now)
  const acted: string[] = []
  for (const supply of supplies || await computeAllIdeaSupply()) {
    if (supply.unused_subjects.kind !== 'measured') continue
    const upgrades = await getIdeaUpgrades(supply.slug)
    if (!upgrades.grow_packs || supply.unused_subjects.value >= upgrades.low_unused_subjects) continue
    const state = (await readRuns())[supply.slug]
    const runs = state?.runs || []
    if (runs.some(run => localYmd(new Date(run.at)) === today)) continue
    const lastThree = runs.slice(-3)
    if (lastThree.length === 3 && lastThree.every(run => run.added < 5)) {
      if (!state?.stop_alerted) {
        await send({ title: `${supply.name}: stopped growing Topic Pack subjects`, body: 'The last three runs each added fewer than 5 new subjects, so Story has stopped trying on its own. Press "Grow Subjects Now" on the Ideas page, add a Topic Pack, or change the Wikipedia categories.' }, supply.slug)
        const all = await readRuns()
        all[supply.slug] = { runs, stop_alerted: true }
        await setAppSetting(RUNS_KEY, all)
        acted.push(supply.slug)
      }
      continue
    }
    try {
      const result = await growTopicPack(supply.slug, { trigger: 'auto', deps })
      const names = result.added.map(entry => entry.subject)
      await send({
        title: `${supply.name}: ${names.length} new Topic Pack subject${names.length === 1 ? '' : 's'}`,
        body: `${names.slice(0, 15).join(', ')}${names.length > 15 ? `, and ${names.length - 15} more` : ''}. Review or remove them on the Ideas page.`,
      }, supply.slug)
    } catch (error) {
      await send({ title: `${supply.name}: growing Topic Pack subjects failed`, body: error instanceof Error ? error.message : String(error) }, supply.slug)
    }
    acted.push(supply.slug)
  }
  return acted
}

/**
 * #5: propose Wikipedia categories for this channel with its helper model (one small call). Only a
 * proposal — the owner edits and saves the list; nothing is fetched until it is saved.
 */
export async function suggestReferenceCategories(slug: string, deps: GrowDeps = {}): Promise<string[]> {
  const project = await pm.getProject(slug)
  if (!project) throw new GrowError('Project not found', 404)
  const upgrades = readIdeaUpgrades(await pm.getConfig(slug).catch(() => null))
  if (!upgrades.helper_model) throw new GrowError('Choose an idea helper model first.', 400)
  const { niche } = await resolveCampaignNiche(project)
  if (!niche) throw new GrowError('This channel has no Series Formula to suggest categories from.', 400)
  try {
    await (deps.checkModel || checkHelperModel)(upgrades.helper_model)
  } catch {
    throw new GrowError(`Idea helper model "${upgrades.helper_model}" is not available right now.`, 503)
  }
  const packs = (niche.activeTopicPacks || []).map(pack => `- ${pack.name}: ${pack.subjects.slice(0, 12).join(', ')}`).join('\n')
  const prompt = `Channel "${project.name || slug}", Series Formula "${niche.name}"${niche.description ? `: ${niche.description}` : ''}.
${packs ? `Its Topic Packs (with example subjects):\n${packs}\n` : ''}
Suggest 5 to 12 English Wikipedia category names whose direct member articles are concrete subjects this channel could make whole episodes about (one food, object, place, person or event per article). Prefer specific categories ("Category:Spices", "Category:Ancient Roman roads") over huge general ones. Use real category names exactly as they appear on Wikipedia.
Return ONLY JSON {"categories":["Category:…"]}.`
  let raw: string
  try {
    raw = await (deps.callModel || ((model, text, id) => callHelperModel(model, text, id, slug, referenceCategoriesOutputContract())))(upgrades.helper_model, prompt, `${slug}:reference-categories:${Date.now()}`)
  } catch (error) {
    throw new GrowError(`The helper model did not answer (${error instanceof Error ? error.message : String(error)}).`, 502)
  }
  const start = raw.indexOf('{')
  const parsed = start >= 0 ? (() => { try { return JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1)) } catch { return null } })() : null
  const categories = normalizeCategories(parsed?.categories)
  if (!categories.length) throw new GrowError('The helper model suggested no categories; type them in yourself.', 502)
  return categories
}
