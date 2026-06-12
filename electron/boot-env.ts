/**
 * boot-env.ts — process-environment tweaks that MUST run before any other
 * module's top-level code executes. Imported FIRST in main.ts (ESM evaluates
 * imports in order, so this file's side effects land before server/app.js or
 * any service touches the filesystem).
 *
 * v1.0.337 — UV_THREADPOOL_SIZE: Node's libuv pool defaults to 4 threads,
 * shared by ALL async fs operations. The episode-status scan on a 200–300
 * episode project fans out thousands of readdir/stat calls and saturates
 * those 4 threads, which starves unrelated requests (provider/voice/model
 * probes) → slow loads and empty dropdowns. 16 threads gives the scans and
 * the interactive requests room to coexist. The env var only takes effect
 * if set before libuv's pool is first used, hence this file.
 *
 * Respect an explicit user override (e.g. launching with
 * UV_THREADPOOL_SIZE=32 for experiments).
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16'
}

export {}
