import fs from 'node:fs/promises'


const { recordContentStoreKeyAnchor, setApiKey } = await import('../../services/app-secrets-store.js')
const { configureYouTubeApplication } = await import('../../services/youtube-connection-store.js')

const action = process.env.ACTION
const ready = process.env.READY!
const release = process.env.RELEASE!
await fs.writeFile(ready, 'ready')
while (true) {
  try { await fs.stat(release); break } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
}

if (action === 'provider') {
  await setApiKey('genstudio', 'gsk_child_provider')
} else if (action === 'anchor') {
  await recordContentStoreKeyAnchor({
    origin: 'https://api.genstudio.example',
    account_id: 'acct_a',
    content_account_id: 'acct_a',
    keys: [{ key_id: 'key_a', public_key_base64: Buffer.alloc(32, 4).toString('base64') }],
  })
} else if (action === 'youtube') {
  await configureYouTubeApplication({
    client_id: 'concurrent-client.apps.googleusercontent.com',
    client_secret: 'concurrent-youtube-secret',
  })
} else {
  throw new Error(`Unknown worker action: ${String(action)}`)
}
