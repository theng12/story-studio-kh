/**
 * v1.2.9 — every `/video-editor/preview-image` URL must carry a cache-busting
 * parameter, and every consumer must change that parameter when the bytes
 * behind the path can change.
 *
 * The bug this file exists to prevent (owner-reported, 2026-08-17): the
 * Thumbnail Generator's row thumbnail busted correctly, the enlarged preview
 * did not, and regenerating a thumbnail left the large preview showing the
 * previous artwork until the app was restarted.
 *
 * Why a source-text test rather than a rendering one: the failure is in the
 * BROWSER's in-memory image cache, which no test runner has. Verified in a
 * real browser — an `<img>` destroyed and recreated with a byte-identical
 * `src` is served from memory with NO request reaching the server at all, so
 * the route's `Cache-Control: no-cache` and its ETag are both powerless. The
 * only defence is that the URL differs, and that is exactly what these
 * assertions pin. See AGENTS.md, "Bugs The Gates Cannot See".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const lightbox = read('../components/ImagePreviewLightbox.vue')
const row = read('../components/ImageGeneratorRow.vue')
const panel = read('../components/ImageGeneratorPanel.vue')
const images = read('../pages/projects/[slug]/images.vue')
const videoAssembly = read('../pages/projects/[slug]/video-assembly.vue')
const imagePrompts = read('../pages/projects/[slug]/image-prompts.vue')

/** Every consumer, so a new one cannot be added without a decision here. */
const CONSUMERS: Array<[name: string, source: string]> = [
  ['ImagePreviewLightbox.vue', lightbox],
  ['ImageGeneratorRow.vue', row],
  ['images.vue', images],
  ['video-assembly.vue', videoAssembly],
  ['image-prompts.vue', imagePrompts],
]

describe('preview-image cache busting', () => {
  test('every preview-image URL carries a cache-busting parameter', () => {
    for (const [name, source] of CONSUMERS) {
      const urls = source.match(/video-editor\/preview-image\?[^`'"]*/g) || []
      assert.ok(urls.length > 0, `${name} should still build a preview-image URL`)
      for (const url of urls) {
        assert.match(
          url,
          /[?&](k|v)=\$\{/,
          `${name} builds a preview-image URL with no cache-buster: ${url}`,
        )
      }
    }
  })

  test('the lightbox takes a version and puts it in both the URL and the <img> key', () => {
    // The URL alone is not enough: Vue patches the `src` attribute in place
    // unless the element's key changes, and a patched attribute can still be
    // satisfied from the browser's decoded-image cache.
    assert.match(lightbox, /version\?: number \| string/)
    assert.match(lightbox, /renderKey = computed\(\(\) => `\$\{currentImage\.value\?\.path \?\? ''\}#\$\{props\.version\}`\)/)
    assert.match(lightbox, /:key="renderKey"/)
    assert.match(lightbox, /preview-image\?path=\$\{encodeURIComponent\(c\.path\)\}&v=/)
  })

  test('the lightbox keeps preview_retry for its own job — recovering a failed load', () => {
    // The version and the retry counter are independent: one tracks new bytes
    // at the same path, the other re-asks after an error. Collapsing them
    // would lose the retry path, which is a separate feature.
    assert.match(lightbox, /preview_retry=\$\{previewAttempt\.value\}/)
    assert.match(lightbox, /function onImgError\(\)[\s\S]*previewAttempt\.value\+\+/)
    assert.match(lightbox, /function retryPreview\(\)[\s\S]*previewAttempt\.value\+\+/)
  })

  test('images.vue drives its lightbox and grid from one bytes-changed signal', () => {
    assert.match(images, /:version="igPanelRefreshKey"/)
    // The Browse grid must not reintroduce a private key nothing increments —
    // that was the second instance of this bug, found alongside the first.
    // (The name still appears in a comment explaining the removal; this pins
    // the declaration, not the prose.)
    assert.doesNotMatch(images, /const _editKey\s*=/)
    assert.match(images, /preview-image\?path=\$\{encodeURIComponent\(path\)\}&k=\$\{igPanelRefreshKey\.value\}/)
    // Re-reading the disk must also re-fetch the pixels, or "Refresh" lies.
    assert.match(images, /async function loadEditScan\(\)[\s\S]*igPanelRefreshKey\.value\+\+/)
    // A completed repair rewrites artwork at the same paths, so it is a
    // bytes-changed event too.
    assert.match(images, /lastRepairJob\.value\?\.status[\s\S]{0,600}onPanelRefresh\(\)/)
  })

  test('the generator panel re-busts when the parent says the disk changed', () => {
    // Re-scanning returns the same paths, so a scan alone cannot reveal new
    // bytes — the panel must bump its own key when refreshKey moves.
    assert.match(panel, /props\.refreshKey[\s\S]{0,500}cacheKey\.value\+\+/)
    assert.match(panel, /cacheKey\.value\+\+\s*\n\s*emit\('refresh'\)/)
  })

  test('pages that cannot rewrite images while mounted still bust per visit', () => {
    for (const [name, source] of [
          ['video-assembly.vue', videoAssembly],
      ['image-prompts.vue', imagePrompts],
    ] as const) {
      assert.match(
        source,
        /const previewCacheKey = Date\.now\(\)/,
        `${name} needs a per-visit preview cache key`,
      )
    }
  })
})
