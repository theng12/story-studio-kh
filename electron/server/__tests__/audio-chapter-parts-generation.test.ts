/**
 * Narration split into parts ends as ONE chapter file as soon as every part
 * succeeded; the parts are kept hidden so a re-run never pays again and one
 * missing part is made alone, then the chapter is re-joined.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio, resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { readPartsManifest } = await import('../services/chapter-parts.js')
const { readAudioQualityProvenance } = await import('../services/audio-quality-store.js')
const { episodeDirForNarration } = await import('../generators/audio.js')

void test('split narration is joined into one chapter file; re-runs never pay again; a missing part is remade alone', async () => {
  const service = await startMockGenStudioService()
  try {
    await setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    service.ttsModels = [{
      id: 'tiny-model', display_name: 'Tiny', provider_id: 'p', provider_name: 'Mock provider', description: '',
      credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 40,
      supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
      preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
    }]
    clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Joined chapters', episode_prefix: 'EP', episode_digits: 3 })
    const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
    const narrationDir = path.join(outputRoot, 'EP001 - Script')
    await fs.mkdir(narrationDir, { recursive: true })
    await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
      '# Narration',
      '## Chapter 1: One',
      'First sentence is here. Second sentence is here.',
      'Third paragraph is here.',
    ].join('\n\n'))

    let run = 0
    const generate = async () => {
      const job: any = {
        job_id: `audio-joined-${++run}`, project_slug: project.slug, type: 'audio', episode_id: 'EP001',
        title: 'Joined chapters', status: 'running', created_at: new Date().toISOString(),
        started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [],
        params: { episode_id: 'EP001', model: 'tiny-model', voice: 'mock-voice', sections: 'all', speed: 1, force: false, no_overwrite: false },
      }
      await generateAudio(job)
      return job
    }

    const first = await generate()
    assert.equal(service.providerSubmissionCount('tts'), 3, first.output_lines.join('\n'))
    const narration = await findNarrationFile(project.slug, 'EP001')
    const audioDir = await resolveAudioDir(project.slug, narration, 'EP001')
    const mp3s = async () => (await fs.readdir(audioDir)).filter(name => name.endsWith('.mp3')).sort()
    const [chapterFile] = await mp3s()
    assert.deepEqual(await mp3s(), [chapterFile], 'one visible file for the chapter, no _partN files')
    const stem = chapterFile!.replace(/\.mp3$/, '')
    const manifest = (await readPartsManifest(audioDir, stem))!
    assert.equal(manifest.parts.length, 3)
    assert.deepEqual(manifest.parts.map(part => part.pause_after_s), [1.0, 1.5, undefined], 'sentence then paragraph pause (uniform 1.0 / 1.5 s)')
    assert.ok(manifest.parts.every(part => part.request_key && part.text_sha256 && typeof part.text_start === 'number'))
    assert.equal(manifest.model_id, 'tiny-model')
    assert.deepEqual(manifest.settings, { speed: 1 })
    const episodeDir = episodeDirForNarration(narration)
    assert.deepEqual((await readAudioQualityProvenance(episodeDir)).chapters[manifest.chapter]!.source_files, [chapterFile])

    // Status, recovery and "Generate missing" see the chapter as that one file.
    const { getAudioStatus } = await import('../services/audio-reconciler.js')
    const status = await getAudioStatus(project.slug, 'EP001')
    assert.deepEqual(status.expected.map(chunk => chunk.filename), [chapterFile])
    assert.deepEqual(status.missing, [])

    // Re-run: everything is present (as the joined file + kept parts) — nothing is bought again.
    const second = await generate()
    assert.equal(service.providerSubmissionCount('tts'), 3)
    assert.ok(second.output_lines.some((line: string) => /already present/.test(line)), second.output_lines.join('\n'))

    // One part is gone: only that part is fetched again (here reclaimed from the
    // Gateway's finished job, so nothing new is bought); the others stay kept.
    await fs.rename(path.join(audioDir, '.parts', stem, 'part2.mp3'), path.join(temp.dir, 'bad-part2.mp3'))
    const third = await generate()
    assert.equal(service.providerSubmissionCount('tts'), 3, third.output_lines.join('\n'))
    assert.equal(third.output_lines.filter((line: string) => /^ {2}Skipping .*_part\d\.mp3/.test(line)).length, 2)
    assert.ok(third.output_lines.some((line: string) => /part2\.mp3: collecting the result of the earlier request/.test(line)))
    assert.deepEqual(await mp3s(), [chapterFile])
    for (const n of [1, 2, 3]) assert.ok(existsSync(path.join(audioDir, '.parts', stem, `part${n}.mp3`)))
    assert.deepEqual((await readAudioQualityProvenance(episodeDir)).chapters[manifest.chapter]!.source_files, [chapterFile])

    // Regenerate makes a new take of every part and joins it again.
    const forced: any = await (async () => {
      const job: any = {
        job_id: 'audio-joined-force', project_slug: project.slug, type: 'audio', episode_id: 'EP001',
        title: 'Joined chapters', status: 'running', created_at: new Date().toISOString(),
        started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [],
        params: { episode_id: 'EP001', model: 'tiny-model', voice: 'mock-voice', sections: 'all', speed: 1, force: true, no_overwrite: false },
      }
      await generateAudio(job)
      return job
    })()
    assert.equal(service.providerSubmissionCount('tts'), 6, forced.output_lines.join('\n'))
    assert.deepEqual(await mp3s(), [chapterFile])
    for (const n of [1, 2, 3]) assert.ok(existsSync(path.join(audioDir, '.parts', stem, `part${n}.mp3`)))

    // The owner frees the parts in Free up space: the chapter still counts as made, a re-run
    // buys nothing, and the Audio Assembly preflight passes on the joined chapter file alone.
    const { trashEpisodeParts, narrationPartsToFree } = await import('../services/chapter-parts.js')
    const freed = await trashEpisodeParts(pm.getProjectDir(project.slug)!, audioDir, (await narrationPartsToFree(audioDir)).map(item => item.path))
    assert.equal(freed.moved.length, 1, JSON.stringify(freed))
    assert.ok(!existsSync(path.join(audioDir, '.parts', stem)))
    const afterFree = await generate()
    assert.equal(service.providerSubmissionCount('tts'), 6, afterFree.output_lines.join('\n'))
    assert.ok(afterFree.output_lines.some((line: string) => /already present/.test(line)), afterFree.output_lines.join('\n'))
    assert.deepEqual(await mp3s(), [chapterFile])
    const { requireChapterAudioReady } = await import('../services/audio-workflow-readiness.js')
    const ready = await requireChapterAudioReady(project.slug, 'EP001')
    assert.deepEqual([ready.expected_files, ready.missing_files], [[chapterFile], []])

  } finally {
    clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})
