/**
 * Custom style presets → the Store visual style that now owns the look.
 *
 * WHY THIS EXISTS. The owner's own channels accumulated 34 hand-written
 * art-style presets. A triage on 2026-10-25 found that sixteen of them were
 * already served by a style in the Store, two were one picture described twice,
 * and the rest were worth publishing; fifteen were adopted as standalone styles
 * and the other nineteen now point at an existing one. Every one of those
 * presets is still sitting in a channel's `style_presets` and may still be named
 * by `active_style_preset_id`.
 *
 * THE RULE THIS TABLE OBEYS (AGENTS.md 5): stored presets and project data are
 * never rewritten, and no preset is migrated, normalised or deleted. This is a
 * READ-time resolution only. A preset that names an id below renders with the
 * Store style's bible and negative prompt when that style is installed, and
 * falls back to its own stored prose when it is not — so a Mac with no Store
 * styles behaves exactly as it does today.
 *
 * It is deliberately a fixed table and not a similarity search: the judgement is
 * the owner's, taken once, and a runtime guess would re-decide it in the dark.
 *
 * It also resolves the retired built-in style catalogue: the `builtin-*` ids
 * the app shipped before the Style Library moved to packs (removed from the
 * visible library 2026-09-02). An episode that still names one reads the
 * authored pack that owns that look — WHICH ids retired and which pack took
 * each over is the ledger's call, `content-packs/legacy-migration-dispositions.json`
 * (`style:builtin-*`), never a guess from the id's name.
 *
 * NOT COVERED, on purpose: the free-text `style_tag` override typed into the
 * Image Prompts page, and a preset the owner writes from now on. Both are new
 * text, not a mapping of old text, and both keep winning exactly as before.
 */

/** The Store namespace every Visual Style id lives in. */
const STYLE_NAMESPACE = 'com.storystudio.style.'

function style(slug: string): string {
  return `${STYLE_NAMESPACE}${slug}`
}

export interface StyleAlias {
  /** The Store style that carries the rendering contract. */
  styleId: string
  /** Preset ids the owner's channels already carry. Never rewritten. */
  presetIds: readonly string[]
}

