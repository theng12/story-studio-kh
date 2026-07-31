/**
 * Research gate + verification contract (v1.0.760).
 *
 * This reverses the old "research is always optional" rule, so the tests pin
 * BOTH directions:
 *
 *   - `research_required` ON  → research blocks completion until verified
 *   - `research_required` OFF → byte-for-byte today's optional behaviour
 *   - setting ABSENT (a project created before the gate) → resolves OFF
 *   - generating / regenerating research resets it to unverified
 *   - verifying completes it; un-verifying takes it back
 *   - Pipeline runs auto-verify, and that is distinguishable from a human
 *   - the Research pending filter lists unverified research
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
import type { Job, ResearchOutput } from '../models/types.js'

let pm: typeof import('../services/project-manager.js')
let assetStatus: typeof import('../services/asset-status.js')
let cacheMod: typeof import('../services/episode-status-cache.js')
let rv: typeof import('../lib/research-verification.js')
let researchPaths: typeof import('../lib/research-paths.js')
let pipeline: typeof import('../routes/pipeline.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'research-gate-test'
const CODE = 'EP0001'

/** A research sidecar with real evidence in it. */
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

/**
 * Build a project on disk. `researchRequired` is passed as-is so we can create
 * the three distinct cases the migration cares about: explicitly on,
 * explicitly off, and ABSENT (a project that predates the gate).
 */
async function makeProject(researchRequired?: boolean): Promise<string> {
  const projDir = path.join(pm.PROJECTS_ROOT, SLUG)
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
    assert.equal(rv.isResearchComplete(rv.withResearchUnverified(generated), false), true)
    assert.equal(rv.isResearchComplete({ summary: '', claims: [] }, false), false)
  })

  test('gate ON: evidence is not enough — it must also be verified', () => {
    const generated = rv.withResearchUnverified(researchFixture())
    assert.equal(rv.isResearchComplete(generated, true), false)
    assert.equal(rv.isResearchComplete(rv.withResearchVerified(generated, 'human'), true), true)
  })

  test('gate ON: verified but EMPTY research is still not complete', () => {
    const empty = rv.withResearchVerified(researchFixture({ summary: '', claims: [] }), 'human')
    assert.equal(rv.isResearchComplete(empty, true), false)
  })

  test('a forged verification block cannot fake an attestation', () => {
    assert.equal(rv.isResearchVerified({ verification: { verified: 'yes' } }), false)
    assert.equal(rv.isResearchVerified({ verification: true }), false)
    // A truthy `verified` with a junk actor still reads as verified, but the
    // actor is dropped rather than trusted.
    assert.equal(rv.readResearchVerification({ verification: { verified: true, verified_by: 'admin' } }).verified_by, undefined)
  })

  test('human vs pipeline attestations stay distinguishable', () => {
    const human = rv.withResearchVerified(researchFixture(), 'human')
    const auto = rv.withResearchVerified(researchFixture(), 'pipeline-auto')
    assert.equal(human.verification?.verified_by, 'human')
    assert.equal(auto.verification?.verified_by, 'pipeline-auto')
    assert.match(auto.verification?.note || '', /no human reviewed/i)
    assert.ok(auto.verification?.verified_at, 'automatic verification must be timestamped too')
  })

  test('un-verifying clears the attestation entirely', () => {
    const verified = rv.withResearchVerified(researchFixture(), 'human')
    const cleared = rv.withResearchUnverified(verified)
    assert.equal(cleared.verification?.verified, false)
    assert.equal(cleared.verification?.verified_by, undefined)
    assert.equal(cleared.verification?.verified_at, undefined)
  })

  test('gap messages name what is missing AND how to fix it', () => {
    assert.equal(rv.describeResearchGap({ episodeId: CODE, researchRequired: false, hasEvidence: false, verified: false }), null)
    const missing = rv.describeResearchGap({ episodeId: CODE, researchRequired: true, hasEvidence: false, verified: false })
    assert.match(missing || '', /EP0001/)
    assert.match(missing || '', /no research evidence exists/)
    assert.match(missing || '', /run it for this episode/)
    const unverified = rv.describeResearchGap({ episodeId: CODE, researchRequired: true, hasEvidence: true, verified: false })
    assert.match(unverified || '', /not verified/)
    assert.match(unverified || '', /Verify research/)
    assert.equal(rv.describeResearchGap({ episodeId: CODE, researchRequired: true, hasEvidence: true, verified: true }), null)
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
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'), 'PROJECTS_ROOT must be the temp dir')
  })
  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  test('gate ON + generated-but-unverified → NOT complete, but flagged as generated', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUnverified(researchFixture()))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, false, 'unverified research must not count as complete')
    assert.equal(status.research_generated, true, 'the evidence itself is present')
    assert.equal(status.research_verified, false)
    assert.equal(status.research_required, true)
  })

  test('gate ON + verified → complete, and the actor is surfaced', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchVerified(researchFixture(), 'human'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true)
    assert.equal(status.research_verified, true)
    assert.equal(status.research_verified_by, 'human')
  })

  test('gate ON + pipeline auto-verified → complete, and marked automatic', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchVerified(researchFixture(), 'pipeline-auto'))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'an unattended run must not be blocked')
    assert.equal(status.research_verified_by, 'pipeline-auto',
      'the record must never imply a human reviewed these claims')
  })

  test('gate OFF: unverified research is complete, exactly as before the gate', async () => {
    const epDir = await makeProject(false)
    await writeResearch(epDir, rv.withResearchUnverified(researchFixture()))
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true)
    assert.equal(status.research_required, false)
  })

  test('setting ABSENT (legacy project): behaves exactly like gate OFF', async () => {
    const epDir = await makeProject(undefined)
    await writeResearch(epDir, researchFixture())  // no verification block at all
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'an upgraded project must not regress to incomplete')
    assert.equal(status.research_required, false)
    assert.equal(status.research_verified, false)
  })

  test('no sidecar at all → not generated, not verified, not complete', async () => {
    await makeProject(true)
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, false)
    assert.equal(status.research_generated, false)
    assert.equal(status.research_verified, false)
  })

  test('gate ON + an empty sidecar is never complete, verified or not', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchVerified(researchFixture({ summary: '', claims: [] }), 'human'))
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
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  test('pending filter lists unverified research and drops it once verified', async () => {
    // The Research page's "Pending only" filter keys off `status.research`, so
    // that boolean IS the pending contract.
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUnverified(researchFixture()))
    const pendingBefore = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pendingBefore.research, false, 'must still appear in the pending list')

    cacheMod.episodeStatusCache.clear()
    await writeResearch(epDir, rv.withResearchVerified(researchFixture(), 'human'))
    const pendingAfter = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pendingAfter.research, true, 'verifying must drop it out of pending')
  })

  test('isStepAlreadyDone("research") follows the SAME gated rule as the board', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUnverified(researchFixture()))
    const unverified = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pipeline.isStepAlreadyDone(unverified, 'research'), false)

    cacheMod.episodeStatusCache.clear()
    await writeResearch(epDir, rv.withResearchVerified(researchFixture(), 'human'))
    const verified = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(pipeline.isStepAlreadyDone(verified, 'research'), true)
  })

  test('Pipeline auto-verifies EXISTING evidence instead of regenerating it', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUnverified(researchFixture()))

    const changed = await pipeline.autoVerifyResearchForPipeline(SLUG, CODE)
    assert.equal(changed, true)

    const after = await readResearch(epDir)
    assert.equal(after.verification?.verified, true)
    assert.equal(after.verification?.verified_by, 'pipeline-auto',
      'automatic verification must never be recorded as human')
    // The evidence itself must be untouched — this promotes, it does not rerun.
    assert.equal(after.claims.length, 1)
    assert.equal(after.summary, researchFixture().summary)

    cacheMod.episodeStatusCache.clear()
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.research, true, 'the unattended run is no longer blocked')
  })

  test('Pipeline auto-verification never overwrites a human attestation', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchVerified(researchFixture(), 'human'))
    const changed = await pipeline.autoVerifyResearchForPipeline(SLUG, CODE)
    assert.equal(changed, false)
    assert.equal((await readResearch(epDir)).verification?.verified_by, 'human')
  })

  test('Pipeline auto-verification never invents evidence that is not there', async () => {
    const epDir = await makeProject(true)
    await writeResearch(epDir, rv.withResearchUnverified(researchFixture({ summary: '', claims: [] })))
    assert.equal(await pipeline.autoVerifyResearchForPipeline(SLUG, CODE), false)
    assert.equal((await readResearch(epDir)).verification?.verified, false)

    // And with no sidecar at all it is a silent no-op, so the step just runs.
    await fs.rm(path.join(epDir, researchPaths.researchFolderName(CODE)), { recursive: true, force: true })
    assert.equal(await pipeline.autoVerifyResearchForPipeline(SLUG, CODE), false)
  })
})

