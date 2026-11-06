/**
 * Thumbnail Shell storage boundaries — reusable image + editable layout note.
 *
 * Proves, without a network or render:
 *  - pack schema accepts an image only with a saved note;
 *  - pack adapter maps both fields through;
 *  - a managed shell reference resolves to its global file and refuses raw paths;
 *  - the save boundary refuses an image without a note, or a missing file.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'

import { ContentPackDocumentSchema, ThumbnailRecipeDocumentSchema } from '../content-packs/schemas.js'
import { contentPackDocumentToThumbnailTemplate } from '../content-packs/legacy-adapters.js'
import {
  managedShellDir,
  resolveTemplateShellImage,
  validateShellSaveFields,
} from '../services/thumbnail-template-loader.js'
import { useTempDataDir } from './_helpers.js'
import type { ThumbnailTemplate } from '../models/types.js'

const temp = await useTempDataDir()
const PACK_ITEM_ID = 'com.storystudio.shell.storage-proof'

after(async () => temp.cleanup())

function baseTemplate(overrides: Partial<ThumbnailTemplate> = {}): ThumbnailTemplate {
  return {
    id: 'shell-storage-proof',
    name: 'Shell storage proof',
    description: 'Proof fixture',
    builtin: false,
    schemaVersion: 1,
    ...overrides,
  }
}

test('pack schema requires a saved note with a shell image', () => {
  const base = {
    kind: 'thumbnail-recipe' as const,
    schema_version: 1,
    id: PACK_ITEM_ID,
    name: 'Shell recipe',
    description: 'Shell recipe description',
    layout: 'hero' as const,
    category: 'proof',
    tags: ['layout'],
    aspect_ratio: '16:9' as const,
    title_mode: 'ai' as const,
    composition_guidance: 'Layout zones and framing.',
    required_elements: ['clear focal zone'],
    avoid_elements: ['clutter'],
    headline_mode: 'short-hook' as const,
    default_text_style: 'none',
    default_font_style: 'serif',
    default_text_position: 'top' as const,
    headline_formats: ['short hook'],
    visual_style_guidance: 'Neutral.',
    preview_assets: ['assets/example.png'],
    compatible_formula_ids: ['com.storystudio.formula.proof'],
  }
  // Field-level schema stays a plain ZodObject (the pack union is a
  // discriminatedUnion); the image⇒note gate is union-level refinement.
  const objectParsed = ThumbnailRecipeDocumentSchema.parse({
    ...base,
    shell_image: 'assets/shell.png',
  })
  assert.equal(objectParsed.shell_image, 'assets/shell.png')
  assert.throws(
    () => ContentPackDocumentSchema.parse({ ...base, shell_image: 'assets/shell.png' }),
    /layout_note/,
  )
  const parsed = ContentPackDocumentSchema.parse({
    ...base,
    shell_image: 'assets/shell.png',
    layout_note: 'left subject zone; headline top right',
  }) as typeof objectParsed
  const mapped = contentPackDocumentToThumbnailTemplate(parsed, [])
  assert.equal(mapped.shellImage, 'assets/shell.png')
  assert.equal(mapped.layoutNote, 'left subject zone; headline top right')
  // Text-only recipe (no shell fields) still parses.
  assert.doesNotThrow(() => ContentPackDocumentSchema.parse(base))
})

test('managed Shell image resolves by safe basename; declared-but-missing refuses loudly', async () => {
  const dir = managedShellDir()
  await fs.mkdir(dir, { recursive: true })
  const bytes = Buffer.from('managed-shell-image')
  await fs.writeFile(path.join(dir, 'shell-abc.png'), bytes)
  const withImage = baseTemplate({ shellImage: 'shell/shell-abc.png', layoutNote: 'subject left, text right' })
  const resolved = await resolveTemplateShellImage(withImage)
  assert.equal(resolved, path.join(dir, 'shell-abc.png'))
  // Text-only Shell: no reference resolves to null, never an error.
  assert.equal(await resolveTemplateShellImage(baseTemplate()), null)
  // Declared but unavailable: a loud refusal, never a silent text-only fallback.
  await assert.rejects(
    () => resolveTemplateShellImage(baseTemplate({ shellImage: 'shell/missing.png', layoutNote: 'note' })),
    /missing or unreadable/,
  )
  await assert.rejects(
    () => resolveTemplateShellImage(baseTemplate({ shellImage: '/tmp/escape.png', layoutNote: 'note' })),
    /managed relative asset/,
  )
})

test('save boundary accepts managed image + note and rejects incomplete Shell fields', async () => {
  const dir = managedShellDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'shell-ok.webp'), Buffer.from('image'))
  await assert.doesNotReject(() => validateShellSaveFields(
    baseTemplate({ shellImage: 'shell/shell-ok.webp', layoutNote: 'headline zone top' }),
  ))
  await assert.rejects(() => validateShellSaveFields(
    baseTemplate({ shellImage: 'shell/shell-ok.webp' }),
  ), /layout note/)
  // Text-only authoring: a note without an image is legal (the only hard rule
  // is image ⇒ non-empty note), and a fully empty template is legal too.
  await assert.doesNotReject(() => validateShellSaveFields(
    baseTemplate({ layoutNote: 'note without image' }),
  ))
  await assert.doesNotReject(() => validateShellSaveFields(baseTemplate()))
  await assert.rejects(() => validateShellSaveFields(
    baseTemplate({ shellImage: '../escape.png', layoutNote: 'note' }),
  ), /managed relative asset/)
  await assert.rejects(() => validateShellSaveFields(
    baseTemplate({ shellImage: 'shell/missing.png', layoutNote: 'note' }),
  ), /existing managed image/)
})

// Last: leave the redirected fixture intact for the retained-filesystem harness.
test('managed Shell directory redirection is refused before resolving a picture', async () => {
  const dir = managedShellDir()
  const outside = path.join(temp.dir, 'outside-shell-library')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'shell-escape.png'), 'outside fixture')
  await fs.rename(dir, `${dir}-held`)
  await fs.symlink(outside, dir)
  const template = baseTemplate({ shellImage: 'shell/shell-escape.png', layoutNote: 'note' })
  await assert.rejects(() => resolveTemplateShellImage(template), /not a real directory/)
  await assert.rejects(() => validateShellSaveFields(template), /not a real directory/)
})