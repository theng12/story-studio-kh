/**
 * Song briefs (SPEC §2.2 rules 2–4): the model writes only the words for cells the coverage
 * planner already reserved; code checks every answer and assembles the Stable Audio prompt.
 *
 * The pure parts (prompt template, title/similarity checks) are exported for tests; the model
 * call is injected (`write`), so nothing here holds an API client of its own.
 */
import type { PlannedCell } from './song-coverage.js'

export const BRIEFS_PER_CALL = 20

export interface Brief extends PlannedCell {
  title: string
  line: string
  scene_idea: string
  prompt: string
}

export interface BriefContext {
  /** Titles / lines / scene ideas already in the pool (every song, not only drawable). */
  titles: string[]
  lines: string[]
  sceneIdeas: string[]
  never: string[]
  maxTitleWordShare: number
  maxSimilarity: number
  /** The music model's published prompt ceiling, read live. Absent = not stated. */
  maxPromptChars?: number
}

const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'and', 'to', 'for', 'with', 'by', 'from', 'over', 'under', 'after', 'before', 'into', 'is', 'my', 'our', 'its'])

export const normTitle = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export const titleWords = (t: string) => [...new Set(normTitle(t).split(' ').filter(w => w && !STOP.has(w)))]

export function trigrams(text: string): Set<string> {
  const s = ` ${normTitle(text)} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3))
  return out
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const g of a) if (b.has(g)) common++
  return common / (a.size + b.size - common)
}

/** SPEC §2.2 rule 4 — tag-style, because that is what Stable Audio follows best. */
export function assemblePrompt(c: PlannedCell, line: string, maxChars?: number): string {
  const p = `${c.ensemble}, ${c.mood}, ${c.texture}, ${c.structure}, ${c.tempo_bpm} BPM, ${c.key}. ${line.trim()}`
  return maxChars && maxChars > 0 ? p.slice(0, maxChars) : p
}

/** The 15 most over-used title words — sent to the model as an "avoid" list. */
export function overusedWords(titles: string[], top = 15): string[] {
  const n = new Map<string, number>()
  for (const t of titles) for (const w of titleWords(t)) n.set(w, (n.get(w) || 0) + 1)
  return [...n.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([w]) => w)
}

/**
 * Check one answer against the pool and the briefs accepted so far in this batch.
 * Returns the reason it fails, or '' when it passes.
 */
export function checkBrief(
  b: { title: string; line: string; scene_idea: string },
  pool: { titles: string[]; lineGrams: Set<string>[]; sceneGrams: Set<string>[] },
  ctx: Pick<BriefContext, 'never' | 'maxTitleWordShare' | 'maxSimilarity'>,
): string {
  const title = b.title.trim()
  if (!title || !b.line.trim() || !b.scene_idea.trim()) return 'the answer was missing a title, line or scene idea'
  const all = `${title} ${b.line} ${b.scene_idea}`.toLowerCase()
  for (const word of ctx.never) {
    const w = word.trim().toLowerCase()
    if (w && new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(all)) return `it used "${word}", which the formula never allows`
  }
  const nt = normTitle(title)
  if (pool.titles.some(t => normTitle(t) === nt)) return `the title "${title}" is already in the pool`
  // A floor of 2 so a brand-new pool is not forced to drop briefs over one shared word.
  const allowed = Math.max(2, Math.floor(ctx.maxTitleWordShare * (pool.titles.length + 1)))
  for (const w of titleWords(title)) {
    const used = pool.titles.filter(t => titleWords(t).includes(w)).length
    if (used + 1 > allowed) return `the title word "${w}" is already in ${used} titles`
  }
  const lg = trigrams(b.line)
  if (pool.lineGrams.some(g => similarity(lg, g) > ctx.maxSimilarity)) return 'the descriptive line reads like one already in the pool'
  const sg = trigrams(b.scene_idea)
  if (pool.sceneGrams.some(g => similarity(sg, g) > ctx.maxSimilarity)) return 'the scene idea reads like one already in the pool'
  return ''
}

const SYSTEM = 'You write short words for instrumental songs on one music channel. Code has already chosen '
  + 'the music of each song; you write only: a title (2-6 words, evocative, no numbers), ONE descriptive line '
  + 'about the music (under 30 words: melody, shape, colour — concrete, no emotions alone), and ONE scene idea '
  + '(one sentence, a picture with no people and no text that matches the song and its theme). '
  + 'Every title must be new: never reuse a title or a title word from the avoid list, and do not repeat a '
  + 'title word inside this batch. Return strict JSON only: {"songs":[{"n":1,"title":"","line":"","scene_idea":""}]} '
  + 'with one entry per numbered song, in order.'

export function writerPrompt(cells: PlannedCell[], ctx: Pick<BriefContext, 'titles' | 'never'>, retryNotes: string[] = []): string {
  const avoidTitles = ctx.titles.slice(-200)
  return [
    `Write ${cells.length} songs.`,
    ...cells.map((c, i) => `${i + 1}. ${c.ensemble}; ${c.mood}; ${c.tempo_bpm} BPM; ${c.key}; ${c.structure}; ${c.texture}`
      + (c.theme ? `; scene theme: ${c.theme}` : '') + (retryNotes[i] ? ` — rewrite: ${retryNotes[i]}` : '')),
    '',
    `Never use these words: ${ctx.never.join(', ') || '(none)'}.`,
    `Over-used title words to avoid: ${overusedWords(ctx.titles).join(', ') || '(none)'}.`,
    `Titles already used (avoid): ${avoidTitles.join(' | ') || '(none)'}.`,
  ].join('\n')
}

export function parseWriterAnswer(raw: string, n: number): Array<{ title: string; line: string; scene_idea: string } | null> {
  let parsed: any
  try {
    parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''))
  } catch {
    return Array.from({ length: n }, () => null)
  }
  const rows: any[] = Array.isArray(parsed?.songs) ? parsed.songs : []
  return Array.from({ length: n }, (_, i) => {
    const r = rows.find(x => Number(x?.n) === i + 1) ?? rows[i]
    if (!r || typeof r.title !== 'string') return null
    return {
      title: String(r.title).trim().slice(0, 80),
      line: String(r.line || '').trim().slice(0, 400),
      scene_idea: String(r.scene_idea || '').trim().slice(0, 400),
    }
  })
}

export interface WriteResult { briefs: Brief[]; dropped: Array<{ cell: PlannedCell; reason: string }>; calls: number }

/**
 * Write briefs for `cells`, 20 per call; a failing answer is rewritten once, then dropped
 * and reported. `write(system, user)` is the model call (the picked writing model).
 */
export async function writeBriefs(
  cells: PlannedCell[],
  ctx: BriefContext,
  write: (system: string, user: string) => Promise<string>,
  onBatch?: (done: number) => void,
): Promise<WriteResult> {
  const pool = {
    titles: [...ctx.titles],
    lineGrams: ctx.lines.map(trigrams),
    sceneGrams: ctx.sceneIdeas.map(trigrams),
  }
  const briefs: Brief[] = []
  const dropped: WriteResult['dropped'] = []
  let calls = 0
  const accept = (c: PlannedCell, a: { title: string; line: string; scene_idea: string }) => {
    briefs.push({ ...c, ...a, prompt: assemblePrompt(c, a.line, ctx.maxPromptChars) })
    pool.titles.push(a.title); pool.lineGrams.push(trigrams(a.line)); pool.sceneGrams.push(trigrams(a.scene_idea))
  }
  for (let start = 0; start < cells.length; start += BRIEFS_PER_CALL) {
    const chunk = cells.slice(start, start + BRIEFS_PER_CALL)
    let pending = chunk.map(cell => ({ cell, note: '' }))
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      calls++
      let raw = ''
      try {
        raw = await write(SYSTEM, writerPrompt(pending.map(p => p.cell), { titles: pool.titles, never: ctx.never }, pending.map(p => p.note)))
      } catch (error) {
        if (attempt === 1) {
          const why = `the writing model failed (${error instanceof Error ? error.message : String(error)})`
          for (const p of pending) dropped.push({ cell: p.cell, reason: why })
          pending = []
        }
        continue
      }
      const answers = parseWriterAnswer(raw, pending.length)
      const again: typeof pending = []
      pending.forEach((p, i) => {
        const a = answers[i]
        const reason = a ? checkBrief(a, pool, ctx) : 'the model gave no answer for this song'
        if (!reason) accept(p.cell, a!)
        else if (attempt === 0) again.push({ cell: p.cell, note: reason })
        else dropped.push({ cell: p.cell, reason })
      })
      pending = again
    }
    onBatch?.(Math.min(cells.length, start + BRIEFS_PER_CALL))
  }
  return { briefs, dropped, calls }
}
