import { createHash } from 'crypto'
import type { Niche, TopicCoverageGroup, TopicCoverageProfile, TopicPack } from '../models/types.js'

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

const COHERENT_AXIS_IDS = new Set(['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'])

type SubjectRow = {
  value: string
  packId?: string
  coverageGroup?: TopicCoverageGroup
  coverageSubjectIndex?: number
  coverageProfile?: TopicCoverageProfile
}

function coherentTuple(subject: SubjectRow, round: number): Record<string, string> | undefined {
  if (subject.coverageProfile) {
    const tuple = subject.coverageProfile.tuples[round % subject.coverageProfile.tuples.length]!
    return {
      'episode-object': tuple.episodeObject,
      'time-place-scope': tuple.timePlaceScope,
      mechanism: tuple.mechanism,
      'evidence-lens': tuple.evidenceLens,
    }
  }
  const group = subject.coverageGroup
  if (!group || subject.coverageSubjectIndex === undefined) return undefined
  const index = (subject.coverageSubjectIndex + round) % group.episodeObjects.length
  return {
    'episode-object': group.episodeObjects[index]!,
    'time-place-scope': group.timePlaceScopes[index]!,
    mechanism: group.mechanisms[index]!,
    'evidence-lens': group.evidenceLenses[index]!,
  }
}

