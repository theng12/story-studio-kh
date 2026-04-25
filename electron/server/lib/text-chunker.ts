/**
 * Text chunking for TTS — splits at paragraph then sentence boundaries.
 * Port of generate_audio.py chunk_text() function.
 */

const MAX_CHARS = 4800

export function chunkText(text: string, maxChars = MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text]

  const paragraphs = text.split('\n\n')
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para

    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) chunks.push(current)

      // Paragraph itself exceeds limit — split on sentences
      if (para.length > maxChars) {
        const sentences = para.split(/(?<=[.!?])\s+/)
        let sub = ''
        for (const sent of sentences) {
          const candidate2 = sub ? `${sub} ${sent}` : sent
          if (candidate2.length <= maxChars) {
            sub = candidate2
          } else {
            if (sub) chunks.push(sub)
            sub = sent
          }
        }
        current = sub
      } else {
        current = para
      }
    }
  }

  if (current) chunks.push(current)
  return chunks
}
