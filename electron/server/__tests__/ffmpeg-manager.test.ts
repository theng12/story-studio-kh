/**
 * Tests for ffmpeg-manager: path resolution order, status detection, zip extraction.
 * Note: we do NOT test actual network downloads here — those require real evermeet.cx.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let ff: typeof import('../services/ffmpeg-manager.js')
let settings: typeof import('../services/app-settings.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  // Import after env var is set
  settings = await import('../services/app-settings.js')
  ff = await import('../services/ffmpeg-manager.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  // Reset app-settings and ffmpeg dir between tests
  await fs.rm(path.join(tempDir, 'app-settings.json'), { force: true })
  await fs.rm(path.join(tempDir, 'ffmpeg'), { recursive: true, force: true })
  delete process.env.STORY_STUDIO_RESOURCES_DIR
  ff.clearFFmpegCache()
})

describe('getFFmpegPath() resolution order', () => {
  test('release bundle wins over a stale saved or app-data binary', async () => {
    const resourcesDir = path.join(tempDir, 'release-resources')
    const bundledPath = path.join(resourcesDir, 'ffmpeg', 'ffmpeg')
    const customPath = path.join(tempDir, 'custom-ffmpeg')
    const localPath = path.join(tempDir, 'ffmpeg', 'ffmpeg')
    await fs.mkdir(path.dirname(bundledPath), { recursive: true })
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await fs.writeFile(bundledPath, '#!/bin/sh\necho bundled\n')
    await fs.writeFile(customPath, '#!/bin/sh\necho custom\n')
    await fs.writeFile(localPath, '#!/bin/sh\necho local\n')
    await Promise.all([
      fs.chmod(bundledPath, 0o755),
      fs.chmod(customPath, 0o755),
      fs.chmod(localPath, 0o755),
    ])
    await settings.setAppSetting('ffmpeg_path', customPath)
    process.env.STORY_STUDIO_RESOURCES_DIR = resourcesDir

    ff.clearFFmpegCache()
    assert.equal(await ff.getFFmpegPath(), bundledPath)
  })

  test('bundled ffprobe also wins over a stale saved path', async () => {
    const resourcesDir = path.join(tempDir, 'release-resources')
    const bundledPath = path.join(resourcesDir, 'ffmpeg', 'ffprobe')
    const customPath = path.join(tempDir, 'custom-ffprobe')
    await fs.mkdir(path.dirname(bundledPath), { recursive: true })
    await fs.writeFile(bundledPath, '#!/bin/sh\necho bundled\n')
    await fs.writeFile(customPath, '#!/bin/sh\necho custom\n')
    await Promise.all([fs.chmod(bundledPath, 0o755), fs.chmod(customPath, 0o755)])
    await settings.setAppSetting('ffprobe_path', customPath)
    process.env.STORY_STUDIO_RESOURCES_DIR = resourcesDir

    ff.clearFFmpegCache()
    assert.equal(await ff.getFFprobePath(), bundledPath)
  })

  test('respects custom path from app settings first', async () => {
    // Create a fake binary at a custom path
    const customPath = path.join(tempDir, 'custom-ffmpeg')
    await fs.writeFile(customPath, '#!/bin/sh\necho v1\n')
    await fs.chmod(customPath, 0o755)
    await settings.setAppSetting('ffmpeg_path', customPath)

    ff.clearFFmpegCache()
    const resolved = await ff.getFFmpegPath()
    assert.equal(resolved, customPath)
  })

  test('uses app-data binary when custom not set', async () => {
    const ffmpegDir = path.join(tempDir, 'ffmpeg')
    await fs.mkdir(ffmpegDir, { recursive: true })
    const localBin = path.join(ffmpegDir, 'ffmpeg')
    await fs.writeFile(localBin, '#!/bin/sh\necho v1\n')
    await fs.chmod(localBin, 0o755)

    ff.clearFFmpegCache()
    const resolved = await ff.getFFmpegPath()
    assert.equal(resolved, localBin)
  })

  test('falls back to common install locations or system PATH', async () => {
    // No custom path, no app-data binary
    ff.clearFFmpegCache()
    const resolved = await ff.getFFmpegPath()
    // On dev machines, ffmpeg is typically installed via Homebrew
    // If installed: resolved is an absolute path. If not: 'ffmpeg' (literal).
    assert.ok(
      resolved === 'ffmpeg' ||
      resolved.includes('/bin/ffmpeg') ||
      path.isAbsolute(resolved),
      `expected absolute path or 'ffmpeg', got: ${resolved}`,
    )
  })

  test('caches resolved path (same result on repeat calls)', async () => {
    const localBin = path.join(tempDir, 'ffmpeg', 'ffmpeg')
    await fs.mkdir(path.dirname(localBin), { recursive: true })
    await fs.writeFile(localBin, 'x')
    await fs.chmod(localBin, 0o755)
    ff.clearFFmpegCache()

    const r1 = await ff.getFFmpegPath()
    const r2 = await ff.getFFmpegPath()
    assert.equal(r1, r2)
  })
})

describe('getFFmpegStatus()', () => {
  test('returns installed=true when ffmpeg runs successfully', async () => {
    // This test assumes ffmpeg is installed on the dev machine.
    // Skip if we can't find it (common install path or PATH).
    const status = await ff.getFFmpegStatus()
    if (!status.installed) {
      // Treat as skipped
      console.warn('  [skip] ffmpeg not installed on test machine')
      return
    }
    assert.equal(status.installed, true)
    assert.ok(status.version, 'should report a version')
    assert.ok(['bundled', 'app-data', 'system'].includes(status.source), `unexpected source: ${status.source}`)
  })

  test('returns installed=false for invalid binary', async () => {
    // Point to a non-executable file
    const badPath = path.join(tempDir, 'not-ffmpeg')
    await fs.writeFile(badPath, 'this is not a binary')
    await settings.setAppSetting('ffmpeg_path', badPath)
    ff.clearFFmpegCache()

    const status = await ff.getFFmpegStatus()
    assert.equal(status.installed, false)
    assert.equal(status.source, 'not-found')
  })
})

describe('runFfmpeg() wall-clock watchdog', () => {
  test('fires SIGTERM after timeoutMs and surfaces "watchdog" error', async () => {
    // Use `sleep` as the stand-in "ffmpeg" — it blocks indefinitely the
    // same way a pathological FFmpeg input would, but is deterministic
    // and doesn't require a real ffmpeg install. The goal is to prove
    // the timer fires and the error message disambiguates from a normal
    // cancel (which uses "FFmpeg killed (SIGTERM)" instead).
    await settings.setAppSetting('ffmpeg_path', '/bin/sleep')
    ff.clearFFmpegCache()

    const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
    const start = Date.now()
    await assert.rejects(
      () => runFfmpeg(['30'], { timeoutMs: 500 }),
      (err: Error) => {
        assert.match(err.message, /watchdog/)
        return true
      },
    )
    const elapsed = Date.now() - start
    // Should die right around the timeout, not after sleep 30 finishes.
    assert.ok(elapsed < 10_000, `expected <10s, took ${elapsed}ms`)
  })
})
