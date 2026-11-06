/**
 * Channel scene-image rules — three data-driven layers, editable per channel:
 *
 *   scene TYPE  →  COMPLEXITY id  →  MODEL id
 *
 * The scene-type list and the complexity list are both plain data. Complexity
 * is deliberately NOT an enum: levels can be added, renamed or removed, and
 * several levels may share one model id. A custom third level must parse and
 * resolve with no code change.
 *
 * The planner classifies a scene's TYPE only (content-based, recorded on the
 * scene as `subject_kind` + `classification_reason`); the complexity and model
 * come from a lookup (`resolveSceneImageRule`) — there is no per-scene
 * complexity classification to keep in sync.
 *
 * Model ids here are the owner-approved STARTING selections only. Nothing
 * about a model's speed, quality, caps or capabilities is stored or inferred
 * from these ids — those are read live from the catalogue at use (AGENTS §1).
 *
 * Written in the same idiom as `contracts/scene-effects-schema.ts` and
 * `contracts/subtitle-style-schema.ts`: `.strict()` objects, bounded strings
 * and arrays, an error class that names every offending field. The parser
 * rejects an inconsistent config (duplicate ids, dangling type→complexity
 * references) rather than silently reassigning or removing a referenced
 * level; a caller that means to remove an in-use complexity reassigns its
 * types first, explicitly.
 */

import { z } from 'zod'

/** Content-packs' list bound — the reasonable existing ceiling for an editable list. */
const MAX_ENTRIES = 200
const MAX_ID = 80
const MAX_LABEL = 120
const MAX_DESCRIPTION = 1000
/** Structural bound only: the live catalogue validates the id at use. */
const MAX_MODEL_ID = 200

const ruleId = z
  .string()
  .min(1)
  .max(MAX_ID)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be a lowercase id such as "character_portrait"')

const label = z.string().min(1).max(MAX_LABEL)
const description = z.string().min(1).max(MAX_DESCRIPTION)
const modelId = z.string().min(1).max(MAX_MODEL_ID)

// ── Types ───────────────────────────────────────────────────────────────────

/** One entry of the channel's editable scene-type list. */
export interface SceneImageTypeRule {
  id: string
  label: string
  /** What this type means — the content classifier reads it to pick a type. */
  description: string
  /** References a `SceneComplexityRule.id` in this same config (never dangling). */
  complexity_id: string
}

/** One entry of the channel's editable complexity list; several may share a model. */
export interface SceneComplexityRule {
  id: string
  label: string
  /** Starting selection only; capabilities resolve live at use (AGENTS §1). */
  model_id: string
}

/** The channel's scene-image rules. Absent on a channel = no rules yet. */
export interface SceneImageRules {
  scene_types: SceneImageTypeRule[]
  complexities: SceneComplexityRule[]
  /**
   * Automatic reference-overflow selection (owner-approved purpose): when a
   * reference image overflows the mapped model, try the other MAPPED models
   * first, then free enabled edit models; OFF means the pair is reported as
   * incompatible and no substitute is chosen. Absent = true.
   */
  allow_different_model: boolean
}

/** The optional per-scene classification fields, as the parser validates them. */
export interface SceneClassificationFields {
  /** Id of this channel's `scene_types` entry the planner assigned or the operator hand-set. */
  subject_kind?: string
  /** True when the operator hand-set `subject_kind`; a re-plan keeps it. */
  subject_kind_locked?: boolean
  /** Why the content classifier chose this type — a hint, never a gate. */
  classification_reason?: string
  /** Per-scene image model override; structural id only, live catalogue validates at use. */
  image_model_id?: string
}

/** A resolved type → complexity → model lookup. */
export interface ResolvedSceneImageRule {
  type_id: string
  complexity_id: string
  model_id: string
}

// ── Owner-approved starting data (selections only, never capabilities) ──────

/**
 * The 13 starting scene types with the owner's approved complexity mapping
 * (2026-11-05). Starting data a channel may edit — not a closed enum.
 */
export const STARTING_SCENE_IMAGE_TYPES: readonly SceneImageTypeRule[] = [
  { id: 'character_portrait', label: 'Character portrait', description: 'A single person or guide shown as a portrait or close focus', complexity_id: 'simple' },
  { id: 'landscape', label: 'Landscape', description: 'A wide view of a place, terrain or setting with no dominant figure', complexity_id: 'simple' },
  { id: 'simple_map', label: 'Simple map', description: 'A plain overview or layout of a location', complexity_id: 'simple' },
  { id: 'closeup_object', label: 'Close-up object', description: 'One object, animal or plant shown close up', complexity_id: 'simple' },
  { id: 'mood_symbolic', label: 'Mood/symbolic', description: 'A mood, symbol or abstract impression rather than a literal scene', complexity_id: 'simple' },
  { id: 'character_in_place', label: 'Character in a place', description: 'A person or guide shown within a specific place', complexity_id: 'detailed' },
  { id: 'group_crowd', label: 'Group/crowd', description: 'Several people or figures together', complexity_id: 'detailed' },
  { id: 'event_action', label: 'Event/action', description: 'Something happening — an action, conflict or moment', complexity_id: 'detailed' },
  { id: 'interior', label: 'Interior', description: 'The inside of a building or room', complexity_id: 'detailed' },
  { id: 'city_architecture', label: 'City/architecture', description: 'Buildings, streets or architectural views', complexity_id: 'detailed' },
  { id: 'detailed_map', label: 'Detailed map', description: 'A detailed map, plan or annotated layout', complexity_id: 'detailed' },
  { id: 'diagram_chart', label: 'Diagram/chart', description: 'A diagram, chart or structured visual explanation', complexity_id: 'detailed' },
  { id: 'document_writing', label: 'Document/writing', description: 'A document, page or writing shown as content', complexity_id: 'detailed' },
]

