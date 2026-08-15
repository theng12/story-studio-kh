/**
 * Shared test helpers. Provides isolated temp dirs and an API fixture.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'

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
