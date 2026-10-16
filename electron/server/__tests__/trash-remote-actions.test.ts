/**
 * Owner, 2026-10-16: the mini is managed remotely, so Story → Trash can hand items to the
 * Mac's own Trash and delete chosen items for good. Both are the owner's alone (automation
 * keys and keyless loopback requests get 403), need a confirmation that matches what the
 * server measures, and delete only index entries of the Library `_trash` or the app's own
 * `<data>/_trash` safely inside them. Restore, move and delete run one at a time. The Mac's
 * Trash is mocked: nothing here touches the real one.
 */
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let trash: typeof import('../services/trash.js')
let move: typeof import('../lib/trash-move.js')
let updater: typeof import('../services/app-update.js')
let app: express.Express
/** What the app's own window sends (main.ts adds it); a request without it is not the owner. */
let OWNER: Record<string, string>

before(async () => {
  tmp = await useTempDataDir()
  pm = await import('../services/project-manager.js')
  trash = await import('../services/trash.js')
  move = await import('../lib/trash-move.js')
  updater = await import('../services/app-update.js')
  const auth = await import('../lib/auth-session.js')
  OWNER = { [auth.OWNER_WINDOW_HEADER]: auth.ownerWindowSecret() }
  const { router } = await import('../routes/trash.js')
  app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => { if (req.headers['x-test-via-key']) req.user = { via: 'automation_key' }; next() })
  app.use('/api', router)
})
after(async () => { await tmp.cleanup() })

