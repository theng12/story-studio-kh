export type JsonSchema = Record<string, unknown>

export type TextOutputContract =
  | { mode: 'prose' }
  | { mode: 'json_object' }
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

export const PROSE_WRAPPER_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 500_000 },
  },
  required: ['text'],
  additionalProperties: false,
}

export function validateStructuredOutput(
  raw: string,
  contract: TextOutputContract,
): unknown {
  const value = parseJsonOutput(raw)
  if (contract.mode === 'json_object') {
    if (!isPlainObject(value)) {
      throw new Error('GenStudio returned JSON, but this workflow requires one JSON object.')
    }
    return value
  }
  if (contract.mode === 'json_schema') {
    if (!jsonValueMatchesSchema(value, contract.schema)) {
      throw new Error(`GenStudio output did not match the ${contract.name} response schema.`)
    }
    return value
  }
  if (!jsonValueMatchesSchema(value, PROSE_WRAPPER_SCHEMA)) {
    throw new Error('GenStudio prose output did not match its safe response wrapper.')
  }
  return value
}
