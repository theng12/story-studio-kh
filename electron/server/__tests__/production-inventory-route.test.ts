/**
 * The three read-only production-inventory GETs (settings export).
 *
 * Two contracts pin here:
 *   1. Repeated GETs touch NOTHING anywhere — project tree AND the global
 *      data root (legacy permissive app-settings.json, app-secrets.json):
 *      bytes, sizes, mtimes, ctimes and modes all hold. Snapshot hashes
 *      content, not just size/mtime, so a rewrite-in-place still fails.
 *   2. null/absent means "never recorded", never a fabricated default;
 *      corrupt files fail loud instead of being flattened.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let utils: typeof import('../services/utils.js')
let app: express.Express
let tmp: { dir: string; cleanup: () => Promise<void> }
let settingsPath: string
let secretsPath: string

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** Every file AND directory under `root`, stable order: rel|dir or rel|size|mtime|ctime|mode|sha256. */
async function snapshot(root: string): Promise<string> {
  const rows: string[] = []
  const walk = async (dir: string) => {
    const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) {
        rows.push(`${rel}|dir`)
        await walk(full)
      } else {
        const stat = await fs.stat(full)
        rows.push(`${rel}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.mode & 0o777}|${sha(await fs.readFile(full))}`)
      }
    }
  }
  await walk(root)
  return rows.join('\n')
}

/** Per-file identity for the global files the first-read chmod would touch. */
async function fingerprint(files: string[]): Promise<string> {
  const rows: string[] = []
  for (const file of files.sort()) {
    const stat = await fs.stat(file)
    rows.push(`${file}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.mode & 0o777}|${sha(await fs.readFile(file))}`)
  }
  return rows.join('\n')
}

async function makeProject(name: string) {
  const project = await pm.createProject({ name })
  const dir = pm.getProjectDir(project.slug)
  assert.ok(dir, 'project dir resolves')
  return { slug: project.slug, dir: dir! }
}

/** Accepted ideas, written straight into ideas.json — no accept-flow side effects. */
async function writeAcceptedIdeas(slug: string, ideas: Array<{ id: string; title: string; code: string | null }>) {
  const store = {
    ideas: ideas.map((idea) => ({
      id: idea.id,
      title: idea.title,
      logline: 'A quiet test logline.',
      themes: ['test'],
      suggested_chapters: 5,
      suggested_length: '12 min',
      mood: 'calm',
      status: 'accepted',
      episode_code: idea.code,
      generated_at: '2026-11-01T00:00:00.000Z',
      accepted_at: '2026-11-02T00:00:00.000Z',
      batch_id: 'batch-test',
      model_used: 'test-model',
    })),
    next_episode_number: ideas.length + 1,
  }
  await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'ideas.json'), JSON.stringify(store, null, 2))
}

/** Create `<episode>/` + its subtitles folder the way the app would lay it out. */
async function makeEpisodeFolder(slug: string, code: string, title: string) {
  const paths = await utils.resolveEpisodePaths(slug, code, title)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  return paths
}

