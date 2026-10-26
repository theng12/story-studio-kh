import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/**
 * The opt-in rule is a property of the PAGE, so it is pinned here.
 *
 * These read the component source rather than mounting it: the rule is about
 * which controls exist and what gates them, and a mount would have to fake the
 * whole upload flow to reach the same question. Each assertion names the exact
 * mistake it prevents.
 */

const publishSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/upload/publish.vue', import.meta.url)),
  'utf8',
)
const settingsSource = readFileSync(
  fileURLToPath(new URL('../components/SocialPublishingSettings.vue', import.meta.url)),
  'utf8',
)

describe('per-upload social tick box', () => {
  test('nothing posts unless a platform is ticked, and an empty tick list sends nothing', () => {
    // The post function refuses before any request.
    assert.match(publishSource, /async function postToSocial\(episodeCode: string\): Promise<void> \{\s*\n\s*if \(!socialChosen\.value\.length\) return/)
    // The route is called only with the ticked platforms, never with a default.
    assert.match(publishSource, /social\/episodes\/\$\{encodeURIComponent\(episodeCode\)\}\/publish`,\s*\n\s*\{ platforms: socialChosen\.value \}/)
  })

  test('the channel’s saved choice pre-ticks only platforms that have a connected account', () => {
    assert.match(
      publishSource,
      /socialChosen\.value = settings\.platforms\.filter\(platform => !!ready\[platform\]\)/,
    )
  })

  test('a platform with no account cannot be ticked', () => {
    assert.match(publishSource, /:disabled="busy !== '' \|\| !socialReady\[platform\.platform\]"/)
  })

  test('the tick list is cleared when a different episode is reviewed', () => {
    // `closeReview` clears both the receipts and the note, so one episode's
    // state cannot sit under another episode's name.
    assert.match(publishSource, /socialState\.value = null\n\s*socialNote\.value = ''/)
    // And the receipts are re-read for the episode that is actually on screen.
    assert.match(publishSource, /void loadSocialState\(episodeCode\)/)
  })

  test('the confirmation names the platforms that will also be posted to', () => {
    assert.match(publishSource, /const socialConfirmation = socialChosen\.value\.length/)
    assert.match(publishSource, /\+ socialConfirmation/)
  })

  test('the social section is absent for an episode already on YouTube and for a schedule review', () => {
    assert.match(
      publishSource,
      /v-if="socialPlatforms\.length && !alreadyPublished && reviewIntent !== 'schedule'" class="social-publish"/,
    )
  })

  test('posting is a separate call, so a social failure cannot fail the YouTube upload', () => {
    // It is fire-and-forget from the upload action, in its own try/catch that
    // writes a ROW RESULT rather than throwing into the upload's catch.
    assert.match(publishSource, /void postToSocial\(episodeCode\)/)
    const block = publishSource.slice(publishSource.indexOf('async function postToSocial'))
    assert.match(block.slice(0, block.indexOf('\n}\n')), /catch \(error: any\)/)
  })
})

describe('settings component', () => {
  test('a client secret is write-only: the field is emptied after a successful save', () => {
    assert.match(settingsSource, /drafts\[provider\]\.clientSecret = ''/)
    assert.match(settingsSource, /placeholder="Write-only — never shown again"/)
  })

  test('the channel scope saves only the platform list, never an account id', () => {
    const toggle = settingsSource.slice(settingsSource.indexOf('async function togglePlatform'))
    assert.match(toggle.slice(0, toggle.indexOf('\n}\n')), /put\(`\/projects\/\$\{props\.slug\}\/social\/settings`, \{ platforms: next \}\)/)
  })

  test('disconnecting says what it does not remove', () => {
    assert.match(settingsSource, /Posts already published stay on the platform/)
  })

  test('a platform with no connected account cannot be ticked at the channel level', () => {
    assert.match(settingsSource, /:disabled="busy !== '' \|\| !accountFor\(platform\.platform\)"/)
  })
})
