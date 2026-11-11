import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

/**
 * Thumbnail option metadata sidecar — storage + API.
 *
 * Covers: roundtrip, edit-one-preserves-siblings, approval invalidation by
 * prompt hash, the request trust boundary (no foreign episode / no prompt
 * alteration), and a legacy episode that reads empty and is never written.
 */

let cleanup: () => Promise<void>
let app: express.Express
let slug: string
let episodeDir: string
let promptsPath: string
let legacyCode: string
let legacyDir: string
const code = 'EP0001'
const optionsEndpoint = (episode: string) => `/api/projects/${slug}/episodes/${episode}/image-prompts/options`

const PROMPT_1 = 'A cheerful storybook hero stands in a sunlit meadow, warm rim light, cinematic depth. Storybook style.'
const PROMPT_2 = 'A quiet lantern glows on a wooden dock at dusk, soft haze, calm water. Storybook style.'

function promptsFile(prompt1: string): string {
  return `# Thumbnail Prompts\n\n## Thumbnail 1: First idea\n\n${prompt1}\n\n## Thumbnail 2: Second idea\n\n${PROMPT_2}\n`
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Thumbnail option settings' })
  slug = project.slug
  // These cases pin the PER-EPISODE gate exactly as it was. The channel's
  // reusable default is ON unless set, so turn it off here; the inheritance
  // cases below turn it back on for their own fresh project.
  await pm.updateConfig(slug, { auto_approve_thumbnail_prompts: false } as any)
  const paths = await resolveEpisodePaths(slug, code, '')
  episodeDir = paths.episode_dir
  promptsPath = paths.thumb_prompts_docx
  await fs.mkdir(path.dirname(promptsPath), { recursive: true })
  await fs.writeFile(promptsPath, promptsFile(PROMPT_1), 'utf8')
  legacyCode = 'EP0002'
  legacyDir = (await resolveEpisodePaths(slug, legacyCode, '')).episode_dir
  await fs.mkdir(legacyDir, { recursive: true })
  const { router } = await import('../routes/image-prompts-edit.js')
  app = express().use(express.json()).use('/api', router)
})
after(async () => { await cleanup?.() })

const sidecarFile = () => path.join(episodeDir, 'thumbnail_options.json')
const readDisk = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'))

