import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const uploadPage = fs.readFileSync(
  path.resolve(process.cwd(), 'pages/projects/[slug]/upload.vue'),
  'utf8',
)

test('Upload Center serves YouTube channel icons through the local API with a fallback', () => {
  assert.match(uploadPage, /\/upload\/accounts\/\$\{encodeURIComponent\(account\.id\)\}\/avatar/)
  assert.match(uploadPage, /@error="channelAvatarFailed = true"/)
  assert.match(uploadPage, /v-else>\{\{ channelInitials \}\}/)
  assert.doesNotMatch(uploadPage, /:src="youtubeAccounts\[0\]\.thumbnail_url"/)
})
