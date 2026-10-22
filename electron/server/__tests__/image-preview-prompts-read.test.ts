/**
 * Reading an episode's image prompts must find THAT episode's prompts.
 *
 * An episode's folder is named `{code} - {title}`, so a read that carries no
 * title used to resolve to `.../EP0001 - /` — a folder that does not exist.
 * The prompt docs live in the episode's real folder, so the read found
 * nothing and answered "no image prompts yet" over prompts that were there
 * all along. The Images page asks by CODE alone, so that was the ordinary
 * request, not an edge case.
 *
 * The rule these cases pin down:
 *
 *   - The episode's OWN folder is found, with or without a title.
 *   - A title that IS correct is still honoured (nothing else consulted).
 *   - A legacy episode whose prompts are still `.docx` still answers.
 *   - An episode with no prompts, and an episode that is not on disk at all,
 *     answer "not generated yet" — the two are the same 404 the frontend
 *     already understands, and neither invents prompts.
 *   - More than one folder carrying the code is REFUSED, not guessed: reading
 *     the wrong folder would show one episode's prompts under another's name.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
})

after(async () => { await cleanup() })

const SCENE_PROMPTS_MD = `# Scene Prompts

## Scene 1: The Forest
A wide shot of a forest at dawn.
`

const THUMB_PROMPTS_MD = `# Thumbnail Prompts

## Thumbnail 1: Golden Hour
A warm thumbnail of the forest.
`

/** A legacy episode: the same prompts, still in Word files. */
function docxParagraphs(paragraphs: Array<{ text: string; heading?: 1 | 2 }>): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs.map(({ text, heading }) => {
    const run = `<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`
    const pPr = heading ? `<w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr>` : ''
    return `<w:p>${pPr}${run}</w:p>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
}

async function buildDocx(paragraphs: Array<{ text: string; heading?: 1 | 2 }>): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.folder('word')!.file('document.xml', docxParagraphs(paragraphs))
  return zip.generateAsync({ type: 'nodebuffer' })
}

interface SeededEpisode {
  slug: string
  code: string
  title: string
  paths: any
}

/** A channel with one accepted episode, and the paths of its folder. */
async function seedEpisode(projectName: string, ideaTitle: string): Promise<SeededEpisode> {
  const project = await pm.createProject({ name: projectName })
  const slug = project.slug
  const im = await import('../services/idea-manager.js')
  const [idea] = await im.addIdeas(slug, [{
    title: ideaTitle, logline: '', themes: [], suggested_chapters: 1,
    suggested_length: '5 min', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(slug, idea!.id)
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const title = String(accepted.idea?.title || ideaTitle)
  const paths = await resolveEpisodePaths(slug, accepted.episode_code, title)
  // The fixture is only honest if the folder the resolver names is the folder
  // that was actually created — a title that did not survive sanitising would
  // otherwise write the prompts somewhere the read never looks.
  const stat = await fs.stat(paths.episode_dir).catch(() => null)
  assert.ok(stat?.isDirectory(), `the episode folder must exist for this fixture: ${paths.episode_dir}`)
  return { slug, code: accepted.episode_code, title, paths }
}

/** Write the episode's prompt files, in Markdown (the current format). */
async function writeMarkdownPrompts(paths: any, code: string): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, `${code}_Scene_Prompts.md`), SCENE_PROMPTS_MD)
  await fs.mkdir(paths.thumb_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_prompts_dir, `${code}_Thumbnail_Prompts.md`), THUMB_PROMPTS_MD)
}

/** Write the episode's prompt files as legacy `.docx` siblings. */
async function writeLegacyDocxPrompts(paths: any, code: string): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(
    path.join(paths.scene_prompts_dir, `${code}_Scene_Prompts.docx`),
    await buildDocx([
      { text: 'Scene Prompts', heading: 1 },
      { text: 'Scene 1: The Forest', heading: 2 },
      { text: 'A wide shot of a forest at dawn.' },
    ]),
  )
  await fs.mkdir(paths.thumb_prompts_dir, { recursive: true })
  await fs.writeFile(
    path.join(paths.thumb_prompts_dir, `${code}_Thumbnail_Prompts.docx`),
    await buildDocx([
      { text: 'Thumbnail Prompts', heading: 1 },
      { text: 'Thumbnail 1: Golden Hour', heading: 2 },
      { text: 'A warm thumbnail of the forest.' },
    ]),
  )
}

/** The prompts of the episode under `code`, whatever its title says. */
async function readPrompts(slug: string, code: string, title?: string) {
  const query = title ? `?title=${encodeURIComponent(title)}` : ''
  return request(app).get(`/api/projects/${slug}/episodes/${code}/image-prompts${query}`)
}

describe('reading an episode\'s image prompts', () => {
  test('a read with no title finds the episode\'s prompts', async () => {
    const { slug, code, paths } = await seedEpisode('Titleless Prompt Read', 'The Forest Episode')
    await writeMarkdownPrompts(paths, code)

    const res = await readPrompts(slug, code)

    assert.equal(res.status, 200, `expected the prompts; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.scenes?.length, 1, 'the scene prompts are the episode\'s own')
    assert.equal(res.body.scenes[0].title, 'The Forest')
    assert.equal(res.body.thumbnails?.length, 1, 'the thumbnail prompts are the episode\'s own')
    assert.equal(res.body.thumbnails[0].title, 'Golden Hour')
  })

  test('a correct title is still honoured', async () => {
    const { slug, code, title, paths } = await seedEpisode('Titled Prompt Read', 'The Forest Episode')
    await writeMarkdownPrompts(paths, code)

    const res = await readPrompts(slug, code, title)

    assert.equal(res.status, 200, `expected the prompts; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.scenes?.[0]?.title, 'The Forest')
    assert.equal(res.body.thumbnails?.[0]?.title, 'Golden Hour')
  })

  test('a legacy episode whose prompts are still .docx still answers', async () => {
    const { slug, code, paths } = await seedEpisode('Legacy Docx Prompt Read', 'The Forest Episode')
    await writeLegacyDocxPrompts(paths, code)

    const res = await readPrompts(slug, code)

    assert.equal(res.status, 200, `expected the prompts; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.scenes?.[0]?.title, 'The Forest')
    assert.equal(res.body.thumbnails?.[0]?.title, 'Golden Hour')
  })

  test('an episode renamed on disk is still found', async () => {
    const { slug, code, paths } = await seedEpisode('Renamed Episode Read', 'The Forest Episode')
    await writeMarkdownPrompts(paths, code)

    // The folder was renamed on disk, so neither the (absent) request title
    // nor the title the idea index holds names it any more.
    const renamed = path.join(path.dirname(paths.episode_dir), `${code} - Renamed On Disk`)
    await fs.rename(paths.episode_dir, renamed)

    const res = await readPrompts(slug, code)

    assert.equal(res.status, 200, `expected the prompts; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.scenes?.[0]?.title, 'The Forest')
    assert.equal(res.body.thumbnails?.[0]?.title, 'Golden Hour')
  })

  test('an episode with no prompts answers "not generated yet"', async () => {
    const { slug, code } = await seedEpisode('No Prompts Read', 'The Forest Episode')

    const res = await readPrompts(slug, code)

    assert.equal(res.status, 404, `expected the not-generated answer; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.match(String(res.body?.detail || ''), /No image prompts found/i)
  })

  test('an episode that is not on disk answers "not generated yet", and never another episode\'s prompts', async () => {
    const { slug, code, paths } = await seedEpisode('Foreign Episode Read', 'The Forest Episode')
    await writeMarkdownPrompts(paths, code)

    const res = await readPrompts(slug, 'EP9999')

    assert.equal(res.status, 404, `expected the not-generated answer; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body?.scenes, undefined, 'no episode\'s prompts may be shown under another episode')
    assert.equal(res.body?.thumbnails, undefined)
  })

  test('two folders for one code are refused, not guessed between', async () => {
    const { slug, code, paths } = await seedEpisode('Ambiguous Folder Read', 'The Forest Episode')
    await writeMarkdownPrompts(paths, code)

    // A rename that left the old folder behind: two folders carry the code,
    // and neither is the one the idea index names.
    const seasonDir = path.dirname(paths.episode_dir)
    await fs.rename(paths.episode_dir, path.join(seasonDir, `${code} - Old Title`))
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const other = await resolveEpisodePaths(slug, code, 'Other Title')
    await fs.mkdir(other.thumb_prompts_dir, { recursive: true })
    await fs.writeFile(
      path.join(other.thumb_prompts_dir, `${code}_Thumbnail_Prompts.md`),
      '# Thumbnail Prompts\n\n## Thumbnail 1: Foreign Frame\nA prompt from another folder.\n',
    )

    const res = await readPrompts(slug, code)

    assert.equal(res.status, 409, `expected a refusal; got ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body?.code, 'EPISODE_FOLDER_AMBIGUOUS')
    assert.match(String(res.body?.detail || ''), /Old Title/)
    assert.match(String(res.body?.detail || ''), /Other Title/)
    assert.equal(res.body?.thumbnails, undefined, 'neither folder\'s prompts may be shown as this episode\'s')
  })
})