test('roundtrip: one option writes its selections and reads them back, approval required by default', async () => {
  const beforeGet = await request(app).get(optionsEndpoint(code))
  assert.equal(beforeGet.status, 200)
  assert.deepEqual(beforeGet.body, { schema: 1, auto_approve: false, auto_approve_inherited: true, options: {} })
  await assert.rejects(fs.access(sidecarFile()), 'a read must not create the sidecar')

  const put = await request(app).put(optionsEndpoint(code)).send({
    number: 1,
    thumbnail_template_id: 'tmpl-glow',
    style_tag: 'storybook',
    thumb_font_style: 'display',
    thumb_text_style: 'bold',
    thumb_text_position: 'bottom',
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.options[1].approved, false, 'a new prompt needs approval; autoapproval is off')

  const get = await request(app).get(optionsEndpoint(code))
  assert.equal(get.status, 200)
  assert.equal(get.body.auto_approve, false)
  assert.deepEqual(get.body.options[1], {
    thumbnail_template_id: 'tmpl-glow',
    style_tag: 'storybook',
    thumb_font_style: 'display',
    thumb_text_style: 'bold',
    thumb_text_position: 'bottom',
    approved: false,
  })
  const disk = await readDisk(sidecarFile())
  assert.equal(disk.schema, 1)
  assert.equal(disk.auto_approve, undefined, 'no per-episode choice is written; the channel default applies')
  assert.equal(typeof disk.options['1'].thumbnail_template_id, 'string')
  assert.equal(disk.options['1'].approved_prompt_sha256, undefined, 'approval is only stored on approve')
})

test('editing one option preserves every sibling option', async () => {
  const put = await request(app).put(optionsEndpoint(code)).send({ number: 2, thumb_font_style: 'serif' })
  assert.equal(put.status, 200)

  const get = await request(app).get(optionsEndpoint(code))
  assert.equal(get.status, 200)
  assert.equal(get.body.options[2].thumb_font_style, 'serif')
  assert.deepEqual(get.body.options[1], {
    thumbnail_template_id: 'tmpl-glow',
    style_tag: 'storybook',
    thumb_font_style: 'display',
    thumb_text_style: 'bold',
    thumb_text_position: 'bottom',
    approved: false,
  }, 'option 1 must be untouched by option 2\'s edit')
  // A partial update also keeps the rest of ITS OWN option.
  assert.equal(get.body.options[2].thumbnail_template_id, undefined)
})

test('approval is pinned to the prompt hash and a prompt edit invalidates it', async () => {
  const approve = await request(app).put(optionsEndpoint(code)).send({ number: 1, approve: true })
  assert.equal(approve.status, 200)
  assert.equal(approve.body.options[1].approved, true)
  const disk = await readDisk(sidecarFile())
  assert.match(disk.options['1'].approved_prompt_sha256, /^[0-9a-f]{64}$/)

  // The prompt text changes on disk (what the Image Prompts page's edit does).
  await fs.writeFile(promptsPath, promptsFile('A brand-new composition for the hero, different light. Storybook style.'), 'utf8')
  const afterEdit = await request(app).get(optionsEndpoint(code))
  assert.equal(afterEdit.status, 200)
  assert.equal(afterEdit.body.options[1].approved, false, 'the stored approval hash no longer matches the current prompt')

  // Withdrawing approval is explicit and also preserves siblings.
  const withdraw = await request(app).put(optionsEndpoint(code)).send({ number: 1, approve: false })
  assert.equal(withdraw.status, 200)
  assert.equal(withdraw.body.options[1].approved, false)
  assert.equal((await readDisk(sidecarFile())).options['1'].approved_prompt_sha256, undefined)
  assert.equal((await request(app).get(optionsEndpoint(code))).body.options[2].thumb_font_style, 'serif')
})

test('trust boundary: bad numbers are refused and foreign/extra fields cannot ride along', async () => {
  const bad = await request(app).put(optionsEndpoint(code)).send({ number: 0, style_tag: 'x' })
  assert.equal(bad.status, 400)

  const missing = await request(app).put(optionsEndpoint(code)).send({ number: 42, style_tag: 'x' })
  assert.equal(missing.status, 404, 'a number with no prompt in THIS episode cannot be an option')

  const promptBefore = await fs.readFile(promptsPath, 'utf8')
  const sneaky = await request(app).put(optionsEndpoint(code)).send({
    number: 2,
    style_tag: 'changed',
    prompt: 'attacker text',
    episode_id: legacyCode,
    slug: 'some-other-project',
    approved_prompt_sha256: 'f'.repeat(64),
  })
  assert.equal(sneaky.status, 200)
  assert.equal(sneaky.body.options[2].style_tag, 'changed')
  assert.equal(sneaky.body.options[2].prompt, undefined, 'prompt text is never part of option metadata')
  assert.equal(sneaky.body.options[2].approved, false, 'the approval hash cannot be set from the request')
  assert.equal(await fs.readFile(promptsPath, 'utf8'), promptBefore, 'the prompts Markdown must be byte-identical')
  await assert.rejects(
    fs.access(path.join(legacyDir, 'thumbnail_options.json')),
    'metadata for one episode must never create a file in another episode',
  )
})

test('simultaneous option updates preserve both edits', async () => {
  const responses = await Promise.all([
    request(app).put(optionsEndpoint(code)).send({ number: 1, style_tag: 'concurrent-style' }),
    request(app).put(optionsEndpoint(code)).send({ number: 2, thumb_font_style: 'concurrent-font' }),
  ])
  for (const response of responses) assert.equal(response.status, 200)
  const disk = await readDisk(sidecarFile())
  assert.equal(disk.options['1'].style_tag, 'concurrent-style')
  assert.equal(disk.options['2'].thumb_font_style, 'concurrent-font')
})

test('malformed stored option fields are reported rather than silently reset', async () => {
  const original = await fs.readFile(sidecarFile(), 'utf8')
  try {
    await fs.writeFile(sidecarFile(), JSON.stringify({ schema: 1, auto_approve: false, options: { 1: { approved_prompt_sha256: true } } }))
    const get = await request(app).get(optionsEndpoint(code))
    assert.equal(get.status, 500)
    assert.match(get.body.detail, /malformed/)
    assert.equal((await request(app).put(optionsEndpoint(code)).send({ number: 1, approve: true })).status, 500)
  } finally {
    await fs.writeFile(sidecarFile(), original)
  }
})

test('render approval checks current prompts and preserves legacy behavior', async () => {
  const { assertThumbnailOptionsApproved, thumbnailOptionApproved, emptyThumbnailOptionSettings } = await import('../services/thumbnail-option-settings.js')
  const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
  const prompts = (await parseImagePromptsDocx(promptsPath)).thumbnails
  await assert.rejects(assertThumbnailOptionsApproved(slug, code, prompts), /Approve thumbnail prompt/)
  assert.equal((await request(app).put(optionsEndpoint(code)).send({ number: 1, approve: true })).status, 200)
  await assertThumbnailOptionsApproved(slug, code, [prompts[0]!])
  await assert.rejects(assertThumbnailOptionsApproved(slug, code, [prompts[1]!]), /2/)
  assert.equal((await request(app).put(optionsEndpoint(code)).send({ number: 1, auto_approve: true })).status, 200)
  await assertThumbnailOptionsApproved(slug, code, prompts)
  assert.equal(thumbnailOptionApproved({ ...emptyThumbnailOptionSettings(), auto_approve: true }, 1, null), false)
  await request(app).put(optionsEndpoint(code)).send({ number: 1, auto_approve: false })
  // An episode with no saved choice inherits the channel default. It is OFF
  // here, so the gate applies to the legacy episode too.
  await assert.rejects(
    assertThumbnailOptionsApproved(slug, legacyCode, [{ number: 1, prompt: PROMPT_1 }]),
    /Approve thumbnail prompt/,
  )
})

test('duplication is independent, unapproved and idempotent', async () => {
  const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
  const source = (await parseImagePromptsDocx(promptsPath)).thumbnails[0]!
  const body = { number: source.number, operation_id: randomUUID() }
  const endpoint = optionsEndpoint(code) + '/duplicate'
  const first = await request(app).post(endpoint).send(body)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.number, 3)
  const replay = await request(app).post(endpoint).send(body)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.number, 3)
  assert.equal((await parseImagePromptsDocx(promptsPath)).thumbnails.length, 3)
  const settings = await readDisk(sidecarFile())
  assert.equal(settings.options['3'].duplicate_of, 1)
  assert.equal(settings.options['3'].style_tag, settings.options['1'].style_tag)
  assert.equal(settings.options['3'].approved_prompt_sha256, undefined)
  const edited = await request(app).put(`/api/projects/${slug}/episodes/${code}/image-prompts/item`).send({
    kind: 'thumbnail', number: 3, title: 'Independent copy', prompt: 'A different image for only the duplicated option.',
  })
  assert.equal(edited.status, 200)
  assert.deepEqual((await parseImagePromptsDocx(promptsPath)).thumbnails[0], source)
})

