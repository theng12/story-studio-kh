/**
 * App-owned recency extraction strategies. Content Packs may select an ID,
 * but never deliver a pattern or prompt template for Story to execute.
 */
export const RECENCY_STRATEGY_IDS = [
  'scripture-references',
  'pastoral-daily-reflection-scripture',
  'pastoral-expository-teaching-scripture',
] as const
export type RecencyStrategyId = typeof RECENCY_STRATEGY_IDS[number]

export interface RecencyStrategy {
  extractPatterns: readonly string[]
  instructionTemplate: string
}

const SCRIPTURE_REFERENCE_PATTERN = '\\b(?:[123]\\s+)?(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Song\\s+of\\s+Solomon|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)\\s+\\d+(?::\\d+(?:-\\d+)?)?'

export const RECENCY_STRATEGIES: Readonly<Record<RecencyStrategyId, RecencyStrategy>> = {
  'scripture-references': {
    extractPatterns: [SCRIPTURE_REFERENCE_PATTERN],
    instructionTemplate: "These {label} were used in this channel's recent {count} prayer episodes — pick a DIFFERENT verse for this prayer:\n{items}\n\nThe Bible has 66 books — don't keep cycling through Psalm 91 / Philippians 4:6-7 / Isaiah 41:10. Branch into less-quoted passages that fit this prayer's specific theme. Examples of underused but powerful passages: Lamentations 3:22-24 (mercies new every morning), Zephaniah 3:17 (God rejoices over you with singing), Habakkuk 3:17-19 (joy in scarcity), 2 Corinthians 12:9 (grace sufficient in weakness), Hebrews 4:14-16 (approach the throne of grace), 1 Peter 5:7 (cast your anxieties), Romans 8:28 (all things work for good), James 1:2-4 (count it joy), Isaiah 43:1-3 (passing through waters), Psalm 34:18 (close to the brokenhearted), Psalm 139:7-12 (nowhere from His presence).",
  },
  'pastoral-daily-reflection-scripture': {
    extractPatterns: [SCRIPTURE_REFERENCE_PATTERN],
    instructionTemplate: "These {label} were used in this channel's recent {count} devotional episodes — anchor THIS devotional on a DIFFERENT passage:\n{items}\n\nThe Bible has 66 books and devotional channels especially benefit from variety — your audience returns for fresh teaching, not for the same six 'comfort verses' on rotation. Branch into less-quoted but theologically rich passages: 2 Corinthians 4:7-10 (treasure in jars of clay), Romans 12:1-2 (renewing of the mind), James 1:19-20 (slow to speak, slow to anger), 1 Peter 3:8-9 (live in harmony), Philippians 2:5-11 (the kenosis hymn), Hebrews 12:1-2 (cloud of witnesses), Ecclesiastes 3:1-8 (time for everything), Micah 6:8 (do justly, love mercy), Galatians 5:22-23 (fruit of the Spirit).",
  },
  'pastoral-expository-teaching-scripture': {
    extractPatterns: [SCRIPTURE_REFERENCE_PATTERN],
    instructionTemplate: "These {label} were the primary anchors in this channel's recent {count} sermons — pick a DIFFERENT primary text for this preaching episode:\n{items}\n\nPreaching channels especially benefit from showing the breadth of scripture — congregants tune in expecting to encounter passages they don't already know by heart. Branch into less-frequently-preached passages: 2 Kings 6 (Elisha and the chariots of fire), Nehemiah 8 (the public reading of the law), Acts 17 (Paul at the Areopagus), Romans 9-11 (Israel's place in salvation history), Hebrews 11 (the hall of faith), Revelation 7 (the great multitude), Job 38-41 (the Lord answers from the whirlwind), Ezekiel 37 (the valley of dry bones), Hosea 11 (the father's heart).",
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
