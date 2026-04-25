// Minimal preload — exposes a single marker so the renderer can detect that
// it is running inside the Electron shell, not a stray browser tab pointed at
// http://localhost:3001/.
//
// CJS (.cjs) on purpose: the renderer is sandboxed by default in modern
// Electron, and ESM preload requires sandbox: false. CJS works in either mode
// and avoids tying the preload to a specific webPreferences flag.
//
// Exposed shape kept intentionally tiny — this file's only job is browser-tab
// detection. If we ever add IPC bridges, they belong in a separate
// contextBridge.exposeInMainWorld('api', ...) call alongside this one.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
})
