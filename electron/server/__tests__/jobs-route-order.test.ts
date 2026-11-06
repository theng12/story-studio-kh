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
  test('registers explicit POST cancellation routes and hides terminal jobs instead of deleting them', () => {
    const stack = (router as any).stack as Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>
    const hasRoute = (path: string, method: string) => stack.some(layer =>
      layer.route?.path === path && layer.route.methods?.[method] === true,
    )
    const hasTerminalDelete = (path: string) => stack.some(layer =>
      layer.route?.path === path && layer.route.methods?.delete === true,
    )

    assert.ok(hasRoute('/projects/:slug/jobs/:jobId/cancel', 'post'))
    assert.ok(hasRoute('/jobs/all/:jobId/cancel', 'post'))
    // `From List` is a restorable hide since 2026-11-02 (AGENTS.md: nothing is
    // deleted for good), so no route may delete a terminal job.
    assert.ok(hasRoute('/projects/:slug/jobs/:jobId/hide', 'post'))
    assert.ok(hasRoute('/jobs/all/:jobId/hide', 'post'))
    assert.ok(!hasTerminalDelete('/projects/:slug/jobs/:jobId'))
    assert.ok(!hasTerminalDelete('/jobs/all/:jobId'))
  })

  test('/jobs/all/stream is registered before the /jobs/all/:jobId routes', () => {
    const paths = routePaths()
    const streamIdx = paths.indexOf('/jobs/all/stream')
    // The universal job-id family is the POST control sub-routes; the bare
    // route went with terminal deletion. Match the family, so a future bare
    // route still has to register after the literal stream path.
    const jobIdIdx = paths.findIndex(path => path.startsWith('/jobs/all/:jobId'))

    assert.notEqual(streamIdx, -1, '/jobs/all/stream route must exist')
    assert.notEqual(jobIdIdx, -1, 'a /jobs/all/:jobId route must exist')
    assert.ok(streamIdx < jobIdIdx, 'the universal stream must not be shadowed by the job-id route')
  })

  test('literal bulk Resume routes are registered before job-id wildcards', () => {
    const paths = routePaths()
    const universalResumeIdx = paths.indexOf('/jobs/all/resume-paused')
    const universalJobIdx = paths.findIndex(path => path.startsWith('/jobs/all/:jobId'))
    const projectResumeIdx = paths.indexOf('/projects/:slug/jobs/resume-paused')
    const projectJobIdx = paths.indexOf('/projects/:slug/jobs/:jobId')

    assert.notEqual(universalResumeIdx, -1, 'the universal bulk Resume route must exist')
    assert.notEqual(projectResumeIdx, -1, 'the project bulk Resume route must exist')
    assert.ok(universalResumeIdx < universalJobIdx, 'the universal literal route must precede job-id routes')
    assert.ok(projectResumeIdx < projectJobIdx, 'the project literal route must precede job-id routes')
  })

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