describe('the research generator resets verification', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    cacheMod = await import('../services/episode-status-cache.js')
    rv = await import('../lib/research-verification.js')
    researchPaths = await import('../lib/research-paths.js')
  })
  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
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
    adapter.run = async () => researchFixture()
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

  test('a manual run writes UNVERIFIED research even over a previously verified sidecar', async () => {
    const epDir = await makeProject(true)
    // Pre-existing, human-verified research for an OLDER generation.
    await writeResearch(epDir, rv.withResearchVerified(researchFixture({ summary: 'stale' }), 'human'))

    const job = await runGeneratorWithStubAdapter({})

    const written = await readResearch(epDir)
    assert.equal(written.verification?.verified, false,
      'regeneration must clear the old attestation — nobody has read the NEW claims')
    assert.ok(job.output_lines.some(l => /NOT VERIFIED/.test(l)),
      'the job log must tell the user verification is still owed')
  })

  test('a Pipeline run auto-verifies and records that it was automatic', async () => {
    const epDir = await makeProject(true)
    const job = await runGeneratorWithStubAdapter({ pipeline_batch_id: 'batch-123' })

    const written = await readResearch(epDir)
    assert.equal(written.verification?.verified, true, 'unattended runs must not be left blocked')
    assert.equal(written.verification?.verified_by, 'pipeline-auto')
    assert.ok(job.output_lines.some(l => /AUTO-VERIFIED/.test(l)))

    // And the markdown a human reads in Finder says so too.
    const { mdPath } = await researchPaths.resolveResearchPaths(epDir, CODE)
    assert.match(await fs.readFile(mdPath, 'utf-8'), /Auto-verified/)
  })

  test('an empty pipeline_batch_id is not treated as a Pipeline run', async () => {
    const epDir = await makeProject(true)
    await runGeneratorWithStubAdapter({ pipeline_batch_id: '' })
    assert.equal((await readResearch(epDir)).verification?.verified, false)
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
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    const meta = await pm.createProject({ name: 'Brand New Channel' } as any)
    const onDisk = JSON.parse(
      await fs.readFile(path.join(pm.PROJECTS_ROOT, meta.slug, 'project.json'), 'utf-8'),
    )
    // Stamped, not inferred — this is what makes "absent means legacy" safe.
    assert.equal(onDisk.research_required, true)
    assert.equal(rv.resolveResearchRequired(onDisk), true)
  })
})
