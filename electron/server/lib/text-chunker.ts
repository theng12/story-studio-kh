/**
 * Text chunking for TTS — splits at paragraph then sentence boundaries.
 * Port of generate_audio.py chunk_text() function.
 *
 * v1.0.155+ — `MAX_CHARS = 4800` is the ElevenLabs-tuned default. Local
 * MLX TTS engines have much tighter soft caps (VoxCPM2 ~600, F5-TTS
 * ~400, Bark/Orpheus hard-capped <200). Callers should pass the
 * model-specific cap when dispatching to those providers instead of
 * relying on the default — see `AudioModelConfig.tts_soft_max_chars`
 * and the lookup in generators/audio.ts.
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
            // v1.0.155+ — word-level fallback for sentences that
            // individually exceed the cap. Rare in narration prose
            // but possible with verbose technical / academic content,
            // and especially relevant for local-TTS callers at 500-
            // char targets (VoxCPM2). Without this, a 700-char run-on
            // sentence at a 500-char cap would emit one oversized
            // chunk that hallucinates on the modal side. With it,
            // we greedy-pack words up to the cap and start a fresh
            // chunk on the word boundary that would have crossed it.
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