describe('production inventory routes', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    utils = await import('../services/utils.js')
    const { router } = await import('../routes/production-inventory.js')
    const { errorBoundary } = await import('../lib/error-boundary.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)
    app.use(errorBoundary)

    // Global fixtures, seeded WITHOUT going through readSettings: a direct
    // file write never arms tightenModeOnce's modeTightened set, so the first
    // preset-state GET in the next test is the genuine cold first read. (A
    // setVoicePresetsGlobal seed would warm the seam, and a route reverted to
    // getSafeConfig would then skip its chmod and pass.) The secrets store is
    // written through its own API — it never touches app-settings.
    const { writeAppSecrets, appSecretsPath } = await import('../services/app-secrets-store.js')
    settingsPath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'app-settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ voice_presets: [], voice_favourites: [] }))
    await writeAppSecrets((v3: any) => { v3.providers.fal = { apiKey: '{{SECRET_5xu8d4za}}' } })
    secretsPath = appSecretsPath()
    await fs.chmod(settingsPath, 0o644)
    await fs.chmod(secretsPath, 0o644)
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('preset-state keeps typed and legacy pointers separate and lists every preset-pattern family, secrets excluded', async () => {
    // Manual fixture — NO createProject/updateConfig: both reach readSettings
    // (caught by this suite itself: mode was already 0600 at the cold
    // assert), which arms tightenModeOnce and would hide a getSafeConfig
    // revert behind an already-warmed seam. getProjectDir is just
    // projectsRoot()+existsSync and this route reads config.json only, so
    // folder + config are the whole project for it.
    const slug = 'preset-state-shape'
    const dir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
      script_presets: [{ id: 'sp1', name: 'Plain Script', data: { model: 'story-llm' } }],
      script_last_preset_script: 'sp1',
      script_last_preset: 'dangling-legacy-pointer',
      research_presets: [{ id: 'rp1', name: 'Quick Research' }],
      research_last_preset: 'rp1',
      video_subtitles_presets: [{ id: 'vs1', name: 'Khmer Burn' }],
      video_subtitles_last_preset: 'vs1',
      video_effects_presets: [{ id: 've1', name: 'Soft Glow' }],
      custom_whatever_presets: [{ id: 'x', name: 'Unknown family' }],
      style_presets: [{ id: 'wd', name: 'Whiteboard Doodle' }],
      fal_api_key: 'sk-should-never-export-xyz',
    }, null, 2))

    // Cold-first-read proof: no setup step (createProject, updateConfig,
    // direct config write) may have reached readSettings — tightenModeOnce
    // chmods the seeded 0644 file to 0600 on ANY first read. Mode still 0644
    // here proves the seam is cold, so the GET below is the first read; a
    // route reverted to getSafeConfig would chmod inside it and break the
    // fingerprint assert at the end of this test.
    const seeded = await fs.stat(settingsPath)
    assert.equal(seeded.mode & 0o777, 0o644, 'setup must not reach readSettings (it would arm tightenModeOnce and chmod 0600)')
    const globalsBefore = await fingerprint([settingsPath, secretsPath])

    const response = await request(app).get(`/api/projects/${slug}/settings/preset-state`).expect(200)
    assert.deepEqual(Object.keys(response.body).sort(), ['pointers', 'presets'])
    // Typed AND legacy pointers both survive — no winner-take-all collapse.
    assert.equal(response.body.pointers.script_last_preset_script, 'sp1')
    assert.equal(response.body.pointers.script_last_preset, 'dangling-legacy-pointer')
    assert.equal(response.body.pointers.research_last_preset, 'rp1')
    assert.equal(response.body.pointers.video_subtitles_last_preset, 'vs1')
    // Every preset-pattern family is listed — including ones the pipeline
    // table doesn't know and unknown custom families.
    assert.deepEqual(response.body.presets.script_presets, [{ id: 'sp1', name: 'Plain Script', data: { model: 'story-llm' } }])
    assert.deepEqual(response.body.presets.video_subtitles_presets, [{ id: 'vs1', name: 'Khmer Burn' }])
    assert.deepEqual(response.body.presets.video_effects_presets, [{ id: 've1', name: 'Soft Glow' }])
    assert.deepEqual(response.body.presets.custom_whatever_presets, [{ id: 'x', name: 'Unknown family' }])
    assert.ok(Array.isArray(response.body.presets.style_presets))
    assert.ok(Array.isArray(response.body.presets.research_presets))
    // Non-preset config and secrets stay unexposed.
    const body = JSON.stringify(response.body)
    for (const key of ['image_models', 'channel_default_name', 'publish_cadence', 'fal_api_key', 'secrets']) {
      assert.equal(key in response.body.pointers, false, `${key} is not a pointer`)
      assert.equal(key in response.body.presets, false, `${key} is not a preset list`)
    }
    assert.ok(!body.includes('sk-should-never-export-xyz'), 'config api keys never reach the export')
    assert.ok(!body.includes('{{SECRET_5xu8d4za}}'), 'app secrets never reach the export')
    // First-read chmod risk: global files byte- and mode-identical after GETs.
    assert.equal(await fingerprint([settingsPath, secretsPath]), globalsBefore, 'GET must not touch global data-root files (mode/ctime/bytes)')
  })

  test('an unrecorded pointer or list key stays absent or null — never a fabricated default', async () => {
    const { slug, dir } = await makeProject('Preset Null Not Recorded')
    const configPath = path.join(dir, 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    delete config.thumbnail_generator_last_preset
    delete config.introduction_presets
    config.script_last_preset_script = 'keep-me'
    config.script_presets = [{ id: 'k1', name: 'Kept' }]
    config.research_last_preset = null
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    const response = await request(app).get(`/api/projects/${slug}/settings/preset-state`).expect(200)
    assert.equal('thumbnail_generator_last_preset' in response.body.pointers, false, 'never recorded → key absent, no default invented')
    assert.equal('introduction_presets' in response.body.presets, false, 'never recorded → key absent')
    assert.equal(response.body.pointers.research_last_preset, null, 'stored null round-trips as null')
    assert.equal(response.body.pointers.script_last_preset_script, 'keep-me')
    assert.deepEqual(response.body.presets.script_presets, [{ id: 'k1', name: 'Kept' }])
  })

  test('repeated GETs change no bytes, mtimes, ctimes, modes or entries anywhere in the data root', async () => {
    const { slug, dir } = await makeProject('Inventory Invariance')
    await pm.updateConfig(slug, {
      script_presets: [{ id: 'sp1', name: 'Plain Script' }],
      script_last_preset_script: 'sp1',
      llm_lineup_migration: { migrated_at: '2026-10-01T00:00:00.000Z', note: 'legacy record' },
    } as any)
    // Legacy, not-yet-migrated config markers that getSafeConfig-era reads
    // would rewrite in memory (models prunes, audio form sanitises, key
    // shadowing) — bytes must hold through every export GET.
    const configPath = path.join(dir, 'config.json')
    const legacy = JSON.parse(await fs.readFile(configPath, 'utf8'))
    legacy.models = { unified: { id: 'legacy-unified' } }
    legacy.audio_generator_presets = [{ id: 'a1', name: 'Legacy Audio', data: { form: { chunk: { max_chunk_chars: 100 } }, model: 'm' } }]
    legacy.genstudio_api_key = 'legacy-config-value'
    await fs.writeFile(configPath, JSON.stringify(legacy, null, 2))

    const paths = await makeEpisodeFolder(slug, 'EP0001', 'Quiet Harbor')
    await fs.writeFile(
      path.join(paths.episode_dir, 'thumbnail_options.json'),
      JSON.stringify({
        schema: 1,
        auto_approve: false,
        options: {
          '1': {
            thumbnail_template_id: 'tpl-a',
            style_tag: 'warm-woodcut',
            thumb_font_style: 'Noto Serif',
            thumb_text_style: 'outline',
            thumb_text_position: 'lower-third',
          },
        },
      }, null, 2),
    )
    await fs.writeFile(path.join(paths.subtitles_dir, '.selected_subtitle'), 'EP0001_stitched.srt\n')
    await writeAcceptedIdeas(slug, [
      { id: 'idea-1', title: 'Quiet Harbor', code: 'EP0001' },
      { id: 'idea-2', title: 'No Folder Yet', code: 'EP0002' },
      { id: 'idea-3', title: 'No Code', code: null },
    ])

    const before = await snapshot(tmp.dir)

    const rounds: any[] = []
    for (let round = 0; round < 2; round++) {
      const preset = await request(app).get(`/api/projects/${slug}/settings/preset-state`).expect(200)
      const lettering = await request(app).get(`/api/projects/${slug}/lettering-selections`).expect(200)
      const subtitles = await request(app).get(`/api/projects/${slug}/subtitle-selections`).expect(200)
      rounds.push({ preset: preset.body, lettering: lettering.body, subtitles: subtitles.body })

      assert.deepEqual(lettering.body.episodes.EP0001['1'], {
        thumb_font_style: 'Noto Serif',
        thumb_text_style: 'outline',
        thumb_text_position: 'lower-third',
      }, 'stored lettering scalars round-trip; art-style fields are not lettering state')
      assert.equal(lettering.body.episodes.EP0002, null, 'no sidecar → null, not empty defaults')
      assert.equal('EP0003' in lettering.body.episodes, false, 'accepted idea without a code is skipped')
      assert.equal(subtitles.body.episodes.EP0001, 'EP0001_stitched.srt')
      assert.equal(subtitles.body.episodes.EP0002, null, 'no sidecar → null')
      assert.equal(preset.body.pointers.script_last_preset_script, 'sp1')
      assert.equal(preset.body.presets.script_presets[0].id, 'sp1')
      assert.ok(!JSON.stringify(preset.body).includes('legacy-config-value'), 'legacy key material never leaves config.json')
    }
    assert.deepEqual(rounds[0], rounds[1], 'repeated GETs answer identically')

    // Unknown project: 404, and no project bytes involved.
    await request(app).get('/api/projects/no-such-project/settings/preset-state').expect(404)
    await request(app).get('/api/projects/no-such-project/lettering-selections').expect(404)
    await request(app).get('/api/projects/no-such-project/subtitle-selections').expect(404)

    const after = await snapshot(tmp.dir)
    assert.equal(after, before, 'GET routes must not create, rewrite, retime, rechmod or delete anything')
  })

  test('corrupt config.json fails loud (409) and its bytes are untouched', async () => {
    const { slug, dir } = await makeProject('Corrupt Config')
    const configPath = path.join(dir, 'config.json')
    await fs.writeFile(configPath, '{ "script_presets": [ broken')

    const response = await request(app).get(`/api/projects/${slug}/settings/preset-state`).expect(409)
    assert.match(response.body.detail, /config\.json is corrupted/)
    assert.equal(await fs.readFile(configPath, 'utf8'), '{ "script_presets": [ broken', 'a failed read never overwrites')
  })

  test('a preset list that is not a list is a loud 500 with a distinct detail', async () => {
    const { slug } = await makeProject('Corrupt Preset List')
    await pm.updateConfig(slug, { script_presets: 'not-a-list' } as any)

    const response = await request(app).get(`/api/projects/${slug}/settings/preset-state`).expect(500)
    assert.match(response.body.detail, /script_presets.*corrupt \(expected a list/)
  })

  test('a malformed lettering sidecar fails loud and the file is untouched', async () => {
    const { slug } = await makeProject('Corrupt Lettering')
    const paths = await makeEpisodeFolder(slug, 'EP0001', 'Broken Options')
    const optionsPath = path.join(paths.episode_dir, 'thumbnail_options.json')
    await fs.writeFile(optionsPath, '{ not json at all')
    await writeAcceptedIdeas(slug, [{ id: 'idea-1', title: 'Broken Options', code: 'EP0001' }])

    const response = await request(app).get(`/api/projects/${slug}/lettering-selections`).expect(500)
    assert.match(response.body.detail, /Internal server error/)
    assert.equal(await fs.readFile(optionsPath, 'utf8'), '{ not json at all', 'a failed read never rewrites the sidecar')

    // Error seam: an unreadable parent must stay loud. existsSync() reports
    // EACCES as "absent" and would export this episode as null.
    await fs.chmod(paths.episode_dir, 0o000)
    try {
      const denied = await request(app).get(`/api/projects/${slug}/lettering-selections`).expect(500)
      assert.equal(denied.body.detail, 'Internal server error', 'unreadable parent ≠ not recorded')
    } finally {
      await fs.chmod(paths.episode_dir, 0o755)
    }
  })

  test('an unreadable subtitle sidecar fails loud; empty stays null', async () => {
    const { slug } = await makeProject('Subtitle Sidecar States')
    const paths = await makeEpisodeFolder(slug, 'EP0001', 'Directory Pin')
    await writeAcceptedIdeas(slug, [
      { id: 'idea-1', title: 'Directory Pin', code: 'EP0001' },
      { id: 'idea-2', title: 'No Folder Here', code: 'EP0002' },
    ])

    // Error seam with no episode folder: resolution deterministically falls
    // back to <project>/<script>/subtitles (no scan to interfere), so chmod
    // there isolates the ENOENT-only read — existsSync() would call EACCES
    // "absent" and answer 200 null instead of failing loud.
    const { resolveSubtitlesDir } = await import('../generators/subtitles.js')
    const fallbackDir = await resolveSubtitlesDir(slug, 'EP0002')
    await fs.mkdir(fallbackDir, { recursive: true })
    await fs.writeFile(path.join(fallbackDir, '.selected_subtitle'), 'EP0002_stitched.srt')
    await fs.chmod(fallbackDir, 0o000)
    try {
      const denied = await request(app).get(`/api/projects/${slug}/subtitle-selections`).expect(500)
      assert.equal(denied.body.detail, 'Internal server error', 'unreadable parent ≠ not recorded')
    } finally {
      await fs.chmod(fallbackDir, 0o755)
    }

    // A directory where EP0001's sidecar should be: exists, but cannot be read.
    await fs.mkdir(path.join(paths.subtitles_dir, '.selected_subtitle'))

    const response = await request(app).get(`/api/projects/${slug}/subtitle-selections`).expect(500)
    assert.equal(response.body.detail, 'Internal server error', 'unreadable ≠ not recorded')

    // Same project, sidecar replaced with an empty file → never recorded, 200 null.
    await fs.rmdir(path.join(paths.subtitles_dir, '.selected_subtitle'))
    await fs.writeFile(path.join(paths.subtitles_dir, '.selected_subtitle'), '   \n')
    const empty = await request(app).get(`/api/projects/${slug}/subtitle-selections`).expect(200)
    assert.equal(empty.body.episodes.EP0001, null, 'an empty pin means never recorded')
  })

  test('a real pin written after a null read is served on the next GET', async () => {
    const { slug } = await makeProject('Subtitle Pin Later')
    const paths = await makeEpisodeFolder(slug, 'EP0001', 'Pinned Later')
    await writeAcceptedIdeas(slug, [{ id: 'idea-1', title: 'Pinned Later', code: 'EP0001' }])

    const before = await request(app).get(`/api/projects/${slug}/subtitle-selections`).expect(200)
    assert.equal(before.body.episodes.EP0001, null)

    // A write from elsewhere (the real pin flow) is picked up — reads are live, not cached into defaults.
    await fs.writeFile(path.join(paths.subtitles_dir, '.selected_subtitle'), 'EP0001_whisper.srt')
    const after = await request(app).get(`/api/projects/${slug}/subtitle-selections`).expect(200)
    assert.equal(after.body.episodes.EP0001, 'EP0001_whisper.srt')
  })
})
