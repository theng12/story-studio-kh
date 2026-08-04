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
  'maximum_input_characters', 'maximum_quote_characters',
  'max_reference_images', 'min_reference_images', 'max_image_dimension',
].join('|')

/**
 * The same fields in any casing, for the `?? <literal>` fallback rule.
 *
 * v1.0.785 widened this after it missed the TTS quote parser
 * (`optionalCount(payload?.maximum_input_characters) ?? 0`) three separate ways:
 *
 *  - `max(?:imum)?` — the list only spelled the short form, so every
 *    `maximum_*` field GenStudio publishes was invisible to it.
 *  - bare `credits` — only `credits_per_*` was listed, so the single worst
 *    field in the catalogue (`credits ?? 0` reads as FREE) was not covered.
 *  - the wrapping call, handled at the pattern below.
 *
 * `min(?:imum)?_*` stays in the list on purpose: the rule's own exemption lets a
 * minimum default to 0, because an unpublished minimum genuinely means "no
 * constraint" — while a minimum defaulting to any OTHER number is still a claim
 * and must still fire. Longest alternatives come first so the reported name is
 * the whole field rather than a prefix of it.
 */
const PUBLISHED_VALUE_NAMES = [
  'context_?window\\w*',
  'max(?:imum)?_?output_?tokens', 'max(?:imum)?_?input_?tokens',
  'max(?:imum)?_?prompt_?characters', 'max(?:imum)?_?input_?characters',
  'max(?:imum)?_?quote_?characters', 'max(?:imum)?_?reference_?images',
  'min(?:imum)?_?reference_?images', 'max(?:imum)?_?image_?dimension',
  'base_?credits_?per_?\\w+', 'credits_?per_?\\w+',
  'aspect_?ratios?', 'resolutions?',
  // Bare last, so the alternation prefers the fully-qualified names above and
  // reports `credits_per_1000_characters` rather than a truncated `credits`.
  'credits',
].join('|')

const COST_VOCABULARY = /\b(cost|costs|price|pricing|priced|credit|credits|usd|dollar|dollars|estimate|estimated|spend|spent|bill|billed|billing|charge|charged)\b/i

/**
 * Upstream routing identities: the aggregator and direct-provider keys Story
 * Studio carried before every generation moved behind GenStudio (v1.0.669), plus
 * Studio Hub — the retired local control plane whose routes now 410. GenStudio
 * owns provider selection and deliberately does not disclose who it routes to,
 * so none of these names may appear anywhere in the frontend — not in a label
 * map, a template, a toast string, or a request payload.
 *
 * v1.0.783 shipped this with five names and frontend-only scope, deliberately
 * leaving out openai/anthropic/deepseek so a rule could not fire on a true
 * sentence. The owner overruled that scope: they were all historical direct
 * integrations, and every one of them is now enforced.
 *
 * Providers GenStudio PUBLISHES (ElevenLabs, Fish Audio — a voice's `provider`
 * / `engine_name`, a TTS model's `provider_name`) are still shown on purpose.
 * That is not in tension with `elevenlabs` being listed here: a published
 * provider arrives as runtime catalogue data and is rendered from a field, so
 * it never appears as source text. A vendor name TYPED INTO THIS REPO is always
 * either a legacy transport key or a guess, and both are forbidden.
 */
const PRIVATE_ROUTING_IDENTITY = /\b(?:kie\.ai|kie|fal\.ai|fal|openrouter|genaipro|deepseek|perplexity|anthropic|open ?ai|eleven ?labs|opencode|studio ?hub)\b/gi

/**
 * Backend scope. v1.0.783 found four customer-facing backend leaks — a 400
 * listing four vendors, a "no fal.ai, Kie.ai, or Studio Hub fallback" job error
 * — that a frontend-only rule can never catch, so the backend is scanned too.
 *
 * The backend genuinely holds transport identifiers, and it must keep holding
 * them: `getApiKey('anthropic')`, `provider: 'kie' | 'fal'`, a legacy union in
 * models/types.ts, a probe URL. What separates those from a leak is not the
 * name but the SHAPE of the string carrying it. An identifier is one token; a
 * customer-facing message is prose. So the backend rule fires only inside a
 * string literal that reads as a sentence — three or more whitespace-separated
 * words. `'elevenlabs'`, `'kie_api_key'` and `'https://api.deepseek.com/models'`
 * are not sentences and are left alone; "No OpenAI, Studio Hub, or direct Voice
 * Studio fallback was attempted." is one, and is exactly what must not ship.
 */
const BACKEND_PROSE = /\S+(?:\s+\S+){2,}/

/**
 * The one backend file whose prose may name a provider: audio-expression.ts
 * holds the LLM SYSTEM PROMPT that teaches a model ElevenLabs v3 inline tag
 * syntax. It is sent to a model, never rendered to a customer, and the tag
 * dialect is a real published capability of a provider GenStudio publishes —
 * rewording it would break tag generation to satisfy a display rule that does
 * not apply. Every other backend file is in scope.
 */
const BACKEND_IDENTITY_EXEMPT = new Set([
  'electron/server/services/audio-expression.ts',
])

/**
 * Members that legitimately hang off something named `controls` — array and
 * object built-ins, plus Vue's `.value`. Anything else after `controls.` is a
 * control NAME, which belongs to the catalogue and not to this codebase.
 */
