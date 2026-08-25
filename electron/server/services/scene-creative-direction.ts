import type {
  SceneCreativeDirection,
  SceneCreativeProfile,
  SceneCreativeStrategy,
  ScenePlanEntry,
} from '../models/types.js'

export interface CreativeProfileDefinition {
  label: string
  usage: string
  weights: Partial<Record<SceneCreativeStrategy, number>>
}

export const CREATIVE_STRATEGY_LABELS: Record<SceneCreativeStrategy, string> = {
  'literal-narrative': 'Literal narrative',
  documentary: 'Documentary',
  'editorial-metaphor': 'Editorial metaphor',
  symbolic: 'Symbolic',
  'poetic-environment': 'Poetic environment',
  'character-psychology': 'Character psychology',
  'spiritual-allegory': 'Spiritual allegory',
  surreal: 'Surreal',
  'conceptual-collage': 'Conceptual collage',
  'minimal-graphic': 'Minimal graphic',
}

export const CREATIVE_STRATEGY_INSTRUCTIONS: Record<SceneCreativeStrategy, string> = {
  'literal-narrative': 'Depict the narrated event or action directly, selecting the most cinematic and specific moment rather than illustrating every noun.',
  documentary: 'Use an observational, grounded image built from credible people, places, artifacts, and period details; avoid generic stock-photo staging.',
  'editorial-metaphor': 'Translate the underlying argument or tension into one clear visual analogy. The metaphor must be understandable without text labels.',
  symbolic: 'Represent the scene through a meaningful object, contrast, threshold, transformation, or recurring symbol instead of a literal reenactment.',
  'poetic-environment': 'Let landscape, weather, light, color, scale, and negative space carry the emotional meaning while retaining a connection to the narration.',
  'character-psychology': 'Externalize an inner state through posture, spatial pressure, reflections, shadows, divided spaces, or environmental behavior; avoid a generic portrait.',
  'spiritual-allegory': 'Use reverent visual allegory such as journey, shelter, wilderness, water, seed, illumination, renewal, or communion without defaulting to stock religious imagery.',
  surreal: 'Use coherent dream logic, impossible scale, transformation, suspension, fragmentation, or unexpected spatial relationships to express the idea.',
  'conceptual-collage': 'Combine a small number of contrasting subjects or visual fragments into one intentional editorial composition with a strong hierarchy.',
  'minimal-graphic': 'Reduce the idea to one dominant subject, bold silhouette or shape relationship, generous negative space, and a single immediately readable concept.',
}

export const CREATIVE_PROFILES: Record<Exclude<SceneCreativeProfile, 'custom'>, CreativeProfileDefinition> = {
  narrative: {
    label: 'Narrative',
    usage: 'Best for stories, history, biographies, and explanations where clarity and continuity matter most.',
    weights: { 'literal-narrative': 6, documentary: 5, 'poetic-environment': 1 },
  },
  balanced: {
    label: 'Balanced',
    usage: 'Best for general educational videos that benefit from clear scenes with occasional visual metaphor.',
    weights: { 'literal-narrative': 5, documentary: 4, 'editorial-metaphor': 2, symbolic: 2, 'poetic-environment': 2, 'minimal-graphic': 1 },
  },
  editorial: {
    label: 'Editorial',
    usage: 'Best for psychology, culture, commentary, business, and conceptual explanations.',
    weights: { 'editorial-metaphor': 6, 'character-psychology': 5, symbolic: 4, 'minimal-graphic': 3, 'conceptual-collage': 3, 'literal-narrative': 1 },
  },
  spiritual: {
    label: 'Spiritual',
    usage: 'Best for faith, reflection, prayer, hope, healing, and poetic devotional storytelling.',
    weights: { 'spiritual-allegory': 6, symbolic: 5, 'poetic-environment': 5, 'minimal-graphic': 2, 'literal-narrative': 1 },
  },
  abstract: {
    label: 'Abstract',
    usage: 'Best for artistic essays, dreamlike sequences, music-led work, and ideas that should be felt rather than reenacted.',
    weights: { surreal: 6, 'conceptual-collage': 5, symbolic: 5, 'poetic-environment': 4, 'minimal-graphic': 3, 'editorial-metaphor': 2 },
  },
}

export const ALL_CREATIVE_STRATEGIES = Object.keys(CREATIVE_STRATEGY_LABELS) as SceneCreativeStrategy[]

const DEFAULT_CUSTOM_STRATEGIES: SceneCreativeStrategy[] = [
  'literal-narrative',
  'editorial-metaphor',
  'symbolic',
  'poetic-environment',
]

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().slice(0, max)
  return cleaned || undefined
}

export function normalizeCreativeDirection(value?: Partial<SceneCreativeDirection> | null): SceneCreativeDirection {
  const profile: SceneCreativeProfile = value?.profile === 'balanced'
    || value?.profile === 'editorial'
    || value?.profile === 'spiritual'
    || value?.profile === 'abstract'
    || value?.profile === 'custom'
    ? value.profile : 'narrative'
  const rawIntensity = Math.round(Number(value?.intensity) || 2)
  const intensity = Math.max(1, Math.min(4, rawIntensity)) as SceneCreativeDirection['intensity']
  const strategies = Array.isArray(value?.strategies)
    ? [...new Set(value.strategies.filter((item): item is SceneCreativeStrategy => ALL_CREATIVE_STRATEGIES.includes(item as SceneCreativeStrategy)))]
    : []
  return {
    profile,
    intensity,
    strategies: strategies.length ? strategies : [...DEFAULT_CUSTOM_STRATEGIES],
    recurring_motifs: cleanText(value?.recurring_motifs, 1200),
    avoid_cliches: cleanText(value?.avoid_cliches, 1200),
    custom_direction: cleanText(value?.custom_direction, 2000),
  }
}

