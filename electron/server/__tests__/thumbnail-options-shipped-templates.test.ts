/**
 * Every thumbnail recipe the app ships must satisfy the schema the app validates with.
 *
 * Measured live 2026-11-15: thirteen Komsan episodes failed at `image_prompts` with
 * "String must contain at most 200 character(s)" on `options[1..3].thumb_font_style`, before any
 * provider was called. The banner triptych's own `default_font_style` is 242 characters and its
 * `default_text_style` 252 — so the app rejected a value the app itself ships, and the failure
 * surfaced as a per-episode validation error rather than as the template problem it was.
 *
 * This test is the class fix: it reads the shipped recipes and asserts each default passes the
 * same schema the request validator uses. A new template with longer prose fails here, in a unit
 * test, instead of in a production batch.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ThumbnailOptionStoredSchema, THUMBNAIL_STYLE_TEXT_MAX } from '../contracts/thumbnail-options.js'

// Resolved from this file, not the process cwd: the harness runs suites from a temp work dir,
// so `process.cwd()` there is not the repo root and the scan would find nothing.
const CONTENT_PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../content-packs')

/** Every `content/thumbnail-recipe.json` under the shipped content packs. */
function recipePaths(dir: string, found: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      recipePaths(full, found)
    } else if (entry === 'thumbnail-recipe.json' && full.includes(`${join('content', '')}`)) {
      found.push(full)
    }
  }
  return found
}

describe('shipped thumbnail recipes satisfy the option schema', () => {
  const paths = recipePaths(CONTENT_PACKS)

  it('finds the shipped recipes at all', () => {
    // A silent zero would make every assertion below vacuous.
    assert.ok(paths.length > 0, `no thumbnail-recipe.json found under ${CONTENT_PACKS}`)
  })

  for (const path of paths) {
    it(`${path.split(join('content-packs', ''))[1] ?? path} passes validation`, () => {
      const recipe = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
      // The fields the image-prompts request carries straight from the recipe's defaults.
      const option = {
        thumbnail_template_id: typeof recipe.id === 'string' ? recipe.id : undefined,
        thumb_font_style: recipe.default_font_style as string | undefined,
        thumb_text_style: recipe.default_text_style as string | undefined,
      }
      const parsed = ThumbnailOptionStoredSchema.safeParse(option)
      assert.equal(
        parsed.success,
        true,
        `${path} does not satisfy the option schema: ${JSON.stringify(parsed.error?.issues ?? [])}`,
      )
    })
  }

  it('the style-text ceiling admits the longest shipped default', () => {
    let longest = 0
    for (const path of paths) {
      const recipe = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
      for (const field of ['default_font_style', 'default_text_style']) {
        const value = recipe[field]
        if (typeof value === 'string') longest = Math.max(longest, value.length)
      }
    }
    assert.ok(
      longest <= THUMBNAIL_STYLE_TEXT_MAX,
      `a shipped default is ${longest} characters but the ceiling is ${THUMBNAIL_STYLE_TEXT_MAX}`,
    )
  })
})
