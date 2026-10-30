/**
 * Before an outline is replaced it is copied to Story's Trash.
 *
 * Owner rule (2026-10-30): nothing deleted for good. A `force` rebuild of a good
 * outline and an edit both used to overwrite the progress sidecar in place. This
 * pins the helper both paths call: the previous sidecar is copied (never moved),
 * the copy is under `script-versions/`, and a FIRST build — nothing to copy —
 * creates no folder at all.
 *
 * The rebuild path's own call is asserted by source in `buildOutlineOnly`; the
 * edit path is exercised end to end in `outline-routes.test.ts`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { preserveOutlineSidecar, sidecarPath } from '../lib/chunked-narration.js'
import { useTempDataDir } from './_helpers.js'

const SLUG = 'preserve-test'
const CODE = 'EP0001'

async function project(t: { after: (fn: () => Promise<void>) => void }) {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const projectDir = path.join(temporary.dir, 'projects', SLUG)
  const scriptDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Test`, '01 Script')
  await fs.mkdir(scriptDir, { recursive: true })
  return { temporary, projectDir, scriptDir }
}

async function everyFile(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(target)
      else out.push(target)
    }
  }
  await walk(root)
  return out
}

test('a rebuild copies the previous outline to Trash and leaves the original in place', async t => {
  const { temporary, scriptDir } = await project(t)
  const sidecar = sidecarPath(scriptDir, CODE)
  const original = JSON.stringify({ schema_version: 3, episode_id: CODE, outline: [{ n: 1, title: 'One' }] })
  await fs.writeFile(sidecar, original)

  const preserved = preserveOutlineSidecar(SLUG, scriptDir, CODE, 'rebuild')
  assert.ok(preserved, 'a copy was made')
  assert.match(preserved!, /script-versions[\\/]outline-rebuild-[0-9]+[\\/]/)
  assert.equal(await fs.readFile(preserved!, 'utf-8'), original)
  assert.equal(await fs.readFile(sidecar, 'utf-8'), original, 'the live sidecar is untouched by the copy')

  // A second rebuild keeps its own copy — the earlier one is never replaced.
  const second = preserveOutlineSidecar(SLUG, scriptDir, CODE, 'rebuild')
  assert.ok(second)
  const copies = (await everyFile(temporary.dir)).filter(file => file.endsWith(`${CODE}_chunked-progress.json`))
  assert.equal(copies.length, 3, 'the live sidecar plus two preserved copies')
})

test('a first build has nothing to copy and adds no folder', async t => {
  const { temporary, scriptDir } = await project(t)
  assert.equal(preserveOutlineSidecar(SLUG, scriptDir, CODE, 'rebuild'), null)
  const files = await everyFile(temporary.dir)
  assert.deepEqual(files, [], 'no Trash folder is created for a first build')
})
