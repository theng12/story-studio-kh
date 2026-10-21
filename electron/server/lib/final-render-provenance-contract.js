import { decodeStrictJson } from './final-render-strict-json.js'

/** @typedef {Readonly<{profile_digest: string, tools_digest: string, compiler_digest: string}>} DescriptorPins */
/** @typedef {Readonly<{vector_id: string, qualification_digest: string, packet_digest: string, recipe_digest: string, manifest_digest: string}>} QualificationProvenance */
/** @typedef {Readonly<{format: 'studio.render.story-build-provenance.v1', mode: 'tool-only', descriptors: null, qualification: null}> | Readonly<{format: 'studio.render.story-build-provenance.v1', mode: 'descriptor-only', descriptors: DescriptorPins, qualification: null}> | Readonly<{format: 'studio.render.story-build-provenance.v1', mode: 'sealed-candidate', descriptors: DescriptorPins, qualification: QualificationProvenance}>} StoryRenderProvenance */

const FORMAT = 'studio.render.story-build-provenance.v1'
const DESCRIPTORS = ['profile_digest', 'tools_digest', 'compiler_digest']
const QUALIFICATION = ['vector_id', 'qualification_digest', 'packet_digest', 'recipe_digest', 'manifest_digest']
const SHA256 = /^[0-9a-f]{64}$/

export class RenderProvenanceError extends Error {
  /** @param {string} message @param {ErrorOptions} [options] */
  constructor(message, options) {
    super(`Invalid Story render provenance: ${message}`, options)
    this.name = 'RenderProvenanceError'
  }
}

/** @param {string} message @returns {never} */
function invalid(message) { throw new RenderProvenanceError(message) }

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid(`${label} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {unknown} value @param {string[]} keys @param {string} label @returns {Record<string, unknown>} */
function exact(value, keys, label) {
  const result = record(value, label)
  const own = Reflect.ownKeys(result)
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(result, key))
      || own.some(key => typeof key !== 'string' || !keys.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(result, key), 'value'))) {
    invalid(`${label} must have the exact closed fields`)
  }
  return result
}

/** @param {unknown} value @param {string} label @returns {string} */
function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256`)
  return value
}

/** @param {unknown} value @returns {DescriptorPins} */
function parseDescriptors(value) {
  const pins = exact(value, DESCRIPTORS, 'descriptors')
  return Object.freeze({
    profile_digest: digest(pins.profile_digest, 'profile_digest'),
    tools_digest: digest(pins.tools_digest, 'tools_digest'),
    compiler_digest: digest(pins.compiler_digest, 'compiler_digest'),
  })
}

/** @param {unknown} value @returns {QualificationProvenance} */
export function parseQualificationProvenance(value) {
  const pins = exact(value, QUALIFICATION, 'qualification')
  if (typeof pins.vector_id !== 'string' || !pins.vector_id || pins.vector_id !== pins.vector_id.trim()
      || pins.vector_id.length > 256 || pins.vector_id.includes('\0')) invalid('vector_id is invalid')
  return Object.freeze({
    vector_id: pins.vector_id,
    qualification_digest: digest(pins.qualification_digest, 'qualification_digest'),
    packet_digest: digest(pins.packet_digest, 'packet_digest'),
    recipe_digest: digest(pins.recipe_digest, 'recipe_digest'),
    manifest_digest: digest(pins.manifest_digest, 'manifest_digest'),
  })
}

/** @param {unknown} value @returns {StoryRenderProvenance} */
export function parseStoryRenderProvenance(value) {
  const result = exact(value, ['format', 'mode', 'descriptors', 'qualification'], 'provenance')
  if (result.format !== FORMAT) invalid('format is unsupported')
  if (result.mode === 'tool-only') {
    if (result.descriptors !== null || result.qualification !== null) invalid('tool-only data must be null')
    return Object.freeze({ format: FORMAT, mode: 'tool-only', descriptors: null, qualification: null })
  }
  if (result.mode === 'descriptor-only') {
    if (result.qualification !== null) invalid('descriptor-only qualification must be null')
    return Object.freeze({ format: FORMAT, mode: 'descriptor-only', descriptors: parseDescriptors(result.descriptors), qualification: null })
  }
  if (result.mode === 'sealed-candidate') {
    return Object.freeze({ format: FORMAT, mode: 'sealed-candidate', descriptors: parseDescriptors(result.descriptors), qualification: parseQualificationProvenance(result.qualification) })
  }
  return invalid('mode is unsupported')
}

/** @param {string | Uint8Array} bytes @returns {StoryRenderProvenance | null} */
export function readStoryRenderProvenanceFromPackageBytes(bytes) {
  let metadata
  try { metadata = record(decodeStrictJson(bytes, 'installed package metadata'), 'package metadata') } catch (error) {
    if (error instanceof RenderProvenanceError) throw error
    throw new RenderProvenanceError('package JSON is invalid', { cause: error })
  }
  if (metadata.name !== 'story-studio-kh' || metadata.main !== 'electron/dist/main.js' || metadata.type !== 'module') {
    invalid('package identity/layout is invalid')
  }
  return Object.hasOwn(metadata, 'storyRenderProvenance') ? parseStoryRenderProvenance(metadata.storyRenderProvenance) : null
}

/** @param {DescriptorPins | null | undefined} left @param {DescriptorPins | null | undefined} right @returns {boolean} */
export function sameDescriptorPins(left, right) {
  return !!left && !!right && DESCRIPTORS.every(key => left[/** @type {keyof DescriptorPins} */ (key)] === right[/** @type {keyof DescriptorPins} */ (key)])
}

/** @param {QualificationProvenance | null | undefined} left @param {QualificationProvenance | null | undefined} right @returns {boolean} */
export function sameQualificationProvenance(left, right) {
  return !!left && !!right && QUALIFICATION.every(key => left[/** @type {keyof QualificationProvenance} */ (key)] === right[/** @type {keyof QualificationProvenance} */ (key)])
}
