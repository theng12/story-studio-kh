/**
 * Archive sweep: a failed copy must not block its own retry, and proving an upload must not read a
 * file that cannot be matched by content.
 *
 * - A copy that died half-way (full disk, unplugged drive, crash) used to sit under the REAL name,
 *   and the next run answered "a file named X is already in the archive folder" forever.
 * - `youtubeArchiveProofForFile` hashed the whole final first, even when the only evidence was a
 *   legacy sidecar that carries no hash — 3 extra full reads of every such video per archive run.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => { tmp = await useTempDataDir() })
after(async () => { await tmp.cleanup() })

describe('youtubeArchiveProofForFile', () => {
  test('a legacy-sidecar proof never opens the file for reading', async () => {
    const { youtubeArchiveProofForFile } = await import('../services/youtube-remote-video.js')
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'proof-')), 'EP0001_final_video.mp4')
    await fs.writeFile(file, 'video bytes')
    await fs.chmod(file, 0o000) // stat still works; any read would throw EACCES
    try {
      const uploadedAt = new Date(Date.now() + 60_000).toISOString()
      const proof = await youtubeArchiveProofForFile({
        accepted_operations: [], ready_operations: [],
        legacy_sidecar: { video_id: 'abc123', uploaded_at: uploadedAt },
      }, file)
      assert.deepEqual(proof, { usable: true, video_id: 'abc123' })
      const none = await youtubeArchiveProofForFile({ accepted_operations: [], ready_operations: [] }, file)
      assert.equal(none.usable, false)
    } finally {
      await fs.chmod(file, 0o644)
    }
  })

  test('a content-hash receipt still matches only the exact bytes', async () => {
    const { youtubeArchiveProofForFile } = await import('../services/youtube-remote-video.js')
    const { resolveYouTubeSourceRevision } = await import('../services/youtube-source-video.js')
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'proof-')), 'EP0002_final_video.mp4')
    await fs.writeFile(file, 'the uploaded bytes')
    const revision = await resolveYouTubeSourceRevision(file)
    const evidence = (source_revision: string) => ({
      accepted_operations: [],
      ready_operations: [{ operation_id: 'op', video_id: 'vid', source_revision, channel_id: 'ch' }],
    })
    assert.deepEqual(await youtubeArchiveProofForFile(evidence(revision), file), { usable: true, video_id: 'vid' })
    assert.equal((await youtubeArchiveProofForFile(evidence(`sha256:${'0'.repeat(64)}`), file)).usable, false)
  })
})