async function write(file: string, text = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const libraryTrash = () => path.join(pm.projectsRoot(), '_trash')

/** A channel file moved into Story's Trash the normal way. */
async function trashed(name: string, text: string): Promise<{ slug: string; from: string; landed: string }> {
  const { slug } = await pm.createProject({ name })
  const projectDir = pm.getProjectDir(slug)!
  const from = path.join(projectDir, 'music', `${slug}.mp3`)
  await write(from, text)
  const landed = move.moveToTrashSync(from, path.join(move.trashRootFor(projectDir, projectDir, slug), 'music', `${slug}.mp3`), 'music')
  return { slug, from, landed }
}

const itemAt = async (p: string) => (await trash.listTrash()).items.find(item => item.path === p)

describe('Delete permanently', () => {
  test('an automation key is refused (valid or not, header or session), and nothing is deleted', async () => {
    const { landed } = await trashed('Key Channel', 'keep me')
    const item = (await itemAt(landed))!
    const body = { ids: [item.id], confirm: true, expected_count: 1, expected_bytes: item.bytes }
    // Even alongside the app window's own secret: a key always loses.
    for (const key of [{ Authorization: 'Bearer sk-anything' }, { 'X-Story-Key': 'whatever' }, { 'x-test-via-key': '1' }]) {
      const headers = { ...OWNER, ...key }
      for (const url of ['/api/trash/delete-permanently', '/api/trash/macos-trash']) {
        const refused = await request(app).post(url).set(headers).send(body)
        assert.equal(refused.status, 403, url)
        assert.match(refused.body.detail, /Only the owner/)
      }
    }
    assert.equal(readFileSync(landed, 'utf8'), 'keep me')
  })

  test('a keyless loopback request (any local process) is not the owner: 403, nothing deleted or moved', async () => {
    const { landed } = await trashed('Keyless Channel', 'still here')
    const item = (await itemAt(landed))!
    const body = { ids: [item.id], confirm: true, expected_count: 1, expected_bytes: item.bytes }
    for (const url of ['/api/trash/delete-permanently', '/api/trash/macos-trash']) {
      for (const headers of [{}, { 'x-story-owner': 'a-guess' }, { Cookie: 'ssk_session=forged.sig' }]) {
        const refused = await request(app).post(url).set(headers).send(body)
        assert.equal(refused.status, 403, `${url} ${JSON.stringify(headers)}`)
        assert.match(refused.body.detail, /Only the owner/)
      }
    }
    assert.equal(readFileSync(landed, 'utf8'), 'still here')
    assert.equal((await itemAt(landed))?.restorable, true)
  })

  test('a missing or mismatched confirmation is refused; the matching one deletes, reports bytes and drops Restore', async () => {
    const { landed } = await trashed('Confirm Channel', '12345')
    const item = (await itemAt(landed))!
    assert.equal(item.deletable, true)
    assert.equal(item.bytes, 5)
    const send = (body: object) => request(app).post('/api/trash/delete-permanently').set(OWNER).send(body)
    assert.equal((await send({ ids: [item.id] })).status, 400, 'no confirmation')
    assert.equal((await send({ ids: [item.id], confirm: 'yes', expected_count: 1, expected_bytes: 5 })).status, 400)
    assert.equal((await send({ ids: [item.id], confirm: true, expected_count: 1 })).status, 400, 'no byte figure')
    const wrongCount = await send({ ids: [item.id], confirm: true, expected_count: 2, expected_bytes: 5 })
    assert.equal(wrongCount.status, 409)
    assert.match(wrongCount.body.detail, /Nothing was deleted/)
    assert.equal((await send({ ids: [item.id], confirm: true, expected_count: 1, expected_bytes: 4 })).status, 409, 'wrong bytes')
    assert.equal((await send({ ids: [], confirm: true, expected_count: 0, expected_bytes: 0 })).status, 400, 'nothing chosen')
    assert.equal(existsSync(landed), true, 'still in the Trash after every refusal')

    const done = await send({ ids: [item.id], confirm: true, expected_count: 1, expected_bytes: 5 })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { deleted: 1, bytes_freed: 5, errors: [] })
    assert.equal(existsSync(landed), false)
    assert.equal(await itemAt(landed), undefined)
    await assert.rejects(trash.restoreTrashItem(item.id), /not found/)
    assert.match(readFileSync(path.join(libraryTrash(), move.TRASH_INDEX), 'utf8'), /"removed":"deleted"/)
  })

  test('only indexed paths safely inside the Library _trash or the app\'s own _trash are deleted; symlinks and anything outside are refused', async () => {
    const { slug, landed } = await trashed('Safety Channel', 'indexed')
    const outside = path.join(tmp.dir, 'outside')
    await write(path.join(outside, 'precious.txt'), 'never delete me')
    const index = path.join(libraryTrash(), move.TRASH_INDEX)
    const forge = (to: string) => appendFileSync(index, `${JSON.stringify({ id: `forged-${path.basename(to)}`, from: path.join(tmp.dir, 'gone', path.basename(to)), to, kind: 'other', at: new Date().toISOString() })}\n`)
    // 1. a symlink in the trash pointing outside, recorded in the index
    const link = path.join(libraryTrash(), slug, 'link-out')
    symlinkSync(path.join(outside, 'precious.txt'), link)
    forge(link)
    // 2. an index line naming a path outside the trash altogether
    forge(path.join(outside, 'precious.txt'))
    // 3. a folder in the trash that is a symlink leading out, with an index line beneath it
    symlinkSync(outside, path.join(libraryTrash(), slug, 'dir-out'))
    forge(path.join(libraryTrash(), slug, 'dir-out', 'precious.txt'))
    // 4. something in the trash no index line describes
    await write(path.join(libraryTrash(), slug, 'legacy', 'old.txt'), 'legacy')
    // 5. an indexed item in the app's own `<data>/_trash` (the Library on another drive): deletable too,
    //    and listed once, not again as its bucket folder; an unrecorded leftover there is movable only
    const appTrash = updater.trashDir()
    const appFile = path.join(tmp.dir, 'stray.plist')
    await write(appFile, 'plist')
    const appLanded = move.moveToTrashSync(appFile, path.join(appTrash, 'launch-agent', 'stray.plist'), 'launch-agent')
    await write(path.join(appTrash, 'app-update', '1.4.200-1700000000000', 'old.zip'), 'zip')

    const listing = await trash.listTrash()
    const deletable = listing.items.filter(item => item.deletable).map(item => item.path)
    assert.ok(deletable.includes(landed))
    assert.ok(deletable.includes(appLanded), 'the app\'s own _trash is deletable like the Library one')
    for (const unsafe of [link, path.join(outside, 'precious.txt'), path.join(libraryTrash(), slug, 'dir-out', 'precious.txt'), path.join(libraryTrash(), slug, 'legacy', 'old.txt'), path.join(appTrash, 'app-update', '1.4.200-1700000000000')]) {
      assert.equal(deletable.includes(unsafe), false, unsafe)
    }
    // P3-3: each thing in the app's _trash is one row; the bucket folders are never items of their own.
    const appRows = listing.items.filter(item => item.path.startsWith(appTrash + path.sep))
    assert.deepEqual(appRows.map(item => item.path).sort(), [path.join(appTrash, 'app-update', '1.4.200-1700000000000'), appLanded].sort())
    assert.ok(appRows.every(item => item.slug === '_story-studio' && item.movable))
    const appChannel = listing.channels.find(row => row.slug === '_story-studio')!
    assert.deepEqual({ bytes: appChannel.bytes, items: appChannel.items }, { bytes: 5 + 3, items: 2 }, 'nothing counted twice')
    assert.equal(listing.kinds.find(row => row.kind === 'legacy')?.items, listing.items.filter(item => item.kind === 'legacy').length)
    for (const id of ['forged-link-out', 'forged-precious.txt']) {
      const refused = await request(app).post('/api/trash/delete-permanently').set(OWNER).send({ ids: [id], confirm: true, expected_count: 1, expected_bytes: 15 })
      assert.equal(refused.status, 409, id)
    }
    const { items, bytes } = listing.deletable
    const all = await request(app).post('/api/trash/delete-permanently').set(OWNER).send({ ids: 'all', confirm: true, expected_count: items, expected_bytes: bytes })
    assert.equal(all.status, 200)
    assert.deepEqual(all.body, { deleted: items, bytes_freed: bytes, errors: [] })
    assert.equal(existsSync(landed), false)
    assert.equal(existsSync(appLanded), false)
    assert.match(readFileSync(path.join(appTrash, move.TRASH_INDEX), 'utf8'), /"removed":"deleted"/)
    assert.equal(readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'never delete me')
    assert.equal(existsSync(link), true, 'the symlink itself is left alone too')
    assert.equal(readFileSync(path.join(libraryTrash(), slug, 'legacy', 'old.txt'), 'utf8'), 'legacy')
    assert.equal(readFileSync(path.join(appTrash, 'app-update', '1.4.200-1700000000000', 'old.zip'), 'utf8'), 'zip')
  })

  test('a delete that fails partway: Restore is gone (recorded before the rm), the rest stays listed and can be deleted again', async () => {
    const { slug } = await pm.createProject({ name: 'Partial Channel' })
    const projectDir = pm.getProjectDir(slug)!
    const from = path.join(projectDir, 'scenes')
    await write(path.join(from, 'a.txt'), 'aaa')
    await write(path.join(from, 'locked', 'b.txt'), 'bbb')
    const landed = move.moveToTrashSync(from, path.join(move.trashRootFor(projectDir, projectDir, slug), 'scenes'), 'other')
    const item = (await itemAt(landed))!
    chmodSync(path.join(landed, 'locked'), 0o555) // b.txt cannot be removed
    try {
      const result = await trash.deletePermanently([item.id], { count: 1, bytes: item.bytes })
      assert.equal(result.deleted, 0)
      assert.equal(result.errors.length, 1)
      assert.equal(readFileSync(path.join(landed, 'locked', 'b.txt'), 'utf8'), 'bbb')
      const left = (await itemAt(landed))!
      assert.equal(left.restorable, false)
      assert.match(left.restore_note!, /stopped partway/)
      assert.equal(left.deletable, true)
      await assert.rejects(trash.restoreTrashItem(item.id), /stopped partway/)
      assert.equal(existsSync(from), false, 'nothing half-empty was put back')
      const lines = readFileSync(path.join(libraryTrash(), move.TRASH_INDEX), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line)).filter(line => line.to === landed)
      assert.deepEqual(lines.map(line => line.removed ?? (line.partial ? 'partial' : 'moved')), ['moved', 'deleted', 'partial'])
    } finally { chmodSync(path.join(landed, 'locked'), 0o755) }
    const again = (await itemAt(landed))!
    assert.equal((await trash.deletePermanently([again.id], { count: 1, bytes: again.bytes })).deleted, 1)
    assert.equal(existsSync(landed), false)
  })
})

