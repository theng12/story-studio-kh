/**
 * A narration file that lists a chapter twice (EP0003/4/5, 2026-10-12: every
 * chapter doubled) is made as one section per chapter, and a request that
 * names a chapter twice makes it once. Before: 13 sections for 7 chapters, the
 * same files written twice, then activation refused.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { selectNarrationSections } from '../services/tts-request-plan.js'

void test('duplicate chapters collapse to the first, in the script and in the request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narration-dup-'))
  const file = path.join(dir, 'EP001_Script_Narration.md')
  await fs.writeFile(file, [
    '# Introduction', 'Welcome in.',
    '# Narration', '## Chapter 1: One', 'First take.',
    '## Chapter 2: Two', 'Second chapter.',
    '## Chapter 1: One', 'Second take.',
  ].join('\n\n'))
  const sections = await parseNarrationDocx(file)
  assert.deepEqual(sections.map(s => [s.slug, s.text]), [['Introduction', 'Welcome in.'], ['Chapter_01', 'First take.'], ['Chapter_02', 'Second chapter.']])
  const doubled = [...sections, { ...sections[1]!, text: 'again' }]
  assert.deepEqual(selectNarrationSections(doubled, 'all').map(s => s.slug), ['Introduction', 'Chapter_01', 'Chapter_02'])
  assert.deepEqual(selectNarrationSections(doubled, '1,01,Chapter_01').map(s => s.text), ['First take.'])
  await fs.rm(dir, { recursive: true, force: true })
})