test('legacy episode: reads empty defaults and never gets written', async () => {
  const get = await request(app).get(optionsEndpoint(legacyCode))
  assert.equal(get.status, 200)
  assert.deepEqual(get.body, { schema: 1, auto_approve: false, auto_approve_inherited: true, options: {} })

  const put = await request(app).put(optionsEndpoint(legacyCode)).send({ number: 1, style_tag: 'x' })
  assert.equal(put.status, 404, 'no prompts file means there is no option to write')
  await assert.rejects(
    fs.access(path.join(legacyDir, 'thumbnail_options.json')),
    'a legacy read/write attempt must not create a sidecar',
  )
})

test('regression: approved style longer than 1000 characters roundtrips through initializeThumbnailOptions and API with exact bytes preserved', async () => {
  const { initializeThumbnailOptions, readThumbnailOptionSettings } = await import('../services/thumbnail-option-settings.js')
  const {
    THUMBNAIL_OPTION_STYLE_TAG_MAX,
    ThumbnailOptionStoredSchema,
    ThumbnailOptionUpdateSchema,
  } = await import('../contracts/thumbnail-options.js')

  assert.equal(THUMBNAIL_OPTION_STYLE_TAG_MAX, 12_000, 'style_tag cap must match the authoritative 12,000 character style limit')

  // A 2,751-character style bible (matches the production defect MANU2-NATIVE-20261025T115324Z-092ce216 / MineePod EP20 incident).
  const longStyle = 'Warm painterly illustration with rich textures, gentle rim lighting, and atmospheric depth. '.repeat(30)
    + 'Extra unique detail signature: ' + 'x'.repeat(150)
  assert.ok(longStyle.length > 1000, `test requires >1000 characters, got ${longStyle.length}`)

  // 1. Direct schema verification
  const parsedStored = ThumbnailOptionStoredSchema.safeParse({ style_tag: longStyle })
  assert.equal(parsedStored.success, true, 'stored schema must accept >1000 character style')
  if (parsedStored.success) {
    assert.equal(parsedStored.data.style_tag, longStyle, 'exact bytes must be preserved without truncation')
  }

  const parsedUpdate = ThumbnailOptionUpdateSchema.safeParse({ number: 1, style_tag: longStyle })
  assert.equal(parsedUpdate.success, true, 'update schema must accept >1000 character style')
  if (parsedUpdate.success) {
    assert.equal(parsedUpdate.data.style_tag, longStyle, 'exact bytes must be preserved without truncation')
  }

  // 2. Ceiling verification at the 12,000 character boundary
  const atCeiling = 'a'.repeat(THUMBNAIL_OPTION_STYLE_TAG_MAX)
  assert.equal(ThumbnailOptionStoredSchema.safeParse({ style_tag: atCeiling }).success, true)
  assert.equal(ThumbnailOptionUpdateSchema.safeParse({ number: 1, style_tag: atCeiling }).success, true)

  const overCeiling = 'a'.repeat(THUMBNAIL_OPTION_STYLE_TAG_MAX + 1)
  assert.equal(ThumbnailOptionStoredSchema.safeParse({ style_tag: overCeiling }).success, false)
  assert.equal(ThumbnailOptionUpdateSchema.safeParse({ number: 1, style_tag: overCeiling }).success, false)

  // New generation starts without sidecar selections; existing user choices must survive initialization.
  const regressionCode = 'EP0003'
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const regressionPaths = await resolveEpisodePaths(slug, regressionCode, '')
  await fs.mkdir(path.dirname(regressionPaths.thumb_prompts_docx), { recursive: true })
  await fs.writeFile(regressionPaths.thumb_prompts_docx, promptsFile(PROMPT_1), 'utf8')
  await initializeThumbnailOptions(slug, regressionCode, [1, 2], { style_tag: longStyle })
  const settings = await readThumbnailOptionSettings(slug, regressionCode)
  assert.equal(settings.options['1']?.style_tag, longStyle, 'option 1 must preserve exact style bytes')
  assert.equal(settings.options['2']?.style_tag, longStyle, 'option 2 must preserve exact style bytes')

  // 4. API update verification: PUT preserves exact bytes and GET returns them
  const put = await request(app).put(optionsEndpoint(regressionCode)).send({ number: 1, style_tag: longStyle })
  assert.equal(put.status, 200)
  assert.equal(put.body.options[1].style_tag, longStyle)

  const get = await request(app).get(optionsEndpoint(regressionCode))
  assert.equal(get.status, 200)
  assert.equal(get.body.options[1].style_tag, longStyle, 'GET must return exact style bytes')
  assert.equal(get.body.options[1].style_tag.length, longStyle.length)
})