function stableHash(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const AFFINITY: Partial<Record<SceneCreativeStrategy, RegExp>> = {
  documentary: /\b(year|century|history|evidence|archive|document|city|country|war|king|queen|scientist|invent|discovered|built)\b/i,
  'editorial-metaphor': /\b(power|system|society|pressure|expectation|choice|career|money|trust|control|success|failure|conflict)\b/i,
  symbolic: /\b(hope|fear|truth|freedom|memory|change|loss|identity|purpose|belief|promise|secret)\b/i,
  'poetic-environment': /\b(night|dawn|light|dark|rain|storm|sea|sky|forest|river|silence|journey|path|winter|summer)\b/i,
  'character-psychology': /\b(feel|mind|thought|anxiety|emotion|identity|desire|confidence|lonely|shame|grief|trauma|habit)\b/i,
  'spiritual-allegory': /\b(god|faith|prayer|grace|soul|spirit|blessing|mercy|worship|sacred|heaven|forgive|redemption)\b/i,
  surreal: /\b(dream|impossible|strange|reality|illusion|infinite|unconscious|paradox|timeless)\b/i,
  'conceptual-collage': /\b(between|versus|forces|parts|many|several|list|compare|past and present|on one hand)\b/i,
  'minimal-graphic': /\b(single|one|only|simple|core|essential|focus|choice|point)\b/i,
}

function candidateWeights(direction: SceneCreativeDirection): Partial<Record<SceneCreativeStrategy, number>> {
  if (direction.profile === 'custom') {
    return Object.fromEntries(direction.strategies.map(strategy => [strategy, 4])) as Partial<Record<SceneCreativeStrategy, number>>
  }
  return CREATIVE_PROFILES[direction.profile].weights
}

/** Assigns a stable, varied strategy to every scene without an LLM call. */
export function assignCreativeStrategies(
  scenes: ScenePlanEntry[],
  rawDirection: Partial<SceneCreativeDirection> | null | undefined,
  episodeSeed: string,
  preserveExisting = true,
): SceneCreativeDirection {
  const direction = normalizeCreativeDirection(rawDirection)
  const weights = candidateWeights(direction)
  const candidates = ALL_CREATIVE_STRATEGIES.filter(strategy => (weights[strategy] || 0) > 0)
  const usage = new Map<SceneCreativeStrategy, number>()
  let previous: SceneCreativeStrategy | undefined

  for (const scene of scenes) {
    if (preserveExisting && scene.creative_strategy && candidates.includes(scene.creative_strategy)) {
      previous = scene.creative_strategy
      usage.set(previous, (usage.get(previous) || 0) + 1)
      continue
    }
    const transcript = scene.transcript_segment || ''
    let best = candidates[0] || 'literal-narrative'
    let bestScore = Number.NEGATIVE_INFINITY
    for (const strategy of candidates) {
      const affinity = AFFINITY[strategy]?.test(transcript) ? 1 : 0
      const jitter = stableHash(`${episodeSeed}:${scene.id}:${strategy}`) % 31
      const repeatPenalty = strategy === previous ? 240 : 0
      const usagePenalty = (usage.get(strategy) || 0) * (16 + direction.intensity * 7)
      const score = (weights[strategy] || 0) * 100
        + affinity * (35 + direction.intensity * 15)
        + jitter - repeatPenalty - usagePenalty
      if (score > bestScore) {
        best = strategy
        bestScore = score
      }
    }
    scene.creative_strategy = best
    previous = best
    usage.set(best, (usage.get(best) || 0) + 1)
  }
  return direction
}

export function buildCreativeDirectionPrompt(directionInput: Partial<SceneCreativeDirection> | null | undefined): string {
  const direction = normalizeCreativeDirection(directionInput)
  const definition = direction.profile === 'custom'
    ? { label: 'Custom', usage: 'Use the operator-selected visual strategies.' }
    : CREATIVE_PROFILES[direction.profile]
  const lines = [
    `CREATIVE DIRECTION: ${definition.label}, intensity ${direction.intensity}/4. ${definition.usage}`,
    'Interpret the meaning of each narration beat before choosing imagery. Do not merely turn every mentioned noun into a literal inventory.',
  ]
  if (direction.recurring_motifs) lines.push(`RECURRING MOTIFS (use selectively, never in consecutive scenes): ${direction.recurring_motifs}`)
  if (direction.avoid_cliches) lines.push(`AVOIDED CLICHES / IMAGERY: ${direction.avoid_cliches}`)
  if (direction.custom_direction) lines.push(`CUSTOM CREATIVE DIRECTION: ${direction.custom_direction}`)
  return lines.join('\n')
}

export function buildStrategyGlossary(strategies: SceneCreativeStrategy[]): string {
  const unique = [...new Set(strategies)]
  return unique.map(strategy => `${strategy}: ${CREATIVE_STRATEGY_INSTRUCTIONS[strategy]}`).join('\n')
}
