import { createHash } from 'crypto'
import type { Niche, TopicPack } from '../models/types.js'

export interface IdeaAssignment {
  idea_key: string
  fingerprint: string
  topic_pack_id?: string
  dimensions: Record<string, string>
}

const UNIVERSAL_COVERAGE_ANGLES = [
  'hidden system',
  'daily reality',
  'origin and first adoption',
  'survival pressure',
  'economic constraint',
  'status and hierarchy',
  'tools and technology',
  'labor and expertise',
  'risk and failure',
  'scale and logistics',
  'law and regulation',
  'family and community',
  'environment and geography',
  'misconception versus evidence',
  'crisis response',
  'seasonal change',
  'resource scarcity',
  'trade and exchange',
  'power and inequality',
  'long-term consequence',
]

const UNIVERSAL_PRESENTATION_LENSES = [
  'cause and origin',
  'step-by-step process',
  'human consequence',
  'before and after',
  'timeline of change',
  'myth versus evidence',
  'representative case study',
  'constraint and trade-off',
  'critical decision',
  'failure analysis',
]

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100)
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const clean = value?.trim()
    const key = clean?.toLowerCase()
    if (!clean || !key || seen.has(key)) continue
    seen.add(key)
    result.push(clean)
  }
  return result
}

function stableScore(seed: string, value: string): string {
  return createHash('sha256').update(`${seed}|${value}`).digest('hex')
}

/**
 * Build a large deterministic pool of conceptual assignments before any LLM
 * call. Exact fingerprints are reserved from structured dimensions, so a
 * retry or a second project using the same Series Formula cannot silently
 * rephrase an already-used concept.
 */
export function planIdeaAssignments(options: {
  niche: Niche
  count: number
  usedFingerprints?: Iterable<string>
  seed: string
}): IdeaAssignment[] {
  const { niche, seed } = options
  const used = new Set(options.usedFingerprints || [])
  const packs: TopicPack[] = niche.activeTopicPacks || []

  const subjectRows: Array<{ value: string; packId?: string }> = []
  if (packs.length) {
    for (const pack of packs) {
      for (const subject of unique(pack.subjects)) {
        subjectRows.push({ value: subject, packId: pack.id })
      }
    }
  } else {
    for (const topic of unique(niche.exampleTopics)) subjectRows.push({ value: topic })
  }
  if (!subjectRows.length) subjectRows.push({ value: niche.name })

  const axes = (niche.ideaAxes || [])
    .filter(axis => axis.values?.length)
    .map(axis => ({ ...axis, values: unique(axis.values) }))
  if (!axes.some(axis => axis.id === 'coverage-angle')) {
    axes.push({
      id: 'coverage-angle',
      label: 'Coverage angle',
      values: UNIVERSAL_COVERAGE_ANGLES,
    })
  }
  // A completely generic project can have only one subject row and no
  // formula-owned axes. A second neutral axis keeps 100-slot campaigns
  // possible without pretending that title rewording is conceptual variety.
  if (axes.length < 2 && !axes.some(axis => axis.id === 'presentation-lens')) {
    axes.push({
      id: 'presentation-lens',
      label: 'Presentation lens',
      values: UNIVERSAL_PRESENTATION_LENSES,
    })
  }

  const targetPoolSize = Math.max(options.count * 4, options.count + 40)
  const candidates: IdeaAssignment[] = []
  const seen = new Set<string>()

  // Enumerate the Cartesian space with mixed-radix counters, but stop once we
  // have a bounded reserve pool. This guarantees every conceptual combination
  // is reachable (stride-based cycling can accidentally visit only a subset
  // when axis lengths share factors).
  let totalCombinations = subjectRows.length
  for (const axis of axes) {
    totalCombinations = Math.min(1_000_000, totalCombinations * axis.values.length)
  }
  const maxRounds = Math.min(
    totalCombinations,
    Math.max(targetPoolSize * 8, used.size + targetPoolSize * 4),
  )
  for (let index = 0; index < maxRounds && candidates.length < targetPoolSize; index++) {
    const subject = subjectRows[index % subjectRows.length]!
    const dimensions: Record<string, string> = { subject: subject.value }
    let combinationIndex = Math.floor(index / subjectRows.length)
    axes.forEach((axis) => {
      dimensions[axis.id] = axis.values[combinationIndex % axis.values.length]!
      combinationIndex = Math.floor(combinationIndex / axis.values.length)
    })
    const parts = [
      niche.id,
      subject.packId || 'formula',
      ...Object.entries(dimensions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${slug(key)}=${slug(value)}`),
    ]
    const fingerprint = parts.join('|')
    if (used.has(fingerprint) || seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const digest = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12)
    candidates.push({
      idea_key: `idea-${digest}`,
      fingerprint,
      topic_pack_id: subject.packId,
      dimensions,
    })
  }

  return candidates
    .sort((a, b) => stableScore(seed, a.fingerprint).localeCompare(stableScore(seed, b.fingerprint)))
}

export function assignmentSummary(assignment: IdeaAssignment): string {
  return Object.entries(assignment.dimensions)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ')
}
