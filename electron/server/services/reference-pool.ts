/**
 * #5 Ideas grounded in real sources (1.4.293, per-channel `idea_upgrades.real_sources`).
 *
 * A cached list of real Wikipedia articles from the categories the owner saved for this channel
 * (`reference_categories`), in `projects/<slug>/reference-pool.json`. Free and keyless: GETs to
 * en.wikipedia.org only (a named exception to "one endpoint" — AGENTS.md §7), at most one request
 * a second, backing off on 429/503, with a User-Agent that names the app and nothing personal.
 * Any failure keeps the cached pool; nothing is fetched while the category list is empty.
 */
import path from 'path'
import { existsSync } from 'fs'
import { readJsonOr, withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import * as pm from './project-manager.js'

export const REFERENCE_FILE = 'reference-pool.json'
export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php'
/** Names the app and its purpose. No person, email or machine name — ever. */
export const WIKIPEDIA_USER_AGENT = 'StoryStudioKH/1.0 (idea reference lists)'
const MAX_ITEMS = 500
const MAX_AGE_MS = 7 * 86_400_000
const MIN_GAP_MS = 1000
const MAX_TRIES = 3

export interface ReferenceItem { title: string; description: string; url: string; category: string }
export interface ReferencePool { fetched_at: string; categories: string[]; items: ReferenceItem[] }

export interface ReferenceDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function filePath(slug: string): string | null {
  const dir = pm.getProjectDir(slug)
  return dir ? path.join(dir, REFERENCE_FILE) : null
}

export async function readReferencePool(slug: string): Promise<ReferencePool | null> {
  const file = filePath(slug)
  if (!file || !existsSync(file)) return null
  const pool = await readJsonOr<ReferencePool | null>(file, null)
  return pool && Array.isArray(pool.items) && Array.isArray(pool.categories) ? pool : null
}

/** The category's own head article ("Spices" → "Spice"/"Spices") is too generic to be a subject. */
function isHeadArticle(title: string, category: string): boolean {
  const head = category.replace(/^Category:/, '').toLowerCase()
  const value = title.toLowerCase()
  return value === head || value === head.replace(/e?s$/, '') || `${value}s` === head
}

export function keepArticle(page: { ns?: number; title?: string; pageprops?: Record<string, unknown> }, category: string): boolean {
  const title = page.title || ''
  return (page.ns ?? 0) === 0
    && !!title
    && !/^(list|lists|index|outline|timeline|glossary) of /i.test(title)
    && !/\(disambiguation\)$/i.test(title)
    && !(page.pageprops && 'disambiguation' in page.pageprops)
    && !isHeadArticle(title, category)
}

function articleUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

/**
 * Fetch every category's direct articles (depth 1), politely. Throws when nothing at all could be
 * fetched; a single bad category only adds a note.
 */
async function fetchFromWikipedia(categories: string[], deps: ReferenceDeps, notes: string[]): Promise<{ items: ReferenceItem[]; requests: number }> {
  const doFetch = deps.fetch || fetch
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = deps.now || Date.now
  let last = -Infinity
  let requests = 0
  const get = async (params: Record<string, string>): Promise<any> => {
    const url = `${WIKIPEDIA_API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params })}`
    for (let attempt = 1; ; attempt++) {
      const wait = last + MIN_GAP_MS - now()
      if (wait > 0) await sleep(wait)
      last = now()
      requests++
      const response = await doFetch(url, { headers: { 'User-Agent': WIKIPEDIA_USER_AGENT, 'Api-User-Agent': WIKIPEDIA_USER_AGENT }, signal: AbortSignal.timeout(15_000) })
      if ((response.status === 429 || response.status === 503) && attempt < MAX_TRIES) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2 ** attempt * 1000)
        continue
      }
      if (!response.ok) throw new Error(`Wikipedia answered HTTP ${response.status}`)
      return response.json()
    }
  }
  const items: ReferenceItem[] = []
  const seen = new Set<string>()
  let fetchedAny = false
  let lastError = ''
  for (const category of categories) {
    let found = 0
    let cont: Record<string, string> = {}
    try {
      do {
        const data = await get({
          generator: 'categorymembers', gcmtitle: category, gcmnamespace: '0', gcmlimit: '500',
          prop: 'description|pageprops', ppprop: 'disambiguation', ...cont,
        })
        fetchedAny = true
        for (const page of Array.isArray(data?.query?.pages) ? data.query.pages : []) {
          if (!keepArticle(page, category) || seen.has(page.title.toLowerCase())) continue
          seen.add(page.title.toLowerCase())
          items.push({ title: page.title, description: String(page.description || '').slice(0, 200), url: articleUrl(page.title), category })
          found++
        }
        cont = data?.continue && typeof data.continue === 'object' ? data.continue : {}
      } while (Object.keys(cont).length && items.length < MAX_ITEMS)
      if (!found) notes.push(`${category}: no usable articles`)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      notes.push(`${category}: ${lastError}`)
    }
    if (items.length >= MAX_ITEMS) break
  }
  if (!fetchedAny) throw new Error(lastError || 'Wikipedia could not be reached')
  return { items: items.slice(0, MAX_ITEMS), requests }
}

