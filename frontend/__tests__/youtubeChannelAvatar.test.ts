import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const overviewPage = fs.readFileSync(
  path.resolve(process.cwd(), 'pages/projects/[slug]/upload/index.vue'),
  'utf8',
)

test('Upload Center serves YouTube channel icons through the local API with a fallback', () => {
  assert.match(overviewPage, /encodeURIComponent\(`registry:\$\{channelId\}`\)\}\/avatar/)
  assert.match(overviewPage, /@error="channelAvatarFailed = true"/)
  assert.match(overviewPage, /v-else>\{\{ channelInitials \}\}/)
  assert.doesNotMatch(overviewPage, /:src="[^\"]*thumbnail_url/)
})
