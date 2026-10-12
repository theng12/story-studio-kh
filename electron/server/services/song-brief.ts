/**
 * Song briefs (SPEC §2.2 rules 2–4): the model writes only the words for cells the coverage
 * planner already reserved; code checks every answer and assembles the Stable Audio prompt.
 *
 * The pure parts (prompt template, title/similarity checks) are exported for tests; the model
 * call is injected (`write`), so nothing here holds an API client of its own.
 */
import type { PlannedCell } from './song-coverage.js'

export const BRIEFS_PER_CALL = 20
/** Songs with lyrics are ~10x longer answers, so fewer per call keeps each answer whole. */
export const SUNG_BRIEFS_PER_CALL = 4

export interface Brief extends PlannedCell {
  title: string
  line: string
  scene_idea: string
  prompt: string
  /** Songs with lyrics only: the sung words, in [Verse]/[Chorus]-style sections. */
  lyrics?: string
  /** Songs with lyrics only: the writer's style line (genre, instruments, singer's voice). */
  style?: string
}

/** One lyric section is sung in about this many seconds (`YUE2_SECONDS_PER_SECTION`). */
export const SECONDS_PER_SECTION = 30
/** Three verses, 3–4 choruses, a bridge and an outro: 8 sections, or 9 with the fourth chorus. */
export const sectionsFor = (length_s: number): number => Math.min(9, Math.max(8, Math.round(length_s / SECONDS_PER_SECTION)))
/**
 * Words a lyric sheet needs for a song of `length_s` (1.4.301). YuE2 stops singing when the words run
 * out: with ~4 short lines per section the 82 fleet samples came out 2:00–4:16 (mostly 2:25–3:15) on a
 * 285 s budget, short of the owner's 3–4 min. ~1.4 sung words per second of song (≈ 300 for 3.5 min).
 */
export const WORDS_PER_SONG_SECOND = 1.4
export const wordsFor = (length_s: number): number => Math.min(350, Math.max(250,
  Math.round(Math.max(60, length_s) * WORDS_PER_SONG_SECOND / 10) * 10))
/** Two output tokens per requested lyric word, plus room for the rest of each structured song row. */
export const minimumLyricsOutputTokens = (cells: readonly PlannedCell[]): number =>
  cells.reduce((total, cell) => total + wordsFor(cell.length_s) * 2 + 256, 0)
const SECTION_LINE = /^\s*\[[^\]\n]+\]\s*$/
const sectionCount = (lyrics: string) => lyrics.split('\n').filter(line => SECTION_LINE.test(line)).length

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
  /** Songs with lyrics: write lyrics and a style line in this language too. Absent = instrumental.
   *  `fixedSinger`: the channel's singer is fixed, so the style line names no voice. */
  lyrics?: { language: string; fixedSinger?: boolean }
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

