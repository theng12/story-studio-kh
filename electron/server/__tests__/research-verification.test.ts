/**
 * Research gate + derived claim-review contract (v1.0.760, reworked v1.0.761).
 *
 * v1.0.761 removed the separate research-level attestation. The research-level
 * state is DERIVED from the per-claim Verified / Ignore triage, so these tests
 * pin the derivation itself as well as both gate directions:
 *
 *   - `research_required` ON  → research blocks completion until every claim
 *                               is triaged AND at least one is kept
 *   - `research_required` OFF → byte-for-byte today's optional behaviour
 *   - setting ABSENT (a project created before the gate) → resolves OFF
 *   - any pending claim → not complete; zero claims → not complete
 *   - all claims ignored → REVIEWED, surfaced as such, still not complete
 *   - generating / regenerating research resets every claim to untriaged
 *   - Pipeline runs machine-complete the triage, and that stays distinguishable
 *     from a human's review
 *   - the Research pending filter lists research whose claims still need review
 *
 * Every dependent module is dynamic-imported inside `before()` — a static
 * import would evaluate project-manager's PROJECTS_ROOT before
 * useTempDataDir() can point STORY_STUDIO_DATA_DIR at a temp folder, and the
 * suite would write into the user's real projects folder.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import type { Job, ResearchClaim, ResearchOutput } from '../models/types.js'

let pm: typeof import('../services/project-manager.js')
let assetStatus: typeof import('../services/asset-status.js')
let cacheMod: typeof import('../services/episode-status-cache.js')
let rv: typeof import('../lib/research-verification.js')
let researchPaths: typeof import('../lib/research-paths.js')
let pipeline: typeof import('../routes/pipeline.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'research-gate-test'
const CODE = 'EP0001'

function claim(id: string, status: ResearchClaim['status'], text = `Claim ${id} text.`): ResearchClaim {
  return { id, text, status, citation_indices: [] }
}

/** A research sidecar with real evidence in it. Claims default to untriaged. */
function researchFixture(overrides: Partial<ResearchOutput> = {}): ResearchOutput {
  return {
    schema_version: 1,
    source_provider: 'llm-only',
    generated_at: '2026-07-30T00:00:00.000Z',
    topic: 'Volcanic soil fertility',
    summary: 'Volcanic ash weathers into mineral-rich soil.',
    claims: [{
      id: 'claim_1',
      text: 'Basaltic ash weathers quickly into clay minerals.',
      status: 'unreviewed',
      citation_indices: [0],
    }],
    citations: [{ title: 'USGS', url: 'https://example.invalid/usgs' }],
    ...overrides,
  }
}

/** The same fixture with every claim triaged as `status`. */
function triaged(status: ResearchClaim['status'], overrides: Partial<ResearchOutput> = {}): ResearchOutput {
  const base = researchFixture(overrides)
  return { ...base, claims: base.claims.map(c => ({ ...c, status })) }
}

/**
 * Build a project on disk. `researchRequired` is passed as-is so we can create
 * the three distinct cases the migration cares about: explicitly on,
 * explicitly off, and ABSENT (a project that predates the gate).
 */
async function makeProject(researchRequired?: boolean): Promise<string> {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Research Gate Test',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: outputRoot, created_at: new Date().toISOString(),
    ...(researchRequired === undefined ? {} : { research_required: researchRequired }),
  }))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'i-1', title: 'Test', logline: 'l', themes: [], suggested_chapters: 8,
      suggested_length: '30 min', mood: 'm', status: 'accepted', episode_code: CODE,
      generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'b', model_used: 'gpt-4o',
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const epDir = path.join(outputRoot, 'Season 001', `${CODE} - Test`)
  await fs.mkdir(epDir, { recursive: true })
  return epDir
}