/**
 * The channel's pool: the cache when it is fresh and for the same categories, else a polite
 * refetch. Never throws. `pool` is null only when there is no cache and nothing could be fetched;
 * `note` says what happened in a sentence fragment for the job log.
 */
export async function getReferencePool(slug: string, categories: string[], options: { force?: boolean; deps?: ReferenceDeps } = {}): Promise<{ pool: ReferencePool | null; note: string; fetched: boolean }> {
  if (!categories.length) return { pool: null, note: 'no Wikipedia categories saved for this channel; nothing fetched', fetched: false }
  const file = filePath(slug)
  if (!file) return { pool: null, note: 'project folder not found', fetched: false }
  const now = options.deps?.now || Date.now
  return withLock(file, async () => {
    const cached = await readReferencePool(slug)
    const sameCategories = !!cached && [...cached.categories].sort().join('\n') === [...categories].sort().join('\n')
    if (cached && sameCategories && !options.force && now() - Date.parse(cached.fetched_at) < MAX_AGE_MS) {
      return { pool: cached, note: `${cached.items.length} Wikipedia articles (cached ${cached.fetched_at.slice(0, 10)})`, fetched: false }
    }
    const notes: string[] = []
    const started = now()
    try {
      const { items, requests } = await fetchFromWikipedia(categories, options.deps || {}, notes)
      const pool: ReferencePool = { fetched_at: new Date(now()).toISOString(), categories, items }
      await writeJsonAtomic(file, pool)
      const seconds = Math.max(1, Math.round((now() - started) / 1000))
      return { pool, note: `fetched ${items.length} Wikipedia articles from ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} in ${requests} request${requests === 1 ? '' : 's'} over ${seconds}s${notes.length ? ` (${notes.join('; ')})` : ''}`, fetched: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return cached
        ? { pool: cached, note: `Wikipedia not reachable (${reason}); using the cached list from ${cached.fetched_at.slice(0, 10)}`, fetched: false }
        : { pool: null, note: `Wikipedia not reachable (${reason}) and nothing is cached`, fetched: false }
    }
  })
}

/** Lower-case words only, for "is this already covered/used?" matching. */
export function subjectKey(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Pool items whose title is not an existing subject, a covered subject, or inside a used title. */
export function unusedReferenceItems(pool: ReferencePool | null, taken: string[], usedTitles: string[] = []): ReferenceItem[] {
  if (!pool) return []
  const takenKeys = new Set(taken.map(subjectKey))
  const titles = usedTitles.map(title => ` ${subjectKey(title)} `)
  return pool.items.filter(item => {
    const key = subjectKey(item.title)
    return key && !takenKeys.has(key) && !titles.some(title => title.includes(` ${key} `))
  })
}

export function sample<T>(values: T[], count: number, random: () => number = Math.random): T[] {
  const out = [...values]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out.slice(0, count)
}
