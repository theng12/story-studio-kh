import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'

function expected(parts: Buffer[]): string {
  const digests = parts.map(part => createHash('sha256').update(part).digest('hex'))
  return `sha256:${createHash('sha256').update(JSON.stringify(digests)).digest('hex')}`
}

test('source hashing preserves multipart identity across streaming boundaries and same-size replacement', async t => {
  const temp = await useTempDataDir()
  try {
    const first = Buffer.alloc(9 * 1024 * 1024 + 3, 7)
    const second = Buffer.from('another part')
    const files = [path.join(temp.dir,'one.mp3'),path.join(temp.dir,'two.mp3')]
    await Promise.all(files.map((file,i)=>fs.writeFile(file,[first,second][i]!)))
    // A status read must not load whole source files into memory.
    const read = fs.readFile.bind(fs)
    t.mock.method(fs,'readFile',async (...args: any[]) => {
      assert.ok(!files.includes(String(args[0])), 'source audio must be streamed')
      return (read as any)(...args)
    })
    assert.equal(await hashSubtitleAudioSources(files),expected([first,second]))
    assert.equal(await hashSubtitleAudioSources([...files].reverse()),expected([second,first]))
    first[0] = 8
    await fs.writeFile(files[0]!,first)
    assert.equal(await hashSubtitleAudioSources(files),expected([first,second]))
  } finally { t.mock.restoreAll(); await temp.cleanup() }
})

test('source hashing retains empty-file identity and refuses absent or unreadable parts', async () => {
  const temp=await useTempDataDir()
  try {
    const file=path.join(temp.dir,'empty.mp3')
    await fs.writeFile(file,'')
    assert.equal(await hashSubtitleAudioSources([file]),expected([Buffer.alloc(0)]))
    assert.equal(await hashSubtitleAudioSources([]),null)
    assert.equal(await hashSubtitleAudioSources([file,path.join(temp.dir,'missing.mp3')]),null)
    assert.equal(await hashSubtitleAudioSources([temp.dir]),null)
  } finally {await temp.cleanup()}
})

test('an unchanged source file is hashed once; a replacement is hashed again', async t => {
  const temp = await useTempDataDir()
  const { default: fsSync } = await import('node:fs')
  const { syncBuiltinESMExports } = await import('node:module')
  try {
    const file = path.join(temp.dir, 'narration.mp3')
    await fs.writeFile(file, 'first take')
    const opened: string[] = []
    const real = fsSync.createReadStream
    t.mock.method(fsSync, 'createReadStream', (...args: any[]) => { opened.push(String(args[0])); return (real as any)(...args) })
    syncBuiltinESMExports()
    assert.equal(await hashSubtitleAudioSources([file]), expected([Buffer.from('first take')]))
    assert.equal(await hashSubtitleAudioSources([file]), expected([Buffer.from('first take')]))
    assert.equal(opened.length, 1, 'the second status read reuses the hash instead of re-reading the narration')
    const replacement = `${file}.tmp`
    await fs.writeFile(replacement, 'other take')
    await fs.rename(replacement, file)
    assert.equal(await hashSubtitleAudioSources([file]), expected([Buffer.from('other take')]))
    assert.equal(opened.length, 2, 'a same-size atomic replacement is read again')
  } finally { t.mock.restoreAll(); (await import('node:module')).syncBuiltinESMExports(); await temp.cleanup() }
})
