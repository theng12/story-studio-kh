/**
 * The hold route answers only the Launcher (contract:
 * _orchestra/youtube-stack/update-hold/CONTRACT.md; issue row 20261123-80).
 *
 * The hold pauses dispatch on a fixed loopback port, so before this gate anything on the Mac could
 * pause Story's queue — and a shim branching on status alone read a refusal as permission. The
 * proof owed: a missing token file, a request with no token, a wrong token and a token readable by
 * others each answer 401 with NOTHING paused; a GET answers 405; the Launcher's own 64-hex token
 * answers 200 with `safe: true`.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const TOKEN = randomBytes(32).toString('hex')
const WRONG = randomBytes(32).toString('hex')

let app: express.Express
let tokenFile: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')

const hold = () => request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=60')
const resume = () => request(app).delete('/api/maintenance/hold')

async function writeToken(contents = TOKEN, mode = 0o600) {
  await fs.rm(tokenFile, { force: true })
  await fs.writeFile(tokenFile, contents)
  await fs.chmod(tokenFile, mode)
}

async function assertNothingPaused(why: string) {
  const state = await jq.updateHoldState()
  assert.equal(state.active, false, why)
}

before(async () => {
  const isolated = await useTempDataDir()
  cleanup = isolated.cleanup
  tokenFile = path.join(isolated.dir, 'hold-token')
  process.env.KHU_HOLD_TOKEN_FILE = tokenFile
  const { router } = await import('../routes/system.js')
  jq = await import('../services/job-queue.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => {
  jq._clearUpdateHoldForTesting()
  delete process.env.KHU_HOLD_TOKEN_FILE
  await cleanup()
})

describe('the hold route refuses anything but the Launcher', () => {
  test('a missing token file answers 401 and pauses nothing', async () => {
    await fs.rm(tokenFile, { force: true })
    const refused = await hold().set('X-Hub-Token', TOKEN).expect(401)
    assert.match(refused.body.detail, /^update blocked: hold token missing at /)
    assert.ok(refused.body.detail.includes(tokenFile), 'the sentence names the file a person must fix')
    assert.match(refused.body.detail, /Nothing was paused/)
    await assertNothingPaused('a refused hold never stalls the queue')
  })

  test('a request that sends no token answers 401 and pauses nothing', async () => {
    await writeToken()
    const refused = await hold().expect(401)
    assert.match(refused.body.detail, /^update blocked: hold token was not sent by this request/)
    await assertNothingPaused('a tokenless request must not pause dispatch')
  })

  test('a wrong token answers 401 and pauses nothing', async () => {
    await writeToken()
    const refused = await hold().set('X-Hub-Token', WRONG).expect(401)
    assert.match(refused.body.detail, /^update blocked: hold token does not match /)
    await assertNothingPaused('a wrong token must not pause dispatch')
  })

  test('a token others could read, or one that is not a token, answers 401', async () => {
    await writeToken(TOKEN, 0o644)
    const loose = await hold().set('X-Hub-Token', TOKEN).expect(401)
    assert.match(loose.body.detail, /not private \(mode 644\)/)

    await writeToken('not-a-hold-token'.padEnd(64, 'x'))
    const junk = await hold().set('X-Hub-Token', TOKEN).expect(401)
    assert.match(junk.body.detail, /^update blocked: hold token unreadable at /)

    await assertNothingPaused('an unreadable credential must not pause dispatch')
  })

  test('a browser-shaped request is refused even with the token', async () => {
    await writeToken()
    const refused = await hold().set('X-Hub-Token', TOKEN).set('Origin', 'https://example.com').expect(401)
    assert.match(refused.body.detail, /must come from the Launcher, not a browser/)
    await assertNothingPaused('a browser request must not pause dispatch')
  })

  test('a GET answers 405 instead of doing nothing silently', async () => {
    await writeToken()
    const refused = await request(app).get('/api/maintenance/hold').set('X-Hub-Token', TOKEN).expect(405)
    assert.match(refused.body.detail, /POST \(hold\) and DELETE \(resume\) only/)
    await assertNothingPaused('a GET must not hold or resume anything')
  })

  test('the Launcher\'s token holds and resumes; a tokenless DELETE cannot resume', async () => {
    await writeToken()
    // The Launcher sends the token as X-Hub-Token and as a bearer; either is the same credential.
    const held = await hold().set('Authorization', `Bearer ${TOKEN}`).expect(200)
    assert.equal(held.body.safe, true, 'the contract: only 200 {"safe":true} permits an update')
    assert.equal(held.body.dispatch_paused_s, 60)
    assert.equal((await jq.updateHoldState()).active, true)

    const tokenless = await resume().expect(401)
    assert.match(tokenless.body.detail, /^update blocked: hold token was not sent by this request/)
    assert.equal((await jq.updateHoldState()).active, true, 'a refused DELETE leaves the hold it could not lift')

    const resumed = await resume().set('X-Hub-Token', TOKEN).expect(200)
    assert.equal(resumed.body.dispatch_paused_s, 0)
    await assertNothingPaused('the Launcher\'s DELETE resumes at once')
  })
})
