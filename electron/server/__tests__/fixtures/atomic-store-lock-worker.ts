import fs from 'node:fs/promises'

import { withCrossProcessLock, writeJsonAtomic } from '../../lib/atomic-store.js'

const target = process.env.TARGET!
const ready = process.env.READY!
const release = process.env.RELEASE!

await withCrossProcessLock(target, async () => {
  await fs.writeFile(ready, 'ready')
  while (true) {
    try { await fs.stat(release); break } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  const current = JSON.parse(await fs.readFile(target, 'utf8'))
  await writeJsonAtomic(target, { ...current, worker: true })
})
