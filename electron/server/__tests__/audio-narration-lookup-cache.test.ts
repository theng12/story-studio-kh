/**
 * `findNarrationFile` is reached both from list routes that already have a
 * request snapshot and from single audio routes that do not.  The latter must
 * still resolve a canonical episode without walking every other episode.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

const slug = 'narration-lookup-cache'
const code = 'EP0042'
const title = 'The Answer'
const scriptFolder = `${code} - 01 Script`

function canonicalEpisode(tempDir: string): string {
  return path.join(tempDir, 'projects', slug, 'episodes', 'Season 003', `${code} - ${title}`)
}

async function seedProject(tempDir: string, episodeDir = canonicalEpisode(tempDir)): Promise<void> {
  const projectDir = path.join(tempDir, 'projects', slug)
  await fs.mkdir(projectDir, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug,
      name: 'Narration lookup cache',
      episode_prefix: 'EP',
      season_size: 20,
      season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: { script: '{code} - 01 Script' },
    })),
    fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{ id: 'idea-42', episode_code: code, title, status: 'accepted' }],
      next_episode_number: 43,
      recycled_numbers: [],
    })),
  ])
  await fs.mkdir(path.join(episodeDir, scriptFolder), { recursive: true })
}

async function seedUnrelatedEpisodes(tempDir: string): Promise<void> {
  const root = path.join(tempDir, 'projects', slug, 'episodes')
  await Promise.all(Array.from({ length: 12 }, (_unused, index) =>
    fs.mkdir(path.join(root, `archive-${String(index).padStart(2, '0')}`, 'nested'), { recursive: true })))
}

test('canonical markdown narration wins without scanning unrelated episode folders', async (t) => {
  const temp = await useTempDataDir()
  try {
    await seedProject(temp.dir)
    await seedUnrelatedEpisodes(temp.dir)
    const scriptDir = path.join(canonicalEpisode(temp.dir), scriptFolder)
    const markdown = path.join(scriptDir, `${code}_Script_Narration.md`)
    await Promise.all([
      fs.writeFile(markdown, '# Narration'),
      fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.docx`), 'legacy'),
    ])

    const read = fs.readdir.bind(fs)
    let scans = 0
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      scans += 1
      return read(...args)
    })
    const { findNarrationFile } = await import('../generators/audio.js')

    assert.equal(await findNarrationFile(slug, code), markdown)
    assert.equal(scans, 0, 'a canonical narration needs stats only, never an episode-tree walk')
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('a canonical missing narration reports missing without scanning unrelated episode folders', async (t) => {
  const temp = await useTempDataDir()
  try {
    await seedProject(temp.dir)
    await seedUnrelatedEpisodes(temp.dir)
    const read = fs.readdir.bind(fs)
    let scans = 0
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      scans += 1
      return read(...args)
    })
    const { findNarrationFile, NarrationMissingError } = await import('../generators/audio.js')

    await assert.rejects(
      () => findNarrationFile(slug, code),
      (error: unknown) => error instanceof NarrationMissingError
        && error.episode_id === code
        && error.filename === `${code}_Script_Narration.md`,
    )
    assert.equal(scans, 2, 'a missing canonical narration may scan its own episode, never the whole project')
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('a legacy root script stays discoverable when its canonical episode directory exists', async (t) => {
  const temp = await useTempDataDir()
  try {
    await seedProject(temp.dir)
    const legacyScriptDir = path.join(temp.dir, 'projects', slug, 'episodes', `${code} - Script`)
    const legacy = path.join(legacyScriptDir, `${code}_Script_Narration.md`)
    await fs.mkdir(legacyScriptDir, { recursive: true })
    await fs.writeFile(legacy, '# Legacy narration')

    const read = fs.readdir.bind(fs)
    let scans = 0
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      scans += 1
      return read(...args)
    })
    const { findNarrationFile } = await import('../generators/audio.js')

    assert.equal(await findNarrationFile(slug, code), legacy)
    assert.equal(scans, 2, 'only the canonical episode may be checked before the direct legacy fallback')
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('a renamed episode still finds its legacy docx through the fallback walk', async (t) => {
  const temp = await useTempDataDir()
  try {
    const renamed = path.join(temp.dir, 'projects', slug, 'episodes', 'Season 003', `${code} - Renamed Outside App`)
    await seedProject(temp.dir, renamed)
    const legacy = path.join(renamed, scriptFolder, `${code}_Script_Narration.docx`)
    await fs.writeFile(legacy, 'legacy narration')

    const read = fs.readdir.bind(fs)
    let scans = 0
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      scans += 1
      return read(...args)
    })
    const { findNarrationFile } = await import('../generators/audio.js')

    assert.equal(await findNarrationFile(slug, code), legacy)
    assert.ok(scans > 0, 'only a renamed episode falls back to the recovery walk')
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})
