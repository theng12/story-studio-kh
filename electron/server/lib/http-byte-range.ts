export type HttpByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'invalid' }

/**
 * Parse the single-range form used by HTML audio and video elements.
 * Multiple ranges are rejected because these endpoints stream one local file
 * and do not need multipart/byteranges responses.
 */
export function parseHttpByteRange(header: string | undefined, size: number): HttpByteRange {
  if (!header) return { kind: 'full' }
  if (!Number.isSafeInteger(size) || size <= 0) return { kind: 'invalid' }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return { kind: 'invalid' }

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' }
    return {
      kind: 'partial',
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return { kind: 'invalid' }
  if (start < 0 || start >= size || requestedEnd < start) return { kind: 'invalid' }

  return {
    kind: 'partial',
    start,
    end: Math.min(requestedEnd, size - 1),
  }
}
