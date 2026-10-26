/**
 * Format loader — reads built-in + user-custom Format profiles and resolves
 * the "effective format" for a given project (base + per-project overrides
 * deep-merged).
 *
 * Layout:
 *   - Built-in formats: ${BUILTIN_FORMATS_DIR}/{id}.json — shipped with the
 *     app (electron-builder copies electron/server/formats → resourcesPath/formats).
 *   - User-custom formats: ${PROJECTS_ROOT}/.formats/{id}.json — exportable as
 *     single JSON files, shareable across machines / users.
 *   - Per-project overrides: stored inside project.json as `format_overrides`
 *     (DeepPartial<Format>), applied with a deep merge on top of the base.
 *
 * Lookup:
 *   loadFormat('continuity-chain') → built-in Continuity Engine
 *   loadFormat('my-custom')   → user library
 *   getEffectiveFormat(slug)  → reads project.format_id, loads base, applies
 *                                project.format_overrides, returns merged result
 *
 * Caching:
 *   Built-in formats are cached forever (immutable in the bundle).
 *   User-custom formats are cached + invalidated on mtime change so editing
 *   the JSON directly takes effect on the next read.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import { resolveMotionProfile } from './motion-profiles.js'
import { applyFormulaEpisodeProfile, resolveFormulaEpisodeDimensions } from './formula-production-kit.js'
import type { Format, DeepPartial, ProjectMeta } from '../models/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * Default base format used when a project has no `format_id` set, or when a
 * saved project names any format other than the Continuity Engine.
 */
// Stored project metadata is retained for migration safety, but every format
// ID resolves to the Continuity Engine at the effective-format boundary.
export const DEFAULT_FORMAT_ID = 'continuity-chain'

export function canonicalFormatId(id?: string | null): string {
  void id
  return DEFAULT_FORMAT_ID
}

// ── Built-in directory resolution ──────────────────────────────────────────
//
// Mirrors resolveTemplatesRoot() in project-manager.ts: in packaged Electron
// the formats live under process.resourcesPath; in dev (tsx or compiled JS
// from the watcher) they live in the source tree at electron/server/formats.

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

/**
 * Walk up from `start` until a directory contains `electron/server/formats`.
 * Robust to both source layout (electron/server/services running via tsx)
 * AND compiled layout (electron/dist/server/services running via Electron),
 * which differ in depth. Returns null if no match within `maxDepth` levels.
 */
function findRepoFormatsDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'formats')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinFormatsDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'formats')
  }
  // Dev / tests / Electron-running-dist: walk up to find the source dir.
  // From source (electron/server/services) it's 3 ups; from compiled
  // (electron/dist/server/services) it's 4 ups; the search handles both.
  const found = findRepoFormatsDir(__dirname)
  if (found) return found
  // Fallback to the 3-ups guess so the loader still has *some* path to
  // attempt (will produce a clearer "not found" error than throwing here).
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'formats')
}

export const BUILTIN_FORMATS_DIR = resolveBuiltinFormatsDir()

/** User-custom formats live next to projects so they travel with the user. */
function userFormatsDir(): string {
  return path.join(pm.projectsRoot(), '.formats')
}

// ── Cache ──────────────────────────────────────────────────────────────────
//
// Built-in: load-once-and-keep. They're shipped with the bundle; mtime never
// changes during a process lifetime.
// User-custom: keyed by (path, mtimeMs) so editing the JSON directly works
// without restart.

const builtinCache = new Map<string, Format>()
const userCache = new Map<string, { mtimeMs: number; format: Format }>()

/**
 * Read + validate one format JSON file. Throws on parse error or missing
 * required fields so callers can decide whether to log + fall back vs. fail.
 */
async function loadFormatFile(filePath: string): Promise<Format> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Format JSON parse failed at ${filePath}: ${e.message}`)
  }
  validateFormatShape(parsed, filePath)
  return parsed as Format
}

function validateFormatShape(f: any, filePath: string): void {
  // Lightweight shape check — enough to avoid runtime explosions if the
  // user hand-edits a format. Per-field validation (e.g. narrator-style id
  // uniqueness) lives in the override editor; loader only enforces the
  // structural invariants the prompt assembly depends on.
  const missing: string[] = []
  if (typeof f?.id !== 'string') missing.push('id')
  if (typeof f?.name !== 'string') missing.push('name')
  if (f?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (!f?.idea?.systemPromptRole) missing.push('idea.systemPromptRole')
  if (!f?.script?.systemPromptRole) missing.push('script.systemPromptRole')
  if (!Array.isArray(f?.script?.narratorStyles) || !f.script.narratorStyles.length) {
    missing.push('script.narratorStyles (non-empty array)')
  }
  if (!f?.imagePrompts?.purposeNote) missing.push('imagePrompts.purposeNote')
  if (!f?.metadata?.purposeNote) missing.push('metadata.purposeNote')
  if (missing.length) {
    throw new Error(`Format at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a format by id. Tries the user library first (so custom formats can
 * shadow built-ins by reusing an id), falls back to the built-in library.
 * Returns null if not found.
 */
