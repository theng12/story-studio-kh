/**
 * Phase 8 — character name detector for auto-attaching reference images
 * to image-generation prompts. Returns the subset of `cast` whose .name
 * appears in `promptText` as a whole word (case-insensitive).
 *
 * Used by the image generator so the user doesn't have to thread
 * character_ids through the request: drop a character into the project's
 * cast and any scene prompt that mentions them by name automatically
 * picks up their reference images at generation time.
 *
 * Boundary semantics:
 *   - Multi-word names ("Aria the Knight") match as a phrase.
 *   - Match requires non-letter/digit on both sides — so "Aria" won't
 *     match "Marian" or "Arianna".
 *   - Case-insensitive.
 *   - Special regex characters in the name are escaped so a name like
 *     "C-3PO" or "Mr. Brick" is matched literally.
 *
 * Pulled out of generators/images.ts for testability and reuse (the
 * video generator can adopt the same logic when reference-image i2v
 * lands).
 */

interface NameableCharacter {
  name: string
}

export function findReferencedCharacters<T extends NameableCharacter>(
  promptText: string,
  cast: T[],
): T[] {
  if (!promptText || !cast.length) return []
  const matched: T[] = []
  for (const c of cast) {
    if (!c.name || typeof c.name !== 'string') continue
    const escaped = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Boundary = start/end of string OR a non-alphanumeric character.
    // We don't use \b because names with internal punctuation (Mr. Brick,
    // C-3PO) confuse \b's word-character rules.
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i')
    if (re.test(promptText)) matched.push(c)
  }
  return matched
}
