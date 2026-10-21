const MAX_JSON_BYTES = 1024 * 1024
const MAX_JSON_VISITS = 65536
const MAX_JSON_DEPTH = 32

export class StrictJsonError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'StrictJsonError'
  }
}

/** @param {string} message @returns {never} */
function invalid(message) { throw new StrictJsonError(message) }

/** Syntax-only bounded JSON decoding; callers validate their own value schema.
 * @param {string | Uint8Array} value
 * @param {string} label
 * @returns {unknown}
 */
export function decodeStrictJson(value, label) {
  let text
  if (typeof value === 'string') {
    const length = Buffer.byteLength(value, 'utf8')
    if (length < 2 || length > MAX_JSON_BYTES || value.charCodeAt(0) === 0xfeff) {
      invalid(`${label} bytes are invalid`)
    }
    text = value
  } else {
    if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > MAX_JSON_BYTES
        || (value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf)) {
      invalid(`${label} bytes are invalid`)
    }
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(value) } catch {
      invalid(`${label} UTF-8 is invalid`)
    }
  }

  let index = 0
  let visits = 0
  const primitivePattern = /(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y
  const whitespace = () => {
    while (index < text.length) {
      const unit = text.charCodeAt(index)
      if (unit !== 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) break
      index += 1
    }
  }
  /** @param {number} depth */
  const visit = depth => {
    if (depth > MAX_JSON_DEPTH) invalid(`${label} depth exceeds ${MAX_JSON_DEPTH}`)
    if (++visits > MAX_JSON_VISITS) invalid(`${label} value/key visits exceed ${MAX_JSON_VISITS}`)
  }
  /** @param {boolean} decode @returns {string | undefined} */
  const stringToken = decode => {
    const start = index
    if (text[index++] !== '"') invalid(`${label} JSON string is invalid`)
    while (index < text.length) {
      const unit = text.charCodeAt(index)
      if (unit < 0x20) invalid(`${label} JSON string is invalid`)
      if (text[index] === '"') {
        index += 1
        if (!decode) return undefined
        try { return JSON.parse(text.slice(start, index)) } catch {
          invalid(`${label} JSON string is invalid`)
        }
      }
      index += text[index] === '\\' ? 2 : 1
    }
    return invalid(`${label} JSON string is unterminated`)
  }
  /** @param {number} depth @returns {void} */
  const parseValue = depth => {
    visit(depth)
    whitespace()
    const token = text[index]
    if (token === '{') {
      index += 1
      whitespace()
      const keys = new Set()
      if (text[index] === '}') { index += 1; return }
      while (index < text.length) {
        visit(depth + 1)
        const key = stringToken(true)
        if (keys.has(key)) invalid(`${label} has a duplicate decoded object key`)
        keys.add(key)
        whitespace()
        if (text[index++] !== ':') invalid(`${label} JSON object is invalid`)
        parseValue(depth + 1)
        whitespace()
        if (text[index] === '}') { index += 1; return }
        if (text[index++] !== ',') invalid(`${label} JSON object is invalid`)
        whitespace()
      }
      invalid(`${label} JSON object is unterminated`)
    }
    if (token === '[') {
      index += 1
      whitespace()
      if (text[index] === ']') { index += 1; return }
      while (index < text.length) {
        parseValue(depth + 1)
        whitespace()
        if (text[index] === ']') { index += 1; return }
        if (text[index++] !== ',') invalid(`${label} JSON array is invalid`)
        whitespace()
      }
      invalid(`${label} JSON array is unterminated`)
    }
    if (token === '"') { stringToken(false); return }
    primitivePattern.lastIndex = index
    const primitive = primitivePattern.exec(text)
    if (!primitive) invalid(`${label} JSON value is invalid`)
    index += primitive[0].length
  }

  whitespace()
  parseValue(0)
  whitespace()
  if (index !== text.length) invalid(`${label} JSON has trailing bytes`)
  try { return JSON.parse(text) } catch { invalid(`${label} JSON is invalid`) }
}