/** A sung song's prompt: the writer's style line, then the cell's tempo and key (code's facts). */
export function assembleSungPrompt(c: PlannedCell, style: string, maxChars?: number): string {
  const p = `${style.trim()}, ${c.tempo_bpm} BPM, ${c.key}`
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
  b: { title: string; line: string; scene_idea: string; lyrics?: string; style?: string },
  pool: { titles: string[]; lineGrams: Set<string>[]; sceneGrams: Set<string>[] },
  ctx: Pick<BriefContext, 'never' | 'maxTitleWordShare' | 'maxSimilarity'> & { sung?: boolean },
): string {
  const title = b.title.trim()
  if (!title || !b.line.trim() || !b.scene_idea.trim()) return 'the answer was missing a title, line or scene idea'
  if (ctx.sung) {
    if (!b.style?.trim()) return 'the answer was missing the style line'
    if (sectionCount(b.lyrics || '') < 2) return 'the lyrics need at least two [Verse]/[Chorus] sections'
  }
  const all = `${title} ${b.line} ${b.scene_idea} ${b.style || ''} ${b.lyrics || ''}`.toLowerCase()
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

/** Songs with lyrics: the same words, plus original lyrics and a style line the singing model reads. */
const SYSTEM_SUNG = 'You write songs with lyrics for one music channel. Code has already chosen the music of each '
  + 'song; you write: a title (2-6 words, evocative, no numbers), ONE descriptive line about the music (under 30 '
  + 'words), ONE scene idea (one sentence, a picture with no people and no text that matches the song), a style '
  + 'line for the singing model (comma-separated tags: genre, the given ensemble and mood, the singer\'s voice such '
  + 'as "warm female vocal" or "soft male vocal"; under 25 words), and the lyrics: exactly the number of sections '
  + 'asked for, each a line like [Verse], [Chorus], [Bridge] or [Outro] followed by 4–8 singable lines, enough '
  + 'lines to reach the word count asked for (the song ends when the words run out): three verses and a chorus '
  + 'that returns three times in an 8-section sheet or four times in a 9-section sheet, plus one bridge and one '
  + 'outro, no stage directions. Everything must be ORIGINAL: never name or imitate a real artist, '
  + 'band, song, album or label, never quote existing lyrics, and never write "in the style of". Every title must '
  + 'be new: never reuse a title or a title word from the avoid list, and do not repeat a title word inside this '
  + 'batch. Return strict JSON only: {"songs":[{"n":1,"title":"","line":"","scene_idea":"","style":"","lyrics":""}]} '
  + 'with one entry per numbered song, in order; lyrics use \\n between lines.'

export function writerPrompt(
  cells: PlannedCell[], ctx: Pick<BriefContext, 'titles' | 'never' | 'lyrics'>, retryNotes: string[] = [],
): string {
  const avoidTitles = ctx.titles.slice(-200)
  return [
    `Write ${cells.length} songs.`,
    ...(ctx.lyrics ? [`Lyrics language: ${ctx.lyrics.language}.`] : []),
    ...(ctx.lyrics?.fixedSinger ? ['The singer is fixed by the channel: the style line gives genre, instruments and mood only — no voice, singer, gender or vocal words.'] : []),
    ...cells.map((c, i) => `${i + 1}. ${c.ensemble}; ${c.mood}; ${c.tempo_bpm} BPM; ${c.key}; ${c.structure}; ${c.texture}`
      + (c.theme ? `; scene theme: ${c.theme}` : '') + (ctx.lyrics ? `; ${sectionsFor(c.length_s)} lyric sections, about ${wordsFor(c.length_s)} words of lyrics` : '')
      + (retryNotes[i] ? ` — rewrite: ${retryNotes[i]}` : '')),
    '',
    `Never use these words: ${ctx.never.join(', ') || '(none)'}.`,
    `Over-used title words to avoid: ${overusedWords(ctx.titles).join(', ') || '(none)'}.`,
    `Titles already used (avoid): ${avoidTitles.join(' | ') || '(none)'}.`,
  ].join('\n')
}

export function parseWriterAnswer(raw: string, n: number): Array<{ title: string; line: string; scene_idea: string; style?: string; lyrics?: string } | null> {
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
      ...(typeof r.style === 'string' && r.style.trim() ? { style: r.style.trim().slice(0, 300) } : {}),
      ...(typeof r.lyrics === 'string' && r.lyrics.trim() ? { lyrics: r.lyrics.replace(/\r\n?/g, '\n').trim().slice(0, 4000) } : {}),
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
  write: (system: string, user: string, minimumOutputTokens: number) => Promise<string>,
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
  const sung = !!ctx.lyrics
  const accept = (c: PlannedCell, a: { title: string; line: string; scene_idea: string; style?: string; lyrics?: string }) => {
    briefs.push({ ...c, ...a, prompt: sung ? assembleSungPrompt(c, a.style!, ctx.maxPromptChars) : assemblePrompt(c, a.line, ctx.maxPromptChars) })
    pool.titles.push(a.title); pool.lineGrams.push(trigrams(a.line)); pool.sceneGrams.push(trigrams(a.scene_idea))
  }
  const perCall = sung ? SUNG_BRIEFS_PER_CALL : BRIEFS_PER_CALL
  for (let start = 0; start < cells.length; start += perCall) {
    const chunk = cells.slice(start, start + perCall)
    let pending = chunk.map(cell => ({ cell, note: '' }))
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      calls++
      let raw = ''
      try {
        const minimumOutputTokens = sung ? minimumLyricsOutputTokens(pending.map(p => p.cell)) : 0
        raw = await write(sung ? SYSTEM_SUNG : SYSTEM,
          writerPrompt(pending.map(p => p.cell), { titles: pool.titles, never: ctx.never, lyrics: ctx.lyrics }, pending.map(p => p.note)),
          minimumOutputTokens)
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
        const reason = a ? checkBrief(a, pool, { ...ctx, sung }) : 'the model gave no answer for this song'
        if (!reason) accept(p.cell, a!)
        else if (attempt === 0) again.push({ cell: p.cell, note: reason })
        else dropped.push({ cell: p.cell, reason })
      })
      pending = again
    }
    onBatch?.(Math.min(cells.length, start + perCall))
  }
  return { briefs, dropped, calls }
}
