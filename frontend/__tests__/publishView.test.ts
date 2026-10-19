/**
 * Publish keeps its place in the URL (search, status chip, sort, rows shown),
 * and the Overview's "Needs you" rows open it already filtered. This pins the
 * URL ↔ view mapping; the page wiring is in uploadCenterPublish.test.ts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PUBLISH_PAGE, finalChecksRunning, readPublishView, writePublishView } from '../utils/publish-view.ts'

test('an empty URL is the default view: everything, newest first, one page', () => {
  assert.deepEqual(readPublishView({}), { q: '', status: 'all', sort: 'episode_newest', shown: PUBLISH_PAGE })
  assert.equal(PUBLISH_PAGE, 50)
})

test('a saved view comes back exactly', () => {
  assert.deepEqual(
    readPublishView({ q: 'harbor', status: 'attention', sort: 'schedule_soonest', shown: '150' }),
    { q: 'harbor', status: 'attention', sort: 'schedule_soonest', shown: 150 },
  )
})

test('a hand-edited URL cannot pick a status, sort or row count the page does not have', () => {
  const view = readPublishView({ status: 'failed', sort: 'title', shown: '73' })
  assert.equal(view.status, 'all')
  assert.equal(view.sort, 'episode_newest')
  assert.equal(view.shown, 100, 'rounded up to whole pages')
  assert.equal(readPublishView({ shown: '0' }).shown, 50)
  assert.equal(readPublishView({ shown: '-5' }).shown, 50)
})

test('the Jobs deep link still seeds the search, and q wins when both are present', () => {
  assert.equal(readPublishView({ episode_id: 'EP0007' }).q, 'EP0007')
  assert.equal(readPublishView({ episode_id: 'EP0007', q: 'EP0009' }).q, 'EP0009')
})

test('writing leaves defaults out, keeps unrelated keys, and replaces episode_id with q', () => {
  assert.deepEqual(
    writePublishView({ episode_id: 'EP0007', tab: 'x' }, { q: 'EP0007', status: 'all', sort: 'episode_newest', shown: 50 }),
    { tab: 'x', q: 'EP0007' },
  )
  assert.deepEqual(
    writePublishView({}, { q: '', status: 'in_progress', sort: 'status', shown: 100 }),
    { status: 'in_progress', sort: 'status', shown: '100' },
  )
  const view = { q: 'moon', status: 'missed', sort: 'episode_oldest', shown: 200 } as const
  assert.deepEqual(readPublishView(writePublishView({}, view)), view, 'round trip')
})

test('the page reloads while a Final Check is measuring, and stops when it is done', () => {
  const row = (final_check?: unknown) => ({ episode_code: 'EP0001', final_check })
  assert.equal(finalChecksRunning([row({ running: true, checked: false })]), true)
  assert.equal(finalChecksRunning([row({ running: false, checked: true })]), false)
  assert.equal(
    finalChecksRunning([row({ running: false }), row({ running: true })]), true,
    'one row still checking is enough to keep reloading',
  )
  assert.equal(finalChecksRunning([row(), row(undefined)]), false, 'a row with no verdict is not a running check')
  assert.equal(finalChecksRunning([]), false)
})
