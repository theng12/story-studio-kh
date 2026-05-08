/**
 * Read .docx files and extract structured data.
 * Uses mammoth to convert to HTML, then parses headings/paragraphs.
 */

import mammoth from 'mammoth'
import fs from 'fs/promises'

// ── Image Prompts Parser ────────────────────────────────────────────────────

export interface ParsedPrompts {
  character_reference: string
  scenes: Array<{ number: number; title: string; prompt: string }>
  thumbnails: Array<{ number: number; title: string; prompt: string }>
}

// ── parseImagePromptsDocx memoization ──────────────────────────────────────
//
// `computeEpisodeStatus` calls parseImagePromptsDocx for every accepted
// episode in a project (via getImageStatus + getVideoStatus). At 150+
// episodes that's 300+ docx parses per /projects/:slug/episodes request —
// each one a mammoth HTML conversion (CPU-heavy). Memoize by absolute path
// + mtime so back-to-back calls in one request reuse the parse, while file
// edits on disk still invalidate (mtime changes).
//
// Cache is in-process and reset on app restart. LRU cap protects against
// unbounded growth on huge projects.

const PARSE_CACHE = new Map<string, ParsedPrompts>()
const PARSE_CACHE_MAX = 200

function lruSet(key: string, value: ParsedPrompts): void {
  // Re-insert puts it at the end (LRU recency).
  if (PARSE_CACHE.has(key)) PARSE_CACHE.delete(key)
  PARSE_CACHE.set(key, value)
  while (PARSE_CACHE.size > PARSE_CACHE_MAX) {
    const oldest = PARSE_CACHE.keys().next().value
    if (oldest === undefined) break
    PARSE_CACHE.delete(oldest)
  }
}

function lruGet(key: string): ParsedPrompts | undefined {
  const v = PARSE_CACHE.get(key)
  if (v !== undefined) {
    // Touch — move to most-recently-used position.
    PARSE_CACHE.delete(key)
    PARSE_CACHE.set(key, v)
  }
  return v
}

/** Test/diagnostics helper — clears the parse cache. */
export function _clearImagePromptsParseCache(): void {
  PARSE_CACHE.clear()
}

export async function parseImagePromptsDocx(docxPath: string): Promise<ParsedPrompts> {
  // Cache key includes mtime so external edits invalidate automatically.
  // If stat fails (file missing), fall through to mammoth which will throw
  // a clearer error than we could here.
  let mtimeMs: number | null = null
  try {
    const st = await fs.stat(docxPath)
    mtimeMs = st.mtimeMs
  } catch { /* fall through; cache miss */ }

  const cacheKey = mtimeMs !== null ? `${docxPath}::${mtimeMs}` : null
  if (cacheKey) {
    const hit = lruGet(cacheKey)
    if (hit) return hit
  }

  const result = await mammoth.convertToHtml({ path: docxPath })
  const html = result.value

  // Convert HTML to structured text lines with heading markers
  const lines = htmlToLines(html)

  const parsed: ParsedPrompts = {
    character_reference: '',
    scenes: [],
    thumbnails: [],
  }

  let section: 'none' | 'character' | 'scenes' | 'thumbnails' = 'none'
  let currentScene: { number: number; title: string; prompt: string } | null = null
  let currentThumb: { number: number; title: string; prompt: string } | null = null
  const charLines: string[] = []

  function flushScene() {
    if (currentScene?.prompt) parsed.scenes.push({ ...currentScene })
    currentScene = null
  }
  function flushThumb() {
    if (currentThumb?.prompt) parsed.thumbnails.push({ ...currentThumb })
    currentThumb = null
  }

  for (const line of lines) {
    const text = line.text.trim()
    if (!text) continue
    const lower = text.toLowerCase()

    // Section detection
    if (line.level === 1 || (line.bold && text.length < 120)) {
      if (lower.includes('character reference')) {
        flushScene(); flushThumb(); section = 'character'; continue
      }
      if (lower.includes('thumbnail') && (lower.includes('variant') || lower.includes('prompt'))) {
        flushScene(); flushThumb(); section = 'thumbnails'; continue
      }
      if (lower.includes('scene') && lower.includes('prompt') || lower.includes('chapter scene')) {
        flushScene(); flushThumb(); section = 'scenes'; continue
      }
    }

    if (section === 'character') {
      charLines.push(text)
    } else if (section === 'scenes') {
      const sceneMatch = text.match(/^Scene\s+(\d+)\s*[:\-–—]\s*(.+)$/i)
      if (sceneMatch || (line.level === 2 && /scene\s+\d+/i.test(lower))) {
        flushScene()
        const num = sceneMatch ? parseInt(sceneMatch[1]) : (parsed.scenes.length + 1)
        const title = sceneMatch ? sceneMatch[2].trim() : text.replace(/^Scene\s+\d+\s*[:\-–—]?\s*/i, '')
        currentScene = { number: num, title, prompt: '' }
      } else if (currentScene) {
        currentScene.prompt += (currentScene.prompt ? ' ' : '') + text
      }
    } else if (section === 'thumbnails') {
      const thumbMatch = text.match(/^(\d+)\.\s+(.+)$/) || text.match(/^Thumbnail\s+(?:Option\s+)?(\d+)/i)
      if (thumbMatch || (line.level === 2 && /\d/.test(text) && text.length < 80)) {
        flushThumb()
        const num = thumbMatch ? parseInt(thumbMatch[1]) : (parsed.thumbnails.length + 1)
        const title = thumbMatch ? (thumbMatch[2] || `Thumbnail ${num}`) : text
        currentThumb = { number: num, title, prompt: '' }
      } else if (currentThumb) {
        currentThumb.prompt += (currentThumb.prompt ? ' ' : '') + text
      }
    }
  }

  flushScene()
  flushThumb()
  parsed.character_reference = charLines.join('\n')

  if (cacheKey) lruSet(cacheKey, parsed)
  return parsed
}

