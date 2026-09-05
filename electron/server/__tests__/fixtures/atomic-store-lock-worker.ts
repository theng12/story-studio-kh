import fs from 'node:fs/promises'

import { withCrossProcessLock, writeJsonAtomic } from '../../lib/atomic-store.js'

const target = process.env.TARGET!
const ready = process.env.READY!
const release = process.env.RELEASE!

await withCrossProcessLock(target, async () => {
  const current = process.env.NO_WRITE === '1'
    ? null
    : JSON.parse(await fs.readFile(target, 'utf8'))
  await fs.writeFile(ready, 'ready')
  while (true) {
    try { await fs.stat(release); break } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  if (process.env.NO_WRITE === '1') return
  await writeJsonAtomic(target, { ...current, worker: true })
})
