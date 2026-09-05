/**
 * End-to-end resumable-upload flow test.
 *
 * Drives `uploadVideo` against a real local HTTP server that mimics
 * Google's resumable-upload protocol, with the goal of verifying:
 *
 *  1. When `resumeFromSessionUrl` is set, the init endpoint is NOT hit.
 *  2. The resume probe (PUT Content-Range: bytes star-slash-N) is issued first.
 *  3. The chunk loop continues from Google's server-side high-water mark.
 *  4. `recordQuotaUsage('videos_insert')` is NOT called a second time —
 *     the persisted sidecar already records a quota_charged: true. This
 *     is the whole point of the fix; redoing the upload from scratch
 *     would burn another 1600 units (16% of the default daily 10K).
 *  5. The transient sidecar is deleted after the final 200.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
let tempDir: string
let cleanup: () => Promise<void>
let yt: typeof import('../lib/youtube-client.js')
let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let resume: typeof import('../services/upload-resume-sidecar.js')
let quota: typeof import('../services/upload-quota.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  resume = await import('../services/upload-resume-sidecar.js')
  quota = await import('../services/upload-quota.js')
  yt = await import('../lib/youtube-client.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.rm(path.join(tempDir, 'youtube'), { recursive: true, force: true })
  await fs.rm(path.join(tempDir, 'app-secrets.json'), { force: true })
})

async function setupProject() {
  const proj = await pm.createProject({ name: 'Resume', episode_prefix: 'EP', episode_digits: 3 })
  await connections.configureYouTubeApplication({ client_id: 'test-client', client_secret: 'test-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC_resume', title: 'Resume', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'access-token-fresh',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
      scope: 'youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: proj.slug, channel_id: 'UC_resume', expected_previous_channel_id: null })
  return proj
}

interface RequestLog {
  method: string
  url: string
  headers: Record<string, string>
}

/**
 * A fake YouTube resumable-upload server. Tracks every request so the
 * test can assert what was hit (init endpoint NOT hit on resume,
 * Content-Range probe IS hit, etc).
 */
function fakeYouTube(opts: {
  totalBytes: number
  serverHasBytesAt: number  // server's claimed high-water mark for the resume probe
  finalVideo: any           // returned on the final-chunk 200
}) {
  const log: RequestLog[] = []
  const server = http.createServer((req, res) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v
    }
    log.push({ method: req.method || '', url: req.url || '', headers })

    // Drain body silently; the chunk PUTs send video bytes we don't care about.
    req.on('data', () => {})
    req.on('end', () => {
      const contentRange = headers['content-range'] || ''
      const isProbe = contentRange === `bytes */${opts.totalBytes}`
      if (req.method === 'PUT' && isProbe) {
        // Resume probe — tell the client where we are.
        if (opts.serverHasBytesAt >= opts.totalBytes) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(opts.finalVideo))
          return
        }
        res.writeHead(308, {
          range: `bytes=0-${opts.serverHasBytesAt - 1}`,
        })
        res.end()
        return
      }
      if (req.method === 'PUT') {
        // Real chunk PUT. Match the byte range to decide if it's the
        // final chunk or an intermediate one.
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(contentRange)
        if (!m) { res.writeHead(400); res.end('bad range'); return }
        const end = Number(m[2])
        const total = Number(m[3])
        if (end + 1 >= total) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(opts.finalVideo))
        } else {
          res.writeHead(308, { range: `bytes=0-${end}` })
          res.end()
        }
        return
      }
      // Anything else (POST init, etc) — fail loudly so the test catches
      // accidental init calls on the resume path.
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'fake server: unexpected request', code: 400 },
      }))
    })
  })
  return { server, log }
}

