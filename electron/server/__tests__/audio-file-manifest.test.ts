import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'

import { clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

function binaryBody(response: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
  response.on('end', () => done(null, Buffer.concat(chunks)))
  response.on('error', (error: Error) => done(error, Buffer.alloc(0)))
}

void test('audio-file info returns only the ordered active multipart selection', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  try {
    const app = (await import('../app.js')).app
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const jq = await import('../services/job-queue.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')

    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()

    const project = await pm.createProject({ name: 'Audio file manifest', episode_prefix: 'AM', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Multipart fixture', logline: 'Fixture', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const code = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await Promise.all([paths.script_dir, paths.audio_dir].map(dir => fs.mkdir(dir, { recursive: true })))
    // Mock TTS publishes a 15,000-character request ceiling. Record the
    // selected model in history so the reconciler predicts multipart names.
    jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'audio',
      episode_id: code,
      title: 'multipart fixture',
      params: { model: 'mock-tts-v1' },
    })
    await fs.writeFile(paths.narration_docx, `# Narration\n\n## Chapter 01: Fixture\n\n${'A short sentence. '.repeat(16_000)}`)

    const base = (part: number) => `${code}_Chapter_01_part${part}.mp3`
    const active = (part: number) => `${code}_Chapter_01_part${part}_v2.mp3`
    for (const part of [1, 2, 10]) {
      await fs.writeFile(path.join(paths.audio_dir, base(part)), `old part ${part}`)
      await fs.writeFile(path.join(paths.audio_dir, active(part)), `active part ${part}`)
    }
    // The sidecar is the authoritative selected version and its order must be
    // kept exactly; retained base files are intentionally present beside it.
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: [{
      slug: 'Chapter_01',
      source_file: active(10),
      source_files: [active(10), active(2), active(1)],
    }] }))

    const endpoint = `/api/projects/${project.slug}/episodes/${code}/audio-file`
    const selected = await request(app).get(endpoint).query({ section: 'Chapter_01', info: 1 })
    assert.equal(selected.status, 200, JSON.stringify(selected.body))
    assert.deepEqual(selected.body, {
      parts: [
        { part: 0, filename: active(10) },
        { part: 1, filename: active(2) },
        { part: 2, filename: active(1) },
      ],
    }, 'the exact active map wins over retained historical variants')

    const streamed = await request(app).get(endpoint).query({ section: 'Chapter_01', part: 1 })
      .buffer(true).parse(binaryBody as any)
    assert.equal(streamed.status, 200)
    assert.deepEqual(streamed.body, Buffer.from('active part 2'), 'streaming part indexes use the same active-map order as metadata')

    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: [{
      slug: 'Chapter_01', source_files: [active(1), '../retained-base.mp3'],
    }] }))
    const malformedMap = await request(app).get(endpoint).query({ section: 'Chapter_01', info: 1 })
    assert.equal(malformedMap.status, 404, JSON.stringify(malformedMap.body))

    // A sidecar that explicitly selects audio is authoritative. If its chosen
    // file disappears, refusing playback is safer than silently substituting
    // the retained base recording that happens to remain beside it.
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: [{
      slug: 'Chapter_01', source_file: active(10), source_files: [active(10), active(2), active(1)],
    }] }))
    await fs.unlink(path.join(paths.audio_dir, active(2)))
    const missingActive = await request(app).get(endpoint).query({ section: 'Chapter_01', info: 1 })
    assert.equal(missingActive.status, 404, JSON.stringify(missingActive.body))
    assert.match(missingActive.body.detail, /selected active audio/i)

    // When no active mapping exists, the reconciler fallback still plays
    // multipart files in numeric chunk order instead of lexical part10-before-part2 order.
    await fs.unlink(path.join(paths.episode_dir, 'audio_chapters.json'))
    const fallback = await request(app).get(endpoint).query({ section: 'Chapter_01', info: 1 })
    assert.equal(fallback.status, 200, JSON.stringify(fallback.body))
    assert.deepEqual(fallback.body.parts.map((part: { filename: string }) => part.filename), [base(1), base(2), base(10)])

    const traversal = await request(app).get(endpoint).query({ section: 'Chapter_01/../outside', info: 1 })
    assert.equal(traversal.status, 404, JSON.stringify(traversal.body))
  } finally {
    clearGenStudioCatalogCache()
    await service.close()
    await isolated.cleanup()
  }
})