// ── Narration Parser ────────────────────────────────────────────────────────

export interface NarrationSection {
  label: string
  slug: string
  text: string
  /** Descriptive title parsed from the docx heading. For chapter sections
   *  ("## Chapter 03: The Whispering Forest") this is the part AFTER the
   *  "Chapter NN:" prefix ("The Whispering Forest"). Empty for sections
   *  whose heading is just the label ("Introduction", "Section 01"). The
   *  /chapter-list and /chapters/:n/content routes use this to surface
   *  per-chapter titles without a second mammoth round-trip. */
  title?: string
}

export async function parseNarrationDocx(docxPath: string): Promise<NarrationSection[]> {
  const result = await mammoth.convertToHtml({ path: docxPath })
  const lines = htmlToLines(result.value)

  const sections: NarrationSection[] = []
  let currentLabel: string | null = null
  let currentSlug: string | null = null
  let currentTitle: string | undefined
  let currentLines: string[] = []
  const storyLines: string[] = []

  function flush() {
    if (currentLabel && currentLines.length) {
      const text = currentLines.join('\n\n').trim()
      if (text) sections.push({ label: currentLabel, slug: currentSlug!, text, title: currentTitle })
    }
  }

  for (const line of lines) {
    const text = line.text.trim()
    if (!text) continue
    const lower = text.toLowerCase()

    // Introduction marker
    if ((line.level === 1 || lower === 'introduction') && !sections.length && !currentLabel) {
      flush(); currentLines = []; currentLabel = 'Introduction'; currentSlug = 'Introduction'; currentTitle = undefined
      continue
    }

    // Narration marker (skip)
    if ((line.level === 1 || line.bold) && lower.includes('narration')) {
      flush(); currentLines = []; currentLabel = null; currentSlug = null; currentTitle = undefined
      continue
    }

    // Chapter N: Title
    const chapterMatch = text.match(/^Chapter\s+(\d+)\s*[:\-–—]\s*(.*)$/i)
    if (line.level === 2 && chapterMatch) {
      flush(); currentLines = []
      const num = parseInt(chapterMatch[1])
      const titlePart = (chapterMatch[2] || '').trim()
      currentLabel = `Chapter ${num.toString().padStart(2, '0')}`
      currentSlug = `Chapter_${num.toString().padStart(2, '0')}`
      currentTitle = titlePart || undefined
      continue
    }

    // Roman numeral sections
    if ((line.level === 2 || line.bold) && /^[IVXLCDM]+\.?$/.test(text) && text.length < 10) {
      flush(); currentLines = []
      const sectionNum = sections.filter(s => s.slug.startsWith('Section_')).length + 1
      currentLabel = `Section ${sectionNum.toString().padStart(2, '0')}`
      currentSlug = `Section_${sectionNum.toString().padStart(2, '0')}`
      currentTitle = undefined
      continue
    }

    if (currentLabel) {
      currentLines.push(text)
    } else {
      storyLines.push(text)
    }
  }

  flush()

  // Fallback for unstructured narration
  if (storyLines.length) {
    const fullText = storyLines.join('\n\n').trim()
    if (fullText.length > 200) {
      sections.push({ label: 'Narration', slug: 'Narration', text: fullText })
    }
  }

  return sections
}

