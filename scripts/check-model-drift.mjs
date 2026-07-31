/**
 * Model-drift guard — enforces AGENTS.md "Everything Follows the Selected Model".
 *
 * GenStudio publishes what each product can do. Story Studio reads it live. The
 * failure mode this catches is the one that keeps recurring: somebody in a hurry
 * copies a published value into application code — a product id, a price, a
 * context window, an option list — and from that moment the app lies whenever the
 * catalogue changes.
 *
 * The check is a source grep, the same shape as check-typography.mjs and
 * check-production-security.mjs. It reads application code only; test fixtures,
 * mocks and contract tests are deliberately out of scope because pinning a
 * literal is exactly what they are for.
 *
 * A literal that is legitimately frozen is allowed with a single greppable
 * annotation on the same line or the line above:
 *
 *   // model-drift-allow: <why this literal may never follow the catalogue>
 *
 * The justification is mandatory and must be a real sentence. Audit every
 * exception at once with `grep -rn "model-drift-allow" electron frontend`.
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import process from 'node:process'

const repoRoot = resolve(import.meta.dirname, '..')
const sourceExtensions = new Set(['.ts', '.vue', '.mjs', '.js'])
const skippedDirectories = new Set(['node_modules', 'dist', '__tests__', '.nuxt', '.output', 'archive'])

/** Application code only. Tests, fixtures and mocks pin literals on purpose. */
const scanRoots = [
  'electron/main.ts',
  'electron/boot-env.ts',
  'electron/server',
  'frontend/app.vue',
  'frontend/components',
  'frontend/composables',
  'frontend/layouts',
  'frontend/middleware',
  'frontend/pages',
  'frontend/plugins',
  'frontend/types',
  'frontend/utils',
]

const ALLOW_ANNOTATION = 'model-drift-allow'
const MINIMUM_JUSTIFICATION_WORDS = 4

/**
 * Module specifiers are file paths, not catalogue values. Matched on what
 * precedes the string — NOT on the line starting with `import`/`export`, which
 * would blind the guard to `export const MODEL = 'gpt-4o'`.
 */
