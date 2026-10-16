/**
 * A metadata job that got a Gateway answer and found it unusable records `result.chat_answer_rejected`,
 * so Retry asks afresh instead of replaying that answer's key (NEW-14). The mock Gateway's one-line
 * answer leaves the tags short, which the completion audit refuses.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const CODE = 'EP0001'
const TITLE = 'The Lighthouse Ledger'

test('a metadata job whose answer fails the completion audit marks the answer rejected', async t => {
  const temporary = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => {
    await mock.close()
    await temporary.cleanup()
  })
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const projects = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  const project = await projects.createProject({ name: 'Metadata rejected answer', episode_prefix: 'EP', episode_digits: 4 })
  await projects.updateConfig(project.slug, { safety_checks: { chapter_marks: 'warn' } } as any)
  const paths = await resolveEpisodePaths(project.slug, CODE, TITLE)
  const narration = paths.narration_docx.replace(/\.docx$/i, '.md')
  await fs.mkdir(paths.metadata_json.replace(/[/\\][^/\\]*$/, ''), { recursive: true })
  await fs.mkdir(narration.replace(/[/\\][^/\\]*$/, ''), { recursive: true })
  await fs.writeFile(narration, 'A keeper compares two ledgers while the tide turns.')

  await import('../providers/text/genstudio.js')
  const { generateMetadata } = await import('../generators/metadata.js')
  const job: any = {
    job_id: 'metadata-rejected-answer', project_slug: project.slug, type: 'metadata', episode_id: CODE,
    title: 'YouTube Finalizer', output_lines: [],
    params: { episode_id: CODE, title: TITLE, model: 'mock-chat-v1', title_mode: 'use_idea_title', tag_count: 5 },
  }
  await assert.rejects(generateMetadata(job), /tag/i)
  assert.equal(job.result?.chat_answer_rejected, true)
})