/**
 * The two starting complexities. Owner-approved model SELECTIONS only — no
 * speed, quality or capability may be read from these ids (AGENTS §1).
 */
export const STARTING_SCENE_COMPLEXITIES: readonly SceneComplexityRule[] = [
  { id: 'simple', label: 'Simple', model_id: 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit' },
  { id: 'detailed', label: 'Detailed', model_id: 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4' },
]

/** A fresh copy of the starting rules — fresh arrays and objects every call. */
export function defaultSceneImageRules(): SceneImageRules {
  return {
    scene_types: STARTING_SCENE_IMAGE_TYPES.map(type => ({ ...type })),
    complexities: STARTING_SCENE_COMPLEXITIES.map(complexity => ({ ...complexity })),
    allow_different_model: true,
  }
}

// ── Schema ──────────────────────────────────────────────────────────────────

const SceneImageTypeRuleSchema = z.object({
  id: ruleId,
  label,
  description,
  complexity_id: ruleId,
}).strict()

const SceneComplexityRuleSchema = z.object({
  id: ruleId,
  label,
  model_id: modelId,
}).strict()

export const SceneImageRulesSchema = z
  .object({
    scene_types: z.array(SceneImageTypeRuleSchema).max(MAX_ENTRIES),
    complexities: z.array(SceneComplexityRuleSchema).max(MAX_ENTRIES),
    allow_different_model: z.boolean().default(true),
  })
  .strict()
  .superRefine((rules, ctx) => {
    const typeIds = new Set<string>()
    rules.scene_types.forEach((type, i) => {
      if (typeIds.has(type.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scene_types', i, 'id'],
          message: `duplicate scene type id "${type.id}"`,
        })
      }
      typeIds.add(type.id)
    })

    const complexityIds = new Set<string>()
    rules.complexities.forEach((complexity, i) => {
      if (complexityIds.has(complexity.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['complexities', i, 'id'],
          message: `duplicate complexity id "${complexity.id}"`,
        })
      }
      complexityIds.add(complexity.id)
    })

    // A type pointing at a complexity that is gone (or was never there) is an
    // inconsistent config. Refuse it with a plain reason instead of silently
    // reassigning the type or dropping the reference.
    rules.scene_types.forEach((type, i) => {
      if (!complexityIds.has(type.complexity_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scene_types', i, 'complexity_id'],
          message: `scene type "${type.id}" references unknown complexity "${type.complexity_id}" — reassign the type to an existing complexity before removing one`,
        })
      }
    })
  })

const SceneClassificationSchema = z
  .object({
    subject_kind: ruleId.optional(),
    subject_kind_locked: z.boolean().optional(),
    classification_reason: z.string().max(MAX_DESCRIPTION).optional(),
    image_model_id: modelId.optional(),
  })
  .strict()

// ── Errors ──────────────────────────────────────────────────────────────────

export class SceneImageRulesValidationError extends Error {
  /** Bad input: running the job again stops here again, so no automatic retry (services/job-retry-policy.ts isNonRetryableError). */
  readonly retryable = false
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`Scene image rules are not valid: ${issues.join('; ')}`)
    this.name = 'SceneImageRulesValidationError'
    this.issues = issues
  }
}

/** Turn a zod issue list into messages that NAME the offending field. */
function describe(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const at = issue.path.length ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as z.ZodIssue & { keys: string[] }).keys
      return `unknown field${keys.length === 1 ? '' : 's'} ${keys.map(k => `"${at === '(root)' ? k : `${at}.${k}`}"`).join(', ')} — this config was authored for a newer engine`
    }
    return `${at}: ${issue.message}`
  })
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Validate a COMPLETE rules document. Throws `SceneImageRulesValidationError`
 * with one message per problem; unknown fields are named individually and an
 * inconsistent type→complexity mapping is refused, never repaired.
 */
export function parseSceneImageRules(input: unknown): SceneImageRules {
  const result = SceneImageRulesSchema.safeParse(input)
  if (!result.success) throw new SceneImageRulesValidationError(describe(result.error))
  // Zod's required keys infer as optional under the frontend's non-strict null checks.
  return result.data as SceneImageRules
}

/**
 * Validate a scene's optional classification fields against this channel's
 * rules. All fields are optional (an unclassified legacy scene parses as
 * `{}`); a `subject_kind` that names no entry in the channel's scene types is
 * rejected — custom channel ids are fine, dangling references are not.
 */
export function parseSceneClassification(
  input: unknown,
  rules: SceneImageRules,
): SceneClassificationFields {
  const result = SceneClassificationSchema.safeParse(input)
  if (!result.success) throw new SceneImageRulesValidationError(describe(result.error))
  const fields = result.data
  if (fields.subject_kind !== undefined && !rules.scene_types.some(type => type.id === fields.subject_kind)) {
    throw new SceneImageRulesValidationError([
      `subject_kind "${fields.subject_kind}" is not in this channel's scene types`,
    ])
  }
  return fields
}

/**
 * Look up a scene type's complexity and model. Returns null for a type this
 * config does not know (or a dangling reference a caller bypassed the parser
 * with) — a refusal, never an inferred guess.
 */
export function resolveSceneImageRule(
  rules: SceneImageRules,
  type_id: string,
): ResolvedSceneImageRule | null {
  const type = rules.scene_types.find(candidate => candidate.id === type_id)
  if (!type) return null
  const complexity = rules.complexities.find(candidate => candidate.id === type.complexity_id)
  if (!complexity) return null
  return { type_id: type.id, complexity_id: complexity.id, model_id: complexity.model_id }
}
