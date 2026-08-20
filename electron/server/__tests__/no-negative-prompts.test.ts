/**
 * v1.4.11 — negative prompts are not a thing this app does.
 *
 * The owner's ruling: *"we are never using negative prompts at all. so don't
 * include it anyways."*
 *
 * Two separate messes were behind it, and both were invisible from the UI:
 *
 *   1. `negativePromptAddendum` — a niche field, typed, schema-validated,
 *      authored in six niche files, and RENDERED TO HIM in project settings as
 *      "Negative: …", which no render path had ever read. A setting he can see
 *      and edit that does nothing is worse than no setting.
 *
 *   2. `NONCHARACTER_NEGATIVE` in continuity-render.ts — `person, people,
 *      child, boy, kid, human figure, character, portrait`, attached to every
 *      scene not typed `character`. Its v1.0.336 intent was "keep the ANCHORED
 *      GUIDE out of a cutaway"; what it said was "no humans", so an event, a
 *      market or a coronation was rendered with every person banned. The part
 *      that actually does that job — dropping the guide's descriptors and
 *      reference images for a non-character scene — is untouched.
 *
 * These are source-level assertions on purpose. The thing being guarded is the
 * ABSENCE of a value in an outgoing request, and absence is exactly what a
 * behavioural test drifts quietly out of covering: a future re-add would sail
 * past a test that only checks what IS sent.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFile(path.join(serverRoot, rel), 'utf-8')

describe('no negative prompt is sent, from anywhere', () => {
  test('the continuity renderer never puts a negative prompt on a request', async () => {
    const src = await read('generators/continuity-render.ts')
    assert.ok(
      !/NONCHARACTER_NEGATIVE/.test(src),
      'the hardcoded no-humans negative must not come back',
    )
    assert.ok(
      !/person, people, child, boy, kid/.test(src),
      'nor may its wording be re-inlined under another name',
    )
    assert.ok(
      !/providerParams as any\)\.negative_prompt|negative_prompt:\s*\[/.test(src),
      'nothing may copy a stored negative prompt into the outgoing provider params',
    )
  })

  test('a non-character scene still drops the guide — that is what kept it out', async () => {
    // The safety this feature actually relies on. If this ever goes, cutaways
    // start img2img-ing the anchored character back in, and no negative prompt
    // would have saved it anyway.
    const src = await read('generators/continuity-render.ts')
    assert.match(
      src,
      /includeCharacter:\s*isCharacterScene\(scene\)/,
      'non-character scenes must still be composed without the guide’s descriptors',
    )
  })

  test('the image provider never forwards provider params as request content', async () => {
    // Why the two removals above change nothing he will see: this is the only
    // registered image provider, and it builds its request field by field.
    const src = await read('providers/image/genstudio.ts')
    assert.ok(
      !/negative/i.test(src),
      'the only image provider must know nothing about negative prompts',
    )
  })

  test('the retired niche addendum is gone from every surface', async () => {
    for (const rel of ['models/types.ts', 'contracts/index.ts']) {
      assert.ok(
        !/negativePromptAddendum/.test(await read(rel)),
        `${rel} must not declare the retired niche negative-prompt field`,
      )
    }
    const niches = await fs.readdir(path.join(serverRoot, 'niches'))
    for (const name of niches.filter(n => n.endsWith('.json'))) {
      const raw = await read(path.join('niches', name))
      assert.ok(
        !raw.includes('negativePromptAddendum'),
        `niches/${name} still carries a negative-prompt addendum`,
      )
    }
  })
})