export async function loadFormat(id: string): Promise<Format | null> {
  // User-custom first (shadows built-ins).
  const userPath = path.join(userFormatsDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.format
    const fmt = await loadFormatFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, format: fmt })
    return fmt
  }

  // Built-in (cached forever).
  if (builtinCache.has(id)) return builtinCache.get(id)!
  const builtinPath = path.join(BUILTIN_FORMATS_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const fmt = await loadFormatFile(builtinPath)
  builtinCache.set(id, fmt)
  return fmt
}

/**
 * List every available format (built-in + user-custom). Used by the format
 * picker and the GET /api/formats endpoint. Returns the full Format objects
 * sorted by name for stable display order.
 */
export async function listFormats(): Promise<Format[]> {
  const seen = new Map<string, Format>()

  // User-custom first so they shadow built-ins with the same id.
  const userDir = userFormatsDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const fmt = await loadFormatFile(path.join(userDir, name))
        if (fmt.id === DEFAULT_FORMAT_ID) seen.set(fmt.id, fmt)
      } catch (e: any) {
        console.warn(`[format-loader] skipping malformed user format ${name}: ${e.message}`)
      }
    }
  }

  // Built-ins fill in gaps.
  if (existsSync(BUILTIN_FORMATS_DIR)) {
    let entries: string[] = []
    try { entries = await fs.readdir(BUILTIN_FORMATS_DIR) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const fmt = await loadFormatFile(path.join(BUILTIN_FORMATS_DIR, name))
        if (fmt.id === DEFAULT_FORMAT_ID && !seen.has(fmt.id)) seen.set(fmt.id, fmt)
      } catch (e: any) {
        console.warn(`[format-loader] skipping malformed built-in format ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Deep-merge `overrides` onto `base`. Arrays in overrides REPLACE the base
 * array (not merged element-wise) — narrator-style lists, keyword pools, and
 * pacing arcs are atomic-meaning-units the user intends to swap out wholesale.
 */
export function mergeFormatOverrides(base: Format, overrides?: DeepPartial<Format>): Format {
  if (!overrides) return base
  return deepMerge(base, overrides) as Format
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target
  if (Array.isArray(source)) return source.slice()  // arrays replace
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
 * Resolve the effective format for a project: load `project.format_id`
 * (defaulting to DEFAULT_FORMAT_ID), apply `project.format_overrides`,
 * return the merged result.
 *
 * Errors fall back to the default format with a warning rather than throwing —
 * the script generator must always return a usable format so the user's
 * generation flow never fails because of a missing format file.
 */
export async function getEffectiveFormat(
  slug: string,
  opts?: EffectiveFormatOpts,
): Promise<Format> {
  const project = await pm.getProject(slug)
  if (!project) {
    // No project → default format. Loader callers handle the missing-project
    // error themselves; this path supports tests / dry-runs.
    return ensureLoaded(DEFAULT_FORMAT_ID)
  }
  return getEffectiveFormatFor(project, opts)
}

/**
 * Per-call overrides for getEffectiveFormat[For]:
 *   - nicheIdOverride: undefined → use project.niche_id (default).
 *                      null / ''  → force "no niche" for this call.
 *                      string    → use this niche instead of project.niche_id.
 *
 * Used by surfaces that let the user override the project's saved niche per
 * generation (Ideas Generator's NichePicker, v1.0.92+) without persisting
 * the override into the project meta.
 */
export interface EffectiveFormatOpts {
  nicheIdOverride?: string | null
  /** undefined uses project packs (or the overridden formula's defaults);
   *  [] explicitly disables packs for this generation. */
  topicPackIdsOverride?: string[]
  /** Accepted episode whose durable Idea Campaign profile should apply. */
  episodeId?: string
}

const LIVE_VISUAL_SOURCES = new Set<string>([
  'timestamp-driven',
  'continuity-chain',
  'narrated-scenes',
])

/** Same as getEffectiveFormat() but takes the ProjectMeta directly. */
export async function getEffectiveFormatFor(
  project: ProjectMeta,
  opts?: EffectiveFormatOpts,
): Promise<Format> {
  const requestedId = project.format_id || DEFAULT_FORMAT_ID
  let id = canonicalFormatId(requestedId)
  let base: Format | null = null
  try {
    base = await loadFormat(id)
  } catch (e: any) {
    console.warn(`[format-loader] failed loading format '${id}', falling back to default: ${e.message}`)
  }
  if (!base) {
    if (id !== DEFAULT_FORMAT_ID) {
      console.warn(`[format-loader] format '${id}' not found, falling back to '${DEFAULT_FORMAT_ID}'`)
    }
    base = await ensureLoaded(DEFAULT_FORMAT_ID)
  }
  // Formula-owned content must not be bypassed by an old project-level
  // freeform mode. Keep the stored setting for migration safety, but do not
  // apply it to new effective formats.
  base = mergeFormatOverrides(base, project.format_overrides)
  // Stored project metadata is never rewritten, but callers only receive a
  // current production source. Unknown values take the Continuity path.
  if (!LIVE_VISUAL_SOURCES.has(base.visualSource || '')) {
    base = { ...base, visualSource: 'continuity-chain', sceneAlignment: 'sentence' }
  }
  // Niche layer — the CONTENT layer (v1.0.280+ polarity). The format is a
  // presentation shell carrying neutral fallback content; the niche provides
  // the actual voice/vocab/persona/rules. Applied LAST so niche content wins
  // over the shell's neutral defaults but still loses to explicit project
  // format_overrides (the per-project escape hatch). When NO niche is set, the
  // shell's own neutral content IS the fallback — a format-only project still
  // produces sane generic output (the prompt builders fall back leniently for
  // any empty content field).
  // Resolve which niche (if any) to layer on. Per-call override wins when
  // provided — empty string / null means "force no niche for this call" so
  // a user with a saved project niche can still ask the Ideas Generator
  // to ignore it for one batch. Undefined falls through to project state.
  const hasOverride = opts && Object.prototype.hasOwnProperty.call(opts, 'nicheIdOverride')
  const hasPackOverride = opts && Object.prototype.hasOwnProperty.call(opts, 'topicPackIdsOverride')
  const effectiveNicheId = hasOverride
    ? ((opts!.nicheIdOverride ?? '') || null)
    : (project.niche_id || null)
  if (effectiveNicheId) {
    try {
      const nicheLoader = await import('./niche-loader.js')
      // When overriding, load the override id directly. Otherwise use the
      // project-aware resolver (which applies project.niche_overrides on
      // top of the base niche file).
      const packIds = hasPackOverride
        ? opts!.topicPackIdsOverride
        : hasOverride
          ? undefined
          : project.topic_pack_ids
      const rawNiche = hasOverride
        ? await nicheLoader.loadNiche(effectiveNicheId)
        : null
      const niche = hasOverride
        ? (rawNiche ? await nicheLoader.composeNicheWithTopicPacks(rawNiche, packIds) : null)
        : await nicheLoader.getEffectiveNicheFor(project, packIds)
      if (niche) {
        const dimensions = await resolveFormulaEpisodeDimensions(project.slug, opts?.episodeId)
        base = applyNicheToFormat(base, niche, dimensions)
      }
    } catch (e: any) {
      if (e?.code === 'content-pack-missing') throw e
      console.warn(`[format-loader] failed applying niche '${effectiveNicheId}' for project '${project.slug}': ${e.message}`)
    }
  }
  // Legacy note: freeform content mode used to strip the formula's NARRATIVE
  // shaping so ideation + script aren't boxed by the video format. Done here, as
  // the last step, so every consumer of the effective format (ideas/script/
  // outline) sees the neutralised narrative while the VISUAL fields
  // (imagePrompts/visualSource/style) — and structural fields (chapter counts,
  // narrator styles, pacing) — stay exactly as the format/niche define them.
  // v1.0.332 — keep the legacy `imagePrompts.alignment` in sync with the
  // top-level `sceneAlignment` after all overrides resolve. The frontend
  // pipeline/flow reads top-level `sceneAlignment`, but the backend video
  // assembler (generators/video.ts) reads `imagePrompts.alignment`. Mirroring
  // here means a per-project `sceneAlignment` override (the new Scene-timing
  // toggle) reaches BOTH paths from one knob.
  if (base.sceneAlignment && base.imagePrompts) {
    base = { ...base, imagePrompts: { ...base.imagePrompts, alignment: base.sceneAlignment } }
  }
  return base
}

/** Neutral idea/script roles used in freeform mode. */
const FREEFORM_IDEA_ROLE =
  'You are a versatile video-idea generator. Produce strong, varied, audience-ready ideas for the given niche, topic, and keywords. Do not impose a fixed genre, tone, or title template — follow the user\'s inputs and instructions.'
const FREEFORM_SCRIPT_ROLE =
  'You are a skilled scriptwriter. Write a clear, engaging spoken-narration script in a natural voice suited to the topic, niche, and the requested length + structure. Do not impose a fixed persona, genre, or formula beyond what the user specifies.'

/**
 * v1.0.270 — return a copy of `format` with its NARRATIVE-shaping fields
 * neutralised (idea persona + title/logline/theme rules + example ideas +
 * structural-variety + script persona + additional rules). Everything else —
 * imagePrompts, visualSource, metadata, narratorStyles, pacing, chapter/length
 * ranges, vocabularies — is left untouched, so the format still fully controls
 * visuals + structure. buildPrompt()/systemPrompt() already fall back to lenient
 * defaults when these fields are empty/undefined.
 */
function neutralizeFormatNarrative(format: Format): Format {
  return {
    ...format,
    idea: {
      ...format.idea,
      systemPromptRole: FREEFORM_IDEA_ROLE,
      guidanceText: '',
      titleShapeRules: undefined,
      loglineShapeRules: undefined,
      themeShapeRules: undefined,
      structuralVariety: 'free',
      exampleIdeas: undefined,
    },
    script: {
      ...format.script,
      systemPromptRole: FREEFORM_SCRIPT_ROLE,
      additionalRules: [],
    },
  }
}

// ── Niche-onto-format layering ─────────────────────────────────────────────
//
// Mutates none of the input Format/Niche objects — returns a new Format with
// niche vocabulary, style sheet, and metadata hints merged in. Designed so
// every existing call site of getEffectiveFormat() automatically benefits
// from niche context without per-generator integration.

import type { Niche } from '../models/types.js'

function uniqueAppend(a: string[] | undefined, b: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const arr of [a, b]) {
    if (!arr) continue
    for (const v of arr) {
      if (!v) continue
      const k = v.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
  }
  return out
}

export function applyNicheToFormat(
  format: Format,
  niche: Niche,
  dimensions?: Record<string, string>,
): Format {
  niche = applyFormulaEpisodeProfile(niche, dimensions)
  // ── Polarity (v1.0.280+, format↔niche refactor) ─────────────────────────
  // FORMAT is a presentation-only shell; its content fields hold NEUTRAL
  // generic defaults (the fallback). NICHE provides the actual content.
  // This function overlays niche content onto the shell: every niche-owned
  // field wins when the niche sets it, and falls back to the shell's neutral
  // value (or the prompt builder's lenient default) when the niche is silent.
  //
  // Build new sub-objects rather than mutating the input — Format objects
  // can be cached by loadFormat() across requests; mutating would leak
  // niche state into later format-only consumers.
  //
  // v1.0.93+ — niche `exampleTopics` (a flat string[] of niche-specific
  // titles like "Morning Prayer for Strength") now REPLACES the format's
  // `exampleIdeas` whenever the niche provides them. Before this fix the
  // niche's example bar lived only in the picker preview UI; the LLM
  // never saw it, so a project on the broll-narration format + prayer
  // niche still got titles modelled on broll-narration's 2 generic
  // examples → poetic nature-flavoured output even with "prayer" vocab
  // sprinkled in (the actual bug the user reported).
  //
  // Synthesis: format's exampleIdeas is a rich object[]; niche's
  // exampleTopics is a flat string[]. We bolt the missing fields on with
  // sensible defaults pulled from the surrounding niche/format context.
  // The LLM gets the niche's titles as the bar AND keeps the format's
  // structural cues (chapters, length, narrator role).
  const nicheExampleIdeas: Format['idea']['exampleIdeas'] | undefined =
    Array.isArray(niche.exampleTopics) && niche.exampleTopics.length > 0
      ? niche.exampleTopics.map(t => ({
          title: t,
          logline: '',  // LLM infers from title + niche scriptContext
          themes: (niche.vocabulary?.theme || []).slice(0, 3),
          suggested_chapters: format.script.defaultChapterCount,
          suggested_length: `${format.script.defaultLengthMinutes} min`,
          mood: (niche.vocabulary?.mood || [])[0] || (format.idea.moodVocabulary || [])[0] || '',
        }))
      : undefined

  // v1.0.93+ — niche LEADS the prompt, format supports. Previous merge
  // appended niche audience after format audience and never touched the
  // Ideas-page systemPromptRole / guidanceText. The LLM therefore read
  // format vocab first ("calm, dream-like imagery") and niche vocab as a
  // late afterthought → "Daily Prayer | The Piano Tuner's Evening Prayer"
  // type compromises. Now the niche scriptContext + audienceHint appear
  // FIRST in the prompt so the LLM anchors on the niche voice before it
  // reads format guidance.
  // v1.0.280+ — niche can fully OWN the idea role via `ideaSystemPromptRole`.
  // When it does, the niche persona REPLACES the shell role outright. When it
  // doesn't, we compose the niche's scriptContext over the shell's generic
  // role (interim behaviour until Phase B authors explicit personas).
  const ideaSystemPromptRole = niche.ideaSystemPromptRole
    ? niche.ideaSystemPromptRole
    : niche.scriptContext
      ? `NICHE CONTEXT — this is the dominant voice for the channel:\n${niche.scriptContext}\n\nFORMAT ROLE (structural backbone — niche always wins on conflict):\n${format.idea.systemPromptRole}`
      : format.idea.systemPromptRole

  // Guidance text: niche-owned when provided, else niche voice cue at the top
  // with the format shell's (neutral) guidance underneath.
  const nicheGuidanceLead = niche.scriptContext || niche.description
    ? `Channel voice for this generation: ${niche.scriptContext || niche.description}\n\n`
    : ''
  const ideaGuidanceText = niche.ideaGuidanceText
    ? niche.ideaGuidanceText
    : `${nicheGuidanceLead}${format.idea.guidanceText}`

  const idea = {
    ...format.idea,
    systemPromptRole: ideaSystemPromptRole,
    guidanceText: ideaGuidanceText,
    moodVocabulary: uniqueAppend(format.idea.moodVocabulary, niche.vocabulary?.mood),
    themeVocabulary: uniqueAppend(format.idea.themeVocabulary, niche.vocabulary?.theme),
    genreVocabulary: uniqueAppend(format.idea.genreVocabulary, niche.vocabulary?.genre),
    keywordVocabulary: uniqueAppend(format.idea.keywordVocabulary, niche.vocabulary?.keyword),
    // Niche audience leads. Format audience trails in parens for context
    // so the LLM still knows the broader channel demographics.
    audienceDefault: niche.audienceHint
      ? `${niche.audienceHint} (within the format's broader audience: ${format.idea.audienceDefault})`
      : format.idea.audienceDefault,
    exampleIdeas: nicheExampleIdeas || format.idea.exampleIdeas,
    // v1.0.95+ — Full IdeaPromptShape merge. Niche overrides format on
    // every field it sets. Unset fields fall through to format defaults
    // (which themselves may be unset, in which case the prompt builder
    // falls back to a minimal lenient instruction — "title fits the
    // genre, matches the example ideas above"). This is the schema that
    // makes "each niche owns its own structure" work: the prompt
    // assembler has zero hardcoded English about title/logline/theme
    // shape, niches and formats own every voice rule via JSON.
    titleShapeRules: niche.titleShapeRules?.length
      ? niche.titleShapeRules
      : format.idea.titleShapeRules,
    titleLengthRange: niche.titleLengthRange || format.idea.titleLengthRange,
    loglineShapeRules: niche.loglineShapeRules?.length
      ? niche.loglineShapeRules
      : format.idea.loglineShapeRules,
    loglineSentenceRange: niche.loglineSentenceRange || format.idea.loglineSentenceRange,
    themeShapeRules: niche.themeShapeRules?.length
      ? niche.themeShapeRules
      : format.idea.themeShapeRules,
    themeCountRange: niche.themeCountRange || format.idea.themeCountRange,
    structuralVariety: niche.structuralVariety || format.idea.structuralVariety,
  }

  // Script layer — system-prompt-role gets niche-augmented, AND v1.0.103+
  // niche.scriptStructure can override format.script's chapter count,
  // pacing arc, and add additional rules. Used by niches with strong
  // multi-section conventions (prayer-channel: Reflection → Prayer →
  // Blessing) that don't match the format's default shape. Each field
  // is optional; unset falls through to format.script.
  const niche_structure = niche.scriptStructure
  // v1.0.280+ — niche can fully OWN the script persona via
  // `scriptSystemPromptRole` (replaces the shell role). Otherwise it appends
  // scriptContext to the shell role (interim). closingHint is niche-owned too.
  const scriptSystemPromptRole = niche.scriptSystemPromptRole
    ? niche.scriptSystemPromptRole
    : niche.scriptContext
      ? `${format.script.systemPromptRole}\n\nSubject-domain context: ${niche.scriptContext}`
      : format.script.systemPromptRole
  // v1.0.280+ — niche can own the narrator-voice picker. When it ships its
  // own styles, they REPLACE the shell's single neutral default and the
  // niche's defaultNarratorStyleId is honoured (falling back to the first id
  // if the niche omits it or names a non-existent one).
  const nicheNarrators = Array.isArray(niche.narratorStyles) && niche.narratorStyles.length > 0
    ? niche.narratorStyles
    : null
  const nicheDefaultNarratorId = nicheNarrators
    ? (nicheNarrators.some(s => s.id === niche.defaultNarratorStyleId)
        ? niche.defaultNarratorStyleId!
        : nicheNarrators[0].id)
    : format.script.defaultNarratorStyleId
  // v1.4.73 — the Formula owns its opening too.
  //
  // This line is the whole of the Introduction fix. `format.script.introDefaults`
  // has been read since v1.0.71 by both `defaultSegmentRecipe()` and
  // `generateIntroductionOnly()`, and it was NEVER SET: `canonicalFormatId()`
  // folds every project onto `continuity-chain`, and that one format file ships
  // no `introDefaults`. So the override branch existed, was tested, and could
  // not run — every channel got a sleep-shaped seven-beat opening, breathing
  // exercise included, whether it was a bedtime story or a business explainer.
  //
  // The Formula was always the right owner. It already supplies the script
  // persona, the closing hint, the narrator voices and the chapter counts
  // through this same function; an opening is the same kind of fact about a
  // channel. Nothing new had to be built to carry it — only this assignment.
  //
  // Formula wins outright when it declares one, rather than merging field by
  // field. A half-Formula opening (its beats, the shell's word count) is an
  // opening nobody wrote.
  const baseScript: Format['script'] = {
    ...format.script,
    systemPromptRole: scriptSystemPromptRole,
    closingHint: niche.scriptClosingHint || format.script.closingHint,
    narratorStyles: nicheNarrators ? nicheNarrators.slice() : format.script.narratorStyles,
    defaultNarratorStyleId: nicheDefaultNarratorId,
    introDefaults: niche.introDefaults
      ? { ...niche.introDefaults, beats: niche.introDefaults.beats?.slice() }
      : format.script.introDefaults,
    // The pause between chapters is a fact about the channel type (a sleep
    // story wants a long, calm gap), so the Formula sets Audio Assembly's default.
    ...(typeof niche.chapterPauseSec === 'number' && niche.chapterPauseSec >= 0
      ? { audioMergeDefaults: { ...format.script.audioMergeDefaults, gapDurationSec: niche.chapterPauseSec } }
      : {}),
    // Likewise the pauses inside a chapter, where a formula overrides the uniform 1.5 / 1.0 s.
    ...(typeof niche.paragraphPauseSec === 'number' || typeof niche.sentencePauseSec === 'number'
      ? { narrationPauses: {
          ...(typeof niche.paragraphPauseSec === 'number' ? { paragraphSec: niche.paragraphPauseSec } : {}),
          ...(typeof niche.sentencePauseSec === 'number' ? { sentenceSec: niche.sentencePauseSec } : {}),
        } }
      : {}),
  }

  if (niche_structure) {
    if (typeof niche_structure.defaultChapterCount === 'number' && niche_structure.defaultChapterCount > 0) {
      baseScript.defaultChapterCount = niche_structure.defaultChapterCount
    }
    if (Array.isArray(niche_structure.chapterCountRange)
      && niche_structure.chapterCountRange.length === 2
      && niche_structure.chapterCountRange.every(n => typeof n === 'number' && n > 0)) {
      baseScript.chapterCountRange = [
        niche_structure.chapterCountRange[0],
        niche_structure.chapterCountRange[1],
      ]
    }
    if (typeof niche_structure.defaultLengthMinutes === 'number' && niche_structure.defaultLengthMinutes > 0) {
      baseScript.defaultLengthMinutes = niche_structure.defaultLengthMinutes
    }
    if (Array.isArray(niche_structure.lengthMinutesRange)
      && niche_structure.lengthMinutesRange.length === 2
      && niche_structure.lengthMinutesRange.every(n => typeof n === 'number' && n > 0)) {
      baseScript.lengthMinutesRange = [
        niche_structure.lengthMinutesRange[0],
        niche_structure.lengthMinutesRange[1],
      ]
    }
    if (Array.isArray(niche_structure.durationPresets)) {
      const presets = niche_structure.durationPresets
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
      if (presets.length) baseScript.durationPresets = presets
    }
    if (typeof niche_structure.defaultWordsPerMinute === 'number' && niche_structure.defaultWordsPerMinute > 0) {
      baseScript.defaultWordsPerMinute = niche_structure.defaultWordsPerMinute
    }
    if (typeof niche_structure.chaptersIndependent === 'boolean') {
      baseScript.chaptersIndependent = niche_structure.chaptersIndependent
    }
    if (niche_structure.visualPacingProfile) {
      const profile = niche_structure.visualPacingProfile
      const validRange = (range: unknown): range is { min_sec: number; max_sec: number } =>
        !!range && typeof (range as any).min_sec === 'number' && typeof (range as any).max_sec === 'number'
        && (range as any).min_sec > 0 && (range as any).max_sec >= (range as any).min_sec
      if (typeof profile.opening_duration_sec === 'number' && profile.opening_duration_sec >= 0
        && validRange(profile.opening) && validRange(profile.settled)) {
        baseScript.visualPacingProfile = {
          opening_duration_sec: profile.opening_duration_sec,
          opening: { ...profile.opening },
          settled: { ...profile.settled },
        }
      }
    }
    if (niche_structure.motionProfile || niche_structure.motionProfileId) {
      let profile = niche_structure.motionProfile
      if (typeof niche_structure.motionProfileId === 'string') {
        try {
          profile = resolveMotionProfile(niche_structure.motionProfileId)
        } catch {
          // Legacy raw profile remains the compatibility fallback; signed packs
          // cannot reach this path with an unknown ID because their schema rejects it.
        }
      }
      const validShares = (shares: unknown): shares is Record<'still' | 'gentle' | 'limited', number> =>
        !!shares && ['still', 'gentle', 'limited'].every(mode =>
          typeof (shares as any)[mode] === 'number' && Number.isFinite((shares as any)[mode]) && (shares as any)[mode] >= 0,
        )
      if (profile && typeof profile.id === 'string' && profile.id.trim()
        && typeof profile.label === 'string' && profile.label.trim()
        && typeof profile.description === 'string'
        && typeof profile.opening_duration_sec === 'number' && profile.opening_duration_sec >= 0
        && validShares(profile.opening) && validShares(profile.settled)) {
        baseScript.motionProfile = {
          id: profile.id,
          label: profile.label,
          description: profile.description,
          opening_duration_sec: profile.opening_duration_sec,
          opening: { ...profile.opening },
          settled: { ...profile.settled },
        }
      }
    }
    if (Array.isArray(niche_structure.pacingArc) && niche_structure.pacingArc.length > 0) {
      baseScript.pacingArc = niche_structure.pacingArc.slice()
    }
    if (Array.isArray(niche_structure.additionalRules) && niche_structure.additionalRules.length > 0) {
      // APPEND, don't replace — format rules stay; niche layers on top.
      baseScript.additionalRules = [
        ...format.script.additionalRules,
        ...niche_structure.additionalRules,
      ]
    }
  }
  // The Formula's quality contract is applied once at the effective-format
  // boundary. Every script route (outline, expansion, repair, pipeline) uses
  // this same format, so the anti-cadence safeguards cannot disappear between
  // steps or conflict with a per-screen POV picker.
  const quality = niche.narrativeQualityContract
  if (quality) {
    baseScript.additionalRules = uniqueAppend(baseScript.additionalRules, [
      `OPENING POLICY — ${quality.openingPolicy}`,
      `AVOID THESE RECOGNISABLE AI PATTERNS — ${quality.forbiddenPatterns.join('; ')}.`,
      `WRITE LIKE A HUMAN — ${quality.requiredHabits.join(' ')}`,
      ...(quality.closingPolicy ? [`CLOSING POLICY — ${quality.closingPolicy}`] : []),
      ...(niche.perspectivePolicy ? [`FORMULA-OWNED PERSPECTIVE — ${niche.perspectivePolicy}`] : []),
    ])
  }
  const script = baseScript

  // Image-prompt layer — append visualStyleSheet to defaultStyleTag (the
  // string the LLM sees baked into every prompt). visualStyleHint is the
  // human-facing one-liner shown in the UI; we leave it alone so the
  // picker preview stays readable.
  const stylePieces: string[] = []
  if (format.imagePrompts.defaultStyleTag) stylePieces.push(format.imagePrompts.defaultStyleTag)
  if (niche.visualStyleSheet) stylePieces.push(`Niche style: ${niche.visualStyleSheet}`)
  if (niche.defaultStyleKeywords?.length) {
    stylePieces.push(`Niche keywords: ${niche.defaultStyleKeywords.join(', ')}`)
  }
  // Niche thumbnail direction has two independent layers:
  //   - thumbnailProfile owns layout / composition / mood for this content.
  //   - thumbnailStyleSheet appends optional rendering language.
  // A profile field replaces the format shell's neutral value; unset fields
  // fall through. This lets an annotated business diagram ride on Scenes
  // without inheriting the shell's contradictory cinematic hero rules.
  const baseThumb = format.imagePrompts.thumbnail
  const nicheThumb = niche.thumbnailProfile
  const thumbnail = (baseThumb || nicheThumb || niche.thumbnailStyleSheet)
    ? {
        ...(baseThumb || { conceptGuidance: '' }),
        ...(nicheThumb || {}),
        conceptGuidance: [
          nicheThumb?.conceptGuidance ?? baseThumb?.conceptGuidance ?? '',
          niche.thumbnailStyleSheet ? `Niche thumbnail style: ${niche.thumbnailStyleSheet}` : '',
        ].filter(Boolean).join('\n\n'),
      }
    : undefined
  // The spread preserves every other imagePrompts field — including the
  // v1.0.224 `thumbnail` art-direction block — so per-format thumbnail
  // guidance survives niche application. Only `defaultStyleTag` (scene style)
  // is rewritten here; project `format_overrides` deep-merge the `thumbnail`
  // object key-by-key separately.
  const imagePrompts = {
    ...format.imagePrompts,
    defaultStyleTag: stylePieces.join('\n\n'),
    // v1.0.280+ — niche owns the human-facing one-liner too when it sets it.
    visualStyleHint: niche.visualStyleHint || format.imagePrompts.visualStyleHint,
    // Owner, 2026-10-27 — a Formula may state the frame it makes. This is the
    // SAME field the built-in Formats already carry, so Scene Review, the Image
    // Pool and Video Assembly keep reading one source for the canvas and no
    // second aspect control has to be kept in step with this one.
    ...(niche.aspectRatio ? { recommendedAspect: niche.aspectRatio } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  }

  // Metadata layer — niche tags merged into broadKeywords pool.
  // v1.0.103+ niche.metadataDescription propagates onto
  // format.metadata.descriptionShape so the description prompt builder
  // can read niche-voice/rules/CTA/closing without taking a second
  // niche reference (everything flows through the niche-merged
  // format object, consistent with the rest of the merge).
  const metadata = {
    ...format.metadata,
    // v1.0.280+ — niche owns title/tag tone + hook rules when it sets them.
    titleStyleHint: niche.metadataTitleStyleHint || format.metadata.titleStyleHint,
    titleHookRules: niche.metadataTitleHookRules?.length
      ? niche.metadataTitleHookRules
      : format.metadata.titleHookRules,
    tagsHookRules: niche.metadataTagsHookRules?.length
      ? niche.metadataTagsHookRules
      : format.metadata.tagsHookRules,
    broadKeywords: uniqueAppend(format.metadata.broadKeywords, niche.youtubeTagsHint),
    descriptionShape: niche.metadataDescription
      ? { ...niche.metadataDescription }
      : format.metadata.descriptionShape,
  }

  return {
    ...format,
    idea,
    script,
    imagePrompts,
    metadata,
  }
}

/** Loads a format that MUST exist; throws clearly if not (used for the default). */
async function ensureLoaded(id: string): Promise<Format> {
  const fmt = await loadFormat(id)
  if (!fmt) {
    throw new Error(
      `Built-in format '${id}' could not be loaded from ${BUILTIN_FORMATS_DIR}. ` +
      `This indicates a bundling problem — the formats/ directory may not have ` +
      `shipped with the build.`,
    )
  }
  return fmt
}

/**
 * Substitute `{lastButOne}` and `{last}` placeholders in pacing-arc lines
 * with the actual chapter numbers. Used by the script prompt assembler.
 */
export function fillPacingArcPlaceholders(arc: string[], chapterCount: number): string[] {
  const last = chapterCount
  const lastButOne = chapterCount - 1
  return arc.map(line => line.replace(/\{lastButOne\}/g, String(lastButOne)).replace(/\{last\}/g, String(last)))
}

/** Test-only — wipe caches so freshly-written format files take effect. */
export function _clearFormatCaches(): void {
  builtinCache.clear()
  userCache.clear()
}
