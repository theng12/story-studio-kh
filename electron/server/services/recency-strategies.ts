/**
 * App-owned recency extraction strategies. Content Packs may select an ID,
 * but never deliver a pattern or prompt template for Story to execute.
 */
export const RECENCY_STRATEGY_IDS = ['scripture-references'] as const
export type RecencyStrategyId = typeof RECENCY_STRATEGY_IDS[number]

export interface RecencyStrategy {
  extractPatterns: readonly string[]
  instructionTemplate: string
}

export const RECENCY_STRATEGIES: Readonly<Record<RecencyStrategyId, RecencyStrategy>> = {
  'scripture-references': {
    extractPatterns: [
      '\\b(?:[123]\\s+)?(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Song\\s+of\\s+Solomon|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)\\s+\\d+(?::\\d+(?:-\\d+)?)?',
    ],
    instructionTemplate: "These {label} were used in this channel's recent {count} prayer episodes — pick a DIFFERENT verse for this prayer:\n{items}\n\nThe Bible has 66 books — don't keep cycling through Psalm 91 / Philippians 4:6-7 / Isaiah 41:10. Branch into less-quoted passages that fit this prayer's specific theme. Examples of underused but powerful passages: Lamentations 3:22-24 (mercies new every morning), Zephaniah 3:17 (God rejoices over you with singing), Habakkuk 3:17-19 (joy in scarcity), 2 Corinthians 12:9 (grace sufficient in weakness), Hebrews 4:14-16 (approach the throne of grace), 1 Peter 5:7 (cast your anxieties), Romans 8:28 (all things work for good), James 1:2-4 (count it joy), Isaiah 43:1-3 (passing through waters), Psalm 34:18 (close to the brokenhearted), Psalm 139:7-12 (nowhere from His presence).",
  },
}

export function resolveRecencyStrategy(id: string): RecencyStrategy {
  const strategy = RECENCY_STRATEGIES[id as RecencyStrategyId]
  if (!strategy) throw new Error(`Unknown recency strategy: ${id}`)
  return {
    extractPatterns: [...strategy.extractPatterns],
    instructionTemplate: strategy.instructionTemplate,
  }
}
