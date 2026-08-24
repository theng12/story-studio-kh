/**
 * MEASURED 2026-08-24 on the owner's Abiding Faith channel. Every thumbnail
 * prompt for EP0344 came back reading
 *
 *   Large bold sans-serif text 'EP0344' is placed on the right
 *
 * — five images with a filing code printed across them, and credits spent to
 * make them. The cause was one line: `const title = req.title || episodeId`,
 * and the resolved title is what gets rendered INSIDE the image.
 *
 * An episode code is never thumbnail text. These tests pin the two halves of
 * that: the title is found from the episode's own idea record when the request
 * omits it, and when there is genuinely no title the run REFUSES rather than
 * printing a code onto five paid images.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const generator = readFileSync(path.join(SERVER, 'generators/image-prompts.ts'), 'utf8')
const utils = readFileSync(path.join(SERVER, 'services/utils.ts'), 'utf8')

describe('an episode code is never thumbnail text', () => {
  test('the code fallback is gone', () => {
    assert.doesNotMatch(
      generator,
      /const title = req\.title \|\| episodeId/,
      'restoring this prints the episode code across every thumbnail',
    )
  })

  test('a missing title is looked up from the episode itself', () => {
    assert.match(generator, /resolveEpisodeTitleByCode\(projectSlug, episodeId\)/)
    assert.match(utils, /export async function resolveEpisodeTitleByCode/)
  })

  test('no title anywhere refuses, and names what to do about it', () => {
    // Refusing is the cheap failure. Generating five images with a filing code
    // on them is the expensive one.
    assert.match(generator, /if \(!title \|\| title === episodeId\) \{/)
    assert.match(generator, /an episode code is not thumbnail text/)
    assert.match(generator, /Give \$\{episodeId\} a title in Ideas or Metadata/)
  })

  test('the resolver returns empty rather than inventing a title', () => {
    // It must not fall back to the code either, or the guard above can never
    // fire and the bug returns one layer down.
    assert.match(utils, /return String\(ideas\.find\(idea => idea\.episode_code === code\)\?\.title \|\| ''\)\.trim\(\)/)
    assert.doesNotMatch(utils.split('resolveEpisodeTitleByCode')[1]!.slice(0, 700), /\|\| code/)
  })
})
