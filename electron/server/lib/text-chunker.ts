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
            // Word-level fallback for a single sentence that exceeds
            // the boundary on its own. Rare in narration prose, but
            // possible with verbose technical or academic content, and
            // the only remaining way a part could come back larger than
            // the caller allowed. Greedy-pack words up to the boundary
            // and start a fresh chunk on the word that would cross it.
            if (sent.length > maxChars) {
              const words = sent.split(/\s+/)
              let wordSub = ''
              for (const w of words) {
                const cand3 = wordSub ? `${wordSub} ${w}` : w
                if (cand3.length <= maxChars) {
                  wordSub = cand3
                } else {
                  if (wordSub) chunks.push(wordSub)
                  wordSub = w
                }
              }
              sub = wordSub
            } else {
              sub = sent
            }
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
