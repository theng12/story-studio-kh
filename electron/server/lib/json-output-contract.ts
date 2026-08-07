export type JsonSchema = Record<string, unknown>

/**
 * How a workflow declares the shape it needs back from a language product.
 *
 * - `prose`: free text. It is REQUESTED as free text — `response_format:
 *   { type: 'text' }` — so narrative never has to survive being escaped into a
 *   JSON string on the way back.
 * - `json_object`: one JSON object. It may carry a `name` + `schema`, which are
 *   used to describe the required shape in the request instructions and to
 *   validate the returned object LOCALLY. A GenStudio product is never required
 *   to enforce this schema natively.
 * - `json_schema`: the product itself must accept a strict JSON schema. Reserve
 *   this for workflows that genuinely need provider-native enforcement.
 *
 * ASKED FOR vs ACCEPTED — why `accept` exists
 * -------------------------------------------
 * `schema` is what the model is ASKED for: it is rendered into the request
 * instructions by `describeSchemaForInstructions`, so every bound in it
 * ("exactly 40 items", "one of: <the 40 ids>", "do not add any keys") is
 * genuine instruction value and must stay.
 *
 * `accept` is what Story Studio can safely USE. It is optional, LOCAL-ONLY, and
 * never sent anywhere. It exists for one shape: a BATCH whose items are
 * independently consumable and are already checked one-by-one by the workflow
 * that reads them. For those, validating the batch atomically is not a safety
 * property — it is a way to destroy 39 correct, already-paid-for items because
 * of the 40th. The per-item guarantee belongs where a failure can be surgical
 * (drop the bad row, re-request that id); the envelope check belongs here.
 *
 * A contract WITHOUT `accept` is unchanged: it is validated against `schema`
 * exactly as before. Adding `accept` never loosens anything the workflow does
 * not separately enforce — see `scenePromptPackOutputContract`, which documents
 * the three per-item guards that make its envelope-only acceptance safe.
 */
export type TextOutputContract =
  | { mode: 'prose' }
  | { mode: 'json_object'; name?: string; schema?: JsonSchema; accept?: JsonSchema }
  | { mode: 'json_schema'; name: string; schema: JsonSchema }

export const PROSE_OUTPUT_CONTRACT: TextOutputContract = { mode: 'prose' }
export const JSON_OBJECT_OUTPUT_CONTRACT: TextOutputContract = { mode: 'json_object' }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type]
  return types.some(candidate => {
    switch (candidate) {
      case 'object': return isPlainObject(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'integer': return Number.isInteger(value)
      case 'boolean': return typeof value === 'boolean'
      case 'null': return value === null
      default: return false
    }
  })
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function describeExpectedType(type: unknown): string {
  const types = (Array.isArray(type) ? type : [type]).filter(item => typeof item === 'string')
  return types.length ? types.join(' or ') : 'a declared type'
}

/** A short, quotable rendering of the offending value. Never dumps a whole pack. */
function previewValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `an array of ${value.length}`
  return `keys ${JSON.stringify(Object.keys(value))}`
}

/**
 * Explain the FIRST reason `value` does not satisfy `schema`, or null when it
 * does. Returns a path ("$.results[36]") and a reason in one string.
 *
 * WHY THIS EXISTS: the boolean form below used to be the only answer available,
 * so every local rejection surfaced as "the output did not match the response
 * schema" with no path, no offending value, and no reason. Debugging a rejected
 * 40-item pack then meant re-deriving by hand which of 40 rows was at fault —
 * repeatedly, and expensively. GenStudio names its reasons; this is Story
 * Studio's side of the same courtesy.
 *
 * Validates the bounded JSON-schema subset accepted by GenStudio. Story Studio
 * never retrieves references or executes schema-provided code.
 */