export const STYLE_ALIASES: readonly StyleAlias[] = [
  {
    styleId: style('carved-woodcut-print'),
    presetIds: [
      'kh.art-styles.night-atlas-woodcut',
      'night-atlas-woodcut',
    ],
  },
  {
    styleId: style('lush-painterly-scenery'),
    presetIds: [
      'kh.art-styles.golden-hour-painterly',
      'kh.art-styles.lush-painterly',
      'night-atlas-lush-painterly',
    ],
  },
  {
    styleId: style('dark-moody-painterly'),
    presetIds: [
      'dark-moody-painterly',
      'kh.art-styles.dark-moody-painterly',
    ],
  },
  {
    styleId: style('vintage-copperplate-engraving'),
    presetIds: [
      'kh.art-styles.vintage-engraving',
      'vintage-engraving',
    ],
  },
  {
    styleId: style('warm-cosy-interior-illustration'),
    presetIds: [
      'cosy-caf-illustration',
      'kh.art-styles.cosy-cafe-illustration',
    ],
  },
  {
    styleId: style('storybook-stick-figure-cartoon'),
    presetIds: [
      'kh.art-styles.storybook-stick-figure-cartoon',
    ],
  },
  {
    styleId: style('muted-isometric-infographic'),
    presetIds: [
      'kh.art-styles.muted-isometric-infographic',
    ],
  },
  {
    styleId: style('dark-folk-horror-gouache'),
    presetIds: [
      'kh.art-styles.dark-painterly-folk-horror',
    ],
  },
  {
    styleId: style('stained-glass-panel-illustration'),
    presetIds: [
      'kh.art-styles.stained-glass-inspired',
    ],
  },
  {
    styleId: style('clean-editorial-illustration'),
    presetIds: [
      'kh.art-styles.clean-editorial-illustration',
    ],
  },
  {
    styleId: style('museum-diorama'),
    presetIds: [
      'kh.art-styles.museum-diorama',
    ],
  },
  {
    styleId: style('cosy-night-pixel-art'),
    presetIds: [
      'cozy-bedtime-pixel-art',
      'kh.art-styles.cozy-bedtime-pixel-art',
    ],
  },
  {
    styleId: style('matte-gouache-storybook'),
    presetIds: [
      'kh.art-styles.storybook-gouache',
      'night-atlas-storybook-gouache',
    ],
  },
  {
    styleId: style('naturalist-watercolour-plate'),
    presetIds: [
      'kh.art-styles.naturalist-painting-plate',
      'naturalist-painting-plate',
    ],
  },
  {
    styleId: style('painterly-prehistoric-life'),
    presetIds: [
      'kh.art-styles.painterly-prehistoric',
      'painterly-prehistoric',
    ],
  },
  {
    styleId: style('dreamlike-luminous-sleep-illustration'),
    presetIds: [
      'dreamlands',
      'kh.art-styles.dreamlands',
      'kh.art-styles.night-blue-watercolour',
      'kh.art-styles.soft-dreamlike-sleep',
      'kh.art-styles.soft-luminous-watercolour',
      'night-atlas-night-blue-watercolour',
      'sleep-from-channel-type',
    ],
  },
  {
    styleId: style('impasto-psychological-animals'),
    presetIds: [
      'dark-psychology-from-channel-type',
      'kh.art-styles.dark-psychology-impasto-animals',
    ],
  },
  {
    styleId: style('hand-drawn-hardship-cartoon'),
    presetIds: [
      'animals-from-channel-type',
      'kh.art-styles.expressive-cartoon-animals',
      'wildlife-field-comic',
    ],
  },
  {
    styleId: style('old-master-still-life'),
    presetIds: [
      'old-master-still-life',
    ],
  },
  {
    styleId: style('oil-painting-classical'),
    presetIds: [
      'builtin-oil-painting-classical',
      'kh.art-styles.painterly-historical-oil',
    ],
  },
  {
    styleId: style('prehistoric-stick-cartoon'),
    presetIds: [
      'builtin-prehistoric-stick-cartoon',
    ],
  },
  {
    styleId: style('bold-illustrated-history'),
    presetIds: [
      'bold-illustrated-history',
      'kh.owner.illustrated-history.bold-illustrated-history',
      // Owner, 2026-10-29: the Studio Library style is the one. A channel that
      // still names its own user-pack copy reads the signed style's bible.
      'kh.owner.style.bold-illustrated-history',
    ],
  },
  {
    styleId: style('watercolor-storybook'),
    presetIds: [
      'builtin-watercolor-storybook',
      'kh.art-styles.whimsical-storybook-watercolour',
    ],
  },
  {
    styleId: style('sepia-ink-wash'),
    presetIds: [
      'builtin-sepia-ink-wash',
      'kh.art-styles.vintage-historical-storybook',
    ],
  },
  {
    styleId: style('paleo-documentary-tableau'),
    presetIds: [
      'builtin-paleo-documentary-tableau',
      'kh.art-styles.misty-painterly-landscape',
    ],
  },
  // The rest of the retired built-in catalogue (the `style:builtin-*` entries
  // of content-packs/legacy-migration-dispositions.json). An episode may still
  // name any of them; each reads the authored pack that owns the look.
  // `builtin-ms-paint-fantasy` is Retro Paint Fantasy now — the ledger, not the
  // name, says which pack took it over.
  {
    styleId: style('anime-cel'),
    presetIds: ['builtin-anime-cel'],
  },
  {
    styleId: style('archival-documentary-reconstruction'),
    presetIds: ['builtin-archival-documentary-reconstruction'],
  },
  {
    styleId: style('cinematic-photoreal'),
    presetIds: ['builtin-cinematic-photoreal'],
  },
  {
    styleId: style('flat-vector-explainer'),
    presetIds: ['builtin-flat-vector-explainer'],
  },
  {
    styleId: style('hand-drawn-cartoon-explainer'),
    presetIds: ['builtin-hand-drawn-cartoon-explainer'],
  },
  {
    styleId: style('hand-drawn-editorial-diagram'),
    presetIds: ['builtin-hand-drawn-editorial-diagram'],
  },
  {
    styleId: style('minimal-stick-figure-explainer'),
    presetIds: ['builtin-minimal-stick-figure-explainer'],
  },
  {
    styleId: style('retro-paint-fantasy'),
    presetIds: ['builtin-ms-paint-fantasy'],
  },
  {
    styleId: style('pixel-art-story'),
    presetIds: ['builtin-pixel-art-story'],
  },
  {
    styleId: style('studio-catalog-realism'),
    presetIds: ['builtin-studio-catalog-realism'],
  },
  {
    styleId: style('waxy-outline-cartoon'),
    presetIds: ['builtin-waxy-outline-cartoon'],
  },
  {
    styleId: style('whiteboard-doodle-explainer'),
    presetIds: ['builtin-whiteboard-doodle-explainer'],
  },
]

/**
 * One preset id appears once. A collision would make the resolution depend on
 * table order, so it is refused rather than resolved by luck.
 */
const STYLE_ID_BY_PRESET_ID = (() => {
  const table = new Map<string, string>()
  for (const alias of STYLE_ALIASES) {
    for (const presetId of alias.presetIds) {
      const existing = table.get(presetId)
      if (existing && existing !== alias.styleId) {
        throw new Error(
          `style-aliases: preset id '${presetId}' is claimed by both '${existing}' and '${alias.styleId}'`)
      }
      table.set(presetId, alias.styleId)
    }
  }
  return table
})()

/**
 * The Store style that should serve this preset, when there is one.
 *
 * Returns null for an unknown id — including every id already in the Store
 * namespace — so callers can treat "no alias" and "nothing to alias" the same.
 */
export function aliasedVisualStyleId(presetId: string | null | undefined): string | null {
  const id = (presetId || '').trim()
  if (!id || id.startsWith(STYLE_NAMESPACE)) return null
  return STYLE_ID_BY_PRESET_ID.get(id) || null
}

/** How many preset ids this table resolves. Used by its test, not by the resolver. */
export const ALIASED_PRESET_ID_COUNT = STYLE_ID_BY_PRESET_ID.size
