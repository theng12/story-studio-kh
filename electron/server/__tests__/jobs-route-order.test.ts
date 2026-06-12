import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { router } from '../routes/jobs.js'

// Route-ORDER regression guard.
//
// Express dispatches routes in registration order. `/jobs/app/stream` (the
// SSE endpoint the app-jobs panel subscribes to) MUST be registered BEFORE
// the wildcard `/jobs/app/:jobId`, or `:jobId` swallows the literal "stream"
// segment, the stream request 404s, and EventSource falls into a ~5s retry
// loop. The jobs router carries a reserved-word guard as a runtime backstop,
// but this test pins the invariant at the structural level so a reorder
// fails loudly in CI instead of silently in production.

function routePaths(): string[] {
  // Express 5 router: each route layer exposes `.route.path`.
  const stack = (router as any).stack as Array<{ route?: { path?: string } }>
  return stack.filter(l => l.route?.path).map(l => l.route!.path as string)
}

describe('jobs router registration order', () => {
  test('/jobs/app/stream is registered before /jobs/app/:jobId', () => {
    const paths = routePaths()
    const streamIdx = paths.indexOf('/jobs/app/stream')
    const jobIdIdx = paths.indexOf('/jobs/app/:jobId')

    assert.notEqual(streamIdx, -1, '/jobs/app/stream route must exist')
    assert.notEqual(jobIdIdx, -1, '/jobs/app/:jobId route must exist')
    assert.ok(
      streamIdx < jobIdIdx,
      `/jobs/app/stream (idx ${streamIdx}) must register BEFORE /jobs/app/:jobId ` +
      `(idx ${jobIdIdx}) or the SSE stream 404-loops`,
    )
  })
})
