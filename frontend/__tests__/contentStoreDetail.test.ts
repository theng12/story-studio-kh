import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const detail = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductDetail.vue', import.meta.url)), 'utf8')
const route = readFileSync(fileURLToPath(new URL('../pages/content-store/[productId].vue', import.meta.url)), 'utf8')
const cover = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCover.vue', import.meta.url)), 'utf8')
const storePage = readFileSync(fileURLToPath(new URL('../pages/content-store.vue', import.meta.url)), 'utf8')

describe('Content Store proof route contract', () => {
  test('renders proof and opens showcase links externally', () => {
    assert.match(detail, /Watch example videos/)
    assert.match(detail, /openExternalShowcase/)
    assert.match(detail, /Opens YouTube in your default browser/)
    assert.doesNotMatch(detail, /iframe|autoplay|v-html/)
  })

  test('keeps proof facts and unknown products inside Content Store', () => {
    assert.match(detail, /Minimum Story Studio version/)
    assert.match(detail, /Included components/)
    assert.match(detail, /Publisher/)
    assert.match(detail, /Changelog/)
    assert.match(detail, /License/)
    assert.match(detail, /componentSummary/)
    assert.match(detail, /versionFromSignedSummary/)
    assert.match(route, /Unknown Content Store product/)
    assert.doesNotMatch(route, /project selection|select a project/i)
  })

  test('returns to the Store when Escape leaves the proof route', () => {
    assert.match(route, /event\.key === 'Escape'/)
    assert.match(route, /navigateTo\('\/content-store'\)/)
  })

  test('keeps the nested proof outlet mounted for direct route resolution', () => {
    assert.match(storePage, /<NuxtPage\s*\/>/)
    assert.doesNotMatch(storePage, /<NuxtPage\s+v-if/)
  })

  test('uses truthful cover text and server-published price/status', () => {
    assert.match(cover, /product\.presentation\.cover/)
    assert.match(cover, /:alt="coverAlt"/)
    assert.match(cover, /product\.free \? 'Free'/)
    assert.match(cover, /product\.creditPrice/)
  })
})