function usedStructuralPairs(used: Set<string>, nicheId: string, subject: SubjectRow): Array<{ episodeObject: string, mechanism: string }> {
  if (!subject.packId) return []
  const prefix = `${nicheId}|${subject.packId}|`
  const subjectPart = `|subject=${slug(subject.value)}`
  return [...used].flatMap((fingerprint) => {
    if (!fingerprint.startsWith(prefix) || !fingerprint.includes(subjectPart)) return []
    const episodeObject = /(?:^|\|)episode-object=([^|]+)/.exec(fingerprint)?.[1]
    const mechanism = /(?:^|\|)mechanism=([^|]+)/.exec(fingerprint)?.[1]
    return episodeObject && mechanism ? [{ episodeObject, mechanism }] : []
  })
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

  const subjectRows: SubjectRow[] = []
  if (packs.length) {
    for (const pack of packs) {
      for (const subject of unique(pack.subjects)) {
        const profile = pack.coverageProfiles?.find(candidate => candidate.subject === subject)
        const matches = (pack.coverageGroups || []).flatMap(group => {
          const index = group.subjects.indexOf(subject)
          return index === -1 ? [] : [{ group, index }]
        })
        if (pack.coverageProfiles?.length && !profile) {
          throw new Error(`Topic Pack ${pack.id} cannot plan ${subject}: every subject requires exactly one coverage profile`)
        }
        if (!profile && pack.coverageGroups?.length && matches.length !== 1) {
          throw new Error(`Topic Pack ${pack.id} cannot plan ${subject}: every subject requires exactly one coverage group`)
        }
        subjectRows.push({
          value: subject,
          packId: pack.id,
          coverageGroup: matches[0]?.group,
          coverageSubjectIndex: matches[0]?.index,
          coverageProfile: profile,
        })
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

  // Formula axes apply to every subject; a Topic Pack's axes apply only to
  // subjects from that same pack. `composeNicheWithTopicPacks()` deliberately
  // exposes a merged axis catalog to the UI, but using that merged catalog
  // wholesale here can create nonsense assignments (for example, a deep-ocean
  // subject constrained by a human-origins evidence lens). Keeping the axes
  // scoped preserves both variety and conceptual coherence in large campaigns.
  const packAxisIds = new Set(packs.flatMap(pack => (pack.ideaAxes || []).map(axis => axis.id)))
  const formulaAxes = axes.filter(axis => !packAxisIds.has(axis.id))
  const axesByPack = new Map(packs.map(pack => [
    pack.id,
    (pack.ideaAxes || [])
      .filter(axis => axis.values?.length)
      .map(axis => ({ ...axis, values: unique(axis.values) })),
  ]))
  const axesForSubject = (subject: SubjectRow) => subject.packId
    ? [
      ...(axesByPack.get(subject.packId) || []).filter(axis => !(subject.coverageGroup || subject.coverageProfile) || !COHERENT_AXIS_IDS.has(axis.id)),
      ...formulaAxes.filter(axis => !subject.coverageProfile || !COHERENT_AXIS_IDS.has(axis.id)),
    ]
    : axes

  const targetPoolSize = Math.max(options.count * 4, options.count + 40)
  const candidates: IdeaAssignment[] = []
  const seen = new Set<string>()
  const primaryRank = new Map<string, number>()

  const reserveCandidate = (
    subject: SubjectRow,
    dimensions: Record<string, string>,
  ): IdeaAssignment | null => {
    const parts = [
      niche.id,
      subject.packId || 'formula',
      ...Object.entries(dimensions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${slug(key)}=${slug(value)}`),
    ]
    const fingerprint = parts.join('|')
    if (used.has(fingerprint) || seen.has(fingerprint)) return null
    seen.add(fingerprint)
    const digest = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12)
    const candidate = {
      idea_key: `idea-${digest}`,
      fingerprint,
      topic_pack_id: subject.packId,
      dimensions,
    }
    candidates.push(candidate)
    return candidate
  }

  // Coverage profiles are authored semantic records, not independently
  // combinable axes. Keep each subject paired to its complete tuple before
  // any seeded ordering or bounded reserve can select it; later rounds rotate
  // the whole record.
  for (const [rank, subject] of subjectRows.entries()) {
    if (!subject.packId) continue
    const dimensions: Record<string, string> = { subject: subject.value }
    Object.assign(dimensions, coherentTuple(subject, 0))
    for (const axis of axesForSubject(subject)) {
      dimensions[axis.id] = axis.values[rank % axis.values.length]!
    }
    const primary = reserveCandidate(subject, dimensions)
    if (primary) primaryRank.set(primary.fingerprint, rank)
  }

  // Enumerate the Cartesian space with mixed-radix counters, but stop once we
  // have a bounded reserve pool. This guarantees every conceptual combination
  // is reachable (stride-based cycling can accidentally visit only a subset
  // when axis lengths share factors).
  const totalCombinations = Math.min(1_000_000, subjectRows.reduce((total, subject) => {
    const combinationsForSubject = axesForSubject(subject)
      .reduce((product, axis) => Math.min(1_000_000, product * axis.values.length), 1)
    const tupleCount = subject.coverageProfile?.tuples.length || subject.coverageGroup?.episodeObjects.length || 1
    return Math.min(1_000_000, total + combinationsForSubject * tupleCount)
  }, 0))
  const maxRounds = Math.min(
    totalCombinations,
    Math.max(targetPoolSize * 8, used.size + targetPoolSize * 4),
  )
  for (let index = 0; index < maxRounds && candidates.length < targetPoolSize; index++) {
    const subject = subjectRows[index % subjectRows.length]!
    const dimensions: Record<string, string> = { subject: subject.value }
    let combinationIndex = Math.floor(index / subjectRows.length)
    if (subject.coverageGroup || subject.coverageProfile) {
      Object.assign(dimensions, coherentTuple(subject, combinationIndex))
      combinationIndex = Math.floor(combinationIndex / (subject.coverageProfile?.tuples.length || subject.coverageGroup!.episodeObjects.length))
    }
    axesForSubject(subject).forEach((axis) => {
      dimensions[axis.id] = axis.values[combinationIndex % axis.values.length]!
      combinationIndex = Math.floor(combinationIndex / axis.values.length)
    })
    reserveCandidate(subject, dimensions)
  }

  const siblingCounts = new Map<string, number>()
  const siblingStructures = new Map<string, Array<{ episodeObject: string, mechanism: string }>>()
  const assignments = candidates
    .sort((a, b) => {
      const leftRank = primaryRank.get(a.fingerprint)
      const rightRank = primaryRank.get(b.fingerprint)
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1
        if (rightRank === undefined) return -1
        return leftRank - rightRank
      }
      return stableScore(seed, a.fingerprint).localeCompare(stableScore(seed, b.fingerprint))
    })
    .filter((candidate) => {
      const pack = candidate.topic_pack_id ? packs.find(entry => entry.id === candidate.topic_pack_id) : undefined
      const limit = pack?.maxSiblingsPerSubject
      if (!limit) return true
      const key = `${candidate.topic_pack_id}|${candidate.dimensions.subject}`
      const episodeObject = candidate.dimensions['episode-object']
      const mechanism = candidate.dimensions.mechanism
      const subject = subjectRows.find(row => row.packId === candidate.topic_pack_id && row.value === candidate.dimensions.subject)
      const priorStructures = subject && episodeObject && mechanism
        ? siblingStructures.get(key) || usedStructuralPairs(used, niche.id, subject)
        : []
      if (episodeObject && mechanism && priorStructures.some(prior =>
        prior.episodeObject === slug(episodeObject) || prior.mechanism === slug(mechanism))) return false
      const next = (siblingCounts.get(key) || 0) + 1
      if (next > limit) return false
      siblingCounts.set(key, next)
      if (episodeObject && mechanism) {
        siblingStructures.set(key, [...priorStructures, { episodeObject: slug(episodeObject), mechanism: slug(mechanism) }])
      }
      return true
    })
  if (packs.some(pack => pack.coverageGroups?.length || pack.coverageProfiles?.length) && assignments.length < options.count) {
    throw new Error('Topic Pack coverage profiles cannot plan the requested campaign without repeating an episode object or mechanism')
  }
  return assignments
}

export function assignmentSummary(assignment: IdeaAssignment): string {
  return Object.entries(assignment.dimensions)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ')
}
