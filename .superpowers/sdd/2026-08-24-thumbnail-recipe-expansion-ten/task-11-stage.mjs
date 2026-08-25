import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../../../scripts/content-packs/lib.mjs'
import { stageHandoffArtifacts } from '../../../scripts/content-packs/stage-handoff-artifacts.mjs'

const repositoryRoot = '<owner-home>/Developer/story-studio-kh/.worktrees/content-expansion-portfolio'
const artifactRoot = '<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24'
const receiverHandoffPath = '<owner-home>/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json'
const waveId = 'thumbnail-recipe-expansion-ten'
const deliveryProfile = 'genstudio-store-receipt-v1'
const minAppVersion = '1.0.843'
const receiptRef = 'authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378'
const receiptRevision = 23
const slugs = [
  'before-after-proof-panel', 'two-option-criteria-split', 'reaction-evidence-inset',
  'cutaway-exploded-object', 'hero-payoff-companion', 'iconic-result-closeup',
  'scale-journey', 'numbered-lineup', 'macro-mystery-detail', 'hands-on-pov-moment',
]
const summaries = {
  'before-after-proof-panel': 'Matched before-and-after states show one subject changing across a truthful temporal seam.',
  'two-option-criteria-split': 'Two present-time alternatives receive equal visual weight for an honest criteria-based comparison.',
  'reaction-evidence-inset': 'A reaction subject directs attention to one original in-scene evidence detail.',
  'cutaway-exploded-object': 'One object opens into an ordered, readable view of its meaningful internal layers.',
  'hero-payoff-companion': 'A generic hero visibly interacts with a separate, tangible result object.',
  'iconic-result-closeup': 'One truthful finished outcome dominates the frame at a detail-revealing angle.',
  'scale-journey': 'Three related forms progress through continuous depth to communicate scale or magnitude.',
  'numbered-lineup': 'Three to five equal-status entries form a precise lineup with matching native numerals.',
  'macro-mystery-detail': 'An extreme close detail creates bounded curiosity while a small honest clue preserves context.',
  'hands-on-pov-moment': 'First-person or over-shoulder hands perform one clear, safe action in task context.',
}
const bindings = Object.fromEntries(slugs.map(slug => [slug, {
  pack_id: `com.storystudio.pack.thumbnail.${slug}`,
  item_id: `com.storystudio.thumbnail.${slug}`,
  version: '1.0.0', publisher_id: 'com.storystudio', kind: 'thumbnail-recipe',
  source_path: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/${slug}`,
  dependencies: [],
}]))
const reviewNames = ['schema', 'originality-provenance', 'compatibility', 'prompt-equivalence', 'visual', 'thumbnail', 'safety', 'copy', 'commercial-boundary']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const absent = path => access(path).then(() => false, () => true)

function reviewsFor(slug) {
  const base = `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/${slug}`
  return reviewNames.map(review => ({ review, status: 'passed', evidence: review === 'commercial-boundary'
    ? `${base}.spec.md and ${base}.quality.md`
    : `${base}.${['originality-provenance', 'visual', 'thumbnail', 'safety', 'copy'].includes(review) ? 'quality' : 'spec'}.md` }))
}

function hasRecursiveKey(value, key) {
  if (!value || typeof value !== 'object') return false
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true
  return Object.values(value).some(child => hasRecursiveKey(child, key))
}

assert.equal(await absent(artifactRoot), true, 'external artifact root must be absent')
assert.equal(await absent(receiverHandoffPath), true, 'external receiver handoff must be absent')
const registry = JSON.parse(await readFile(join(repositoryRoot, 'content-packs/authoring-registry.json'), 'utf8'))
const eligibleSlugs = []
for (const slug of slugs) {
  const record = registry.records.find(entry => entry.pack_id === bindings[slug].pack_id)
  assert.equal(record?.status, 'authored')
  assert.equal(record?.receipt_ref, receiptRef)
  assert.deepEqual(record?.dependencies, [])
  execFileSync(process.execPath, [
    'scripts/content-packs/authoring-registry.mjs', 'verify-receipt', '--revision', String(receiptRevision),
    '--receipt', receiptRef, '--expected-identity', `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/expected-identities/${slug}.json`,
  ], { cwd: repositoryRoot, stdio: 'pipe' })
  for (const suffix of ['spec', 'quality']) {
    const review = await readFile(join(repositoryRoot, `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/${slug}.${suffix}.md`), 'utf8')
    assert.match(review, /(?:^|\n)PASS\s*(?:\n|$)/)
    assert.doesNotMatch(review, /(?:Important|Critical).*OPEN/i)
  }
  eligibleSlugs.push(slug)
}
assert.deepEqual(eligibleSlugs, slugs)

const candidateRoot = await mkdtemp(join(tmpdir(), 'story-thumbnail-expansion-ten-candidates-'))
try {
  const entries = []
  for (const slug of eligibleSlugs) {
    const sourceDirectory = join(repositoryRoot, bindings[slug].source_path)
    const first = join(candidateRoot, `${slug}.sspack`)
    const second = join(candidateRoot, `${slug}.second.sspack`)
    for (const outputPath of [first, second]) {
      await buildContentPack({ sourceDirectory, outputPath, deliveryProfile, minAppVersion })
      await validateContentPack({ archivePath: outputPath, deliveryProfile, includeManifest: true })
    }
    const [firstBytes, secondBytes] = await Promise.all([readFile(first), readFile(second)])
    assert.deepEqual(secondBytes, firstBytes, `${slug} must build byte-identically`)
    assert.equal(digest(secondBytes), digest(firstBytes))
    const zip = await JSZip.loadAsync(firstBytes)
    const archiveJson = []
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir && entry.name.endsWith('.json')) archiveJson.push(JSON.parse(await entry.async('string')))
    }
    assert.equal(hasRecursiveKey(archiveJson, 'component_summary'), false)
    entries.push({
      slug, ...bindings[slug], candidate_path: first, bytes: firstBytes.byteLength,
      sha256: digest(firstBytes), delivery_profile: deliveryProfile, min_app_version: minAppVersion,
      receipt_ref: receiptRef, reviews: reviewsFor(slug),
      component_summary: { schema_version: 1, kind: 'thumbnail-recipe', summary: summaries[slug], slots: { 'thumbnail-recipe': 1 } },
    })
  }

  const blockedEntries = []
  const result = await stageHandoffArtifacts({
    waveId, repositoryRoot, candidateRoot, artifactRoot, receiverHandoffPath,
    allowedSlugs: slugs, eligibleSlugs, entries, blockedEntries,
  })
  assert.equal(result.phase, 'complete')

  const [ledger, release, receiver] = await Promise.all([
    readFile(result.ledgerPath, 'utf8').then(JSON.parse),
    readFile(result.releaseHandoffPath, 'utf8').then(JSON.parse),
    readFile(result.receiverHandoffPath, 'utf8').then(JSON.parse),
  ])
  assert.deepEqual(ledger.entries.map(entry => entry.slug), slugs)
  assert.deepEqual(release.entries.map(entry => entry.slug), slugs)
  assert.deepEqual(receiver.successful_entries, release.entries)
  assert.deepEqual(receiver.blocked_entries, [])
  assert.equal(receiver.status, 'ready-for-owner-stocking')
  assert.equal(hasRecursiveKey(ledger, 'component_summary'), false)
  assert.equal(hasRecursiveKey(release, 'component_summary'), true)
  assert.equal(hasRecursiveKey(receiver.successful_entries, 'component_summary'), true)
  assert.equal(hasRecursiveKey(receiver.blocked_entries, 'component_summary'), false)
  assert.deepEqual(Object.keys(receiver).sort(), ['artifact_root', 'blocked_entries', 'explicitly_not_done', 'ledger_path', 'schema_version', 'status', 'successful_entries'])
  for (let index = 0; index < slugs.length; index += 1) {
    const slug = slugs[index]
    const archivePath = join(artifactRoot, `${slug}.sspack`)
    const archiveBytes = await readFile(archivePath)
    assert.equal(digest(archiveBytes), entries[index].sha256)
    assert.equal(archiveBytes.byteLength, entries[index].bytes)
    const validated = await validateContentPack({ archivePath, deliveryProfile, includeManifest: true })
    assert.equal(validated.packId, bindings[slug].pack_id)
    assert.equal(validated.manifest.min_app_version, minAppVersion)
    assert.deepEqual(release.entries[index].component_summary, entries[index].component_summary)
  }
  process.stdout.write(`${JSON.stringify({ phase: result.phase, artifactRoot, receiverHandoffPath, archiveCount: slugs.length })}\n`)
} finally {
  await rm(candidateRoot, { recursive: true, force: true })
}