/** Write a research sidecar into the canonical "{code} - 11 Research" folder. */
async function writeResearch(epDir: string, research: ResearchOutput): Promise<string> {
  const { dir, jsonPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(jsonPath, JSON.stringify(research, null, 2), 'utf-8')
  return jsonPath
}

async function readResearch(epDir: string): Promise<ResearchOutput> {
  const { jsonPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
  return JSON.parse(await fs.readFile(jsonPath, 'utf-8'))
}

describe('research gate default resolution', () => {
  before(async () => {
    tmp = await useTempDataDir()
    rv = await import('../lib/research-verification.js')
  })
  after(async () => { await tmp.cleanup() })

  test('an ABSENT setting resolves OFF — legacy projects never regress', () => {
    // The whole point of the migration: a project.json written before the gate
    // shipped must not retroactively mark finished episodes incomplete.
    assert.equal(rv.resolveResearchRequired({} as any), false)
    assert.equal(rv.resolveResearchRequired({ research_required: undefined } as any), false)
    assert.equal(rv.resolveResearchRequired(null), false)
  })

  test('explicit booleans win, and non-booleans are not coerced', () => {
    assert.equal(rv.resolveResearchRequired({ research_required: true } as any), true)
    assert.equal(rv.resolveResearchRequired({ research_required: false } as any), false)
    // A junk value must land on the safe side (off), not on "truthy → on".
    assert.equal(rv.resolveResearchRequired({ research_required: 'yes' } as any), false)
    assert.equal(rv.resolveResearchRequired({ research_required: 1 } as any), false)
  })
})

describe('the derived triage rule', () => {
  before(async () => {
    tmp = await useTempDataDir()
    rv = await import('../lib/research-verification.js')
  })
  after(async () => { await tmp.cleanup() })

  test('counts each decision and only calls it reviewed when nothing is pending', () => {
    const mixed = rv.readResearchTriage({
      claims: [claim('a', 'verified'), claim('b', 'ignored'), claim('c', 'unreviewed')],
    })
    assert.deepEqual(
      { total: mixed.total, verified: mixed.verified, ignored: mixed.ignored, pending: mixed.pending },
      { total: 3, verified: 1, ignored: 1, pending: 1 },
    )
    assert.equal(mixed.reviewed, false, 'one pending claim means the review is not finished')

    const done = rv.readResearchTriage({ claims: [claim('a', 'verified'), claim('b', 'ignored')] })
    assert.equal(done.reviewed, true)
    assert.equal(done.hasUsableClaims, true)
  })

  test('a missing or junk status counts as still pending, never as decided', () => {
    const t = rv.readResearchTriage({
      claims: [{ id: 'a', text: 'no status field' }, { id: 'b', text: 'junk', status: 'approved' }],
    })
    assert.equal(t.pending, 2)
    assert.equal(t.reviewed, false)
  })

  test('claims with no real text are not countable review work', () => {
    const t = rv.readResearchTriage({ claims: [claim('a', 'verified'), { id: 'b', text: '   ', status: 'unreviewed' }] })
    assert.equal(t.total, 1, 'a blank placeholder must not hold an episode hostage')
    assert.equal(t.reviewed, true)
  })

  test('zero claims is never "reviewed", however the sidecar is shaped', () => {
    assert.equal(rv.readResearchTriage({ claims: [] }).reviewed, false)
    assert.equal(rv.readResearchTriage({}).reviewed, false)
    assert.equal(rv.readResearchTriage(null).reviewed, false)
    assert.equal(rv.isResearchReviewed({ summary: 'text but no claims', claims: [] }), false)
  })
})

describe('research completion rule', () => {
  before(async () => {
    tmp = await useTempDataDir()
    rv = await import('../lib/research-verification.js')
  })
  after(async () => { await tmp.cleanup() })

  test('evidence is judged on artifacts, never on the file merely existing', () => {
    assert.equal(rv.hasResearchEvidence(null), false)
    assert.equal(rv.hasResearchEvidence({}), false)
    // Parsed, well-formed, and completely empty — still not evidence.
    assert.equal(rv.hasResearchEvidence({ summary: '   ', claims: [] }), false)
    assert.equal(rv.hasResearchEvidence({ summary: '', claims: [{ text: '  ' }] }), false)
    assert.equal(rv.hasResearchEvidence({ summary: 'real summary', claims: [] }), true)
    assert.equal(rv.hasResearchEvidence({ claims: [{ text: 'a real claim' }] }), true)
  })

  test('gate OFF: evidence alone completes it (unchanged behaviour)', () => {
    const generated = researchFixture()
    assert.equal(rv.isResearchComplete(generated, false), true)
    assert.equal(rv.isResearchComplete(rv.withResearchUntriaged(generated), false), true)
    // Gate OFF ignores the triage entirely — all-pending and all-ignored alike.
    assert.equal(rv.isResearchComplete(triaged('ignored'), false), true)
    assert.equal(rv.isResearchComplete({ summary: '', claims: [] }, false), false)
    assert.equal(rv.isResearchComplete({ summary: 'summary only', claims: [] }, false), true)
  })

  test('gate ON: every claim triaged and at least one kept completes it', () => {
    assert.equal(rv.isResearchComplete(triaged('verified'), true), true)
    assert.equal(rv.isResearchComplete({
      ...researchFixture(),
      claims: [claim('a', 'verified'), claim('b', 'ignored')],
    }, true), true)
  })

  test('gate ON: ANY pending claim keeps it incomplete', () => {
    assert.equal(rv.isResearchComplete(rv.withResearchUntriaged(researchFixture()), true), false)
    assert.equal(rv.isResearchComplete({
      ...researchFixture(),
      claims: [claim('a', 'verified'), claim('b', 'verified'), claim('c', 'unreviewed')],
    }, true), false, 'one undecided claim out of three still blocks it')
  })

  test('gate ON: zero claims is not complete even with a rich summary', () => {
    const summaryOnly = { ...researchFixture(), claims: [] }
    assert.equal(rv.hasResearchEvidence(summaryOnly), true, 'the summary is real evidence')
    assert.equal(rv.isResearchComplete(summaryOnly, true), false,
      'there is nothing for the Script Generator to use, so it cannot be complete')
  })

  test('gate ON: all-ignored is REVIEWED but not complete', () => {
    const allIgnored = triaged('ignored')
    const t = rv.readResearchTriage(allIgnored)
    assert.equal(t.reviewed, true, 'rejecting everything is a real editorial outcome')
    assert.equal(t.hasUsableClaims, false)
    assert.equal(rv.isResearchComplete(allIgnored, true), false,
      'the gate exists to guarantee the script has evidence; all-ignored hands it none')
  })

  test('the retired v1.0.760 attestation can no longer complete anything', () => {
    // A legacy sidecar that was "verified" at the research level, with claims
    // nobody ever triaged, must now read as incomplete rather than done.
    const legacy = {
      ...rv.withResearchUntriaged(researchFixture()),
      verification: { verified: true, verified_by: 'human', verified_at: '2026-07-30T00:00:00.000Z' },
    }
    assert.equal(rv.isResearchComplete(legacy, true), false)
  })

  test('a forged review record cannot fake an actor', () => {
    assert.equal(rv.readResearchReview({ review: { completed_by: 'admin' } }), null)
    assert.equal(rv.readResearchReview({ review: true }), null)
    assert.equal(rv.readResearchReview({}), null)
    assert.equal(rv.readResearchReview({ review: { completed_by: 'human' } })?.completed_by, 'human')
  })

  test('human vs pipeline review records stay distinguishable', () => {
    const human = rv.withResearchReviewRecord(triaged('verified'), 'human')
    const auto = rv.autoCompleteResearchReview(rv.withResearchUntriaged(researchFixture()))
    assert.equal(human.review?.completed_by, 'human')
    assert.equal(auto.review?.completed_by, 'pipeline-auto')
    assert.match(auto.review?.note || '', /no human read these claims/i)
    assert.doesNotMatch(auto.review?.note || '', /cited sources/i)
    assert.ok(auto.review?.completed_at, 'automatic completion must be timestamped too')
  })

  test('no wording anywhere claims the user checked the cited sources', () => {
    // These notes describe the TRIAGE only. They are shown for both research
    // modes, so they must stay mode-neutral: model-knowledge output cites
    // nothing, and web output cites the run rather than each claim.
    assert.doesNotMatch(rv.HUMAN_REVIEW_NOTE, /cited sources|checked .* against/i)
    assert.doesNotMatch(rv.PIPELINE_AUTO_REVIEW_NOTE, /cited sources/i)
    for (const note of [rv.HUMAN_REVIEW_NOTE, rv.PIPELINE_AUTO_REVIEW_NOTE]) {
      assert.doesNotMatch(note, /no live web access|searched the web/i)
    }
  })

  test('untriaging resets every claim and drops both review records', () => {
    const reviewed = rv.withResearchReviewRecord(triaged('verified'), 'human')
    const legacy = { ...reviewed, verification: { verified: true, verified_by: 'human' } }
    const cleared = rv.withResearchUntriaged(legacy)
    assert.equal(cleared.review, undefined)
    assert.equal((cleared as { verification?: unknown }).verification, undefined)
    assert.ok(cleared.claims.every(c => c.status === 'unreviewed'))
    assert.equal(rv.isResearchComplete(cleared, true), false)
  })

  test('auto-completion keeps decisions a human already made', () => {
    const partly = {
      ...researchFixture(),
      claims: [claim('a', 'ignored'), claim('b', 'unreviewed')],
    }
    const auto = rv.autoCompleteResearchReview(partly)
    assert.equal(auto.claims[0]!.status, 'ignored', 'a human Ignore must never be flipped back to kept')
    assert.equal(auto.claims[1]!.status, 'verified')
    assert.equal(rv.isResearchComplete(auto, true), true)
  })

  test('gap messages name what is missing AND how to fix it', () => {
    assert.equal(rv.describeResearchGap({
      episodeId: CODE, researchRequired: false, hasEvidence: false, reviewed: false, hasUsableClaims: false,
    }), null)

    const missing = rv.describeResearchGap({
      episodeId: CODE, researchRequired: true, hasEvidence: false, reviewed: false, hasUsableClaims: false,
    })
    assert.match(missing || '', /EP0001/)
    assert.match(missing || '', /no research evidence exists/)
    assert.match(missing || '', /run it for this episode/)

    const pending = rv.describeResearchGap({
      episodeId: CODE, researchRequired: true, hasEvidence: true, reviewed: false, hasUsableClaims: false,
    })
    assert.match(pending || '', /still waiting for a decision/)
    assert.match(pending || '', /Verified or Ignore/)
    assert.match(pending || '', /Verify all/)

    // The all-ignored outcome gets its OWN sentence — reporting it as generic
    // "pending" would send the user looking for claims to review that aren't there.
    const allIgnored = rv.describeResearchGap({
      episodeId: CODE, researchRequired: true, hasEvidence: true, reviewed: true, hasUsableClaims: false,
    })
    assert.match(allIgnored || '', /every research claim was ignored/i)
    assert.match(allIgnored || '', /keep at least one claim/)

    assert.equal(rv.describeResearchGap({
      episodeId: CODE, researchRequired: true, hasEvidence: true, reviewed: true, hasUsableClaims: true,
    }), null)

    // None of them may imply the app or the user checked a live source.
    for (const message of [missing, pending, allIgnored]) {
      assert.doesNotMatch(message || '', /cited sources/i)
    }
  })
})

describe('research status through computeEpisodeStatus', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    assetStatus = await import('../services/asset-status.js')
    cacheMod = await import('../services/episode-status-cache.js')
    rv = await import('../lib/research-verification.js')
    researchPaths = await import('../lib/research-paths.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'), 'projectsRoot() must be the temp dir')
  })
  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  test('gate ON + claims still pending → NOT complete, but flagged as generated', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, false, 'untriaged research must not count as complete')
    assert.equal(status.research_generated, true, 'the evidence itself is present')
    assert.equal(status.research_reviewed, false)
    assert.equal(status.research_required, true)
  })

  test('gate ON + every claim triaged → complete, and the actor is surfaced', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified'), 'human'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true)
    assert.equal(status.research_reviewed, true)
    assert.equal(status.research_has_usable_claims, true)
    assert.equal(status.research_reviewed_by, 'human')
  })

  test('gate ON + all claims ignored → reviewed, no usable claims, NOT complete', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('ignored'), 'human'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research_reviewed, true, 'the reviewing itself happened and must be visible')
    assert.equal(status.research_has_usable_claims, false, 'and the UI must be able to say why it is stuck')
    assert.equal(status.research, false)
  })

  test('gate ON + pipeline-completed review → complete, and marked automatic', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.autoCompleteResearchReview(rv.withResearchUntriaged(researchFixture())))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'an unattended run must not be blocked')
    assert.equal(status.research_reviewed_by, 'pipeline-auto',
      'the record must never imply a human read these claims')
  })

  test('gate OFF: untriaged research is complete, exactly as before the gate', async () => {
    const epDir = await makeProject(false)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true)
    assert.equal(status.research_required, false)
  })

  test('setting ABSENT (legacy project): behaves exactly like gate OFF', async () => {
    const epDir = await makeProject(undefined)
    await writeResearch(epDir, researchFixture())  // no review record at all
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'an upgraded project must not regress to incomplete')
    assert.equal(status.research_required, false)
    assert.equal(status.research_reviewed, false)
  })

  test('no sidecar at all → not generated, not reviewed, not complete', async () => {
    await makeProject(true)
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, false)
    assert.equal(status.research_generated, false)
    assert.equal(status.research_reviewed, false)
  })

  test('gate ON + an empty sidecar is never complete, reviewed or not', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(researchFixture({ summary: '', claims: [] }), 'human'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, false, 'directory/file presence is never proof of completion')
    assert.equal(status.research_generated, false)
  })
})