export function explainJsonSchemaMismatch(
  value: unknown,
  schema: JsonSchema,
  path = '$',
): string | null {
  if (!matchesType(value, schema.type)) {
    return `${path}: expected ${describeExpectedType(schema.type)}, got ${describeValueType(value)}`
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
    const shown = schema.enum.slice(0, 3).map(item => JSON.stringify(item)).join(', ')
    const rest = schema.enum.length - Math.min(3, schema.enum.length)
    return `${path}: ${previewValue(value)} is not one of the ${schema.enum.length} allowed values`
      + `${shown ? ` (${shown}${rest > 0 ? `, +${rest} more` : ''})` : ''}`
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    return `${path}: expected the constant ${JSON.stringify(schema.const)}, got ${previewValue(value)}`
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${path}: string is ${value.length} characters, minimum ${schema.minLength}`
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${path}: string is ${value.length} characters, maximum ${schema.maxLength}`
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${path}: ${value} is below the minimum ${schema.minimum}`
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${path}: ${value} is above the maximum ${schema.maximum}`
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return `${path}: ${value} must be greater than ${schema.exclusiveMinimum}`
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      return `${path}: ${value} must be less than ${schema.exclusiveMaximum}`
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${path}: has ${value.length} item(s), minimum ${schema.minItems}`
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${path}: has ${value.length} item(s), maximum ${schema.maxItems}`
    }
    // An array schema that declares no `items` places NO constraint on the
    // members. It previously rejected every array outright, which made the
    // schema's own omission look like the model's mistake.
    if (isPlainObject(schema.items)) {
      for (const [index, item] of value.entries()) {
        const reason = explainJsonSchemaMismatch(item, schema.items as JsonSchema, `${path}[${index}]`)
        if (reason) return reason
      }
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : []
    const missing = required.filter(key => !(key in value))
    if (missing.length) {
      return `${path}: missing required key${missing.length === 1 ? '' : 's'} `
        + `${missing.map(key => JSON.stringify(key)).join(', ')} (present: ${JSON.stringify(Object.keys(value))})`
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter(key => !(key in properties))
      if (extra.length) {
        return `${path}: unexpected key${extra.length === 1 ? '' : 's'} `
          + `${extra.map(key => JSON.stringify(key)).join(', ')} (this contract allows no additional properties)`
      }
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      return `${path}: has ${Object.keys(value).length} key(s), minimum ${schema.minProperties}`
    }
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) {
      return `${path}: has ${Object.keys(value).length} key(s), maximum ${schema.maxProperties}`
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value)) continue
      if (!isPlainObject(child)) return `${path}.${key}: the contract declares no usable schema for this key`
      const reason = explainJsonSchemaMismatch(value[key], child, `${path}.${key}`)
      if (reason) return reason
    }
  }
  return null
}

/**
 * Validate the bounded JSON-schema subset accepted by GenStudio. Story Studio
 * never retrieves references or executes schema-provided code.
 */
export function jsonValueMatchesSchema(value: unknown, schema: JsonSchema): boolean {
  return explainJsonSchemaMismatch(value, schema) === null
}

export function parseJsonOutput(raw: string): unknown {
  const text = raw.trim()
  if (!text) throw new Error('GenStudio returned an empty structured response.')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('GenStudio returned invalid JSON. The result was rejected locally.')
  }
}

/**
 * Validate a completed language-product response. Every failure here happens
 * AFTER GenStudio accepted and completed the request, so no message in this
 * function may claim that nothing was requested or charged.
 */
export function validateStructuredOutput(
  raw: string,
  contract: TextOutputContract,
): unknown {
  if (contract.mode === 'prose') return unwrapProseOutput(raw)
  const value = parseJsonOutput(raw)
  if (contract.mode === 'json_object') {
    if (!isPlainObject(value)) {
      throw new Error('GenStudio returned JSON, but this workflow requires one JSON object.')
    }
    // `accept` is what this workflow can safely USE; `schema` is what the model
    // was ASKED for. They differ only where the workflow checks items itself.
    const enforced = contract.accept ?? contract.schema
    if (enforced) {
      const reason = explainJsonSchemaMismatch(value, enforced)
      if (reason) {
        throw new Error(
          `GenStudio completed the request, but the output did not match the ${contract.name ?? 'requested'} response schema — ${reason}. The result was rejected locally.`,
        )
      }
    }
    return value
  }
  if (contract.mode === 'json_schema') {
    const reason = explainJsonSchemaMismatch(value, contract.schema)
    if (reason) {
      throw new Error(
        `GenStudio completed the request, but the output did not match the ${contract.name} response schema — ${reason}. The result was rejected locally.`,
      )
    }
    return value
  }
  return value
}

/**
 * Prose workflows have no schema of their own, and no longer ask for one:
 * `productResponseFormat` sends `response_format: { type: 'text' }`, so the
 * normal answer arrives as plain text and this function only has to trim it.
 *
 * The `{"text": ...}` unwrap STAYS, for two answers that still exist:
 *
 *   1. A durable job submitted before this change and settled after it. The
 *      chat idempotency digest hashes the output CONTRACT (`{ mode: 'prose' }`),
 *      not the wire `response_format`, so it is unchanged by this release — a
 *      retry crossing the upgrade deliberately replays the in-flight job rather
 *      than paying for a second one, and that job was asked for the wrapper.
 *      Rejecting its answer would discard work already charged for.
 *   2. A model that volunteers a wrapper anyway. Nothing asks for it now, but
 *      a returned `{"text": …}` is still plainly the prose we wanted.
 *
 * So any non-empty answer is valid prose:
 *
 *   - plain prose, taken as-is (the normal case);
 *   - a `{"text": …}` wrapper, unwrapped;
 *   - a wrapper carrying extra keys, still unwrapped (the extras are ignored).
 *
 * Only a genuinely empty response fails. That check is the whole local bound on
 * prose — the real output ceiling is the product's published
 * `max_output_tokens`, enforced before the request leaves this process and by
 * GenStudio after it, never a character cap.
 */
function unwrapProseOutput(raw: string): { text: string } {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('GenStudio completed the request but returned an empty response.')
  try {
    const wrapped = JSON.parse(trimmed)
    if (isPlainObject(wrapped) && typeof wrapped.text === 'string' && wrapped.text.trim()) {
      return { text: wrapped.text }
    }
  } catch {
    // Not JSON at all — the product answered in plain prose, which is what we wanted.
  }
  return { text: trimmed }
}