describe('uploadVideo resume path', () => {
  test('skips init, probes server, and does not charge quota a second time', async () => {
    const proj = await setupProject()

    // Build a small video file — 1 MB (chunkSize defaults to 10 MB so
    // this fits in a single chunk; that's enough for the test).
    const totalBytes = 1024 * 1024
    const filePath = path.join(tempDir, 'video.mp4')
    await fs.writeFile(filePath, Buffer.alloc(totalBytes, 0xab))

    // Fake server simulates "Google has the first 256 KB" — resumed
    // upload should send byte 262144..end.
    const { server, log } = fakeYouTube({
      totalBytes,
      serverHasBytesAt: 256 * 1024,
      finalVideo: {
        id: 'vid_resumed_xyz',
        snippet: { title: 'resumed' },
        status: { privacyStatus: 'private' },
      },
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const sessionUrl = `http://127.0.0.1:${port}/upload?token=fake`

    // Pre-seed the persisted resume sidecar (simulating a prior
    // interrupted run that left this behind).
    await resume.writeResumeSidecar(proj.slug, 'EP001', {
      platform: 'youtube',
      account_id: 'registry:UC_resume',
      file_path: filePath,
      file_size: totalBytes,
      session_url: sessionUrl,
      created_at: new Date().toISOString(),
      quota_charged: true,
    })

    // Snapshot quota before the resume — used must NOT change after.
    const beforeQuota = await quota.readQuota(proj.slug)

    const logLines: string[] = []
    try {
      const result = await yt.uploadVideo({
        slug: proj.slug,
        accountId: 'registry:UC_resume',
        filePath,
        snippet: { title: 'resumed' },
        status: { privacyStatus: 'private' },
        episodeCode: 'EP001',
        resumeFromSessionUrl: sessionUrl,
        logLines,
      })
      assert.equal(result.id, 'vid_resumed_xyz')
    } finally {
      server.close()
    }

    // 1. Quota counter unchanged — we did NOT pay another 1600 units.
    const afterQuota = await quota.readQuota(proj.slug)
    assert.equal(
      afterQuota.used,
      beforeQuota.used,
      'resume must not charge videos_insert again',
    )

    // 2. Init endpoint was never hit — the only PUTs go to /upload.
    const initHits = log.filter((r) => r.method === 'POST')
    assert.equal(initHits.length, 0, `init should not be hit on resume, got: ${JSON.stringify(initHits)}`)

    // 3. First request was the resume probe (Content-Range: bytes */N,
    //    Content-Length: 0).
    assert.equal(log[0].method, 'PUT', 'first request should be the probe PUT')
    assert.equal(log[0].headers['content-range'], `bytes */${totalBytes}`)
    assert.equal(log[0].headers['content-length'], '0')

    // 4. Subsequent chunk PUTs started at the server's high-water mark,
    //    not byte 0.
    const chunkPuts = log.slice(1).filter((r) => r.method === 'PUT')
    assert.ok(chunkPuts.length > 0, 'expected at least one chunk PUT after the probe')
    const firstChunk = chunkPuts[0]
    const m = /bytes (\d+)-/.exec(firstChunk.headers['content-range'] || '')
    assert.ok(m, 'first chunk PUT should have a Content-Range header')
    assert.equal(Number(m![1]), 256 * 1024, 'first chunk should resume from 256 KB, not 0')

    // 5. The transient sidecar was cleared after the final 200.
    const afterSidecar = await resume.readResumeSidecar(proj.slug, 'EP001', 'youtube')
    assert.equal(afterSidecar, null, 'resume sidecar should be deleted after success')

    // 6. The user-facing log line surfaces the resume.
    const resumedLine = logLines.find((l) => l.includes('Resuming upload from byte'))
    assert.ok(resumedLine, `expected a "Resuming upload from byte" line in logLines, got: ${logLines.join('\n')}`)
  })

  test('can retain the resume record until a permanent video-id checkpoint is durable', async () => {
    const proj = await setupProject()
    const totalBytes = 1024 * 1024
    const filePath = path.join(tempDir, 'video-deferred.mp4')
    await fs.writeFile(filePath, Buffer.alloc(totalBytes, 0xef))

    const { server } = fakeYouTube({
      totalBytes,
      serverHasBytesAt: 256 * 1024,
      finalVideo: {
        id: 'vid_deferred_xyz',
        snippet: { title: 'deferred' },
        status: { privacyStatus: 'private' },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const sessionUrl = `http://127.0.0.1:${port}/upload?token=deferred`

    await resume.writeResumeSidecar(proj.slug, 'EP003', {
      platform: 'youtube',
      account_id: 'registry:UC_resume',
      file_path: filePath,
      file_size: totalBytes,
      session_url: sessionUrl,
      created_at: new Date().toISOString(),
      quota_charged: true,
    })

    try {
      const result = await yt.uploadVideo({
        slug: proj.slug,
        accountId: 'registry:UC_resume',
        filePath,
        snippet: { title: 'deferred' },
        status: { privacyStatus: 'private' },
        episodeCode: 'EP003',
        resumeFromSessionUrl: sessionUrl,
        deferResumeCleanup: true,
      })
      assert.equal(result.id, 'vid_deferred_xyz')
    } finally {
      server.close()
    }

    const retained = await resume.readResumeSidecar(proj.slug, 'EP003', 'youtube')
    assert.ok(retained, 'resume record must survive until the caller checkpoints the permanent video id')
  })

  test('clears sidecar and falls back to fresh init when session is gone (404)', async () => {
    const proj = await setupProject()
    const totalBytes = 1024 * 1024
    const filePath = path.join(tempDir, 'video2.mp4')
    await fs.writeFile(filePath, Buffer.alloc(totalBytes, 0xcd))

    // Fake "session is gone" — probe returns 404. The init POST that
    // follows succeeds, and chunk PUTs to the new session URL succeed.
    let goneServer: http.Server
    let initServer: http.Server

    // 1) The expired-session server: every request returns 404.
    goneServer = http.createServer((_req, res) => {
      res.writeHead(404); res.end('session gone')
    })
    await new Promise<void>((r) => goneServer.listen(0, '127.0.0.1', r))
    const gonePort = (goneServer.address() as AddressInfo).port
    const goneSessionUrl = `http://127.0.0.1:${gonePort}/upload?token=expired`

    await resume.writeResumeSidecar(proj.slug, 'EP002', {
      platform: 'youtube',
      account_id: 'registry:UC_resume',
      file_path: filePath,
      file_size: totalBytes,
      session_url: goneSessionUrl,
      created_at: new Date().toISOString(),
      quota_charged: true,
    })

    // 2) On 404, uploadVideo deletes the sidecar and tries fresh init.
    //    We can't easily redirect uploadVideo's UPLOAD_INIT_URL inside a
    //    test, so for THIS path we just verify the sidecar is cleared
    //    and a different (fresh-init-failed-because-test-network) error
    //    surfaces — that's enough to prove we took the fall-through.
    const logLines: string[] = []
    try {
      // Expect uploadVideo to throw when it tries to hit Google's real
      // init URL from a test environment with no network access — but
      // the sidecar should have been cleared FIRST.
      await assert.rejects(
        () => yt.uploadVideo({
          slug: proj.slug,
          accountId: 'registry:UC_resume',
          filePath,
          snippet: { title: 'fallback' },
          status: { privacyStatus: 'private' },
          episodeCode: 'EP002',
          resumeFromSessionUrl: goneSessionUrl,
          logLines,
        }),
      )
    } finally {
      goneServer.close()
    }

    // The sidecar must have been cleared by the RESUME_SESSION_GONE path
    // before falling through to the fresh init.
    const after = await resume.readResumeSidecar(proj.slug, 'EP002', 'youtube')
    assert.equal(after, null, 'sidecar should be cleared after RESUME_SESSION_GONE')

    const goneLine = logLines.find((l) => l.includes('expired'))
    assert.ok(goneLine, `expected "expired" log line, got: ${logLines.join('\n')}`)
  })
})