const MODULE_SPECIFIER_CONTEXT = /\b(?:from|import|require)\s*\(?\s*$/

/**
 * Story Studio's OWN identifiers, not catalogue products.
 *
 * `genstudio-chat` / `genstudio-image` / … are provider-registry keys: the
 * transport a request travels over. The three `genstudio-tts-regular|premium|
 * clone` voice-tier tokens are gone: the customer now picks a real GenStudio
 * TTS model from `/v1/tts/models` and is charged by it, so there is no Story-
 * owned speech token left to exempt. A real product id such as
 * `genstudio-qwen3-standard` is NOT exempt.
 */
const STORY_OWNED_IDENTIFIERS = new RegExp(
  '^genstudio-(?:'
  + 'chat|image|video|audio|tts|speech|transcription|subtitles|client|runtime|relaxed|llm|web'
  + ')$',
)

/**
 * Voice Studio runs models locally on this Mac and owns its own on-device
 * inventory; the GenStudio catalogue has no authority over it. Its family tags
 * and Hugging Face repo paths are not catalogue values.
 */
const LOCAL_RUNNER_FILES = new Set(['electron/server/lib/voicestudio-client.ts'])
const LOCAL_RUNNER_ID = /^voicestudio-|\//

/** DOM plumbing: a CSS class, element id, anchor or header name is not a model. */
const DOM_ATTRIBUTE_CONTEXT = /(?:^|\s)(?::?class|:?id|for|href|:?to|name|aria-[\w-]+|data-[\w-]+)\s*=\s*["'`][^"'`]*$/

/**
 * Money-shaped name parts. Deliberately narrow: `rate` is excluded because
 * sample rates, bit rates and frame rates are Story Studio's own ffmpeg
 * business and have nothing to do with the catalogue, and `per_image` alone is
 * excluded because a slideshow's `seconds_per_image` is not a price.
 */
const PRICE_NAME_PARTS = [
  'credits?', 'price', 'pricing', 'cost', 'usd',
  'per_?million_?tokens', 'per_?1000_?characters', 'per_?1k_?chars',
].join('|')

/** Units that make a "cost"-shaped name a duration, not money. */
const NON_MONETARY_UNIT_SUFFIX = /(?:_?ms|_?millis|_?sec|_?seconds|_?interval|_?timeout|_?delay|_?poll(?:_?ms)?)$/i

/** Fields GenStudio publishes. A numeric literal here fabricates a catalogue row. */
const PUBLISHED_LIMIT_FIELDS = [
  'context_window_tokens', 'max_output_tokens', 'max_input_tokens', 'max_prompt_characters',
  'max_reference_images', 'min_reference_images', 'max_image_dimension',
].join('|')

/** The same fields in any casing, for the `?? <literal>` fallback rule. */
const PUBLISHED_VALUE_NAMES = [
  'context_?window\\w*', 'max_?output_?tokens', 'max_?input_?tokens', 'max_?prompt_?characters',
  'max_?reference_?images', 'min_?reference_?images', 'max_?image_?dimension',
  'credits_?per_?\\w+', 'base_?credits_?per_?\\w+', 'aspect_?ratios?', 'resolutions?',
].join('|')

const COST_VOCABULARY = /\b(cost|costs|price|pricing|priced|credit|credits|usd|dollar|dollars|estimate|estimated|spend|spent|bill|billed|billing|charge|charged)\b/i

/**
 * Every rule names the file, the literal, why it is forbidden, and the
 * published field to read instead. A guard whose message does not teach gets
 * annotated away by the next person in a hurry.
 */
const rules = [
  {
    id: 'product-identifier',
    // Provider/product ids as literals. The catalogue is the only source of a
    // model id; a name in code outlives the product it names.
    pattern: new RegExp(
      String.raw`\b(` + [
        String.raw`gpt-[0-9][\w.-]*`,
        String.raw`chatgpt-[\w.-]+`,
        String.raw`o[1-4]-(?:mini|preview|pro)[\w.-]*`,
        String.raw`claude-(?:[0-9]|opus|sonnet|haiku|instant)[\w.-]*`,
        String.raw`gemini-[0-9][\w.-]*`,
        String.raw`dall-e-[0-9]`,
        String.raw`imagen-[0-9][\w.-]*`,
        String.raw`flux[-.](?:1|dev|pro|schnell|kontext)[\w.-]*`,
        String.raw`seedream[-.]?[0-9][\w.-]*`,
        String.raw`seedance[-.]?[\w.-]*`,
        String.raw`nano-banana[\w.-]*`,
        String.raw`kling[-_]?v?[0-9][\w.-]*`,
        String.raw`veo-?[0-9][\w.-]*`,
        String.raw`sora-?[0-9][\w.-]*`,
        String.raw`runway[-_]?gen-?[0-9][\w.-]*`,
        String.raw`wan-?2[\w.-]*`,
        String.raw`hailuo[-_]?[\w.-]*`,
        String.raw`whisper-[0-9][\w.-]*`,
        String.raw`eleven[-_](?:v[0-9]|multilingual|turbo|flash)[\w.-]*`,
        String.raw`qwen[0-9]?-[\w.-]+`,
        String.raw`(?<![\w-])genstudio-[a-z0-9][\w.-]*`,
      ].join('|') + String.raw`)\b`,
      'gi',
    ),
    stringLiteralsOnly: true,
    skipContext: [MODULE_SPECIFIER_CONTEXT, DOM_ATTRIBUTE_CONTEXT],
    ignore: (match, context) => STORY_OWNED_IDENTIFIERS.test(match[0])
      // `GenStudio-only` in a sentence is prose; product ids are lower-case.
      || (/^genstudio-/i.test(match[0]) && !/^genstudio-/.test(match[0]))
      || LOCAL_RUNNER_FILES.has(context.file)
      || LOCAL_RUNNER_ID.test(context.enclosingString)
      || context.precedingCharacter === '#',
    describe: (match) => `product identifier "${match[0]}" is written into application code`,
    remedy: 'Resolve the id from the live GenStudio catalogue (listChatModels / listImageModels / '
      + 'listVideoModels / listVoices) or from the persisted user SELECTION. A literal id keeps '
      + 'pointing at a product after GenStudio retires, renames or reprices it.',
  },
  {
    id: 'price-literal',
    // A number attached to a price/credit-shaped name. Prices move; a copied
    // one bills the customer a figure the catalogue no longer publishes.
    pattern: new RegExp(
      String.raw`\b([\w$]*(?:` + PRICE_NAME_PARTS + String.raw`)[\w$]*)\s*(?::|=(?!=))\s*(-?\d[\d_]*(?:\.\d+)?)\b`,
      'gi',
    ),
    ignore: (match, context) => NON_MONETARY_UNIT_SUFFIX.test(match[1])
      // A model that runs on this Mac costs no credits by construction.
      || LOCAL_RUNNER_FILES.has(context.file),
    describe: (match) => `${match[1]} is assigned the literal ${match[2]}`,
    remedy: 'Read the published figure instead — credits_per_image / credits_per_second / '
      + 'credits_per_1000_characters / credits_per_million_tokens / credits_per_video and the '
      + 'promotion and chargeable flags beside them. Story Studio never states a price of its own.',
  },
  {
    id: 'catalogue-field-literal',
    // A field GenStudio publishes, given a number here. That is not a limit
    // being respected — it is a catalogue row being fabricated.
    pattern: new RegExp(String.raw`\b(` + PUBLISHED_LIMIT_FIELDS + String.raw`)\s*:\s*(-?\d[\d_]*(?:\.\d+)?)\b`, 'g'),
    describe: (match) => `${match[1]} — a field GenStudio publishes — is written as the literal ${match[2]}`,
    remedy: 'Read the field from the selected product and recompute everything derived from it. '
      + 'A static ceiling silently caps a model that publishes a larger one (a 32,768 output '
      + 'ladder against a published 128,000 shipped once already).',
  },
  {
    id: 'published-value-fallback',
    // `?? 2048` on a published field is the invented fallback AGENTS.md names
    // explicitly: a number the customer will mistake for the model's own.
    pattern: new RegExp(
      String.raw`\b([\w$.?]*(?:` + PUBLISHED_VALUE_NAMES + String.raw`))\s*(?:\?\?|\|\|)\s*(-?\d[\d_]*(?:\.\d+)?)\b`,
      'gi',
    ),
    // A `min_*` field defaulting to 0 states no constraint, which is exactly
    // what an unpublished minimum means. A price or ceiling of 0 is a claim.
    ignore: (match) => /(^|[._])min_?/i.test(match[1]) && Number(match[2].replace(/_/g, '')) === 0,
    describe: (match) => `${match[1]} falls back to the invented literal ${match[2]}`,
    remedy: 'When GenStudio publishes nothing, show nothing, disable the control, or fail loudly. '
      + 'Never substitute a number of your own — the customer cannot tell it apart from the '
      + 'model\'s real figure.',
  },
  {
    id: 'capability-list',
    // An option list written locally instead of generated from the catalogue.
    pattern: /\[[^\][\n]*(['"])(\d{1,2}:\d{1,2}|\d{3,4}p|[24]k)\1[^\][\n]*\]/gi,
    minimumDistinctOptions: 2,
    describe: (match) => `a published option list is written locally: ${match[0].trim()}`,
    remedy: 'Generate aspect ratios, resolutions, durations, modes, voice tiers and output '
      + 'formats from the selected product\'s published option lists. A local list offers the '
      + 'customer choices the model does not have, and hides the ones it does.',
  },
  {
    id: 'currency-symbol',
    // Story Studio bills in credits. A dollar figure in a cost string is always
    // wrong — it was computed from rates this app is not allowed to know.
    pattern: /\$\$\{|\$\s?\d|\bUSD\b/g,
    requireLineMatch: COST_VOCABULARY,
    stringLiteralsOnly: true,
    // A bare `'USD'` is a currency CODE carried through from an upstream
    // payload; only a rendered amount is a cost string Story Studio authored.
    ignore: (match, context) => /^usd$/i.test(match[0]) && !/[\s{]/.test(context.enclosingString),
    describe: (match) => `a currency amount "${match[0].trim()}" appears in a cost string`,
    remedy: 'Story Studio bills in credits and never in dollars. Show the published credit cost. '
      + 'A dollar figure can only have come from a per-token rate hardcoded here (one shipped and '
      + 'was removed in v1.0.770).',
  },
]

async function collectFiles(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') || skippedDirectories.has(entry.name)) continue
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath))
    else if (sourceExtensions.has(extname(entry.name))) files.push(entryPath)
  }

  return files
}

/**
 * Blanks comments while preserving every byte offset, so a literal quoted in
 * documentation cannot fail the build and line numbers stay exact. Returns the
 * blanked source plus the spans of every string literal, because several rules
 * only mean anything inside a string.
 */
function stripComments(source) {
  const out = source.split('')
  const stringSpans = []
  let index = 0
  let previousMeaningful = ''

  const blank = (from, to) => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (out[cursor] !== '\n') out[cursor] = ' '
    }
  }

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      blank(index, end === -1 ? source.length : end)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '<' && source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      const stop = end === -1 ? source.length : end + 3
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = index
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue }
        if (source[index] === char) break
        if (char !== '`' && source[index] === '\n') break
        index += 1
      }
      index += 1
      stringSpans.push([start, Math.min(index, source.length)])
      previousMeaningful = char
      continue
    }
    if (char === '/' && /[=(,:[!&|?{;+\n]/.test(previousMeaningful || '\n')) {
      // Regex literal: skip so its slashes and digits are not read as code.
      let cursor = index + 1
      let inClass = false
      while (cursor < source.length) {
        const regexChar = source[cursor]
        if (regexChar === '\\') { cursor += 2; continue }
        if (regexChar === '\n') break
        if (regexChar === '[') inClass = true
        else if (regexChar === ']') inClass = false
        else if (regexChar === '/' && !inClass) break
        cursor += 1
      }
      if (cursor < source.length && source[cursor] === '/') {
        stringSpans.push([index, cursor + 1])
        index = cursor + 1
        previousMeaningful = '/'
        continue
      }
    }
    if (!/\s/.test(char)) previousMeaningful = char
    index += 1
  }

  return { code: out.join(''), stringSpans }
}

function lineIndexBuilder(content) {
  const lineStarts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lineStarts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (lineStarts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}

/**
 * An allowance covers the line it sits on and the line below it. When the line
 * below opens a block — a retired-id map, a legacy `switch` — it covers that
 * whole block, so one written justification governs one deliberate decision
 * instead of repeating itself on every entry.
 */
function readAllowances(rawLines, codeLines) {
  const allowances = new Map()

  const bracketDelta = (line) => {
    let delta = 0
    for (const char of line) {
      if (char === '{' || char === '[' || char === '(') delta += 1
      else if (char === '}' || char === ']' || char === ')') delta -= 1
    }
    return delta
  }

  rawLines.forEach((line, offset) => {
    const marker = line.indexOf(ALLOW_ANNOTATION)
    if (marker === -1) return
    const justification = line.slice(marker + ALLOW_ANNOTATION.length).replace(/^[:\s-]+/, '').trim()
    const covered = [offset + 1]

    const isStandaloneComment = /^\s*(?:\/\/|\/\*|\*|<!--)/.test(line)
    if (isStandaloneComment) {
      let cursor = offset + 1
      while (cursor < codeLines.length && !codeLines[cursor].trim()) cursor += 1
      covered.push(cursor + 1)
      let depth = bracketDelta(codeLines[cursor] || '')
      while (depth > 0 && cursor + 1 < codeLines.length) {
        cursor += 1
        covered.push(cursor + 1)
        depth += bracketDelta(codeLines[cursor])
      }
    }

    for (const lineNumber of covered) {
      const existing = allowances.get(lineNumber)
      if (!existing || existing.justification.length < justification.length) {
        allowances.set(lineNumber, { justification, declaredOn: offset + 1 })
      }
    }
  })
  return allowances
}

function enclosingString(spans, source, offset) {
  const span = spans.find(([start, end]) => offset >= start && offset < end)
  return span ? source.slice(span[0] + 1, Math.max(span[0] + 1, span[1] - 1)) : null
}

const files = []
for (const scanRoot of scanRoots) {
  const path = join(repoRoot, scanRoot)
  if (extname(path)) files.push(path)
  else files.push(...await collectFiles(path))
}
files.sort()

const violations = []
const malformedAllowances = []
let allowedCount = 0

for (const file of files) {
  const raw = await readFile(file, 'utf8')
  if (!raw.includes(ALLOW_ANNOTATION)
    && !/gpt-|claude-|gemini-|flux|seedream|kling|veo|sora|runway|wan|hailuo|whisper|eleven|qwen|nano-banana|genstudio-|imagen|dall-e|seedance|credit|price|cost|usd|token|character|\d{1,2}:\d{1,2}|\d{3,4}p/i.test(raw)) {
    continue
  }

  const { code, stringSpans } = stripComments(raw)
  const rawLines = raw.split('\n')
  const codeLines = code.split('\n')
  const lineOf = lineIndexBuilder(code)
  const allowances = readAllowances(rawLines, codeLines)
  const relativePath = relative(repoRoot, file)

  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    for (const match of code.matchAll(rule.pattern)) {
      const inside = enclosingString(stringSpans, code, match.index)
      if (rule.stringLiteralsOnly && inside === null) continue

      const line = lineOf(match.index)
      const codeLine = codeLines[line - 1] || ''
      const lineStart = match.index - (code.lastIndexOf('\n', match.index - 1) + 1)
      const context = {
        file: relativePath,
        enclosingString: inside ?? '',
        precedingCharacter: codeLine[lineStart - 1] || '',
        before: codeLine.slice(0, lineStart),
      }

      if (rule.ignore?.(match, context)) continue
      if (rule.requireLineMatch && !rule.requireLineMatch.test(codeLine)) continue
      if (rule.skipContext?.some((skip) => skip.test(context.before))) continue
      if (rule.minimumDistinctOptions) {
        const options = new Set((match[0].match(/['"]([\d]{1,2}:[\d]{1,2}|\d{3,4}p|[24]k)['"]/gi) || [])
          .map((option) => option.toLowerCase()))
        if (options.size < rule.minimumDistinctOptions) continue
      }

      const allowance = allowances.get(line)
      if (allowance) {
        if (allowance.justification.split(/\s+/).filter(Boolean).length < MINIMUM_JUSTIFICATION_WORDS) {
          malformedAllowances.push({
            file: relativePath,
            line: allowance.declaredOn,
            reason: `"${ALLOW_ANNOTATION}" needs a written justification of at least ${MINIMUM_JUSTIFICATION_WORDS} words`,
          })
        }
        allowedCount += 1
        continue
      }

      violations.push({
        file: relativePath,
        line,
        rule: rule.id,
        detail: rule.describe(match),
        remedy: rule.remedy,
        source: (rawLines[line - 1] || '').trim().slice(0, 160),
      })
    }
  }
}

const failures = [...malformedAllowances]

if (violations.length || failures.length) {
  console.error(`Model-drift check failed: ${violations.length} hardcoded catalogue value(s).`)
  console.error('')
  console.error('AGENTS.md, "Everything Follows the Selected Model": nothing about a model may be')
  console.error('hardcoded, copied, or cached past the moment the selection changes. GenStudio')
  console.error('publishes it; Story Studio reads it live.')
  console.error('')

  const byRule = new Map()
  for (const violation of violations) {
    if (!byRule.has(violation.rule)) byRule.set(violation.rule, [])
    byRule.get(violation.rule).push(violation)
  }

  for (const [ruleId, ruleViolations] of byRule) {
    console.error(`[${ruleId}] ${ruleViolations.length} violation(s)`)
    for (const violation of ruleViolations) {
      console.error(`  ${violation.file}:${violation.line} — ${violation.detail}`)
      console.error(`    ${violation.source}`)
    }
    console.error(`  Fix: ${ruleViolations[0].remedy}`)
    console.error('')
  }

  for (const malformed of failures) {
    console.error(`  ${malformed.file}:${malformed.line} — ${malformed.reason}`)
  }

  console.error(`If a literal is genuinely frozen — an idempotency digest component that must stay`)
  console.error(`byte-identical, a retired id kept only so a migration can recognise it — annotate`)
  console.error(`it on its own line or the line above:`)
  console.error(`  // ${ALLOW_ANNOTATION}: <why this value may never follow the catalogue>`)
  console.error(`Audit every exception with: grep -rn "${ALLOW_ANNOTATION}" electron frontend`)
  process.exit(1)
}

console.log(`Model-drift check passed: ${files.length} source files carry no hardcoded catalogue `
  + `values (${allowedCount} annotated exception${allowedCount === 1 ? '' : 's'}).`)
