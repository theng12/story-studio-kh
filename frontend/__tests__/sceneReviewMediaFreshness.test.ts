/**
 * Scene Review media freshness (v1.4.152).
 *
 * Owner report 2026-09-12: Scene Review "loads slowly and feels clunky".
 * Measured cause: a page-wide cache-buster changed on every 3.5 s render poll,
 * so every visible <img> was re-keyed and re-fetched (71 requests per image in
 * one session), and a fixed interval kept firing while a 2–5 s read was still
 * in flight. This pins the replacement contract; the browser-side effect (an
 * unchanged element keeps its bytes) is verified by hand, see the changelog.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const source = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)), 'utf8')

describe('Scene Review media freshness', () => {
  test('every media URL carries its own asset version, not a page-wide timestamp', () => {
    assert.match(source, /scene-review\/\$\{episodeId\.value\}\/image\/\$\{scene\.id\}\?v=\$\{mediaVersion\(scene\.image_version\)\}/)
    // Clip URLs live in Motion Review; Scene Review's unused clip URL was removed with its dead animate code.
    assert.match(source, /scene-review\/\$\{episodeId\.value\}\/audio\?v=\$\{mediaVersion\(audioVersion\.value\)\}/)
    assert.doesNotMatch(source, /cacheBuster/)
    assert.doesNotMatch(source, /\?t=\$\{Date\.now\(\)\}/)
  })

  test('the thumbnail element is keyed on the image version, so an unchanged image keeps its element', () => {
    assert.match(source, /function imageKey\(scene: ReviewScene\): string \{\s*return `\$\{scene\.id\}:\$\{scene\.image_version \|\| ''\}`/)
    assert.match(source, /:src="thumbUrl\(scene\)"\s*:key="imageKey\(scene\)"/)
    assert.match(source, /audioVersion\.value = r\.audio_version \?\? null/)
  })

  test('the render poll is single-flight: armed after the previous read settles, never a fixed interval', () => {
    assert.doesNotMatch(source, /setInterval\(/)
    assert.match(source, /function armRenderPoll\(\): void \{[\s\S]*?setTimeout\(async \(\) => \{[\s\S]*?try \{ await loadReview\(\) \} finally \{ armRenderPoll\(\) \}/)
    assert.match(source, /watch\(isRendering, \(active\) => \{[\s\S]*?stopRenderPoll\(\)\s*void loadReview\(\)/)
    assert.match(source, /onBeforeUnmount\(\(\) => \{\s*pageUnmounted = true\s*stopRenderPoll\(\)/)
  })
})
