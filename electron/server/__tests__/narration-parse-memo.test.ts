import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { _clearNarrationParseCache, parseNarrationDocx } from '../lib/docx-parser.js'
import { useTempDataDir } from './_helpers.js'

// S2: the narration file is parsed once per (path, mtime, size), not per request.
test('parseNarrationDocx reuses a parse until the file changes, and hands out clones', async () => {
  const temp = await useTempDataDir()
  const file = path.join(temp.dir, 'EP0001_narration.md')
  const write = (word: string) => fs.writeFile(file, `# Introduction\n\n${word} begins here.\n\n## Chapter 1: One\n\nText.\n`)
  _clearNarrationParseCache()
  await write('Alpha')
  const stamp = new Date('2026-10-01T00:00:00Z')
  await fs.utimes(file, stamp, stamp)
  const first = await parseNarrationDocx(file)
  assert.match(first[0]!.text, /Alpha/)

  // Same size and mtime: served from the memo (proves no re-parse).
  await write('Bravo')
  await fs.utimes(file, stamp, stamp)
  const memo = await parseNarrationDocx(file)
  assert.match(memo[0]!.text, /Alpha/)

  // A caller editing its copy cannot poison the memo.
  memo[0]!.text = 'edited'
  assert.match((await parseNarrationDocx(file))[0]!.text, /Alpha/)

  // Any edit that moves mtime is a miss.
  const later = new Date('2026-10-02T00:00:00Z')
  await fs.utimes(file, later, later)
  assert.match((await parseNarrationDocx(file))[0]!.text, /Bravo/)
  await temp.cleanup()
})