describe('one at a time', () => {
  test('a Restore asked for while a move to the Mac\'s Trash runs waits for it, then finds nothing to restore', async () => {
    const { from, landed } = await trashed('Race Channel', 'race')
    const item = (await itemAt(landed))!
    const macTrash = path.join(tmp.dir, 'fake-mac-trash-race')
    mkdirSync(macTrash, { recursive: true })
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    // Both facts are sampled at the moment they are decided rather than after a fixed sleep: the move
    // holds the one serial chain, so a Restore queued behind it must not put the item back — and must
    // not settle — before the move finishes. A slow machine cannot make either pass by accident.
    let sourceStayedEmpty = true
    let moveSettled = false
    const moving = trash.moveToMacTrash([item.id], { count: 1, bytes: 4 }, async (p) => {
      sourceStayedEmpty = !existsSync(from)
      await gate
      renameSync(p, path.join(macTrash, path.basename(p)))
    }).then(result => { moveSettled = true; return result })
    let restoreSettledBeforeMove = false
    const restoring = trash.restoreTrashItem(item.id).finally(() => { restoreSettledBeforeMove = !moveSettled })
    restoring.catch(() => {})
    open()
    assert.equal((await moving).moved, 1)
    assert.equal(sourceStayedEmpty, true, 'nothing was put back while the move held the chain')
    assert.equal(restoreSettledBeforeMove, false, 'Restore waits for the move')
    await assert.rejects(restoring, /not found/)
    assert.equal(existsSync(from), false)
  })
})

