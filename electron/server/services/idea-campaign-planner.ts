import { createHash } from 'crypto'
import type { Niche, TopicCoverageGroup, TopicCoverageProfile, TopicPack } from '../models/types.js'

export interface IdeaAssignment {
  idea_key: string
  fingerprint: string
  topic_pack_id?: string
  dimensions: Record<string, string>
}

type SubjectRow = {
  value: string
  packId?: string
  planningAxes: Array<{ id: string; label: string; values: string[] }>
  coverageGroup?: TopicCoverageGroup
  coverageSubjectIndex?: number
  coverageProfile?: TopicCoverageProfile
}

const PACK_PLANNING_FIELDS = [
  ['episode-object', 'Episode object', 'episodeObjects'],
  ['time-place-scope', 'Time and place', 'timePlaceScopes'],
  ['mechanism', 'Mechanism', 'mechanisms'],
  ['evidence-lens', 'Evidence lens', 'evidenceLenses'],
] as const

const MATERIAL_SIBLING_DIMENSIONS = ['episode-object', 'time-place-scope', 'mechanism'] as const

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

function planningAxes(pack: TopicPack): SubjectRow['planningAxes'] {
  return PACK_PLANNING_FIELDS.flatMap(([id, label, field]) => {
    const values = unique(pack[field] || [])
    return values.length ? [{ id, label, values }] : []
  })
}

function independentSiblingCapacity(axes: SubjectRow['planningAxes']): number | undefined {
  const materialAxes = MATERIAL_SIBLING_DIMENSIONS.map(id => axes.find(axis => axis.id === id))
  return materialAxes.every(Boolean)
    ? Math.min(...materialAxes.map(axis => axis!.values.length))
    : undefined
}