describe('pending filter + the Pipeline skip contract', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    assetStatus = await import('../services/asset-status.js')
    cacheMod = await import('../services/episode-status-cache.js')
    rv = await import('../lib/research-verification.js')
    researchPaths = await import('../lib/research-paths.js')
    pipeline = await import('../routes/pipeline.js')
  })
  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  test('pending filter lists untriaged research and drops it once reviewed', async () => {
    // The Research page's "Pending only" filter keys off `status.research`, so
    // that boolean IS the pending contract.
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const pendingBefore = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pendingBefore.research, false, 'must still appear in the pending list')

    cacheMod.episodeStatusCache.clear()
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified'), 'human'))
    const pendingAfter = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pendingAfter.research, true, 'finishing the triage must drop it out of pending')
  })

  test('isStepAlreadyDone("research") follows the SAME gated rule as the board', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const untriaged = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pipeline.isStepAlreadyDone(untriaged, 'research'), false)

    cacheMod.episodeStatusCache.clear()
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified'), 'human'))
    const reviewed = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pipeline.isStepAlreadyDone(reviewed, 'research'), true)
  })

  test('Pipeline completes the review of EXISTING evidence instead of regenerating it', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))

    const changed = await pipeline.autoCompleteResearchReviewForPipeline(SLUG, CODE)
    assert.equal(changed, true)

    const after = await readResearch(epDir)
    assert.equal(after.review?.completed_by, 'pipeline-auto',
      'automatic completion must never be recorded as human')
    assert.ok(after.claims.every(c => c.status === 'verified'), 'pending claims are accepted so the batch runs')
    // The evidence itself must be untouched — this triages, it does not rerun.
    assert.equal(after.claims.length, 1)
    assert.equal(after.summary, researchFixture().summary)

    cacheMod.episodeStatusCache.clear()
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'the unattended run is no longer blocked')
  })

  test('Pipeline auto-completion never overwrites a review a human finished', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified'), 'human'))
    const changed = await pipeline.autoCompleteResearchReviewForPipeline(SLUG, CODE)
    assert.equal(changed, false)
    assert.equal((await readResearch(epDir)).review?.completed_by, 'human')
  })

  test('Pipeline auto-completion leaves a deliberate all-ignored review alone', async () => {
    // The batch stays blocked on purpose: flipping the user's Ignore decisions
    // back to kept would destroy editorial work to make a number go green.
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('ignored'), 'human'))
    assert.equal(await pipeline.autoCompleteResearchReviewForPipeline(SLUG, CODE), false)
    const after = await readResearch(epDir)
    assert.ok(after.claims.every(c => c.status === 'ignored'))
    assert.equal(after.review?.completed_by, 'human')
  })

  test('Pipeline auto-completion never invents evidence that is not there', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture({ summary: '', claims: [] })))
    assert.equal(await pipeline.autoCompleteResearchReviewForPipeline(SLUG, CODE), false)
    assert.equal((await readResearch(epDir)).review, undefined)

    // And with no sidecar at all it is a silent no-op, so the step just runs.
    await fs.rm(path.join(epDir, researchPaths.researchFolderName(CODE)), { recursive: true, force: true })
    assert.equal(await pipeline.autoCompleteResearchReviewForPipeline(SLUG, CODE), false)
  })
})

