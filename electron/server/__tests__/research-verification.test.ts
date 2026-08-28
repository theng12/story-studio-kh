/**
 * Research gate + derived claim-review contract (v1.0.760, reworked v1.0.761).
 *
 * The research-level state is DERIVED from per-claim Verified / Ignore triage.
 * It remains an honest quality workflow without becoming a completion gate:
 *
 *   - real evidence completes the optional Research stage regardless of triage
 *   - pending and all-ignored outcomes remain visibly distinct
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
 * Build a project on disk.
 */
async function makeProject(_retiredResearchRequired?: boolean): Promise<string> {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Research Gate Test',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, created_at: new Date().toISOString(),
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

  test('untriaged and all-ignored evidence never becomes a completion gate', () => {
    // A regression to the retired project gate would make either of these
    // false. Triage remains editorially meaningful, but it must not hold a
    // script, pipeline, or episode completion hostage.
    assert.equal(rv.isResearchComplete(rv.withResearchUntriaged(researchFixture())), true)
    assert.equal(rv.isResearchComplete(triaged('ignored')), true)
  })

  test('evidence alone completes Research while empty sidecars do not', () => {
    const generated = researchFixture()
    assert.equal(rv.isResearchComplete(generated), true)
    assert.equal(rv.isResearchComplete(rv.withResearchUntriaged(generated)), true)
    assert.equal(rv.isResearchComplete(triaged('ignored')), true)
    assert.equal(rv.isResearchComplete({ summary: '', claims: [] }), false)
    assert.equal(rv.isResearchComplete({ summary: 'summary only', claims: [] }), true)
  })

  test('verified claims remain evidence', () => {
    assert.equal(rv.isResearchComplete(triaged('verified')), true)
    assert.equal(rv.isResearchComplete({
      ...researchFixture(),
      claims: [claim('a', 'verified'), claim('b', 'ignored')],
    }), true)
  })

  test('pending claims remain evidence', () => {
    assert.equal(rv.isResearchComplete(rv.withResearchUntriaged(researchFixture())), true)
    assert.equal(rv.isResearchComplete({
      ...researchFixture(),
      claims: [claim('a', 'verified'), claim('b', 'verified'), claim('c', 'unreviewed')],
    }), true, 'triage stays editorial and cannot block completion')
  })

  test('a summary remains evidence without claims', () => {
    const summaryOnly = { ...researchFixture(), claims: [] }
    assert.equal(rv.hasResearchEvidence(summaryOnly), true, 'the summary is real evidence')
    assert.equal(rv.isResearchComplete(summaryOnly), true,
      'a real summary is research evidence even when no claim was kept')
  })

  test('all-ignored remains reviewed evidence', () => {
    const allIgnored = triaged('ignored')
    const t = rv.readResearchTriage(allIgnored)
    assert.equal(t.reviewed, true, 'rejecting everything is a real editorial outcome')
    assert.equal(t.hasUsableClaims, false)
    assert.equal(rv.isResearchComplete(allIgnored), true,
      'all-ignored is still evidence and cannot gate completion')
  })

  test('the retired v1.0.760 attestation does not change evidence status', () => {
    // A legacy attestation is ignored; the real evidence and triage stay the
    // only customer-visible facts.
    const legacy = {
      ...rv.withResearchUntriaged(researchFixture()),
      verification: { verified: true, verified_by: 'human', verified_at: '2026-07-30T00:00:00.000Z' },
    }
    assert.equal(rv.isResearchComplete(legacy), true)
  })

  test('a forged review record cannot fake an actor', () => {
    assert.equal(rv.readResearchReview({ review: { completed_by: 'admin' } }), null)
    assert.equal(rv.readResearchReview({ review: true }), null)
    assert.equal(rv.readResearchReview({}), null)
    assert.equal(rv.readResearchReview({ review: { completed_by: 'human' } })?.completed_by, 'human')
    assert.equal(
      rv.readResearchReview({ review: { completed_by: 'auto-approval' } })?.completed_by,
      'auto-approval',
      'automatic approval is a known actor — it must survive the read, not be dropped as forged',
    )
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

  // ── "Approve claims automatically" (config research_auto_approve_claims) ──
  // The toggle reuses the manual transition exactly, so nothing downstream can
  // tell an auto-approved claim from a hand-approved one BY SHAPE — and the
  // provenance record is the one place that always can.
  test('automatic approval is off unless the project explicitly asked for it', () => {
    assert.equal(rv.researchAutoApproveEnabled(undefined), false)
    assert.equal(rv.researchAutoApproveEnabled(null), false)
    assert.equal(rv.researchAutoApproveEnabled({}), false, 'ABSENT KEY MEANS OFF')
    assert.equal(rv.researchAutoApproveEnabled({ research_auto_approve_claims: false }), false)
    assert.equal(rv.researchAutoApproveEnabled({ research_auto_approve_claims: 'true' }), false,
      'only a real boolean true counts — a stray string must not turn it on')
    assert.equal(rv.researchAutoApproveEnabled({ research_auto_approve_claims: 1 }), false)
    assert.equal(rv.researchAutoApproveEnabled({ research_auto_approve_claims: true }), true)
    assert.equal(rv.RESEARCH_AUTO_APPROVE_CONFIG_KEY, 'research_auto_approve_claims')
  })

  test('auto-approval marks claims through the same transition a human uses', () => {
    const approved = rv.autoApproveResearchReview(rv.withResearchUntriaged(researchFixture()))
    const byHand = rv.withResearchReviewRecord(triaged('verified'), 'human')

    // Identical claim SHAPE: same field, same value, no extra per-claim key
    // for a downstream consumer to have to learn.
    assert.deepEqual(
      approved.claims.map(c => c.status),
      byHand.claims.map(c => c.status),
    )
    assert.deepEqual(Object.keys(approved.claims[0]!).sort(), Object.keys(byHand.claims[0]!).sort())
    assert.equal(rv.isResearchReviewed(approved), true, 'the episode reaches Reviewed with no clicks')
    assert.equal(rv.readResearchTriage(approved).hasUsableClaims, true)
  })

  test('auto-approved research is distinguishable from every other actor', () => {
    const approved = rv.autoApproveResearchReview(rv.withResearchUntriaged(researchFixture()))
    assert.equal(approved.review?.completed_by, 'auto-approval')
    assert.ok(approved.review?.completed_at, 'automatic approval must be timestamped too')
    assert.match(approved.review?.note || '', /no human read these claims/i)
    assert.match(approved.review?.note || '', /Approve claims automatically/)
    // It never borrows the Pipeline's sentence — they are different promises.
    assert.doesNotMatch(approved.review?.note || '', /Pipeline/)
    assert.doesNotMatch(approved.review?.note || '', /cited sources/i)
    assert.notEqual(rv.AUTO_APPROVAL_REVIEW_NOTE, rv.PIPELINE_AUTO_REVIEW_NOTE)
    assert.notEqual(rv.AUTO_APPROVAL_REVIEW_NOTE, rv.HUMAN_REVIEW_NOTE)
  })

  test('auto-approval never overwrites a decision a person already made', () => {
    const withIgnored = researchFixture({
      claims: [claim('c1', 'ignored'), claim('c2', 'unreviewed')],
    })
    const approved = rv.autoApproveResearchReview(withIgnored)
    assert.equal(approved.claims[0]!.status, 'ignored', 'a human "Ignore" survives')
    assert.equal(approved.claims[1]!.status, 'verified')
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
    assert.equal(rv.isResearchComplete(cleared), true)
  })

  test('auto-completion keeps decisions a human already made', () => {
    const partly = {
      ...researchFixture(),
      claims: [claim('a', 'ignored'), claim('b', 'unreviewed')],
    }
    const auto = rv.autoCompleteResearchReview(partly)
    assert.equal(auto.claims[0]!.status, 'ignored', 'a human Ignore must never be flipped back to kept')
    assert.equal(auto.claims[1]!.status, 'verified')
    assert.equal(rv.isResearchComplete(auto), true)
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

  test('untriaged evidence is complete while its review state stays visible', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'triage cannot block optional Research')
    assert.equal(status.research_generated, true, 'the evidence itself is present')
    assert.equal(status.research_reviewed, false)
  })

  test('triaged evidence is complete and the actor is surfaced', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified'), 'human'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true)
    assert.equal(status.research_reviewed, true)
    assert.equal(status.research_has_usable_claims, true)
    assert.equal(status.research_reviewed_by, 'human')
  })

  test('all-ignored evidence remains complete while its editorial result stays visible', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('ignored'), 'human'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research_reviewed, true, 'the reviewing itself happened and must be visible')
    assert.equal(status.research_has_usable_claims, false, 'and the UI must say no claim was kept')
    assert.equal(status.research, true)
  })

  test('pipeline-completed review stays marked automatic', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.autoCompleteResearchReview(rv.withResearchUntriaged(researchFixture())))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'an unattended run must not be blocked')
    assert.equal(status.research_reviewed_by, 'pipeline-auto',
      'the record must never imply a human read these claims')
  })

  test('untriaged research is complete for all projects', async () => {
    const epDir = await makeProject(false)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true)
  })

  test('legacy project metadata does not change research evidence', async () => {
    const epDir = await makeProject(undefined)
    await writeResearch(epDir, researchFixture())  // no review record at all
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'an upgraded project must not regress to incomplete')
    assert.equal(status.research_reviewed, false)
  })

  test('no sidecar at all → not generated, not reviewed, not complete', async () => {
    await makeProject(true)
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, false)
    assert.equal(status.research_generated, false)
    assert.equal(status.research_reviewed, false)
  })

  // v1.2.7 — REWRITTEN, not deleted. This used to assert that enabling either
  // optional timeline made an episode with no sidecar incomplete. That WAS the
  // defect: switching an optional feature on then blocked Video Assembly and
  // Pipeline right across a library, over cues nobody had ever proposed. The
  // rule now matches the Research rule these tests sit beside — an optional
  // workflow with nothing in it has nothing outstanding. What still holds
  // strict is a sidecar that EXISTS with something unresolved in it; that is
  // asserted in `episode-status-cache.test.ts` and in both services' suites.
  test('optional timelines with no sidecar are complete whether the feature is on or off', async () => {
    const epDir = await makeProject()
    await fs.writeFile(path.join(pm.projectsRoot(), SLUG, 'config.json'), JSON.stringify({
      contextual_cues: { enabled: false }, sound_design: { enabled: false },
    }))
    await fs.writeFile(path.join(epDir, 'scene_plan.json'), JSON.stringify({
      generated_at: '2026-08-12T00:00:00.000Z', scenes: [],
    }))

    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.contextual_cues, true)
    assert.equal(status.sound_design, true)

    cacheMod.episodeStatusCache.clear()
    await fs.writeFile(path.join(pm.projectsRoot(), SLUG, 'config.json'), JSON.stringify({
      contextual_cues: { enabled: true }, sound_design: { enabled: true },
    }))
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.contextual_cues, true, 'enabling the feature does not invent work nobody created')
    assert.equal(status.sound_design, true, 'same rule, same reason')
    // …but "nothing outstanding" is not "already produced". Pipeline must still
    // run a Contextual Cues step the customer explicitly selected.
    assert.equal(status.contextual_cues_generated, false)
  })

  test('an empty sidecar is never complete, reviewed or not', async () => {
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

  test('evidence marks the optional Research stage complete before triage', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const pendingBefore = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pendingBefore.research, true, 'evidence cannot wait on review')

    cacheMod.episodeStatusCache.clear()
    await writeResearch(epDir, rv.withResearchReviewRecord(triaged('verified'), 'human'))
    const pendingAfter = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pendingAfter.research, true, 'review does not change evidence completion')
  })

  test('isStepAlreadyDone("research") follows the evidence-only rule', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUntriaged(researchFixture()))
    const untriaged = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pipeline.isStepAlreadyDone(untriaged, 'research'), true)

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
    assert.equal(rv.isResearchComplete(written), true)
    assert.ok(job.output_lines.some(l => /Claim review: PENDING/.test(l)),
      'the job log must tell the user the review is still owed')
    assert.ok(!job.output_lines.some(l => /cited sources/i.test(l)))
  })

  test('a Pipeline run completes the triage and records that it was automatic', async () => {
    const epDir = await makeProject(true)
    const job = await runGeneratorWithStubAdapter({ pipeline_batch_id: 'batch-123' })

    const written = await readResearch(epDir)
    assert.equal(rv.isResearchComplete(written), true, 'unattended runs remain complete')
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

  // ── "Approve claims automatically", read at RUN time ────────────────────
  /** Give the project a config.json so `getConfig` has something to read. */
  async function writeProjectConfig(config: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      path.join(pm.projectsRoot(), SLUG, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    )
  }

  test('with the setting OFF (absent key) a run behaves exactly as it does today', async () => {
    const epDir = await makeProject(true)
    await writeProjectConfig({})           // the key was never set
    const job = await runGeneratorWithStubAdapter({})

    const written = await readResearch(epDir)
    assert.ok(written.claims.every(c => c.status === 'unreviewed'))
    assert.equal(written.review, undefined)
    assert.equal(rv.isResearchReviewed(written), false)
    assert.ok(job.output_lines.some(l => /Claim review: PENDING/.test(l)))
    assert.ok(!job.output_lines.some(l => /AUTO-APPROVED/.test(l)))
  })

  test('an explicit false is still off', async () => {
    const epDir = await makeProject(true)
    await writeProjectConfig({ research_auto_approve_claims: false })
    await runGeneratorWithStubAdapter({})
    const written = await readResearch(epDir)
    assert.ok(written.claims.every(c => c.status === 'unreviewed'))
    assert.equal(written.review, undefined)
  })

  test('with the setting ON the run approves the claims and records that it was automatic', async () => {
    const epDir = await makeProject(true)
    await writeProjectConfig({ research_auto_approve_claims: true })
    const job = await runGeneratorWithStubAdapter({})

    const written = await readResearch(epDir)
    assert.ok(written.claims.every(c => c.status === 'verified'),
      'every claim reaches the same verified state a hand triage produces')
    assert.equal(rv.isResearchReviewed(written), true, 'the episode is Reviewed with no clicks')
    assert.equal(written.review?.completed_by, 'auto-approval')
    assert.notEqual(written.review?.completed_by, 'human', 'and never as a person')
    assert.ok(job.output_lines.some(l => /AUTO-APPROVED/.test(l)))
    assert.ok(!job.output_lines.some(l => /Claim review: PENDING/.test(l)))

    // The markdown a reader opens in Finder says it too, in its own words.
    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /Claims auto-approved/)
    assert.match(md, /No human read these claims/)
    assert.doesNotMatch(md, /unattended Pipeline run/)
  })

  test('an unattended Pipeline run still records itself as the Pipeline', async () => {
    // Both are automatic; the batch's stronger claim wins so the record never
    // understates that the run was unattended.
    const epDir = await makeProject(true)
    await writeProjectConfig({ research_auto_approve_claims: true })
    await runGeneratorWithStubAdapter({ pipeline_batch_id: 'batch-123' })
    const written = await readResearch(epDir)
    assert.equal(written.review?.completed_by, 'pipeline-auto')
  })

  test('the setting is read at run time, so flipping it changes the very next run', async () => {
    const epDir = await makeProject(true)
    await writeProjectConfig({ research_auto_approve_claims: true })
    await runGeneratorWithStubAdapter({})
    assert.equal((await readResearch(epDir)).review?.completed_by, 'auto-approval')

    await writeProjectConfig({ research_auto_approve_claims: false })
    await runGeneratorWithStubAdapter({})
    const after = await readResearch(epDir)
    assert.equal(after.review, undefined, 'turning it off returns the next run to manual review')
    assert.ok(after.claims.every(c => c.status === 'unreviewed'))
  })

  test('the setting survives a settings/config round-trip', async () => {
    await makeProject(true)
    await writeProjectConfig({})
    assert.equal(rv.researchAutoApproveEnabled(await pm.getConfig(SLUG)), false,
      'default off: an untouched project has no key at all')
    assert.equal(((await pm.getSafeConfig(SLUG)) as any).research_auto_approve_claims, undefined)

    assert.equal(await pm.updateConfig(SLUG, { research_auto_approve_claims: true }), true)
    assert.equal(rv.researchAutoApproveEnabled(await pm.getConfig(SLUG)), true)
    assert.equal(((await pm.getSafeConfig(SLUG)) as any).research_auto_approve_claims, true,
      'and getSafeConfig must ECHO it, or the page would re-render its default after a reload')

    assert.equal(await pm.updateConfig(SLUG, { research_auto_approve_claims: false }), true)
    assert.equal(rv.researchAutoApproveEnabled(await pm.getConfig(SLUG)), false)
    assert.equal(((await pm.getSafeConfig(SLUG)) as any).research_auto_approve_claims, false)
  })

  test('the Script Generator cannot tell an auto-approved claim from a hand-approved one', async () => {
    // The consumer's own predicate (lib/chunked-narration.ts, and the scene
    // planner) is `status === 'verified'`. Auto-approval must satisfy it
    // identically — no second field, no special case.
    const epDir = await makeProject(true)
    await writeProjectConfig({ research_auto_approve_claims: true })
    await runGeneratorWithStubAdapter({})
    const auto = await readResearch(epDir)

    const byHand = rv.withResearchReviewRecord(triaged('verified'), 'human')
    const usable = (r: ResearchOutput) => (r.claims || [])
      .filter(c => c.status === 'verified' && c.text?.trim())
      .map(c => c.text)

    assert.deepEqual(usable(auto), usable(byHand))
    assert.equal(usable(auto).length, 1, 'and the claim really does reach the Script Generator')
    // Distinguishable only where it should be: the provenance record.
    assert.notEqual(auto.review?.completed_by, byHand.review?.completed_by)
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

  test('research.md separates retrieved pages from structured citations and filters unsafe links', async () => {
    const epDir = await makeProject(true)
    await runWebGenerator(
      [
        { title: 'Safe citation', url: ' https://example.invalid/citation ' },
        { title: 'Unsafe citation', url: 'javascript:alert(1)' },
      ],
      {
        source_urls: [
          ' https://example.invalid/opened ',
          'javascript:alert(1)',
          'data:text/html,unsafe',
        ],
      },
    )

    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /## Structured citations/)
    assert.match(md, /\[Safe citation\]\(<https:\/\/example\.invalid\/citation>\)/)
    assert.match(md, /## Pages GenStudio reported retrieving/)
    assert.match(md, /https:\/\/example\.invalid\/opened/)
    assert.match(md, /not citations and do not back individual claims/i)
    assert.doesNotMatch(md, /javascript:|data:text\/html/)
  })

  test('research.md cannot turn canonical URLs or titles into injected Markdown links', async () => {
    const epDir = await makeProject(true)
    await runWebGenerator(
      [{
        title: 'Citation ](javascript:alert(1))',
        url: 'https://example.invalid/](javascript:alert(1))',
      }],
      { source_urls: ['https://example.invalid/](javascript:alert(1))'] },
    )

    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.ok(md.includes('[Citation \\]\\(javascript:alert\\(1\\)\\)](<https://example.invalid/](javascript:alert(1))>)'))
    assert.match(md, /- <https:\/\/example\.invalid\/\]\(javascript:alert\(1\)\)>/)
  })

  test('research.md renders citation metadata as plain text and normalizes a non-string title', async () => {
    const epDir = await makeProject(true)
    await runWebGenerator([
      {
        title: '<a href="javascript:alert(1)">Title</a>',
        url: 'https://example.invalid/html',
        publisher: '<img src=x onerror=alert(1)>',
        snippet: '<script>alert(1)</script> [link](javascript:alert(1))',
      },
      { title: 123 as unknown as string, url: 'https://example.invalid/fallback-title' },
    ])

    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /&lt;a href=/)
    assert.match(md, /&lt;img src=x/)
    assert.match(md, /&lt;script&gt;/)
    assert.match(md, /\[https:\/\/example\.invalid\/fallback-title\]\(<https:\/\/example\.invalid\/fallback-title>\)/)
    assert.doesNotMatch(md, /<a href=|<img |<script>|\[link\]\(javascript:/)
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

describe('new projects do not persist a research gate', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
  })
  after(async () => { await tmp.cleanup() })

  test('createProject leaves Research optional without metadata policy', async () => {
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    const meta = await pm.createProject({ name: 'Brand New Channel' } as any)
    const onDisk = JSON.parse(
      await fs.readFile(path.join(pm.projectsRoot(), meta.slug, 'project.json'), 'utf-8'),
    )
    assert.equal(Object.hasOwn(onDisk, 'research_required'), false)
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