// ── Round-trip helpers (docx → markdown source) ────────────────────────────

/**
 * Convert a narration `.docx` back into the `# / ##` markdown-source format
 * that `buildNarrationDocx()` consumes. Used by the introduction merger so
 * we can splice an intro into an existing chapters file without losing
 * chapter titles or paragraph structure.
 *
 * Heading levels round-trip:
 *   <h1>X</h1>  →  `# X`
 *   <h2>X</h2>  →  `## X`
 *   <p>X</p>    →  `X` (with a blank line between paragraphs)
 *
 * Title/subtitle paragraphs that buildNarrationDocx adds for branding
 * (the episode code line in italics) are detectable by an empty heading
 * level and italicised text — but htmlToLines already drops empty lines,
 * so they pass through as plain paragraphs. The `# Introduction` /
 * `# {title} — Narration` / `## Chapter N: …` markers we write back are
 * what the parser cares about, so this round-trip preserves the
 * structural skeleton even if the doc gets re-rendered.
 */
export async function narrationDocxToMarkdown(docxPath: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: docxPath })
  const lines = htmlToLines(result.value)
  const out: string[] = []
  for (const line of lines) {
    if (line.level === 1) out.push(`# ${line.text}`)
    else if (line.level === 2) out.push(`## ${line.text}`)
    else out.push(line.text)
    // Blank line between blocks so paragraphs survive the
    // markdown → docx pass in buildNarrationDocx.
    out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Strip the leading Introduction block from a narration markdown source.
 * Used by `generateIntroductionOnly` so re-runs replace the prior intro
 * instead of stacking. Matches the `# Introduction` heading the original
 * generator emits, plus any `# {title} — Narration` separator that
 * `narrationPrompt` writes between intro and chapters; everything before
 * the first chapter heading is discarded.
 *
 * Returns the chapters portion only (starts at the first `## Chapter`).
 * If the source has no chapter heading the original is returned unchanged
 * (defensive — the caller should treat that as "nothing to merge into").
 */
export function stripIntroFromNarrationMarkdown(markdown: string): string {
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Chapter\b/i.test(lines[i].trim())) {
      return lines.slice(i).join('\n').trim()
    }
  }
  return markdown
}

// ── HTML to structured lines ────────────────────────────────────────────────

interface StructuredLine {
  text: string
  level: number // 0=normal, 1=h1, 2=h2
  bold: boolean
}

function htmlToLines(html: string): StructuredLine[] {
  const lines: StructuredLine[] = []

  // Simple HTML tag parser
  const tagRegex = /<(h[1-6]|p|strong|b|\/h[1-6]|\/p|\/strong|\/b)(?:\s[^>]*)?>|([^<]+)/gi
  let currentLevel = 0
  let currentBold = false
  let currentText = ''

  const flushLine = () => {
    const text = currentText.replace(/\s+/g, ' ').trim()
    if (text) lines.push({ text, level: currentLevel, bold: currentBold })
    currentText = ''
  }

  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(html)) !== null) {
    if (match[1]) {
      const tag = match[1].toLowerCase()
      if (tag.startsWith('h') && !tag.startsWith('/')) {
        flushLine()
        currentLevel = parseInt(tag[1]) <= 1 ? 1 : 2
      } else if (tag.startsWith('/h')) {
        flushLine()
        currentLevel = 0
      } else if (tag === 'p') {
        flushLine()
      } else if (tag === '/p') {
        flushLine()
      } else if (tag === 'strong' || tag === 'b') {
        currentBold = true
      } else if (tag === '/strong' || tag === '/b') {
        currentBold = false
      }
    } else if (match[2]) {
      currentText += match[2]
    }
  }
  flushLine()

  return lines
}