describe('reusable Auto-approve thumbnail prompts (owner-approved 2026-11-08)', () => {
  test('a new episode inherits the channel default, which is ON', async () => {
    const { assertThumbnailOptionsApproved } = await import('../services/thumbnail-option-settings.js')
    const pm = await import('../services/project-manager.js')
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const fresh = await pm.createProject({ name: 'Thumbnail auto approve default' })
    const code = 'EP0100'
    const paths = await resolveEpisodePaths(fresh.slug, code, '')
    await fs.mkdir(paths.episode_dir, { recursive: true })

    // No config key, no sidecar: the product default is ON.
    await assertThumbnailOptionsApproved(fresh.slug, code, [{ number: 1, prompt: 'anything' }])

    await pm.updateConfig(fresh.slug, { auto_approve_thumbnail_prompts: false } as any)
    await assert.rejects(
      assertThumbnailOptionsApproved(fresh.slug, code, [{ number: 1, prompt: 'anything' }]),
      /Approve thumbnail prompt/,
      'with the channel switch OFF a new episode needs approval',
    )

    // An explicit per-episode choice wins over the channel default, both ways.
    await fs.writeFile(
      path.join(paths.episode_dir, 'thumbnail_options.json'),
      JSON.stringify({ schema: 1, auto_approve: true, options: {} }),
      'utf8',
    )
    await assertThumbnailOptionsApproved(fresh.slug, code, [{ number: 1, prompt: 'anything' }])

    await pm.updateConfig(fresh.slug, { auto_approve_thumbnail_prompts: true } as any)
    await fs.writeFile(
      path.join(paths.episode_dir, 'thumbnail_options.json'),
      JSON.stringify({ schema: 1, auto_approve: false, options: {} }),
      'utf8',
    )
    await assert.rejects(
      assertThumbnailOptionsApproved(fresh.slug, code, [{ number: 1, prompt: 'anything' }]),
      /Approve thumbnail prompt/,
      'an explicit episode OFF wins over a channel default that is ON',
    )
  })

  test('an edited prompt still requires approval when the gate is on', async () => {
    const { assertThumbnailOptionsApproved } = await import('../services/thumbnail-option-settings.js')
    const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
    const put = await request(app).put(optionsEndpoint(code)).send({ number: 1, auto_approve: false })
    assert.equal(put.status, 200)
    assert.equal(put.body.auto_approve, false)
    assert.equal(put.body.auto_approve_inherited, false, 'an explicit choice is not reported as inherited')

    await fs.writeFile(promptsPath, promptsFile(PROMPT_1), 'utf8')
    assert.equal((await request(app).put(optionsEndpoint(code)).send({ number: 1, approve: true })).status, 200)
    const approved = (await parseImagePromptsDocx(promptsPath)).thumbnails
    await assertThumbnailOptionsApproved(slug, code, [approved[0]!])

    await fs.writeFile(promptsPath, promptsFile('An edited prompt after approval. Storybook style.'), 'utf8')
    const edited = (await parseImagePromptsDocx(promptsPath)).thumbnails
    await assert.rejects(
      assertThumbnailOptionsApproved(slug, code, [edited[0]!]),
      /Approve thumbnail prompt/,
      'the SHA-256 no longer matches the edited prompt',
    )
  })
})
