// boundful EP0092/EP0100 (Story 1.4.277, 2026-10-10): thumbnails on Z-Image and Qwen (both free
// Studio Hub fleet models) failed with only "This image was not made", and no Gateway task was
// created. Each thumbnail had an earlier failed fleet task in its manifest; the paid-replacement
// gate (meant for charged work) refused to resend it. Free fleet work now takes the ordinary fresh
// retry, a short prompt file makes the thumbnails it has and says so, and a paid refusal says why.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const FREE_MODEL = 'studio-hub::mock-image-v1'

function freeCatalogRow() {
  return {
    id: FREE_MODEL, display_name: 'Mock Fleet Image', description: 'In-process PNG fixture.',
    available: true, qualification_only: false, chargeable: false,
    aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', default_resolution: '1K',
    output_options: [{ resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true, credits_per_image: 0, price_version: 'free' }],
    max_prompt_characters: 4800, prompt_token_allowance: 1200, min_reference_images: 0, max_reference_images: 0,
  }
}

test('a free-fleet thumbnail with a dead earlier task is sent again, and a 2-of-3 prompt file makes 2', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const deadTask = 'dead-fleet-thumb-task'
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([freeCatalogRow()])
      if (url.pathname.includes(deadTask)) {
        // EP0092's earlier task: failed with a code the paid policy never resends.
        return Response.json({
          id: deadTask, state: 'failed', operation: 'image.generation', model_id: FREE_MODEL,
          cancellable: false, cancelled: false, failure_code: 'CONTENT_REFUSED',
          reserved_credits: 0, settled_credits: 0, released_credits: 0,
        })
      }
      return originalFetch(input, init)
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const queue = await import('../services/job-queue.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    const { writePromptCompletionManifest } = await import('../services/prompt-completion.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { generateImages, resolveImageDirs } = await import('../generators/images.js')

    const project = await pm.createProject({ name: 'Boundless thumbnails', episode_prefix: 'EP', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{ title: "The Hidden System Behind Cleopatra's Final Hours", logline: 'Fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'neutral' }], 'mock-chat-v1')
    const episodeId = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    const promptPath = toMdPath(paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA sealed letter by lamplight.\n\n## Thumbnail 2: Second\n\nA queen at dusk.\n')
    await writePromptCompletionManifest(path.dirname(promptPath), episodeId, 'thumbnail', 3)

    const { thumbDir } = await resolveImageDirs(project.slug, promptPath, episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    const filename = `${episodeId.toUpperCase()}_Thumb01_v1.png`
    const selector = { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' as const }
    const original = buildPaidImageOriginalIdentity({ prompt: 'A sealed letter by lamplight.', baseScope: 'default', references: [], selector })
    await recordTaskStrict(thumbDir, filename, {
      provider: 'genstudio-image', task_id: deadTask, submitted_at: '2026-10-10T04:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: 'story-dead-fleet-key', operation: 'image',
      last_state: 'failed', request_scope: original.requestScope, model_id: FREE_MODEL,
      original_output_selector: selector, original_reference_inputs: [],
      original_reference_identity_hash: original.referenceIdentityHash, original_output_path: path.join(thumbDir, filename),
    })

    const now = new Date().toISOString()
    const job: any = {
      job_id: 'boundless-free-thumbs', project_slug: project.slug, type: 'thumb_images', episode_id: episodeId,
      title: 'Thumbnails', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, mode: 'thumbs', model: FREE_MODEL, aspect_ratio: '16:9', resolution: '1K' },
    }
    await queue._waitForJobPersistenceForTesting()
    await fs.writeFile(path.join(pm.getProjectDir(project.slug)!, 'jobs.json'), JSON.stringify({ jobs: [job] }))
    queue._forgetProjectPersistenceForTesting(project.slug)

    await generateImages(job)
    const log = job.output_lines.join('\n')
    assert.doesNotMatch(log, /This image was not made/, log)
    assert.match(log, /has 2 of the 3 prompts Thumbnail Prompts was asked for; making the 2 it has/)
    assert.equal(service.providerSubmissionCount('image'), 2, log)
    assert.notEqual(service.submissions.find(s => s.operation === 'image')?.idempotencyKey, 'story-dead-fleet-key', 'the dead key is never replayed')
    const manifest = await readManifest(thumbDir)
    assert.equal(manifest.tasks[filename]?.last_state, 'succeeded')
    for (const n of ['01', '02']) await fs.access(path.join(thumbDir, `${episodeId.toUpperCase()}_Thumb${n}_v1.png`))
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a refused paid image says why in plain words', async () => {
  await useTempDataDir()
  const queue = await import('../services/job-queue.js')
  const messages = (['original_failure_not_eligible', 'not_verified', 'replacement_disabled'] as const)
    .map(reason => queue.paidImageReplacementBlockedMessage(reason))
  assert.equal(new Set(messages).size, 3)
  for (const message of messages) assert.match(message, /^This image was not made because .+; nothing new was sent or charged\./)
  assert.match(messages[0]!, /earlier Gateway task failed in a way that is not safe to resubmit/)
})
