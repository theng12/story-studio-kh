import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const episodes = read('../composables/useEpisodes.ts')
const selector = read('../components/EpisodeSelector.vue')
const pipeline = read('../pages/projects/[slug]/pipeline.vue')
const board = read('../pages/projects/[slug]/board.vue')

test('local media cleanup is presentation metadata, never an asset-completion override', () => {
  assert.match(episodes, /local_media_status\?: LocalMediaCleanupStatus \| null/)
  assert.match(episodes, /state: 'available' \| 'archived' \| 'partially_removed' \| 'removed'/)
  assert.match(episodes, /function localMediaStatusLabel\(status: LocalMediaCleanupStatus \| null \| undefined\): string/)
  assert.match(episodes, /return 'Local sources removed'/)
  assert.match(episodes, /return 'Sources archived'/)
  assert.match(selector, /localMediaStatusLabel\(ep\.local_media_status\)/)
  assert.match(pipeline, /localMediaStatusLabel\(ep\.local_media_status\)/)
  assert.match(board, /localMediaStatusLabel\(ep\.local_media_status\)/)
  assert.doesNotMatch(episodes, /all_done: .*local_media_status/s)
})