describe('Move to macOS Trash', () => {
  test('calls trashItem with the item; a failing trashItem leaves it in place and Restore still offered', async () => {
    const { landed } = await trashed('Mac Fail Channel', 'stay')
    const item = (await itemAt(landed))!
    assert.equal(item.movable, true)
    const calls: string[] = []
    const failing = async (p: string) => { calls.push(p); throw new Error('Finder said no') }
    const result = await trash.moveToMacTrash([item.id], { count: 1, bytes: 4 }, failing)
    assert.deepEqual(calls, [landed])
    assert.equal(result.moved, 0)
    assert.match(result.errors[0]!, /Finder said no/)
    assert.equal(readFileSync(landed, 'utf8'), 'stay', 'never deleted, never moved')
    assert.equal((await itemAt(landed))?.restorable, true)
  })

  test('a successful hand-over reports bytes and the item is no longer offered for Restore', async () => {
    const { landed } = await trashed('Mac Ok Channel', 'gone to mac')
    const item = (await itemAt(landed))!
    const macTrash = path.join(tmp.dir, 'fake-mac-trash')
    mkdirSync(macTrash, { recursive: true })
    const result = await trash.moveToMacTrash([item.id], { count: 1, bytes: 11 }, async (p) => { renameSync(p, path.join(macTrash, path.basename(p))) })
    assert.deepEqual(result, { moved: 1, bytes: 11, errors: [] })
    assert.equal(await itemAt(landed), undefined)
    await assert.rejects(trash.restoreTrashItem(item.id), /not found/)
    assert.match(readFileSync(path.join(libraryTrash(), move.TRASH_INDEX), 'utf8'), /"removed":"macos-trash"/)
  })

  test('"all" (or a choice) must match what is measured now, as for Delete: otherwise nothing is moved', async () => {
    const { landed } = await trashed('Mac All Channel', 'all of it')
    const { movable } = await trash.listTrash()
    const calls: string[] = []
    const record = async (p: string) => { calls.push(p) }
    await assert.rejects(trash.moveToMacTrash('all', { count: movable.items - 1, bytes: movable.bytes }, record), /Nothing was moved/)
    await assert.rejects(trash.moveToMacTrash('all', { count: movable.items, bytes: movable.bytes + 1 }, record), /Nothing was moved/)
    const item = (await itemAt(landed))!
    await assert.rejects(trash.moveToMacTrash([item.id], { count: 1, bytes: item.bytes + 1 }, record), /Nothing was moved/)
    assert.deepEqual(calls, [])
    assert.equal(readFileSync(landed, 'utf8'), 'all of it')
    const res = await request(app).post('/api/trash/macos-trash').set(OWNER).send({ ids: 'all' })
    assert.equal(res.status, 400, 'the route asks for the figures')
  })

  test('without Electron (no shell.trashItem) the route refuses and moves nothing; there is no fallback', async () => {
    const { landed } = await trashed('No Electron Channel', 'here')
    const item = (await itemAt(landed))!
    const res = await request(app).post('/api/trash/macos-trash').set(OWNER).send({ ids: [item.id], expected_count: 1, expected_bytes: 4 })
    assert.equal(res.status, 503)
    assert.equal(readFileSync(landed, 'utf8'), 'here')
  })

  test('the listing carries the Free up space summary: oldest item and the totals each "all" means', async () => {
    const listing = await trash.listTrash()
    assert.ok(listing.oldest && listing.oldest.at <= listing.items.filter(i => i.at).map(i => i.at!).sort().at(-1)!)
    assert.equal(listing.movable.items, listing.items.filter(item => item.movable).length)
    assert.equal(listing.deletable.bytes, listing.items.filter(item => item.deletable).reduce((n, item) => n + item.bytes, 0))
  })
})