function dimensionsFromFingerprint(fingerprint: string): Record<string, string> {
  return Object.fromEntries(fingerprint.split('|').slice(2).flatMap(part => {
    const separator = part.indexOf('=')
    return separator > 0 ? [[part.slice(0, separator), part.slice(separator + 1)]] : []
  }))
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
      const packPlanningAxes = planningAxes(pack)
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
          planningAxes: packPlanningAxes,
          coverageGroup: matches[0]?.group,
          coverageSubjectIndex: matches[0]?.index,
          coverageProfile: profile,
        })
      }
    }
  } else {
    for (const topic of unique(niche.exampleTopics)) subjectRows.push({ value: topic, planningAxes: [] })
  }
  if (!subjectRows.length) subjectRows.push({ value: niche.name, planningAxes: [] })

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
  const axesForSubject = (subject: SubjectRow) => {
    if (!subject.packId) return axes
    if (subject.coverageGroup || subject.coverageProfile) {
      return [
        ...(axesByPack.get(subject.packId) || []).filter(axis => !COHERENT_AXIS_IDS.has(axis.id)),
        ...formulaAxes.filter(axis => !COHERENT_AXIS_IDS.has(axis.id)),
      ]
    }
    const planningAxisIds = new Set(subject.planningAxes.map(axis => axis.id))
    return [
      ...subject.planningAxes,
      ...formulaAxes.filter(axis => !planningAxisIds.has(axis.id)),
      ...(axesByPack.get(subject.packId) || []).filter(axis => !planningAxisIds.has(axis.id)),
    ]
  }

  // The pool must be able to see PAST the history, not just past the request.
  //
  // A reserved idea still costs a pool slot. It enumerates as a distinct
  // fingerprint — the same structure carrying a different non-structural axis
  // value — so it is only rejected later, by the structural filter. Sizing the
  // pool from `count` alone therefore let the enumeration run out inside a
  // round the history had already consumed, and the planner concluded the pack
  // was exhausted with thousands of tuples untouched.
  //
  // Measured on money-debt (100 subjects x 20 tuples, 500 reserved): count 1
  // gave a pool of 41 against 100 subject rows, so the walk stopped partway
  // through round 0 — every candidate a burned structure — and threw. The
  // shape was perverse enough to be worth naming: asking for ONE idea failed
  // while asking for sixty succeeded, because only the larger pool looked far
  // enough ahead.
  //
  // Within the first T rounds the walk visits every (subject, tuple) exactly
  // once, so at most `used.size` slots can be spent on burned structures.
  // `used.size + count` is therefore the smallest budget that guarantees
  // `count` fresh candidates are SEEN whenever they exist. `maxRounds` below
  // already scales with `used.size`; this makes the pool agree with it.
  const targetPoolSize = Math.max(options.count * 4, options.count + 40, used.size + options.count)
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
    const structuralRound = combinationIndex
    let isInitialGenericSibling = false
    if (subject.coverageGroup || subject.coverageProfile) {
      Object.assign(dimensions, coherentTuple(subject, combinationIndex))
      combinationIndex = Math.floor(combinationIndex / (subject.coverageProfile?.tuples.length || subject.coverageGroup!.episodeObjects.length))
    } else {
      const initialIndependentSiblings = independentSiblingCapacity(subject.planningAxes) || 0
      isInitialGenericSibling = structuralRound < initialIndependentSiblings
      let planningCombinationIndex = combinationIndex
      if (initialIndependentSiblings && combinationIndex < initialIndependentSiblings) {
        for (const axis of subject.planningAxes) dimensions[axis.id] = axis.values[combinationIndex]!
        planningCombinationIndex = 0
      } else {
        planningCombinationIndex -= initialIndependentSiblings
      }
      for (const axis of subject.planningAxes) {
        if (dimensions[axis.id]) continue
        dimensions[axis.id] = axis.values[planningCombinationIndex % axis.values.length]!
        planningCombinationIndex = Math.floor(planningCombinationIndex / axis.values.length)
      }
      combinationIndex = planningCombinationIndex
    }
    const planningAxisIds = new Set(subject.planningAxes.map(axis => axis.id))
    axesForSubject(subject).filter(axis => !planningAxisIds.has(axis.id)).forEach((axis) => {
      dimensions[axis.id] = axis.values[combinationIndex % axis.values.length]!
      combinationIndex = Math.floor(combinationIndex / axis.values.length)
    })
    const candidate = reserveCandidate(subject, dimensions)
    if (candidate && isInitialGenericSibling) {
      primaryRank.set(candidate.fingerprint, subjectRows.length * (structuralRound + 1) + (index % subjectRows.length))
    }
  }

  const siblingCounts = new Map<string, number>()
  const siblingStructures = new Map<string, Array<{ episodeObject: string, mechanism: string }>>()
  /**
   * `usedStructuralPairs` rescans the WHOLE reserved set, and the filter below
   * memoises its result only when a candidate is accepted. At exhaustion
   * nothing is accepted, so it rescanned once per candidate — O(pool x used).
   *
   * That was survivable only because the pool was too small to matter. Sizing
   * the pool correctly above turns it into a real regression: money-debt at
   * exhaustion went 1.3s -> 22.0s. Memoising per subject makes the scan happen
   * once per subject instead of once per candidate (1.2s), and it is exactly
   * equivalent — the function is pure in `used`, which never changes here.
   */
  const usedStructuresBySubject = new Map<string, Array<{ episodeObject: string, mechanism: string }>>()
  const priorUsedStructures = (subject: SubjectRow): Array<{ episodeObject: string, mechanism: string }> => {
    const memoKey = `${subject.packId || ''}|${slug(subject.value)}`
    let cached = usedStructuresBySubject.get(memoKey)
    if (cached === undefined) {
      cached = usedStructuralPairs(used, niche.id, subject)
      usedStructuresBySubject.set(memoKey, cached)
    }
    return cached
  }
  const genericSiblingCounts = new Map<string, number>()
  const genericMaterialValues = new Map<string, Map<string, Set<string>>>()
  for (const fingerprint of used) {
    const [fingerprintNiche, packId] = fingerprint.split('|')
    if (fingerprintNiche !== niche.id || !packId) continue
    const dimensions = dimensionsFromFingerprint(fingerprint)
    const subject = subjectRows.find(row => row.packId === packId && slug(row.value) === dimensions.subject)
    if (!subject || subject.coverageGroup || subject.coverageProfile) continue
    const pack = packs.find(entry => entry.id === packId)
    if (!pack?.maxSiblingsPerSubject) continue
    const key = `${packId}|${dimensions.subject}`
    genericSiblingCounts.set(key, (genericSiblingCounts.get(key) || 0) + 1)
    if (!MATERIAL_SIBLING_DIMENSIONS.every(dimension => dimensions[dimension])) continue
    const valuesByDimension = genericMaterialValues.get(key) || new Map<string, Set<string>>()
    for (const dimension of MATERIAL_SIBLING_DIMENSIONS) {
      const values = valuesByDimension.get(dimension) || new Set<string>()
      values.add(dimensions[dimension]!)
      valuesByDimension.set(dimension, values)
    }
    genericMaterialValues.set(key, valuesByDimension)
  }
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
      const episodeObject = candidate.dimensions['episode-object']
      const mechanism = candidate.dimensions.mechanism
      const subject = subjectRows.find(row => row.packId === candidate.topic_pack_id && row.value === candidate.dimensions.subject)
      if (subject && !subject.coverageGroup && !subject.coverageProfile) {
        const key = `${candidate.topic_pack_id}|${slug(candidate.dimensions.subject)}`
        const boundedLimit = Math.min(limit, independentSiblingCapacity(subject.planningAxes) || limit)
        if ((genericSiblingCounts.get(key) || 0) >= boundedLimit) return false
        if (MATERIAL_SIBLING_DIMENSIONS.every(dimension => candidate.dimensions[dimension])) {
          const valuesByDimension = genericMaterialValues.get(key) || new Map<string, Set<string>>()
          if (MATERIAL_SIBLING_DIMENSIONS.some(dimension =>
            valuesByDimension.get(dimension)?.has(slug(candidate.dimensions[dimension]!)))) return false
          for (const dimension of MATERIAL_SIBLING_DIMENSIONS) {
            const values = valuesByDimension.get(dimension) || new Set<string>()
            values.add(slug(candidate.dimensions[dimension]!))
            valuesByDimension.set(dimension, values)
          }
          genericMaterialValues.set(key, valuesByDimension)
        }
        genericSiblingCounts.set(key, (genericSiblingCounts.get(key) || 0) + 1)
        return true
      }
      const key = `${candidate.topic_pack_id}|${candidate.dimensions.subject}`
      const priorStructures = subject && episodeObject && mechanism
        ? siblingStructures.get(key) || priorUsedStructures(subject)
        : []
      if (episodeObject && mechanism && priorStructures.some(prior =>
        prior.episodeObject === slug(episodeObject) || prior.mechanism === slug(mechanism))) return false
      // Coverage packs use coherent tuples. Their pre-existing assignments are
      // recovered as prior structures above, but they must also consume the
      // declared sibling capacity; otherwise a one-sibling pack can issue a
      // second tuple after a previously accepted assignment.
      const next = (siblingCounts.get(key) ?? priorStructures.length) + 1
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

/**
 * #6 supply counter (1.4.285): per active pack, how many of its distinct subjects have no idea yet.
 * Read from the same fingerprints `planIdeaAssignments` reserves against (`<formula>|<pack>|…|subject=<slug>|…`),
 * so the counter and the generator cannot disagree about what is used.
 */
export function subjectUseByPack(niche: Niche, usedFingerprints: Iterable<string>): Array<{ id: string; name: string; unused: number; total: number }> {
  const used = [...usedFingerprints]
  return (niche.activeTopicPacks || []).map(pack => {
    const prefix = `${niche.id}|${pack.id}|`
    const subjects = unique(pack.subjects)
    const unused = subjects.filter(subject => {
      const part = `subject=${slug(subject)}`
      return !used.some(fp => fp.startsWith(prefix) && fp.split('|').includes(part))
    }).length
    return { id: pack.id, name: pack.name, unused, total: subjects.length }
  })
}