describe('the research generator resets the triage', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    cacheMod = await import('../services/episode-status-cache.js')
    rv = await import('../lib/research-verification.js')
    researchPaths = await import('../lib/research-paths.js')
  })
  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  /**
   * Drive runResearchJob against a stubbed adapter. NO network and NO paid
   * calls: the singleton GenStudio adapter's two methods are swapped in memory
   * for the duration of the run and restored afterwards.
   */
  async function runGeneratorWithStubAdapter(jobParams: Record<string, unknown>): Promise<Job> {
    const { genStudioResearch } = await import('../services/research/genstudio.js')
    const generator = await import('../generators/research.js')
    const adapter = genStudioResearch as any
    const originalIsConfigured = adapter.isConfigured
    const originalRun = adapter.run
    adapter.isConfigured = async () => true
    // The adapter hands back claims already marked verified to prove the
    // generator resets them rather than trusting whatever it was given.
    adapter.run = async () => triaged('verified')
    const job: Job = {
      job_id: 'j1', project_slug: SLUG, type: 'research_run', episode_id: CODE,
      title: 'Research', status: 'running', created_at: '', started_at: '', finished_at: null,
      error: null, output_lines: [], params: {
        episode_id: CODE, source_provider: 'llm-only', topic: 'Volcanic soil fertility', ...jobParams,
      },
    }
    try {
      await generator.runResearchJob(job)
    } finally {
      adapter.isConfigured = originalIsConfigured
      adapter.run = originalRun
    }
    return job
  }

  test('a manual run writes UNTRIAGED claims even over a reviewed sidecar', async () => {
    const epDir = await makeProject(true)
    // Pre-existing, human-reviewed research for an OLDER generation.
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified', { summary: 'stale' }), 'human'))

    const job = await runGeneratorWithStubAdapter({})

    const written = await readResearch(epDir)
    assert.ok(written.claims.every(c => c.status === 'unreviewed'),
      'regeneration must clear old decisions — nobody has read the NEW claims')
    assert.equal(written.review, undefined, 'and the old review record must not carry over')
    assert.equal(rv.isResearchComplete(written, true), false)
    assert.ok(job.output_lines.some(l => /Claim review: PENDING/.test(l)),
      'the job log must tell the user the review is still owed')
    assert.ok(!job.output_lines.some(l => /cited sources/i.test(l)))
  })

  test('a Pipeline run completes the triage and records that it was automatic', async () => {
    const epDir = await makeProject(true)
    const job = await runGeneratorWithStubAdapter({ pipeline_batch_id: 'batch-123' })

    const written = await readResearch(epDir)
    assert.equal(rv.isResearchComplete(written, true), true, 'unattended runs must not be left blocked')
    assert.equal(written.review?.completed_by, 'pipeline-auto')
    assert.ok(job.output_lines.some(l => /AUTO-COMPLETED/.test(l)))

    // And the markdown a human reads in Finder says so too, without ever
    // implying a person read the claims or that sources were checked.
    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /Review auto-completed/)
    assert.match(md, /No human read these claims/)
    assert.doesNotMatch(md, /checked .* against the cited sources/i)
    // Provenance is disclosed rather than dressed up as fact-checking — but in
    // the softened, mode-specific wording. The old copy ("no live web access")
    // read as if the output were worthless, and it is also simply wrong for a
    // web-search run, so it must not come back.
    assert.match(md, /Model knowledge only · research ran on/)
    assert.match(md, /Reliable on well-established facts/)
    assert.match(md, /can’t cite live sources/)
    assert.doesNotMatch(md, /no live web access/)
  })

  test('research.md shows when a claim has no source behind it', async () => {
    const epDir = await makeProject(true)
    await runGeneratorWithStubAdapter({})
    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    // The fixture's single claim cites source 1, so the citation is shown…
    assert.match(md, /\[1\]/)
    // …and the review state is stated for the reader.
    assert.match(md, /REVIEW PENDING/)
  })

  test('an empty pipeline_batch_id is not treated as a Pipeline run', async () => {
    const epDir = await makeProject(true)
    await runGeneratorWithStubAdapter({ pipeline_batch_id: '' })
    const written = await readResearch(epDir)
    assert.ok(written.claims.every(c => c.status === 'unreviewed'))
    assert.equal(written.review, undefined)
  })

  // ── Web-search mode ────────────────────────────────────────────────────
  // Same generator, same triage rules, DIFFERENT provenance. Nothing here
  // touches GenStudio: the web adapter is stubbed with a fixture envelope.
  async function runWebGenerator(
    citations: ResearchOutput['citations'],
    web_run: ResearchOutput['web_run'] = { searches_performed: 3, credits_per_search: 5 },
  ): Promise<Job> {
    const { genStudioWebResearch } = await import('../services/research/genstudio-web.js')
    const generator = await import('../generators/research.js')
    const adapter = genStudioWebResearch as any
    const originalIsConfigured = adapter.isConfigured
    const originalRun = adapter.run
    adapter.isConfigured = async () => true
    adapter.run = async () => ({
      ...researchFixture({
        source_provider: 'genstudio-web',
        research_mode: 'web-search',
        citations,
        // Deliberately the RETIRED v1.0.764 field name: a sidecar written by
        // that release must still display, and still say "not reported" for
        // the field GenStudio genuinely did not send.
        web_run,
      }),
      // Claims are never mapped to sources in web mode — the sources back the
      // run as a whole.
      claims: [{ id: 'claim_1', text: 'A searched claim.', status: 'unreviewed', citation_indices: [] }],
    })
    const job: Job = {
      job_id: 'jw', project_slug: SLUG, type: 'research_run', episode_id: CODE,
      title: 'Research', status: 'running', created_at: '', started_at: '', finished_at: null,
      error: null, output_lines: [], params: {
        episode_id: CODE, source_provider: 'genstudio-web', research_mode: 'web-search',
        topic: 'Volcanic soil fertility',
      },
    }
    try {
      await generator.runResearchJob(job)
    } finally {
      adapter.isConfigured = originalIsConfigured
      adapter.run = originalRun
    }
    return job
  }

  test('a web run records run-level sources and never borrows model-knowledge copy', async () => {
    const epDir = await makeProject(true)
    const job = await runWebGenerator([{ title: 'USGS', url: 'https://example.invalid/usgs' }])

    const written = await readResearch(epDir)
    assert.equal(written.research_mode, 'web-search')
    assert.equal(written.source_provider, 'genstudio-web')
    // Sources are recorded; no claim points at one.
    assert.equal(written.citations.length, 1)
    assert.deepEqual(written.claims[0]!.citation_indices, [])

    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /Search the web · research ran on/)
    assert.match(md, /Searched the web and cited its sources below/)
    assert.match(md, /back the run as a whole/)
    // The model-knowledge copy must never appear in a web run.
    assert.doesNotMatch(md, /no live web access/)
    assert.doesNotMatch(md, /Reliable on well-established facts/)
    assert.doesNotMatch(md, /no source cited/i)
    // Actual usage is reported exactly as GenStudio reported it, under its
    // confirmed field names — the unreported search cost says so instead of
    // being computed locally. "Web search cost", not "charged": the envelope
    // field is the search ADD-ON, never the run's total bill.
    assert.match(md, /Searches executed: 3\. Web search cost: not reported\./)
    assert.ok(job.output_lines.some(l => /Mode: Search the web/.test(l)))
    assert.ok(job.output_lines.some(l => /Web search cost: not reported/.test(l)))
  })

  test('a web run without structured citations remains a successful web outcome', async () => {
    const epDir = await makeProject(true)
    const job = await runWebGenerator([], {
      web_searches_executed: 3,
      web_search_credit_cost: 5,
    })

    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /Research ran, but GenStudio did not publish structured citations or source URLs for this run\./)
    assert.match(md, /Searches executed: 3\. Web search cost: 5 credits\./)
    assert.doesNotMatch(md, /Searched the web and cited its sources below/)
    assert.doesNotMatch(md, /Treat these claims as model knowledge/)
    assert.ok(job.output_lines.some(l => /did not publish structured citations or source URLs/.test(l)))
    assert.ok(job.output_lines.some(l => /Searches executed: 3\. Web search cost: 5 credits\./.test(l)))
    assert.ok(!job.output_lines.some(l => /Treat these claims as model knowledge/.test(l)))
  })
})

