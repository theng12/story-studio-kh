import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { writeChapterFiles, chapterFilePath } from '../lib/narration-assembly.js'
import { moveToTrashSync, TRASH_INDEX, trashRootFor } from '../lib/trash-move.js'

const revision = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const

/**
 * The canonical harness owns this fixture. A fixture outside
 * STORY_STUDIO_TEST_HARNESS_ROOT is refused by the retained-filesystem guard, so
 * the promotion's atomic rename and this retention move would both fail.
 */
function harnessRoot(): string {
  const root = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(root, 'run through scripts/testing/run-backend-tests.mjs so the fixture root is isolated')
  return root
}

function retainFixture(root: string): void {
  moveToTrashSync(
    root,
    path.join(harnessRoot(), '_trash', 'script-document-preservation-fixtures', path.basename(root)),
    'test-fixture',
  )
}

test('manual chapter promotion copies the complete old package before replacing the locked component', async t => {
  const root = await fs.mkdtemp(path.join(harnessRoot(), '.script-preserve-'))
  t.after(() => retainFixture(root))
  const projectDir = path.join(root, 'projects', 'script-project')
  const scriptDir = path.join(projectDir, 'episodes', 'EP7301 - Preserve', 'script')
  const component = chapterFilePath(scriptDir, 'EP7301', 2)
  const unified = path.join(scriptDir, 'EP7301_Script_Narration.md')
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(component, '## Chapter 02: Old\n\nOld component bytes.\n')
  await fs.writeFile(unified, '# Old unified bytes\n')

  await writeChapterFiles(scriptDir, 'EP7301', 'Preserve', {
    chapters: [{ number: 2, title: 'New', text: 'New component words remain safely promoted.' }],
  }, {
    normalizeSpokenProse: false,
    manualPromotion: {
      expectedRevision: revision(await fs.readFile(component)),
      ownerActionId: '73010000-0000-4000-8000-000000000001',
      projectDir,
      projectSlug: 'script-project',
      archiveFiles: [component, unified],
    },
  })

  assert.match(await fs.readFile(component, 'utf8'), /New component words/)
  assert.equal(await fs.readFile(unified, 'utf8'), '# Old unified bytes\n', 'component writer does not claim two-file atomicity')
  const trashDir = trashRootFor(projectDir, projectDir, 'script-project')
  const entries = (await fs.readFile(path.join(path.dirname(trashDir), TRASH_INDEX), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
    .filter(entry => entry.kind === 'script-version')
  assert.deepEqual(new Set(entries.map(entry => entry.from)), new Set([component, unified]))
  assert.equal(await fs.readFile(entries.find(entry => entry.from === component)!.to, 'utf8'), '## Chapter 02: Old\n\nOld component bytes.\n')
  assert.equal(await fs.readFile(entries.find(entry => entry.from === unified)!.to, 'utf8'), '# Old unified bytes\n')
})

test('a preservation member failure leaves every active member byte-identical and in place', async t => {
  const root = await fs.mkdtemp(path.join(harnessRoot(), '.script-preserve-fail-'))
  t.after(() => retainFixture(root))
  const projectDir = path.join(root, 'projects', 'script-project')
  const scriptDir = path.join(projectDir, 'episodes', 'EP7302 - Fail', 'script')
  const component = chapterFilePath(scriptDir, 'EP7302', 1)
  const unified = path.join(scriptDir, 'EP7302_Script_Narration.md')
  const outside = path.join(root, 'outside.md')
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(component, 'old component')
  await fs.writeFile(unified, 'old unified')
  await fs.writeFile(outside, 'outside')

  await assert.rejects(writeChapterFiles(scriptDir, 'EP7302', 'Fail', {
    chapters: [{ number: 1, title: 'New', text: 'candidate' }],
  }, {
    normalizeSpokenProse: false,
    manualPromotion: {
      expectedRevision: revision('old component'),
      ownerActionId: '73020000-0000-4000-8000-000000000002',
      projectDir,
      projectSlug: 'script-project',
      archiveFiles: [component, unified, outside],
    },
  }), /outside its project/)
  assert.equal(await fs.readFile(component, 'utf8'), 'old component')
  assert.equal(await fs.readFile(unified, 'utf8'), 'old unified')
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside')
})

test('a stale accepted revision promotes nothing', async t => {
  const root = await fs.mkdtemp(path.join(harnessRoot(), '.script-cas-'))
  t.after(() => retainFixture(root))
  const projectDir = path.join(root, 'projects', 'script-project')
  const scriptDir = path.join(projectDir, 'episodes', 'EP7303 - CAS', 'script')
  const component = chapterFilePath(scriptDir, 'EP7303', 4)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(component, 'human edit after admission')
  await assert.rejects(writeChapterFiles(scriptDir, 'EP7303', 'CAS', {
    chapters: [{ number: 4, title: 'Candidate', text: 'candidate' }],
  }, {
    manualPromotion: {
      expectedRevision: revision('older bytes'),
      ownerActionId: '73030000-0000-4000-8000-000000000003',
      projectDir,
      projectSlug: 'script-project',
      archiveFiles: [component],
    },
  }), /changed after this replacement was accepted/)
  assert.equal(await fs.readFile(component, 'utf8'), 'human edit after admission')
})
