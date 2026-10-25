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
    ],
  },
  {
    styleId: style('watercolor-storybook'),
    presetIds: [
      'kh.art-styles.whimsical-storybook-watercolour',
    ],
  },
  {
    styleId: style('sepia-ink-wash'),
    presetIds: [
      'kh.art-styles.vintage-historical-storybook',
    ],
  },
  {
    styleId: style('paleo-documentary-tableau'),
    presetIds: [
      'kh.art-styles.misty-painterly-landscape',
    ],
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
