/**
 * The interactive source-revision cache (v1.4.152).
 *
 * Upload Center's Review click hashed the whole rendered final (Upload no
 * longer does — see the source-scan test at the bottom). This pins the two
 * properties that make remembering the hash safe: the cached answer IS the
 * byte-for-byte digest, and any change to the file's size, mtime or inode
 * re-reads every byte. The uncached function is the one every delete/move/
 * archive path still calls; it must keep hashing.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  __clearSourceRevisionCacheForTests,
  resolveYouTubeSourceRevision,
  resolveYouTubeSourceRevisionCached,
  resolveYouTubeSourceRevisionFromHandle,
} from '../services/youtube-source-video.js'

let dir: string
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-revision-cache-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

function sha256(bytes: Buffer): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

describe('YouTube source revision cache', () => {
  test('the digest is the plain sha256 of the file, in every read mode, across chunk boundaries', async () => {
    __clearSourceRevisionCacheForTests()
    // Larger than one 4 MiB read chunk, so the chunked loop is exercised.
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 123)
    for (let i = 0; i < bytes.length; i += 7919) bytes[i] = i & 0xff
    const file = path.join(dir, 'chunked.mp4')
    await fs.writeFile(file, bytes)
    const expected = sha256(bytes)
    assert.equal(await resolveYouTubeSourceRevision(file), expected)
    assert.equal(await resolveYouTubeSourceRevisionCached(file), expected)
    const handle = await fs.open(file, 'r')
    try { assert.equal(await resolveYouTubeSourceRevisionFromHandle(handle), expected) } finally { await handle.close() }
  })

  test('an unchanged file is hashed once and served from the cache; a replaced file is re-read', async () => {
    __clearSourceRevisionCacheForTests()
    const file = path.join(dir, 'final.mp4')
    await fs.writeFile(file, Buffer.from('first render bytes'))
    const first = await resolveYouTubeSourceRevisionCached(file)
    assert.equal(first, sha256(Buffer.from('first render bytes')))
    // Same promise object: the second call did not start another read.
    const again = resolveYouTubeSourceRevisionCached(file)
    assert.equal(await again, first)

    // Atomic replacement (new inode) with the same byte length.
    const tmp = path.join(dir, 'final.mp4.tmp')
    await fs.writeFile(tmp, Buffer.from('later render bytes'))
    await fs.rename(tmp, file)
    const replaced = await resolveYouTubeSourceRevisionCached(file)
    assert.equal(replaced, sha256(Buffer.from('later render bytes')))
    assert.notEqual(replaced, first)

    // In-place rewrite, same length, mtime moves forward.
    await fs.writeFile(file, Buffer.from('third render bytes'))
    const future = new Date(Date.now() + 5_000)
    await fs.utimes(file, future, future)
    assert.equal(await resolveYouTubeSourceRevisionCached(file), sha256(Buffer.from('third render bytes')))
  })

  test('concurrent callers share one in-flight hash, and a missing file is never remembered', async () => {
    __clearSourceRevisionCacheForTests()
    const file = path.join(dir, 'shared.mp4')
    await fs.writeFile(file, Buffer.from('shared bytes'))
    const [a, b, c] = await Promise.all([
      resolveYouTubeSourceRevisionCached(file),
      resolveYouTubeSourceRevisionCached(file),
      resolveYouTubeSourceRevisionCached(file),
    ])
    assert.equal(a, b)
    assert.equal(b, c)

    const missing = path.join(dir, 'missing.mp4')
    await assert.rejects(resolveYouTubeSourceRevisionCached(missing))
    await fs.writeFile(missing, Buffer.from('now present'))
    assert.equal(await resolveYouTubeSourceRevisionCached(missing), sha256(Buffer.from('now present')))
  })

  test('manual upload carries its reviewed revision, automatic admission hashes, and the job re-hashes', async () => {
    const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf8')
    const center = await read('../routes/youtube-upload-center.ts')
    const previewStart = center.indexOf("router.post('/projects/:slug/youtube/preview'")
    const uploadStart = center.indexOf('export async function admitYouTubeUpload(')
    const uploadEnd = center.indexOf("router.post('/projects/:slug/youtube/upload'", uploadStart)
    assert.ok(previewStart > 0 && uploadStart > previewStart && uploadEnd > uploadStart)
    // Preview is an explicit Review click: hashing there is what the owner reviews.
    assert.match(center.slice(previewStart, uploadStart), /resolveYouTubeSourceRevisionCached\(sourcePath\)/)
    // Only automatic uploads hash on admission; manual uploads carry the revision reviewed in Preview.
    const admission = center.slice(uploadStart, uploadEnd)
    assert.match(admission, /automatic\s*\? await resolveYouTubeSourceRevisionCached\(sourceVideoPath\)/)
    assert.match(admission, /expected_source_revision: reviewedSourceRevision/)
    // 1.4.289: Clear Uploaded Videos and Free up space only MOVE a final to Story's Trash (undoable), so the
    // match with its upload is read once and re-checked by size, mtime and inode (it read each final three times).
    const remote = await read('../services/youtube-remote-video.ts')
    const archiveProof = remote.slice(remote.indexOf('export async function youtubeArchiveProofForFile'))
    assert.match(archiveProof.slice(0, archiveProof.indexOf('\n}\n')), /await resolveYouTubeSourceRevision\(filePath\)/, 'archiving (which removes the original) re-reads every byte')
    assert.doesNotMatch(await read('../generators/youtube-upload.ts'), /resolveYouTubeSourceRevisionCached/, 'the upload hashes the bytes it sends')
    // The upload generator still hashes the open handle it sends from, and the
    // route hands it the revision the owner reviewed to compare that against.
    assert.match(await read('../generators/youtube-upload.ts'), /resolveYouTubeSourceRevisionFromHandle\(sourceHandle\)/)
    assert.match(await read('../generators/youtube-upload.ts'), /params\.expected_source_revision && sourceRevision !== params\.expected_source_revision/)
  })
})
