import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ProjectAudit } from '../services/manifest-audit.js'
import { useTempDataDir } from './_helpers.js'

const slug = 'task14-audio-measurement-boundaries'
const code = 'EP0001'

async function createFixture(t: TestContext, decorateAudioDir = false) {
  const isolated = await useTempDataDir()
  t.after(async () => {
    t.mock.restoreAll()
    await isolated.cleanup()
  })

  const projectDir = path.join(isolated.dir, 'projects', slug)
  await fs.mkdir(projectDir, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug,
      name: 'Task 14 audio measurement boundaries',
      episode_prefix: 'EP',
      episode_digits: 4,
      season_size: 20,
      season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {
        audio: '{code} - Custom Audio Assets',
        merged_audio: '{code} - Custom Merged Audio',
      },
    })),
    fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{
        id: 'task14-idea',
        title: 'Measurement fixture',
        status: 'accepted',
        episode_code: code,
      }],
      next_episode_number: 2,
      recycled_numbers: [],
    })),
  ])

  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const paths = await resolveEpisodePathsByCode(slug, code)
  const audioDir = decorateAudioDir
    ? path.join(path.dirname(paths.audio_dir), `✅ ${path.basename(paths.audio_dir)}`)
    : paths.audio_dir
  await Promise.all([
    fs.mkdir(paths.script_dir, { recursive: true }),
    fs.mkdir(audioDir, { recursive: true }),
    fs.mkdir(paths.merged_audio_dir, { recursive: true }),
  ])

  const sourceName = `${code}_Chapter_01.mp3`
  const sourcePath = path.join(audioDir, sourceName)
  const sidecarPath = path.join(paths.episode_dir, 'audio_chapters.json')
  await fs.writeFile(paths.narration_docx, '## Chapter 01: Fixture\n\nNarration.\n')
  await fs.writeFile(sourcePath, 'chapter audio')
  await fs.writeFile(sidecarPath, JSON.stringify({
    sections: [{ slug: 'Chapter_01', source_file: sourceName }],
  }))

  const mergedName = `${code}_merged_audio.mp3`
  const mergedPath = path.join(paths.merged_audio_dir, mergedName)
  await fs.writeFile(mergedPath, 'merged audio')
  const mergedStat = await fs.stat(mergedPath)
  await fs.writeFile(
    path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`),
    JSON.stringify({
      output_filename: mergedName,
      bytes: mergedStat.size,
      duration_sec: 1,
    }),
  )

  return { paths, audioDir, sidecarPath }
}

function audioStage(report: ProjectAudit) {
  return report.episodes[0]!.stages.find(stage => stage.stage === 'audio')!
}

test('audit keeps decorated custom audio-folder EACCES distinct from zero assets', async t => {
  const fixture = await createFixture(t, true)
  const { auditAssets } = await import('../services/manifest-audit.js')

  const healthy = audioStage(await auditAssets(slug))
  assert.equal(healthy.outcome, 'measured')
  assert.equal(healthy.present, 1)
  assert.equal(healthy.dir, fixture.audioDir)

  // macOS exposes the same temp directory through both /var and /private/var.
  // Match the filesystem identity rather than one spelling, and prove this
  // fault seam was actually exercised before interpreting the audit result.
  const deniedEpisodeDir = await fs.realpath(fixture.paths.episode_dir)
  const observedPlainReads: string[] = []
  let deniedLookupIntercepted = false
  const readdir = fs.readdir.bind(fs)
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const [target, options] = args as [unknown, unknown?]
    if (options === undefined) {
      const targetPath = path.resolve(String(target))
      const canonicalTarget = await fs.realpath(targetPath).catch(() => targetPath)
      observedPlainReads.push(canonicalTarget)
      if (canonicalTarget === deniedEpisodeDir) {
        deniedLookupIntercepted = true
        throw Object.assign(new Error('simulated custom-folder permission denial'), { code: 'EACCES' })
      }
    }
    return readdir(...args)
  })

  const denied = audioStage(await auditAssets(slug))
  assert.equal(
    deniedLookupIntercepted,
    true,
    `fixture did not intercept the audio-directory read; observed: ${observedPlainReads.join(', ')}`,
  )
  assert.equal(denied.outcome, 'unmeasurable')
  assert.equal(denied.started, false)
  assert.deepEqual(denied.missing, [])
  assert.match(denied.error ?? '', /could not measure.*retry/i)

  t.mock.restoreAll()
  const recovered = audioStage(await auditAssets(slug))
  assert.equal(recovered.outcome, 'measured')
  assert.equal(recovered.present, 1)
})

test('canonical merge accepts healthy evidence and a missing legacy source sidecar', async t => {
  const fixture = await createFixture(t)
  const { getAudioMergeStatus } = await import('../services/asset-status.js')

  const healthy = await getAudioMergeStatus(slug, code)
  assert.equal(healthy.present, true)

  await fs.unlink(fixture.sidecarPath)
  const legacy = await getAudioMergeStatus(slug, code)
  assert.equal(legacy.present, true, 'ENOENT remains compatible with merges made before the sidecar existed')
})

test('canonical merge does not verify with an unreadable existing source sidecar', async t => {
  const fixture = await createFixture(t)
  const { getAudioMergeStatus } = await import('../services/asset-status.js')
  const readFile = fs.readFile.bind(fs)
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (path.resolve(String(args[0])) === fixture.sidecarPath) {
      throw Object.assign(new Error('simulated sidecar permission denial'), { code: 'EACCES' })
    }
    return readFile(...args)
  })

  const status = await getAudioMergeStatus(slug, code)
  assert.equal(status.present, false)
})

test('canonical merge does not verify with a malformed existing source sidecar', async t => {
  const fixture = await createFixture(t)
  const { getAudioMergeStatus } = await import('../services/asset-status.js')
  await fs.writeFile(fixture.sidecarPath, '{not valid json')

  const status = await getAudioMergeStatus(slug, code)
  assert.equal(status.present, false)
})
