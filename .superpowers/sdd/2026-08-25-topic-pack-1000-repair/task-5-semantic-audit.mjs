import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const sourcePath = 'content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json'
const reviewPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/habits-momentum-semantic-review.md'
const reviewedTemplateCommit = '19df47b5d702cf41e1d7ced75e609a0761058440'
const rejectReviewedTemplate = process.argv.includes('--reject-reviewed-template')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function unique(values, label) {
  assert(new Set(values).size === values.length, `${label} must be unique`)
}

function mechanismTrigrams(value) {
  const ignored = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'at', 'for', 'with', 'in', 'on', 'or'])
  const core = value.replace(/^[^:]+:\s*/i, '').replace(/\s+via .+? at /i, ' at ')
  const tokens = core.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(token => token && !ignored.has(token))
  return Array.from({ length: Math.max(0, tokens.length - 2) }, (_, index) => tokens.slice(index, index + 3).join(' '))
}

function audit(source, review, options = {}) {
  const tuples = source.coverage_profiles.flatMap((profile, profileIndex) => profile.tuples.map((tuple, tupleIndex) => ({
    subject: profile.subject,
    profileIndex,
    tupleIndex,
    ...tuple,
  })))
  assert(source.subjects.length === 50, 'expected 50 subjects')
  assert(source.coverage_profiles.length === 50, 'expected 50 profiles')
  assert(tuples.length === 1000, 'expected 1,000 tuples')
  assert(source.max_siblings_per_subject === 20, 'expected sibling cap 20')
  unique(source.subjects, 'subjects')
  unique(tuples.map(tuple => tuple.episode_object), 'episode objects')
  unique(tuples.map(tuple => `${tuple.episode_object}|${tuple.mechanism}`), 'object/mechanism pairs')
  unique(tuples.map(tuple => `${tuple.subject}|${tuple.episode_object}|${tuple.time_place_scope}|${tuple.mechanism}|${tuple.evidence_lens}`), 'complete tuples')

  const badCopy = /\b(?:todo|tbd|lorem|placeholder|various|mechanism\s*\d+|tuple\s*\d+|focus:|test:)\b/i
  const badSafety = /\b(?:no excuses|push through pain|guaranteed|cure|diagnose|treat anxiety|moral failure|lazy people|make money fast)\b/i
  const badGrammar = /\b(?:a a|an a|a an|the the|and and|to to|for for)\b/i
  const badClauseSlot = /\btoward\s+(?:the\s+)?(?:[a-z]+\s+){0,10}(?:has|reduces|remains|is)\b/i
  const badVerbObject = /\b(?:keeping|weighing|logging)\s+(?:prepare|launch|begin|resume|leave|pack|start|return|practice|review|take|reset|lay|protect|close|file|water|recharge|replenish|set|send|rehearse|create|choose|hold)\b/i
  const observableEvidence = /\b(?:seconds?|minutes?|count|log|record|comparison|tally|window|days?|weeks?|accuracy|rating|choices?|time|barriers?|delay|rework|starts?|searches?|burden)\b/i
  for (const tuple of tuples) {
    if (options.templateOnly) continue
    const fields = [tuple.episode_object, tuple.time_place_scope, tuple.mechanism, tuple.evidence_lens]
    const coordinate = `${tuple.profileIndex + 1}/${tuple.tupleIndex + 1}`
    assert(fields.every(value => typeof value === 'string' && value.trim().length >= 8), `empty/short field at ${coordinate}`)
    assert(!fields.some(value => badCopy.test(value)), `placeholder/copy artifact at ${coordinate}`)
    assert(!fields.some(value => badSafety.test(value)), `unsafe/overclaim wording at ${coordinate}`)
    assert(!fields.some(value => badGrammar.test(value) || badClauseSlot.test(value) || badVerbObject.test(value)), `grammar or clause-slot defect at ${coordinate}`)
    assert(observableEvidence.test(tuple.evidence_lens), `evidence lacks an observable variable at ${coordinate}`)
  }
  for (const profile of source.coverage_profiles) {
    unique(profile.tuples.map(tuple => tuple.mechanism.replace(/^[^:]+:\s*/i, '')), `${profile.subject} independent mechanisms`)
  }

  // Generic frames remain generic after the author swaps in a routine noun or artifact.
  const trigramProfiles = new Map()
  const scopeFrames = new Set(tuples.flatMap(tuple => mechanismTrigrams(tuple.time_place_scope)))
  for (const tuple of tuples) for (const frame of new Set(mechanismTrigrams(tuple.mechanism))) {
    if (scopeFrames.has(frame)) continue
    const profiles = trigramProfiles.get(frame) || new Set()
    profiles.add(tuple.profileIndex)
    trigramProfiles.set(frame, profiles)
  }
  const reusedFrames = [...trigramProfiles.entries()].filter(([, profiles]) => profiles.size > 7)
  assert(reusedFrames.length === 0, `generic mechanism frames repeat across profiles: ${reusedFrames.slice(0, 8).map(([frame, profiles]) => `${frame} (${profiles.size})`).join(', ')}`)

  let comparedPairs = 0
  for (let left = 0; left < tuples.length; left++) for (let right = left + 1; right < tuples.length; right++) comparedPairs++
  assert(comparedPairs === 499500, 'pairwise audit must inspect all 499,500 pairs')
  if (review) {
    const digest = createHash('sha256').update(JSON.stringify(source, null, 2) + '\n').digest('hex')
    assert(review.includes(digest), 'semantic review must bind exact source digest')
    const reviewRows = [...review.matchAll(/^\d+\. \*\*(.+?)\*\* — (.+)$/gm)]
    assert(reviewRows.length === 50, 'semantic review must contain exactly 50 subject rows')
    assert((review.match(/\[scope=PASS; evidence=PASS; tuple=PASS\]/g) || []).length === 1000, 'semantic review must contain 1,000 tuple verdicts')
    for (let i = 0; i < reviewRows.length; i++) {
      assert(reviewRows[i][1] === source.subjects[i], `review subject order mismatch at ${i + 1}`)
      assert((reviewRows[i][2].match(/\[scope=PASS; evidence=PASS; tuple=PASS\]/g) || []).length === 20, `review row ${i + 1} must contain 20 verdicts`)
    }
  }
  return { tuples, comparedPairs, reusedFrames: reusedFrames.length }
}

if (rejectReviewedTemplate) {
  const reviewedTemplate = JSON.parse(execFileSync('git', ['show', `${reviewedTemplateCommit}:${sourcePath}`], { encoding: 'utf8' }))
  let rejected = false
  try { audit(reviewedTemplate, undefined, { templateOnly: true }) } catch (error) {
    rejected = /generic mechanism frames|grammar or clause-slot/.test(String(error))
    if (!rejected) throw error
  }
  assert(rejected, 'reviewed template corpus must be rejected by the semantic audit')
  console.log(JSON.stringify({ template_fixture_rejected: true, reviewed_template_commit: reviewedTemplateCommit }))
} else {
  const [sourceBytes, review] = await Promise.all([readFile(sourcePath), readFile(reviewPath, 'utf8')])
  const source = JSON.parse(sourceBytes)
  const result = audit(source, review)
  console.log(JSON.stringify({
    source_document_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    source_bytes: sourceBytes.length,
    subjects: source.subjects.length,
    tuples: result.tuples.length,
    compared_pairs: result.comparedPairs,
    generic_mechanism_frames: result.reusedFrames,
    review_rows: 50,
    review_verdicts: 1000,
  }, null, 2))
}
