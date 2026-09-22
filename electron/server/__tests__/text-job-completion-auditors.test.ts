/**
 * NEW-02 — the text job types have a completion auditor again.
 *
 * DS-02 made a settled-but-unverifiable restart fail loudly instead of running
 * forever, which was right. But `metadata`, `image_prompts` and `research_run`
 * had NO auditor, so every restart of those types became an error even when the
 * output was complete — and the error said so ("no completion audit is
 * registered for this job type").
 *
 * The fix reuses each generator's own proof. These tests pin BOTH directions for
 * every type, because an auditor that always answered `repair-required` would
 * otherwise pass every "not complete" assertion while being just as useless as
 * no auditor at all (AGENTS.md §6). Fixtures are written into the REAL resolved
 * episode paths, because the auditors resolve them from the job — a temp file
 * somewhere else would prove nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  getJobCancellationAuditor,
  hasJobCancellationAuditor,
} from '../services/job-cancellation-auditors.js'
import { writePromptCompletionManifest } from '../services/prompt-completion.js'
import { writeMetadataCompletionManifest } from '../services/metadata-completion.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

const CODE = 'EP0044'
const TYPES = ['image_prompts', 'metadata', 'research_run'] as const

let cleanup: () => Promise<void>
let projectSlug: string
let paths: {
  episode_dir: string
  thumb_prompts_dir: string
  metadata_dir: string
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  // Auditors are registered at boot; a test process must do the same or it is
  // asserting against an empty registry (the same call the app makes).
  const { registerAllExecutors } = await import('../boot/executors.js')
  registerAllExecutors({ loadSettings: false })
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Text completion auditors' })
  projectSlug = project.slug
  const resolved = await resolveEpisodePathsByCode(projectSlug, CODE)
  paths = {
    episode_dir: resolved.episode_dir,
    thumb_prompts_dir: resolved.thumb_prompts_dir,
    metadata_dir: resolved.metadata_dir,
  }
  await Promise.all([
    fs.mkdir(paths.thumb_prompts_dir, { recursive: true }),
    fs.mkdir(paths.metadata_dir, { recursive: true }),
  ])
})

after(async () => {
  await cleanup()
})

function job(type: Job['type']): Job {
  return {
    job_id: `audit-${type}`,
    project_slug: projectSlug,
    type,
    episode_id: CODE,
    title: 'Auditor fixture',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
  } as unknown as Job
}

describe('every text type that can settle after a restart has an auditor', () => {
  test('the three types register one', () => {
    for (const type of TYPES) {
      assert.equal(hasJobCancellationAuditor(type), true,
        `${type} must have a completion auditor, or a restart errors over complete output`)
    }
  })
})

describe('the auditors verify output in both directions', () => {
  test('image_prompts: complete manifest + prompts is complete; empty is not', async () => {
    const auditor = getJobCancellationAuditor('image_prompts')!
    assert.equal(await auditor(job('image_prompts')), 'repair-required',
      'nothing on disk must never be reported complete')

    // The shape the generator writes, plus the completion manifest naming two
    // expected prompts.
    await fs.writeFile(path.join(paths.thumb_prompts_dir, `${CODE}_Thumbnail_Prompts.md`), [
      '# Thumbnail Prompts',
      '',
      '## Thumbnail 1: Lantern',
      '',
      'A lantern in a quiet archive, warm light, deep shadow.',
      '',
      '## Thumbnail 2: Ledger',
      '',
      'An open ledger on a desk, cold morning light.',
      '',
    ].join('\n'))
    await writePromptCompletionManifest(paths.thumb_prompts_dir, CODE, 'thumbnail', 2)

    assert.equal(await auditor(job('image_prompts')), 'complete',
      'a complete two-prompt document with its manifest must be verified complete')
  })

  test('metadata: description + every expected title and tag is complete; a missing field is not', async () => {
    const auditor = getJobCancellationAuditor('metadata')!

    await writeMetadataCompletionManifest(paths.metadata_dir, CODE, 'metadata.json', 2, 2)
    await fs.writeFile(path.join(paths.metadata_dir, 'metadata.json'), JSON.stringify({
      description: 'A complete description of the episode.',
      title_options: ['First title', 'Second title'],
      tags: ['one', 'two'],
    }))
    assert.equal(await auditor(job('metadata')), 'complete')

    await fs.writeFile(path.join(paths.metadata_dir, 'metadata.json'), JSON.stringify({
      description: '',
      title_options: ['First title'],
      tags: ['one'],
    }))
    assert.equal(await auditor(job('metadata')), 'repair-required',
      'a partial package must stay repair-required, never a verified done')
  })

  test('research_run: real evidence is complete; an empty sidecar is not', async () => {
    const { jsonPath } = await resolveResearchPaths(paths.episode_dir, CODE)
    await fs.mkdir(path.dirname(jsonPath), { recursive: true })
    const auditor = getJobCancellationAuditor('research_run')!
    assert.equal(await auditor(job('research_run')), 'repair-required',
      'no sidecar at all must be repair-required')

    await fs.writeFile(jsonPath, JSON.stringify({
      episode_code: CODE,
      summary: 'An evidence summary the script may use.',
      claims: [{ id: 'c1', text: 'A claim with real text.', status: 'unreviewed' }],
    }))
    assert.equal(await auditor(job('research_run')), 'complete',
      'artifact-based evidence is what makes research complete (AGENTS.md §9)')

    await fs.writeFile(jsonPath, JSON.stringify({ episode_code: CODE, summary: '', claims: [] }))
    assert.equal(await auditor(job('research_run')), 'repair-required',
      'an empty result is not evidence')
  })
})