describe('new projects opt in, upgraded projects do not', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    rv = await import('../lib/research-verification.js')
  })
  after(async () => { await tmp.cleanup() })

  test('createProject stamps research_required: true explicitly', async () => {
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    const meta = await pm.createProject({ name: 'Brand New Channel' } as any)
    const onDisk = JSON.parse(
      await fs.readFile(path.join(pm.projectsRoot(), meta.slug, 'project.json'), 'utf-8'),
    )
    // Stamped, not inferred — this is what makes "absent means legacy" safe.
    assert.equal(onDisk.research_required, true)
    assert.equal(rv.resolveResearchRequired(onDisk), true)
  })
})

describe('there is no separate research-level attestation any more', () => {
  before(async () => {
    tmp = await useTempDataDir()
  })
  after(async () => { await tmp.cleanup() })

  test('the retired POST …/verify route is gone from the research routes', async () => {
    const source = await fs.readFile(
      new URL('../routes/research.ts', import.meta.url),
      'utf-8',
    )
    assert.doesNotMatch(source, /router\.post\([^)]*\/verify/)
    // No user-facing string may claim anything was checked against a source.
    // (The header comment names the retired wording on purpose, so only
    // response/message literals are scanned here.)
    const userFacingStrings = source.match(/detail: [^\n]+/g) || []
    for (const line of userFacingStrings) assert.doesNotMatch(line, /cited sources/i)
  })
})
