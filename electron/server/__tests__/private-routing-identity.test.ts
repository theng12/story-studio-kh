/**
 * The backend must not serialise a private routing identity into anything the
 * customer can read: an HTTP response body, a job result, a job output line,
 * or an error message that reaches the Jobs page.
 *
 * The recurring source is a `.task-manifest.json` written before the
 * GenStudio-only migration (v1.0.669). Those entries still record the transport
 * that served each task — an upstream aggregator, or a direct-vendor key. The
 * manifests are audit evidence and are deliberately left on disk untouched;
 * what these tests pin is that the repair paths stop echoing them back.
 *
 * Source assertions, in the same shape as legacy-network-boundary: the leak is
 * one field on an object literal, which a behavioural test of the repair result
 * happily passes over.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const read = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  'utf8',
)

describe('repair results carry the task id, not the transport that produced it', () => {
  test('image reconciler outcomes do not include a provider field', () => {
    const source = read('../services/image-reconciler.ts')
    assert.equal(source.includes('provider: entry.provider'), false,
      'image reconciler copies the manifest provider into an outcome that reaches job.result')
    assert.match(source, /entry\.provider === 'genstudio/)
  })

  test('the image repair-status items expose recoverability, not a provider', () => {
    const source = read('../services/image-reconciler.ts')
    assert.equal(source.includes('task_id: entry.task_id, provider: entry.provider'), false,
      'GET /episodes/:code/images-repair-status returns these items verbatim')
  })
})

describe('legacy-evidence messages describe the situation without naming a route', () => {
  test('the image reason does not interpolate the manifest provider', () => {
    const source = read('../services/image-reconciler.ts')
    assert.equal(source.includes('Legacy ${entry.provider}'), false)
    assert.match(source, /Legacy task evidence was preserved/)
  })

  test('the audio repair log does not interpolate the manifest provider', () => {
    const source = read('../services/audio-reconciler.ts')
    assert.equal(source.includes('Legacy ${entry.provider'), false,
      'result.logs is returned straight to the customer by POST /audio-repair')
    assert.match(source, /Legacy evidence is read-only/)
  })
})

describe('user-facing errors name the gateway or nobody', () => {
  test('the unavailable-video-model error does not list the retired fallbacks', () => {
    const source = read('../generators/scene-clip.ts')
    assert.equal(/no fal\.ai, Kie\.ai, or Studio Hub fallback/.test(source), false)
    assert.match(source, /VIDEO_MODEL_UNAVAILABLE_MESSAGE/)
  })
})

describe('the provider registry names only the gateway', () => {
  for (const relative of [
    '../providers/text/genstudio.ts',
    '../providers/image/genstudio.ts',
    '../providers/video/genstudio.ts',
  ]) {
    test(`${relative} publishes 'Gateway' as its display name`, () => {
      // `meta.name` is interpolated into job output lines and into
      // "No API key configured for X" — it is a rendered string.
      assert.match(read(relative), /name: 'Gateway'/)
    })
  }
})
