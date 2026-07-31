export type JsonSchema = Record<string, unknown>

/**
 * How a workflow declares the shape it needs back from a language product.
 *
 * - `prose`: free text, carried through the safe `{ text }` wrapper.
 * - `json_object`: one JSON object. It may carry a `name` + `schema`, which are
 *   used to describe the required shape in the request instructions and to
 *   validate the returned object LOCALLY. A GenStudio product is never required
 *   to enforce this schema natively.
 * - `json_schema`: the product itself must accept a strict JSON schema. Reserve
 *   this for workflows that genuinely need provider-native enforcement.
 */
export type TextOutputContract =
  | { mode: 'prose' }
  | { mode: 'json_object'; name?: string; schema?: JsonSchema }
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

/**
 * Validate the bounded JSON-schema subset accepted by GenStudio. Story Studio
 * never retrieves references or executes schema-provided code.
 */
export function jsonValueMatchesSchema(value: unknown, schema: JsonSchema): boolean {
  if (!matchesType(value, schema.type)) return false
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) return false
  if ('const' in schema && !Object.is(schema.const, value)) return false

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
    if (!isPlainObject(schema.items)) return false
    if (!value.every(item => jsonValueMatchesSchema(item, schema.items as JsonSchema))) return false
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : []
    if (required.some(key => !(key in value))) return false
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in properties))) return false
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) return false
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) return false
    for (const [key, child] of Object.entries(properties)) {
      if (key in value && (!isPlainObject(child) || !jsonValueMatchesSchema(value[key], child))) return false
    }
  }
  return true
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
 * The `{ "text": ... }` transport wrapper for prose.
 *
 * NO `maxLength`, deliberately. It carried `maxLength: 500_000` until this
 * release, and that number was wrong twice over:
 *
 *   1. It is not a local bound. `validateStructuredOutput` routes prose to
 *      `unwrapProseOutput`, which never consults this schema. The only place
 *      the cap ever reached was the REQUEST — this object is sent verbatim as
 *      a `strict: true` provider schema for products publishing
 *      `structured_output_mode: 'request_json_schema'`. So it constrained
 *      generation rather than validating a result.
 *   2. It can now bite. Output allowances published by GenStudio reach 128,000
 *      tokens; at roughly four characters per token that is already past
 *      500,000 characters, so a legitimately long answer would be constrained
 *      or rejected after the customer was charged for it. Worse, a character
 *      cap cannot stand in for a token budget at all: characters per token
 *      differ sharply by language, and Khmer and mixed-script narration sit
 *      nowhere near the English ratio any such number would be tuned to.
 *
 * The real ceiling is the model's published `max_output_tokens`, which is
 * enforced against the live catalogue before the request leaves this process,
 * and by GenStudio server-side after it. An empty answer is still rejected —
 * that check lives in `unwrapProseOutput`, where it belongs.
 */
export const PROSE_WRAPPER_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1 },
  },
  required: ['text'],
  additionalProperties: false,
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
    if (contract.schema && !jsonValueMatchesSchema(value, contract.schema)) {
      throw new Error(
        `GenStudio completed the request, but the output did not match the ${contract.name ?? 'requested'} response schema. The result was rejected locally.`,
      )
    }
    return value
  }
  if (contract.mode === 'json_schema') {
    if (!jsonValueMatchesSchema(value, contract.schema)) {
      throw new Error(
        `GenStudio completed the request, but the output did not match the ${contract.name} response schema. The result was rejected locally.`,
      )
    }
    return value
  }
  return value
}

/**
 * Prose workflows have no schema of their own. The `{"text": ...}` wrapper exists
 * only because the language-product endpoint requires a `response_format` — it is
 * transport packaging, not a requirement of the workflow. So any non-empty answer
 * is valid prose:
 *
 *   - the wrapper, unwrapped;
 *   - a wrapper carrying extra keys, still unwrapped (the extras are ignored);
 *   - plain prose the product returned without wrapping, taken as-is.
 *
 * Only a genuinely empty response fails. Rejecting readable prose because the
 * product declined to wrap it would discard work GenStudio has already completed
 * and charged for, which is strictly worse than accepting the text we asked for.
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
