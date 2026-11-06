/**
 * Subject-word check for style_bible and description texts.
 *
 * A style says how things are drawn, never what to draw. This module
 * scans style_bible (hard fail) and description (warning only) for
 * words that imply a subject, prop, place, era, genre, or mood that
 * pins a scene. The word list lives in subject-words.json and is
 * editable. Per-pack allow entries carry a reason so no rule is
 * hard-coded without a deliberate way out.
 *
 * Colour names such as "bone white" are safe and listed as compounds
 * so the shorter token "bone" does not false-flag inside them.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

let cachedConfig = null

export async function loadSubjectConfig() {
  if (cachedConfig) return cachedConfig
  const bytes = await readFile(resolve(MODULE_DIR, 'subject-words.json'), 'utf8')
  cachedConfig = JSON.parse(bytes)
  return cachedConfig
}

/**
 * Build a case-insensitive regex for a token, matching on a word boundary
 * where applicable. Hyphenated and multi-word tokens are matched literally
 * (with s/m) so "martial-arts" catches "martial-arts" and "martial arts".
 * An optional trailing "s" catches plurals like "bones" for "bone".
 */
function tokenRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-zA-Z])${escaped}s?(?![a-zA-Z])`, 'gi')
}

/**
 * Find the sentence in `text` that contains the character at `offset`.
 * Sentences are delimited by '.', '!' or '?' followed by whitespace or
 * end of string, or by a newline. Returns a trimmed sentence string.
 */
function findSentence(text, offset) {
  let start = offset
  while (start > 0) {
    const ch = text[start - 1]
    if ((ch === '.' || ch === '!' || ch === '?') && (text[start] === ' ' || text[start] === '\n' || start === offset)) {
      break
    }
    if (ch === '\n') break
    start--
  }
  let end = offset
  while (end < text.length) {
    const ch = text[end]
    if ((ch === '.' || ch === '!' || ch === '?') && (end + 1 >= text.length || text[end + 1] === ' ' || text[end + 1] === '\n')) {
      end++
      break
    }
    if (ch === '\n') break
    end++
  }
  return text.slice(start, end).trim()
}

/**
 * Pattern for a bare colour name in a palette list. Live styles write colour
 * swatches as "slate green, bone, ochre" — a colour word with no noun attached
 * is how a palette is written, not a named subject. A colour name that leads a
 * phrase with no noun ("bone in the foreground") is not matched by this.
 */
const PALETTE_COLOUR_WORDS = new Set(['bone', 'ivory', 'ochre', 'amber', 'sepia', 'umber', 'slate', 'teal', 'crimson', 'russet', 'pewter', 'charcoal'])

function isBareColourWord(text, index, matched) {
  const word = matched.toLowerCase()
  if (!PALETTE_COLOUR_WORDS.has(word)) return false
  // "a bone" and "bones" are things; a swatch has no article and no plural.
  if (/\b(?:a|an|the)\s+$/i.test(text.slice(0, index))) return false
  // A swatch ends the phrase: "bone, ochre", "bone; every shadow", "bone and charcoal".
  // "bone of the leg" and "bone and the skull" go on to name a thing.
  const after = text.slice(index + matched.length)
  return /^\s*(?:$|[,;:.!?)\u2014-]|(?:and|or)\s+(?!(?:a|an|the|its|his|her|their)\b))/i.test(after)
}

/**
 * Scan `text` for subject words. Returns an array of findings, each with
 * { word, kind, sentence }. Compounds are checked first so their inner
 * tokens are masked (replaced with spaces of equal length) before the
 * single-word scan runs. Bare palette colour words are skipped.
 */
export function scanText(text, config) {
  if (!text || typeof text !== 'string') return []
  const findings = []
  let masked = text

  // Mask compounds first so inner words don't false-flag.
  for (const compound of config.compounds || []) {
    const rx = tokenRegex(compound)
    masked = masked.replace(rx, match => ' '.repeat(match.length))
  }

  // Scan single words.
  for (const entry of config.words || []) {
    const rx = tokenRegex(entry.word)
    let match
    while ((match = rx.exec(masked)) !== null) {
      if (isBareColourWord(text, match.index, match[0])) continue
      findings.push({
        word: entry.word,
        kind: entry.kind,
        sentence: findSentence(text, match.index),
      })
    }
  }

  return findings
}

/**
 * Check whether a pack_id is allowed to carry a specific word.
 * An allow entry must have a reason — no silent bypass.
 */
function isAllowed(config, packId, word) {
  if (!config.allows || !Array.isArray(config.allows)) return false
  return config.allows.some(
    entry => entry.pack_id === packId && entry.word === word && typeof entry.reason === 'string' && entry.reason.length > 0,
  )
}

/**
 * Run the subject check on a parsed content pack's documents.
 *
 * - style_bible findings are hard failures (returned in `failures`).
 * - description findings are warnings (returned in `warnings`).
 * - Allowed entries suppress a failure for a specific pack_id + word.
 *
 * Returns { failures: [...], warnings: [...] }.
 */
export async function checkStylePack(documents, packId) {
  const config = await loadSubjectConfig()
  const failures = []
  const warnings = []

  for (const doc of documents) {
    if (doc.kind !== 'visual-style') continue
    const styleId = doc.id || '(unknown)'

    // style_bible: hard fail
    if (doc.style_bible) {
      const found = scanText(doc.style_bible, config)
      for (const f of found) {
        if (isAllowed(config, packId, f.word)) continue
        failures.push({
          styleId,
          field: 'style_bible',
          word: f.word,
          kind: f.kind,
          sentence: f.sentence,
        })
      }
    }

    // description: warning only
    if (doc.description) {
      const found = scanText(doc.description, config)
      for (const f of found) {
        warnings.push({
          styleId,
          field: 'description',
          word: f.word,
          kind: f.kind,
          sentence: f.sentence,
        })
      }
    }
  }

  return { failures, warnings }
}

/**
 * Format failures into a human-readable error message for the build log.
 */
export function formatSubjectFailures(failures) {
  if (failures.length === 0) return ''
  const lines = ['Style subject check failed — a style_bible must not name subjects:']
  for (const f of failures) {
    lines.push(`  ${f.styleId} [${f.field}]: "${f.word}" (${f.kind})`)
    lines.push(`    ${f.sentence}`)
  }
  lines.push('Add an allow entry in subject-words.json with a reason, or remove the subject word from the style text.')
  return lines.join('\n')
}

/**
 * Format warnings for the build log (does not stop the build).
 */
export function formatSubjectWarnings(warnings) {
  if (warnings.length === 0) return ''
  const lines = ['Style subject check warnings (description may name what a style suits):']
  for (const w of warnings) {
    lines.push(`  ${w.styleId} [${w.field}]: "${w.word}" (${w.kind})`)
  }
  return lines.join('\n')
}