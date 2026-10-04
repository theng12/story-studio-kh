/**
 * Text chunking for TTS — splits at paragraph, then sentence, then word
 * boundaries, never exceeding the caller's boundary.
 *
 * `maxChars` is REQUIRED and has no default, deliberately. This module holds no
 * length of its own: a length belongs either to the model that publishes it or
 * to the engine that enforces it, and neither is Story Studio. The one caller
 * derives it from the selected model's published `maximum_input_characters`
 * (see `services/tts-request-plan.ts`).
 *
 * It used to default to 4,800 — a figure tuned for ElevenLabs, a route Story
 * Studio no longer takes — and callers that omitted the argument silently
 * inherited it. That is how a 5,456-character chapter came to be shown as a
 * two-part split while the selected model published a 25,000-character
 * boundary. A required parameter makes that class of mistake unexpressible.
 */

import { splitAtLimit, splitSentences } from './sentence-ends.js'

export function chunkText(text: string, maxChars: number): string[] {
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

      // Paragraph itself exceeds limit — split on sentences (Latin, Khmer ។ ៕ and CJK stops)
      if (para.length > maxChars) {
        let sub = ''
        for (const sent of splitSentences(para)) {
          if ((sub + sent).trimEnd().length <= maxChars) {
            sub += sent
            continue
          }
          if (sub) chunks.push(sub.trimEnd())
          const bare = sent.trimEnd()
          if (bare.length > maxChars) {
            // A single sentence over the boundary on its own. Rare in narration
            // prose, but possible with verbose technical content or Khmer text
            // with no stop. Cut at the last space, else at a point that is not
            // inside a Khmer syllable; the tail starts the next chunk.
            const pieces = splitAtLimit(bare.replace(/\s+/g, ' '), maxChars)
            chunks.push(...pieces.slice(0, -1))
            sub = pieces.at(-1)! + sent.slice(bare.length)
          } else {
            sub = sent
          }
        }
        current = sub.trimEnd()
      } else {
        current = para
      }
    }
  }

  if (current) chunks.push(current)
  return chunks
}
