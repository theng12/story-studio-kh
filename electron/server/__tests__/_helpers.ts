/**
 * Shared test helpers. Provides isolated temp dirs and an API fixture.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'
// The backend runner preloads this via NODE_OPTIONS; anything else that drives Story's routes
// with supertest (a single `node --test` file, the Gateway's Story content-delivery round trip)
// only imports this helper, and without it a local daemon on 127.0.0.1 could answer instead
// (seen 2026-10-03: "Story series-formula install refusal: HTTP 404 no-code"). Idempotent.
import '../../../scripts/testing/loopback-supertest.mjs'

installTestSafeStorage()

/** Create a fresh temp data dir and point STORY_STUDIO_DATA_DIR at it. */
export async function useTempDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-test-'))
  process.env.STORY_STUDIO_DATA_DIR = dir
  setTestSafeStorageAvailable(true)
  return {
    dir,
    cleanup: async () => {
      delete process.env.STORY_STUDIO_DATA_DIR
      setTestSafeStorageAvailable(true)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
