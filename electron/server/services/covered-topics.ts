/**
 * #1 Covered-topics map (1.4.285, per-channel `idea_upgrades.covered_map`).
 *
 * A compact list of everything the channel's whole history covers — subjects, people, places, eras,
 * angles, each with a count — built by the owner's chosen helper model and shown to the idea model
 * next to the newest 200 titles. Built by deltas: only ideas not yet folded in are sent, 150 at a
 * time, and the server merges by name. Existing ideas are read, never changed. The map only shapes
 * the prompt; it never blocks or deletes anything.
 */
import path from 'path'
import { existsSync } from 'fs'
import { withLock, writeJsonAtomic, readJsonOr } from '../lib/atomic-store.js'
import { moveToTrashSync } from '../lib/trash-move.js'
import { callAiWithRetry, resolveLivePipelineModel } from '../lib/ai-client.js'
import { listChatModels } from '../lib/genstudio-client.js'
import { getApiKey } from './app-secrets-store.js'
import { coveredTopicsOutputContract } from '../lib/story-output-contracts.js'
import * as pm from './project-manager.js'

export const COVERED_GROUPS = ['subjects', 'people', 'places', 'eras', 'angles'] as const
export type CoveredGroup = typeof COVERED_GROUPS[number]
export interface CoveredEntry { name: string; count: number }
export interface CoveredMap {
  schema: 1
  formula_id: string
  helper_model: string
  built_at: string
  covered_idea_ids: string[]
  entries: Record<CoveredGroup, CoveredEntry[]>
}
export interface HistoryIdea { id: string; title: string; logline?: string; themes?: string[] }

export const COVERED_FILE = 'covered-topics.json'
const CHUNK = 150

function emptyEntries(): CoveredMap['entries'] {
  return { subjects: [], people: [], places: [], eras: [], angles: [] }
}

function filePath(slug: string): string | null {
  const dir = pm.getProjectDir(slug)
  return dir ? path.join(dir, COVERED_FILE) : null
}

export async function readCoveredMap(slug: string): Promise<CoveredMap | null> {
  const file = filePath(slug)
  if (!file || !existsSync(file)) return null
  const map = await readJsonOr<CoveredMap | null>(file, null)
  return map && map.schema === 1 && map.entries ? map : null
}

/** Merge additions by exact name (case-insensitive); counts add up. Pure. */
export function mergeCovered(entries: CoveredMap['entries'], add: unknown): CoveredMap['entries'] {
  const out = structuredClone(entries)
  for (const group of COVERED_GROUPS) {
    const rows = Array.isArray((add as any)?.[group]) ? (add as any)[group] : []
    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
      if (!name) continue
      const count = Number.isInteger(row?.count) && row.count > 0 ? row.count : 1
      const existing = out[group].find(entry => entry.name.toLowerCase() === name.toLowerCase())
      if (existing) existing.count += count
      else out[group].push({ name, count })
    }
    out[group].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }
  return out
}

// ponytail: fixed per-group caps on our OWN list (not a model limit); subjects are never dropped.
// Chat products publish no prompt-character figure, so the cap cannot be derived from the model.
const OTHER_GROUP_CAP = 40

function list(entries: CoveredEntry[]): string {
  return entries.map(entry => entry.count > 1 ? `${entry.name} ×${entry.count}` : entry.name).join('; ')
}

/**
 * The prompt block. Freeform: never another episode on a covered subject. Pack path (subject is
 * assigned by the planner): pick a focus inside it that is not covered, so the map does not fight
 * the planner's deliberate sibling ideas. Empty map → ''.
 */
export function renderCoveredBlock(map: CoveredMap | null, mode: 'freeform' | 'pack'): string {
  if (!map) return ''
  const others = (['people', 'places', 'eras'] as const)
    .filter(group => map.entries[group].length)
    .map(group => `${group[0]!.toUpperCase()}${group.slice(1)}: ${list(map.entries[group].slice(0, OTHER_GROUP_CAP))}`)
  const subjects = map.entries.subjects
  if (!subjects.length && !others.length) return ''
  const lines = mode === 'freeform'
    ? [
        subjects.length ? `COVERED SUBJECTS — never make another episode about any of these, even from a new angle:\n${list(subjects)}` : '',
        others.length ? `ALREADY USED OFTEN — prefer people, places and eras not listed here:\n${others.join('\n')}` : '',
      ]
    : [
        `COVERED LIST — within your assigned subject, pick a focus (person, place, event, object) that is NOT in this list:\n${[subjects.length ? `Subjects: ${list(subjects)}` : '', ...others].filter(Boolean).join('\n')}`,
      ]
  return lines.filter(Boolean).join('\n\n')
}

