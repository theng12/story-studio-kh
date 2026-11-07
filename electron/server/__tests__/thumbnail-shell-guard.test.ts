/**
 * Thumbnail Shell selection guard — the exact behaviours the 1.4.384 Shell work must keep.
 *
 * Item 4 is an AUDIT, not a rewrite: the Shell flow is shipped and the owner's rule is "keep the
 * current selection behavior". This file pins the guard itself so a later refactor of
 * `resolveThumbnailShell` cannot quietly move it. It deliberately covers the four precedence and
 * guard cases the shipped `thumbnail-shell-runtime.test.ts` does NOT — the *precedence* of the
 * request's explicit no-Shell value over the config, and the malformed/oversized inputs that must
 * refuse rather than silently degrade:
 *
 *   1. A deliberate no-Shell (`thumbnail_shell_id: ''`) beats a stored channel reference and a
 *      stored template — it is the customer's own choice and nothing revives the legacy reference.
 *   2. The request's own reference beats the config's when both name one (request wins).
 *   3. A Shell id carrying characters a project slug can never contain is refused (not treated as
 *      a channel Shell, not silently blanked).
 *   4. A text-only Shell keeps its layout note even with no image — the guidance is not dropped.
 *
 * Nothing here rewrites stored data: every case reads a config object in memory, and the config is
 * asserted byte-identical after the call (AGENTS §5 — the selection is read, never rewritten).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { channelReferenceShellId, resolveThumbnailShell } from '../services/thumbnail-shell.js'

let cleanup: () => Promise<void>
let slug: string
let projectDir: string
const templateId = 'guard-text-shell'
const layoutNote = 'Subject left of centre; keep the right third clear for the headline.'
const reference = { id: 'guard-reference', filename: 'guard-reference.png', reframing_prompt: 'A wide room with empty wall space.' }

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Shell guard fixtures' })
  slug = project.slug
  projectDir = pm.getProjectDir(slug)!
  const templates = path.join(pm.projectsRoot(), '.thumbnail-templates')
  await fs.mkdir(templates, { recursive: true })
  await fs.writeFile(path.join(templates, `${templateId}.json`), JSON.stringify({
    id: templateId, name: 'Guard Text Shell', description: 'Layout only', builtin: false,
    schemaVersion: 1, layoutNote,
  }))
  await fs.mkdir(path.join(projectDir, 'thumbnail-reference-assets'), { recursive: true })
  await fs.writeFile(path.join(projectDir, 'thumbnail-reference-assets', reference.filename), 'guard fixture bytes')
})
after(async () => { await cleanup() })

test('a deliberate no-Shell beats a stored channel reference and a stored template', async () => {
  const config = { thumbnail_template_id: templateId, thumbnail_reference_asset: reference }
  const before = JSON.stringify(config)
  const shell = await resolveThumbnailShell(slug, { thumbnail_shell_id: '' }, config)
  assert.equal(shell.id, '')
  assert.equal(shell.imagePath, null)
  assert.equal(shell.layoutNote, '')
  assert.equal(shell.template, null)
  assert.equal(JSON.stringify(config), before, 'a read never rewrites the stored selection')
})

test('the request’s own shell id beats the config’s stored shell id', async () => {
  const shell = await resolveThumbnailShell(
    slug,
    { thumbnail_shell_id: templateId },
    { thumbnail_shell_id: 'stored-other-shell', thumbnail_template_id: templateId },
  )
  assert.equal(shell.id, templateId)
  assert.equal(shell.template?.id, templateId)
})

test('a request shell id a slug can never contain is refused, not treated as a channel Shell', async () => {
  for (const bad of ['channel-reference:../etc', 'channel-reference:has space', 'bad shell/id!']) {
    await assert.rejects(
      resolveThumbnailShell(slug, { thumbnail_shell_id: bad }, {}),
      /invalid|unavailable/,
      `"${bad}" must be refused rather than silently accepted or blanked`,
    )
  }
})

test('a channel Shell id resolves through the real project, never a fabricated source', async () => {
  const shell = await resolveThumbnailShell(slug, { thumbnail_shell_id: channelReferenceShellId(slug) }, { thumbnail_reference_asset: reference })
  assert.equal(shell.id, channelReferenceShellId(slug))
  assert.equal(shell.imagePath, path.join(projectDir, 'thumbnail-reference-assets', reference.filename))
  assert.equal(shell.sourceProjectSlug, slug)
  assert.equal(shell.layoutNote, reference.reframing_prompt)
})

test('a text-only Shell keeps its layout note even though it carries no image', async () => {
  const shell = await resolveThumbnailShell(slug, { thumbnail_shell_id: templateId }, {})
  assert.equal(shell.imagePath, null)
  assert.equal(shell.layoutNote, layoutNote)
  assert.deepEqual(shell.guidanceAsset, { layoutNote })
})
