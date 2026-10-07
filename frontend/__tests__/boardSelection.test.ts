import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { episodesFromQuery, hideFinished, pipelineLinkFor, selectShown } from '../utils/board-selection.js'

const board = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/board.vue', import.meta.url)), 'utf8')
const pipeline = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)), 'utf8')

test('Select Shown adds every shown row to the selection without dropping earlier picks', () => {
  const next = selectShown(new Set(['EP0009']), [{ episode_code: 'EP0001' }, { episode_code: 'EP0002' }])
  assert.deepEqual([...next].sort(), ['EP0001', 'EP0002', 'EP0009'])
  assert.deepEqual([...selectShown(new Set(), [])], [])
})

test('hideFinished counts exactly the finished rows it hid', () => {
  const rows = [{ done: true }, { done: false }, { done: true }]
  assert.deepEqual(hideFinished(rows, true, row => row.done), { rows: [{ done: false }], hidden: 2 })
  assert.deepEqual(hideFinished(rows, false, row => row.done), { rows, hidden: 0 })
  assert.deepEqual(hideFinished([{ done: false }], true, row => row.done).hidden, 0)
})

test('Open in Pipeline link and the Pipeline reader agree on the episode list', () => {
  const link = pipelineLinkFor('kh-boundless', new Set(['EP0002', 'EP0001']))
  assert.equal(link, '/projects/kh-boundless/pipeline?episodes=EP0001,EP0002')
  assert.deepEqual(episodesFromQuery(new URL(link, 'http://x').searchParams.get('episodes')), ['EP0001', 'EP0002'])
  assert.deepEqual(episodesFromQuery(['EP1,EP2', ' EP2 ', '']), ['EP1', 'EP2'])
  assert.deepEqual(episodesFromQuery(undefined), [])
  assert.equal(pipelineLinkFor('s', []), '/projects/s/pipeline')
})

test('Board wires selection, scoped retry, hidden-finished note, freshness and keep-place', () => {
  assert.match(board, /class="ep-select"[\s\S]*?@change="toggleSelected\(ep\.episode_code\)"/)
  assert.match(board, /@click="selected = selectShown\(selected, visibleEpisodes\)"[\s\S]*?Select Shown \(\{\{ visibleEpisodes\.length \}\}\)/)
  assert.match(board, /Retry Failed \(\$\{selectionFailedCells\.size\}\)/)
  assert.match(board, /boardRetryPlan\(jobs\.value as any\[\], selectionFailedCells\.value/)
  assert.match(board, /await ask\(\{\s*title: 'Retry failed steps\?'/)
  assert.match(board, /Paid work is included, so this may use credits\./)
  assert.match(board, /:to="pipelineLinkFor\(slug, selected\)"[^>]*>Open in Pipeline</)
  assert.match(board, /Hiding \{\{ hiddenFinishedCount \}\} finished episode[\s\S]*?@click="needsWorkOnly = false">Show Them</)
  assert.match(board, /<UpdatedAgo\s+:at="loadedAt"[\s\S]*?@refresh="onRefreshClick"/)
  assert.match(board, /const place = readQueryState\(route\.query, PLACE\)/)
  assert.match(board, /router\.currentRoute\.value\.path === route\.path && !sameQuery\(query, route\.query\)\) void router\.replace\(\{ query \}\)/)
  // Owner wording: a channel, not a project; Title Case buttons.
  assert.doesNotMatch(board, /this project/)
  assert.match(board, /Needs Work Only/)
  assert.match(board, /Failed Only \(/)
})

test('Pipeline honours ?episodes=, keeps its place and keeps Run Batch in view', () => {
  assert.match(pipeline, /const linkedEpisodes = episodesFromQuery\(route\.query\.episodes\)/)
  assert.match(pipeline, /delete query\.episodes/)
  assert.match(pipeline, /const searchQuery = ref\(place\.search\)/)
  assert.match(pipeline, /const currentPage = ref\(place\.page\)/)
  assert.match(pipeline, /class="pipeline-sticky-run"[\s\S]*?Run Batch \(\$\{selectedEpisodes\.size\}\)/)
  assert.match(pipeline, /\.pipeline-sticky-run \{\s*position: sticky;\s*bottom: 12px;/)
  assert.match(pipeline, /<UpdatedAgo\s+:at="episodesLoadedAt"[\s\S]*?@refresh="onRefreshClick"/)
  assert.doesNotMatch(pipeline, /this project/)
})