const CONTROLS_COLLECTION_MEMBERS = new Set([
  'length', 'value', 'at', 'find', 'findIndex', 'findLast', 'filter', 'map', 'flatMap',
  'some', 'every', 'forEach', 'reduce', 'reduceRight', 'slice', 'splice', 'concat',
  'includes', 'indexOf', 'lastIndexOf', 'sort', 'reverse', 'join', 'push', 'pop',
  'shift', 'unshift', 'entries', 'keys', 'values', 'flat', 'fill', 'toString',
  'hasOwnProperty', 'constructor',
])

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
    //
    // The field does NOT have to sit against the `??`. This rule originally
    // required adjacency, so the ordinary way of writing the mistake —
    // `optionalCount(payload?.maximum_input_characters) ?? 0`, a parse helper
    // wrapped around the read — walked straight past it, and that exact line
    // shipped. `[\s)]*` lets the name be closed out of any number of wrapping
    // calls before the default.
    //
    // It stays tight in both directions. Only whitespace and closing PARENS may
    // intervene, so an argument list (`clamp(model.max_output_tokens, 2) || 0`)
    // cannot reach across a comma. `]` is deliberately excluded: a published
    // name inside a subscript is a lookup KEY, not a read of the value —
    // `RESOLUTION_FACTOR[settings.resolution] || 1` defaults a local multiplier
    // and says nothing about what any model published.
    pattern: new RegExp(
      String.raw`\b([\w$.?]*(?:` + PUBLISHED_VALUE_NAMES + String.raw`))[\s)]*(?:\?\?|\|\|)\s*(-?\d[\d_]*(?:\.\d+)?)\b`,
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
    id: 'named-control',
    // Reaching into a published `controls` map by a name written here. Which
    // controls a product takes — and what each accepts — is published per
    // product and read live; code that names one asserts a capability for
    // every product, including the ones that never had it.
    //
    // Deliberately narrow. It does NOT flag `productPublishesControl(product,
    // 'temperature')`, which is the opposite mistake's cure: a conditional
    // gate that sends a field only when the SELECTED product publishes it.
    // What it flags is the unconditional reach — `controls.stability`,
    // `controls['similarity']` — which no gate protects.
    // The lookbehind excludes `-`, and no whitespace is allowed before the
    // dot, so CSS selectors (`.scene-motion-controls.is-disabled`,
    // `.reconcile-controls .control-label`) are not property accesses and do
    // not trip it. Missing an oddly-wrapped access is the right trade: a guard
    // that cries wolf gets annotated away by the next person in a hurry.
    pattern: /(?<![\w$-])controls(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"\n]+)\2\s*\])/g,
    ignore: (match) => !!match[1] && CONTROLS_COLLECTION_MEMBERS.has(match[1]),
    describe: (match) => `a published control is named in code: controls${match[1] ? `.${match[1]}` : `['${match[3]}']`}`,
    remedy: 'Render and send controls from the selected product\'s published controls[] — name, '
      + 'label, type, minimum, maximum, step, max_length and default all come from the catalogue '
      + '(lib/tts-controls.ts). Index the map by a published name, never by one written here; a '
      + 'product that renames or drops the control leaves the code asserting it still exists.',
  },
  {
    id: 'private-routing-identity',
    // The names that must never reach a screen. Comments are already blanked
    // before any rule runs and __tests__ is not scanned, so a name discussed in
    // documentation or pinned in a boundary test is not a hit — only a name that
    // survives into shipped frontend code.
    pattern: PRIVATE_ROUTING_IDENTITY,
    ignore: (_match, context) => !context.file.startsWith('frontend/'),
    describe: (match) => `the private routing identity "${match[0]}" appears in frontend code`,
    remedy: 'GenStudio owns provider selection and does not publish who it routes to. Show the '
      + 'gateway ("GenStudio KH"), a provider GenStudio actually publishes (provider_name / '
      + 'provider / engine_name, read live from the catalogue), or nothing at all. A model with '
      + 'no published provider shows NO provider — never a placeholder vendor, and never a name '
      + 'guessed from a model id.',
  },
  {
    id: 'private-routing-identity-backend',
    // Same names, backend half: a vendor written into a sentence the customer
    // can read. Route `detail`s, thrown Error messages and job output_lines all
    // reach a screen verbatim, and a frontend-only rule never sees them.
    pattern: PRIVATE_ROUTING_IDENTITY,
    stringLiteralsOnly: true,
    ignore: (_match, context) => !context.file.startsWith('electron/')
      || BACKEND_IDENTITY_EXEMPT.has(context.file)
      || !BACKEND_PROSE.test(context.enclosingString),
    describe: (match) => `the private routing identity "${match[0]}" appears in a customer-facing backend string`,
    remedy: 'This string can reach a screen — as a route detail, a thrown Error, or a job output '
      + 'line. Name the gateway ("GenStudio KH") or nothing; say "no fallback route was attempted" '
      + 'rather than listing who was not called. Transport identifiers are fine: keep the bare id '
      + "('kie', 'elevenlabs'), the config key, the union member and the probe URL — only prose "
      + 'the customer reads is forbidden.',
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
    && !/gpt-|claude-|gemini-|flux|seedream|kling|veo|sora|runway|wan|hailuo|whisper|eleven|qwen|nano-banana|genstudio-|imagen|dall-e|seedance|credit|price|cost|usd|token|character|kie|fal\.ai|openrouter|genaipro|deepseek|perplexity|anthropic|open ?ai|opencode|studio ?hub|\d{1,2}:\d{1,2}|\d{3,4}p/i.test(raw)) {
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
