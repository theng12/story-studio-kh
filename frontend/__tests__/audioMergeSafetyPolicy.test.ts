import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const page = readFileSync(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url), 'utf8')

test('Audio Assembly follows chapter-audio policy without permitting an empty merge', async () => {
  const start = page.indexOf('function canMergeChapterAudio(')
  assert.notEqual(start, -1, 'the page needs one policy helper shared by its button and tests')
  const end = page.indexOf('\n}', start) + 2
  assert.ok(end > start)
  const compiled = await transform(page.slice(start, end), { loader: 'ts', format: 'esm' })
  const canMerge = new Function(`${compiled.code}; return canMergeChapterAudio`)() as (
    readiness: { ready?: boolean; present_files?: string[] } | null,
    mode: 'off' | 'warn' | 'block',
  ) => boolean

  assert.equal(canMerge({ ready: true, present_files: ['EP001_Chapter_01.mp3'] }, 'block'), true)
  assert.equal(canMerge({ ready: false, present_files: ['EP001_Chapter_01.mp3'] }, 'warn'), true)
  assert.equal(canMerge({ ready: false, present_files: ['EP001_Chapter_01.mp3'] }, 'off'), true)
  assert.equal(canMerge({ ready: false, present_files: ['EP001_Chapter_01.mp3'] }, 'block'), false)
  assert.equal(canMerge({ ready: false, present_files: [] }, 'warn'), false)
  assert.equal(canMerge({ ready: false, present_files: [] }, 'off'), false)

  assert.match(page, /:disabled="!chapterAudioCanMerge \|\| mergeStatus\.loading/)
  assert.match(page, /chapterAudioPolicyMessage/)
})
