/**
 * Production's worker is a compiled `.js` file next to its module. Under
 * `node --import tsx` a worker thread does NOT inherit the tsx loader, so this
 * fixture registers it in its own thread before loading the real modules.
 * The only other difference is the command stub: `sample` takes 10 s on macOS.
 */
import { register } from 'tsx/esm/api'

register()
const { _setWedgeCaptureExecForTests } = await import('../../services/wedge-capture.js')
await import('../../services/wedge-watch-worker.js')

_setWedgeCaptureExecForTests(async (file: string) => (
  file === 'sample' ? 'stub sample of the blocked process' : `stub ${file}`
))