function helperPrompt(channel: string, description: string, map: CoveredMap['entries'], ideas: HistoryIdea[]): string {
  const lines = ideas.map(idea => `- ${idea.title} | ${(idea.logline || '').slice(0, 300)} | ${(idea.themes || []).join(', ')}`)
  return `You maintain a covered-topics map for the YouTube channel "${channel}"${description ? ` (${description})` : ''}.
CURRENT MAP: ${JSON.stringify(map)}
NEW EPISODES (title | logline | themes):
${lines.join('\n')}

Return ONLY JSON {"add":{"subjects":[{"name":"…","count":1}],"people":[],"places":[],"eras":[],"angles":[]}} listing what these NEW episodes add.
- Use a short canonical name (at most 5 words).
- If a new item is the same thing as an existing entry, reuse that entry's name exactly so counts merge.
- One subject per episode: the concrete thing the episode is about, not its category.
- count = how many of the NEW episodes it appears in.`
}

function parseObject(raw: string): unknown {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('helper returned no JSON object')
  return JSON.parse(text.slice(start, end + 1))?.add
}

export interface CoveredMapDeps {
  /** Throws when the model is not offered right now. */
  checkModel?: (model: string) => Promise<void>
  callModel?: (model: string, prompt: string, requestIdentity: string) => Promise<string>
}

async function liveCheck(model: string): Promise<void> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  resolveLivePipelineModel(model, apiKey ? await listChatModels(apiKey) : [])
}

async function liveCall(model: string, prompt: string, requestIdentity: string, slug: string, signal?: AbortSignal): Promise<string> {
  return callAiWithRetry(model, '', prompt, {}, false, {
    slug, signal, requestIdentity,
    outputBudget: { tier: 'long', minimumTokens: 4096 },
    outputContract: coveredTopicsOutputContract(),
    disableReasoning: true,
  })
}

/**
 * Fold every history idea not yet in the map into it. Never throws: on any helper failure the map
 * keeps what it already had (each finished chunk is saved) and `note` says why. Another model is
 * never substituted for the chosen one.
 */
export async function updateCoveredMap(options: {
  slug: string
  helperModel: string
  formulaId: string
  channelName: string
  description?: string
  history: HistoryIdea[]
  signal?: AbortSignal
  deps?: CoveredMapDeps
}): Promise<{ map: CoveredMap | null; added: number; note: string }> {
  const file = filePath(options.slug)
  if (!file) return { map: null, added: 0, note: 'project folder not found; covered-topics map skipped' }
  if (!options.helperModel) return { map: await readCoveredMap(options.slug), added: 0, note: 'no idea helper model chosen; covered-topics map skipped' }
  return withLock(file, async () => {
    let map: CoveredMap = (await readCoveredMap(options.slug)) || {
      schema: 1, formula_id: options.formulaId, helper_model: options.helperModel,
      built_at: new Date().toISOString(), covered_idea_ids: [], entries: emptyEntries(),
    }
    const done = new Set(map.covered_idea_ids)
    const pending = options.history.filter(idea => idea.id && !done.has(idea.id)).reverse() // oldest first
    if (!pending.length) return { map, added: 0, note: '' }
    try {
      await (options.deps?.checkModel || liveCheck)(options.helperModel)
    } catch {
      return { map: done.size ? map : null, added: 0, note: `Idea helper model "${options.helperModel}" is not available; covered-topics map not updated` }
    }
    let added = 0
    for (let start = 0; start < pending.length; start += CHUNK) {
      if (options.signal?.aborted) break
      const chunk = pending.slice(start, start + CHUNK)
      const identity = `${options.slug}:covered-topics:${chunk[0]!.id}:${chunk.length}`
      const prompt = helperPrompt(options.channelName, options.description || '', map.entries, chunk)
      let add: unknown
      try {
        const call = options.deps?.callModel || ((model, text, id) => liveCall(model, text, id, options.slug, options.signal))
        add = parseObject(await call(options.helperModel, prompt, identity))
      } catch (error) {
        return { map: done.size || added ? map : null, added, note: `covered-topics map kept as it was (${error instanceof Error ? error.message : String(error)})` }
      }
      map = {
        ...map,
        helper_model: options.helperModel,
        built_at: new Date().toISOString(),
        covered_idea_ids: [...map.covered_idea_ids, ...chunk.map(idea => idea.id)],
        entries: mergeCovered(map.entries, add),
      }
      await writeJsonAtomic(file, map)
      added += chunk.length
    }
    return { map, added, note: '' }
  })
}

/** "Rebuild": the old map moves to the project's `_trash` (never deleted); the next build starts fresh. */
export async function trashCoveredMap(slug: string): Promise<string | null> {
  const file = filePath(slug)
  if (!file || !existsSync(file)) return null
  return withLock(file, async () => moveToTrashSync(file, path.join(path.dirname(file), '_trash', 'covered-topics', COVERED_FILE)))
}
