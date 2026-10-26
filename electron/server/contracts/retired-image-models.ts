/**
 * Image model ids the owner has retired, and the product that replaced each.
 *
 * A saved preset keeps the id it was written with. When GenStudio republishes a
 * product under a new identifier, that id stops resolving even though the
 * product is right there — and the failure landed on the customer as a refusal
 * from an unrelated resolver rather than as "choose another model".
 *
 * TWO independent mechanisms, and they answer different questions:
 *
 *   - `findGenStudioProduct` (`contracts/genstudio-product-identity.ts`) is
 *     ALIAS-AWARE against the LIVE catalogue: it resolves an id when the
 *     catalogue itself still publishes it under `customer_handle`,
 *     `public_model_id` or `legacy_ids`. That is the general case and needs no
 *     entry here. It is asked FIRST, so a catalogue that already answers never
 *     depends on this table.
 *
 *   - This table is for an id the catalogue does NOT publish at all, where the
 *     OWNER has said which product it meant. That is a statement about identity,
 *     not a guess from a name: an id is only ever mapped to the SAME product.
 *     Nothing here infers that two similarly-named products are the same, and a
 *     caller must still confirm the target is in the live catalogue before it
 *     selects it — a replacement that has itself been retired resolves to
 *     nothing, not to something else.
 *
 * Nothing is rewritten on disk. This is a READ-time resolution, so a stored
 * preset, draft or job chain keeps the bytes it has (AGENTS.md §5, trap 2).
 *
 * Dependency-free so renderer code can import it (see nuxt.config.ts), the same
 * shape as `contracts/retired-video-models.ts`.
 */

/**
 * 1.4.288 — a bare product id still saved in old presets and job chains, and the
 * product that replaced it. BW EP0049's July chain asked for `flux-2-klein` and
 * its recovery failed with "Unknown image model"; it now renders on the fleet
 * FLUX.2 Klein. `terranash-sleep-stories` still carries it in four Scene Plan
 * presets, where selecting one ended in a 409 from the prompt-cap resolver.
 */
const RETIRED_IMAGE_IDS: Record<string, string> = {
  'flux-2-klein': 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit',
}

/**
 * The product a retired image id names, or `null` when the id is not one we
 * have an owner-published replacement for.
 *
 * Case-folded and trimmed, so a saved id never misses on whitespace or casing.
 * Returns the replacement id ONLY — the caller must check it against the live
 * catalogue, because a replacement can be retired in turn.
 */
export function resolveRetiredImageModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return key ? RETIRED_IMAGE_IDS[key] ?? null : null
}
